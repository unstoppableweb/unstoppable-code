import { Surface } from '@canopy/ui-shared/components';
import { type JSX } from 'react';
import type {
  ReviewAnnotation,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import { ReviewPopoverShell } from './reviewPopoverShell';
import { ReviewAnnotationCard, ReviewThreadCard } from './reviewPopoverCards';

export interface ReviewLinePopoverProps {
  anchorRect: DOMRect;
  /** Agent annotations anchored to the line (rendered first). */
  annotations: ReviewAnnotation[];
  /** Comment threads anchored to the line. */
  threads: ReviewCommentThread[];
  isThreadReadOnly?: (threadId: string) => boolean;
  onReply: (threadId: string, body: string) => void;
  onToggleResolved: (threadId: string) => void;
  onEditStagedComment: (
    threadId: string,
    commentId: string,
    body: string,
  ) => void;
  onDeleteStagedComment: (threadId: string, commentId: string) => void;
  onDiscussAnnotation: (annotationId: string) => void;
  onClose: () => void;
}

/**
 * The multi-item popover for a diff line carrying two or more annotations /
 * comment threads. A single gutter marker opens this instead of stacking
 * several overlapping markers; it shows every item fully (each thread with its
 * own reply/resolve composer) in one scrollable column, reusing the same cards
 * the single-item `ReviewCommentPopover` renders.
 */
export function ReviewLinePopover({
  anchorRect,
  annotations,
  threads,
  isThreadReadOnly,
  onReply,
  onToggleResolved,
  onEditStagedComment,
  onDeleteStagedComment,
  onDiscussAnnotation,
  onClose,
}: ReviewLinePopoverProps): JSX.Element {
  const annotationCount = annotations.length;
  const threadCount = threads.length;
  const header =
    annotationCount > 0 && threadCount > 0
      ? `${threadCount} ${threadCount === 1 ? 'comment' : 'comments'}, ${annotationCount} ${
          annotationCount === 1 ? 'annotation' : 'annotations'
        } on this line`
      : threadCount > 0
        ? `${threadCount} ${threadCount === 1 ? 'comment' : 'comments'} on this line`
        : `${annotationCount} ${
            annotationCount === 1 ? 'annotation' : 'annotations'
          } on this line`;
  return (
    <ReviewPopoverShell
      anchorRect={anchorRect}
      label={header}
      onClose={onClose}
      dataTestId="review-line-popover"
    >
      {/* A single scroll container that sizes to content up to 60vh, then
          scrolls — with a sticky header. Cards are block-level with
          `shrink-0` so a long list never squeezes them into header-only
          slivers (they keep their full body + reply composer). */}
      <div className="max-h-[60vh] overflow-auto">
        <Surface variant="annotation-header" className="sticky top-0 z-10">
          {header}
        </Surface>
        <div className="flex flex-col p-2 gap-2">
          {annotations.map((annotation) => (
            <div key={annotation.id} className="shrink-0">
              <ReviewAnnotationCard
                annotation={annotation}
                onDiscuss={(): void => onDiscussAnnotation(annotation.id)}
              />
            </div>
          ))}
          {threads.map((thread) => (
            <div key={thread.id} className="shrink-0">
              <ReviewThreadCard
                thread={thread}
                readOnly={isThreadReadOnly?.(thread.id)}
                onReply={(body): void => onReply(thread.id, body)}
                onToggleResolved={(): void => onToggleResolved(thread.id)}
                onEditStagedComment={(commentId, body): void =>
                  onEditStagedComment(thread.id, commentId, body)
                }
                onDeleteStagedComment={(commentId): void =>
                  onDeleteStagedComment(thread.id, commentId)
                }
              />
            </div>
          ))}
        </div>
      </div>
    </ReviewPopoverShell>
  );
}
