import type {
  LocalMemoryRebuildOutcome,
  LocalMemoryStatus,
} from '@canopy/app-core/local-memory';
import {
  LOCAL_MEMORY_FULL_SENTENCE_REASONS,
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
  LOCAL_MEMORY_SYNCED_REBUILD_MESSAGE,
  LOCAL_MEMORY_SYNCED_REFUSED_MESSAGE,
  LOCAL_MEMORY_SYNCED_SECRET_MESSAGE,
} from '@canopy/protocol/local-memory';

const CONSOLIDATION_FAILURE_PREFIX = "Couldn't consolidate memories";
const REBUILD_FAILURE_PREFIX = "Couldn't finish rebuilding memories";
/** Internal skip/failure reasons rendered as plain-language fragments. */
const CONSOLIDATION_REASONS: Record<string, string> = {
  failed: 'the model request failed',
  'invalid-output': 'the model returned unusable output',
  'missing-input-hash': 'the run finished without a checkpoint',
  'local-memory-disabled': 'local memory is off',
  'already-running': 'another run is in progress',
  cancelled: 'memory changed while it ran',
  'no-progress': 'a run left the same notes waiting',
  undrainable: 'a saved note is too large to consolidate',
  'too-many-runs': 'too many runs were needed',
};

/** Codes for the reasons that are full sentences, which are not telemetry. */
const FULL_SENTENCE_CODES: ReadonlyMap<string, string> = new Map([
  [LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE, 'model-blocked'],
  [LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE, 'model-unavailable'],
  [LOCAL_MEMORY_SYNCED_REBUILD_MESSAGE, 'synced-rebuild'],
  [LOCAL_MEMORY_SYNCED_REFUSED_MESSAGE, 'synced-refused'],
  [LOCAL_MEMORY_SYNCED_SECRET_MESSAGE, 'synced-secret'],
]);

function reasonFragment(reason: string | null | undefined): string {
  if (reason === null || reason === undefined)
    return CONSOLIDATION_REASONS.failed;
  return CONSOLIDATION_REASONS[reason] ?? reason;
}

/**
 * Copy for a run that failed or was skipped for a reason worth showing.
 * Blocked or unavailable memory models already carry their full sentence;
 * every other reason becomes a fragment after the shared prefix. Returns null
 * when the last run has nothing to report (success, clean, cancelled).
 */
export function consolidationProblem(status: LocalMemoryStatus): string | null {
  const reason = status.lastReason;
  if (
    status.lastResult === 'skipped' &&
    (reason === null || reason === 'clean')
  )
    return null;
  if (status.lastResult !== 'failed' && status.lastResult !== 'skipped')
    return null;
  if (reason !== null && LOCAL_MEMORY_FULL_SENTENCE_REASONS.has(reason))
    return reason;
  return `${CONSOLIDATION_FAILURE_PREFIX}: ${reasonFragment(reason)}`;
}

/** Copy for a rebuild that did not finish, or null when it did. */
export function rebuildProblem(
  result: LocalMemoryRebuildOutcome['rebuild'],
): string | null {
  if (result.status === 'completed') return null;
  if (
    result.reason !== undefined &&
    LOCAL_MEMORY_FULL_SENTENCE_REASONS.has(result.reason)
  )
    return result.reason;
  return `${REBUILD_FAILURE_PREFIX}: ${reasonFragment(result.reason)}`;
}

/**
 * A closed code for why a run failed, safe to send to telemetry. A reason can
 * be a caught error's message, so only a known reason is named; any other
 * becomes `other`, and a missing one `failed` as it reads in the banner.
 */
export function problemReasonCode(reason: string | null | undefined): string {
  if (reason === null || reason === undefined) return 'failed';
  const sentence = FULL_SENTENCE_CODES.get(reason);
  if (sentence !== undefined) return sentence;
  return Object.prototype.hasOwnProperty.call(CONSOLIDATION_REASONS, reason)
    ? reason
    : 'other';
}
