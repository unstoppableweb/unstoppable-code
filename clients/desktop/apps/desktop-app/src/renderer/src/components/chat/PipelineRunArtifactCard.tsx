import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { PipelineRunArtifactReceiptV1 } from '@canopy/desktop-shared/types';
import type {
  ExecutionState,
  PipelineData,
} from '@canopy/execution-engine/types/pipeline';
import type {
  PipelineRunBreadcrumbEntry,
  PipelineRunPauseResponse,
  PipelineRunSummary,
} from '@canopy/ui-app';
import {
  PipelineRunReceiptCard,
  pipelineRunReceiptView,
  type PipelineRunReceiptActions,
  type PipelineRunReceiptLiveOverride,
  type PipelineRunReceiptPending,
} from '@canopy/ui-app/agent-activity';
import { getDocument } from '@canopy/ui-shared/panels';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { usePipelineExecutionSummaryInterest } from '@/stores/pipelineDetailCoordinator';
import { dispatchAppAction } from '@/lib/app-actions/dispatcher';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  openTrackedPlan,
  type OpenTrackedPlanOptions,
} from '@/lib/plans/open-tracked-plan';
import { collectVisibleExecutionTreeNodes } from '@/lib/executionTree';
import { revealChatPanel } from '@/lib/panels/reveal-chat-panel';
import { detectChatStoreSurface } from '@/stores/chat/surface';
import { AdvisorEtaStatus } from '@/components/activity/AdvisorEtaBadge';
import { PipelineReportModal } from '@/components/activity/PipelineReportModal';
import type { PipelinePluginCollectionRunContext } from '@/components/activity/PipelineTriggerModal';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';
import { watchersForPipelineExecution } from '@/components/watchers/watcherFilters';
import { PlanReadyPipelineModal } from './PlanReadyPipelineModal';
import { openAgentArtifactNavigation } from './agent-artifact-navigation';

const requestedExecutionRows = new Set<string>();

function executionPlanPath(state: ExecutionState): string | undefined {
  return (
    state.event_data?.plan_ready?.plan_path ??
    state.event_data?.task_ready?.plan_path
  );
}

interface PipelineRunArtifactCardProps {
  receipt: PipelineRunArtifactReceiptV1;
  chatTarget?: { projectId: string; worktreeId: string; chatId: string };
}

/**
 * A run's plan opens beside the chat showing this card when both belong to
 * the same worktree; otherwise beside that worktree's active chat.
 */
function planOpenOptionsForChat(
  chatTarget: PipelineRunArtifactCardProps['chatTarget'],
  projectId: string,
  worktreeId: string,
): OpenTrackedPlanOptions {
  return chatTarget?.projectId === projectId &&
    chatTarget.worktreeId === worktreeId
    ? { origin: { chatTabId: chatTarget.chatId } }
    : {};
}

export const PipelineRunArtifactCard = memo(function PipelineRunArtifactCard({
  receipt,
  chatTarget,
}: PipelineRunArtifactCardProps): JSX.Element {
  const {
    summaries,
    rowStatesById,
    statesById,
    loadDetails,
    loadRowState,
    retryExecution,
    resumeExecution,
    rerunExecution,
    advisorSnapshots,
  } = usePipelineRunsStore(
    useShallow((state) => ({
      summaries: state.summaries,
      rowStatesById: state.rowStatesById,
      statesById: state.statesById,
      loadDetails: state.loadExecutionDetails,
      loadRowState: state.loadExecutionRowState,
      retryExecution: state.retryExecution,
      resumeExecution: state.resumeExecution,
      rerunExecution: state.rerunExecution,
      advisorSnapshots: state.advisorSnapshotsByExecutionId,
    })),
  );
  const watchers = useAppAdvisorWatchersStore(
    useShallow((state) => state.watchers),
  );
  const addToast = useGitHubStore((state) => state.addToast);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [rerunningIds, setRerunningIds] = useState<Set<string>>(new Set());
  const [debuggingFailureId, setDebuggingFailureId] = useState<string | null>(
    null,
  );
  const [reportExecution, setReportExecution] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [followUpExecution, setFollowUpExecution] =
    useState<ExecutionState | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineRunError, setPipelineRunError] = useState<string | null>(null);
  const remoteControlHostRef = useRef<HTMLDivElement>(null);
  const rowExecutionState = rowStatesById[receipt.executionId];

  const liveOverride = useMemo(():
    | PipelineRunReceiptLiveOverride
    | undefined => {
    if (!rowExecutionState) return undefined;
    return {
      status: rowExecutionState.status,
      status_reasons: rowExecutionState.status_reasons,
      planId: rowExecutionState.planId,
      rerun_source_id: rowExecutionState.rerun_source_id,
      trigger_source: rowExecutionState.trigger_source,
    };
  }, [rowExecutionState]);
  const view = useMemo(
    () => pipelineRunReceiptView(receipt, summaries, liveOverride),
    [liveOverride, receipt, summaries],
  );
  const displaySummary = view.summary;
  const summaryLookup = view.summaryLookup;
  const visibleNodes = useMemo(
    () => collectVisibleExecutionTreeNodes([view.node], expandedIds),
    [expandedIds, view.node],
  );
  const visibleExecutionIds = useMemo(
    () => visibleNodes.map((visibleNode) => visibleNode.summary.id),
    [visibleNodes],
  );
  // A lightweight summary interest keeps these rows live under execution
  // events and across run-list scope changes, even when the card sits outside
  // the selected worktree. Cards never take detail or log interest.
  usePipelineExecutionSummaryInterest(visibleExecutionIds);

  useEffect(() => {
    for (const visibleNode of visibleNodes) {
      const executionId = visibleNode.summary.id;
      if (
        rowStatesById[executionId] ||
        requestedExecutionRows.has(executionId)
      ) {
        continue;
      }
      requestedExecutionRows.add(executionId);
      void loadRowState(executionId).finally(() => {
        requestedExecutionRows.delete(executionId);
      });
    }
  }, [loadRowState, rowStatesById, visibleNodes]);

  const showError = (message: string): void =>
    addToast(message, 'error', undefined, { category: 'Pipeline' });
  // Opens a run from this card: the root with its breadcrumb stack and job.
  // In the main window the run's panel opens beside this card's chat when
  // the run belongs to the chat's worktree or task; the opener checks the
  // owner. The App Advisor window hands off to the main window, which cannot
  // carry a breadcrumb stack, so a child row opens that child's own panel.
  const openExecution = (
    rootId: string,
    viewStack: readonly PipelineRunBreadcrumbEntry[] = [],
    jobId?: string,
  ): void => {
    const owner = {
      projectId: displaySummary.project_id ?? receipt.projectId,
      worktreeId: displaySummary.worktree_id ?? receipt.worktreeId,
    };
    if (detectChatStoreSurface() === 'main') {
      void openPipelineExecutionFromUi({
        executionId: rootId,
        // The card's owner describes its own run tree; a rerun source is
        // resolved from its own record.
        ...(rootId === displaySummary.id ? { owner } : {}),
        target: {
          viewStack: viewStack.map((entry) => ({
            executionId: entry.executionId,
            label: entry.label,
          })),
          ...(jobId ? { jobId } : {}),
        },
        ...(chatTarget
          ? {
              origin: {
                chatTabId: chatTarget.chatId,
                ownerKey: `${chatTarget.projectId}/${chatTarget.worktreeId}`,
              },
            }
          : {}),
      });
      return;
    }
    const leaf =
      viewStack.length > 0 ? viewStack[viewStack.length - 1] : undefined;
    void openAgentArtifactNavigation({
      kind: 'pipeline_execution',
      executionId: leaf?.executionId ?? rootId,
      ...owner,
      ...(jobId ? { jobId } : {}),
    });
  };
  const setPending = (
    setter: (
      value: Set<string> | ((current: Set<string>) => Set<string>),
    ) => void,
    executionId: string,
    pending: boolean,
  ): void =>
    setter((current) => {
      const next = new Set(current);
      if (pending) next.add(executionId);
      else next.delete(executionId);
      return next;
    });
  const handleCancel = async (executionId: string): Promise<void> => {
    if (cancellingId) return;
    setCancellingId(executionId);
    try {
      const result = await window.pipelines.cancelExecution(executionId);
      if (!result.success)
        showError(result.error ?? 'Failed to cancel execution');
    } catch (error: unknown) {
      showError(extractIpcErrorMessage(error));
    } finally {
      setCancellingId(null);
    }
  };
  const handleRetry = async (executionId: string): Promise<void> => {
    if (retryingIds.has(executionId)) return;
    setPending(setRetryingIds, executionId, true);
    try {
      const result = await retryExecution(executionId);
      if (!result.success)
        showError(result.error ?? 'Failed to retry execution');
    } catch (error: unknown) {
      showError(extractIpcErrorMessage(error));
    } finally {
      setPending(setRetryingIds, executionId, false);
    }
  };
  const handleResume = async (
    executionId: string,
    pauseResponses?: PipelineRunPauseResponse[],
  ): Promise<void> => {
    if (resumingId === executionId) return;
    setResumingId(executionId);
    try {
      const result = await resumeExecution(
        executionId,
        pauseResponses?.length ? { pauseResponses } : {},
      );
      if (!result.success)
        showError(result.error ?? 'Failed to resume execution');
    } catch (error: unknown) {
      showError(extractIpcErrorMessage(error));
    } finally {
      setResumingId((current) => (current === executionId ? null : current));
    }
  };
  const handleRerun = async (executionId: string): Promise<void> => {
    if (rerunningIds.has(executionId)) return;
    setPending(setRerunningIds, executionId, true);
    try {
      const result = await rerunExecution(executionId);
      if (!result.success) showError(result.error ?? 'Failed to start over');
    } catch (error: unknown) {
      showError(extractIpcErrorMessage(error));
    } finally {
      setPending(setRerunningIds, executionId, false);
    }
  };
  const handleOpenPlan = async (executionId: string): Promise<void> => {
    if (detectChatStoreSurface() !== 'main') {
      openExecution(executionId);
      return;
    }
    const fullState =
      statesById[executionId] ?? (await loadDetails(executionId));
    const summary = summaryLookup[executionId];
    const planId = fullState?.planId ?? summary?.planId;
    const projectId = fullState?.project_id ?? summary?.project_id;
    const worktreeId = fullState?.worktree_id ?? summary?.worktree_id;
    if (!planId || !projectId || !worktreeId) {
      showError('This workflow run is not linked to a tracked plan');
      return;
    }
    await openTrackedPlan(
      { projectId, worktreeId, planId },
      planOpenOptionsForChat(chatTarget, projectId, worktreeId),
    );
  };
  const sendExecutionArtifactToChat = async (
    executionId: string,
    kind: 'plan' | 'report',
  ): Promise<void> => {
    if (detectChatStoreSurface() !== 'main' || !chatTarget) {
      openExecution(executionId);
      return;
    }
    const fullState =
      statesById[executionId] ?? (await loadDetails(executionId));
    if (!fullState) {
      showError('Failed to load workflow execution details');
      return;
    }
    const filePath =
      kind === 'plan'
        ? executionPlanPath(fullState)
        : (fullState.report_outputs?.report_file ??
          fullState.report_outputs?.report_json_file);
    if (!filePath) {
      showError(`This workflow run does not have a saved ${kind} file`);
      return;
    }
    // The chat that receives the message may sit behind another tab, in a
    // collapsed or covered group, or in a popped-out window.
    void revealChatPanel(chatTarget);
    await useChatStore
      .getState()
      .sendMessage(`Review this ${kind}: ${filePath}`, undefined, chatTarget);
  };
  const handlePipelineFollowUp = async (executionId: string): Promise<void> => {
    if (detectChatStoreSurface() !== 'main') {
      openExecution(executionId);
      return;
    }
    const fullState =
      statesById[executionId] ?? (await loadDetails(executionId));
    if (!fullState) {
      showError('Failed to load workflow execution details');
      return;
    }
    if (!executionPlanPath(fullState)) {
      showError('This workflow run does not have a saved plan file');
      return;
    }
    // A run with no project starts only by dispatch, never from a plan.
    if ((fullState.scope ?? fullState.target?.scope) === 'global') {
      showError("A run with no project can't start a follow-up pipeline.");
      return;
    }
    setPipelineRunError(null);
    setFollowUpExecution(fullState);
  };
  const handlePipelineRun = async (
    _pipelineId: string,
    pipeline: PipelineData,
    inputs: Record<string, string> | undefined,
    selectedRepoId: string | undefined,
    pluginContext: PipelinePluginCollectionRunContext,
  ): Promise<void> => {
    const state = followUpExecution;
    const planPath = state ? executionPlanPath(state) : undefined;
    if (!state || !planPath) {
      setPipelineRunError('Missing execution context for follow-up run');
      return;
    }
    setPipelineRunning(true);
    setPipelineRunError(null);
    try {
      const executionScope =
        state.scope ??
        state.target?.scope ??
        (state.project_id && state.worktree_id ? 'worktree' : 'directory');
      let cwd =
        state.target && 'path' in state.target ? state.target.path : state.cwd;
      if (
        executionScope === 'worktree' &&
        state.project_id &&
        state.worktree_id
      ) {
        cwd = await window.api.getWorktreePath({
          projectId: state.project_id,
          worktreeId: state.worktree_id,
          ...(selectedRepoId ? { repoId: selectedRepoId } : {}),
        });
      }
      const result = await window.pipelines.execute(pipeline.content, {
        cwd,
        pipelineId: pipeline.info.id,
        pipelineFilePath:
          pipeline.info.source === 'project'
            ? pipeline.info.filePath
            : undefined,
        repoPath: pipeline.info.source === 'project' && cwd ? cwd : undefined,
        projectId: state.project_id,
        worktreeId: state.worktree_id,
        scope: executionScope,
        target:
          executionScope === 'worktree' && state.project_id && state.worktree_id
            ? {
                scope: 'worktree',
                workspace_id: state.project_id,
                worktree_id: state.worktree_id,
                path: cwd,
                created:
                  state.target?.scope === 'worktree'
                    ? state.target.created
                    : false,
              }
            : executionScope === 'directory'
              ? { scope: 'directory', path: cwd }
              : { scope: 'global' },
        eventName: 'plan_ready',
        eventData: { plan_ready: { plan_path: planPath } },
        ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
        pluginCollectionPreferences: pluginContext.preferences,
        ...(pluginContext.modelAliasPreferences
          ? { modelAliasPreferences: pluginContext.modelAliasPreferences }
          : {}),
        ...(pluginContext.modelConfig
          ? { modelConfig: pluginContext.modelConfig }
          : {}),
        ...(pluginContext.pipelinePreferenceLocator
          ? {
              pipelinePreferenceLocator:
                pluginContext.pipelinePreferenceLocator,
            }
          : {}),
        ...(pipeline.info.source === 'shared' &&
        pipeline.info.serverId &&
        pipeline.info.remoteId
          ? {
              sharedPipeline: {
                serverId: pipeline.info.serverId,
                remoteId: pipeline.info.remoteId,
              },
            }
          : {}),
      });
      if (!result.success) {
        setPipelineRunError(result.error ?? 'Workflow execution failed');
        return;
      }
      setFollowUpExecution(null);
    } catch (error: unknown) {
      setPipelineRunError(extractIpcErrorMessage(error));
    } finally {
      setPipelineRunning(false);
    }
  };
  const handleDebug = async (executionId: string): Promise<void> => {
    if (debuggingFailureId) return;
    setDebuggingFailureId(executionId);
    try {
      const response = await dispatchAppAction({
        requestId:
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `pipeline-debug-${Date.now()}`,
        source: 'ui',
        action: { type: 'pipeline.debug_run', executionId },
      });
      if (!response.ok)
        showError(response.error?.message ?? 'Failed to debug execution');
    } catch (error: unknown) {
      showError(extractIpcErrorMessage(error));
    } finally {
      setDebuggingFailureId(null);
    }
  };
  // The shared card is memoized: its actions stay stable and call the latest
  // handlers, which close over this render's state.
  const latestActions = useRef<Required<PipelineRunReceiptActions> | null>(
    null,
  );
  useLayoutEffect(() => {
    const handlers: Required<PipelineRunReceiptActions> = {
      onOpenDetail: openExecution,
      onCancel: (executionId) => void handleCancel(executionId),
      onResume: (executionId, pauseResponses) =>
        void handleResume(executionId, pauseResponses),
      onChatFollowUp: (executionId) =>
        void sendExecutionArtifactToChat(executionId, 'plan'),
      onReportChatFollowUp: (executionId) =>
        void sendExecutionArtifactToChat(executionId, 'report'),
      onViewReport: (executionId) =>
        setReportExecution({
          id: executionId,
          name:
            summaryLookup[executionId]?.pipeline_name ??
            displaySummary.pipeline_name,
        }),
      onPipelineFollowUp: (executionId) =>
        void handlePipelineFollowUp(executionId),
      onOpenPlan: (executionId) => void handleOpenPlan(executionId),
      onRetry: (executionId) => void handleRetry(executionId),
      onRerun: (executionId) => void handleRerun(executionId),
      onDebugFailure: (executionId) => void handleDebug(executionId),
      onOpenSource: (executionId) => openExecution(executionId),
    };
    latestActions.current = handlers;
  });
  const actions = useMemo(
    (): PipelineRunReceiptActions => ({
      onOpenDetail: (rootId, viewStack, jobId) =>
        latestActions.current?.onOpenDetail(rootId, viewStack, jobId),
      onCancel: (executionId) => latestActions.current?.onCancel(executionId),
      onResume: (executionId, pauseResponses) =>
        latestActions.current?.onResume(executionId, pauseResponses),
      onChatFollowUp: (executionId) =>
        latestActions.current?.onChatFollowUp(executionId),
      onReportChatFollowUp: (executionId) =>
        latestActions.current?.onReportChatFollowUp(executionId),
      onViewReport: (executionId) =>
        latestActions.current?.onViewReport(executionId),
      onPipelineFollowUp: (executionId) =>
        latestActions.current?.onPipelineFollowUp(executionId),
      onOpenPlan: (executionId) =>
        latestActions.current?.onOpenPlan(executionId),
      onRetry: (executionId) => latestActions.current?.onRetry(executionId),
      onRerun: (executionId) => latestActions.current?.onRerun(executionId),
      onDebugFailure: (executionId) =>
        latestActions.current?.onDebugFailure(executionId),
      onOpenSource: (executionId) =>
        latestActions.current?.onOpenSource(executionId),
    }),
    [],
  );
  const pending = useMemo(
    (): PipelineRunReceiptPending => ({
      cancellingId,
      resumingId,
      retryingIds,
      rerunningIds,
      debuggingFailureId,
    }),
    [cancellingId, debuggingFailureId, rerunningIds, resumingId, retryingIds],
  );
  const handleToggleExpand = useCallback((executionId: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(executionId)) next.delete(executionId);
      else next.add(executionId);
      return next;
    });
  }, []);
  const renderAdvisorBadge = useCallback(
    (summary: PipelineRunSummary): JSX.Element | null => (
      <AdvisorEtaStatus
        snapshot={advisorSnapshots[summary.id]}
        pipelineStatus={summary.status}
      />
    ),
    [advisorSnapshots],
  );
  const renderWatcherButton = useCallback(
    (summary: PipelineRunSummary): JSX.Element | null => {
      const matching = watchersForPipelineExecution(watchers, {
        projectId: summary.project_id,
        worktreeId: summary.worktree_id,
        executionId: summary.id,
        pipelineId: summary.pipeline_id,
      });
      return matching.length > 0 ? (
        <WatcherManagementButton
          watchers={matching}
          modalTitle="Workflow watchers"
          modalEmptyMessage="No active watchers for this workflow."
          ariaLabel="Manage workflow watchers"
          dataTestId={`pipeline-run-watchers-${summary.id}`}
        />
      ) : null;
    },
    [watchers],
  );
  const remoteControlDocument = getDocument(remoteControlHostRef.current);

  return (
    <>
      <div
        ref={remoteControlHostRef}
        className="contents"
        data-testid={`pipeline-run-portal-host-${receipt.executionId}`}
      >
        <PipelineRunReceiptCard
          receipt={receipt}
          summaries={summaries}
          statesById={rowStatesById}
          liveOverride={liveOverride}
          expandedIds={expandedIds}
          onToggleExpand={handleToggleExpand}
          actions={actions}
          pending={pending}
          renderAdvisorBadge={renderAdvisorBadge}
          renderWatcherButton={renderWatcherButton}
        />
      </div>
      {reportExecution && (
        <PipelineReportModal
          executionId={reportExecution.id}
          pipelineName={reportExecution.name}
          onClose={(): void => setReportExecution(null)}
          ownerDocument={remoteControlDocument}
        />
      )}
      {followUpExecution && (
        <PlanReadyPipelineModal
          projectId={followUpExecution.project_id}
          worktreeId={followUpExecution.worktree_id}
          executionScope={followUpExecution.scope}
          executionTarget={followUpExecution.target}
          onClose={(): void => {
            if (!pipelineRunning) {
              setFollowUpExecution(null);
              setPipelineRunError(null);
            }
          }}
          onRun={handlePipelineRun}
          isRunning={pipelineRunning}
          runError={pipelineRunError}
          ownerDocument={remoteControlDocument}
        />
      )}
    </>
  );
});
