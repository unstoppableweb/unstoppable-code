import { type JSX, useState } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import type { EmptyCompletionRecoveryView } from '@/stores/chat/empty-completion';
import { FeedbackModal } from '../feedback/FeedbackModal';

export interface EmptyCompletionRecoveryNoticeProps {
  recovery: EmptyCompletionRecoveryView;
  /** Nudges the same provider session to finish the turn. */
  onResume: () => void;
  /** Re-sends the turn's original prompt. Hidden when it cannot be recovered. */
  onRetry: () => void;
  /** True while either send is in flight. */
  busy?: boolean;
  /** Post-action failure text. */
  error?: string | null;
  /** Closes the notice. The host shows it again for the next empty turn. */
  onDismiss?: () => void;
}

/**
 * The recovery state for a turn the provider called complete while producing
 * nothing (CAN-2307). Before this, such a turn rendered as a plain success
 * with only its "Completed in M:SS" row, which is indistinguishable from a
 * turn that worked.
 *
 * Action order follows the Notice contract — alternatives first, the single
 * recommended action last (rightmost). `Resume` is the recommendation because
 * it continues the SAME provider session: the agent sees whatever it already
 * did and picks up from there, so a tool call that already ran is not issued
 * a second time. `Try again` re-sends the original prompt into that session,
 * which is the right move when nothing ran at all and the wrong one once the
 * turn has started touching things — hence the extra line when it did.
 *
 * There is deliberately no automatic retry. The turn may have left work
 * half-finished that the app cannot see, so re-running it is the user's call.
 */
export function EmptyCompletionRecoveryNotice({
  recovery,
  onResume,
  onRetry,
  busy = false,
  error = null,
  onDismiss,
}: EmptyCompletionRecoveryNoticeProps): JSX.Element {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const message = recovery.repeatsToolActivity
    ? 'Resume picks up where it stopped. Try again is off because it could repeat work already done.'
    : 'Resume picks up where it stopped. Try again sends your message again.';

  return (
    <>
      <Notice
        intent="attention"
        title="The reply came back empty."
        data-testid="empty-completion-recovery"
        actionsPlacement="below"
        onDismiss={onDismiss}
        {...(error ? { detail: error } : {})}
        actions={
          <>
            <NoticeButton
              variant="secondary"
              onClick={(): void => setFeedbackOpen(true)}
              data-testid="empty-completion-recovery-report"
            >
              Report this
            </NoticeButton>
            {recovery.canRetryPrompt && (
              <NoticeButton
                variant="secondary"
                disabled={busy || recovery.repeatsToolActivity}
                onClick={onRetry}
                data-testid="empty-completion-recovery-retry"
              >
                Try again
              </NoticeButton>
            )}
            <NoticeButton
              variant="primary"
              disabled={busy}
              onClick={onResume}
              data-testid="empty-completion-recovery-resume"
            >
              {busy ? 'Resuming…' : 'Resume'}
            </NoticeButton>
          </>
        }
      >
        {message}
      </Notice>
      {feedbackOpen && (
        <FeedbackModal
          initialReportType="bug"
          onClose={(): void => setFeedbackOpen(false)}
        />
      )}
    </>
  );
}
