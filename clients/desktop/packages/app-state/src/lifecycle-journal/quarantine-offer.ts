import { create } from 'zustand';
import { lifecycleJournalRefusalKind } from '@canopy/protocol/portal/lifecycle-journal-refusal';

/**
 * Requests made by refusal surfaces. One per page, not per client: a surface
 * may hold a narrower client than the host that reviews (the web sidebar's
 * composite client versus the Portal's), so the mounted host answers it.
 */
const lifecycleJournalQuarantineRequests = create<{ readonly token: number }>()(
  () => ({
    token: 0,
  }),
);

/** The latest request token; a host opens its review when it changes. */
export function useLifecycleJournalQuarantineRequest(): number {
  return lifecycleJournalQuarantineRequests((state) => state.token);
}

/**
 * Asks the mounted host to open the review when `error` is an
 * unreadable-journal refusal. Returns whether it was; callers keep their own
 * message.
 */
export function offerLifecycleJournalQuarantine(error: unknown): boolean {
  if (lifecycleJournalRefusalKind(error) === null) return false;
  lifecycleJournalQuarantineRequests.setState((state) => ({
    token: state.token + 1,
  }));
  return true;
}
