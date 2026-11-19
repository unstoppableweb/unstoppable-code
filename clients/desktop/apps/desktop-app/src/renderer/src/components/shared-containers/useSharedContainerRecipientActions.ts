/**
 * One behavior source for the recipient-side share actions (CAN-2551).
 *
 * Modeled on `useArchivedContainerActions`: the invitation dialog's "Remove
 * share", the accepted row's "Remove share", and any future viewer-header
 * action all run through this hook rather than each re-deriving pending
 * state, re-entrancy guards, and toasts.
 *
 * Both removals land on the same transport call. `dismiss` gives up the grant
 * server-side and purges any local plaintext. The server keeps a record of
 * the removed share, so the recipient can restore it from Past shares
 * (CAN-4052): removing an invitation needs no confirmation, and removing an
 * accepted share confirms only because it deletes the local copy. Against a
 * server that predates that record the removal is irreversible, and the
 * surface says so instead of offering a restore.
 */
import { useCallback, useRef, useState } from 'react';
import type {
  SharedContainerForkDestination,
  SharedContainerForkResponse,
} from '@canopy/desktop-shared/types';
import type { SharedContainerForkErrorCode } from '@canopy/protocol/shared-containers';
import { extractIpcErrorMessage } from '@/lib/errors';
import { useGitHubStore } from '@/stores/githubStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { restoreSharedContainerWithFeedback } from '@/lib/shared-containers/restoreSharedContainerWithFeedback';

export const SHARED_CONTAINER_REMOVE_FAILED =
  "Couldn't remove this share. Try again.";

export type SharedContainerDismissOutcome =
  | 'dismissed'
  | 'failed'
  | 'in-flight';

/**
 * Result of a fork attempt (CAN-2552).
 *
 * `'failed'` carries main's own message rather than a generic one. Fork
 * refuses for reasons the recipient can act on. The chosen workspace may not
 * contain the shared repository, or the replica may be mid-promotion. Flattening
 * those into "Couldn't fork this share" would strip the only guidance the user
 * has for choosing a different destination. Expected refusals (CAN-4781)
 * arrive as data with a stable `code`; anything else is an IPC rejection and
 * has no code.
 */
export type SharedContainerForkOutcome =
  | { status: 'forked'; response: SharedContainerForkResponse }
  | { status: 'failed'; message: string; code?: SharedContainerForkErrorCode }
  | { status: 'in-flight' };

export interface SharedContainerForkInput {
  revisionId: string;
  sourceOwnerDisplayName: string;
  destination: SharedContainerForkDestination;
  /** Digest of the capability package the confirmation disclosed, if any. */
  expectedPackageDigest?: string;
}

export interface SharedContainerRecipientActions {
  /** True while this container's dismiss is in flight. */
  dismissing: boolean;
  /**
   * Removes an invitation or an accepted share.
   *
   * Resolves `'dismissed'` when the dismiss committed, `'failed'` when it did
   * not, and `'in-flight'` when an earlier call is still running. Callers use
   * this to decide whether to close their confirmation dialog: a failure has to
   * close it explicitly, while a duplicate click must leave the first request's
   * dialog exactly where it is.
   */
  dismiss: () => Promise<SharedContainerDismissOutcome>;
  /** True while this container's fork is in flight. */
  forking: boolean;
  /**
   * Copies one accepted revision into an independent local container.
   *
   * Unlike `dismiss`, a success is not self-announcing: nothing unmounts and
   * the new container is somewhere else entirely, so the caller navigates.
   * A duplicate click resolves `'in-flight'` and must leave the first
   * request's dialog exactly where it is. A fork can copy a whole repository
   * checkout, so the window in which a second click is possible is wide.
   */
  fork: (
    input: SharedContainerForkInput,
  ) => Promise<SharedContainerForkOutcome>;
}

export function useSharedContainerRecipientActions(
  containerId: string,
  /** Absent for a personal container shared directly. */
  organizationId: string | undefined,
  /** Names the share in the removal toast; absent sends no success toast. */
  title?: string,
): SharedContainerRecipientActions {
  const dismissContainer = useSharedContainerReplicasStore(
    (state) => state.dismissContainer,
  );
  const addToast = useGitHubStore((state) => state.addToast);
  const [dismissing, setDismissing] = useState(false);
  const dismissingRef = useRef(false);
  const [forking, setForking] = useState(false);
  const forkingRef = useRef(false);

  const dismiss =
    useCallback(async (): Promise<SharedContainerDismissOutcome> => {
      // A second click while the first request is still running is neither a
      // success nor a failure, and must not close the dialog the first one is
      // still working behind.
      if (dismissingRef.current) return 'in-flight';
      dismissingRef.current = true;
      setDismissing(true);
      try {
        if (await dismissContainer(containerId, organizationId)) {
          // Only a server that keeps removed shares earns the restore
          // promise; against any other the removal stays silent, as before.
          const restorable =
            useSharedContainerReplicasStore.getState().removedStatus !==
            'unsupported';
          if (title !== undefined && restorable) {
            addToast(
              `Removed ${title}. You can restore it from Past shares.`,
              'success',
              undefined,
              {
                forceInApp: true,
                suppressOsNotification: true,
                action: {
                  label: 'Restore',
                  onClick: (): void => {
                    void restoreSharedContainerWithFeedback(containerId, title);
                  },
                },
              },
            );
          }
          return 'dismissed';
        }
        addToast(SHARED_CONTAINER_REMOVE_FAILED, 'error');
        return 'failed';
      } catch (error) {
        addToast(SHARED_CONTAINER_REMOVE_FAILED, 'error', undefined, {
          caught: error,
        });
        return 'failed';
      } finally {
        dismissingRef.current = false;
        setDismissing(false);
      }
    }, [addToast, containerId, dismissContainer, organizationId, title]);

  const fork = useCallback(
    async (
      input: SharedContainerForkInput,
    ): Promise<SharedContainerForkOutcome> => {
      if (forkingRef.current) return { status: 'in-flight' };
      forkingRef.current = true;
      setForking(true);
      try {
        const response = await window.api.sharedContainers.fork({
          containerId,
          organizationId,
          revisionId: input.revisionId,
          sourceOwnerDisplayName: input.sourceOwnerDisplayName,
          destination: input.destination,
          ...(input.expectedPackageDigest !== undefined
            ? { expectedPackageDigest: input.expectedPackageDigest }
            : {}),
        });
        if ('ok' in response) {
          return {
            status: 'failed',
            message: response.message,
            code: response.code,
          };
        }
        return { status: 'forked', response };
      } catch (cause) {
        // Electron rewraps the rejection as
        // `Error invoking remote method '<channel>': Error: <message>`, so the
        // guidance main wrote only reaches the user unwrapped.
        const unwrapped = extractIpcErrorMessage(cause);
        const message =
          unwrapped && unwrapped !== 'Unknown error'
            ? unwrapped
            : 'Could not copy this share';
        // No toast here. The fork dialog is still open and renders the failure
        // inline next to the destination the user would change to retry; a
        // toast on top of that would say the same thing twice.
        return { status: 'failed', message };
      } finally {
        forkingRef.current = false;
        setForking(false);
      }
    },
    [containerId, organizationId],
  );

  return { dismissing, dismiss, forking, fork };
}
