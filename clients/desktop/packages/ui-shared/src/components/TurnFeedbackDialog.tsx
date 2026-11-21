import { useRef, useState, type JSX } from 'react';
import {
  MAX_TURN_FEEDBACK_COMMENT_LENGTH,
  TURN_FEEDBACK_REASONS,
  type TurnFeedbackReason,
} from '@canopy/protocol/turn-feedback';
import { Button } from './Button';
import { Chip } from './Chip';
import { DialogModal } from './DialogModal';
import { TextArea } from './Field';

const REASON_LABELS: Record<TurnFeedbackReason, string> = {
  'incorrect-or-didnt-work': "Incorrect or didn't work",
  'ignored-instructions': 'Ignored my instructions',
  'changed-more-than-asked': 'Changed more than I asked',
  'broke-something': 'Broke something that worked',
  'got-stuck': 'Got stuck or went in circles',
  'missed-context': 'Missed important context',
  'unsafe-action': 'Took an unsafe action',
  other: 'Something else',
};

export interface TurnFeedbackDialogProps {
  onClose: () => void;
  /**
   * Submit the reason and/or comment. The rating itself is already recorded,
   * so this only ever amends it — skipping simply never calls this.
   */
  onSubmit: (detail: { reason?: TurnFeedbackReason; comment?: string }) => void;
  /**
   * Opens the app-level "Report a bug / Share an idea" modal for anyone who
   * does want to send logs. Omitted on Portal, which has no such modal.
   */
  onOpenAppFeedback?: () => void;
}

/**
 * Thumbs-down detail dialog (CAN-1521). The rating is already saved by the
 * time this opens, so Escape / Skip close it without undoing anything.
 *
 * Nothing is collected beyond what the user types: no screenshots, no file
 * picker, no diagnostics bundle. That is what the dialog already looks like,
 * so it is not spelled out in copy — the only escape hatch that needs a
 * control is the full feedback form, which is the one path that does attach
 * logs.
 */
export function TurnFeedbackDialog({
  onClose,
  onSubmit,
  onOpenAppFeedback,
}: TurnFeedbackDialogProps): JSX.Element {
  const [reason, setReason] = useState<TurnFeedbackReason | undefined>(
    undefined,
  );
  const [comment, setComment] = useState('');
  const commentRef = useRef<HTMLTextAreaElement | null>(null);

  const trimmed = comment.trim();
  // Submitting with neither a reason nor a comment would post an empty detail
  // that the IPC handler short-circuits into a no-op, so the button reads as
  // working while doing nothing. "Skip" is the affordance for sending nothing.
  const hasDetail = reason !== undefined || trimmed.length > 0;
  const submit = (): void => {
    onSubmit({
      ...(reason ? { reason } : {}),
      ...(trimmed.length > 0 ? { comment: trimmed } : {}),
    });
  };

  return (
    <DialogModal
      trapFocus
      initialFocusRef={commentRef}
      onClose={onClose}
      title="What went wrong?"
      subtitle="Optional, but it helps us fix it faster."
      maxWidth="md"
      headerBorder={false}
      dataTestId="turn-feedback-dialog"
    >
      <div className="flex flex-col gap-3">
        {/*
          A toggle group, not a radio group: clicking the selected chip clears
          it. ARIA radios cannot be deselected and form a single tab stop with
          arrow-key navigation, so `role="radio"` would announce semantics this
          control does not implement. `aria-pressed` toggle buttons describe the
          actual behaviour and each chip stays independently tabbable.
        */}
        <div
          role="group"
          aria-label="Reason"
          data-testid="turn-feedback-reasons"
          // On touch each chip's hit area reaches 10px above and below.
          className="flex flex-wrap gap-1.5 pointer-coarse:gap-y-5"
        >
          {TURN_FEEDBACK_REASONS.map((code) => {
            const selected = reason === code;
            return (
              <Chip
                key={code}
                selected={selected}
                actionTestId={`turn-feedback-reason-${code}`}
                onClick={(): void => {
                  setReason(selected ? undefined : code);
                }}
              >
                {REASON_LABELS[code]}
              </Chip>
            );
          })}
        </div>

        {/*
          The prompt lives in the placeholder rather than a label above the
          field: it is the only field in the dialog, so a separate label row
          adds height without adding meaning. `aria-label` keeps the accessible
          name once the placeholder disappears on the first keystroke.
        */}
        <TextArea
          id="turn-feedback-comment"
          ref={commentRef}
          data-testid="turn-feedback-comment"
          aria-label="Anything else you want to add?"
          placeholder="Anything else?"
          value={comment}
          onChange={(event): void => {
            setComment(event.target.value);
          }}
          onKeyDown={(event): void => {
            if (
              event.key !== 'Enter' ||
              !(event.metaKey || event.ctrlKey) ||
              event.nativeEvent.isComposing
            )
              return;
            event.preventDefault();
            if (hasDetail && !event.repeat) submit();
          }}
          rows={3}
          maxLength={MAX_TURN_FEEDBACK_COMMENT_LENGTH}
        />

        <div className="flex items-center justify-end gap-2 pt-1">
          {onOpenAppFeedback && (
            <Button
              variant="ghost"
              size="compact"
              data-testid="turn-feedback-open-app-feedback"
              onClick={onOpenAppFeedback}
              className="mr-auto"
            >
              Report a bug with logs
            </Button>
          )}
          <Button
            size="compact"
            data-testid="turn-feedback-skip"
            onClick={onClose}
          >
            Skip
          </Button>
          <Button
            variant="primary"
            size="compact"
            data-testid="turn-feedback-submit"
            disabled={!hasDetail}
            onClick={submit}
          >
            Send feedback
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
