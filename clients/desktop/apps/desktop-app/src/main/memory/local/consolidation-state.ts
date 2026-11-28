import type { MemoryConsolidationMetrics } from '@canopy/protocol/local-memory';
import type { UnresolvedTopicLink } from '@canopy/memory-consolidation/link-health';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LocalMemoryConsolidationResult } from '@canopy/desktop-shared/types';
import { isRecord } from '../../lib/type-guards';
import type { RunConsolidationResult } from './consolidation-task';
import { ensureOwnerOnlyDir } from '@canopy/memory-store/memory-files';

const CONSOLIDATION_STATE_VERSION = 1;
const CONSOLIDATION_STATE_FILENAME = 'consolidation-state.json';
const CONSOLIDATION_STATUS_FILENAME = 'consolidation-status.json';
const STATUS_MAX_BYTES = 16 * 1024;
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
  history?: Array<{
    at: string;
    result: LocalMemoryConsolidationResult;
    metrics: MemoryConsolidationMetrics | null;
  }>;
  unresolvedLinks?: UnresolvedTopicLink[];
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
  metrics?: MemoryConsolidationMetrics;
  unresolvedLinks?: UnresolvedTopicLink[];
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

function isMetrics(value: unknown): value is MemoryConsolidationMetrics {
  if (!isRecord(value)) return false;
  return (
    [
      'indexBytes',
      'topicCount',
      'topicBytes',
      'inputBytes',
      'brokenLinkCount',
      'orphanTopicCount',
      'repairedLinkCount',
    ].every(
      (key) =>
        typeof value[key] === 'number' &&
        Number.isSafeInteger(value[key]) &&
        value[key] >= 0,
    ) &&
    typeof value.growthBytes === 'number' &&
    Number.isSafeInteger(value.growthBytes) &&
    (value.growthRatio === null ||
      (typeof value.growthRatio === 'number' &&
        Number.isFinite(value.growthRatio)))
  );
}

function metricsOnly(
  value: MemoryConsolidationMetrics,
): MemoryConsolidationMetrics {
  return {
    indexBytes: value.indexBytes,
    topicCount: value.topicCount,
    topicBytes: value.topicBytes,
    inputBytes: value.inputBytes,
    growthBytes: value.growthBytes,
    growthRatio: value.growthRatio,
    brokenLinkCount: value.brokenLinkCount,
    orphanTopicCount: value.orphanTopicCount,
    repairedLinkCount: value.repairedLinkCount,
  };
}

function unresolvedLinks(value: unknown): UnresolvedTopicLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter(
      (entry): entry is { source: string; target: string } =>
        typeof entry.source === 'string' && typeof entry.target === 'string',
    )
    .map(({ source, target }) => ({ source, target }));
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
  if (Array.isArray(value.history)) {
    state.history = value.history
      .filter(isRecord)
      .flatMap((entry) =>
        isTimestamp(entry.at) &&
        isRunResult(entry.result) &&
        (entry.metrics === null || isMetrics(entry.metrics))
          ? [
              {
                at: entry.at,
                result: entry.result,
                metrics:
                  entry.metrics === null ? null : metricsOnly(entry.metrics),
              },
            ]
          : [],
      )
      .slice(-30);
  }
  if (Array.isArray(value.unresolvedLinks))
    state.unresolvedLinks = unresolvedLinks(value.unresolvedLinks);
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

/** Read only a bounded projection of the recorded history, never retry data. */
export async function readConsolidationStatusState(
  scopeDir: string,
): Promise<ConsolidationState | null> {
  const readBounded = async (
    filename: string,
  ): Promise<ConsolidationState | null> => {
    const file = await open(join(scopeDir, filename), 'r').catch(
      (error: unknown) => {
        if (isNodeError(error, 'ENOENT')) return null;
        throw error;
      },
    );
    if (file === null) return null;
    try {
      const buffer = Buffer.alloc(STATUS_MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > STATUS_MAX_BYTES) return null;
      try {
        return normalizeConsolidationState(
          JSON.parse(buffer.toString('utf8', 0, bytesRead)),
        );
      } catch {
        return null;
      }
    } finally {
      await file.close();
    }
  };
  return (
    (await readBounded(CONSOLIDATION_STATUS_FILENAME)) ??
    // Pre-feature state has only small run metadata. This bounded fallback
    // preserves it without opening an arbitrarily large legacy retry payload.
    (await readBounded(CONSOLIDATION_STATE_FILENAME))
  );
}

function statusProjection(state: ConsolidationState): ConsolidationState {
  const latest = state.history?.[state.history.length - 1];
  return {
    version: CONSOLIDATION_STATE_VERSION,
    ...(latest &&
    isTimestamp(latest.at) &&
    isRunResult(latest.result) &&
    (latest.metrics === null || isMetrics(latest.metrics))
      ? {
          history: [
            {
              at: new Date(latest.at).toISOString(),
              result: latest.result,
              metrics:
                latest.metrics === null ? null : metricsOnly(latest.metrics),
            },
          ],
        }
      : {}),
    ...(isTimestamp(state.lastConsolidatedAt) &&
    isInputHash(state.lastInputHash)
      ? {
          lastConsolidatedAt: new Date(state.lastConsolidatedAt).toISOString(),
          lastInputHash: state.lastInputHash,
        }
      : {}),
    ...(isTimestamp(state.lastRunAt) && isRunResult(state.lastResult)
      ? {
          lastRunAt: new Date(state.lastRunAt).toISOString(),
          lastResult: state.lastResult,
        }
      : {}),
    ...(state.lastReason
      ? { lastReason: state.lastReason.slice(0, 1024) }
      : {}),
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

export async function writeConsolidationState(
  scopeDir: string,
  state: Omit<ConsolidationState, 'version'>,
): Promise<void> {
  const filePath = join(scopeDir, CONSOLIDATION_STATE_FILENAME);
  const payload: ConsolidationState = {
    version: CONSOLIDATION_STATE_VERSION,
    ...(state.history ? { history: state.history.slice(-30) } : {}),
    ...(state.unresolvedLinks
      ? { unresolvedLinks: state.unresolvedLinks }
      : {}),
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
  await writeFileAtomically(
    scopeDir,
    filePath,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  // The full history/retry state stays canonical. A crash between the two
  // atomic replacements can leave an older status sample, never lose history.
  await writeFileAtomically(
    scopeDir,
    join(scopeDir, CONSOLIDATION_STATUS_FILENAME),
    `${JSON.stringify(statusProjection(payload))}\n`,
  );
}

/** Maps a task result to the outcome persisted for the explorer status line. */
function runOutcome(result: RunConsolidationResult): ConsolidationRunOutcome {
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

export function consolidationRunOutcome(
  result: RunConsolidationResult,
): ConsolidationRunOutcome {
  return {
    ...runOutcome(result),
    ...(result.metrics ? { metrics: result.metrics } : {}),
    ...(result.linkHealth
      ? { unresolvedLinks: result.linkHealth.unresolvedLinks }
      : {}),
  };
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
  if (outcome.metrics === undefined) {
    try {
      const [{ readLocalMemoryState }, { measureMemoryConsolidation }] =
        await Promise.all([
          import('./snapshots'),
          import('@canopy/memory-consolidation/metrics'),
        ]);
      const state = await readLocalMemoryState(scopeDir);
      const tree = {
        memoryMd: state.memoryMd ?? '',
        topicFiles: state.topicFiles,
      };
      outcome = {
        ...outcome,
        metrics: measureMemoryConsolidation(tree, tree, 0),
      };
    } catch {
      // A bad document may be the original failure. Persist its outcome even
      // when health is unavailable; never substitute an older run's counts.
    }
  }
  const previous = await readConsolidationState(scopeDir).catch(() => null);
  const succeeded =
    outcome.result === 'success' && outcome.inputHash !== undefined;
  const recorded: ConsolidationRunOutcome =
    outcome.result === 'success' && !succeeded
      ? { ...outcome, result: 'failed', reason: 'missing-input-hash' }
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
    history: [
      ...(previous?.history ?? []),
      { at, result: recorded.result, metrics: recorded.metrics ?? null },
    ].slice(-30),
    unresolvedLinks: succeeded
      ? (recorded.unresolvedLinks ?? [])
      : Array.from(
          new Map(
            [
              ...(previous?.unresolvedLinks ?? []),
              ...(recorded.unresolvedLinks ?? []),
            ].map((link) => [JSON.stringify([link.source, link.target]), link]),
          ).values(),
        ),
    lastRunAt: at,
    lastResult: recorded.result,
    ...(recorded.reason !== undefined ? { lastReason: recorded.reason } : {}),
  });
  if (recorded.metrics !== undefined) {
    const { recordMemoryConsolidationTelemetry } =
      await import('../../lib/desktop-telemetry');
    recordMemoryConsolidationTelemetry(recorded.metrics);
  }
}

async function writeFileAtomically(
  scopeDir: string,
  filePath: string,
  content: string,
): Promise<void> {
  // Owner-only like every other local-memory directory (0o700 with
  // fail-closed chmod), instead of a default-mode mkdir.
  await ensureOwnerOnlyDir(scopeDir, { trustedScopeRoot: scopeDir });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
