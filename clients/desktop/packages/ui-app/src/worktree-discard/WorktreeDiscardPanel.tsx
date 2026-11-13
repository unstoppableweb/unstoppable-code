import { useEffect, useRef, type JSX } from 'react';
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
import { WorktreeRecoveryDialog } from './WorktreeRecoveryDialog';

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
  const active = useRef<CanopyClient | null>(client);
  useEffect(() => {
    active.current = client;
    return (): void => {
      active.current = null;
      // Strict Mode immediately reattaches the same client; real detach and
      // client changes invalidate late answers without losing that opening.
      queueMicrotask(() => {
        if (active.current !== client) store.getState().deactivate();
      });
    };
  }, [client, store]);
  const { discard, retry, close, recover, confirmDiscard, refresh } =
    store.getState();
  if (view.phase === 'recovery')
    return (
      <WorktreeRecoveryDialog
        name={view.offer.worktreeName}
        recovery={view.recovery}
        busy={view.busy}
        error={view.error}
        onAction={(action) => {
          void recover(action).then((result) => {
            if (result && active.current === client)
              onDiscarded({
                workspaceId: view.offer.workspaceId,
                worktreeId: view.offer.worktreeId,
                ...result,
              });
          });
        }}
        onDiscard={() => {
          void confirmDiscard();
        }}
        onRefresh={() => {
          void refresh();
        }}
        onClose={close}
      />
    );
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
          if (result && active.current === client)
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
