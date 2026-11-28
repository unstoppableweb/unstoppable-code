import { createHash } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LocalMemoryScopeRequest } from '@canopy/desktop-shared/types';
import { localMemoryScopeDir } from '../scope-resolver';
import {
  importEntryFitsBudget,
  logicalMemorySourcePath,
  type MemoryImportSourceTool,
} from '@canopy/memory-consolidation/input-budget';
import { withMemoryWriteLock } from '../edit-coordination';
import {
  assertMemoryPathContained,
  assertMemoryScopeLockHeld,
} from '@canopy/memory-store/memory-files';
import { memoryNoteIdAt } from '@canopy/memory-store/note-identity';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import { resolveLocalMemoryPolicy } from '../policy';
import {
  CLAUDE_MEMORY_MAX_FILE_BYTES,
  discoverClaudeMemoryFiles,
  discoverCodexMemoryFiles,
  type LocalMemoryDiscoveryResult,
  type LocalMemorySourceFile,
} from './discovery';
import {
  isLiveImportEntry,
  readImportState,
  writeImportState,
  type ImportSkipReason,
  type ImportState,
  type ImportStateEntry,
  type ImportStateStagedEntry,
} from '@canopy/memory-store/import/ledger';
import {
  routeClaudeMemoryContent,
  routeCodexMemoryContent,
  type RoutedMemoryContent,
} from './scope-routing';
import {
  prepareStagedMemoryContent,
  stagedFilenameForSource,
  stageImportedMemory,
} from './staging';

export const LOCAL_MEMORY_IMPORT_SOURCE_BUDGET_BYTES = 256 * 1024;
export const CLAUDE_IMPORT_SOURCE_BUDGET_BYTES =
  LOCAL_MEMORY_IMPORT_SOURCE_BUDGET_BYTES;

interface ClaudeMemoryImportBaseOptions {
  repoPath: string;
  repoId?: string;
  scopeFilter?: 'user' | 'workspace';
  checkedAt?: string;
  sourcePaths?: readonly string[];
}

export interface ClaudeMemoryWorkspaceImportOptions extends ClaudeMemoryImportBaseOptions {
  workspaceId: string;
  worktreeId?: string;
  userScope?: never;
}

export interface ClaudeMemoryUserImportOptions extends ClaudeMemoryImportBaseOptions {
  userScope: true;
  /** Origin project for queued per-project user imports; omit for global sources. */
  workspaceId?: string;
  worktreeId?: never;
}

export type ClaudeMemoryImportOptions =
  | ClaudeMemoryWorkspaceImportOptions
  | ClaudeMemoryUserImportOptions;

export interface CodexMemoryImportOptions {
  userScope: true;
  codexHome?: string;
  checkedAt?: string;
  sourcePaths?: readonly string[];
}

export interface ClaudeMemoryImportResult {
  staged: number;
  skippedUnchanged: number;
  skippedOversize: number;
  oversizePaths: string[];
  skippedUndrainable: number;
  deferred: number;
  errors: string[];
}

interface PendingImport {
  source: LocalMemorySourceFile;
  scopeDir: string;
  stagedContent: string;
  modified: string;
  fileHash: string;
  state: ImportState;
}

type LocalMemoryImportOptions =
  | ClaudeMemoryImportOptions
  | CodexMemoryImportOptions;

interface LocalMemoryImportProvider {
  sourceTool: MemoryImportSourceTool;
  displayName: string;
  discover: () => Promise<LocalMemoryDiscoveryResult>;
  route: (raw: string, fileMtime: Date) => RoutedMemoryContent;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/**
 * What decides where an import run stages a source: the project it imports
 * from (if any), whether it imports into user memory, and the scope it is
 * limited to. Every import option type is one.
 */
interface ImportRoutingOptions {
  workspaceId?: string;
  worktreeId?: string;
  userScope?: true;
  scopeFilter?: 'user' | 'workspace';
}

function isWorkspaceOptions<T extends ImportRoutingOptions>(
  options: T,
): options is T & { workspaceId: string } {
  return typeof options.workspaceId === 'string';
}

async function resolveWorkspaceScopeDir(options: {
  workspaceId: string;
  worktreeId?: string;
}): Promise<string | null> {
  const policy = await resolveLocalMemoryPolicy({
    projectId: options.workspaceId,
    worktreeId: options.worktreeId ?? options.workspaceId,
  });
  return policy.kind === 'scoped'
    ? localMemoryScopeDir({
        scope: 'workspace',
        workspaceId: policy.workspaceId,
      })
    : null;
}

async function resolveTargetScopeDir(
  options: ImportRoutingOptions,
  scope: 'user' | 'workspace',
): Promise<string | null> {
  if (isWorkspaceOptions(options)) {
    const policy = await resolveLocalMemoryPolicy({
      projectId: options.workspaceId,
      worktreeId: options.worktreeId ?? options.workspaceId,
    });
    if (policy.kind !== 'scoped') return null;
    if (policy.privateMemory) {
      return options.userScope === true
        ? null
        : localMemoryScopeDir({
            scope: 'workspace',
            workspaceId: policy.workspaceId,
          });
    }
  }
  if (scope === 'user') {
    return localMemoryScopeDir({ scope: 'user' });
  }
  return isWorkspaceOptions(options) ? resolveWorkspaceScopeDir(options) : null;
}

/**
 * The memory folder an import run stages a routed source into, applying the
 * current local memory policy of the project it imports from: none when that
 * project blocks memory, always the project when its memory is private,
 * otherwise the routed scope, and only within the run's scope filter. Null
 * when the run stages it nowhere.
 */
async function importDestination(
  options: ImportRoutingOptions,
  routedScope: 'user' | 'workspace',
): Promise<string | null> {
  const policy = isWorkspaceOptions(options)
    ? await resolveLocalMemoryPolicy({
        projectId: options.workspaceId,
        worktreeId: options.worktreeId ?? options.workspaceId,
      })
    : null;
  if (policy?.kind === 'blocked' || policy?.kind === 'unscoped') return null;
  const scope =
    policy?.kind === 'scoped' && policy.privateMemory
      ? 'workspace'
      : routedScope;
  if (options.scopeFilter !== undefined && scope !== options.scopeFilter) {
    return null;
  }
  return resolveTargetScopeDir(options, scope);
}

/** Whether a staged import's prompt entry can ever fit the input budget. */
function stagedImportFitsBudget(options: {
  sourceTool: MemoryImportSourceTool;
  sourcePath: string;
  stagedFilename: string;
  repo?: string;
  modified: string;
  stagedContent: string;
}): boolean {
  return importEntryFitsBudget({
    filename: options.stagedFilename,
    originalPath: redactMemoryContent(
      logicalMemorySourcePath(options.sourceTool, options.sourcePath),
    ),
    sourceFilename: redactMemoryContent(basename(options.sourcePath)),
    ...(options.repo ? { repo: options.repo } : {}),
    modified: options.modified,
    content: options.stagedContent,
    sourceTool: options.sourceTool,
  });
}

/** The ledger entry for a source just staged as `stagedAs`, with a new note ID. */
function stagedImportEntry(options: {
  sourceTool: MemoryImportSourceTool;
  fileHash: string;
  checkedAt: string;
  stagedAs: string;
  repo?: string;
  workspaceId?: string;
  modified: string;
}): ImportStateStagedEntry {
  const importedMs = Date.now();
  return {
    fileHash: options.fileHash,
    importedAt: new Date(importedMs).toISOString(),
    noteId: memoryNoteIdAt(importedMs),
    checkedAt: options.checkedAt,
    stagedAs: options.stagedAs,
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    modified: options.modified,
    ...(options.sourceTool === 'codex' ? { sourceTool: 'codex' } : {}),
  };
}

/**
 * Stages one source and records it in the ledger as it is now, in one
 * critical section. When another run already staged these bytes under this
 * name, its entry, note ID included, stays and nothing is staged again.
 * Callers hold the scope's write lock.
 */
async function stageAndRecordImport(options: {
  scopeDir: string;
  source: LocalMemorySourceFile;
  stagedFilename: string;
  fileHash: string;
  content: string;
  entry: (stagedAs: string) => ImportStateStagedEntry;
}): Promise<{ entry: ImportStateStagedEntry; staged: boolean }> {
  const { scopeDir, source, fileHash } = options;
  const ledger = await readImportState(scopeDir);
  const current = ledger.sources[source.sourcePath];
  const previous = current && 'stagedAs' in current ? current : undefined;
  if (
    previous?.fileHash === fileHash &&
    previous.stagedAs === `imported/${options.stagedFilename}`
  ) {
    return { entry: previous, staged: false };
  }
  const stagedAs = await stageImportedMemory({
    scopeDir,
    sourcePath: source.sourcePath,
    originalName: source.originalName,
    fileHash,
    content: options.content,
    ...(previous && isLiveImportEntry(previous)
      ? { previousStagedAs: previous.stagedAs }
      : {}),
  });
  const entry = options.entry(stagedAs);
  ledger.sources[source.sourcePath] = entry;
  await writeImportState(scopeDir, ledger);
  return { entry, staged: true };
}

function newResult(): ClaudeMemoryImportResult {
  return {
    staged: 0,
    skippedUnchanged: 0,
    skippedOversize: 0,
    oversizePaths: [],
    skippedUndrainable: 0,
    deferred: 0,
    errors: [],
  };
}

/** A run's change to one ledger entry: a new entry, or only a fresh check time. */
type ImportStateChange = ImportStateEntry | { checkedAt: string; touch: true };

/**
 * Applies a run's ledger changes over the ledger as it is now, under the
 * scope's write lock, so entries another writer changed since the run read
 * the ledger (a consolidation stamping an import) are kept.
 */
async function writeImportStateChanges(
  scopeDir: string,
  changes: ReadonlyMap<string, ImportStateChange>,
): Promise<void> {
  await withMemoryWriteLock(scopeDir, async () => {
    const latest = await readImportState(scopeDir);
    for (const [sourcePath, change] of Array.from(changes)) {
      if (!('touch' in change)) {
        latest.sources[sourcePath] = change;
        continue;
      }
      const current = latest.sources[sourcePath];
      if (current) {
        latest.sources[sourcePath] = {
          ...current,
          checkedAt: change.checkedAt,
        };
      }
    }
    await writeImportState(scopeDir, latest);
  });
}

async function runLocalMemoryImport(
  options: LocalMemoryImportOptions,
  provider: LocalMemoryImportProvider,
): Promise<ClaudeMemoryImportResult> {
  const result = newResult();
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const scopeFilter =
    'scopeFilter' in options ? options.scopeFilter : undefined;
  const repoId = 'repoId' in options ? options.repoId : undefined;
  const originWorkspaceId = isWorkspaceOptions(options)
    ? options.workspaceId
    : undefined;
  let discovery;
  try {
    discovery = await provider.discover();
  } catch (error) {
    result.errors.push(errorMessage(error));
    return result;
  }
  const shouldProcessSource = (sourcePath: string): boolean =>
    options.sourcePaths === undefined ||
    options.sourcePaths.includes(sourcePath);
  result.oversizePaths = discovery.oversizeFiles.filter((sourcePath) =>
    shouldProcessSource(sourcePath),
  );
  result.skippedOversize = result.oversizePaths.length;
  if (result.skippedOversize > 0) {
    process.emitWarning(
      `Skipped ${result.skippedOversize} ${provider.displayName} memory file(s) over the 4 MiB source limit`,
      { code: 'LOCAL_MEMORY_IMPORT_OVERSIZE_SKIPPED' },
    );
  }

  const states = new Map<string, ImportState>();
  const changes = new Map<string, Map<string, ImportStateChange>>();
  const recordChange = (
    scopeDir: string,
    sourcePath: string,
    change: ImportStateChange,
  ): void => {
    const scopeChanges =
      changes.get(scopeDir) ?? new Map<string, ImportStateChange>();
    scopeChanges.set(sourcePath, change);
    changes.set(scopeDir, scopeChanges);
  };
  const ioUnavailableScopeDirs = new Set<string>();
  const stateForScope = async (
    scopeDir: string,
  ): Promise<ImportState | null> => {
    const existing = states.get(scopeDir);
    if (existing) {
      return existing;
    }
    if (ioUnavailableScopeDirs.has(scopeDir)) {
      return null;
    }
    try {
      const state = await readImportState(scopeDir);
      states.set(scopeDir, state);
      return state;
    } catch (error) {
      // Corrupt/schema-invalid ledgers recover to empty state in the reader;
      // a rejection here is a genuine filesystem I/O failure for the scope.
      ioUnavailableScopeDirs.add(scopeDir);
      result.errors.push(`${scopeDir}: ${errorMessage(error)}`);
      return null;
    }
  };

  const markSkipped = async (
    scopeDir: string,
    sourcePath: string,
    skipReason: ImportSkipReason,
  ): Promise<void> => {
    const state = await stateForScope(scopeDir);
    if (state === null) {
      return;
    }
    const previous = state.sources[sourcePath];
    if (previous && isLiveImportEntry(previous)) {
      await withMemoryWriteLock(scopeDir, async () => {
        try {
          const stagedPath = join(scopeDir, previous.stagedAs);
          await assertMemoryPathContained(scopeDir, stagedPath);
          await assertMemoryScopeLockHeld();
          await unlink(stagedPath);
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) {
            throw error;
          }
        }
      });
    }
    state.sources[sourcePath] = { checkedAt, skipReason };
    recordChange(scopeDir, sourcePath, state.sources[sourcePath]);
  };

  const oversizeScopes: Array<'user' | 'workspace'> = scopeFilter
    ? [scopeFilter]
    : isWorkspaceOptions(options)
      ? ['user', 'workspace']
      : ['user'];
  for (const sourcePath of discovery.oversizeFiles) {
    if (!shouldProcessSource(sourcePath)) {
      continue;
    }
    for (const scope of oversizeScopes) {
      const scopeDir = await resolveTargetScopeDir(options, scope);
      if (scopeDir !== null) {
        try {
          await markSkipped(scopeDir, sourcePath, 'oversize');
        } catch (error) {
          result.errors.push(`${sourcePath}: ${errorMessage(error)}`);
        }
      }
    }
  }

  const pending: PendingImport[] = [];
  const countedStagedPaths = new Set<string>();
  let pendingStagedBytes = 0;
  const orderedFiles = [...discovery.files].sort(
    (left, right) =>
      left.modifiedAt.getTime() - right.modifiedAt.getTime() ||
      left.sourcePath.localeCompare(right.sourcePath),
  );
  for (const source of orderedFiles) {
    if (!shouldProcessSource(source.sourcePath)) {
      continue;
    }
    let originalContent: string;
    try {
      originalContent = await readFile(source.sourcePath, 'utf8');
    } catch (error) {
      result.errors.push(`${source.sourcePath}: ${errorMessage(error)}`);
      continue;
    }
    const routed = provider.route(originalContent, source.modifiedAt);
    const scopeDir = await importDestination(options, routed.scope);
    if (scopeDir === null) {
      continue;
    }
    const state = await stateForScope(scopeDir);
    if (state === null) {
      continue;
    }
    const fileHash = createHash('sha256').update(originalContent).digest('hex');
    const existingEntry = state.sources[source.sourcePath];
    if (
      existingEntry &&
      'fileHash' in existingEntry &&
      existingEntry.fileHash === fileHash
    ) {
      result.skippedUnchanged += 1;
      if (existingEntry.checkedAt !== checkedAt) {
        state.sources[source.sourcePath] = {
          ...existingEntry,
          checkedAt,
        };
        recordChange(scopeDir, source.sourcePath, { checkedAt, touch: true });
      }
      const stagedPath = join(scopeDir, existingEntry.stagedAs);
      if (
        isLiveImportEntry(existingEntry) &&
        existingEntry.consolidatedAt === undefined &&
        !countedStagedPaths.has(stagedPath)
      ) {
        try {
          pendingStagedBytes += (await stat(stagedPath)).size;
          countedStagedPaths.add(stagedPath);
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) {
            result.errors.push(`${stagedPath}: ${errorMessage(error)}`);
          }
        }
      }
      continue;
    }
    pending.push({
      source,
      scopeDir,
      stagedContent: prepareStagedMemoryContent(routed.content),
      modified: routed.modified,
      fileHash,
      state,
    });
  }

  let stagedBytes = pendingStagedBytes;
  let capacityReached = false;
  for (const item of pending) {
    const stagedFilename = stagedFilenameForSource(
      item.source.sourcePath,
      item.source.originalName,
      item.fileHash,
    );
    if (
      !stagedImportFitsBudget({
        sourceTool: provider.sourceTool,
        sourcePath: item.source.sourcePath,
        stagedFilename,
        ...(repoId ? { repo: repoId } : {}),
        modified: item.modified,
        stagedContent: item.stagedContent,
      })
    ) {
      result.skippedUndrainable += 1;
      try {
        await markSkipped(item.scopeDir, item.source.sourcePath, 'undrainable');
      } catch (error) {
        result.errors.push(`${item.source.sourcePath}: ${errorMessage(error)}`);
      }
      process.emitWarning(
        `Skipped ${item.source.sourcePath}: its serialized prompt entry could never fit the consolidation imports input budget`,
        { code: 'LOCAL_MEMORY_IMPORT_UNDRAINABLE_SKIPPED' },
      );
      continue;
    }
    // Charge the exact prepared representation written to disk, matching
    // pendingStagedBytes' stat-derived sizes for files staged in earlier runs.
    const contentBytes = Buffer.byteLength(item.stagedContent, 'utf8');
    if (
      capacityReached ||
      stagedBytes + contentBytes > LOCAL_MEMORY_IMPORT_SOURCE_BUDGET_BYTES
    ) {
      capacityReached = true;
      result.deferred += 1;
      try {
        await markSkipped(item.scopeDir, item.source.sourcePath, 'deferred');
      } catch (error) {
        result.errors.push(`${item.source.sourcePath}: ${errorMessage(error)}`);
      }
      continue;
    }
    try {
      const recorded = await withMemoryWriteLock(item.scopeDir, () =>
        stageAndRecordImport({
          scopeDir: item.scopeDir,
          source: item.source,
          stagedFilename,
          fileHash: item.fileHash,
          content: item.stagedContent,
          entry: (stagedAs) =>
            stagedImportEntry({
              sourceTool: provider.sourceTool,
              fileHash: item.fileHash,
              checkedAt,
              stagedAs,
              ...(repoId ? { repo: repoId } : {}),
              ...(originWorkspaceId ? { workspaceId: originWorkspaceId } : {}),
              modified: item.modified,
            }),
        }),
      );
      item.state.sources[item.source.sourcePath] = recorded.entry;
      stagedBytes += contentBytes;
      if (recorded.staged) {
        result.staged += 1;
      } else {
        result.skippedUnchanged += 1;
        if (recorded.entry.checkedAt !== checkedAt) {
          recordChange(item.scopeDir, item.source.sourcePath, {
            checkedAt,
            touch: true,
          });
        }
      }
    } catch (error) {
      result.errors.push(`${item.source.sourcePath}: ${errorMessage(error)}`);
    }
  }
  if (result.deferred > 0) {
    process.emitWarning(
      `Deferred ${result.deferred} ${provider.displayName} memory file(s) after reaching the 256 KiB source import limit`,
      { code: 'LOCAL_MEMORY_IMPORT_DEFERRED' },
    );
  }

  for (const [scopeDir, scopeChanges] of Array.from(changes)) {
    try {
      await writeImportStateChanges(scopeDir, scopeChanges);
    } catch (error) {
      result.errors.push(`${scopeDir}: ${errorMessage(error)}`);
    }
  }
  return result;
}

const ROUTE_BY_SOURCE_TOOL: Record<
  MemoryImportSourceTool,
  LocalMemoryImportProvider['route']
> = {
  'claude-code': routeClaudeMemoryContent,
  codex: routeCodexMemoryContent,
};

/**
 * Why an import cannot be staged again into the memory being rebuilt:
 * `moved` when an import run would now stage it elsewhere or nowhere (its
 * routing or its project's local memory policy changed since it was
 * imported), `origin-unknown` when the project it came from was not
 * recorded, so its policy cannot be checked.
 */
export class ImportRestageRefusedError extends Error {
  constructor(
    readonly kind: 'moved' | 'origin-unknown',
    sourcePath: string,
  ) {
    super(
      kind === 'moved'
        ? `${sourcePath} no longer imports into this memory`
        : `${sourcePath} has no recorded project to check its policy`,
    );
    this.name = 'ImportRestageRefusedError';
  }
}

/**
 * The options the import run that stages this source into `target` runs
 * with, so a restage routes it exactly as that run would. Null when no run
 * could be identified: a project's import into user memory that did not
 * record its project.
 */
function restageRoutingOptions(
  target: LocalMemoryScopeRequest,
  previous: ImportStateStagedEntry,
): ImportRoutingOptions | null {
  if (previous.sourceTool === 'codex') return { userScope: true };
  if (target.scope === 'workspace') {
    return { workspaceId: target.workspaceId, scopeFilter: 'workspace' };
  }
  return previous.workspaceId === undefined
    ? null
    : {
        userScope: true,
        workspaceId: previous.workspaceId,
        scopeFilter: 'user',
      };
}

/**
 * Stages one previously imported source again from its original file, the
 * way an import run stages it: same routing and local memory policy,
 * normalization, redaction, size and budget limits, staged name, and ledger
 * entry shape. It stages only into `scopeDir`, the memory being rebuilt
 * (`target`), and only when the import run for that memory would stage the
 * source there today; otherwise it rejects with
 * {@link ImportRestageRefusedError}, and the run for the memory it now
 * belongs to imports it there. The caller writes the returned entry to the
 * ledger. Rejects, staging nothing, when the original is not a readable
 * regular file within the source size limit, or its prompt entry could never
 * fit the consolidation input budget; it also refuses to replace a staged
 * file that already exists under the new name.
 */
export async function restageImportSource(options: {
  scopeDir: string;
  target: LocalMemoryScopeRequest;
  sourcePath: string;
  previous: ImportStateStagedEntry;
  checkedAt?: string;
}): Promise<ImportStateStagedEntry> {
  const { scopeDir, sourcePath, previous } = options;
  const sourceTool = previous.sourceTool ?? 'claude-code';
  const routing = restageRoutingOptions(options.target, previous);
  if (routing === null) {
    throw new ImportRestageRefusedError('origin-unknown', sourcePath);
  }
  const info = await stat(sourcePath);
  if (!info.isFile()) {
    throw new Error(`${sourcePath} is not a file`);
  }
  if (info.size > CLAUDE_MEMORY_MAX_FILE_BYTES) {
    throw new Error(`${sourcePath} is over the 4 MiB source limit`);
  }
  const originalContent = await readFile(sourcePath, 'utf8');
  const routed = ROUTE_BY_SOURCE_TOOL[sourceTool](originalContent, info.mtime);
  if ((await importDestination(routing, routed.scope)) !== scopeDir) {
    throw new ImportRestageRefusedError('moved', sourcePath);
  }
  const stagedContent = prepareStagedMemoryContent(routed.content);
  const fileHash = createHash('sha256').update(originalContent).digest('hex');
  const stagedFilename = stagedFilenameForSource(
    sourcePath,
    basename(sourcePath),
    fileHash,
  );
  if (
    !stagedImportFitsBudget({
      sourceTool,
      sourcePath,
      stagedFilename,
      ...(previous.repo ? { repo: previous.repo } : {}),
      modified: routed.modified,
      stagedContent,
    })
  ) {
    throw new Error(
      `${sourcePath} could never fit the consolidation imports input budget`,
    );
  }
  const alreadyStaged = await stat(
    join(scopeDir, 'imported', stagedFilename),
  ).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    },
  );
  if (alreadyStaged) {
    throw new Error(`imported/${stagedFilename} already exists`);
  }
  const stagedAs = await stageImportedMemory({
    scopeDir,
    sourcePath,
    originalName: basename(sourcePath),
    fileHash,
    content: stagedContent,
  });
  return stagedImportEntry({
    sourceTool,
    fileHash,
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    stagedAs,
    ...(previous.repo ? { repo: previous.repo } : {}),
    ...(routing.workspaceId ? { workspaceId: routing.workspaceId } : {}),
    modified: routed.modified,
  });
}

export function runClaudeMemoryImport(
  options: ClaudeMemoryImportOptions,
): Promise<ClaudeMemoryImportResult> {
  return runLocalMemoryImport(options, {
    sourceTool: 'claude-code',
    displayName: 'Claude Code',
    discover: () => discoverClaudeMemoryFiles(options.repoPath),
    route: routeClaudeMemoryContent,
  });
}

export function runCodexMemoryImport(
  options: CodexMemoryImportOptions,
): Promise<ClaudeMemoryImportResult> {
  return runLocalMemoryImport(options, {
    sourceTool: 'codex',
    displayName: 'Codex',
    discover: () => discoverCodexMemoryFiles(options.codexHome),
    route: routeCodexMemoryContent,
  });
}
