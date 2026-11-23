import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { CloudModelReplacementDialog } from '@canopy/ui-app';
import {
  CloudRunCheckoutDialog,
  type PipelineRunOn,
} from '@canopy/ui-app/workflows';
import type {
  CloudModelChoice,
  CloudModelPreflightResult,
} from '@canopy/protocol/canopy-core';
import { CLOUD_PIPELINE_RUN_TARGET_ID } from '@canopy/protocol/canopy-core/core/pipeline/cloud-runs';
import type {
  CloudPipelineRunCheckoutConfirmation,
  CloudPipelineRunCheckoutState,
  CloudPipelineRunStarted,
  CloudPipelineRunStartResult,
} from '@canopy/desktop-shared/types/pipeline-cloud-runs';
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

/**
 * A start sent from a Run dialog that has since closed may have been
 * recorded (CAN-6869): its launch stays, so running it again resends it.
 */
const CLOUD_RUN_MAYBE_STARTED_TOAST =
  'The cloud run may have started. Check Workflows › Runs before you run it again.';

/** Shown once the wait for a task's cloud worktree runs out (CAN-6869). */
const CLOUD_WORKTREE_STILL_PREPARING =
  'The cloud worktree is still being set up. Run again to keep waiting.';

/** How long a task's cloud run waits before asking again while its cloud worktree is set up. */
const CLOUD_WORKTREE_PREPARING_RETRY_MS = 10_000;
/** About five minutes of setup before the dialog stops asking. */
const CLOUD_WORKTREE_PREPARING_ATTEMPTS = 30;

/** One cloud launch: where it goes, and a task's repository (CAN-6869). */
interface CloudLaunchTarget {
  pipeline: PipelineData;
  inputs: Record<string, string>;
  destination: PipelineRunDestination;
  selectedRepoId: string | undefined;
}

/** A cloud run waiting on the user's cloud model choices (CAN-6174). */
interface PendingCloudModels extends CloudLaunchTarget {
  preflight: CloudModelPreflightResult;
  error: string | null;
}

/**
 * A task's cloud run waiting on the person's word about what isn't on
 * GitHub (CAN-6869): nothing is pushed until they confirm.
 */
interface PendingCloudCheckout extends CloudLaunchTarget {
  state: CloudPipelineRunCheckoutState;
  error: string | null;
  /** `error` is main's `cloud_unavailable` refusal (signed out), not a failure. */
  errorRefused: boolean;
}

/** Who owns a cloud run: its owner with no project, or a task's chosen one. */
function cloudRunOwner(destination: PipelineRunDestination): string {
  return destination.kind === 'global'
    ? destination.owner
    : (destination.cloudOwner ?? '');
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * One idempotency key per cloud launch (workflow, inputs and owner), and the
 * cloud models confirmed for it, kept until the launch is settled so a retry
 * resends the same start (CAN-6187).
 */
interface CloudLaunch {
  request: string;
  key: string;
  confirmed?: {
    preflight: CloudModelPreflightResult;
    choices: CloudModelChoice[];
  };
  /** A start went out and may have been recorded: resend it unchanged. */
  unsettled?: true;
  /**
   * A send of it started the run: its key is spent, and a late answer of an
   * earlier send never brings the launch back (CAN-6869).
   */
  started?: true;
  /**
   * Sends of this launch still out (CAN-6869). A Run dialog closed meanwhile
   * keeps the launch, since any of them may record the run.
   */
  sending?: number;
  /**
   * The repository, branch and head the person confirmed the push warning
   * for (CAN-6869): every later send of this launch carries them, so a model
   * choice after it doesn't ask again while the task still stands there.
   */
  checkout?: CloudPipelineRunCheckoutConfirmation;
}

/**
 * The cloud launch in progress, shared by every Run dialog host and kept
 * across their remounts: a start that may have been recorded is resent
 * under its key from whichever dialog runs it next (CAN-6869).
 */
const sharedCloudLaunch: { current: CloudLaunch | null } = { current: null };

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
  const [cloudCheckout, setCloudCheckout] =
    useState<PendingCloudCheckout | null>(null);
  // Bumped when the dialog closes, so a start waiting for its cloud
  // worktree stops asking (CAN-6869).
  const cloudLaunchGeneration = useRef(0);
  // A start is only waiting for its cloud worktree (CAN-6869): the Run
  // dialog may close, which stops the waiting, and Run can't start another.
  const cloudPreparing = useRef(false);
  const [cloudPreparingShown, setCloudPreparingShown] = useState(false);
  const cloudLaunch = sharedCloudLaunch;
  const watcher = usePipelineRunWatcher(
    target ?? workflowsRun?.currentTarget ?? null,
  );

  // The launch this host started last, which its unmount may let go of.
  const ownLaunch = useRef<CloudLaunch | null>(null);
  // A host that unmounts (navigating away) stops waiting as closing does: no
  // further start goes out with no dialog to show or cancel it. Its launch
  // stays while a send of it may yet be recorded (CAN-6869).
  useEffect(() => {
    const generation = cloudLaunchGeneration;
    const preparing = cloudPreparing;
    const own = ownLaunch;
    return (): void => {
      generation.current += 1;
      preparing.current = false;
      const launch = own.current;
      if (
        launch !== null &&
        sharedCloudLaunch.current === launch &&
        launch.unsettled !== true &&
        (launch.sending ?? 0) === 0
      )
        sharedCloudLaunch.current = null;
    };
  }, []);

  const closeDispatchModal = useCallback((): void => {
    if (dispatchRunning && !cloudPreparing.current) return;
    setTarget(null);
    setWorkflowsRun(null);
    setCloudModels(null);
    setCloudCheckout(null);
    setDispatchRunError(null);
    cloudLaunchGeneration.current += 1;
    // A launch with a send still out may yet be recorded: it stays, so the
    // same workflow run again reuses its key.
    if (
      cloudLaunch.current?.unsettled !== true &&
      (cloudLaunch.current?.sending ?? 0) === 0
    )
      cloudLaunch.current = null;
    // A start waiting for its cloud worktree stops here.
    cloudPreparing.current = false;
    setCloudPreparingShown(false);
    setDispatchRunning(false);
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
   * It never falls back to this computer. A task's run (CAN-6869) goes at
   * its pushed branch: main asks first about what isn't on GitHub, pushes
   * only once the person confirms, and the start waits while its cloud
   * worktree is set up.
   */
  const startCloudRun = useCallback(
    async (
      launchTarget: CloudLaunchTarget,
      confirmed?: {
        models?: {
          preflight: CloudModelPreflightResult;
          choices: CloudModelChoice[];
        };
        /** What the person confirmed the push warning for. */
        checkout?: CloudPipelineRunCheckoutConfirmation;
      },
    ): Promise<void> => {
      const { pipeline, inputs, destination, selectedRepoId } = launchTarget;
      // One launch waits at a time; Run stays off meanwhile.
      if (cloudPreparing.current) return;
      setDispatchRunning(true);
      setDispatchRunError(null);
      // A retry from the push dialog clears its error, so a failure with the
      // same text is sighted again.
      if (confirmed?.checkout !== undefined)
        setCloudCheckout((current) =>
          current ? { ...current, error: null, errorRefused: false } : current,
        );
      // Once a wait for the cloud worktree closed the confirmations, every
      // later answer belongs to the Run dialog, which is what's showing.
      let confirmationsClosed = false;
      // `refused` marks an expected refusal the checkout dialog must not
      // record as a failure.
      const fail = (message: string, refused = false): void => {
        if (confirmationsClosed) setDispatchRunError(message);
        else if (confirmed?.models)
          setCloudModels((current) =>
            current ? { ...current, error: message } : current,
          );
        else if (confirmed?.checkout !== undefined)
          setCloudCheckout((current) =>
            current
              ? { ...current, error: message, errorRefused: refused }
              : current,
          );
        else setDispatchRunError(message);
      };
      const pipelineId = cloudRunPipelineId(pipeline) ?? pipeline.info.id;
      const owner = cloudRunOwner(destination);
      const task =
        destination.kind === 'current-task'
          ? {
              projectId: destination.projectId,
              worktreeId: destination.worktreeId,
              ...(selectedRepoId === undefined
                ? {}
                : { cloudRepoId: selectedRepoId }),
            }
          : null;
      const request = JSON.stringify([pipelineId, inputs, owner, task]);
      if (
        cloudLaunch.current?.request !== request ||
        cloudLaunch.current.started === true
      )
        cloudLaunch.current = { request, key: crypto.randomUUID() };
      ownLaunch.current = cloudLaunch.current;
      // Choices confirmed after a refusal that recorded nothing replace any
      // earlier ones. Once a start may have been recorded, the retry resends
      // exactly that start until the launch is settled.
      if (confirmed?.models && cloudLaunch.current.unsettled !== true)
        cloudLaunch.current.confirmed = confirmed.models;
      if (confirmed?.checkout !== undefined)
        cloudLaunch.current.checkout = confirmed.checkout;
      const launch = cloudLaunch.current;
      const checkout = launch.checkout;
      const sent = launch.confirmed;
      const generation = cloudLaunchGeneration.current;
      // The dialog closed while a start that may have been recorded was
      // out: the launch keeps its key, so running the same workflow again
      // resends that start instead of recording a second one.
      const keepAfterClose = (): void => {
        // Already started by another send: nothing to keep or tell.
        if (launch.started === true) return;
        launch.unsettled = true;
        if (cloudLaunch.current === null) cloudLaunch.current = launch;
        useGitHubStore
          .getState()
          .addToast(CLOUD_RUN_MAYBE_STARTED_TOAST, 'warning', undefined, {
            category: 'Pipeline',
            // Not a failure: the start's outcome is unknown, so it stays
            // until the person has seen it, and shows even with in-app
            // notifications off, as the answer to their own Cancel.
            persistent: true,
            forceInApp: true,
          });
      };
      try {
        const sendOnce = (): Promise<CloudPipelineRunStartResult> =>
          window.pipelines.execute(pipeline.content, {
            pipelineId,
            // A task's folder is main's to resolve, from its ids (CAN-6869).
            ...(task === null
              ? { scope: 'global', target: { scope: 'global' } }
              : { scope: 'worktree', ...task }),
            eventName: 'dispatch',
            inputs,
            requestedOwner: owner,
            targetId: CLOUD_PIPELINE_RUN_TARGET_ID,
            cloudIdempotencyKey: launch.key,
            ...(checkout === undefined
              ? {}
              : { cloudCheckoutConfirmed: checkout }),
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
        // Counted while out, so a dialog closed meanwhile keeps the launch.
        const send = async (): Promise<CloudPipelineRunStartResult> => {
          launch.sending = (launch.sending ?? 0) + 1;
          try {
            return await sendOnce();
          } finally {
            launch.sending = (launch.sending ?? 1) - 1;
          }
        };
        // The Run dialog (or its host) went while a send was out: a run it
        // started is still told, the launch stays while it may be recorded,
        // and a newer launch in the shared slot is never touched.
        const answeredAfterClose = (
          answer: CloudPipelineRunStartResult,
        ): void => {
          // Started: the run is recorded under its key, which is spent.
          // Refused with nothing recorded: spent too, unless an earlier send
          // may be recorded. Either way, not while another send of it is
          // still out.
          if (answer.success) launch.started = true;
          if (
            cloudLaunch.current === launch &&
            (launch.sending ?? 0) === 0 &&
            (answer.success ||
              (answer.errorCode !== 'cloud_start_uncertain' &&
                launch.unsettled !== true))
          )
            cloudLaunch.current = null;
          if (answer.success)
            useGitHubStore
              .getState()
              .addToast(
                cloudRunStartedToast(answer.cloudRun),
                'success',
                undefined,
                { category: 'Pipeline' },
              );
          else if (answer.errorCode === 'cloud_start_uncertain')
            keepAfterClose();
        };
        let result = await send();
        if (cloudLaunchGeneration.current !== generation) {
          answeredAfterClose(result);
          return;
        }
        // A new cloud worktree for the task is being set up: nothing was
        // recorded, so the same start goes again until it is ready, unless
        // the dialog closed meanwhile.
        for (
          let attempt = 1;
          !result.success &&
          result.errorCode === 'cloud_worktree_preparing' &&
          attempt < CLOUD_WORKTREE_PREPARING_ATTEMPTS;
          attempt++
        ) {
          // The confirmations are done with: the wait shows in the Run
          // dialog, which can be closed to stop it.
          cloudPreparing.current = true;
          setCloudPreparingShown(true);
          confirmationsClosed = true;
          setCloudCheckout(null);
          setCloudModels(null);
          setDispatchRunError(result.error);
          await waitFor(CLOUD_WORKTREE_PREPARING_RETRY_MS);
          if (cloudLaunchGeneration.current !== generation) return;
          result = await send();
          // Closed while that send was out: a run it started is still told,
          // and nothing else comes back.
          if (cloudLaunchGeneration.current !== generation) {
            answeredAfterClose(result);
            return;
          }
        }
        // The wait ran out with the worktree still being set up: nothing was
        // recorded, and Run again keeps waiting under the same key.
        if (
          !result.success &&
          result.errorCode === 'cloud_worktree_preparing'
        ) {
          fail(CLOUD_WORKTREE_STILL_PREPARING);
          return;
        }
        // The key goes only once the launch is settled: started, or refused
        // while no earlier start of it may have been recorded. An uncertain
        // start, an unreachable cloud, or any refusal of a retry after an
        // uncertain start (it may come before the web core reads its
        // receipts) keeps it. Unconfirmed models and an unconfirmed push are
        // handled below: those refusals record nothing.
        if (result.success) launch.started = true;
        if (
          result.success ||
          (result.errorCode !== 'cloud_start_uncertain' &&
            result.errorCode !== 'cloud_unavailable' &&
            result.errorCode !== 'cloud_models_unconfirmed' &&
            result.errorCode !== 'cloud_checkout_unconfirmed' &&
            result.errorCode !== 'cloud_worktree_preparing' &&
            launch.unsettled !== true)
        ) {
          // Only this launch: the slot is shared by every Run dialog host.
          if (cloudLaunch.current === launch) cloudLaunch.current = null;
        } else if (
          result.errorCode === 'cloud_start_uncertain' &&
          launch.started !== true
        ) {
          launch.unsettled = true;
          if (cloudLaunch.current === null) cloudLaunch.current = launch;
          // Retry from the Run dialog, which resends the same start.
          setCloudModels(null);
          setCloudCheckout(null);
          setDispatchRunError(result.error);
          return;
        }
        if (result.success) {
          watcher.reset();
          setCloudModels(null);
          setCloudCheckout(null);
          setDispatchRunError(null);
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
        if (result.errorCode === 'cloud_checkout_unconfirmed') {
          // Nothing was pushed or recorded: the person decides first, and a
          // head that moved meanwhile asks again. The launch is kept in
          // place, with any send of it still out, and stays unsettled if an
          // earlier send of it may be recorded.
          delete launch.confirmed;
          delete launch.checkout;
          cloudLaunch.current = launch;
          setCloudModels(null);
          setCloudCheckout({
            ...launchTarget,
            state: result.checkout,
            error: null,
            errorRefused: false,
          });
          return;
        }
        if (result.errorCode === 'cloud_models_unconfirmed') {
          // Refused before anything was recorded: the next choices replace
          // these, under the same key, with the push the person confirmed.
          // The launch is kept in place, with any send of it still out.
          delete launch.unsettled;
          delete launch.confirmed;
          cloudLaunch.current = launch;
          setCloudCheckout(null);
          setCloudModels({
            ...launchTarget,
            preflight: result.cloudModels,
            // A second ask means the earlier choices no longer apply.
            error: confirmed?.models ? result.error : null,
          });
          return;
        }
        // `cloud_unavailable` is main's answer to a signed-out account (or cloud
        // runs being off), an expected refusal rather than a failure.
        fail(result.error, result.errorCode === 'cloud_unavailable');
      } catch (error: unknown) {
        reportClientAppError(error);
        // Main may have sent the start before the answer was lost: as for
        // an uncertain start, retry from the Run dialog with the same start.
        if (cloudLaunchGeneration.current !== generation) {
          keepAfterClose();
          return;
        }
        if (launch.started !== true) {
          launch.unsettled = true;
          if (cloudLaunch.current === null) cloudLaunch.current = launch;
        }
        setCloudModels(null);
        setCloudCheckout(null);
        setDispatchRunError(extractIpcErrorMessage(error));
      } finally {
        if (cloudLaunchGeneration.current === generation) {
          cloudPreparing.current = false;
          setCloudPreparingShown(false);
          setDispatchRunning(false);
        }
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
      // While a cloud launch waits for its worktree, nothing else starts.
      if (cloudPreparing.current) return;
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
      // With no project, or a task's worktree at its pushed branch (CAN-6869).
      await startCloudRun({ pipeline, inputs, destination, selectedRepoId });
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
      onCancel={() => {
        // Nothing of this launch was recorded unless a start was uncertain:
        // the next Run is a new launch, read afresh (CAN-6869).
        if (
          cloudLaunch.current?.unsettled !== true &&
          (cloudLaunch.current?.sending ?? 0) === 0
        )
          cloudLaunch.current = null;
        setCloudModels(null);
      }}
      onConfirm={(choices) =>
        void startCloudRun(cloudModels, {
          models: { preflight: cloudModels.preflight, choices },
        })
      }
    />
  ) : null;

  const cloudCheckoutDialog = cloudCheckout ? (
    <CloudRunCheckoutDialog
      key={cloudCheckout.state.headSha}
      state={cloudCheckout.state}
      busy={dispatchRunning}
      errorMessage={cloudCheckout.error}
      {...(cloudCheckout.errorRefused
        ? { errorRecordingDisabled: true as const }
        : { errorSource: 'cloud-run-checkout' })}
      onCancel={() => {
        if (
          cloudLaunch.current?.unsettled !== true &&
          (cloudLaunch.current?.sending ?? 0) === 0
        )
          cloudLaunch.current = null;
        setCloudCheckout(null);
      }}
      onConfirm={() =>
        void startCloudRun(cloudCheckout, {
          checkout: {
            repository: cloudCheckout.state.repository,
            branch: cloudCheckout.state.branch,
            headSha: cloudCheckout.state.headSha,
          },
        })
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
      // Waiting for a cloud worktree leaves Cancel and close available, and
      // Run and the run settings off.
      isRunning={dispatchRunning && !cloudPreparingShown}
      waiting={cloudPreparingShown}
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
        {cloudCheckoutDialog}
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
