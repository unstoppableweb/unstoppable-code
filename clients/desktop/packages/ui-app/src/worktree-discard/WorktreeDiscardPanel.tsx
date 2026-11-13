import type { JSX } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import type { WorktreeDiscardOffer } from '@canopy/app-state';
import {
  worktreeDiscardStoreFor,
  worktreeRemovalRetryable,
  type WorktreeDiscardAttemptError,
} from '@canopy/app-state/worktree-discard';
import type { WorktreeDiscardDescription } from '@canopy/protocol/portal/worktree-discard';
import { WorktreeDiscardDialog } from '@canopy/ui-shared/components/WorktreeDiscardDialog';
import {
  WORKTREE_DISCARD_FAILED,
  worktreeDiscardRefusalCopy,
} from '@canopy/ui-shared/lib/worktree-discard-copy';
import type { WorktreeDiscarded } from './types';

/**
 * Opens `client`'s confirmation for `offer`. Resolves `false` when nothing
 * can be discarded. `WorktreeDiscardHost` calls it once this module loads.
 */
export function openWorktreeDiscard(
  client: CanopyClient,
  offer: WorktreeDiscardOffer,
): Promise<boolean> {
  return worktreeDiscardStoreFor(client).getState().open(offer);
}

function errorText(
  error: WorktreeDiscardAttemptError | null,
  description: WorktreeDiscardDescription,
): string | null {
  if (!error) return null;
  switch (error.kind) {
    case 'changed':
      return worktreeDiscardRefusalCopy('changed');
    case 'refused':
      return worktreeDiscardRefusalCopy(
        error.reason,
        description.refusal?.retry,
      );
    case 'failed':
      return error.message ?? WORKTREE_DISCARD_FAILED;
  }
}

/** CAN-5336: the confirmation and its store, loaded by `WorktreeDiscardHost`. */
export function WorktreeDiscardPanel({
  client,
  onDiscarded,
}: {
  client: CanopyClient;
  onDiscarded: (discarded: WorktreeDiscarded) => void;
}): JSX.Element | null {
  const store = worktreeDiscardStoreFor(client);
  const view = store((state) => state.view);
  const { discard, retry, close } = store.getState();
  if (view.phase !== 'open') return null;
  const { offer } = view;
  return (
    <WorktreeDiscardDialog
      worktreeName={offer.worktreeName}
      description={view.description}
      busy={view.busy}
      errorMessage={errorText(view.error, view.description)}
      onConfirm={() => {
        void discard().then((result) => {
          if (result)
            onDiscarded({
              workspaceId: offer.workspaceId,
              worktreeId: offer.worktreeId,
              ...result,
            });
        });
      }}
      onRetry={worktreeRemovalRetryable(view) ? retry : undefined}
      onCancel={close}
    />
  );
}
