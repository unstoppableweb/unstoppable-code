import {
  isUnknownKeyedWriteOutcome,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';

export {
  isRebuildAdmissionRefusal,
  isUnknownKeyedWriteOutcome,
  KEYED_WRITE_OUTCOME_SHAPES,
  NOT_APPLIED_MARKS,
  type KeyedWriteOutcomeShape,
  type NotAppliedMark,
} from '@canopy/protocol/canopy-core';

/**
 * The keys whose write ended unknown, so a later attempt under the same key
 * stays unknown whatever it is answered (CAN-7196): the first attempt may
 * have landed, so a refusal of the retry proves nothing about it. A key is
 * forgotten once its write is settled, by a receipt or a re-read.
 */
export interface KeyedWriteHistory {
  /** Whether this attempt leaves the write unknown, recording it if so. */
  readonly unknown: (key: string, payload: CanopyErrorPayload) => boolean;
  /** Records an attempt that ended unknown for a reason other than its error. */
  readonly markUnknown: (key: string) => void;
  /** Whether an earlier attempt under the key ended unknown. */
  readonly wasUnknown: (key: string) => boolean;
  /** Forgets a key whose write is settled. */
  readonly settle: (key: string) => void;
}

/** A {@link KeyedWriteHistory} holding at most `limit` keys, oldest first out. */
export function createKeyedWriteHistory(limit = 512): KeyedWriteHistory {
  const keys = new Set<string>();
  const markUnknown = (key: string): void => {
    keys.delete(key);
    keys.add(key);
    if (keys.size > limit) {
      const oldest = keys.values().next();
      if (oldest.done !== true) keys.delete(oldest.value);
    }
  };
  return {
    unknown: (key, payload) => {
      if (!isUnknownKeyedWriteOutcome(payload) && !keys.has(key)) return false;
      markUnknown(key);
      return true;
    },
    markUnknown,
    wasUnknown: (key) => keys.has(key),
    settle: (key) => {
      keys.delete(key);
    },
  };
}
