import type {
  CloudModelChoice,
  CloudModelPreflightResult,
} from '@canopy/protocol/canopy-core';

/**
 * Where a manual run executes (CAN-6187, decision P6), on `pipelines:execute`
 * and `portal.pipeline.run`. It is its own field, apart from the run's
 * destination (no project, a task or a project) and from a run chat.
 */
export interface PipelineRunLocationRequest {
  /**
   * The execution target. Absent runs on this computer;
   * `CLOUD_PIPELINE_RUN_TARGET_ID` starts the run in the cloud through the
   * web core. Main refuses any other value rather than run it here.
   */
  targetId?: string;
  /**
   * The cloud models the user confirmed for the model preflight they were
   * shown, with its definition hash and policy fingerprint.
   */
  cloudModelChoices?: {
    definitionHash: string;
    policyFingerprint: string;
    choices: CloudModelChoice[];
  };
  /**
   * The cloud start's idempotency key, kept by the Run dialog for one launch
   * and sent again after an uncertain outcome, so a retry never records a
   * second run. Main makes one when it is absent.
   */
  cloudIdempotencyKey?: string;
}

/** Why main didn't start a cloud run, besides unconfirmed models. */
export type CloudPipelineRunRefusalCode =
  /** Not signed in, the web core is unreachable, or cloud runs are off. */
  | 'cloud_unavailable'
  /** A `targetId` this computer can't place runs on. */
  | 'cloud_target_unavailable'
  /** Cloud runs start with no project only, for now. */
  | 'cloud_destination_unavailable'
  /** Only shared and curated workflows run in the cloud, for now. */
  | 'cloud_source_unavailable'
  /** The run needs an owner: Personal or an organization. */
  | 'cloud_owner_required'
  /** The cloud refused steps of the workflow, or the start itself. */
  | 'cloud_run_refused'
  /**
   * The start may have been recorded (a lost answer, a deadline, an internal
   * error); retrying with the same idempotency key never starts it twice.
   */
  | 'cloud_start_uncertain';

/** The cloud run a start recorded in the web core. */
export interface CloudPipelineRunStarted {
  /** The web core's `core.pipeline.run` operation. */
  operationId: string;
  /** `waiting` while the owner's admitted runs are at their cap. */
  admission: 'waiting' | 'admitted' | 'released';
  statusReason: string | null;
  replayed: boolean;
}

/** What `pipelines:execute` answers for a run with a cloud `targetId`. */
export type CloudPipelineRunStartResult =
  | { success: true; cloudRun: CloudPipelineRunStarted }
  | {
      success: false;
      error: string;
      /** Model steps need a cloud model the user confirms first. */
      errorCode: 'cloud_models_unconfirmed';
      cloudModels: CloudModelPreflightResult;
    }
  | { success: false; error: string; errorCode: CloudPipelineRunRefusalCode };

/**
 * `pipelines:cloud-runs-availability`: this computer's web core manifest
 * through `pipelineCloudRunsFromManifest`, the CAN-6085 capability axis.
 */
export interface PipelineCloudRunsAvailability {
  pipelineCloudRuns: boolean;
}
