import { useCallback, useMemo, useState, type JSX } from 'react';
import {
  PipelineTriggerModal,
  type PipelinePluginCollectionRunContext,
  type PipelineRunContextReview,
} from './PipelineTriggerModal';
import type { PipelineWatcherSelection } from './usePipelineRunWatcher';
import type {
  PipelineData,
  PipelineExecutionScope,
} from '@canopy/execution-engine/types/pipeline';
import {
  PIPELINE_RUN_CONTEXT_COPY,
  PipelineRunContextFields,
  type PipelineRunLocation,
  type PipelineRunOn,
} from '@canopy/ui-app/workflows';
import type { WatcherRecipientGroup } from '@/components/watchers/WatcherRecipientPicker';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { usePipelineWorktreeContext } from './usePipelineWorktreeContext';
import {
  cloudRunSourceUnavailable,
  loadPipelineRunOn,
  savePipelineRunOn,
  usePipelineCloudRuns,
} from './pipelineRunOn';
import {
  usePipelineRunOwnerChoices,
  usePipelineRunOwnerSelection,
} from './usePipelineRunOwnerChoices';
import {
  resolveWorkflowsRunContext,
  type PipelineRunDestination,
  type ResolvedRunContext,
} from './workflowsRunContext';

export type { PipelineRunDestination } from './workflowsRunContext';

export type DispatchPipelinePluginCollectionContext =
  PipelinePluginCollectionRunContext;

interface DispatchPipelineModalProps {
  projectId?: string;
  worktreeId?: string;
  /** Preselects a pipeline in the select step (see PipelineTriggerModal). */
  initialPipelineId?: string;
  onClose: () => void;
  onRun: (
    pipeline: PipelineData,
    inputs: Record<string, string>,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
  ) => Promise<void>;
  isRunning?: boolean;
  runError?: string | null;
  onClearError?: () => void;
  watcherRecipientGroups?: WatcherRecipientGroup[];
  onWatcherSelectionChange?: (
    selection: PipelineWatcherSelection | null,
  ) => void;
}

export function DispatchPipelineModal({
  projectId,
  worktreeId,
  initialPipelineId,
  onClose,
  onRun,
  isRunning = false,
  runError = null,
  onClearError,
  watcherRecipientGroups,
  onWatcherSelectionChange,
}: DispatchPipelineModalProps): JSX.Element {
  const title = useEarlyAccessTitle('Dispatch Pipeline');
  const { cwd, cwdResolved, repoChoices } = usePipelineWorktreeContext(
    projectId,
    worktreeId,
  );

  // A resolved worktree cwd means this dispatch surface runs in a worktree
  // context (so it should also list `directory`/legacy pipelines via the
  // capability relation); otherwise treat it as a `directory` surface.
  // Cowork workspaces resolve a cwd too (the workspace folder), but they are
  // never a git worktree — their dispatches are directory-scoped, so only
  // directory-satisfiable pipelines are listed.
  const isCowork = projectId !== undefined && isCoworkChatTarget(projectId);
  const executionScope = isCowork
    ? 'directory'
    : cwd
      ? 'worktree'
      : 'directory';

  const handleRun = async (
    _pipelineId: string,
    pipeline: PipelineData,
    inputs: Record<string, string> | undefined,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
  ): Promise<void> => {
    await onRun(
      pipeline,
      inputs ?? {},
      selectedRepoId,
      pluginCollectionContext,
    );
  };

  return (
    <PipelineTriggerModal
      triggerType="dispatch"
      labels={{
        title,
        selectSubtitle: 'Select a workflow with dispatch trigger',
        emptyMessage: 'No workflows with dispatch trigger found',
      }}
      cwd={cwd}
      contextPending={!cwdResolved}
      repoChoices={repoChoices}
      executionScope={executionScope}
      initialPipelineId={initialPipelineId}
      onClose={onClose}
      onRun={handleRun}
      isRunning={isRunning}
      runError={runError}
      onClearError={onClearError}
      watcherRecipientGroups={watcherRecipientGroups}
      onWatcherSelectionChange={onWatcherSelectionChange}
    />
  );
}

interface WorkflowsRunPipelineModalProps {
  /** The selected task, offered as **Current task** when it can run the pipeline. */
  currentTarget?: { projectId: string; worktreeId: string };
  initialPipelineId?: string;
  onClose: () => void;
  onRun: (
    pipeline: PipelineData,
    inputs: Record<string, string>,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
    destination: PipelineRunDestination,
    /** Where the run executes, apart from where it goes (CAN-6187). */
    runOn: PipelineRunOn,
  ) => Promise<void>;
  isRunning?: boolean;
  runError?: string | null;
  onClearError?: () => void;
  /** Changing it re-reads the pipelines and their saved owners. */
  reloadToken?: number;
  watcherRecipientGroups?: WatcherRecipientGroup[];
  onWatcherSelectionChange?: (
    selection: PipelineWatcherSelection | null,
  ) => void;
}

/**
 * Workflows' Run dialog (CAN-4542): opens without a selected task, runs a
 * global pipeline with no project, and asks who owns a run of a pipeline
 * with no saved owner.
 */
export function WorkflowsRunPipelineModal({
  currentTarget,
  initialPipelineId,
  onClose,
  onRun,
  isRunning = false,
  runError = null,
  onClearError,
  reloadToken,
  watcherRecipientGroups,
  onWatcherSelectionChange,
}: WorkflowsRunPipelineModalProps): JSX.Element {
  const title = useEarlyAccessTitle('Run pipeline');
  const { cwd, cwdResolved, repoChoices } = usePipelineWorktreeContext(
    currentTarget?.projectId,
    currentTarget?.worktreeId,
  );
  const taskScope: PipelineExecutionScope | undefined =
    currentTarget === undefined
      ? undefined
      : isCoworkChatTarget(currentTarget.projectId) || !cwd
        ? 'directory'
        : 'worktree';
  const executionScopes = useMemo(
    (): readonly PipelineExecutionScope[] =>
      taskScope === undefined ? ['global'] : ['global', taskScope],
    [taskScope],
  );
  const choices = usePipelineRunOwnerChoices();
  const selection = usePipelineRunOwnerSelection(choices);
  // Retry after a pipeline's owner couldn't be read reads it again.
  const [ownerReread, setOwnerReread] = useState(0);
  const rereadPipeline = useCallback((): void => {
    setOwnerReread((current) => current + 1);
  }, []);
  const [chosenLocation, setChosenLocation] = useState<{
    pipelineId: string;
    location: PipelineRunLocation;
  } | null>(null);

  // CAN-6187: "Run on" shows only while this computer's web core reports
  // cloud runs available, and remembers the last choice per workflow.
  const cloudRuns = usePipelineCloudRuns();
  const [chosenRunOn, setChosenRunOn] = useState<{
    pipelineId: string;
    runOn: PipelineRunOn;
  } | null>(null);
  const runOnFor = useCallback(
    (
      pipeline: PipelineData,
    ): { value: PipelineRunOn; unavailable?: string } => {
      if (cloudRuns.pipelineCloudRuns !== true) return { value: 'local' };
      const unavailable = cloudRunSourceUnavailable(pipeline);
      if (unavailable !== undefined) return { value: 'local', unavailable };
      return {
        value:
          chosenRunOn?.pipelineId === pipeline.info.id
            ? chosenRunOn.runOn
            : (loadPipelineRunOn(pipeline.info.id) ?? 'local'),
      };
    },
    [chosenRunOn, cloudRuns.pipelineCloudRuns],
  );

  const resolve = useCallback(
    (pipeline: PipelineData): ResolvedRunContext =>
      resolveWorkflowsRunContext({
        pipeline,
        taskScope,
        chosenLocation:
          chosenLocation?.pipelineId === pipeline.info.id
            ? chosenLocation.location
            : undefined,
        choices,
        selection,
        rereadPipeline,
      }),
    [choices, chosenLocation, rereadPipeline, selection, taskScope],
  );

  const runContextReview = useCallback(
    (pipeline: PipelineData): PipelineRunContextReview => {
      const context = resolve(pipeline);
      const global = context.location === 'global';
      const runOn = runOnFor(pipeline);
      const cloud = runOn.value === 'cloud';
      // Cloud runs start with no project only, for now (CP-36, CP-29).
      const cloudBlockedReason =
        cloud && !global
          ? PIPELINE_RUN_CONTEXT_COPY.cloudDestinationUnavailable
          : undefined;
      return {
        fields: (
          <PipelineRunContextFields
            disabled={isRunning}
            runOn={{
              capabilities: cloudRuns,
              value: runOn.value,
              onChange: (value: PipelineRunOn): void => {
                setChosenRunOn({ pipelineId: pipeline.info.id, runOn: value });
                savePipelineRunOn(pipeline.info.id, value);
                onClearError?.();
              },
              ...(runOn.unavailable !== undefined
                ? { cloudUnavailableReason: runOn.unavailable }
                : {}),
              ...(cloudBlockedReason !== undefined
                ? { cloudBlockedReason }
                : {}),
            }}
            {...(context.showLocation
              ? {
                  location: {
                    value: context.location,
                    currentTaskUnavailable: context.currentTaskUnavailable,
                    onChange: (location: PipelineRunLocation): void => {
                      setChosenLocation({
                        pipelineId: pipeline.info.id,
                        location,
                      });
                      onClearError?.();
                    },
                  },
                }
              : {})}
            {...(context.owner ? { owner: context.owner } : {})}
          />
        ),
        // A task-only pipeline keeps today's Run; anything with a choice or
        // an owner to confirm is reviewed first.
        needsReview:
          global ||
          context.showLocation ||
          cloudRuns.pipelineCloudRuns === true,
        runBlocked: context.runBlocked || cloudBlockedReason !== undefined,
        ...(context.blockedReason !== undefined
          ? { blockedReason: context.blockedReason }
          : {}),
        // Repository, watcher and model choices apply to a run on this
        // computer; a cloud run takes its models from the cloud preflight.
        targeted: !global && !cloud,
        executesElsewhere: cloud,
      };
    },
    [cloudRuns, isRunning, onClearError, resolve, runOnFor],
  );

  const handleRun = async (
    _pipelineId: string,
    pipeline: PipelineData,
    inputs: Record<string, string> | undefined,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
  ): Promise<void> => {
    const context = resolve(pipeline);
    if (context.runBlocked) return;
    const runOn = runOnFor(pipeline).value;
    if (runOn === 'cloud' && context.location !== 'global') return;
    let destination: PipelineRunDestination;
    if (context.location === 'current-task') {
      if (!currentTarget) return;
      destination = { kind: 'current-task', ...currentTarget };
    } else {
      const owner = context.ownerValue ?? '';
      destination = {
        kind: 'global',
        owner,
        ...(context.requestedOwner !== undefined
          ? { requestedOwner: context.requestedOwner }
          : {}),
        ownerLabel:
          choices.status === 'ready' ? choices.labelFor(owner) : owner,
        outsideNavigation:
          choices.status === 'ready' &&
          choices.navigationOwner !== null &&
          choices.navigationOwner !== owner,
      };
    }
    await onRun(
      pipeline,
      inputs ?? {},
      selectedRepoId,
      pluginCollectionContext,
      destination,
      runOn,
    );
  };

  return (
    <PipelineTriggerModal
      triggerType="dispatch"
      labels={{
        title,
        selectSubtitle: 'Select a pipeline to run',
        emptyMessage: 'No pipelines available for this context.',
      }}
      cwd={cwd}
      contextPending={!cwdResolved}
      repoChoices={repoChoices}
      executionScopes={executionScopes}
      runContextReview={runContextReview}
      reloadToken={(reloadToken ?? 0) + ownerReread}
      initialPipelineId={initialPipelineId}
      onClose={onClose}
      onRun={handleRun}
      isRunning={isRunning}
      runError={runError}
      onClearError={onClearError}
      runLoadingLabel="Starting…"
      watcherRecipientGroups={watcherRecipientGroups}
      onWatcherSelectionChange={onWatcherSelectionChange}
    />
  );
}
