import type { JSX, ReactNode } from 'react';
import { Button } from '@canopy/ui-shared/components/Button';
import {
  TurnTimer as SharedTurnTimer,
  type TurnCompletionStatus,
  type PlanCopyState,
} from '@canopy/ui-shared';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { getModelDisplayName } from '@canopy/desktop-shared/types';
import { BranchIcon } from '@canopy/ui-shared/icons/AppIcons';
import { ActionTooltip } from '../shared/ActionTooltip';
import { ForkChatButton } from './ForkChatButton';

export function TurnTimer({
  pending = false,
  startedAt,
  pausedAt,
  resumedAt,
  accumulatedPausedDurationMs,
  waitingForUser = false,
  completedAt,
  showForkAction = false,
  onFork,
  showBranchAction = false,
  onBranch,
  watcherButton,
  archiveToggleButton,
  shareButton,
  feedbackControl,
  commentsButton,
  workingLabel,
  autoRoutedModel,
  copyText,
  planCopy,
  moreMenu,
  liveLine,
  completionStatus,
}: {
  pending?: boolean;
  startedAt?: number;
  pausedAt?: number | null;
  resumedAt?: number | null;
  accumulatedPausedDurationMs?: number;
  /** The chat has a pending tool approval; pauses an unfinished turn. */
  waitingForUser?: boolean;
  completedAt: number | null;
  showForkAction?: boolean;
  onFork?: () => void;
  showBranchAction?: boolean;
  onBranch?: () => void;
  /** Optional watcher (eye) button rendered alongside the fork/branch actions. */
  watcherButton?: ReactNode;
  /** Optional auto-archive toggle rendered after the fork action. */
  archiveToggleButton?: ReactNode;
  /** Optional share-session control rendered alongside the fork/branch actions. */
  shareButton?: ReactNode;
  /**
   * Turn-level thumbs up/down control (CAN-1521). Pinned to the trailing edge
   * of the row rather than appended after the fork/branch actions, so its x
   * position is identical on turns that do and do not carry those actions.
   */
  feedbackControl?: ReactNode;
  /**
   * Optional shared-run comments control (CAN-397) rendered after the share
   * control. Only present when the session has been shared as a run, so the
   * footer stays unchanged for the (common) unshared case.
   */
  commentsButton?: ReactNode;
  /** Override the active timer label for a pre-provider lifecycle phase. */
  workingLabel?: string;
  /**
   * Model Auto picked for this turn. Shown as a pill ahead of the turn
   * actions so each turn keeps a record of which model answered it.
   */
  autoRoutedModel?: string;
  /** The finished reply's text, for the timer row's Copy button. */
  copyText?: string;
  /** The turn's plan, whose Copy plan replaces the reply's Copy (CAN-5354). */
  planCopy?: PlanCopyState;
  /** Clean chat look: the "…" menu with the turn's less-used actions. */
  moreMenu?: ReactNode;
  /** Clean chat look: the running turn's live line; see the shared row. */
  liveLine?: ReactNode;
  /** How the settled turn ended; omitted while it runs. */
  completionStatus?: TurnCompletionStatus;
}): JSX.Element {
  if (pending) {
    // Pre-provider phases (Auto model routing) run while the send is still
    // pending, so the label must survive this branch too.
    return (
      <SharedTurnTimer
        {...(workingLabel ? { workingLabel } : {})}
        liveLine={liveLine}
        inset
      />
    );
  }

  const hasTrailing =
    (showForkAction && onFork !== undefined) ||
    (showBranchAction && onBranch !== undefined) ||
    watcherButton != null ||
    archiveToggleButton != null ||
    shareButton != null ||
    commentsButton != null;
  const trailing = hasTrailing ? (
    <>
      {/* The clean look names the model in the time's tooltip instead. */}

      {watcherButton}
      {showForkAction && onFork && <ForkChatButton onClick={onFork} />}
      {archiveToggleButton}
      {showBranchAction && onBranch && (
        <ActionTooltip
          title={`Branch ${CHAT_UNIT_LABEL}`}
          description="Create a new worktree from this one and continue the chat there."
        >
          <Button
            variant="ghost-quiet"
            size="sm"
            iconOnly
            onClick={onBranch}
            aria-label={`Branch ${CHAT_UNIT_LABEL} into new worktree`}
          >
            <BranchIcon size="sm" aria-hidden="true" />
          </Button>
        </ActionTooltip>
      )}
      {shareButton}
      {commentsButton}
    </>
  ) : undefined;

  return (
    <SharedTurnTimer
      startedAt={startedAt}
      pausedAt={pausedAt}
      resumedAt={resumedAt}
      accumulatedPausedDurationMs={accumulatedPausedDurationMs}
      waitingForUser={waitingForUser}
      finishedAt={completedAt}
      trailing={trailing}
      liveLine={liveLine}
      stampAccessory={feedbackControl}
      {...(completionStatus !== undefined ? { completionStatus } : {})}
      {...(workingLabel ? { workingLabel } : {})}
      {...(copyText !== undefined ? { copyText } : {})}
      {...(planCopy !== undefined ? { planCopy } : {})}
      {...(moreMenu != null ? { moreMenu } : {})}
      {...(autoRoutedModel !== undefined
        ? { modelLabel: getModelDisplayName(autoRoutedModel) }
        : {})}
      inset
    />
  );
}
