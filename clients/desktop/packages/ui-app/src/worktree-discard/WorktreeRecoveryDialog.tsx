import type {
  WorktreeRecoveryFinishResult,
  WorktreeRecoveryResolveResult,
  WorktreeRecoverySetAsideParams,
  WorktreeRecoverySetAsideResult,
} from '@canopy/protocol/canopy-core';
import { useEffect, useState, type JSX } from 'react';
import type { WorktreeRecoveryDescription } from '@canopy/protocol/remote-control/shell/worktree-recovery';
import {
  formatWorktreeRecoveryReason,
  worktreeRecoveryOfferedActions,
  worktreeRecoveryResolutionAction,
} from '@canopy/protocol/remote-control/shell/worktree-recovery';
import {
  Button,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
  DialogModal,
  Disclosure,
  ErrorBanner,
  Heading,
} from '@canopy/ui-shared/components';
import {
  WORKTREE_RECOVERY_SET_ASIDE_CONFIRM,
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
  unconfirmedAction: recoveryUnconfirmedAction,
  outcome: recoveryOutcome,
  setAsideResult = null,
  hostOutdated,
  canResolve = false,
  canSetAside = false,
  onAction,
  onDiscard,
  onSetAside,
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
    | 'setAside'
    | null;
  readonly canResolve?: boolean;
  readonly canSetAside?: boolean;
  readonly outcome?:
    | WorktreeRecoveryFinishResult
    | WorktreeRecoveryResolveResult
    | WorktreeRecoverySetAsideResult;
  readonly setAsideResult?: WorktreeRecoverySetAsideResult | null;
  readonly error: 'transport-failed' | 'unconfirmed' | null;
  readonly unconfirmedAction?:
    | 'keep-worktree'
    | 'release'
    | 'finish'
    | 'finish-cleanup'
    | 'set-aside';
  /**
   * An older computer refused the last action or check, so nothing ran
   * (CAN-7444): its update message, shown instead of the unconfirmed copy.
   */
  readonly hostOutdated?: string;
  readonly onAction: (
    action: 'retry' | 'finishArchive' | 'keepWorktree' | 'release',
  ) => void;
  readonly onDiscard: () => void;
  /** Runs after this dialog's own confirmation. */
  readonly onSetAside?: (target: WorktreeRecoverySetAsideParams) => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const outcome = setAsideResult ?? recoveryOutcome;
  const unconfirmedAction =
    setAsideResult?.status === 'interrupted'
      ? 'set-aside'
      : recoveryUnconfirmedAction;
  const canDismiss = busy === null || setAsideResult !== null;
  const [confirmingSetAside, setConfirmingSetAside] = useState<{
    readonly recovery: WorktreeRecoveryDescription;
    readonly name: string;
    readonly target: WorktreeRecoverySetAsideParams;
  } | null>(null);
  useEffect(() => {
    setConfirmingSetAside(null);
  }, [recovery, name, outcome, error]);
  useEffect(() => {
    if (hostOutdated) setConfirmingSetAside(null);
  }, [hostOutdated]);
  const resolution = canResolve
    ? worktreeRecoveryResolutionAction(recovery)
    : null;
  const offered = worktreeRecoveryOfferedActions(recovery, {
    canResolve,
    canSetAside: canSetAside && onSetAside !== undefined,
  });
  // A submitted Set aside stays until its result; an unsubmitted one closes
  // once the offer is withdrawn (for example, a relay disconnect).
  const setAsideLive = offered.includes('set-aside') || busy === 'setAside';
  useEffect(() => {
    if (!setAsideLive) setConfirmingSetAside(null);
  }, [setAsideLive]);
  const settled =
    outcome && outcome.status !== 'refused' && outcome.status !== 'interrupted';
  const completedCleanup =
    recovery.check === 'completed-turn-diff-cleanup' ||
    unconfirmedAction === 'finish-cleanup';
  const offeredResolution = offered.includes('keep-worktree')
    ? 'keep-worktree'
    : offered.includes('release')
      ? 'release'
      : null;
  const recommended = offered.includes('finish')
    ? 'finishArchive'
    : offered.includes('retry')
      ? 'retry'
      : null;
  if (
    confirmingSetAside &&
    confirmingSetAside.recovery === recovery &&
    confirmingSetAside.name === name &&
    setAsideLive &&
    onSetAside &&
    !outcome &&
    !error
  )
    return (
      <ConfirmDialog
        title={
          <>
            Set aside the archive record for{' '}
            <span className={REPLAY_MASK_CLASS}>“{name}”</span>?
          </>
        }
        message={WORKTREE_RECOVERY_SET_ASIDE_CONFIRM}
        confirmLabel="Set aside record"
        busyLabel="Setting aside…"
        busy={busy === 'setAside'}
        // Lifts this worktree's archive fence: Enter must not confirm by accident.
        focusCancel
        onConfirm={() => onSetAside(confirmingSetAside.target)}
        onCancel={() => {
          if (busy === null) setConfirmingSetAside(null);
        }}
        dataTestId="worktree-recovery-set-aside-confirm"
      />
    );
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
      closeButtonDisabled={!canDismiss}
      closeOnBackdrop={canDismiss}
      closeOnEscape={canDismiss}
      dataTestId="worktree-recovery-dialog"
      footer={
        <>
          {settled ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : outcome ? (
            <Button
              variant="primary"
              disabled={busy !== null}
              loading={busy === 'refresh'}
              loadingLabel="Checking…"
              onClick={onRefresh}
            >
              Check again
            </Button>
          ) : (
            <>
              {offeredResolution ? (
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  loading={busy === 'keepWorktree' || busy === 'release'}
                  loadingLabel={
                    offeredResolution === 'release'
                      ? 'Releasing…'
                      : 'Keeping worktree…'
                  }
                  onClick={() =>
                    onAction(
                      offeredResolution === 'release'
                        ? 'release'
                        : 'keepWorktree',
                    )
                  }
                  data-testid={
                    offeredResolution === 'release'
                      ? 'worktree-recovery-release'
                      : 'worktree-recovery-keepWorktree'
                  }
                >
                  {offeredResolution === 'release'
                    ? 'Release'
                    : 'Keep worktree'}
                </Button>
              ) : null}
              {offered.includes('set-aside') ? (
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  loading={busy === 'setAside'}
                  loadingLabel="Setting aside…"
                  onClick={() => {
                    if (!recovery.diagnosis) return;
                    setConfirmingSetAside({
                      recovery,
                      name,
                      target: {
                        workspaceId: recovery.subject.workspaceId,
                        operationId: recovery.diagnosis.operationId,
                        revision: recovery.diagnosis.revision,
                      },
                    });
                  }}
                  data-testid="worktree-recovery-setAside"
                >
                  Set aside record
                </Button>
              ) : null}
              {offered.includes('discard') ? (
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  loading={busy === 'discard'}
                  loadingLabel="Checking…"
                  onClick={onDiscard}
                  data-testid="worktree-recovery-discard"
                >
                  Discard worktree
                </Button>
              ) : null}
              {offered.includes('retry') && recommended !== 'retry' ? (
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  loading={busy === 'retry'}
                  loadingLabel="Trying again…"
                  onClick={() => onAction('retry')}
                  data-testid="worktree-recovery-retry"
                >
                  Try again
                </Button>
              ) : null}
              {recommended ? (
                <Button
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
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={busy !== null}
                  loading={busy === 'refresh'}
                  loadingLabel="Checking…"
                  onClick={onRefresh}
                  data-testid="worktree-recovery-refresh"
                >
                  Check again
                </Button>
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
            outcome.status === 'set-aside' ||
              unconfirmedAction === 'set-aside' ||
              (offered.includes('set-aside') &&
                (outcome.status === 'refused' ||
                  outcome.status === 'interrupted'))
              ? 'set-aside'
              : completedCleanup
                ? 'finish-cleanup'
                : (resolution ?? undefined),
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
      {!outcome && offered.includes('set-aside') ? (
        <p
          className="text-pretty"
          data-testid="worktree-recovery-set-aside-help"
        >
          This archive can't continue from here. Set its record aside so it
          stops blocking this worktree. Nothing else is moved or deleted.
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
      {hostOutdated && !error ? (
        <p
          role="status"
          className="text-pretty"
          data-testid="worktree-recovery-host-outdated"
        >
          {hostOutdated}
        </p>
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
