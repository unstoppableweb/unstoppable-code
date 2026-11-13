import { useCallback, useRef, useState, type JSX } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { CloudModelReplacementDialog } from '@canopy/ui-app';
import type { PipelineRunOn } from '@canopy/ui-app/workflows';
import type {
  CloudModelChoice,
  CloudModelPreflightResult,
} from '@canopy/protocol/canopy-core';
import { CLOUD_PIPELINE_RUN_TARGET_ID } from '@canopy/protocol/canopy-core/core/pipeline/cloud-runs';
import type { CloudPipelineRunStarted } from '@canopy/desktop-shared/types/pipeline-cloud-runs';
import {
  PIPELINE_NOW_OWNED_ERROR_CODE,
  type PipelineData,
  type PipelineExecutionStartResult,
} from '@canopy/execution-engine/types/pipeline';
import { WORKFLOW_RUN_STARTED_TOAST } from '@canopy/ui-app/workflows';
import { extractIpcErrorMessage } from '@/lib/errors';
import { useGitHubStore } from '@/stores/githubStore';
import {
  DispatchPipelineModal,
  WorkflowsRunPipelineModal,
  type DispatchPipelinePluginCollectionContext,
  type PipelineRunDestination,
} from './DispatchPipelineModal';
import { usePipelineRunWatcher } from './usePipelineRunWatcher';
import { cloudRunPipelineId } from './pipelineRunOn';

export interface DispatchPipelineTarget {
  projectId: string;
  worktreeId: string;
  /**
   * Preselects this pipeline in the modal's select step (CAN-2361 PR2b:
   * share-landing "Try now"). Preselect only — Run stays an explicit click.
   */
  initialPipelineId?: string;
}

/** Workflows' Run, which needs no selected task (CAN-4542). */
export interface WorkflowsRunOptions {
  initialPipelineId?: string;
  /** Opens on that pipeline's run settings, as its editor's Run does. */
  startOnSettings?: boolean;
  /** The selected task, offered as **Current task**. */
  currentTarget?: { projectId: string; worktreeId: string };
}

interface DispatchPipelineModalController {
  openDispatchPipelineModal: (target: DispatchPipelineTarget) => void;
  openWorkflowsRunModal: (options?: WorkflowsRunOptions) => void;
  dispatchPipelineModal: JSX.Element | null;
}

export const PIPELINE_STARTED_TOAST = WORKFLOW_RUN_STARTED_TOAST;

export function pipelineStartedToast(
  destination: PipelineRunDestination | undefined,
): string {
  return destination?.kind === 'global' && destination.outsideNavigation
    ? `Pipeline started. Find it in ${destination.ownerLabel} › Workflows › Runs.`
    : PIPELINE_STARTED_TOAST;
}

/** The started toast of a cloud run (CAN-6187). */
function cloudRunStartedToast(run: CloudPipelineRunStarted): string {
  return run.admission === 'waiting'
    ? 'Pipeline queued in the cloud. It starts when one of your other cloud runs ends.'
    : 'Pipeline started in the cloud.';
}

/** A cloud run waiting on the user's cloud model choices (CAN-6174). */
interface PendingCloudModels {
  pipeline: PipelineData;
  inputs: Record<string, string>;
  destination: Extract<PipelineRunDestination, { kind: 'global' }>;
  preflight: CloudModelPreflightResult;
  error: string | null;
}

export function useDispatchPipelineModal(): DispatchPipelineModalController {
  const [target, setTarget] = useState<DispatchPipelineTarget | null>(null);
  const [workflowsRun, setWorkflowsRun] = useState<WorkflowsRunOptions | null>(
    null,
  );
  const [dispatchRunning, setDispatchRunning] = useState(false);
  const [dispatchRunError, setDispatchRunError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [cloudModels, setCloudModels] = useState<PendingCloudModels | null>(
    null,
  );
  // One idempotency key per cloud launch (workflow, inputs and owner), and
  // the cloud models confirmed for it, kept until the launch is settled so a
  // retry resends the same start (CAN-6187).
  const cloudLaunch = useRef<{
    request: string;
    key: string;
    confirmed?: {
      preflight: CloudModelPreflightResult;
      choices: CloudModelChoice[];
    };
    /** A start went out and may have been recorded: resend it unchanged. */
    unsettled?: true;
  } | null>(null);
  const watcher = usePipelineRunWatcher(
    target ?? workflowsRun?.currentTarget ?? null,
  );

  const closeDispatchModal = useCallback((): void => {
    if (dispatchRunning) return;
    setTarget(null);
    setWorkflowsRun(null);
    setCloudModels(null);
    setDispatchRunError(null);
    watcher.reset();
  }, [dispatchRunning, watcher]);

  const openDispatchPipelineModal = useCallback(
    (nextTarget: DispatchPipelineTarget): void => {
      setWorkflowsRun(null);
      setTarget(nextTarget);
      setDispatchRunError(null);
    },
    [],
  );

  const openWorkflowsRunModal = useCallback(
    (options: WorkflowsRunOptions = {}): void => {
      setTarget(null);
      setWorkflowsRun(options);
      setDispatchRunError(null);
    },
    [],
  );

  const clearDispatchError = useCallback((): void => {
    setDispatchRunError(null);
  }, []);

  /**
   * Starts a run in the cloud through main (CAN-6187): the model preflight
   * first, so model steps that need a cloud model ask before anything runs.
   * It never falls back to this computer.
   */
  const startCloudRun = useCallback(
    async (
      pipeline: PipelineData,
      inputs: Record<string, string>,
      destination: Extract<PipelineRunDestination, { kind: 'global' }>,
      confirmed?: {
        preflight: CloudModelPreflightResult;
        choices: CloudModelChoice[];
      },
    ): Promise<void> => {
      setDispatchRunning(true);
      setDispatchRunError(null);
      const fail = (message: string): void => {
        if (confirmed)
          setCloudModels((current) =>
            current ? { ...current, error: message } : current,
          );
        else setDispatchRunError(message);
      };
      const pipelineId = cloudRunPipelineId(pipeline) ?? pipeline.info.id;
      const request = JSON.stringify([pipelineId, inputs, destination.owner]);
      if (cloudLaunch.current?.request !== request)
        cloudLaunch.current = { request, key: crypto.randomUUID() };
      // Choices confirmed after a refusal that recorded nothing replace any
      // earlier ones. Once a start may have been recorded, the retry resends
      // exactly that start until the launch is settled.
      if (confirmed && cloudLaunch.current.unsettled !== true)
        cloudLaunch.current.confirmed = confirmed;
      const launch = cloudLaunch.current;
      const sent = launch.confirmed;
      try {
        const result = await window.pipelines.execute(pipeline.content, {
          pipelineId,
          scope: 'global',
          target: { scope: 'global' },
          eventName: 'dispatch',
          inputs,
          requestedOwner: destination.owner,
          targetId: CLOUD_PIPELINE_RUN_TARGET_ID,
          cloudIdempotencyKey: launch.key,
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
          ...(sent
            ? {
                cloudModelChoices: {
                  definitionHash: sent.preflight.definitionHash,
                  policyFingerprint: sent.preflight.policyFingerprint,
                  choices: sent.choices,
                },
              }
            : {}),
        });
        // The key goes only once the launch is settled: started, or refused
        // while no earlier start of it may have been recorded. An uncertain
        // start, an unreachable cloud, or any refusal of a retry after an
        // uncertain start (it may come before the web core reads its
        // receipts) keeps it. Unconfirmed models are handled below: that
        // refusal comes after the receipts were read.
        if (
          result.success ||
          (result.errorCode !== 'cloud_start_uncertain' &&
            result.errorCode !== 'cloud_unavailable' &&
            result.errorCode !== 'cloud_models_unconfirmed' &&
            launch.unsettled !== true)
        )
          cloudLaunch.current = null;
        else if (result.errorCode === 'cloud_start_uncertain') {
          launch.unsettled = true;
          // Retry from the Run dialog, which resends the same start.
          setCloudModels(null);
          setDispatchRunError(result.error);
          return;
        }
        if (result.success) {
          watcher.reset();
          setCloudModels(null);
          setWorkflowsRun(null);
          useGitHubStore
            .getState()
            .addToast(
              cloudRunStartedToast(result.cloudRun),
              'success',
              undefined,
              {
                category: 'Pipeline',
              },
            );
          return;
        }
        if (result.errorCode === 'cloud_models_unconfirmed') {
          // Refused before anything was recorded: the next choices replace
          // these, under the same key.
          cloudLaunch.current = { request, key: launch.key };
          setCloudModels({
            pipeline,
            inputs,
            destination,
            preflight: result.cloudModels,
            // A second ask means the earlier choices no longer apply.
            error: confirmed ? result.error : null,
          });
          return;
        }
        fail(result.error);
      } catch (error: unknown) {
        reportClientAppError(error);
        // Main may have sent the start before the answer was lost: as for
        // an uncertain start, retry from the Run dialog with the same start.
        launch.unsettled = true;
        setCloudModels(null);
        setDispatchRunError(extractIpcErrorMessage(error));
      } finally {
        setDispatchRunning(false);
      }
    },
    [watcher],
  );

  const handleDispatchRun = useCallback(
    async (
      pipeline: PipelineData,
      inputs: Record<string, string>,
      selectedRepoId: string | undefined,
      pluginCollectionContext: DispatchPipelinePluginCollectionContext,
      destination?: PipelineRunDestination,
    ): Promise<void> => {
      if (destination?.kind === 'global') {
        setDispatchRunError(null);
        await startGlobalRun(pipeline, inputs, pluginCollectionContext, {
          requestedOwner: destination.requestedOwner,
          onStarted: () => {
            watcher.reset();
            setWorkflowsRun(null);
            useGitHubStore
              .getState()
              .addToast(
                pipelineStartedToast(destination),
                'success',
                undefined,
                {
                  category: 'Pipeline',
                },
              );
          },
          setRunning: setDispatchRunning,
          setError: (message, errorCode) => {
            setDispatchRunError(message);
            // A pipeline that gained an owner is re-read to show it.
            if (errorCode === PIPELINE_NOW_OWNED_ERROR_CODE)
              setReloadToken((current) => current + 1);
          },
        });
        return;
      }
      const taskTarget =
        destination?.kind === 'current-task' ? destination : target;
      if (!taskTarget) {
        setDispatchRunError('No worktree is selected');
        return;
      }

      setDispatchRunning(true);
      setDispatchRunError(null);

      let cwd: string;
      try {
        cwd = await window.api.getWorktreePath({
          projectId: taskTarget.projectId,
          worktreeId: taskTarget.worktreeId,
          repoId: selectedRepoId,
        });
      } catch (error: unknown) {
        setDispatchRunning(false);
        setDispatchRunError(
          error instanceof Error
            ? error.message
            : 'Failed to resolve worktree path',
        );
        return;
      }

      try {
        const appAdvisorPipelineWatchers = watcher.appAdvisorPipelineWatchers();
        const result = await window.pipelines.execute(pipeline.content, {
          cwd,
          pipelineId: pipeline.info.id,
          pipelineFilePath:
            pipeline.info.source === 'project'
              ? pipeline.info.filePath
              : undefined,
          repoPath: pipeline.info.source === 'project' ? cwd : undefined,
          projectId: taskTarget.projectId,
          worktreeId: taskTarget.worktreeId,
          eventName: 'dispatch',
          inputs,
          pluginCollectionPreferences: pluginCollectionContext.preferences,
          ...(pluginCollectionContext.modelAliasPreferences
            ? {
                modelAliasPreferences:
                  pluginCollectionContext.modelAliasPreferences,
              }
            : {}),
          modelConfig: pluginCollectionContext.modelConfig,
          ...(appAdvisorPipelineWatchers ? { appAdvisorPipelineWatchers } : {}),
          ...(pluginCollectionContext.pipelinePreferenceLocator
            ? {
                pipelinePreferenceLocator:
                  pluginCollectionContext.pipelinePreferenceLocator,
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
          setDispatchRunError(result.error ?? 'Workflow execution failed');
          return;
        }

        watcher.reset();
        if (destination !== undefined) {
          useGitHubStore
            .getState()
            .addToast(pipelineStartedToast(destination), 'success', undefined, {
              category: 'Pipeline',
            });
        }
        setTarget(null);
        setWorkflowsRun(null);
        setDispatchRunError(null);
      } catch (error: unknown) {
        setDispatchRunError(extractIpcErrorMessage(error));
      } finally {
        setDispatchRunning(false);
      }
    },
    [target, watcher],
  );

  /** Workflows' Run: where the run executes picks the start (CAN-6187). */
  const handleWorkflowsRun = useCallback(
    async (
      pipeline: PipelineData,
      inputs: Record<string, string>,
      selectedRepoId: string | undefined,
      pluginCollectionContext: DispatchPipelinePluginCollectionContext,
      destination: PipelineRunDestination,
      runOn: PipelineRunOn,
    ): Promise<void> => {
      if (runOn === 'local') {
        await handleDispatchRun(
          pipeline,
          inputs,
          selectedRepoId,
          pluginCollectionContext,
          destination,
        );
        return;
      }
      // The dialog offers Cloud with no project only, for now.
      if (destination.kind === 'global')
        await startCloudRun(pipeline, inputs, destination);
    },
    [handleDispatchRun, startCloudRun],
  );

  const cloudModelsDialog = cloudModels ? (
    <CloudModelReplacementDialog
      key={
        cloudModels.preflight.definitionHash +
        cloudModels.preflight.policyFingerprint
      }
      preflight={cloudModels.preflight}
      busy={dispatchRunning}
      error={cloudModels.error}
      onCancel={() => setCloudModels(null)}
      onConfirm={(choices) =>
        void startCloudRun(
          cloudModels.pipeline,
          cloudModels.inputs,
          cloudModels.destination,
          { preflight: cloudModels.preflight, choices },
        )
      }
    />
  ) : null;

  const runDialog = workflowsRun ? (
    <WorkflowsRunPipelineModal
      currentTarget={workflowsRun.currentTarget}
      initialPipelineId={workflowsRun.initialPipelineId}
      startOnSettings={workflowsRun.startOnSettings}
      onClose={closeDispatchModal}
      onRun={handleWorkflowsRun}
      isRunning={dispatchRunning}
      runError={dispatchRunError}
      onClearError={clearDispatchError}
      reloadToken={reloadToken}
      watcherRecipientGroups={watcher.recipientGroups}
      onWatcherSelectionChange={watcher.onWatcherSelectionChange}
    />
  ) : target ? (
    <DispatchPipelineModal
      projectId={target.projectId}
      worktreeId={target.worktreeId}
      initialPipelineId={target.initialPipelineId}
      onClose={closeDispatchModal}
      onRun={handleDispatchRun}
      isRunning={dispatchRunning}
      runError={dispatchRunError}
      onClearError={clearDispatchError}
      watcherRecipientGroups={watcher.recipientGroups}
      onWatcherSelectionChange={watcher.onWatcherSelectionChange}
    />
  ) : null;

  const dispatchPipelineModal =
    runDialog === null ? null : (
      <>
        {runDialog}
        {cloudModelsDialog}
      </>
    );

  return {
    openDispatchPipelineModal,
    openWorkflowsRunModal,
    dispatchPipelineModal,
  };
}

type StartErrorCode = Extract<
  PipelineExecutionStartResult,
  { success: false }
>['errorCode'];

/**
 * Starts a run with no project. Main supplies its scratch folder, so no
 * working directory, project, task, or repository goes with it, and no
 * completion watcher: global runs have none yet.
 */
async function startGlobalRun(
  pipeline: PipelineData,
  inputs: Record<string, string>,
  pluginCollectionContext: DispatchPipelinePluginCollectionContext,
  handlers: {
    requestedOwner: string | undefined;
    onStarted: () => void;
    setRunning: (running: boolean) => void;
    setError: (message: string, errorCode?: StartErrorCode) => void;
  },
): Promise<void> {
  handlers.setRunning(true);
  try {
    const result = await window.pipelines.execute(pipeline.content, {
      pipelineId: pipeline.info.id,
      scope: 'global',
      target: { scope: 'global' },
      eventName: 'dispatch',
      inputs,
      ...(handlers.requestedOwner !== undefined
        ? { requestedOwner: handlers.requestedOwner }
        : {}),
      pluginCollectionPreferences: pluginCollectionContext.preferences,
      ...(pluginCollectionContext.modelAliasPreferences
        ? {
            modelAliasPreferences:
              pluginCollectionContext.modelAliasPreferences,
          }
        : {}),
      modelConfig: pluginCollectionContext.modelConfig,
      ...(pluginCollectionContext.pipelinePreferenceLocator
        ? {
            pipelinePreferenceLocator:
              pluginCollectionContext.pipelinePreferenceLocator,
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
      handlers.setError(
        result.error ?? 'Pipeline execution failed',
        result.errorCode,
      );
      return;
    }
    handlers.onStarted();
  } catch (error: unknown) {
    handlers.setError(extractIpcErrorMessage(error));
  } finally {
    handlers.setRunning(false);
  }
}
