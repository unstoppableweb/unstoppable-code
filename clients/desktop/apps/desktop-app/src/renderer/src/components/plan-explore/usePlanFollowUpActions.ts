import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from 'react';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import type { PipelineData } from '@canopy/execution-engine/types/pipeline';
import type { PipelinePluginCollectionRunContext } from '@/components/activity/PipelineTriggerModal';
import type { PlanReadyPipelineModalOnRun } from '@/components/chat/PlanReadyPipelineModal';
import type { SharePlanShareRequest } from '@/components/shared/SharePlanModal';
import { hasVisiblePlanShare } from '@/components/shared/planShareLabel';
import { useShareAccess } from '@/hooks/useShareAccess';
import { useTeamOrgShareEntryVisible } from '@/lib/share-targets';
import { extractIpcErrorMessage } from '@/lib/errors';
import { buildPlanReadyExecuteOptions } from '@/lib/planReadyPipelineExecuteOptions';
import { implementTrackedPlan } from '@/lib/plans/plan-follow-up';
import { PLAN_DISPATCH_BUSY_MESSAGE } from '@/stores/chat/plan-utils';
import { beginPlanWorkflowDispatch } from './usePlanImplementationState';
import { reconcileExecutedPlan } from '@/lib/plans/reconcile-tracked-plans';
import { planLinkedExecutionIds } from '@/lib/plans/linked-executions';
import { SHARE_PLAN_GATE_CONTEXT } from '@/lib/share-gate-context';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';

/** A pipeline run linked to the plan, labeled for the linked-runs menu. */
export interface PlanLinkedExecution {
  readonly id: string;
  /** Pipeline name, or a short id while the run's summary is unknown. */
  readonly label: string;
  readonly status?: string;
  /** ISO start, once the run's summary is known. */
  readonly startedAt?: string;
}

export interface UsePlanFollowUpActionsOptions {
  /** Revision on screen; `null` is Latest. Sharing needs the latest plan. */
  viewedRevision: number | null;
  /**
   * Implement chose the plan's worktree chat. Called once, as soon as that
   * chat is its worktree's active tab and before the send settles, so the
   * chat can be shown right away; a send that then fails raises a toast.
   */
  onImplemented?: (chatId: string) => void;
  /** A `plan_ready` pipeline run started successfully. */
  onPipelineStarted?: () => void;
}

/**
 * Plan follow-up state and handlers shared by every plan view: Implement,
 * the `plan_ready` pipeline run, sharing, and the linked-runs menu. All of it
 * targets the plan's own worktree.
 */
export interface PlanFollowUpActions {
  linkedExecutions: readonly PlanLinkedExecution[];
  executionsOpen: boolean;
  setExecutionsOpen: Dispatch<SetStateAction<boolean>>;
  implement: () => void;
  pipelineModalOpen: boolean;
  openPipelineModal: () => void;
  /** Close the pipeline dialog; ignored while a run is starting. */
  closePipelineModal: () => void;
  pipelineRunning: boolean;
  pipelineRunError: string | null;
  runPipeline: PlanReadyPipelineModalOnRun;
  /**
   * Whether the Share entry is offered: the selected context has a
   * destination, or the plan is shared.
   */
  shareEnabled: boolean;
  sharing: boolean;
  /** Start sharing, behind the cloud sign-in gate. */
  requestShare: () => void;
  shareModalOpen: boolean;
  /** Close the share dialog; ignored while a share is in flight. */
  closeShareModal: () => void;
  submitShare: (
    request: SharePlanShareRequest,
  ) => Promise<TrackedPlanData | null>;
  /** Stop sharing the plan; rejects with the reason when it failed. */
  submitUnshare: () => Promise<TrackedPlanData | null>;
  /** Cloud sign-in prompt backing {@link requestShare}; render it once. */
  shareGateModal: JSX.Element | null;
}

function useLinkedExecutions(
  plan: TrackedPlanData,
): readonly PlanLinkedExecution[] {
  const summaries = usePipelineRunsStore((s) => s.summaries);
  return useMemo((): PlanLinkedExecution[] => {
    const ids = planLinkedExecutionIds(plan, summaries);
    return Array.from(ids).map((id): PlanLinkedExecution => {
      const summary = summaries.find((entry) => entry.id === id);
      return {
        id,
        label: summary?.pipeline_name ?? id.slice(0, 8),
        ...(summary?.status ? { status: summary.status } : {}),
        ...(summary?.started_at ? { startedAt: summary.started_at } : {}),
      };
    });
  }, [plan, summaries]);
}

function useImplementAction(
  plan: TrackedPlanData,
  onImplemented: ((chatId: string) => void) | undefined,
): () => void {
  const addToast = useGitHubStore((s) => s.addToast);
  return useCallback((): void => {
    // Show the chat as soon as it is chosen, not after the send, the
    // approval, and the plan reload settle (and never again after them).
    void implementTrackedPlan(
      plan,
      onImplemented === undefined ? {} : { onChatChosen: onImplemented },
    ).catch((error: unknown) => {
      addToast(
        error instanceof Error ? error.message : 'Failed to start implement',
        'error',
        undefined,
        {
          category: 'Chat',
          projectId: plan.projectId,
          worktreeId: plan.worktreeId,
        },
      );
    });
  }, [plan, onImplemented, addToast]);
}

interface PipelineRunState {
  pipelineModalOpen: boolean;
  setPipelineModalOpen: Dispatch<SetStateAction<boolean>>;
  pipelineRunning: boolean;
  pipelineRunError: string | null;
  setPipelineRunError: Dispatch<SetStateAction<string | null>>;
  runPipeline: PlanReadyPipelineModalOnRun;
}

function usePipelineRun(
  plan: TrackedPlanData,
  onPipelineStarted: (() => void) | undefined,
): PipelineRunState {
  const markTrackedPlanExecuted = useChatStore(
    (s) => s.markTrackedPlanExecuted,
  );
  const [pipelineModalOpen, setPipelineModalOpen] = useState(false);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineRunError, setPipelineRunError] = useState<string | null>(null);

  const runPipeline = useCallback(
    async (
      _pipelineId: string,
      pipeline: PipelineData,
      inputs: Record<string, string> | undefined,
      selectedRepoId: string | undefined,
      pluginCollectionContext: PipelinePluginCollectionRunContext,
    ): Promise<void> => {
      const { projectId, worktreeId } = plan;
      const release = beginPlanWorkflowDispatch(plan);
      if (!release) {
        setPipelineRunError(PLAN_DISPATCH_BUSY_MESSAGE);
        return;
      }
      setPipelineRunning(true);
      setPipelineRunError(null);

      let succeeded = false;
      try {
        const cwd = await window.api.getWorktreePath({
          projectId,
          worktreeId,
          repoId: selectedRepoId,
        });
        const result = await window.pipelines.execute(
          pipeline.content,
          buildPlanReadyExecuteOptions({
            cwd,
            pipeline,
            projectId,
            worktreeId,
            planId: plan.id,
            planContent: plan.content,
            inputs,
            pluginCollectionContext,
          }),
        );

        if (!result.success) {
          setPipelineRunError(result.error ?? 'Workflow execution failed');
          return;
        }

        succeeded = true;
        markTrackedPlanExecuted({ projectId, worktreeId, planId: plan.id });
        // Implicit plan approval is performed authoritatively in the main
        // process (`startPipelineExecutionFromMain`) for every `plan_ready`
        // run, so the renderer no longer emits a duplicate approval. The
        // refetch below pulls the already-approved state back from main.
        await reconcileExecutedPlan({ projectId, worktreeId }, plan.id);
      } catch (error: unknown) {
        setPipelineRunError(extractIpcErrorMessage(error));
      } finally {
        release();
        setPipelineRunning(false);
        if (succeeded) {
          setPipelineModalOpen(false);
          onPipelineStarted?.();
        }
      }
    },
    [plan, markTrackedPlanExecuted, onPipelineStarted],
  );

  return {
    pipelineModalOpen,
    setPipelineModalOpen,
    pipelineRunning,
    pipelineRunError,
    setPipelineRunError,
    runPipeline,
  };
}

interface PlanShareState {
  sharing: boolean;
  setSharing: Dispatch<SetStateAction<boolean>>;
  shareModalOpen: boolean;
  setShareModalOpen: Dispatch<SetStateAction<boolean>>;
  submitShare: PlanFollowUpActions['submitShare'];
  submitUnshare: PlanFollowUpActions['submitUnshare'];
  startShare: () => void;
}

function usePlanShare(
  plan: TrackedPlanData,
  viewedRevision: number | null,
): PlanShareState {
  const shareTrackedPlan = useActivityStore((s) => s.shareTrackedPlan);
  const unshareTrackedPlan = useActivityStore((s) => s.unshareTrackedPlan);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const { projectId, worktreeId, id: planId } = plan;

  // Share always targets the latest local plan, never the revision being
  // viewed — sharing an old revision is disabled in the UI.
  const submitShare = useCallback(
    async (request: SharePlanShareRequest): Promise<TrackedPlanData | null> => {
      setSharing(true);
      try {
        return await shareTrackedPlan(projectId, worktreeId, planId, request);
      } finally {
        setSharing(false);
      }
    },
    [projectId, worktreeId, planId, shareTrackedPlan],
  );

  // Leaves `sharing` alone: the dialog locks itself while it stops, and
  // closes through `closeShareModal` the moment the stop lands.
  const submitUnshare = useCallback(
    (): Promise<TrackedPlanData | null> =>
      unshareTrackedPlan(projectId, worktreeId, planId),
    [projectId, worktreeId, planId, unshareTrackedPlan],
  );

  // A shared plan opens its access view; nothing is pushed until the
  // dialog's own actions ask (CAN-5904).
  const startShare = useCallback((): void => {
    if (viewedRevision !== null) {
      return;
    }
    setShareModalOpen(true);
  }, [viewedRevision]);

  return {
    sharing,
    setSharing,
    shareModalOpen,
    setShareModalOpen,
    submitShare,
    submitUnshare,
    startShare,
  };
}

export function usePlanFollowUpActions(
  plan: TrackedPlanData,
  options: UsePlanFollowUpActionsOptions,
): PlanFollowUpActions {
  const { viewedRevision, onImplemented, onPipelineStarted } = options;
  const linkedExecutions = useLinkedExecutions(plan);
  const [executionsOpen, setExecutionsOpen] = useState(false);
  const implement = useImplementAction(plan, onImplemented);
  const pipeline = usePipelineRun(plan, onPipelineStarted);
  const share = usePlanShare(plan, viewedRevision);
  const { requestShare: requestGatedShare, shareGateModal } = useShareAccess();
  // Personal has no Team/Organization destination for a brand-new share, so
  // the entry appears there only for an existing share (CAN-3460).
  const shareEntryVisible = useTeamOrgShareEntryVisible(
    hasVisiblePlanShare(plan),
  );

  const { setPipelineModalOpen, setPipelineRunError, pipelineRunning } =
    pipeline;
  const { setShareModalOpen, setSharing, sharing, startShare } = share;

  // Reset transient view state whenever a different plan is shown.
  useEffect(() => {
    setExecutionsOpen(false);
    setPipelineModalOpen(false);
    setPipelineRunError(null);
    setShareModalOpen(false);
    setSharing(false);
  }, [
    plan.id,
    setPipelineModalOpen,
    setPipelineRunError,
    setShareModalOpen,
    setSharing,
  ]);

  const openPipelineModal = useCallback((): void => {
    setPipelineRunError(null);
    setPipelineModalOpen(true);
  }, [setPipelineModalOpen, setPipelineRunError]);

  const closePipelineModal = useCallback((): void => {
    if (pipelineRunning) {
      return;
    }
    setPipelineModalOpen(false);
    setPipelineRunError(null);
  }, [pipelineRunning, setPipelineModalOpen, setPipelineRunError]);

  const requestShare = useCallback((): void => {
    requestGatedShare(SHARE_PLAN_GATE_CONTEXT, startShare);
  }, [requestGatedShare, startShare]);

  const closeShareModal = useCallback((): void => {
    if (sharing) {
      return;
    }
    setShareModalOpen(false);
  }, [sharing, setShareModalOpen]);

  return {
    linkedExecutions,
    executionsOpen,
    setExecutionsOpen,
    implement,
    pipelineModalOpen: pipeline.pipelineModalOpen,
    openPipelineModal,
    closePipelineModal,
    pipelineRunning,
    pipelineRunError: pipeline.pipelineRunError,
    runPipeline: pipeline.runPipeline,
    shareEnabled: shareEntryVisible,
    sharing,
    requestShare,
    shareModalOpen: share.shareModalOpen,
    closeShareModal,
    submitShare: share.submitShare,
    submitUnshare: share.submitUnshare,
    shareGateModal,
  };
}
