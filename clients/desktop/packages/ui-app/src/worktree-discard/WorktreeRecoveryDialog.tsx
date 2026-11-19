import type {
  WorktreeRecoveryFinishResult,
  WorktreeRecoveryResolveResult,
} from '@canopy/protocol/canopy-core';
import type { JSX } from 'react';
import type { WorktreeRecoveryDescription } from '@canopy/protocol/remote-control/shell/worktree-recovery';
import {
  formatWorktreeRecoveryReason,
  worktreeRecoveryResolutionAction,
} from '@canopy/protocol/remote-control/shell/worktree-recovery';
import {
  Button,
  CodeBlock,
  CopyButton,
  DialogModal,
  Disclosure,
  ErrorBanner,
  Heading,
  LoadingButton,
} from '@canopy/ui-shared/components';
import {
  WORKTREE_REMOVAL_UNCONFIRMED,
  worktreeRecoveryRetainedFact,
  worktreeRecoveryResultCopy,
  worktreeRecoveryUnconfirmedCopy,
} from '@canopy/ui-shared/lib/worktree-discard-copy';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** Existence alone never promises a restorable copy. */
export function WorktreeRecoveryDialog({
  name,
  recovery,
  busy,
  error,
  unconfirmedAction,
  outcome,
  canResolve = false,
  onAction,
  onDiscard,
  onRefresh,
  onClose,
}: {
  readonly name: string;
  readonly recovery: WorktreeRecoveryDescription;
  readonly busy:
    | 'refresh'
    | 'retry'
    | 'finishArchive'
    | 'discard'
    | 'keepWorktree'
    | 'release'
    | null;
  readonly canResolve?: boolean;
  readonly outcome?:
    | WorktreeRecoveryFinishResult
    | WorktreeRecoveryResolveResult;
  readonly error: 'transport-failed' | 'unconfirmed' | null;
  readonly unconfirmedAction?:
    | 'keep-worktree'
    | 'release'
    | 'finish'
    | 'finish-cleanup';
  readonly onAction: (
    action: 'retry' | 'finishArchive' | 'keepWorktree' | 'release',
  ) => void;
  readonly onDiscard: () => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const resolution = canResolve
    ? worktreeRecoveryResolutionAction(recovery)
    : null;
  const settled =
    outcome && outcome.status !== 'refused' && outcome.status !== 'interrupted';
  const completedCleanup =
    recovery.check === 'completed-turn-diff-cleanup' ||
    unconfirmedAction === 'finish-cleanup';
  const recommended =
    resolution === 'finish' ||
    (!canResolve && recovery.actions.finishArchive.eligible)
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
        outcome ? (
          'Archive recovery result'
        ) : completedCleanup ? (
          'Archive cleanup'
        ) : (
          <>
            {resolution !== null ||
            recovery.intent === 'archive' ||
            unconfirmedAction !== undefined ||
            (recovery.evidence.kind === 'journal' &&
              recovery.evidence.attribution === 'subject' &&
              recovery.evidence.operation === 'worktree-archive')
              ? "Couldn't archive worktree"
              : "Couldn't delete worktree"}{' '}
            <span className={REPLAY_MASK_CLASS}>“{name}”</span>
          </>
        )
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
          {settled ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : outcome ? (
            <LoadingButton
              variant="primary"
              disabled={busy !== null}
              loading={busy === 'refresh'}
              loadingLabel="Checking…"
              onClick={onRefresh}
            >
              Check again
            </LoadingButton>
          ) : (
            <>
              {resolution === 'keep-worktree' || resolution === 'release' ? (
                <LoadingButton
                  variant="secondary"
                  disabled={busy !== null}
                  loading={busy === 'keepWorktree' || busy === 'release'}
                  loadingLabel={
                    resolution === 'release'
                      ? 'Releasing…'
                      : 'Keeping worktree…'
                  }
                  onClick={() =>
                    onAction(
                      resolution === 'release' ? 'release' : 'keepWorktree',
                    )
                  }
                  data-testid={
                    resolution === 'release'
                      ? 'worktree-recovery-release'
                      : 'worktree-recovery-keepWorktree'
                  }
                >
                  {resolution === 'release' ? 'Release' : 'Keep worktree'}
                </LoadingButton>
              ) : null}
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
                    recommended === 'retry'
                      ? 'Trying again…'
                      : completedCleanup
                        ? 'Finishing cleanup…'
                        : 'Finishing archive…'
                  }
                  onClick={() => onAction(recommended)}
                  data-testid={`worktree-recovery-${recommended}`}
                >
                  {recommended === 'retry'
                    ? 'Try again'
                    : completedCleanup
                      ? 'Finish cleanup'
                      : 'Finish archive'}
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
          )}
        </>
      }
    >
      {outcome ? (
        <p
          role="status"
          className="text-pretty"
          data-testid="worktree-recovery-result"
        >
          {worktreeRecoveryResultCopy(
            outcome,
            completedCleanup ? 'finish-cleanup' : (resolution ?? undefined),
          )}
        </p>
      ) : null}
      {!outcome && resolution ? (
        <p
          className="text-pretty"
          data-testid="worktree-recovery-resolution-help"
        >
          {resolution === 'keep-worktree'
            ? 'Keep the worktree and withdraw this archive attempt. Saved recovery material stays separate and can be deleted later. Earlier scripts and stopped sessions are not reversed.'
            : resolution === 'release'
              ? 'Withdraw the archive attempt with no listed worktree or working folder. Saved recovery material stays separate and can be deleted later.'
              : 'Finish removing this worktree using the saved archive. Any separate cleanup still pending will be reported.'}
        </p>
      ) : null}
      {!outcome ? (
        <>
          <p className="text-pretty" data-testid="worktree-recovery-reason">
            {completedCleanup
              ? 'The archive finished. Only cleanup of saved change data remains.'
              : formatWorktreeRecoveryReason(recovery)}
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
        </>
      ) : null}
      {error ? (
        <ErrorBanner
          errorSource="worktree-recovery-dialog"
          error={
            error === 'unconfirmed'
              ? unconfirmedAction
                ? worktreeRecoveryUnconfirmedCopy(
                    completedCleanup && unconfirmedAction === 'finish'
                      ? 'finish-cleanup'
                      : unconfirmedAction,
                  )
                : WORKTREE_REMOVAL_UNCONFIRMED
              : "Couldn't check this worktree. Check again before continuing."
          }
        />
      ) : null}
      {!settled ? (
        <p className="text-pretty">
          If recovery cannot continue, keep the files in place. Copy the
          recovery details before changing or deleting files. Use Send feedback
          in the account menu to share them with support.
        </p>
      ) : null}
      <CopyButton
        label="Copy recovery details"
        value={JSON.stringify({ ...recovery, result: outcome }, null, 2)}
      />
      <Disclosure label="Details">
        <CodeBlock
          variant="bare"
          size="xs"
          wrap="words"
          tone="secondary"
          replay="inherit"
          overflow="visible"
        >
          {JSON.stringify(
            {
              code: recovery.code,
              stoppingPoint: recovery.stoppingPoint,
              check: recovery.check,
              actions: recovery.actions,
              result: outcome,
            },
            null,
            2,
          )}
        </CodeBlock>
      </Disclosure>
    </DialogModal>
  );
}
