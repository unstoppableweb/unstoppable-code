/**
 * The main-owned attempt journal of a `create-worktree` host step.
 *
 * The W5 creation receipt covers the creation only; this journal adds the
 * effects after it (setup launch, script identities, grouping) and the
 * complete terminal result, so a replay never relaunches setup or regroups
 * and returns what the first attempt returned. It supplements worktree
 * tracking and never replaces it.
 *
 * Stored at `<artifactsDir>/attempt.json`, written atomically (temp file and
 * rename) through an in-process chain per file. Each phase is written before
 * the effect it names. Unknown versions and corrupt records read as
 * `corrupt`, which the adapter fails closed on.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { PIPELINE_HOST_FAILURE_REASONS } from '@canopy/execution-engine/pipelines/host-actions';
import type { CreateWorktreeInputs } from '@canopy/execution-engine/pipelines/host-create-worktree';
import type { PipelineHostActionCaller } from '@canopy/execution-engine/node/pipelines/executor/types';
import { writeFileAtomically } from '../lib/atomic-file';
import { isRecord } from '../lib/type-guards';

export const ATTEMPT_JOURNAL_FILE = 'attempt.json';

/**
 * - `creating`: written before the creation call; W5 decides on replay.
 * - `created`: the outcome is known (identifiers recorded); setup not admitted.
 *   The only phase a replay resumes.
 * - `setup_starting`: written before the setup runner launches.
 * - `setup_running`: the runner resolved its scripts.
 * - `finalized`: the terminal result is recorded.
 * - `uncertain`: an effect's outcome couldn't be recorded; replay fails closed.
 */
export const ATTEMPT_PHASES = [
  'creating',
  'created',
  'setup_starting',
  'setup_running',
  'finalized',
  'uncertain',
] as const;

export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

const attemptScriptSchema = z.object({
  scriptKey: z.string(),
  runId: z.string(),
  target: z.enum(['project', 'workspace-root', 'workspace-repo']),
  lifecycle: z.enum(['before-setup', 'setup', 'after-setup']),
  repoId: z.string().optional(),
  /** The canonical log's project id (the store's key), when a log started. */
  logProjectId: z.string().optional(),
  /** Artifact file name, relative to the artifacts dir; absent until copied. */
  logFile: z.string().optional(),
});

export type AttemptScript = z.infer<typeof attemptScriptSchema>;

export const hostResultSchema = z.union([
  z.object({
    status: z.literal('success'),
    outputs: z.record(z.string(), z.string()),
  }),
  z.object({
    status: z.literal('failure'),
    failureReason: z.enum(PIPELINE_HOST_FAILURE_REASONS),
    error: z.string(),
    outputs: z.record(z.string(), z.string()),
  }),
]);

const attemptRecordSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string(),
  owner: z.string().nullable(),
  attempt: z.object({
    executionId: z.string(),
    jobId: z.string(),
    childId: z.string().optional(),
    stepId: z.string(),
    attempt: z.number(),
    iteration: z.number(),
  }),
  phase: z.enum(ATTEMPT_PHASES),
  worktree: z
    .object({
      taskId: z.string(),
      branchName: z.string(),
      createdAt: z.string(),
      path: z.string(),
      workspaceKind: z.enum(['single-repo', 'multi-repo']),
    })
    .optional(),
  /** Whether setup scripts were configured, once the runner resolved them. */
  setupConfigured: z.boolean().optional(),
  /**
   * The runner settled, so `scripts` is the whole lifecycle. Without it a
   * replay can't tell a finished lifecycle from one interrupted between
   * scripts, and fails closed.
   */
  setupSettled: z.boolean().optional(),
  /**
   * The settled runner reported failure itself (an error stopped the
   * lifecycle), even if every recorded script succeeded.
   */
  setupRunFailed: z.boolean().optional(),
  scripts: z.array(attemptScriptSchema),
  /** The group outputs, once assignment ran; never assigned again on replay. */
  group: z.record(z.string(), z.string()).optional(),
  result: hostResultSchema.optional(),
});

export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export type AttemptRead =
  | { kind: 'absent' }
  | { kind: 'corrupt' }
  | { kind: 'ok'; record: AttemptRecord };

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Canonical inputs, setup mode and group included; key order never matters. */
export function createWorktreeRequestFingerprint(
  inputs: CreateWorktreeInputs,
): string {
  return createHash('sha256').update(canonicalJson(inputs)).digest('hex');
}

export function newAttemptRecord(
  inputs: CreateWorktreeInputs,
  caller: PipelineHostActionCaller,
): AttemptRecord {
  return {
    version: 1,
    fingerprint: createWorktreeRequestFingerprint(inputs),
    owner: caller.executionContext ?? null,
    attempt: {
      executionId: caller.executionId,
      jobId: caller.jobId,
      ...(caller.childId !== undefined ? { childId: caller.childId } : {}),
      stepId: caller.stepId,
      attempt: caller.attempt,
      iteration: caller.iteration,
    },
    phase: 'creating',
    scripts: [],
  };
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export async function readAttemptRecord(
  artifactsDir: string,
): Promise<AttemptRead> {
  let text: string;
  try {
    text = await readFile(
      path.join(artifactsDir, ATTEMPT_JOURNAL_FILE),
      'utf8',
    );
  } catch (error) {
    if (isMissingFileError(error)) return { kind: 'absent' };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'corrupt' };
  }
  const record = attemptRecordSchema.safeParse(parsed);
  return record.success
    ? { kind: 'ok', record: record.data }
    : { kind: 'corrupt' };
}

const writeChains = new Map<string, Promise<void>>();

/** Hook for crash-injection tests: runs before each journal write lands. */
let beforeJournalWrite: ((record: AttemptRecord) => void) | undefined;

export function setBeforeJournalWriteForTests(
  hook: ((record: AttemptRecord) => void) | undefined,
): void {
  beforeJournalWrite = hook;
}

/**
 * Writes the whole record atomically, serialized per file in this process.
 * Resolves once the record is on disk; a failed write rejects.
 */
export function writeAttemptRecord(
  artifactsDir: string,
  record: AttemptRecord,
): Promise<void> {
  const filePath = path.join(artifactsDir, ATTEMPT_JOURNAL_FILE);
  const snapshot = structuredClone(record);
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      beforeJournalWrite?.(snapshot);
      await mkdir(artifactsDir, { recursive: true });
      // Durable: each phase must survive a crash before its effect runs.
      await writeFileAtomically(
        filePath,
        `${JSON.stringify(snapshot, null, 2)}\n`,
        { encoding: 'utf8', durable: true },
      );
    });
  writeChains.set(filePath, next);
  void next
    .finally(() => {
      if (writeChains.get(filePath) === next) writeChains.delete(filePath);
    })
    .catch(() => undefined);
  return next;
}
