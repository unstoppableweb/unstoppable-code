/**
 * Owner departure notices (CAN-5120): the record that a share ended because
 * its owner left the organization.
 *
 * Kept apart from the replica store on purpose. Notices grant no access and
 * outlive the organization that produced them, so an organization change that
 * resets the replica store must not clear them, and no notice request may ever
 * delay the close of a revoked copy.
 */
import { create } from 'zustand';
import type { SharedContainerOwnerDepartureNotice } from '@canopy/protocol/shared-containers';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

interface SharedContainerOwnerDeparturesState {
  notices: readonly SharedContainerOwnerDepartureNotice[];
  failedDismissalId: string | null;
  load: () => Promise<void>;
  dismiss: (noticeId: string) => Promise<void>;
  /** Forgets every notice and in-flight answer of the previous account. */
  reset: (retryAfterMs?: number) => void;
}

const LIST_UNAVAILABLE_RETRY_MS = 5 * 60_000;

const EMPTY_NOTICES: readonly SharedContainerOwnerDepartureNotice[] =
  Object.freeze<SharedContainerOwnerDepartureNotice[]>([]);

/** Bumped by each load, so only the newest listing lands. */
let loadEpoch = 0;
/** Bumped by `reset`, so an earlier account's dismissal cannot land. */
let sessionEpoch = 0;
let listRetryAt = 0;
/**
 * Notices dismissed this session, or being dismissed. A listing that left the
 * server before the delete still carries them; ids are never reused, so
 * filtering by this set is safe for the whole session.
 */
const hiddenIds = new Set<string>();

/** Keep the latest listing, including rows hidden by a pending dismissal. */
let listedNotices = EMPTY_NOTICES;

function visibleNotices(): readonly SharedContainerOwnerDepartureNotice[] {
  return listedNotices.filter((notice) => !hiddenIds.has(notice.id));
}

export const useSharedContainerOwnerDeparturesStore =
  create<SharedContainerOwnerDeparturesState>((set, get) => ({
    notices: EMPTY_NOTICES,
    failedDismissalId: null,

    load: async (): Promise<void> => {
      if (Date.now() < listRetryAt) return;
      loadEpoch += 1;
      const epoch = loadEpoch;
      const bridge = window.api?.sharedContainers;
      if (!bridge?.listOwnerDepartures) {
        get().reset();
        return;
      }
      try {
        const response = await bridge.listOwnerDepartures();
        if (epoch !== loadEpoch) return;
        if ('unsupported' in response) {
          get().reset(LIST_UNAVAILABLE_RETRY_MS);
          return;
        }
        listedNotices = response.notices;
        set(({ failedDismissalId }) => ({
          notices: visibleNotices(),
          failedDismissalId: listedNotices.some(
            (notice) => notice.id === failedDismissalId,
          )
            ? failedDismissalId
            : null,
        }));
      } catch (error) {
        reportClientAppError(error);
        // Authorization loss arrives as data. Keep the list on transient failure.
      }
    },

    dismiss: async (noticeId): Promise<void> => {
      if (hiddenIds.has(noticeId)) return;
      if (!listedNotices.some((notice) => notice.id === noticeId)) return;
      const session = sessionEpoch;
      hiddenIds.add(noticeId);
      set(({ failedDismissalId }) => ({
        notices: visibleNotices(),
        failedDismissalId:
          failedDismissalId === noticeId ? null : failedDismissalId,
      }));
      let dismissed = false;
      try {
        const bridge = window.api?.sharedContainers;
        const response = await bridge?.dismissOwnerDeparture?.({ noticeId });
        if (session !== sessionEpoch) return;
        if (response && 'unsupported' in response) {
          get().reset();
          return;
        }
        dismissed = response !== undefined && 'dismissed' in response;
      } catch (error) {
        reportClientAppError(error);
      }
      if (dismissed || session !== sessionEpoch) return;
      hiddenIds.delete(noticeId);
      // A refresh may already have confirmed the notice is gone.
      if (!listedNotices.some((notice) => notice.id === noticeId)) return;
      set({ notices: visibleNotices(), failedDismissalId: noticeId });
    },

    reset: (retryAfterMs = 0): void => {
      loadEpoch += 1;
      sessionEpoch += 1;
      listRetryAt = retryAfterMs > 0 ? Date.now() + retryAfterMs : 0;
      hiddenIds.clear();
      listedNotices = EMPTY_NOTICES;
      set({ notices: EMPTY_NOTICES, failedDismissalId: null });
    },
  }));
