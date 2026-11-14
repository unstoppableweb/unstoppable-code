import { useWorktreeReview } from './useWorktreeReview';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  CodeReviewDiagramsPanel,
  type DiagramNodeRevealRequest,
} from './CodeReviewDiagramsPanel';
import { Notice } from '@canopy/ui-shared';
import { useDiagramFind, type DiagramSearchHandle } from '@canopy/ui-app/find';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { reviewForFingerprint } from './change-diagram-review';
import { useReviewComments } from './useReviewComments';
import { FileCommentsDrawer } from '../chat/FileCommentsDrawer';
import { submitWorkspaceComments } from '../chat/submitWorkspaceComments';

export interface ChangeDiagramPanelProps {
  projectId: string;
  worktreeId: string;
  active: boolean;
}

/**
 * The worktree's change diagrams with their comments; Cmd/Ctrl+F opens the
 * shared find bar in diagram mode over the shown diagram.
 */
export function ChangeDiagramPanel({
  projectId,
  worktreeId,
  active,
}: ChangeDiagramPanelProps): JSX.Element {
  const artifacts = useWorktreeReview(projectId, worktreeId, true, active);
  const review = useMemo(
    () => reviewForFingerprint(artifacts.review ?? null, artifacts.fingerprint),
    [artifacts.fingerprint, artifacts.review],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [reveal, setReveal] = useState<DiagramNodeRevealRequest | null>(null);
  const diagramSearch = useRef<DiagramSearchHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const noticeTimer = useRef<number | null>(null);
  const scope = { projectId, worktreeId };
  const comments = useReviewComments(scope, review, true);
  useCurrentUiStateReporter('codeReview.modal', {
    open: active,
    projectId,
    worktreeId,
    armed: review?.armed ?? false,
    chatVisible: false,
    diagramVisible: active,
    chatActive: false,
    commentThreadCount: review?.commentThreads.length ?? 0,
  });
  // Named as its panel tab is, so the bar's scope menu matches the tab.
  const findTitle = useEarlyAccessTitle('Change Diagram');
  const find = useDiagramFind({
    enabled: active,
    scopeKey: `${projectId}/${worktreeId}`,
    title: findTitle,
    rootRef: root,
    handleRef: diagramSearch,
  });
  useEffect((): (() => void) => {
    return (): void => {
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current);
      }
    };
  }, []);
  const showFreshNotice = (): void => {
    setNotice('Review is up to date.');
    if (noticeTimer.current !== null) {
      window.clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = window.setTimeout(() => {
      setNotice('');
      noticeTimer.current = null;
    }, 2_000);
  };
  const generate = async (arm: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const result = arm
        ? await window.api.codeReview.arm(scope)
        : await window.api.codeReview.generate(scope);
      if (result.status === 'fresh' || result.status === 'empty') {
        showFreshNotice();
      } else if (result.status === 'error') {
        setError(result.error ?? 'Unable to generate diagrams.');
      } else if (result.status === 'stopped') {
        setError('Unable to refresh diagrams while this project is closing.');
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to generate diagrams.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      ref={root}
      // Recorded chrome (notices); the diagrams panel blocks its diagrams and
      // the comments tray blocks its threads.
      className="flex min-h-0 flex-1 flex-col outline-none"
      data-testid="change-diagram-panel"
      {...find.surfaceProps}
    >
      {(error || artifacts.error || notice) && (
        <div
          className={`flex shrink-0 flex-col gap-4 px-2 pt-2 ${notice ? '' : 'pb-2'}`}
        >
          {(error || artifacts.error) && (
            <Notice errorSource="change-diagram-panel" intent="destructive">
              {error ?? artifacts.error}
            </Notice>
          )}
          {notice && <Notice intent="positive">{notice}</Notice>}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <CodeReviewDiagramsPanel
          ref={diagramSearch}
          review={review}
          armed={review?.armed ?? false}
          refreshing={busy}
          onArm={() => {
            void generate(true);
          }}
          onRefresh={() => {
            void generate(false);
          }}
          onAddNodeComment={comments.addDiagramComment}
          revealNodeRequest={reveal}
          onSearchContextChange={find.refresh}
        />
      </div>
      <FileCommentsDrawer
        tabId={`diagram:${projectId}/${worktreeId}`}
        active={active}
        allowGeneralComment={false}
        containerRef={root}
        comments={{
          document: {
            filePath: '',
            annotations: [],
            commentThreads: comments.threads,
          },
          view: 'diff',
          otherViewCount: 0,
          stagedCount: comments.stagedCount,
          addComment: (_anchor, body) =>
            comments.addDiagramComment({
              diagramKind: 'logicDiff',
              nodeId: '',
              title: 'General diagram comment',
              body,
            }),
          discussAnnotation: () => undefined,
          dismissAnnotation: () => undefined,
          addReply: comments.addReply,
          editStagedComment: comments.editStagedComment,
          deleteStagedComment: comments.deleteStagedComment,
          toggleResolved: comments.toggleResolved,
          submit: comments.submit,
        }}
        onSubmitStaged={() => {
          void comments.submit((message, context) =>
            submitWorkspaceComments(scope, message, context),
          );
        }}
        onRevealAnchor={(anchor) => {
          if (anchor.diagramKind && anchor.nodeId)
            setReveal({
              requestId: Date.now(),
              diagramKind: anchor.diagramKind,
              nodeId: anchor.nodeId,
            });
        }}
      />
    </div>
  );
}
