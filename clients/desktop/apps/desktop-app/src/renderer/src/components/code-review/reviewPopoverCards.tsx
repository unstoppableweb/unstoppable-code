import { Surface } from '@canopy/ui-shared/components';
import { Stack } from '@canopy/ui-shared/components';
import { useState, type JSX } from 'react';
import type {
  ReviewAnnotation,
  ReviewCommentAuthor,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import {
  PlanCommentComposer,
  PlanReviewComment,
  PlanReviewCommentActions,
  PlanReviewThread,
  Markdown,
  type PlanReviewAuthor,
  type PlanReviewThreadReference,
} from '@canopy/ui-shared';
import {
  ANNOTATION_KIND_TEXT_CLASS,
  annotationKindIcon,
} from './code-review-icons';
import { Button, TextArea } from '@canopy/ui-shared/components';

function toReviewAuthor(author: ReviewCommentAuthor): PlanReviewAuthor {
  if (author === 'agent') {
    return { name: 'Agent', kind: 'agent' };
  }
  return { name: 'You', kind: 'user', isYou: true };
}

export interface ReviewAnnotationCardProps {
  annotation: ReviewAnnotation;
  onDiscuss: () => void;
  sourceLabel?: string;
  discussLabel?: string;
  onClear?: () => void;
}

/** An agent-authored annotation: title + body + a "Discuss" action. */
export function ReviewAnnotationCard({
  annotation,
  onDiscuss,
  sourceLabel,
  discussLabel = 'Discuss',
  onClear,
}: ReviewAnnotationCardProps): JSX.Element {
  return (
    <Surface variant="review-card">
      {sourceLabel ? (
        <span className="text-2xs font-medium fg-secondary">{sourceLabel}</span>
      ) : null}
      <div className="flex items-center gap-1.5">
        <span className={ANNOTATION_KIND_TEXT_CLASS[annotation.kind]}>
          {annotationKindIcon(annotation.kind)}
        </span>
        <span className="text-xs font-semibold fg-primary">
          {annotation.title}
        </span>
      </div>
      <div className="text-xs fg-primary">
        <Markdown>{annotation.body}</Markdown>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {onClear ? (
          <Button
            variant="ghost"
            size="compact"
            data-testid="review-annotation-clear"
            onClick={onClear}
          >
            Clear highlight
          </Button>
        ) : null}
        <Button
          size="compact"
          data-testid="review-annotation-discuss"
          onClick={onDiscuss}
        >
          {discussLabel}
        </Button>
      </div>
    </Surface>
  );
}

export interface ReviewThreadCardProps {
  thread: ReviewCommentThread;
  readOnly?: boolean;
  onReply: (body: string) => void;
  onToggleResolved: () => void;
  /** Edit an unsubmitted (staged) draft comment in this thread. */
  onEditStagedComment: (commentId: string, body: string) => void;
  /** Delete an unsubmitted (staged) draft comment from this thread. */
  onDeleteStagedComment: (commentId: string) => void;
  /** Anchored reference line (file:line / diagram node). Only the bottom
   * tray passes this — the diff-gutter popovers are already anchored at the
   * line, so they omit it (matches the original popover-only behavior). */
  reference?: PlanReviewThreadReference;
  /** Tighter spacing for the bottom tray; the popover stays regular size. */
  compact?: boolean;
  dataTestId?: string;
}

/**
 * One comment thread with its comments, staged-draft edit/delete affordances,
 * and a reply/resolve composer footer. Owns its own reply + inline-edit state
 * so multiple cards can be stacked (in the line popover) independently. Also
 * backs the bottom comments tray (`CodeChangesPanel.tsx`'s `renderThread`) via
 * the optional `reference`/`compact` props, so the tray and diff-gutter
 * popovers share one card implementation instead of two divergent ones.
 */
export function ReviewThreadCard({
  thread,
  readOnly = false,
  onReply,
  onToggleResolved,
  onEditStagedComment,
  onDeleteStagedComment,
  reference,
  compact = false,
  dataTestId,
}: ReviewThreadCardProps): JSX.Element {
  const [replyBody, setReplyBody] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');

  const startEditingComment = (commentId: string, body: string): void => {
    setEditingCommentId(commentId);
    setEditingBody(body);
  };
  const cancelEditingComment = (): void => {
    setEditingCommentId(null);
    setEditingBody('');
  };
  const saveEditingComment = (): void => {
    if (readOnly || !editingCommentId) {
      return;
    }
    const trimmed = editingBody.trim();
    if (trimmed.length === 0) {
      return;
    }
    onEditStagedComment(editingCommentId, trimmed);
    cancelEditingComment();
  };
  const submitReply = (): void => {
    const trimmed = replyBody.trim();
    if (readOnly || trimmed.length === 0) {
      return;
    }
    onReply(trimmed);
    setReplyBody('');
  };

  return (
    <PlanReviewThread
      compact={compact}
      dataTestId={dataTestId}
      status={thread.status}
      commentCount={thread.comments.length}
      reference={reference}
      footer={
        readOnly ? (
          replyBody.length > 0 ? (
            <TextArea
              aria-label="Unsent reply"
              value={replyBody}
              readOnly
              rows={3}
            />
          ) : null
        ) : (
          <PlanCommentComposer
            compact
            value={replyBody}
            onChange={setReplyBody}
            onSubmit={submitReply}
            submitLabel="Reply"
            submitDisabled={replyBody.trim().length === 0}
            secondaryAction={{
              label: thread.status === 'resolved' ? 'Reopen' : 'Resolve',
              onClick: onToggleResolved,
            }}
          />
        )
      }
    >
      {thread.comments.map((comment) => {
        const pending = comment.staged === true;

        if (editingCommentId === comment.id) {
          return (
            <PlanReviewComment
              key={comment.id}
              compact={compact}
              author={toReviewAuthor(comment.author)}
              timestamp={comment.createdAt}
              pending={pending}
            >
              <Stack gap="tight">
                <TextArea
                  aria-label="Comment"
                  value={editingBody}
                  readOnly={readOnly}
                  onChange={(event): void => setEditingBody(event.target.value)}
                  onKeyDown={(event): void => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelEditingComment();
                      return;
                    }
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      saveEditingComment();
                    }
                  }}
                  rows={3}
                  autoFocus
                />
                <div className="flex items-center justify-end gap-1.5">
                  <Button size="compact" onClick={cancelEditingComment}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="compact"
                    onClick={saveEditingComment}
                    disabled={readOnly || editingBody.trim().length === 0}
                  >
                    Save
                  </Button>
                </div>
              </Stack>
            </PlanReviewComment>
          );
        }

        // Only unsubmitted (staged) drafts get edit/delete affordances; once a
        // comment has been submitted to the agent it is immutable.
        const actions =
          pending && !readOnly ? (
            <PlanReviewCommentActions
              onEdit={(): void => startEditingComment(comment.id, comment.body)}
              onDelete={(): void => onDeleteStagedComment(comment.id)}
              editTestId="review-comment-edit-draft"
              deleteTestId="review-comment-delete-draft"
            />
          ) : undefined;

        return (
          <PlanReviewComment
            key={comment.id}
            compact={compact}
            author={toReviewAuthor(comment.author)}
            timestamp={comment.createdAt}
            pending={pending}
            actions={actions}
          >
            <Markdown>{comment.body}</Markdown>
          </PlanReviewComment>
        );
      })}
    </PlanReviewThread>
  );
}
