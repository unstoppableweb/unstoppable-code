import {
  memoryEditRevision,
  recordMemoryEdit,
  withMemoryWriteLock,
} from './edit-coordination';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { access, readFile, readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type AgentModelConfig,
  type ChatModel,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { getStructuredHelperQueryErrorUsage } from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  IMPORTS_INPUT_BUDGET_BYTES,
  INBOX_INPUT_BUDGET_BYTES,
  MAX_INBOX_FILES_PER_RUN,
  MAX_UNUSED_DAYS,
  TOPICS_INPUT_BUDGET_BYTES,
} from '@canopy/memory-consolidation/limits';
import {
  logicalMemorySourcePath,
  promptEntryCostBytes,
  promptEntryFitsBudget,
  type MemoryImportSourceTool,
} from '@canopy/memory-consolidation/input-budget';
import type {
  ConsolidationImportMetadata,
  ConsolidationInput,
  ConsolidationInputFile,
  ConsolidationInputOmission,
  ConsolidationOutput,
  ConsolidationUsageStats,
} from '@canopy/memory-consolidation/input';
import { normalizeMemoryDocumentContent } from '@canopy/memory-consolidation/document-merge';
import { memoryConsolidationInputHashParts } from '@canopy/memory-consolidation/input-hash';
import { isMemoryIndexWithinLimits } from '@canopy/memory-consolidation/memory-index';
import {
  compareUsageForRetention,
  parseTimestamp,
} from '@canopy/memory-consolidation/pruning';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import {
  runMemoryConsolidation,
  type MemoryConsolidationApplyPlan,
  type MemoryConsolidationModelRequest,
  type MemoryConsolidationModelResponse,
  type MemoryConsolidationPorts,
  type MemoryConsolidationResult,
} from '@canopy/memory-consolidation/run';
import {
  isListedTopicName,
  memoryFileIdentity,
  topicIdentity,
  type ScopeTopicInventory,
} from '@canopy/memory-consolidation/topic-identity';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
} from '../../lib/helper-observed-task';
import {
  LOCAL_MEMORY_SYNCED_REFUSED_MESSAGE,
  LOCAL_MEMORY_SYNCED_SECRET_MESSAGE,
} from '@canopy/protocol/local-memory';
import type {
  MemoryDocumentChange,
  MemoryUsageAggregate,
} from '@canopy/protocol/memory-sync';
import { runLocalMemoryStructuredHelper } from './structured-helper';
import {
  isSyncedMemoryReplica,
  localMemoryReplicaHooks,
  type LocalMemorySyncedConsolidation,
  type LocalMemorySyncedNote,
} from './replica-hooks';
import { memoryNoteId } from './note-identity';
import {
  assertMemoryPathContained,
  assertMemoryScopeLockHeld,
  ensureOwnerOnlyMemoryDir,
  isMemoryMarkdownFileName,
} from './memory-files';
import {
  LOCAL_MEMORY_READ_ONLY_MESSAGE,
  LocalMemoryScopeReadOnlyError,
} from './scope-manifest';
import { listPendingSources, type PendingSources } from './pending-sources';
import {
  LocalMemoryScopeChangedError,
  localMemoryScopeHoldsState,
  readLocalMemoryState,
  runVerifiedLocalMemoryWrite,
  saveLocalMemorySnapshot,
  type LocalMemoryState,
  type LocalMemoryWriteGuard,
  type StagedLocalMemoryFile,
} from './snapshots';
import { readUsage, usageEntryFor, type MemoryUsageEntry } from './usage';
import { deleteStaleUsageRows } from './consolidation-usage-cleanup';
import {
  stampImportsConsolidated,
  type ImportStateStagedEntry,
} from './import/ledger';

export type { ConsolidationInput } from '@canopy/memory-consolidation/input';

/*
 * The desktop host of a local memory consolidation run. The rules (prompt,
 * output schema, validation, topic and index handling, pruning) live in
 * `@canopy/memory-consolidation`, shared with Canopy Cloud; this module
 * collects the input from the scope folder, runs the model on the user's
 * memory model, and applies the result under the scope's write lock with a
 * snapshot and compensating rollback.
 */

export interface RunConsolidationOptions {
  scopeDir: string;
  workspaceId?: string;
  model: ChatModel;
  thinkingLevel: ThinkingLevel;
  modelConfig?: AgentModelConfig;
  shouldContinue?: () => boolean | Promise<boolean>;
  /**
   * Snapshot MEMORY.md and the topics before the write (default). A rebuild
   * turns this off for its own runs; its one snapshot precedes all of them.
   */
  snapshotBeforeWrite?: boolean;
  generate?: (
    input: ConsolidationInput,
    options: RunConsolidationOptions,
  ) => Promise<ConsolidationOutput | null>;
  /** Test seam for the one compaction retry of an oversized index. */
  compact?: (
    prompt: string,
    options: RunConsolidationOptions,
  ) => Promise<unknown>;
  now?: Date;
  /** Why a synced replica's run takes its lease (design §11.2). */
  leaseReason?: 'scheduled' | 'manual';
}

export type RunConsolidationResult = MemoryConsolidationResult;

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    // Only a missing file means "empty". Any other failure (EACCES, EIO, …)
    // must abort consolidation before MEMORY.md is overwritten or unread
    // inbox notes are archived based on silently-truncated input.
    if (isNodeError(error, 'ENOENT')) {
      return '';
    }
    throw error;
  }
}

function usageStatsFor(
  usage: Map<string, MemoryUsageEntry>,
  fileKey: string,
  fallbackCreatedAt: string,
): ConsolidationUsageStats {
  const stats = usageEntryFor(usage, fileKey);
  return stats
    ? {
        usageCount: stats.usageCount,
        lastUsedAt: stats.lastUsedAt,
        createdAt: stats.createdAt,
      }
    : {
        usageCount: 0,
        lastUsedAt: null,
        createdAt: fallbackCreatedAt,
      };
}

async function readInputFile(
  scopeDir: string,
  fileKey: string,
  filename: string,
  content: string,
  usage: Map<string, MemoryUsageEntry>,
  importMetadata?: ConsolidationImportMetadata,
): Promise<ConsolidationInputFile | null> {
  try {
    const info = await stat(join(scopeDir, fileKey));
    const modifiedAt = info.mtime.toISOString();
    const fallbackCreatedAt = (
      info.birthtimeMs > 0 ? info.birthtime : info.mtime
    ).toISOString();
    const inputFile: ConsolidationInputFile = {
      fileKey,
      filename,
      content,
      modifiedAt,
      usage: usageStatsFor(usage, fileKey, fallbackCreatedAt),
    };
    return importMetadata ? { ...inputFile, importMetadata } : inputFile;
  } catch (error) {
    // Only a file that disappeared between listing and stat may be dropped
    // from the snapshot. Any other stat failure (EACCES, EIO, …) must abort
    // consolidation — silently omitting the input would rewrite MEMORY.md
    // from an incomplete snapshot and could archive notes it never read.
    if (isNodeError(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

interface ConsolidationInputCandidate {
  fileKey: string;
  filename: string;
  usage: ConsolidationUsageStats;
  totalBytes: number;
  importMetadata?: ConsolidationImportMetadata;
}

interface ConsolidationInputBatch {
  files: ConsolidationInputFile[];
  omitted: ConsolidationInputOmission;
}

interface ConsolidationImportInputBatch extends ConsolidationInputBatch {
  hashMaterials: Array<{
    fileKey: string;
    fileHash: string;
    repo?: string;
    modified?: string;
    sourceTool?: MemoryImportSourceTool;
  }>;
}

async function inspectInputFile(
  scopeDir: string,
  fileKey: string,
  filename: string,
  usage: Map<string, MemoryUsageEntry>,
  importSource?: {
    originalPath: string;
    entry: ImportStateStagedEntry;
  },
): Promise<ConsolidationInputCandidate | null> {
  try {
    const info = await stat(join(scopeDir, fileKey));
    const fallbackCreatedAt = (
      info.birthtimeMs > 0 ? info.birthtime : info.mtime
    ).toISOString();
    const candidate: ConsolidationInputCandidate = {
      fileKey,
      filename,
      usage: usageStatsFor(usage, fileKey, fallbackCreatedAt),
      totalBytes: info.size,
    };
    if (!importSource) {
      return candidate;
    }
    const sourceTool = importSource.entry.sourceTool ?? 'claude-code';
    return {
      ...candidate,
      importMetadata: {
        sourceTool,
        originalPath: redactMemoryContent(
          logicalMemorySourcePath(sourceTool, importSource.originalPath),
        ),
        sourceFilename: redactMemoryContent(
          basename(importSource.originalPath),
        ),
        ...(importSource.entry.repo ? { repo: importSource.entry.repo } : {}),
        modified: importSource.entry.modified ?? info.mtime.toISOString(),
      },
    };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

async function materializeInputFile(
  scopeDir: string,
  candidate: ConsolidationInputCandidate,
  usage: Map<string, MemoryUsageEntry>,
): Promise<ConsolidationInputFile | null> {
  const content = await readTextOrEmpty(join(scopeDir, candidate.fileKey));
  return readInputFile(
    scopeDir,
    candidate.fileKey,
    candidate.filename,
    content,
    usage,
    candidate.importMetadata,
  );
}

// Sequential on purpose: a large backlog fanned out through Promise.all would
// otherwise issue thousands of concurrent stat() calls.
async function inspectInputFiles(
  scopeDir: string,
  entries: Array<{
    fileKey: string;
    filename: string;
    importSource?: { originalPath: string; entry: ImportStateStagedEntry };
  }>,
  usage: Map<string, MemoryUsageEntry>,
): Promise<ConsolidationInputCandidate[]> {
  const candidates: ConsolidationInputCandidate[] = [];
  for (const entry of entries) {
    const candidate = await inspectInputFile(
      scopeDir,
      entry.fileKey,
      entry.filename,
      usage,
      entry.importSource,
    );
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

// The prompt embeds each file as an entry of JSON.stringify(entries, null, 2),
// so the budget must charge the serialized fragment (JSON escaping, the
// filename, and array indentation), not raw content bytes — a quote-heavy
// file serializes to roughly double its raw size. Every line of the entry is
// indented two extra spaces inside the array, plus the ",\n" separator.
// Single selection path for every input class so inbox and topic accounting
// cannot drift. 'stop' preserves FIFO semantics (everything behind the first
// over-budget file stays pending); 'skip' lets lower-ranked files fill the
// remaining room.
// 'stop' holds the files behind one back because that file leads the next
// run. A file no empty budget could hold leads nothing, so 'stop' passes it
// over and reports it: it would otherwise hold every later file back
// forever. Saved notes are clamped and import staging refuses such sources,
// so this is reached only through a note an older build wrote or another
// device pushed.
async function selectFilesWithinBudget(options: {
  scopeDir: string;
  usage: Map<string, MemoryUsageEntry>;
  candidates: ConsolidationInputCandidate[];
  budgetBytes: number;
  maxFiles: number;
  onOverBudget: 'stop' | 'skip';
  /** False for a file read as something other than it was listed as: left out. */
  accepts?: (file: ConsolidationInputFile) => boolean;
}): Promise<ConsolidationInputBatch> {
  const files: ConsolidationInputFile[] = [];
  const omitted: ConsolidationInputOmission = {
    fileCount: 0,
    totalBytes: 0,
  };
  let includedBytes = 0;
  const omitRemaining = (fromIndex: number): void => {
    for (const remaining of options.candidates.slice(fromIndex)) {
      omitted.fileCount += 1;
      omitted.totalBytes += remaining.totalBytes;
    }
  };
  for (let index = 0; index < options.candidates.length; index += 1) {
    const candidate = options.candidates[index];
    if (!candidate) {
      continue;
    }
    if (files.length >= options.maxFiles) {
      omitRemaining(index);
      break;
    }
    // Raw size is a lower bound on the serialized cost, so a candidate whose
    // stat size alone busts the budget can be rejected without reading it.
    if (includedBytes + candidate.totalBytes > options.budgetBytes) {
      if (
        options.onOverBudget === 'stop' &&
        candidate.totalBytes <= options.budgetBytes
      ) {
        omitRemaining(index);
        break;
      }
      omitted.fileCount += 1;
      omitted.totalBytes += candidate.totalBytes;
      continue;
    }
    const file = await materializeInputFile(
      options.scopeDir,
      candidate,
      options.usage,
    );
    if (file === null || options.accepts?.(file) === false) {
      continue;
    }
    const costBytes = promptEntryCostBytes(file);
    if (includedBytes + costBytes > options.budgetBytes) {
      omitted.fileCount += 1;
      omitted.totalBytes += costBytes;
      if (
        options.onOverBudget === 'stop' &&
        promptEntryFitsBudget(file, options.budgetBytes)
      ) {
        omitRemaining(index + 1);
        break;
      }
      continue;
    }
    files.push(file);
    includedBytes += costBytes;
  }
  return { files, omitted };
}

async function readInboxFiles(
  scopeDir: string,
  usage: Map<string, MemoryUsageEntry>,
  names: string[],
  accepts: ((file: ConsolidationInputFile) => boolean) | undefined,
): Promise<ConsolidationInputBatch> {
  const candidates = await inspectInputFiles(
    scopeDir,
    names.map((filename) => ({ fileKey: `inbox/${filename}`, filename })),
    usage,
  );
  return selectFilesWithinBudget({
    scopeDir,
    usage,
    candidates,
    budgetBytes: INBOX_INPUT_BUDGET_BYTES,
    maxFiles: MAX_INBOX_FILES_PER_RUN,
    onOverBudget: 'stop',
    ...(accepts ? { accepts } : {}),
  });
}

async function readTopicFiles(
  scopeDir: string,
  usage: Map<string, MemoryUsageEntry>,
): Promise<ConsolidationInputBatch> {
  // Strict readers: the store's listTopics/readTopic swallow filesystem
  // errors by design (silent-fallback contract), which is wrong here — a
  // listing or read failure must abort consolidation rather than silently
  // dropping a topic from the consolidated snapshot. Enumerate and read the
  // topics directory directly with ENOENT-only tolerance, mirroring
  // readInboxFiles.
  const topicsDir = join(scopeDir, 'topics');
  let names: string[];
  try {
    const entries = await readdir(topicsDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && isMemoryMarkdownFileName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return {
        files: [],
        omitted: { fileCount: 0, totalBytes: 0 },
      };
    }
    throw error;
  }
  // Skip names the store would never list (keeps parity with listTopics).
  const eligibleNames = names.filter(isListedTopicName);
  const inspected = await inspectInputFiles(
    scopeDir,
    eligibleNames.map((name) => ({
      fileKey: `topics/${name}`,
      filename: name,
    })),
    usage,
  );
  return selectFilesWithinBudget({
    scopeDir,
    usage,
    candidates: [...inspected].sort(compareUsageForRetention),
    budgetBytes: TOPICS_INPUT_BUDGET_BYTES,
    maxFiles: Number.POSITIVE_INFINITY,
    onOverBudget: 'skip',
  });
}

function warnAboutUnusableImports(pending: PendingSources): void {
  if (pending.ledgerUnreadable) {
    process.emitWarning(
      'Unreadable local memory import ledger; skipping staged imports this run',
      { code: 'LOCAL_MEMORY_CONSOLIDATION_IMPORT_LEDGER_INVALID' },
    );
    return;
  }
  for (const filename of pending.unusableImports) {
    process.emitWarning(
      `Staged import imported/${filename} has no ledger entry; skipping it this run`,
      { code: 'LOCAL_MEMORY_CONSOLIDATION_IMPORT_ORPHANED' },
    );
  }
}

async function readImportFiles(
  scopeDir: string,
  usage: Map<string, MemoryUsageEntry>,
  pending: PendingSources,
  accepts: ((file: ConsolidationInputFile) => boolean) | undefined,
): Promise<ConsolidationImportInputBatch> {
  warnAboutUnusableImports(pending);
  const entries = pending.imports.map((pendingImport) => ({
    fileKey: pendingImport.fileKey,
    filename: pendingImport.filename,
    importSource: {
      originalPath: pendingImport.originalPath,
      entry: pendingImport.entry,
    },
  }));
  const hashMaterials: ConsolidationImportInputBatch['hashMaterials'] =
    pending.imports.map(({ fileKey, entry }) => ({
      fileKey,
      fileHash: entry.fileHash,
      ...(entry.sourceTool ? { sourceTool: entry.sourceTool } : {}),
      ...(entry.repo ? { repo: entry.repo } : {}),
      ...(entry.modified ? { modified: entry.modified } : {}),
    }));
  const inspected = await inspectInputFiles(scopeDir, entries, usage);
  const oldestFirst = [...inspected].sort((left, right) => {
    const leftModified = left.importMetadata?.modified ?? null;
    const rightModified = right.importMetadata?.modified ?? null;
    return (
      parseTimestamp(leftModified) - parseTimestamp(rightModified) ||
      left.fileKey.localeCompare(right.fileKey)
    );
  });
  const selected = await selectFilesWithinBudget({
    scopeDir,
    usage,
    candidates: oldestFirst,
    budgetBytes: IMPORTS_INPUT_BUDGET_BYTES,
    maxFiles: Number.POSITIVE_INFINITY,
    onOverBudget: 'stop',
    ...(accepts ? { accepts } : {}),
  });
  return { ...selected, hashMaterials };
}

function hashInput(input: {
  memoryMd: string;
  topicFiles: ConsolidationInputFile[];
  inboxFiles: ConsolidationInputFile[];
  importFiles: ConsolidationInputFile[];
  importHashMaterials: ConsolidationImportInputBatch['hashMaterials'];
}): string {
  const hash = createHash('sha256');
  for (const part of memoryConsolidationInputHashParts({
    memoryMd: input.memoryMd,
    files: [...input.topicFiles, ...input.inboxFiles, ...input.importFiles],
    imports: input.importHashMaterials,
  })) {
    hash.update(part);
  }
  return hash.digest('hex');
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * A synced run may consume only the notes the cloud holds as pending: a note
 * still queued for sync, kept on this device, or an import never sent stays
 * for a later run.
 */
function consumablePending(
  pending: PendingSources,
  consumable: ReadonlyMap<string, LocalMemorySyncedNote> | undefined,
): PendingSources {
  if (consumable === undefined) return pending;
  return {
    ...pending,
    inboxFiles: pending.inboxFiles.filter((name) =>
      consumable.has(`inbox/${name}`),
    ),
    imports: pending.imports.filter((pendingImport) =>
      consumable.has(pendingImport.fileKey),
    ),
  };
}

/**
 * Whether a file holds the note the cloud holds pending under its key: an
 * inbox note by the ID in its content, an import by the hash of its body. A
 * file replaced after the listing was read is left for a later run.
 */
function holdsConsumableNote(
  consumable: ReadonlyMap<string, LocalMemorySyncedNote>,
): (file: ConsolidationInputFile) => boolean {
  return (file) => {
    const note = consumable.get(file.fileKey);
    if (note === undefined) return false;
    return note.contentHash === null
      ? memoryNoteId(file.content) === note.noteId
      : sha256Hex(file.content) === note.contentHash;
  };
}

export async function collectConsolidationInput(
  scopeDir: string,
  options: { consumable?: ReadonlyMap<string, LocalMemorySyncedNote> } = {},
): Promise<ConsolidationInput> {
  const memoryMd = await readTextOrEmpty(join(scopeDir, 'MEMORY.md'));
  const { trackingSince, entries: usage } = await readUsage(scopeDir);
  const pending = consumablePending(
    await listPendingSources(scopeDir),
    options.consumable,
  );
  const accepts =
    options.consumable === undefined
      ? undefined
      : holdsConsumableNote(options.consumable);
  const inbox = await readInboxFiles(
    scopeDir,
    usage,
    pending.inboxFiles,
    accepts,
  );
  const inboxFiles = inbox.files;
  const imports = await readImportFiles(scopeDir, usage, pending, accepts);
  const importFiles = imports.files;
  const indexWithinLimits = isMemoryIndexWithinLimits(memoryMd);
  if (
    inboxFiles.length === 0 &&
    importFiles.length === 0 &&
    imports.omitted.fileCount === 0 &&
    indexWithinLimits
  ) {
    return {
      memoryMd,
      topicFiles: [],
      inboxFiles,
      importFiles,
      omittedInboxFiles: inbox.omitted,
      omittedImportFiles: imports.omitted,
      inputHash: hashInput({
        memoryMd,
        topicFiles: [],
        inboxFiles,
        importFiles,
        importHashMaterials: imports.hashMaterials,
      }),
      indexWithinLimits,
      usageTrackingSince: trackingSince,
    };
  }

  const topics = await readTopicFiles(scopeDir, usage);
  const topicFiles = topics.files;
  return {
    memoryMd,
    topicFiles,
    inboxFiles,
    importFiles,
    omittedTopicFiles: topics.omitted,
    omittedInboxFiles: inbox.omitted,
    omittedImportFiles: imports.omitted,
    inputHash: hashInput({
      memoryMd,
      topicFiles,
      inboxFiles,
      importFiles,
      importHashMaterials: imports.hashMaterials,
    }),
    indexWithinLimits,
    usageTrackingSince: trackingSince,
  };
}

const OBSERVED_TASK_LABELS: Record<
  MemoryConsolidationModelRequest['purpose'],
  string
> = {
  consolidation: 'Memory Consolidation',
  compaction: 'Memory Compaction',
};

/**
 * One structured call on the user's local memory model, observed as a
 * helper task. A failed call records its failure here; otherwise the shared
 * run settles the task once it knows whether the answer was used.
 */
async function generateStructuredOutput(
  request: MemoryConsolidationModelRequest,
  options: RunConsolidationOptions,
): Promise<MemoryConsolidationModelResponse> {
  const model = options.model;
  const taskKey = `helper:local-memory-consolidation:${options.scopeDir}:${Date.now()}`;
  startObservedHelperTask({
    taskKey,
    eventType: 'local_memory_consolidation',
    label: OBSERVED_TASK_LABELS[request.purpose],
    model,
    modelConfig: options.modelConfig,
  });
  try {
    const result = await runLocalMemoryStructuredHelper({
      taskKey,
      kind: 'local-memory-consolidation',
      label: 'Local Memory Consolidation',
      scopeDir: options.scopeDir,
      workspaceId: options.workspaceId,
      helperModel: {
        model,
        thinkingLevel: options.thinkingLevel,
        modelConfig: options.modelConfig,
      },
      systemPrompt: request.systemPrompt,
      userMessage: request.userMessage,
      schema: request.schema,
      resultValidationSchema: request.resultValidationSchema,
      onResultRejected: request.onResultRejected,
      isResult: request.isResult,
    });
    const usage = result.usage;
    return {
      value: result.value,
      settle: (outcome, reason): void => {
        finalizeObservedHelperTask(taskKey, outcome, reason, usage);
      },
    };
  } catch (error) {
    finalizeObservedHelperTask(
      taskKey,
      'failure',
      error instanceof Error ? error.message : String(error),
      // Unwraps TransientAgentRetryExhaustedError too, so exhausted retries
      // still record their accumulated cross-attempt usage.
      getStructuredHelperQueryErrorUsage(error),
    );
    throw error;
  }
}

function consolidationModel(
  options: RunConsolidationOptions,
): MemoryConsolidationPorts['model'] {
  return async (request) => {
    if (request.purpose === 'consolidation' && options.generate) {
      return { value: await options.generate(request.input, options) };
    }
    if (request.purpose === 'compaction' && options.compact) {
      return { value: await options.compact(request.userMessage, options) };
    }
    return generateStructuredOutput(request, options);
  };
}

/**
 * Every topic in a scope folder, in one read so the names and the identities
 * are always the same listing. Identities cover every file or link, not only
 * the names the store lists: on a case-insensitive filesystem a generated
 * name replaces whatever entry shares its identity, and a directory cannot be
 * replaced by a file rename.
 */
export async function readScopeTopicInventory(
  scopeDir: string,
): Promise<ScopeTopicInventory> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(scopeDir, 'topics'), { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT'))
      return { names: [], identities: new Set() };
    throw error;
  }
  return {
    names: entries
      .filter(
        (entry) =>
          entry.isFile() &&
          isMemoryMarkdownFileName(entry.name) &&
          isListedTopicName(entry.name),
      )
      .map((entry) => entry.name),
    identities: new Set(
      entries
        .filter((entry) => !entry.isDirectory())
        .map((entry) => topicIdentity(entry.name)),
    ),
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

// Archives a consumed inbox/import file or pruned topic file. Imports use
// imported/.consolidated/; inbox notes and topics use inbox/.consolidated/
// (topics gain a `topic-` prefix). Returns the destination path, or null when
// the source no longer existed (nothing was moved, so there is nothing to
// undo). A topic is moved through `guard`, which checks it right before.
async function moveFileToConsolidated(
  scopeDir: string,
  file: ConsolidationInputFile,
  guard?: LocalMemoryWriteGuard,
): Promise<string | null> {
  const source = join(scopeDir, file.fileKey);
  const imported = file.fileKey.startsWith('imported/');
  const consolidatedDir = imported
    ? join(scopeDir, 'imported', '.consolidated')
    : join(scopeDir, 'inbox', '.consolidated');
  await ensureOwnerOnlyMemoryDir(scopeDir, consolidatedDir);
  const prefix = file.fileKey.startsWith('topics/') ? 'topic-' : '';
  const extensionIndex = file.filename.toLowerCase().lastIndexOf('.md');
  const stem =
    extensionIndex === -1
      ? file.filename
      : file.filename.slice(0, extensionIndex);
  let suffix = 1;
  while (true) {
    const destinationName =
      suffix === 1
        ? `${prefix}${file.filename}`
        : `${prefix}${stem}-${suffix}.md`;
    const destination = join(consolidatedDir, destinationName);
    try {
      await access(destination);
      suffix += 1;
      continue;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw error;
      }
    }
    try {
      if (guard) await guard.move(source, destination);
      else {
        await assertMemoryPathContained(scopeDir, consolidatedDir);
        await assertMemoryScopeLockHeld();
        await rename(source, destination);
      }
      return destination;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return null;
      }
      if (!isNodeError(error, 'EEXIST')) {
        throw error;
      }
      suffix += 1;
    }
  }
}

interface CommittedFileWrite {
  targetPath: string;
  previousContent: string | null;
}

interface ArchivedInboxMove {
  sourcePath: string;
  destinationPath: string;
}

function emitRollbackWarning(error: unknown): void {
  // Emit the message string, not the Error instance: emitWarning ignores the
  // options object (and thus the code) when the first argument is an Error.
  process.emitWarning(error instanceof Error ? error.message : String(error), {
    code: 'LOCAL_MEMORY_CONSOLIDATION_ROLLBACK_FAILED',
  });
}

// Best-effort compensation for a commit that failed part-way: un-archive the
// already-moved inbox notes and imports, then, through the compare-before-
// destroy guard, un-archive pruned topics and restore (or remove) every
// already-committed file, in reverse commit order. The memory files are put
// back only while each still holds its bytes from before or after the
// commit (`expected`); anything else changed them meanwhile, and they are
// left as they are. Rollback failures are warned about and swallowed so the
// original commit error is what propagates to the caller.
async function rollbackAppliedConsolidation(
  scopeDir: string,
  expected: readonly LocalMemoryState[],
  committed: CommittedFileWrite[],
  archived: ArchivedInboxMove[],
): Promise<void> {
  const topicsDir = join(scopeDir, 'topics');
  const isTopicMove = (move: ArchivedInboxMove): boolean =>
    dirname(move.sourcePath) === topicsDir;
  for (const move of [...archived].reverse()) {
    if (isTopicMove(move)) continue;
    try {
      await assertMemoryScopeLockHeld();
      await rename(move.destinationPath, move.sourcePath);
    } catch (error) {
      emitRollbackWarning(error);
    }
  }
  try {
    await runVerifiedLocalMemoryWrite(scopeDir, expected, async (guard) => {
      // Stage every file to put back before the first change.
      const restores: Array<{
        targetPath: string;
        staged: StagedLocalMemoryFile | null;
      }> = [];
      for (const write of [...committed].reverse()) {
        restores.push({
          targetPath: write.targetPath,
          staged:
            write.previousContent === null
              ? null
              : await guard.stage(write.targetPath, write.previousContent),
        });
      }
      // A file that changed meanwhile stops every later change; the rest
      // are best effort.
      const attempt = async (change: () => Promise<unknown>): Promise<void> => {
        try {
          await change();
        } catch (error) {
          if (error instanceof LocalMemoryScopeChangedError) throw error;
          emitRollbackWarning(error);
        }
      };
      for (const move of [...archived].reverse()) {
        if (isTopicMove(move)) {
          await attempt(() =>
            guard.move(move.destinationPath, move.sourcePath),
          );
        }
      }
      for (const restore of restores) {
        const { staged } = restore;
        await attempt(() =>
          staged === null
            ? guard.remove(restore.targetPath)
            : guard.replace(staged),
        );
      }
    });
  } catch (error) {
    emitRollbackWarning(error);
  }
}

/**
 * The index and topics a complete commit of `output` over `prior` leaves:
 * the output's index, its topics in place of any of the same identity, and
 * the pruned topics gone.
 */
function consolidationTargetState(
  prior: LocalMemoryState,
  output: ConsolidationOutput,
  prunedTopics: ConsolidationInputFile[],
): LocalMemoryState {
  const written = output.topicFiles ?? [];
  const replaced = new Set([
    ...written.map((topic) => topicIdentity(topic.filename)),
    ...prunedTopics.map((file) => topicIdentity(file.filename)),
  ]);
  return {
    memoryMd: output.memoryMd,
    topicFiles: [
      ...prior.topicFiles.filter(
        (topic) => !replaced.has(topicIdentity(topic.filename)),
      ),
      ...written,
    ],
  };
}

// Applies validated consolidation output as staged writes plus a best-effort
// compensating rollback on the exception path; it is not all-or-nothing, and
// durability across a process crash mid-commit is out of scope. Stage phase:
// every generated file is fully written to a temp sibling first, so a write
// failure aborts before the live store is touched. Commit phase: staged
// files are renamed into place (topics before MEMORY.md, so the index is
// only ever replaced after every topic it references exists), inbox notes
// are archived, and pruned topics are archived after a final per-file
// revalidation; a failure anywhere in the commit triggers the compensating
// rollback of the files and moves already committed, so the exception path
// does not leave MEMORY.md inconsistent with the topics, pending inbox
// notes, and pruned topics.
async function applyConsolidationOutput(
  scopeDir: string,
  guard: LocalMemoryWriteGuard,
  prior: LocalMemoryState,
  output: ConsolidationOutput,
  inboxFiles: ConsolidationInputFile[],
  importFiles: ConsolidationInputFile[],
  prunedTopics: ConsolidationInputFile[],
  usageTrackingSince: string | null,
  consolidatedAt: string,
): Promise<void> {
  const writes = [
    ...(output.topicFiles ?? []).map((topic) => ({
      targetPath: join(scopeDir, 'topics', topic.filename),
      content: topic.content,
    })),
    { targetPath: join(scopeDir, 'MEMORY.md'), content: output.memoryMd },
  ];

  // Every file is staged before the first change; the guard deletes any
  // staged file that never reaches its target.
  const staged: StagedLocalMemoryFile[] = [];
  for (const write of writes) {
    staged.push(await guard.stage(write.targetPath, write.content));
  }

  const committed: CommittedFileWrite[] = [];
  const archived: ArchivedInboxMove[] = [];
  try {
    for (const file of staged) {
      const previousContent = await guard.replace(file);
      committed.push({ targetPath: file.targetPath, previousContent });
    }
    for (const file of inboxFiles) {
      const destinationPath = await moveFileToConsolidated(scopeDir, file);
      if (destinationPath !== null) {
        archived.push({
          sourcePath: join(scopeDir, file.fileKey),
          destinationPath,
        });
      }
    }
    const consolidatedImports: string[] = [];
    for (const file of importFiles) {
      const destinationPath = await moveFileToConsolidated(scopeDir, file);
      if (destinationPath !== null) {
        archived.push({
          sourcePath: join(scopeDir, file.fileKey),
          destinationPath,
        });
        consolidatedImports.push(file.fileKey);
      }
    }
    for (const file of prunedTopics) {
      // The awaited commit renames and inbox moves above reopened a race
      // window: a SearchMemory hit can commit a usage row after the prune
      // set was validated. Re-check the live usage store and the file's
      // mtime immediately before this file's rename so the remaining window
      // shrinks to the single rename. A veto here intentionally accepts the
      // already-committed MEMORY.md without this topic's index line: content
      // preservation wins over index completeness — the topic file survives
      // on disk and the next consolidation pass re-indexes it.
      const confirmedAtMove = await revalidatePruneCandidates(
        scopeDir,
        usageTrackingSince,
        [file],
      );
      if (confirmedAtMove.length === 0) {
        continue;
      }
      const destinationPath = await moveFileToConsolidated(
        scopeDir,
        file,
        guard,
      );
      if (destinationPath !== null) {
        archived.push({
          sourcePath: join(scopeDir, file.fileKey),
          destinationPath,
        });
      }
    }
    await stampImportsConsolidated(
      scopeDir,
      consolidatedImports,
      consolidatedAt,
    );
  } catch (error) {
    await rollbackAppliedConsolidation(
      scopeDir,
      [prior, consolidationTargetState(prior, output, prunedTopics)],
      committed,
      archived,
    );
    throw error;
  }
}

// Re-checks each prune candidate against the live file and usage store. The
// candidate set was computed from snapshots taken before LLM generation,
// which is slow; a user edit or a SearchMemory usage increment during that
// window must veto the prune (content changes surface through mtime).
async function revalidatePruneCandidates(
  scopeDir: string,
  snapshotTrackingSince: string | null,
  candidates: ConsolidationInputFile[],
): Promise<ConsolidationInputFile[]> {
  if (candidates.length === 0) {
    return [];
  }
  const current = await readUsage(scopeDir);
  // A store that became unavailable or was recreated since the snapshot no
  // longer backs the zero-usage evidence the candidates were selected on.
  if (
    current.trackingSince === null ||
    current.trackingSince !== snapshotTrackingSince
  ) {
    return [];
  }
  const validated: ConsolidationInputFile[] = [];
  for (const file of candidates) {
    let modifiedAt: string;
    try {
      const info = await stat(join(scopeDir, file.fileKey));
      modifiedAt = info.mtime.toISOString();
    } catch {
      // Vanished or unreadable since the snapshot: nothing safe to move.
      continue;
    }
    const usageCount =
      usageEntryFor(current.entries, file.fileKey)?.usageCount ?? 0;
    if (
      modifiedAt !== file.modifiedAt ||
      usageCount !== file.usage.usageCount
    ) {
      continue;
    }
    validated.push(file);
  }
  return validated;
}

/**
 * The scope's revision, read once the scope is ready for writes; null when
 * a newer build made it read-only.
 */
async function writableEditRevision(scopeDir: string): Promise<string | null> {
  try {
    return await withMemoryWriteLock(scopeDir, () =>
      memoryEditRevision(scopeDir),
    );
  } catch (error) {
    if (error instanceof LocalMemoryScopeReadOnlyError) return null;
    throw error;
  }
}

/**
 * The document changes a complete commit of `output` over `prior` makes: a
 * put for every new or changed document and a delete for every topic the
 * output dropped or pruned (design §12.1 step 5). Documents are compared and
 * sent as the cloud holds them, with LF line endings: what a run keeps from
 * the replica may have been saved with CRLF.
 */
function consolidationChanges(
  prior: LocalMemoryState,
  output: ConsolidationOutput,
  prunedTopics: ConsolidationInputFile[],
): MemoryDocumentChange[] {
  const target = consolidationTargetState(prior, output, prunedTopics);
  const put = (path: string, content: string): MemoryDocumentChange => ({
    op: 'put',
    path,
    content,
    contentHash: sha256Hex(content),
  });
  const changes: MemoryDocumentChange[] = [];
  const memoryMd = normalizeMemoryDocumentContent(output.memoryMd);
  if (
    prior.memoryMd === null ||
    memoryMd !== normalizeMemoryDocumentContent(prior.memoryMd)
  ) {
    changes.push(put('MEMORY.md', memoryMd));
  }
  const priorTopics = new Map(
    prior.topicFiles.map((topic) => [topicIdentity(topic.filename), topic]),
  );
  const targetIdentities = new Set<string>();
  for (const topic of target.topicFiles) {
    const identity = topicIdentity(topic.filename);
    targetIdentities.add(identity);
    // A topic keeps its identity across a change of case; the cloud
    // replaces the version of that identity, so one put is the change.
    const before = priorTopics.get(identity);
    const content = normalizeMemoryDocumentContent(topic.content);
    if (
      before === undefined ||
      normalizeMemoryDocumentContent(before.content) !== content ||
      before.filename !== topic.filename
    ) {
      changes.push(put(`topics/${topic.filename}`, content));
    }
  }
  for (const [identity, topic] of priorTopics) {
    if (!targetIdentities.has(identity)) {
      changes.push({ op: 'delete', path: `topics/${topic.filename}` });
    }
  }
  return changes;
}

/** Whether the cloud would refuse a change as holding a secret (design §10.5). */
function holdsSecret(change: MemoryDocumentChange): boolean {
  return (
    change.op === 'put' &&
    redactMemoryContent(change.content) !== change.content
  );
}

/** A note a synced run read, as it read it: by file key, its ID and content hash. */
type PinnedInputs = ReadonlyMap<
  string,
  { noteId: string; contentHash: string }
>;

/**
 * The identity of every note and import in a synced run's input, taken
 * before generation from what the prompt holds, so the commit consumes
 * exactly those notes whatever their files hold by then.
 */
function pinInputs(
  input: ConsolidationInput,
  consumable: ReadonlyMap<string, LocalMemorySyncedNote>,
): PinnedInputs {
  const pinned = new Map<string, { noteId: string; contentHash: string }>();
  for (const file of [...input.inboxFiles, ...input.importFiles]) {
    const note = consumable.get(file.fileKey);
    if (note !== undefined) {
      pinned.set(file.fileKey, {
        noteId: note.noteId,
        contentHash: sha256Hex(file.content),
      });
    }
  }
  return pinned;
}

function consumedNoteIds(
  plan: MemoryConsolidationApplyPlan,
  pinned: PinnedInputs,
): string[] {
  return [...plan.consumedInboxFiles, ...plan.consumedImportFiles].flatMap(
    (file) => {
      const note = pinned.get(file.fileKey);
      return note === undefined ? [] : [note.noteId];
    },
  );
}

/**
 * Whether a pinned input is still the note it was, pending in the cloud as
 * far as this replica knows, with the bytes the run read.
 */
async function pinnedInputCurrent(
  scopeDir: string,
  fileKey: string,
  read: { noteId: string; contentHash: string },
  live: ReadonlyMap<string, LocalMemorySyncedNote>,
): Promise<boolean> {
  const note = live.get(fileKey);
  if (note?.noteId !== read.noteId) return false;
  if (note.contentHash !== null && note.contentHash !== read.contentHash) {
    return false;
  }
  const content = await readFile(join(scopeDir, fileKey), 'utf8').catch(
    (error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    },
  );
  return content !== null && sha256Hex(content) === read.contentHash;
}

/**
 * Prune candidates the cloud's usage also shows unused (design §15), under
 * the local rule: the cloud must have tracked uses for the whole unused
 * window, and a use on any device keeps a topic.
 */
function unusedAcrossDevices(
  usage: MemoryUsageAggregate,
  candidates: ConsolidationInputFile[],
  now: Date,
): ConsolidationInputFile[] {
  const trackedMs =
    usage.trackingSince === null
      ? 0
      : now.getTime() - Date.parse(usage.trackingSince);
  if (!(trackedMs >= MAX_UNUSED_DAYS * 24 * 60 * 60 * 1_000)) return [];
  const used = new Set(
    usage.entries
      .filter((entry) => entry.usageCount > 0)
      .map((entry) => memoryFileIdentity(entry.fileKey)),
  );
  return candidates.filter(
    (file) => !used.has(memoryFileIdentity(file.fileKey)),
  );
}

export async function runLocalMemoryConsolidation(
  options: RunConsolidationOptions,
): Promise<RunConsolidationResult> {
  // A synced replica changes its documents only through cloud commits, so
  // its run holds the scope's lease and commits instead of writing files. A
  // replica no engine keeps now (signed out, another account, sync off) is
  // never consolidated here.
  if (await isSyncedMemoryReplica(options.scopeDir)) {
    const hooks = localMemoryReplicaHooks();
    if (hooks === null) return { status: 'cancelled', reason: 'cancelled' };
    return hooks.runSyncedConsolidation(
      options.scopeDir,
      options.leaseReason ?? 'scheduled',
      (synced) => runConsolidation(options, synced),
    );
  }
  return runConsolidation(options, null);
}

async function runConsolidation(
  options: RunConsolidationOptions,
  synced: LocalMemorySyncedConsolidation | null,
): Promise<RunConsolidationResult> {
  const editRevision = await writableEditRevision(options.scopeDir);
  if (editRevision === null) {
    return { status: 'failed', reason: LOCAL_MEMORY_READ_ONLY_MESSAGE };
  }
  // The index and topics this run replaces, read before its input so the
  // input can only be newer: the commit runs only while the scope is still
  // exactly this state (compare-before-destroy), the consolidation snapshot
  // saves it, and a failed commit's rollback accepts only this state or the
  // one the commit was writing.
  const priorState = await readLocalMemoryState(options.scopeDir);
  const input = await collectConsolidationInput(
    options.scopeDir,
    synced === null ? {} : { consumable: synced.consumable },
  );
  const pinned = pinInputs(
    input,
    synced?.consumable ?? new Map<string, LocalMemorySyncedNote>(),
  );
  // The local path's checks, for a commit the cloud cannot make stale: no
  // edit through the app, no other change to the index or a topic, and every
  // note the run read still pending here with the bytes it read.
  const inputsCurrent =
    (consolidation: LocalMemorySyncedConsolidation) => (): Promise<boolean> =>
      withMemoryWriteLock(options.scopeDir, async () => {
        if ((await memoryEditRevision(options.scopeDir)) !== editRevision) {
          return false;
        }
        if (!(await localMemoryScopeHoldsState(options.scopeDir, priorState))) {
          return false;
        }
        const live = await consolidation.listConsumable();
        for (const [fileKey, read] of pinned) {
          if (
            !(await pinnedInputCurrent(options.scopeDir, fileKey, read, live))
          ) {
            return false;
          }
        }
        return true;
      });
  const commitSynced = async (
    consolidation: LocalMemorySyncedConsolidation,
    plan: MemoryConsolidationApplyPlan,
  ): Promise<boolean> => {
    const changes = plan.writesDocuments
      ? consolidationChanges(priorState, plan.output, plan.prunedTopics)
      : [];
    const consumed = consumedNoteIds(plan, pinned);
    if (changes.length === 0 && consumed.length === 0) return true;
    // The output is redacted, but the index line and sources a run keeps
    // come from the replica as it is, which may hold a local edit never
    // committed for its secret: nothing with a secret leaves the device.
    if (changes.some(holdsSecret)) {
      throw new Error(LOCAL_MEMORY_SYNCED_SECRET_MESSAGE);
    }
    const outcome = await consolidation.commit({
      changes,
      consumedNoteIds: consumed,
      prunedTopicPaths: plan.writesDocuments
        ? plan.prunedTopics.map((topic) => topic.fileKey)
        : [],
      model: { modelId: options.model, thinkingLevel: options.thinkingLevel },
      inputHash: input.inputHash ?? null,
      inputsCurrent: inputsCurrent(consolidation),
    });
    if (outcome === 'refused') {
      throw new Error(LOCAL_MEMORY_SYNCED_REFUSED_MESSAGE);
    }
    if (outcome !== 'committed') return false;
    const usage = await readUsage(options.scopeDir);
    await deleteStaleUsageRows(options.scopeDir, usage.entries.keys());
    return true;
  };
  const apply = async (
    plan: MemoryConsolidationApplyPlan,
  ): Promise<boolean> => {
    if (synced !== null) return commitSynced(synced, plan);
    const applied = await withMemoryWriteLock(options.scopeDir, async () => {
      if ((await memoryEditRevision(options.scopeDir)) !== editRevision) {
        return false;
      }
      if (plan.writesDocuments) {
        await recordMemoryEdit(options.scopeDir);
        if (options.snapshotBeforeWrite !== false) {
          await saveLocalMemorySnapshot(
            options.scopeDir,
            priorState,
            'consolidation',
            plan.now,
          );
        }
        try {
          await runVerifiedLocalMemoryWrite(
            options.scopeDir,
            [priorState],
            (guard) =>
              applyConsolidationOutput(
                options.scopeDir,
                guard,
                priorState,
                plan.output,
                plan.consumedInboxFiles,
                plan.consumedImportFiles,
                plan.prunedTopics,
                input.usageTrackingSince,
                plan.now.toISOString(),
              ),
          );
        } catch (error) {
          // Edited outside the app since this run read it: cancel like an
          // in-app edit, with nothing written.
          if (error instanceof LocalMemoryScopeChangedError) return false;
          throw error;
        }
      }
      return true;
    });
    if (applied) {
      // Usage-row cleanup runs after the transactional apply: a failure here
      // fails the run but must not roll back the committed consolidation —
      // stale rows are advisory-only and swept again on the next pass.
      const usage = await readUsage(options.scopeDir);
      await deleteStaleUsageRows(options.scopeDir, usage.entries.keys());
    }
    return applied;
  };
  const shouldContinue =
    synced === null
      ? options.shouldContinue
      : async (): Promise<boolean> =>
          synced.shouldContinue() &&
          (options.shouldContinue === undefined ||
            (await options.shouldContinue()));
  return runMemoryConsolidation(input, {
    model: consolidationModel(options),
    ...(shouldContinue ? { shouldContinue } : {}),
    listScopeTopics: () => readScopeTopicInventory(options.scopeDir),
    confirmPrunable: async (candidates) => {
      const local = await revalidatePruneCandidates(
        options.scopeDir,
        input.usageTrackingSince,
        candidates,
      );
      return synced === null
        ? local
        : unusedAcrossDevices(synced.usage, local, options.now ?? new Date());
    },
    apply,
    warn: (message, code) => {
      process.emitWarning(message, { code });
    },
    now: () => options.now ?? new Date(),
  });
}

/** What a merge consolidation would write, from {@link previewMemoryMerge}. */
export interface MemoryMergePreviewResult {
  output: ConsolidationOutput | null;
  /** Inbox and import file keys the output consumed. */
  consumedFileKeys: string[];
  model: { modelId: string; thinkingLevel?: string } | null;
  reason?: string;
}

/**
 * Runs consolidation over an input built elsewhere (the first-enable merge,
 * design §17) and returns the plan instead of applying it. Nothing is
 * written and nothing is pruned.
 *
 * `scopeTopics` is the whole document set the merge runs against, which the
 * input's own topics are only the budgeted part of: a topic left out of the
 * prompt exists without being replaceable, and the index may still link it.
 */
export async function previewMemoryMerge(
  input: ConsolidationInput,
  scopeTopics: ScopeTopicInventory,
  options: RunConsolidationOptions,
): Promise<MemoryMergePreviewResult> {
  const captured: { plan: MemoryConsolidationApplyPlan | null } = {
    plan: null,
  };
  const result = await runMemoryConsolidation(input, {
    model: consolidationModel(options),
    ...(options.shouldContinue
      ? { shouldContinue: options.shouldContinue }
      : {}),
    listScopeTopics: () => Promise.resolve(scopeTopics),
    confirmPrunable: () => Promise.resolve([]),
    apply: (next) => {
      captured.plan = next;
      return Promise.resolve(true);
    },
    warn: (message, code) => {
      process.emitWarning(message, { code });
    },
    now: () => options.now ?? new Date(),
  });
  const applied = captured.plan;
  if (applied === null || !applied.writesDocuments) {
    return {
      output: null,
      consumedFileKeys: [],
      model: null,
      reason: result.reason ?? result.status,
    };
  }
  return {
    output: applied.output,
    consumedFileKeys: [
      ...applied.consumedInboxFiles,
      ...applied.consumedImportFiles,
    ].map((file) => file.fileKey),
    model: {
      modelId: options.model,
      ...(options.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: options.thinkingLevel }),
    },
  };
}
