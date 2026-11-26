import type { AppError } from '@canopy/protocol/app-errors';
import {
  toFeedbackReportError,
  type FeedbackReportError,
} from '@canopy/protocol/feedback-report';

let recent: FeedbackReportError | undefined;
const seenOccurrences = new Set<string>();
const MAX_SEEN_OCCURRENCES = 256;
let accountChangedAt = Number.NEGATIVE_INFINITY;

/** One session-local, redacted failure, not a history of IPC rejections. */
export function rememberUserVisibleError(error: AppError): void {
  // An input error is a refusal or the outcome of the person's own command,
  // never what they report: it must not displace the failure they saw.
  if (error.kind === 'input') return;
  // A surface remounting after an account change must not refill the slot.
  // In the change's millisecond the error may have come first, as main assumes.
  if (error.occurredAt <= accountChangedAt) return;
  try {
    // Remounts and StrictMode replays are not newer incidents. A handler can
    // reuse a reference for a repeat, but that repeat has its own occurredAt.
    const occurrence = `${error.referenceId}:${error.occurredAt}`;
    if (seenOccurrences.has(occurrence)) return;
    recent = toFeedbackReportError(error);
    seenOccurrences.add(occurrence);
    if (seenOccurrences.size > MAX_SEEN_OCCURRENCES) {
      const oldest = seenOccurrences.values().next();
      if (!oldest.done) seenOccurrences.delete(oldest.value);
    }
  } catch {
    // Malformed detail must not break the surface showing the failure.
  }
}

/** Snapshot at opening; later failures must not change an inspected report. */
export function readRecentUserVisibleError(): FeedbackReportError | undefined {
  return recent;
}

/**
 * An account change empties the slot. Desktop main still decides, on every
 * submit, whether an attached error belongs to the account filing it.
 */
export function clearRecentUserVisibleError(): void {
  recent = undefined;
  seenOccurrences.clear();
  accountChangedAt = Date.now();
}
