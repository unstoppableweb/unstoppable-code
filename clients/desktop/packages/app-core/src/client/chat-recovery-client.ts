import type { ChatPlanReviewApproval } from '@canopy/protocol/canopy-core';

/**
 * Chat recovery operations a paired desktop serves to Remote Control
 * (CAN-7435): approving a pending Claude/Codex/Ollama plan exit, and retrying
 * a failed worktree chat turn. Each is a portable client composition over
 * existing `chat:get-state`, `chat:get-transcript-page`, `chat:command` and
 * `tracked-plans:update` calls; none adds a host entrypoint, so the host's
 * own checks on those calls are the enforcement point.
 */

/** The worktree chat an operation addresses. */
export interface ChatRecoveryTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/** Approve exactly the plan exit the user reviewed. Approve-only. */
export interface ChatResolvePlanExitArgs extends ChatRecoveryTarget {
  readonly approval: ChatPlanReviewApproval;
}

/**
 * - `started`: approved, and the implementation turn was accepted.
 * - `conflict`: someone else answered, a newer revision arrived, or the chat
 *   is still running; nothing changed.
 * - `approved_not_started`: the plan is approved and plan mode is off, but
 *   the implementation turn didn't start; the user starts it by sending a
 *   message. Terminal: a second call returns `conflict`.
 * - `rejected`: no such review, or one this operation doesn't answer (an
 *   OpenCode proposal keeps its atomic `planReviewApproval` send).
 */
export type ChatResolvePlanExitOutcome =
  | 'started'
  | 'conflict'
  | 'approved_not_started'
  | 'rejected';

export interface ChatResolvePlanExitResult {
  readonly outcome: ChatResolvePlanExitOutcome;
}

/**
 * The failed turn a Retry addresses: its user message, and the failure
 * notice's own source text. A notice rendered from a live event can carry a
 * fallback id that differs from its persisted row, so identity is the text,
 * as on desktop.
 */
export interface ChatFailedTurnRetryArgs extends ChatRecoveryTarget {
  readonly turnUserMessageId: string;
  readonly noticeText: string;
}

/**
 * Why a Retry isn't offered:
 * - `busy`: the chat is running or has queued input.
 * - `not_current`: the notice isn't the chat's last persisted message (not
 *   persisted yet, or the chat moved past it), or the turn's user message
 *   isn't the last one. Ask again on the next state change.
 * - `out_of_range`: the turn's user message lies beyond the paging bound.
 * - `unavailable`: the chat isn't in the computer's state.
 *
 * A failed state or transcript read rejects instead of returning a reason.
 */
export type ChatFailedTurnRetryUnavailableReason =
  | 'busy'
  | 'not_current'
  | 'out_of_range'
  | 'unavailable';

export type ChatFailedTurnRetryCheckResult =
  | {
      readonly available: true;
      /** `true` re-sends the user's message; `false` sends `Continue`. */
      readonly resendsUserMessage: boolean;
    }
  | {
      readonly available: false;
      readonly reason: ChatFailedTurnRetryUnavailableReason;
    };

/** A Retry the host accepted (`already_applied` for a repeated one). */
export interface ChatFailedTurnRetryResult {
  readonly userMessageId: string;
  readonly disposition: 'applied' | 'already_applied';
}

export interface ChatRecoveryQueryMap {
  /** Whether Retry is offered for this failed turn, from fresh host reads. */
  'chat.checkFailedTurnRetry': {
    args: ChatFailedTurnRetryArgs;
    result: ChatFailedTurnRetryCheckResult;
  };
}

export interface ChatRecoveryCommandMap {
  /** Approve a pending Claude/Codex/Ollama plan exit and start its turn. */
  'chat.resolvePlanExit': {
    args: ChatResolvePlanExitArgs;
    result: ChatResolvePlanExitResult;
  };
  /**
   * Retry a failed turn once. Re-runs every check against fresh host reads
   * and rejects when Retry isn't available; idempotent per failure notice.
   */
  'chat.retryFailedTurn': {
    args: ChatFailedTurnRetryArgs;
    result: ChatFailedTurnRetryResult;
  };
}
