import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LocalMemoryConsolidationResult } from '@canopy/desktop-shared/types';
import { isRecord } from '../../lib/type-guards';
import type { RunConsolidationResult } from './consolidation-task';
import { ensureOwnerOnlyDir } from './memory-files';

const CONSOLIDATION_STATE_VERSION = 1;
const CONSOLIDATION_STATE_FILENAME = 'consolidation-state.json';
const RUN_RESULTS: ReadonlySet<string> =
  new Set<LocalMemoryConsolidationResult>([
    'success',
    'skipped',
    'failed',
    'cancelled',
  ]);

/**
 * Persisted per-scope consolidation state. `lastConsolidatedAt` and
 * `lastInputHash` describe the last successful run and always travel
 * together; the `lastRun*` fields describe the most recent run of any
 * outcome. Every field is optional so a scope whose only run failed can still
 * record why; files written before the run fields existed remain valid.
 */
export interface ConsolidationState {
  version: 1;
  lastConsolidatedAt?: string;
  lastInputHash?: string;
  lastRunAt?: string;
  lastResult?: LocalMemoryConsolidationResult;
  lastReason?: string;
}

export interface ConsolidationRunOutcome {
  result: LocalMemoryConsolidationResult;
  reason?: string;
  /** Required for `success`; the run is recorded as failed without it. */
  inputHash?: string;
  at?: string;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isInputHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isRunResult(value: unknown): value is LocalMemoryConsolidationResult {
  return typeof value === 'string' && RUN_RESULTS.has(value);
}

function normalizeConsolidationState(
  value: unknown,
): ConsolidationState | null {
  if (!isRecord(value) || value.version !== CONSOLIDATION_STATE_VERSION) {
    return null;
  }
  const state: ConsolidationState = { version: CONSOLIDATION_STATE_VERSION };
  if (
    isTimestamp(value.lastConsolidatedAt) &&
    isInputHash(value.lastInputHash)
  ) {
    state.lastConsolidatedAt = value.lastConsolidatedAt;
    state.lastInputHash = value.lastInputHash;
  }
  if (isTimestamp(value.lastRunAt) && isRunResult(value.lastResult)) {
    state.lastRunAt = value.lastRunAt;
    state.lastResult = value.lastResult;
    if (typeof value.lastReason === 'string' && value.lastReason !== '') {
      state.lastReason = value.lastReason;
    }
  }
  return Object.keys(state).length > 1 ? state : null;
}

export async function readConsolidationState(
  scopeDir: string,
): Promise<ConsolidationState | null> {
  let raw: string;
  try {
    raw = await readFile(join(scopeDir, CONSOLIDATION_STATE_FILENAME), 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeConsolidationState(parsed);
  } catch {
    return null;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export async function writeConsolidationState(
  scopeDir: string,
  state: Omit<ConsolidationState, 'version'>,
): Promise<void> {
  const filePath = join(scopeDir, CONSOLIDATION_STATE_FILENAME);
  const payload: ConsolidationState = {
    version: CONSOLIDATION_STATE_VERSION,
    ...(state.lastConsolidatedAt !== undefined &&
    state.lastInputHash !== undefined
      ? {
          lastConsolidatedAt: state.lastConsolidatedAt,
          lastInputHash: state.lastInputHash,
        }
      : {}),
    ...(state.lastRunAt !== undefined && state.lastResult !== undefined
      ? {
          lastRunAt: state.lastRunAt,
          lastResult: state.lastResult,
          ...(state.lastReason !== undefined
            ? { lastReason: state.lastReason }
            : {}),
        }
      : {}),
  };
  await writeFileAtomically(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Maps a task result to the outcome persisted for the explorer status line. */
export function consolidationRunOutcome(
  result: RunConsolidationResult,
): ConsolidationRunOutcome {
  switch (result.status) {
    case 'success':
      return result.inputHash === undefined
        ? { result: 'failed', reason: 'missing-input-hash' }
        : {
            result: 'success',
            inputHash: result.inputHash,
            ...(result.notice ? { reason: result.notice } : {}),
          };
    case 'clean':
      return { result: 'skipped', reason: 'clean' };
    case 'cancelled':
      return { result: 'cancelled', reason: result.reason ?? 'cancelled' };
    case 'partial':
      return { result: 'failed', reason: result.reason ?? 'partial-output' };
    case 'invalid-output':
      return { result: 'failed', reason: 'invalid-output' };
    case 'failed':
      return { result: 'failed', reason: result.reason ?? 'failed' };
  }
}

/**
 * Records a finished run. A success replaces the last-consolidated pair;
 * any other outcome keeps the previous success intact and only updates the
 * last-run fields.
 */
export async function recordConsolidationRun(
  scopeDir: string,
  outcome: ConsolidationRunOutcome,
): Promise<void> {
  const at = outcome.at ?? new Date().toISOString();
  const previous = await readConsolidationState(scopeDir).catch(() => null);
  const succeeded =
    outcome.result === 'success' && outcome.inputHash !== undefined;
  const recorded: ConsolidationRunOutcome =
    outcome.result === 'success' && !succeeded
      ? { result: 'failed', reason: 'missing-input-hash' }
      : outcome;
  const carried =
    previous?.lastConsolidatedAt !== undefined &&
    previous.lastInputHash !== undefined
      ? {
          lastConsolidatedAt: previous.lastConsolidatedAt,
          lastInputHash: previous.lastInputHash,
        }
      : {};
  await writeConsolidationState(scopeDir, {
    ...(succeeded
      ? { lastConsolidatedAt: at, lastInputHash: outcome.inputHash }
      : carried),
    lastRunAt: at,
    lastResult: recorded.result,
    ...(recorded.reason !== undefined ? { lastReason: recorded.reason } : {}),
  });
}

async function writeFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  // Owner-only like every other local-memory directory (0o700 with
  // fail-closed chmod), instead of a default-mode mkdir.
  await ensureOwnerOnlyDir(dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
