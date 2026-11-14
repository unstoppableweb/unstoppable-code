import type { JSX } from 'react';
import type { WorktreeRecoveryDescription } from '@canopy/protocol/portal/worktree-recovery';
import { formatWorktreeRecoveryReason } from '@canopy/protocol/portal/worktree-recovery';
import {
  DialogModal,
  Disclosure,
  ErrorBanner,
  Heading,
  LoadingButton,
} from '@canopy/ui-shared/components';
import {
  WORKTREE_REMOVAL_UNCONFIRMED,
  worktreeRecoveryRetainedFact,
} from '@canopy/ui-shared/lib/worktree-discard-copy';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** Existence alone never promises a restorable copy. */
export function WorktreeRecoveryDialog({
  name,
  recovery,
  busy,
  error,
  onAction,
  onDiscard,
  onRefresh,
  onClose,
}: {
  readonly name: string;
  readonly recovery: WorktreeRecoveryDescription;
  readonly busy: 'refresh' | 'retry' | 'finishArchive' | 'discard' | null;
  readonly error: 'transport-failed' | 'unconfirmed' | null;
  readonly onAction: (action: 'retry' | 'finishArchive') => void;
  readonly onDiscard: () => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const recommended = recovery.actions.finishArchive.eligible
    ? 'finishArchive'
    : recovery.actions.retry.eligible
      ? 'retry'
      : null;
  const assets: (keyof WorktreeRecoveryDescription['retained'])[] = [
    'checkout',
    'stagedCopy',
    'gitSnapshot',
    'committedArchive',
    'chats',
  ];
  return (
    <DialogModal
      title={
        <>
          {recovery.intent === 'archive'
            ? "Couldn't archive worktree"
            : "Couldn't delete worktree"}{' '}
          <span className={REPLAY_MASK_CLASS}>“{name}”</span>.
        </>
      }
      onClose={onClose}
      maxWidth="lg"
      trapFocus
      initialFocus="dialog"
      closeButtonDisabled={busy !== null}
      closeOnBackdrop={busy === null}
      closeOnEscape={busy === null}
      dataTestId="worktree-recovery-dialog"
      footer={
        <>
          {recovery.actions.discard.eligible ? (
            <LoadingButton
              variant="secondary"
              disabled={busy !== null}
              loading={busy === 'discard'}
              loadingLabel="Checking…"
              onClick={onDiscard}
              data-testid="worktree-recovery-discard"
            >
              Discard worktree
            </LoadingButton>
          ) : null}
          {recovery.actions.retry.eligible && recommended !== 'retry' ? (
            <LoadingButton
              variant="secondary"
              disabled={busy !== null}
              loading={busy === 'retry'}
              loadingLabel="Trying again…"
              onClick={() => onAction('retry')}
              data-testid="worktree-recovery-retry"
            >
              Try again
            </LoadingButton>
          ) : null}
          {recommended ? (
            <LoadingButton
              variant="primary"
              disabled={busy !== null}
              loading={busy === recommended}
              loadingLabel={
                recommended === 'retry' ? 'Trying again…' : 'Finishing archive…'
              }
              onClick={() => onAction(recommended)}
              data-testid={`worktree-recovery-${recommended}`}
            >
              {recommended === 'retry' ? 'Try again' : 'Finish archive'}
            </LoadingButton>
          ) : (
            <LoadingButton
              variant="primary"
              disabled={busy !== null}
              loading={busy === 'refresh'}
              loadingLabel="Checking…"
              onClick={onRefresh}
              data-testid="worktree-recovery-refresh"
            >
              Check again
            </LoadingButton>
          )}
        </>
      }
    >
      <p className="text-pretty" data-testid="worktree-recovery-reason">
        {formatWorktreeRecoveryReason(recovery)}
      </p>
      <section className="flex flex-col gap-2">
        <Heading level={3} variant="title">
          What remains
        </Heading>
        <ul
          className="flex flex-col gap-2 text-s text-pretty fg-secondary"
          data-testid="worktree-recovery-retained"
        >
          {assets.map((key) => (
            <li key={key}>
              {worktreeRecoveryRetainedFact(key, recovery.retained[key])}
            </li>
          ))}
        </ul>
      </section>
      {error ? (
        <ErrorBanner
          errorSource="worktree-recovery-dialog"
          error={
            error === 'unconfirmed'
              ? WORKTREE_REMOVAL_UNCONFIRMED
              : "Couldn't check this worktree. Check again before continuing."
          }
        />
      ) : null}
      <Disclosure label="Details">
        <pre className="text-xs font-mono whitespace-pre-wrap break-words fg-secondary">
          {JSON.stringify(
            {
              code: recovery.code,
              stoppingPoint: recovery.stoppingPoint,
              check: recovery.check,
              actions: recovery.actions,
            },
            null,
            2,
          )}
        </pre>
      </Disclosure>
    </DialogModal>
  );
}
