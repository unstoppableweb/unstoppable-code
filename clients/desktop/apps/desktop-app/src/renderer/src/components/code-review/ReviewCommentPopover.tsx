import { Surface } from '@canopy/ui-shared/components';
import { useState, type JSX } from 'react';
import type {
  ReviewAnnotation,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import { ReviewPopoverShell } from './reviewPopoverShell';
import { ReviewAnnotationCard, ReviewThreadCard } from './reviewPopoverCards';
import { Button, TextArea } from '@canopy/ui-shared/components';

export interface ReviewCommentPopoverProps {
  mode: 'compose' | 'thread' | 'annotation';
  anchorRect: DOMRect;
  thread?: ReviewCommentThread;
  readOnly?: boolean;
  annotation?: ReviewAnnotation;
  onSubmitComment?: (body: string) => void;
  onReply?: (body: string) => void;
  onToggleResolved?: () => void;
  /** Edit an unsubmitted (staged) draft comment in the active thread. */
  onEditStagedComment?: (commentId: string, body: string) => void;
  /** Delete an unsubmitted (staged) draft comment from the active thread. */
  onDeleteStagedComment?: (commentId: string) => void;
  onDiscussAnnotation?: () => void;
  annotationSourceLabel?: string;
  annotationDiscussLabel?: string;
  onClearAnnotation?: () => void;
  onClose: () => void;
}

/**
 * A single-item floating popover anchored to a diff gutter marker: composing a
 * new code comment, viewing/replying to one comment thread, or reading one
 * agent annotation. For lines with multiple items, `ReviewLinePopover` stacks
 * the same cards instead. Shell (portal/position/dismiss) is shared via
 * `ReviewPopoverShell`; the thread/annotation bodies via `reviewPopoverCards`.
 */
export function ReviewCommentPopover({
  mode,
  anchorRect,
  thread,
  readOnly = false,
  annotation,
  onSubmitComment,
  onReply,
  onToggleResolved,
  onEditStagedComment,
  onDeleteStagedComment,
  onDiscussAnnotation,
  annotationSourceLabel,
  annotationDiscussLabel,
  onClearAnnotation,
  onClose,
}: ReviewCommentPopoverProps): JSX.Element {
  // Compose mode seeds an initial quoted line when opened from the annotation
  // popover's "Discuss" action (which passes `annotation` even though `mode`
  // is `'compose'`).
  const [draftBody, setDraftBody] = useState<string>(() =>
    mode === 'compose' && annotation ? `> ${annotation.title}\n\n` : '',
  );

  const submitDraft = (): void => {
    const trimmed = draftBody.trim();
    if (trimmed.length === 0 || !onSubmitComment) {
      return;
    }
    onSubmitComment(trimmed);
    setDraftBody('');
  };

  const dataTestId =
    mode === 'compose'
      ? 'review-comment-composer'
      : mode === 'thread'
        ? 'review-comment-thread-popover'
        : undefined;

  return (
    <ReviewPopoverShell
      anchorRect={anchorRect}
      label={
        mode === 'compose'
          ? 'Add comment'
          : mode === 'thread'
            ? 'Comment thread'
            : 'Annotation'
      }
      onClose={onClose}
      dataTestId={dataTestId}
    >
      {mode === 'compose' && (
        <Surface variant="review-composer">
          <TextArea
            aria-label="Comment"
            value={draftBody}
            onChange={(event): void => setDraftBody(event.target.value)}
            onKeyDown={(event): void => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.stopPropagation();
                submitDraft();
              }
            }}
            placeholder="Add a comment… (Enter to save, Shift+Enter for a new line)"
            rows={3}
            autoFocus
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button size="compact" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="compact"
              onClick={submitDraft}
              disabled={draftBody.trim().length === 0}
              data-testid="review-comment-submit-draft"
            >
              Add comment
            </Button>
          </div>
        </Surface>
      )}

      {mode === 'thread' && thread && (
        <ReviewThreadCard
          thread={thread}
          readOnly={readOnly}
          onReply={(body): void => onReply?.(body)}
          onToggleResolved={(): void => onToggleResolved?.()}
          onEditStagedComment={(commentId, body): void =>
            onEditStagedComment?.(commentId, body)
          }
          onDeleteStagedComment={(commentId): void =>
            onDeleteStagedComment?.(commentId)
          }
        />
      )}

      {mode === 'annotation' && annotation && (
        <ReviewAnnotationCard
          annotation={annotation}
          onDiscuss={(): void => onDiscussAnnotation?.()}
          sourceLabel={annotationSourceLabel}
          discussLabel={annotationDiscussLabel}
          onClear={onClearAnnotation}
        />
      )}
    </ReviewPopoverShell>
  );
}
