import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import type {
  ReviewCommentAnchor,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import {
  ChangesIcon,
  CodeBracketsIcon,
  Badge,
  Tooltip,
} from '@canopy/ui-shared';
import { CommentsTray } from '@/components/shared/CommentsTray';
import { ReviewThreadCard } from '@/components/code-review/reviewPopoverCards';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import type { UseFileComments } from './useFileComments';

interface FileCommentsDrawerProps {
  tabId: string;
  active: boolean;
  comments: UseFileComments;
  containerRef: RefObject<HTMLDivElement | null>;
  onSubmitStaged?: () => void;
  onRevealAnchor: (anchor: ReviewCommentAnchor) => void;
  canRevealAnchor?: (anchor: ReviewCommentAnchor) => boolean;
  /** Diagram surfaces only support node-anchored comments. */
  allowGeneralComment?: boolean;
}

function clampDrawerHeight(value: number): number {
  return Math.min(72, Math.max(20, value));
}

export function FileCommentsDrawer({
  tabId,
  active,
  comments,
  containerRef,
  onSubmitStaged,
  onRevealAnchor,
  canRevealAnchor = (): boolean => true,
  allowGeneralComment = true,
}: FileCommentsDrawerProps): JSX.Element | null {
  const [heightPercent, setHeightPercent] = useState(34);
  const [collapsed, setCollapsed] = useState(false);
  const trayRef = useRef<HTMLDivElement>(null);
  const threads = comments.drawerThreads ?? comments.document.commentThreads;

  const activeThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.status === 'open' && thread.anchorState !== 'outdated',
      ),
    [threads],
  );
  const archivedThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.status === 'resolved' || thread.anchorState === 'outdated',
      ),
    [threads],
  );

  useCurrentUiStateReporter(`files.commentsDrawer.${tabId}`, {
    active,
    visible: active && threads.length > 0,
    collapsed,
    heightPercent,
    totalCount: threads.length,
    activeCount: activeThreads.length,
    stagedCount: comments.stagedCount,
  });

  const reveal = useCallback(
    (thread: ReviewCommentThread): void => {
      onRevealAnchor(thread.anchor);
    },
    [onRevealAnchor],
  );

  if (threads.length === 0) return null;

  return (
    <CommentsTray
      containerRef={containerRef}
      rootRef={trayRef}
      heightPercent={heightPercent}
      clampHeightPercent={clampDrawerHeight}
      onHeightCommit={setHeightPercent}
      resizeAriaLabel="Resize file comments"
      containerTestId="file-comments-drawer"
      totalCount={threads.length}
      activeThreads={activeThreads}
      archivedThreads={archivedThreads}
      renderThread={(thread): JSX.Element => {
        const start = thread.anchor.lineStart;
        const end = thread.anchor.lineEnd ?? start;
        const referenceText =
          thread.anchor.source === 'diagram'
            ? `Diagram · ${thread.anchor.quote}`
            : thread.anchor.unanchored
              ? 'General file comment'
              : start === undefined
                ? comments.document.filePath
                : end !== undefined && end !== start
                  ? `Lines ${start}–${end}`
                  : `Line ${start}`;
        const origin =
          thread.anchor.source === 'diagram'
            ? 'diagram'
            : thread.anchor.view === 'diff'
              ? 'diff'
              : 'file';
        return (
          <ReviewThreadCard
            key={thread.id}
            compact
            dataTestId={`file-comment-thread-${thread.id}`}
            thread={thread}
            readOnly={comments.isThreadReadOnly?.(thread.id)}
            onReply={(body): void => comments.addReply(thread.id, body)}
            onToggleResolved={(): void => comments.toggleResolved(thread.id)}
            onEditStagedComment={(commentId, body): void =>
              comments.editStagedComment(thread.id, commentId, body)
            }
            onDeleteStagedComment={(commentId): void =>
              comments.deleteStagedComment(thread.id, commentId)
            }
            reference={{
              text:
                thread.anchor.source !== 'diagram' &&
                thread.anchor.view === 'diff'
                  ? `${thread.anchor.diff?.source ?? 'legacy'} · ${thread.anchor.side ?? 'file'} · ${referenceText}`
                  : referenceText,
              outdated: thread.anchorState === 'outdated',
              icon: <CodeBracketsIcon size="sm" />,
              iconLabel: `From ${origin}`,
              badge:
                thread.anchor.view === 'diff' &&
                thread.anchor.source !== 'diagram' ? (
                  <Tooltip label="Comment from diff view">
                    <span
                      data-testid="file-comment-diff-badge"
                      role="img"
                      aria-label="Comment from diff view"
                      tabIndex={0}
                      className="focus-ring inline-flex"
                    >
                      <Badge>
                        <ChangesIcon size={12} aria-hidden="true" />
                      </Badge>
                    </span>
                  </Tooltip>
                ) : undefined,
              ...(!thread.anchor.unanchored && canRevealAnchor(thread.anchor)
                ? {
                    onActivate: (): void => reveal(thread),
                    activateLabel: `Reveal ${referenceText} in ${origin}`,
                  }
                : {}),
            }}
          />
        );
      }}
      readOnly={!allowGeneralComment}
      onAddNote={(body): void =>
        comments.addComment(
          {
            source: 'code',
            filePath: comments.document.filePath,
            side: 'new',
            quote: '',
            unanchored: true,
          },
          body,
        )
      }
      stagedCount={comments.stagedCount}
      onSubmitStaged={onSubmitStaged}
      emptyStateText="Select file text to start a comment."
      addNoteTestId="file-comments-add-note"
      noteInputTestId="file-comments-note-input"
      noteSaveTestId="file-comments-note-save"
      submitTestId="file-comments-submit"
      archivedToggleTestId="file-comments-archived-toggle"
      collapsed={collapsed}
      onToggleCollapsed={(): void => setCollapsed((current) => !current)}
      collapseToggleTestId="file-comments-collapse-toggle"
    />
  );
}
