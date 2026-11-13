import { keepChatHistoryProfile } from './chat-history-profile';
import {
  isConsolidationInputClean,
  type ConsolidationInput,
  type ConsolidationInputFile,
  type ConsolidationInputOmission,
  type ConsolidationOutput,
} from './input';
import {
  clipMemoryIndex,
  indexSizeLabel,
  isMemoryIndexWithinLimits,
} from './memory-index';
import {
  CONSOLIDATION_RESULT_VALIDATION_SCHEMA,
  CONSOLIDATION_SCHEMA,
  compactionWritePolicy,
  consolidationWritePolicy,
  mergeCompactedOutput,
  normalizeAndValidateOutput,
  preservePartialConsolidationSources,
  resolveOutputIndexReferences,
  trackOutputEnvelope,
  type GeneratedConsolidationOutput,
  type TopicWritePolicy,
} from './output';
import {
  buildCompactionPrompt,
  buildConsolidationPrompt,
  CONSOLIDATION_SYSTEM_PROMPT,
} from './prompt';
import { shouldPruneMemoryFile, stripPrunedIndexLines } from './pruning';
import { topicIdentity, type ScopeTopicInventory } from './topic-identity';

export const INDEX_CLIPPED_NOTICE = 'index-clipped';

export interface MemoryConsolidationResult {
  status:
    | 'success'
    | 'partial'
    | 'clean'
    | 'cancelled'
    | 'invalid-output'
    | 'failed';
  inputHash?: string;
  reason?: string;
  /**
   * A successful run that still had to cut the index at boundaries after
   * the compaction retry; recorded as the run's reason.
   */
  notice?: typeof INDEX_CLIPPED_NOTICE;
}

export type MemoryConsolidationOutcome = 'success' | 'failure';

/** One structured model call: the run's answer or the index compaction. */
export interface MemoryConsolidationModelRequest {
  purpose: 'consolidation' | 'compaction';
  input: ConsolidationInput;
  systemPrompt: string;
  userMessage: string;
  schema: Record<string, unknown>;
  /** A looser schema for runners that validate the terminal result. */
  resultValidationSchema: Record<string, unknown>;
  isResult: (value: unknown) => value is GeneratedConsolidationOutput;
  /** For runners that see a result they reject. */
  onResultRejected: (payload: unknown) => void;
}

export interface MemoryConsolidationModelResponse {
  /** The structured answer, or null when the model gave none. */
  value: unknown;
  /**
   * Records how this call's answer ended once the run knows: accepted, or
   * rejected with a reason. Called at most once.
   */
  settle?: (outcome: MemoryConsolidationOutcome, reason?: string) => void;
}

/** What the host writes after a run produced output it accepts. */
export interface MemoryConsolidationApplyPlan {
  /** The index (pruned topics' lines removed) and the topics to write. */
  output: ConsolidationOutput;
  /** False when a partial answer left nothing to write. */
  writesDocuments: boolean;
  /** Inbox notes and imports the run consumed; empty for a partial run. */
  consumedInboxFiles: ConsolidationInputFile[];
  consumedImportFiles: ConsolidationInputFile[];
  /** Topics to archive, each re-checked by the host right before its move. */
  prunedTopics: ConsolidationInputFile[];
  now: Date;
}

/**
 * The host's side of a run. The model is injected; listings, prune checks
 * and the write read and change the host's storage.
 */
export interface MemoryConsolidationPorts {
  model: (
    request: MemoryConsolidationModelRequest,
  ) => Promise<MemoryConsolidationModelResponse>;
  shouldContinue?: () => boolean | Promise<boolean>;
  /**
   * Every topic the scope holds now, read from the scope itself. One port for
   * the names and the identities, so the write policy and the index links of
   * a run can never be built from different views of the scope.
   */
  listScopeTopics: () => Promise<ScopeTopicInventory>;
  /** The prune candidates still unused and unchanged now. */
  confirmPrunable: (
    candidates: ConsolidationInputFile[],
  ) => Promise<ConsolidationInputFile[]>;
  /** Writes the plan; false when memory changed since the input was read. */
  apply: (plan: MemoryConsolidationApplyPlan) => Promise<boolean>;
  warn: (message: string, code: string) => void;
  now: () => Date;
}

type Settle = (outcome: MemoryConsolidationOutcome, reason?: string) => void;

const NO_STRUCTURED_OUTPUT =
  'Local memory consolidation returned no structured output';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function once(settle: Settle | undefined): Settle {
  let settled = false;
  return (outcome, reason) => {
    if (settled || settle === undefined) return;
    settled = true;
    settle(outcome, reason);
  };
}

async function canContinue(ports: MemoryConsolidationPorts): Promise<boolean> {
  return ports.shouldContinue ? ports.shouldContinue() : true;
}

async function callModel(
  ports: MemoryConsolidationPorts,
  purpose: MemoryConsolidationModelRequest['purpose'],
  input: ConsolidationInput,
  userMessage: string,
): Promise<{ output: unknown; reason?: string; settle: Settle }> {
  const envelope = trackOutputEnvelope();
  const response = await ports.model({
    purpose,
    input,
    systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
    userMessage,
    schema: CONSOLIDATION_SCHEMA,
    resultValidationSchema: CONSOLIDATION_RESULT_VALIDATION_SCHEMA,
    isResult: envelope.isResult,
    onResultRejected: (payload) => {
      envelope.isResult(payload);
    },
  });
  const settle = once(response.settle);
  if (response.value === null) {
    settle('failure', envelope.error() ?? NO_STRUCTURED_OUTPUT);
    return { output: null, reason: envelope.error(), settle };
  }
  return { output: response.value, settle };
}

/**
 * Brings an over-limit index back within its limits: one compaction retry,
 * accepted only when its output is fully valid (so a bad retry never turns a
 * good run partial), then a boundary-aware cut of whatever is still over.
 * Returns null when the cut would leave no index at all.
 */
async function fitIndexToLimits(
  input: ConsolidationInput,
  output: ConsolidationOutput,
  runPolicy: TopicWritePolicy,
  ports: MemoryConsolidationPorts,
): Promise<{ output: ConsolidationOutput; clipped: boolean } | null> {
  let candidate = output;
  try {
    const scope = await ports.listScopeTopics();
    const prompt = buildCompactionPrompt(output, [...scope.names]);
    const policy = compactionWritePolicy(runPolicy, output, scope);
    const compaction = await callModel(ports, 'compaction', input, prompt);
    const validation = normalizeAndValidateOutput(compaction.output, policy);
    if (validation.output && validation.diagnostics.length === 0) {
      candidate = keepChatHistoryProfile(
        input.memoryMd,
        mergeCompactedOutput(output, validation.output),
      );
      compaction.settle('success');
    } else {
      const reason = validation.diagnostics.join('; ') || 'no compacted output';
      compaction.settle('failure', reason);
      ports.warn(
        `Local memory index compaction output rejected: ${reason}`,
        'LOCAL_MEMORY_CONSOLIDATION_COMPACTION_REJECTED',
      );
    }
  } catch (error) {
    ports.warn(
      `Local memory index compaction failed: ${errorMessage(error)}`,
      'LOCAL_MEMORY_CONSOLIDATION_COMPACTION_FAILED',
    );
  }
  if (isMemoryIndexWithinLimits(candidate.memoryMd)) {
    return { output: candidate, clipped: false };
  }
  const memoryMd = clipMemoryIndex(candidate.memoryMd);
  if (memoryMd.trim().length === 0) return null;
  ports.warn(
    `Local memory consolidation cut MEMORY.md from ${indexSizeLabel(candidate.memoryMd)} to ${indexSizeLabel(memoryMd)} after compaction`,
    'LOCAL_MEMORY_CONSOLIDATION_INDEX_CLIPPED',
  );
  return { output: { ...candidate, memoryMd }, clipped: true };
}

function warnAboutOmission(
  omission: ConsolidationInputOmission | undefined,
  label: string,
  code: string,
  ports: MemoryConsolidationPorts,
): void {
  if (!omission || omission.fileCount === 0) return;
  const fileNoun = omission.fileCount === 1 ? 'file' : 'files';
  const kilobytes = Math.ceil(omission.totalBytes / 1024);
  ports.warn(
    `Local memory consolidation classified the scope clean while ${omission.fileCount} ${label} ${fileNoun} (${kilobytes} KB) over the input budget remain pending`,
    code,
  );
}

function warnAboutCleanOmission(
  input: ConsolidationInput,
  ports: MemoryConsolidationPorts,
): void {
  // Reachable only through files no budget can hold (saved notes are clamped
  // far below it, and import staging refuses such sources): an oldest file
  // that alone busts the budget selects nothing yet leaves work pending, so
  // surface it rather than letting a 'clean' classification hide it.
  warnAboutOmission(
    input.omittedInboxFiles,
    'inbox',
    'LOCAL_MEMORY_CONSOLIDATION_INBOX_OMITTED',
    ports,
  );
  warnAboutOmission(
    input.omittedImportFiles,
    'imported',
    'LOCAL_MEMORY_CONSOLIDATION_IMPORT_OMITTED',
    ports,
  );
}

function pruneCandidates(
  input: ConsolidationInput,
  output: ConsolidationOutput,
  now: Date,
): ConsolidationInputFile[] {
  // Topic files this run just rewrote must never be pruned: their input
  // snapshot still carries pre-run usage and timestamps, but the written
  // file will hold the freshly consolidated content the MEMORY.md index
  // references. Compared by topic identity: a case-variant rewrite lands
  // in the same file on macOS and Windows.
  const writtenTopics = new Set(
    (output.topicFiles ?? []).map((topic) => topicIdentity(topic.filename)),
  );
  return input.topicFiles.filter(
    (file) =>
      !writtenTopics.has(topicIdentity(file.filename)) &&
      shouldPruneMemoryFile({
        fileKey: file.fileKey,
        usageCount: file.usage.usageCount,
        createdAt: file.usage.createdAt,
        modifiedAt: file.modifiedAt,
        trackingSince: input.usageTrackingSince,
        now,
      }),
  );
}

/**
 * One consolidation run over input the host collected: asks the model,
 * validates and normalizes its answer, compacts or clips an over-limit index,
 * resolves index references, decides what to prune, and hands the result to
 * the host's `apply`. Every storage effect goes through `ports`, so the
 * desktop and the Cloud run the same rules over their own storage.
 */
export async function runMemoryConsolidation(
  input: ConsolidationInput,
  ports: MemoryConsolidationPorts,
): Promise<MemoryConsolidationResult> {
  if (isConsolidationInputClean(input)) {
    warnAboutCleanOmission(input, ports);
    return { status: 'clean', inputHash: input.inputHash };
  }
  if (!(await canContinue(ports))) {
    return { status: 'cancelled', inputHash: input.inputHash };
  }

  let generated: unknown = null;
  let generationReason: string | undefined;
  let settle: Settle = once(undefined);
  try {
    const generation = await callModel(
      ports,
      'consolidation',
      input,
      buildConsolidationPrompt(input),
    );
    generated = generation.output;
    generationReason = generation.reason;
    settle = generation.settle;
  } catch (error) {
    const reason = errorMessage(error);
    ports.warn(reason, 'LOCAL_MEMORY_CONSOLIDATION_FAILED');
    return { status: 'failed', inputHash: input.inputHash, reason };
  }
  let writePolicy: TopicWritePolicy;
  try {
    writePolicy = consolidationWritePolicy(
      input,
      await ports.listScopeTopics(),
    );
  } catch (error) {
    settle('failure', errorMessage(error));
    throw error;
  }
  const validation = normalizeAndValidateOutput(generated, writePolicy);
  let output = validation.output;
  const diagnostics = validation.diagnostics;
  if (!output) {
    const reason = generationReason ?? diagnostics.join('; ');
    settle('failure', reason);
    ports.warn(reason, 'LOCAL_MEMORY_CONSOLIDATION_INVALID_OUTPUT');
    return { status: 'invalid-output', inputHash: input.inputHash, reason };
  }
  // The chat history profile is generated from chat titles and replaced on
  // every scan; anything consolidation merged into it would be lost then.
  output = keepChatHistoryProfile(input.memoryMd, output);
  let indexClipped = false;
  if (!isMemoryIndexWithinLimits(output.memoryMd)) {
    if (!(await canContinue(ports))) {
      settle(
        'failure',
        'Local memory consolidation was cancelled before compacting the index',
      );
      return { status: 'cancelled', inputHash: input.inputHash };
    }
    const fitted = await fitIndexToLimits(input, output, writePolicy, ports);
    if (fitted === null) {
      const reason = 'memoryMd: empty after clipping to index limits';
      settle('failure', reason);
      return { status: 'invalid-output', inputHash: input.inputHash, reason };
    }
    output = fitted.output;
    indexClipped = fitted.clipped;
  }
  if (!(await canContinue(ports))) {
    settle(
      'failure',
      'Local memory consolidation was cancelled before applying output',
    );
    return { status: 'cancelled', inputHash: input.inputHash };
  }

  let partial = diagnostics.length > 0;
  try {
    const existingNames = (await ports.listScopeTopics()).names;
    output.memoryMd = resolveOutputIndexReferences(
      output,
      existingNames,
      diagnostics,
    );
    partial = diagnostics.length > 0;
    if (partial)
      output = preservePartialConsolidationSources(
        input,
        output,
        existingNames,
      );
    const now = ports.now();
    // The prune set is validated against live state before MEMORY.md is
    // written: a candidate vetoed here keeps both its topic file and its
    // index line. Candidates that survive have their index lines stripped
    // below and are re-checked once more right before each move.
    const prunedTopics = await ports.confirmPrunable(
      partial ? [] : pruneCandidates(input, output, now),
    );
    const prunedOutput: ConsolidationOutput = {
      ...output,
      memoryMd: stripPrunedIndexLines(output.memoryMd, prunedTopics),
    };
    const applied = await ports.apply({
      output: prunedOutput,
      writesDocuments: !partial || (prunedOutput.topicFiles?.length ?? 0) > 0,
      consumedInboxFiles: partial ? [] : input.inboxFiles,
      consumedImportFiles: partial ? [] : input.importFiles,
      prunedTopics,
      now,
    });
    if (!applied) {
      settle('failure', 'Memory was edited before consolidation completed');
      return { status: 'cancelled', inputHash: input.inputHash };
    }
  } catch (error) {
    settle('failure', errorMessage(error));
    throw error;
  }

  if (partial) {
    const reason = `Partial consolidation: ${diagnostics.join('; ')}. Original memories and source notes retained for retry.`;
    settle('failure', reason);
    ports.warn(reason, 'LOCAL_MEMORY_CONSOLIDATION_PARTIAL_OUTPUT');
    return { status: 'partial', inputHash: input.inputHash, reason };
  }
  settle('success');
  return {
    status: 'success',
    inputHash: input.inputHash,
    ...(indexClipped ? { notice: INDEX_CLIPPED_NOTICE } : {}),
  };
}
