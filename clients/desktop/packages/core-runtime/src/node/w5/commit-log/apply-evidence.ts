import type { W5FileConflict } from './apply';
import { isRecord } from './is-record';

export function isW5FileConflict(value: unknown): value is W5FileConflict {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    (value.expected === null ||
      (typeof value.expected === 'string' &&
        /^[a-f0-9]{64}$/.test(value.expected))) &&
    (value.actual === null ||
      (typeof value.actual === 'string' && /^[a-f0-9]{64}$/.test(value.actual)))
  );
}

/** Persisted evidence is untrusted. Missing or unsupported fields prove nothing. */
export function isCleanConflictEvidence(
  value: unknown,
): value is { conflicts: W5FileConflict[]; written: string[] } {
  return (
    isRecord(value) &&
    Object.keys(value).every(
      (key) => key === 'conflicts' || key === 'written',
    ) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.length > 0 &&
    value.conflicts.every(isW5FileConflict) &&
    Array.isArray(value.written) &&
    value.written.length === 0
  );
}

/** An OS error a write can hit and later succeed past, once space or handles free up. */
const TRANSIENT_WRITE_ERROR =
  /^(?:ENOSPC|EDQUOT|EIO|EMFILE|ENFILE|EAGAIN|EBUSY): /;

/**
 * Persisted evidence of an apply that stopped on a transient I/O error before
 * it wrote any file and found no conflict (CAN-5680). Nothing reached the
 * files, so applying the commit again is the same as its first attempt.
 */
export function isTransientUnwrittenFailureEvidence(
  value: unknown,
): value is { conflicts: []; written: []; error: string } {
  return (
    isRecord(value) &&
    Object.keys(value).every(
      (key) => key === 'conflicts' || key === 'written' || key === 'error',
    ) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.length === 0 &&
    Array.isArray(value.written) &&
    value.written.length === 0 &&
    typeof value.error === 'string' &&
    TRANSIENT_WRITE_ERROR.test(value.error)
  );
}

/** Only the unscoped list repository uses this operation; it never reserves effects. */
export const W5_LAUNCH_HEAL_OPERATIONS: readonly string[] = [
  'w5.worktree_list.write',
];
