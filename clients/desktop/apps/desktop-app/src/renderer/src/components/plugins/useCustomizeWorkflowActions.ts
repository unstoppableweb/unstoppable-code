import { useEffect, useMemo, type JSX } from 'react';
import { useCapabilities } from '@canopy/app-state';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { PipelineInfo } from '@canopy/protocol/pipelines';
import type { CustomizeWorkflowActions } from '@canopy/ui-app/capability';
import type {
  UnifiedPluginEntry,
  WorkflowLastRun,
} from '@canopy/ui-shared/lib';
import {
  retainExecutionFeed,
  useExecutionFeedStore,
} from '@/lib/workflows/execution-feed';
import {
  executionLastRunState,
  latestExecutions,
} from '@/lib/workflows/library-projection';
import { openPipelineRuns } from '@/lib/workflows/open-pipeline-runs';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useDispatchPipelineModal } from '../activity/useDispatchPipelineModal';

export interface CustomizeWorkflowActionsInput {
  readonly pipelines: readonly PipelineInfo[];
  readonly activities: readonly ScheduledActivity[];
  readonly refreshPipelines: () => Promise<void>;
  readonly deletePipeline: (
    id: string,
    options?: { callerShowsFailure?: () => boolean },
  ) => Promise<boolean>;
  readonly deleteSharedPipeline: (
    remoteId: string,
    options?: { callerShowsFailure?: () => boolean },
  ) => Promise<boolean>;
}

export interface CustomizeWorkflowActionsResult {
  readonly workflowActions: CustomizeWorkflowActions;
  /** Undefined until the run feed first loads, so no row claims `Not run yet` early. */
  readonly pipelineLastRuns:
    | ReadonlyMap<string, WorkflowLastRun | null>
    | undefined;
  /** The Run modal; the page renders it. */
  readonly dispatchPipelineModal: JSX.Element | null;
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The desktop's Customize Workflows row actions (CAN-4845), over the same
 * stores and commands as the Workflows page: the automations store, the Run
 * modal, the pipeline list and the Workflows editor and Runs feed.
 */
export function useCustomizeWorkflowActions({
  pipelines,
  activities,
  refreshPipelines,
  deletePipeline,
  deleteSharedPipeline,
}: CustomizeWorkflowActionsInput): CustomizeWorkflowActionsResult {
  const capabilities = useCapabilities();
  const selectedWorktree = useChatStore((state) => state.selectedWorktree);
  const { openWorkflowsRunModal, dispatchPipelineModal } =
    useDispatchPipelineModal();

  useEffect(() => retainExecutionFeed(), []);
  const executions = useExecutionFeedStore((state) => state.executions);
  const executionsLoaded = useExecutionFeedStore((state) => state.loaded);
  const pipelineLastRuns = useMemo(():
    | ReadonlyMap<string, WorkflowLastRun | null>
    | undefined => {
    if (!executionsLoaded) return undefined;
    // Executions carry the pipeline id but not its source, so a local and a
    // shared pipeline with the same id share a last run.
    const latest = latestExecutions(executions);
    const runs = new Map<string, WorkflowLastRun | null>();
    for (const pipeline of pipelines) {
      const execution = latest.get(pipeline.id);
      if (!execution) {
        runs.set(pipeline.id, null);
        continue;
      }
      const state = executionLastRunState(execution.status);
      const at =
        state === 'running'
          ? undefined
          : parseTime(execution.completed_at ?? execution.started_at);
      runs.set(pipeline.id, at === undefined ? { state } : { state, at });
    }
    return runs;
  }, [executions, executionsLoaded, pipelines]);

  const workflowActions = useMemo((): CustomizeWorkflowActions => {
    const activityOf = (
      entry: UnifiedPluginEntry,
    ): ScheduledActivity | undefined => {
      const { ref } = entry;
      if (ref.type !== 'automation') return undefined;
      return activities.find((activity) => activity.id === ref.activityId);
    };
    return {
      capabilities,
      onRun: (entry): void => {
        if (entry.ref.type !== 'pipeline') return;
        // The modal owns the run from here: target, inputs and its toast.
        openWorkflowsRunModal({
          initialPipelineId: entry.ref.pipelineId,
          ...(selectedWorktree
            ? {
                currentTarget: {
                  projectId: selectedWorktree.projectId,
                  worktreeId: selectedWorktree.worktreeId,
                },
              }
            : {}),
        });
      },
      onSetEnabled: async (entry, enabled): Promise<void> => {
        if (entry.ref.type !== 'automation') return;
        const response = await useAutomationsStore
          .getState()
          .updateActivity({ id: entry.ref.activityId, enabled });
        if (!response.ok) {
          throw new Error(response.error ?? 'Could not update the automation.');
        }
      },
      onRunNow: async (entry): Promise<void> => {
        const activity = activityOf(entry);
        if (!activity) return;
        // A changed shared pipeline is reviewed in the editor before it runs.
        if (activity.sharedPipelineReview) {
          useNavigationStore
            .getState()
            .openAutomationEdit({ activityId: activity.id });
          return;
        }
        const response = await useAutomationsStore
          .getState()
          .runNow(activity.id);
        if (!response.ok) {
          throw new Error(response.error ?? 'Could not start the automation.');
        }
      },
      onEdit: (entry): void => {
        const { ref } = entry;
        if (ref.type === 'automation') {
          useNavigationStore
            .getState()
            .openAutomationEdit({ activityId: ref.activityId });
          return;
        }
        if (ref.type !== 'pipeline') return;
        useNavigationStore.getState().openPipelineEdit({
          pipelineId: ref.pipelineId,
          ...(ref.source === 'bundled' || ref.source === 'user'
            ? { source: ref.source }
            : {}),
          ...(ref.source === 'project' && ref.filePath
            ? { filePath: ref.filePath }
            : {}),
          ...(ref.source === 'shared' && ref.remoteId
            ? { sharedRemoteId: ref.remoteId }
            : {}),
        });
      },
      onViewRuns: (entry): void => {
        if (entry.ref.type === 'automation') {
          useNavigationStore.getState().openAutomationEdit({
            activityId: entry.ref.activityId,
            section: 'runs',
          });
          return;
        }
        if (entry.ref.type === 'pipeline') openPipelineRuns(entry.name);
      },
      onDelete: async (entry, confirmationShown): Promise<string | null> => {
        const failure = `Couldn't delete ${entry.name}`;
        const { ref } = entry;
        if (ref.type === 'automation') {
          const response = await useAutomationsStore
            .getState()
            .deleteActivity(ref.activityId);
          return response.ok ? null : (response.error ?? failure);
        }
        if (ref.type !== 'pipeline') return failure;
        // The confirmation shows and records the failure, so the pipeline
        // list's load error, which the page would raise, holds it only once
        // the confirmation is gone.
        const handled = confirmationShown
          ? { callerShowsFailure: confirmationShown }
          : {};
        const deleted =
          ref.source === 'shared'
            ? ref.remoteId
              ? await deleteSharedPipeline(ref.remoteId, handled)
              : false
            : await deletePipeline(ref.pipelineId, handled);
        if (!deleted) return failure;
        await refreshPipelines();
        return null;
      },
      onActionError: (message): void => {
        useGitHubStore.getState().addToast(message, 'error');
      },
    };
  }, [
    activities,
    capabilities,
    deletePipeline,
    deleteSharedPipeline,
    openWorkflowsRunModal,
    refreshPipelines,
    selectedWorktree,
  ]);

  return { workflowActions, pipelineLastRuns, dispatchPipelineModal };
}
