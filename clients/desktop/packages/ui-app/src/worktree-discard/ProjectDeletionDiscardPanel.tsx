import type { JSX } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import type { ProjectDeletionDiscardOffer } from '@canopy/app-state';
import {
  projectDeletionDiscardStoreFor,
  type ProjectDeletionItemDiscarded,
} from '@canopy/app-state/worktree-discard';
import { ProjectDeletionDiscardDialog } from '@canopy/ui-shared/components/ProjectDeletionDiscardDialog';
import { projectDeletionDiscardErrorCopy } from '@canopy/ui-shared/lib/project-deletion-discard-copy';

/**
 * Opens `client`'s confirmation for `offer`. Resolves `false` when nothing
 * can be discarded. `ProjectDeletionDiscardHost` calls it once this loads.
 */
export function openProjectDeletionDiscard(
  client: CanopyClient,
  offer: ProjectDeletionDiscardOffer,
): Promise<boolean> {
  return projectDeletionDiscardStoreFor(client).getState().open(offer);
}

/** CAN-5337: the confirmation and its store, loaded by the host. */
export function ProjectDeletionDiscardPanel({
  client,
  onItemDiscarded,
}: {
  client: CanopyClient;
  onItemDiscarded: (discarded: ProjectDeletionItemDiscarded) => void;
}): JSX.Element | null {
  const store = projectDeletionDiscardStoreFor(client);
  const view = store((state) => state.view);
  const { confirm, discardItem, close } = store.getState();
  if (view.phase !== 'open') return null;
  return (
    <ProjectDeletionDiscardDialog
      projectName={view.offer.projectName}
      pendingRecovery={Boolean(view.description.pendingRecovery?.length)}
      items={view.rows}
      interruptedDeletion={
        view.description.interruptedDeletion !== undefined && !view.superseded
      }
      earlierDiscarded={view.earlierDiscarded}
      busy={view.busy}
      errorMessage={
        view.error ? projectDeletionDiscardErrorCopy(view.error) : null
      }
      // Only a failed run the host did not record is recorded: a changed or
      // refused worktree, or a fresh review that found changed state (null
      // message), is a state the person is asked to review, not a failure.
      {...(view.error === null ||
      (view.error.kind === 'failed' &&
        view.error.message !== null &&
        view.error.recorded !== true)
        ? { errorSource: 'project-deletion-discard' }
        : { errorRecordingDisabled: true as const })}
      onConfirm={() => {
        void confirm(onItemDiscarded);
      }}
      onDiscardItem={(worktreeId) => {
        void discardItem(worktreeId, onItemDiscarded);
      }}
      onCancel={close}
    />
  );
}
