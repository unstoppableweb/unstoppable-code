import type { JSX } from 'react';
import { Button } from '../primitives/Button';
import { LoadingSpinner } from '../primitives/LoadingSpinner';
import {
  AI_CREDITS_HANDOFF_COPY,
  AI_CREDITS_REOPEN_BILLING_LABEL,
  aiCreditsHandoffSentence,
} from './creditsPromptCopy';

/**
 * What a **Check again** after a billing hand-off concluded (CAN-5162).
 *
 * `'uncovered'` is a conclusive read that still shows no spendable credits.
 * `'check-failed'` is a read that failed or came back inconclusive, so it says
 * nothing about the balance or the payment.
 */
export type AiCreditsCheckFeedbackKind = 'uncovered' | 'check-failed';

export const AI_CREDITS_CHECK_UNCOVERED_COPY = aiCreditsHandoffSentence(
  AI_CREDITS_HANDOFF_COPY.uncovered,
);
export const AI_CREDITS_CHECK_FAILED_COPY = aiCreditsHandoffSentence(
  AI_CREDITS_HANDOFF_COPY.checkFailed,
);

export interface AiCreditsCheckFeedbackProps {
  readonly kind: AiCreditsCheckFeedbackKind;
  /**
   * Offered only after a conclusive uncovered result. Omit to hide the action;
   * a failed check is retried with Check again instead.
   */
  readonly onReopenBilling?: () => void;
  /** The reopen is in flight: keep the action visible but inert. */
  readonly reopenPending?: boolean;
  /** Another credits operation is in flight. */
  readonly reopenDisabled?: boolean;
  readonly dataTestId?: string;
}

/**
 * The sentence and optional recovery action shown after Check again.
 *
 * Pure display, with no live region of its own: a `Notice` host already
 * announces its `detail`, and block hosts wrap this in their own stable status
 * region. Nesting another one would double-announce.
 */
export function AiCreditsCheckFeedback({
  kind,
  onReopenBilling,
  reopenPending = false,
  reopenDisabled = false,
  dataTestId = 'ai-credits-check-feedback',
}: AiCreditsCheckFeedbackProps): JSX.Element {
  const showReopen = kind === 'uncovered' && onReopenBilling !== undefined;
  return (
    <span
      data-testid={dataTestId}
      data-feedback-kind={kind}
      className={`text-2xs leading-snug ${
        kind === 'uncovered' ? 'fg-secondary' : 'fg-warning'
      }`}
    >
      {kind === 'uncovered'
        ? AI_CREDITS_CHECK_UNCOVERED_COPY
        : AI_CREDITS_CHECK_FAILED_COPY}
      {showReopen ? (
        <>
          {' '}
          <Button
            variant="link"
            data-testid={`${dataTestId}-reopen-billing`}
            disabled={reopenPending || reopenDisabled}
            aria-busy={reopenPending}
            // Keep focus where it was (often the composer), like the other
            // credits controls.
            onMouseDown={(e): void => e.preventDefault()}
            onClick={onReopenBilling}
          >
            <span className="inline-flex items-center gap-1">
              {reopenPending && (
                <LoadingSpinner
                  dataTestId={`${dataTestId}-reopen-billing-spinner`}
                  decorative
                />
              )}
              {AI_CREDITS_REOPEN_BILLING_LABEL}
            </span>
          </Button>
        </>
      ) : null}
    </span>
  );
}
