import { Stack } from '@canopy/ui-shared/components';
import { DocumentProse } from '@canopy/ui-shared/components/Markdown';
import {
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  PlanComment,
  PlanCommentAnchor,
  PlanCommentThread,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  PLAN_MARKDOWN_OPTIONS,
  stripPlanTitleLine,
} from '@canopy/ui-app/plan-markdown';
import { SourcePositionMarkdown } from '@canopy/ui-shared/components/SourcePositionMarkdown';
import {
  createHighlightContributor,
  type HighlightContributor,
} from '@/lib/css-highlights';
import {
  findTextRange,
  isRangeInContainer,
  rangeContainsPoint,
} from '@/lib/dom-text-range';
import {
  isPendingSubmission,
  truncateQuote,
} from '@/components/plan-explore/usePlanComments';
import { ChangeDiagramIcon, MapIcon } from '@canopy/ui-shared/icons/AppIcons';
import { CommentsTray } from '@/components/shared/CommentsTray';
import {
  clampPlanExploreTrayHeight,
  loadPlanExploreCommentsCollapsed,
  loadPlanExploreTrayHeight,
  savePlanExploreCommentsCollapsed,
  savePlanExploreTrayHeight,
} from '@/components/plan-explore/planExploreLayout';
import {
  PlanCommentComposer,
  PlanReviewComment,
  PlanReviewCommentActions,
  PlanReviewThread,
  type PlanReviewAuthor,
} from '@canopy/ui-shared';
import {
  Button,
  Popover,
  TextArea,
  type PopoverAnchorRect,
} from '@canopy/ui-shared/components';

/**
 * Map a comment to the shared review author shape, from the plan owner's
 * perspective on the desktop (CAN-393): their own comments are "You", a web
 * teammate uses their display name, and
 * the agent keeps its role.
 */
function toReviewAuthor(comment: PlanComment): PlanReviewAuthor {
  switch (comment.author) {
    case 'user':
      return { name: 'You', kind: 'user', isYou: true };
    case 'remote': {
      const name = comment.remoteAuthor?.displayName ?? 'Teammate';
      return { name, kind: 'remote' };
    }
    case 'agent':
      return { name: 'Agent', kind: 'agent' };
  }
}

/** Custom Highlight API registration names (styled in globals.css). */
const DRAFT_HIGHLIGHT = 'plan-comment-draft';
const ANCHOR_HIGHLIGHT = 'plan-comment-anchor';

export interface PlanDocumentPanelProps {
  /** The latest tracked plan; used for raw content and heading resolution. */
  plan: TrackedPlanData;
  /** Markdown content to render (may be an older revision). */
  displayContent: string;
  /**
   * When true the panel renders read-only: existing threads are listed but no
   * new comments can be added (e.g. when viewing a non-latest revision).
   */
  readOnly: boolean;
  /**
   * Comment threads owned by `usePlanComments` in the parent modal (single
   * source of truth). This panel renders + anchors them but never mutates the
   * list directly.
   */
  threads: PlanCommentThread[];
  /** Count of staged comments in open threads (for the submit button). */
  stagedCount: number;
  /** Stage an anchored (or general/unanchored) document comment. */
  addDocumentComment: (anchor: PlanCommentAnchor, body: string) => void;
  /** Append a staged reply to an existing thread. */
  addReply: (threadId: string, body: string) => void;
  /** Update a not-yet-submitted comment body. */
  editStagedComment: (
    threadId: string,
    commentId: string,
    body: string,
  ) => void;
  /** Remove a not-yet-submitted comment (drops the thread when last). */
  deleteStagedComment: (threadId: string, commentId: string) => void;
  /** Flip a thread between open and resolved. */
  toggleResolved: (threadId: string) => void;
  /**
   * Submit all staged comments to chat. When omitted, the tray offers no
   * submit action (comments are staged in shared storage only).
   */
  onSubmit?: () => void;
  /** Switch to a diagram-anchored comment's diagram and reveal its node
   * (bottom-tray diagram jump), routed to `PlanVisualizerPanel` by the modal. */
  onRevealDiagramNode?: (
    diagramKind: 'sequence' | 'logicDiff' | 'dataModelDiff',
    nodeId: string,
  ) => void;
}

interface PendingSelection {
  /** Exact raw markdown of the anchored block(s). */
  rawQuote: string;
  /** Rendered text the user selected (for display/highlight). */
  renderedText: string;
  /** 1-based canonical line range, when resolvable from source positions. */
  lineStart?: number;
  lineEnd?: number;
  /** The selection's box, where the draft popover hangs. */
  anchorRect: PopoverAnchorRect;
  /** The document showing the panel; the popover opens in its window. */
  ownerDocument: Document;
}

interface SourceLineRange {
  start: number;
  end: number;
}

/**
 * Walk up from a DOM node to the nearest ancestor carrying a
 * `data-sourcepos="start:end"` attribute (stamped by the shared source-position
 * renderer) and parse its 1-based source line range.
 */
function nearestSourcePos(node: Node | null): SourceLineRange | null {
  let element = node instanceof Element ? node : (node?.parentElement ?? null);
  while (element) {
    const raw = element.getAttribute('data-sourcepos');
    if (raw) {
      const [startRaw, endRaw] = raw.split(':');
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        return { start, end };
      }
    }
    element = element.parentElement;
  }
  return null;
}

/**
 * Locate the nearest preceding markdown heading for the first occurrence of
 * `quote` in `content`. Returns a single-element heading path, or `[]` when no
 * heading precedes the quote.
 */
function nearestHeadingPath(content: string, quote: string): string[] {
  const index = content.indexOf(quote);
  if (index < 0) {
    return [];
  }
  const before = content.slice(0, index);
  const lines = before.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^#{1,6}\s+(.*)$/.exec(lines[i].trim());
    if (match) {
      const text = match[1].trim();
      return text.length > 0 ? [text] : [];
    }
  }
  return [];
}

function PlanDocumentPanelImpl({
  plan,
  displayContent,
  readOnly,
  threads,
  stagedCount,
  addDocumentComment,
  addReply,
  editStagedComment,
  deleteStagedComment,
  toggleResolved,
  onSubmit,
  onRevealDiagramNode,
}: PlanDocumentPanelProps): JSX.Element {
  // Wraps the scrollable document AND the bottom tray, so the tray's resize
  // drag can compute its height as a percentage of this whole column — mirrors
  // `CodeChangesPanel.tsx`'s `panelRootRef`.
  const panelRootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Exact range of the in-progress draft selection (kept so the highlight and
  // popover survive the native selection clearing when the user clicks away).
  const draftRangeRef = useRef<Range | null>(null);
  // Resolved ranges for committed threads, keyed by thread id.
  const threadRangesRef = useRef<Map<string, Range>>(new Map());
  // This panel's share of the named highlights in the window that shows it.
  // Other plan views paint the same names; each keeps its own ranges.
  const highlightContributorRef = useRef<HighlightContributor | null>(null);
  const highlights = useCallback((): HighlightContributor | null => {
    const ownerDocument = containerRef.current?.ownerDocument;
    const current = highlightContributorRef.current;
    if (!ownerDocument || current?.ownerDocument === ownerDocument) {
      return current;
    }
    // First paint, or the panel moved to another window's document.
    current?.dispose();
    const next = createHighlightContributor(ownerDocument);
    highlightContributorRef.current = next;
    return next;
  }, []);

  const [pendingSelection, setPendingSelection] =
    useState<PendingSelection | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState<{
    threadId: string;
    commentId: string;
    body: string;
  } | null>(null);

  // Resizable bottom comments tray (height as a % of this panel). The
  // drag/paint mechanics live in the shared `CommentsTray` component — this
  // only owns the committed value + persistence. Mirrors
  // `CodeChangesPanel.tsx`'s `trayHeightPercent`.
  const [trayHeightPercent, setTrayHeightPercent] = useState<number>(() =>
    loadPlanExploreTrayHeight(),
  );
  const handleTrayHeightCommit = useCallback((percent: number): void => {
    setTrayHeightPercent(percent);
    savePlanExploreTrayHeight(percent);
  }, []);

  // Collapsible comments tray (mirrors the code-review modal), persisted across
  // sessions like the tray height above.
  const [commentsCollapsed, setCommentsCollapsed] = useState<boolean>(() =>
    loadPlanExploreCommentsCollapsed(),
  );
  const handleToggleCommentsCollapsed = useCallback((): void => {
    setCommentsCollapsed((prev) => {
      const next = !prev;
      savePlanExploreCommentsCollapsed(next);
      return next;
    });
  }, []);
  const expandComments = useCallback((): void => {
    setCommentsCollapsed((prev) => {
      if (!prev) {
        return prev;
      }
      savePlanExploreCommentsCollapsed(false);
      return false;
    });
  }, []);

  // Stage a general (unanchored) note — reuses `addDocumentComment` with an
  // empty, unanchored anchor rather than a dedicated mutator (there is no
  // `addGeneralComment` on `usePlanComments`; `addDocumentComment` already
  // spreads `source: 'document'` over whatever anchor it's given).
  const addNote = useCallback(
    (body: string): void => {
      addDocumentComment({ quote: '', unanchored: true }, body);
    },
    [addDocumentComment],
  );

  // The markdown actually rendered (title line stripped). Source positions from
  // the rehype plugin are relative to THIS string; `lineOffset` maps them back
  // to canonical `displayContent` line numbers so we can slice the exact raw
  // markdown the agent must edit.
  const renderedSource = useMemo(
    () => stripPlanTitleLine(displayContent),
    [displayContent],
  );
  const lineOffset = useMemo(() => {
    const index = displayContent.indexOf(renderedSource);
    if (index <= 0) {
      return 0;
    }
    return displayContent.slice(0, index).split('\n').length - 1;
  }, [displayContent, renderedSource]);

  const clearDraftHighlight = useCallback((): void => {
    draftRangeRef.current = null;
    highlights()?.clear(DRAFT_HIGHLIGHT);
  }, [highlights]);

  const handleMouseUp = useCallback((): void => {
    if (readOnly) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    // Read the selection of the document showing the panel (a popped-out
    // panel lives in another window).
    const ownerDocument = container.ownerDocument;
    const selection = ownerDocument.getSelection();
    // A collapsed selection means a plain click (including clicks that land
    // after the popover opened). The popover only closes via Cancel/Comment, so
    // we leave any in-progress draft untouched here.
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer)
    ) {
      return;
    }
    const renderedText = selection.toString().trim();
    if (renderedText.length === 0) {
      return;
    }

    // Resolve the canonical source line range from the rehype-stamped DOM, then
    // slice the EXACT raw markdown (formatting intact) from the canonical
    // content. Fall back to the rendered text when positions are unavailable.
    const startPos = nearestSourcePos(range.startContainer);
    const endPos = nearestSourcePos(range.endContainer);
    let rawQuote = renderedText;
    let lineStart: number | undefined;
    let lineEnd: number | undefined;
    if (startPos && endPos) {
      lineStart = startPos.start + lineOffset;
      lineEnd = endPos.end + lineOffset;
      const rawLines = displayContent.split('\n').slice(lineStart - 1, lineEnd);
      if (rawLines.length > 0) {
        rawQuote = rawLines.join('\n');
      }
    }

    const draftRange = range.cloneRange();
    draftRangeRef.current = draftRange;
    highlights()?.set(DRAFT_HIGHLIGHT, [draftRange]);

    const box = range.getBoundingClientRect();
    setPendingSelection({
      rawQuote,
      renderedText,
      lineStart,
      lineEnd,
      anchorRect: {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      },
      ownerDocument,
    });
    setDraftBody('');
  }, [readOnly, displayContent, lineOffset, highlights]);

  const cancelDraft = useCallback((): void => {
    setPendingSelection(null);
    setDraftBody('');
    clearDraftHighlight();
  }, [clearDraftHighlight]);

  const saveDraft = useCallback((): void => {
    if (!pendingSelection) {
      return;
    }
    const body = draftBody.trim();
    if (body.length === 0) {
      return;
    }
    // Build the document anchor from the captured selection (raw markdown +
    // rendered text + canonical line range + enclosing heading). The hook owns
    // the thread/comment ids and persistence; this panel only computes the
    // anchor and hands it over.
    const anchor: PlanCommentAnchor = {
      quote: pendingSelection.rawQuote,
      renderedText: pendingSelection.renderedText,
      ...(pendingSelection.lineStart != null
        ? { lineStart: pendingSelection.lineStart }
        : {}),
      ...(pendingSelection.lineEnd != null
        ? { lineEnd: pendingSelection.lineEnd }
        : {}),
      headingPath: nearestHeadingPath(
        plan.content,
        // The raw quote is an exact slice of the plan content, so it locates
        // the enclosing heading reliably; fall back to the rendered text.
        pendingSelection.rawQuote || pendingSelection.renderedText,
      ),
    };
    addDocumentComment(anchor, body);
    setPendingSelection(null);
    setDraftBody('');
    clearDraftHighlight();
  }, [
    pendingSelection,
    draftBody,
    plan.content,
    addDocumentComment,
    clearDraftHighlight,
  ]);

  const submitReply = useCallback(
    (threadId: string): void => {
      const body = (replyDrafts[threadId] ?? '').trim();
      if (body.length === 0) {
        return;
      }
      addReply(threadId, body);
      setReplyDrafts((prev) => ({ ...prev, [threadId]: '' }));
    },
    [replyDrafts, addReply],
  );

  const startEditingComment = useCallback(
    (threadId: string, commentId: string, body: string): void => {
      setEditingComment({ threadId, commentId, body });
    },
    [],
  );

  const cancelEditingComment = useCallback((): void => {
    setEditingComment(null);
  }, []);

  const saveEditingComment = useCallback((): void => {
    if (!editingComment) {
      return;
    }
    const body = editingComment.body.trim();
    if (body.length === 0) {
      return;
    }
    editStagedComment(editingComment.threadId, editingComment.commentId, body);
    setEditingComment(null);
  }, [editingComment, editStagedComment]);

  useEffect(() => {
    if (!editingComment) {
      return;
    }
    const stillEditable = threads.some(
      (thread) =>
        thread.id === editingComment.threadId &&
        thread.comments.some(
          (comment) =>
            comment.id === editingComment.commentId && comment.staged === true,
        ),
    );
    if (!stillEditable) {
      setEditingComment(null);
    }
  }, [threads, editingComment]);

  // Active threads stay in the main list; resolved or outdated ones move into a
  // collapsed "archived" section the user can expand to interact with again.
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

  const handleSubmit = useCallback((): void => {
    if (stagedCount === 0) {
      return;
    }
    onSubmit?.();
  }, [stagedCount, onSubmit]);

  // Recompute the committed-anchor highlight whenever threads or the rendered
  // content change. Prefer the exact captured range; fall back to locating the
  // quote in the freshly rendered DOM (e.g. after a reload re-created nodes).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const liveIds = new Set(threads.map((thread) => thread.id));
    for (const id of Array.from(threadRangesRef.current.keys())) {
      if (!liveIds.has(id)) {
        threadRangesRef.current.delete(id);
      }
    }

    const ranges: Range[] = [];
    for (const thread of threads) {
      if (thread.anchorState === 'outdated' || thread.anchor.unanchored) {
        threadRangesRef.current.delete(thread.id);
        continue;
      }
      const existing = threadRangesRef.current.get(thread.id);
      let range =
        existing && isRangeInContainer(existing, container) ? existing : null;
      if (!range) {
        // Highlight by the rendered selection text (the raw markdown quote
        // contains syntax that isn't present in the rendered DOM).
        range = findTextRange(
          container,
          thread.anchor.renderedText ?? thread.anchor.quote,
        );
        if (range) {
          threadRangesRef.current.set(thread.id, range);
        } else {
          threadRangesRef.current.delete(thread.id);
        }
      }
      if (range) {
        ranges.push(range);
      }
    }
    highlights()?.set(ANCHOR_HIGHLIGHT, ranges);
  }, [threads, displayContent, highlights]);

  // Remove this panel's highlights on unmount; other views keep theirs.
  useEffect(
    () => (): void => {
      highlightContributorRef.current?.dispose();
      highlightContributorRef.current = null;
    },
    [],
  );

  // Scroll the active thread card into view when a committed highlight is
  // clicked.
  useEffect(() => {
    if (commentsCollapsed || !activeThreadId || !listRef.current) {
      return;
    }
    const card = listRef.current.querySelector(
      `[data-comment-card="${activeThreadId}"]`,
    );
    if (card instanceof HTMLElement) {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeThreadId, commentsCollapsed]);

  const handleContainerClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const selection = event.currentTarget.ownerDocument.getSelection();
      // Ignore clicks that are part of a drag-selection.
      if (selection && !selection.isCollapsed) {
        return;
      }
      for (const thread of threads) {
        const range = threadRangesRef.current.get(thread.id);
        if (range && rangeContainsPoint(range, event.clientX, event.clientY)) {
          expandComments();
          setActiveThreadId(thread.id);
          return;
        }
      }
    },
    [expandComments, threads],
  );

  // Jump to a tray card's anchor: a diagram-anchored comment switches the
  // visualizer to its diagram and reveals the node; a document-anchored
  // comment scrolls its already-highlighted passage into view (the
  // `ANCHOR_HIGHLIGHT` effect above keeps `threadRangesRef` current). A
  // general (unanchored) note has nothing to jump to. `Range` has no
  // `scrollIntoView` of its own, so this resolves the nearest element
  // ancestor of the range's start, mirroring how `handleContainerClick`
  // above already reasons about ranges. Mirrors `CodeChangesPanel.tsx`'s
  // `handleJumpToThread`; a full cross-file-style jump (re-selecting a
  // stale/outdated revision, etc.) isn't applicable here since the document
  // is always the single active plan view.
  const handleJumpToThread = useCallback(
    (thread: PlanCommentThread): void => {
      if (thread.anchor.source === 'diagram') {
        if (thread.anchor.diagramKind && thread.anchor.planNodeId) {
          onRevealDiagramNode?.(
            thread.anchor.diagramKind,
            thread.anchor.planNodeId,
          );
        }
        return;
      }
      setActiveThreadId(thread.id);
      const range = threadRangesRef.current.get(thread.id);
      if (!range) {
        return;
      }
      const node = range.startContainer;
      const el = node instanceof Element ? node : node.parentElement;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    [onRevealDiagramNode],
  );

  const renderThread = (thread: PlanCommentThread): JSX.Element => {
    const resolved = thread.status === 'resolved';
    const active = thread.id === activeThreadId;
    const unanchored = thread.anchor.unanchored === true;
    const fromDiagram = thread.anchor.source === 'diagram';
    const generalComment = unanchored && !fromDiagram;
    const anchorText = thread.anchor.renderedText ?? thread.anchor.quote ?? '';
    const referenceText = generalComment
      ? 'General comment'
      : anchorText.length > 0
        ? `“${truncateQuote(anchorText, 80)}”`
        : 'Diagram comment';
    const reference = {
      text: referenceText,
      outdated: thread.anchorState === 'outdated',
      icon: fromDiagram ? (
        <ChangeDiagramIcon size="sm" />
      ) : (
        <MapIcon size="sm" />
      ),
      iconLabel: fromDiagram ? 'From diagram' : 'From plan document',
      // A general note has nothing to jump to; document/diagram anchors do.
      ...(generalComment
        ? {}
        : {
            onActivate: (): void => handleJumpToThread(thread),
            activateLabel: fromDiagram
              ? `Open ${referenceText} in the diagram`
              : 'Jump to this passage in the plan',
          }),
    };

    return (
      <PlanReviewThread
        key={thread.id}
        compact
        active={active}
        status={thread.status}
        commentCount={thread.comments.length}
        reference={reference}
        dataTestId={`plan-comment-thread-${thread.id}`}
        dataAttributes={{ 'data-comment-card': thread.id }}
        footer={
          readOnly ? undefined : (
            <PlanCommentComposer
              compact
              value={replyDrafts[thread.id] ?? ''}
              onChange={(value): void =>
                setReplyDrafts((prev) => ({ ...prev, [thread.id]: value }))
              }
              onSubmit={(): void => submitReply(thread.id)}
              submitLabel="Reply"
              submitDisabled={(replyDrafts[thread.id] ?? '').trim() === ''}
              secondaryAction={{
                label: resolved ? 'Reopen' : 'Resolve',
                onClick: (): void => toggleResolved(thread.id),
              }}
            />
          )
        }
      >
        {thread.comments.map((comment) => {
          const isEditing =
            editingComment?.threadId === thread.id &&
            editingComment.commentId === comment.id;
          if (isEditing) {
            return (
              <PlanReviewComment
                key={comment.id}
                compact
                author={toReviewAuthor(comment)}
                timestamp={comment.createdAt}
              >
                <Stack gap="tight">
                  <TextArea
                    aria-label="Comment"
                    value={editingComment.body}
                    onChange={(e): void =>
                      setEditingComment({
                        threadId: thread.id,
                        commentId: comment.id,
                        body: e.target.value,
                      })
                    }
                    onKeyDown={(e): void => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEditingComment();
                        return;
                      }
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        saveEditingComment();
                      }
                    }}
                    rows={3}
                    autoFocus
                    data-testid={`plan-comment-edit-input-${comment.id}`}
                  />
                  <div className="flex items-center justify-end gap-1.5">
                    <Button size="compact" onClick={cancelEditingComment}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="compact"
                      onClick={saveEditingComment}
                      disabled={editingComment.body.trim().length === 0}
                      data-testid={`plan-comment-edit-save-${comment.id}`}
                    >
                      Save
                    </Button>
                  </div>
                </Stack>
              </PlanReviewComment>
            );
          }

          const pending =
            thread.status === 'open' && isPendingSubmission(comment);
          const actions =
            comment.staged === true && !readOnly ? (
              <PlanReviewCommentActions
                onEdit={(): void =>
                  startEditingComment(thread.id, comment.id, comment.body)
                }
                onDelete={(): void => {
                  deleteStagedComment(thread.id, comment.id);
                }}
                editTestId={`plan-comment-edit-${comment.id}`}
                deleteTestId={`plan-comment-delete-${comment.id}`}
              />
            ) : undefined;

          return (
            <PlanReviewComment
              key={comment.id}
              compact
              author={toReviewAuthor(comment)}
              timestamp={comment.createdAt}
              pending={pending}
              actions={actions}
            >
              <span className="whitespace-pre-wrap break-words">
                {comment.body}
              </span>
            </PlanReviewComment>
          );
        })}
      </PlanReviewThread>
    );
  };

  return (
    // Blocked from session replay: the plan and its comment threads.
    <div
      ref={panelRootRef}
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex min-h-0 min-w-0 flex-1 flex-col`}
    >
      <div
        ref={containerRef}
        data-testid="plan-explore-plan-panel"
        onMouseUp={handleMouseUp}
        onClick={handleContainerClick}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        <DocumentProse variant="editor">
          <SourcePositionMarkdown options={PLAN_MARKDOWN_OPTIONS}>
            {renderedSource}
          </SourcePositionMarkdown>
        </DocumentProse>
      </div>

      {!readOnly && pendingSelection ? (
        // The shared popover at the selection: focus goes to the comment
        // field, Escape and an outside press cancel the draft, and presses
        // inside never reach the panel's selection and click handlers.
        <Popover
          open
          onOpenChange={(next): void => {
            if (!next) cancelDraft();
          }}
          anchorRect={pendingSelection.anchorRect}
          ownerDocument={pendingSelection.ownerDocument}
          gap={6}
          containEvents
          outsidePressSwallowsClick={false}
          aria-label="Comment on the plan"
          data-testid="plan-comment-draft"
        >
          {/* Portaled out of the panel's block with the selected plan text
              and the draft, so it carries its own. */}
          <div
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex flex-col gap-1.5`}
          >
            <p className="truncate text-2xs italic fg-secondary">
              “{truncateQuote(pendingSelection.renderedText, 60)}”
            </p>
            <TextArea
              aria-label="Comment"
              value={draftBody}
              onChange={(e): void => setDraftBody(e.target.value)}
              onKeyDown={(e): void => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  saveDraft();
                }
              }}
              placeholder="Add a comment… (Enter to save, Shift+Enter for a new line)"
              rows={3}
              autoFocus
            />
            <div className="flex items-center justify-end gap-1.5">
              <Button size="compact" onClick={cancelDraft}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="compact"
                onClick={saveDraft}
                disabled={draftBody.trim().length === 0}
                data-testid="plan-comment-draft-save"
              >
                Comment
              </Button>
            </div>
          </div>
        </Popover>
      ) : null}

      <CommentsTray
        containerRef={panelRootRef}
        rootRef={listRef}
        heightPercent={trayHeightPercent}
        clampHeightPercent={clampPlanExploreTrayHeight}
        onHeightCommit={handleTrayHeightCommit}
        collapsed={commentsCollapsed}
        onToggleCollapsed={handleToggleCommentsCollapsed}
        collapseToggleTestId="plan-comments-collapse-toggle"
        resizeAriaLabel="Resize comments panel"
        containerTestId="plan-explore-comments-tray"
        totalCount={threads.length}
        activeThreads={activeThreads}
        archivedThreads={archivedThreads}
        renderThread={renderThread}
        readOnly={readOnly}
        onAddNote={addNote}
        stagedCount={stagedCount}
        onSubmitStaged={onSubmit ? handleSubmit : undefined}
        emptyStateText={
          readOnly
            ? 'Switch to the latest revision to add comments.'
            : 'Select plan text to add a comment, or use “+ Add comment” for a general note.'
        }
        addNoteTestId="plan-comment-add-note"
        noteInputTestId="plan-comment-note-input"
        noteSaveTestId="plan-comment-note-save"
        submitTestId="plan-comments-submit"
        archivedToggleTestId="plan-comments-archived-toggle"
      />
    </div>
  );
}

export const PlanDocumentPanel = memo(PlanDocumentPanelImpl);
