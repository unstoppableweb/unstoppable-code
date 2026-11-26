import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { retainAppAdvisorWatchersBridge } from '@/stores/appAdvisorWatchersStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useActivitySectionChrome } from '@/components/shared/panel-section';
import { ActivitySection, type CollapsedIconColor } from './ActivitySection';
import type { DispatchPipelineTarget } from './useDispatchPipelineModal';
import { isPipelineExecutionActiveStatus } from './utils';
import type { BreadcrumbEntry } from './details/pipelineDetailTypes';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { AdvisorEtaStatus } from './AdvisorEtaBadge';
import {
  usePipelineExecutionActions,
  usePipelineExecutionWatchers,
} from './usePipelineExecutionActions';
import {
  buildExecutionTree,
  collectVisibleExecutionTreeNodes,
  pruneExpandedIdsToExpandableNodes,
  type ExecutionTreeNode,
} from '@/lib/executionTree';
import { PipelineIcon, TriggerIcon } from '@canopy/ui-shared/icons/AppIcons';
import { HeaderActionButton } from '@canopy/ui-shared/components';
import {
  PipelineRunsSectionBody,
  type PipelineRunSummary,
} from '@canopy/ui-app';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';

function PipelineRunWatcherButton({
  summary,
}: {
  summary: PipelineRunSummary;
}): JSX.Element | null {
  const pipelineWatchers = usePipelineExecutionWatchers({
    projectId: summary.project_id,
    worktreeId: summary.worktree_id,
    executionId: summary.id,
    pipelineId: summary.pipeline_id,
  });
  if (pipelineWatchers.length === 0) {
    return null;
  }
  return (
    <WatcherManagementButton
      watchers={pipelineWatchers}
      modalTitle="Workflow watchers"
      modalEmptyMessage="No active watchers for this workflow."
      ariaLabel="Manage workflow watchers"
      dataTestId={`pipeline-run-watchers-${summary.id}`}
    />
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePipelineRunsHeaderChrome(scope?: {
  projectId: string;
  worktreeId: string;
}): {
  subtitle: string;
  collapsedIconColor: CollapsedIconColor;
  hasContent: boolean;
} {
  const storedWorktree = useChatStore((state) => state.selectedWorktree);
  const selectedWorktree = scope ?? storedWorktree;
  const summaries = usePipelineRunsStore((state) => state.summaries);
  const pendingByWorktree = usePipelineRunsStore(
    (state) => state.pendingExecutions,
  );
  const queuedByWorktree = usePipelineRunsStore(
    (state) => state.queuedExecutionsByWorktree,
  );
  const failedPendingByWorktree = usePipelineRunsStore(
    (state) => state.failedPendingExecutions,
  );
  const failedQueuedByWorktree = usePipelineRunsStore(
    (state) => state.failedQueuedExecutionsByWorktree,
  );
  const key = selectedWorktree
    ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
    : '';
  const pendingCount = key ? (pendingByWorktree[key]?.length ?? 0) : 0;
  const queuedCount = key ? (queuedByWorktree[key]?.length ?? 0) : 0;
  const failedPendingCount = key
    ? (failedPendingByWorktree[key]?.length ?? 0)
    : 0;
  const failedQueuedCount = key
    ? (failedQueuedByWorktree[key]?.length ?? 0)
    : 0;
  const tree = buildExecutionTree(summaries);
  const visible = tree.filter((node) => node.summary.hidden !== true);
  const hiddenCount = tree.length - visible.length;
  const activeCount = visible.filter((node) =>
    isPipelineExecutionActiveStatus(node.summary.status),
  ).length;
  const failureCount = failedPendingCount + failedQueuedCount;
  const queuedTotal = pendingCount + queuedCount;
  return {
    subtitle:
      tree.length === 0
        ? failureCount > 0
          ? `${failureCount} failed`
          : queuedTotal > 0
            ? `${queuedTotal} queued`
            : 'No workflow runs'
        : `${activeCount} active, ${visible.length - activeCount} completed${hiddenCount > 0 ? `, ${hiddenCount} hidden` : ''}`,
    collapsedIconColor:
      activeCount > 0 || failureCount > 0
        ? 'amber'
        : visible.length > 0
          ? 'blue'
          : 'muted',
    hasContent: visible.length > 0 || queuedTotal > 0 || failureCount > 0,
  };
}

export function PipelineRunsSection({
  onDispatchPipeline,
}: {
  onDispatchPipeline: (target: DispatchPipelineTarget) => void;
}): JSX.Element {
  const headerChrome = usePipelineRunsHeaderChrome();
  // Retain the shared, ref-counted watcher bridge (which also hydrates it)
  // for the whole activity panel so every pipeline row below sees live App
  // Advisor watchers. Each row still subscribes through the store hook so
  // React re-renders when its filtered slice changes.
  useEffect(() => retainAppAdvisorWatchersBridge(), []);
  const selectedWorktree = useChatStore((s) => s.selectedWorktree);
  const summaries = usePipelineRunsStore((s) => s.summaries);
  const rowStatesById = usePipelineRunsStore((s) => s.rowStatesById);
  const advisorSnapshotsByExecutionId = usePipelineRunsStore(
    (s) => s.advisorSnapshotsByExecutionId,
  );
  const loadExecutionRowState = usePipelineRunsStore(
    (s) => s.loadExecutionRowState,
  );
  const setExecutionHidden = usePipelineRunsStore((s) => s.setExecutionHidden);
  const cancelPendingExecution = usePipelineRunsStore(
    (s) => s.cancelPendingExecution,
  );
  const dismissFailedPendingExecution = usePipelineRunsStore(
    (s) => s.dismissFailedPendingExecution,
  );
  const retryFailedPendingExecution = usePipelineRunsStore(
    (s) => s.retryFailedPendingExecution,
  );
  const pendingExecutionsByWorktree = usePipelineRunsStore(
    (s) => s.pendingExecutions,
  );
  const failedPendingExecutionsByWorktree = usePipelineRunsStore(
    (s) => s.failedPendingExecutions,
  );
  const queuedExecutionsByWorktree = usePipelineRunsStore(
    (s) => s.queuedExecutionsByWorktree,
  );
  const failedQueuedExecutionsByWorktree = usePipelineRunsStore(
    (s) => s.failedQueuedExecutionsByWorktree,
  );
  const cancelQueuedPipelineExecution = usePipelineRunsStore(
    (s) => s.cancelQueuedPipelineExecution,
  );
  const dismissFailedQueuedExecution = usePipelineRunsStore(
    (s) => s.dismissFailedQueuedExecution,
  );
  const pendingExecutionsForWorktree = useMemo(() => {
    if (!selectedWorktree) return [];
    const key = `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`;
    return pendingExecutionsByWorktree[key] ?? [];
  }, [pendingExecutionsByWorktree, selectedWorktree]);
  const failedPendingExecutionsForWorktree = useMemo(() => {
    if (!selectedWorktree) return [];
    const key = `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`;
    return failedPendingExecutionsByWorktree[key] ?? [];
  }, [failedPendingExecutionsByWorktree, selectedWorktree]);
  const queuedExecutionsForWorktree = useMemo(() => {
    if (!selectedWorktree) return [];
    const key = `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`;
    return queuedExecutionsByWorktree[key] ?? [];
  }, [queuedExecutionsByWorktree, selectedWorktree]);
  const failedQueuedExecutionsForWorktree = useMemo(() => {
    if (!selectedWorktree) return [];
    const key = `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`;
    return failedQueuedExecutionsByWorktree[key] ?? [];
  }, [failedQueuedExecutionsByWorktree, selectedWorktree]);
  const rawAddToast = useGitHubStore((s) => s.addToast);
  const addToast = useCallback(
    (message: string, type: 'error' | 'info' | 'success'): void => {
      rawAddToast(message, type, undefined, { category: 'Pipeline' });
    },
    [rawAddToast],
  );

  // Shared execution-action controller: its in-flight guards are shared with
  // every pipeline detail, and its report/follow-up dialogs render in this
  // section's document (main or an auxiliary window).
  const actions = usePipelineExecutionActions();
  // A hidden element in the section body tells which document the section
  // renders in, so the controller's dialogs open there.
  const { dialogAnchorRef } = actions;

  // Run, job, nested-run, and rerun-source links open the run's own panel
  // through the shared opener. The owner comes from the run (the listed
  // summary is a trusted hint the opener checks), never from the selection.
  const summariesRef = useRef(summaries);
  summariesRef.current = summaries;
  const openDetail = useCallback(
    (
      executionId: string,
      viewStack: readonly BreadcrumbEntry[],
      jobId?: string,
    ): void => {
      const summary = summariesRef.current.find(
        (candidate) => candidate.id === executionId,
      );
      void openPipelineExecutionFromUi({
        executionId,
        ...(summary?.project_id && summary.worktree_id
          ? {
              owner: {
                projectId: summary.project_id,
                worktreeId: summary.worktree_id,
              },
            }
          : {}),
        target: {
          viewStack: [...viewStack],
          ...(jobId !== undefined ? { jobId } : {}),
        },
      });
    },
    [],
  );
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  useCurrentUiStateReporter(
    'pipelineRuns.debugProgress',
    actions.debuggingFailureId
      ? {
          executionId: actions.debuggingFailureId,
          status: 'debugging',
        }
      : null,
  );

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const inFlightIdsRef = useRef<Set<string>>(new Set());

  const tree = useMemo(() => buildExecutionTree(summaries), [summaries]);
  const summaryLookup = useMemo(
    () => Object.fromEntries(summaries.map((summary) => [summary.id, summary])),
    [summaries],
  );

  useEffect(() => {
    setExpandedIds((prev) => {
      const next = pruneExpandedIdsToExpandableNodes(tree, prev);
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [tree]);

  const handleToggleExpand = useCallback((id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleOpenExecutionById = useCallback(
    (executionId: string): void => {
      openDetail(executionId, []);
    },
    [openDetail],
  );

  const visibleRoots = useMemo(
    () => tree.filter((n) => n.summary.hidden !== true),
    [tree],
  );
  const hiddenRoots = useMemo(
    () => tree.filter((n) => n.summary.hidden === true),
    [tree],
  );
  const visibleNodes = useMemo(
    () => collectVisibleExecutionTreeNodes(visibleRoots, expandedIds),
    [expandedIds, visibleRoots],
  );
  const visibleHiddenNodes = useMemo(
    () => collectVisibleExecutionTreeNodes(hiddenRoots, expandedIds),
    [expandedIds, hiddenRoots],
  );
  const feedbackRunIds = useMemo(
    () =>
      new Set([
        ...visibleNodes.map(({ summary }) => summary.id),
        ...(hiddenExpanded
          ? visibleHiddenNodes.map(({ summary }) => summary.id)
          : []),
      ]),
    [hiddenExpanded, visibleHiddenNodes, visibleNodes],
  );
  const prefetchMissingRows = useCallback(
    (nodes: ExecutionTreeNode[]): void => {
      for (const node of nodes) {
        const id = node.summary.id;
        if (!rowStatesById[id] && !inFlightIdsRef.current.has(id)) {
          inFlightIdsRef.current.add(id);
          void loadExecutionRowState(id).finally(() => {
            inFlightIdsRef.current.delete(id);
          });
        }
      }
    },
    [loadExecutionRowState, rowStatesById],
  );

  // Auto-load row projections for visible runs so the DAG progress bar and
  // row affordances render immediately. Actions still resolve full detail on
  // demand through the shared execution-action controller.
  useEffect(() => {
    prefetchMissingRows(visibleNodes);
  }, [prefetchMissingRows, visibleNodes]);

  useEffect(() => {
    if (!hiddenExpanded) return;
    prefetchMissingRows(visibleHiddenNodes);
  }, [hiddenExpanded, prefetchMissingRows, visibleHiddenNodes]);

  const handleToggleHidden = useCallback(
    async (executionId: string, hidden: boolean): Promise<void> => {
      const result = await setExecutionHidden(executionId, hidden);
      if (!result.success) {
        addToast(result.error ?? 'Failed to update hidden state', 'error');
      }
    },
    [addToast, setExecutionHidden],
  );

  const dispatchButton = (
    <HeaderActionButton
      iconOnly
      data-testid="pipeline-dispatch-open"
      aria-label="Dispatch workflow"
      onClick={(): void => {
        if (!selectedWorktree) return;
        onDispatchPipeline(selectedWorktree);
      }}
    >
      <TriggerIcon size={16} />
    </HeaderActionButton>
  );

  const chrome = useActivitySectionChrome();
  const frameless = chrome === 'frameless';

  return (
    <>
      <ActivitySection
        icon={<PipelineIcon />}
        title="Workflow runs"
        subtitle={headerChrome.subtitle}
        headerAction={dispatchButton}
        collapsedIconColor={headerChrome.collapsedIconColor}
        hasExpandableContent={headerChrome.hasContent}
        actionOnlyCard
        showBodyWithActionCard={hiddenRoots.length > 0}
        actionOnlyLabel="Dispatch workflow"
        framelessBody={frameless ? 'flex' : undefined}
      >
        <span ref={dialogAnchorRef} hidden />
        <PipelineRunsSectionBody
          actionFeedback={actions.renderActionError(feedbackRunIds)}
          layout={frameless ? 'frameless' : 'card'}
          queuedExecutions={queuedExecutionsForWorktree}
          failedQueuedExecutions={failedQueuedExecutionsForWorktree}
          pendingExecutions={pendingExecutionsForWorktree}
          failedPendingExecutions={failedPendingExecutionsForWorktree}
          visibleRoots={visibleRoots}
          hiddenRoots={hiddenRoots}
          hiddenExpanded={hiddenExpanded}
          onHiddenExpandedChange={setHiddenExpanded}
          onCancelQueuedExecution={(queueId) =>
            void cancelQueuedPipelineExecution(queueId)
          }
          onDismissFailedQueuedExecution={dismissFailedQueuedExecution}
          onCancelPendingExecution={cancelPendingExecution}
          onDismissFailedPendingExecution={dismissFailedPendingExecution}
          onRetryFailedPendingExecution={retryFailedPendingExecution}
          runRowProps={{
            expandedIds,
            onToggleExpand: handleToggleExpand,
            statesById: rowStatesById,
            cancellingId: actions.cancellingId,
            resumingId: actions.resumingId,
            onOpenDetail: (rootId, viewStack, jobId) =>
              openDetail(rootId, viewStack, jobId),
            onCancel: (id) => void actions.cancel(id),
            onResume: (id, pauseResponses) =>
              void actions.resume(id, pauseResponses),
            onChatFollowUp: (id) => void actions.chatFollowUp(id),
            onReportChatFollowUp: (id) => void actions.reportChatFollowUp(id),
            onViewReport: actions.openReport,
            onPipelineFollowUp: (id) => void actions.pipelineFollowUp(id),
            onOpenPlan: (id) => void actions.openPlan(id),
            onRetry: (id) => void actions.retry(id),
            onRerun: (id) => void actions.rerun(id),
            onDebugFailure: (id) => void actions.debugFailure(id),
            chatFollowUpDisabled: actions.chatFollowUpInProgress,
            retryingIds: actions.retryingIds,
            rerunningIds: actions.rerunningIds,
            debuggingFailureId: actions.debuggingFailureId,
            summaryLookup,
            onOpenSource: handleOpenExecutionById,
            parentChain: [],
            renderAdvisorBadge: (run) => (
              <AdvisorEtaStatus
                snapshot={advisorSnapshotsByExecutionId[run.id]}
                pipelineStatus={run.status}
              />
            ),
            renderWatcherButton: (run) => (
              <PipelineRunWatcherButton summary={run} />
            ),
            onToggleHidden: (id, hidden) => void handleToggleHidden(id, hidden),
          }}
        />
      </ActivitySection>

      {actions.dialogs}
    </>
  );
}
