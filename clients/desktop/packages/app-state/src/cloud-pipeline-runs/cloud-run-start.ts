import {
  CLOUD_MODEL_UNCONFIRMED_CODE,
  CLOUD_PIPELINE_RUN_TARGET_ID,
  CloudModelPreflightResultSchema,
  CloudPipelineRunStartResultSchema,
  type CanopyErrorPayload,
  type CloudModelChoice,
  type CloudModelPreflightResult,
  type CloudPipelineRunStartParams,
  type CloudPipelineRunStartResult,
} from '@canopy/protocol/canopy-core';
import {
  CoreCoworkRequestError,
  type CoreCoworkInvoker,
} from '../core-cowork/invoker';
import { requestCloud } from './request';

/**
 * Starting a cloud run from a browser (CAN-6341, plan CP-39), over the
 * host's web core invoker: the same order desktop's main follows for its
 * Run dialog (CAN-6187). The keyed `core.pipeline.execution.start` goes
 * first: the web core answers a resent key with the run it recorded before
 * reading anything, and refuses a run whose model steps have no confirmed
 * cloud model with `cloudModelsUnconfirmed`, recording nothing. Only then is
 * the CAN-6174 model preflight read, so the caller asks for the models
 * before any run starts.
 */

/** What one launch sends; the key stays the same until it is settled. */
export interface CloudPipelineRunLaunch {
  /** `shared:canopy-cloud:<id>` or `curated:<key>`. */
  readonly definitionId: string;
  /** `personal` or `org:<uuid>`. */
  readonly owner: string;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly eventName?: CloudPipelineRunStartParams['eventName'];
  /** The cloud models the user confirmed for the preflight they saw. */
  readonly modelChoices?: {
    readonly preflight: CloudModelPreflightResult;
    readonly choices: readonly CloudModelChoice[];
  };
  readonly idempotencyKey: string;
}

export type CloudPipelineRunLaunchOutcome =
  | {
      readonly kind: 'started';
      /** The run's execution id: the start's operation. */
      readonly executionId: string;
      readonly admission: CloudPipelineRunStartResult['admission'];
      readonly statusReason: string | null;
      readonly replayed: boolean;
    }
  /** Model steps need a cloud model first; ask, then launch again. */
  | {
      readonly kind: 'models';
      readonly message: string;
      readonly preflight: CloudModelPreflightResult;
    }
  | {
      readonly kind: 'refused';
      readonly message: string;
      /**
       * The run may have been recorded: launch again with the same key, and
       * the web core answers with that run rather than start a second.
       */
      readonly uncertain: boolean;
    };

/** Kinds after which the web core may have recorded the start. */
const UNCERTAIN_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'unavailable',
  'deadline_exceeded',
  'cancelled',
  'internal',
]);

export const CLOUD_RUN_START_UNCERTAIN =
  "Couldn't confirm the cloud run started. Try again; it won't start twice.";
export const CLOUD_RUN_SIGN_IN = 'Sign in to run workflows in the cloud.';
export const CLOUD_RUN_UNAVAILABLE =
  "Cloud runs aren't available right now. Try again later.";
const CHOOSE_MODELS = 'Choose a cloud model for each agent step first.';
const CHOOSE_MODELS_AGAIN =
  'This workflow or its model policy changed. Choose the cloud models again.';

function payloadOf(error: unknown): CanopyErrorPayload | null {
  return error instanceof CoreCoworkRequestError ? error.payload : null;
}

/** The refused items the web core listed, as one readable message. */
function refusalMessage(payload: CanopyErrorPayload): string {
  const details = payload.details;
  const refusals =
    typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details) &&
    Array.isArray(details.refusals)
      ? details.refusals.flatMap((item) =>
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          typeof item.message === 'string'
            ? [item.message]
            : [],
        )
      : [];
  return refusals.length === 0
    ? payload.message
    : `${payload.message} ${refusals.join(' ')}`;
}

function refusalOf(error: unknown): CloudPipelineRunLaunchOutcome {
  const payload = payloadOf(error);
  if (
    payload === null ||
    UNCERTAIN_KINDS.has(payload.kind) ||
    payload.retry.kind === 'same_idempotency_key'
  )
    return {
      kind: 'refused',
      message: CLOUD_RUN_START_UNCERTAIN,
      uncertain: true,
    };
  if (
    payload.kind === 'capability_unavailable' ||
    payload.kind === 'unauthenticated'
  )
    return {
      kind: 'refused',
      message:
        payload.kind === 'unauthenticated'
          ? CLOUD_RUN_SIGN_IN
          : CLOUD_RUN_UNAVAILABLE,
      uncertain: false,
    };
  return {
    kind: 'refused',
    message: refusalMessage(payload),
    uncertain: false,
  };
}

/** Starts one cloud run, or says why not; it never throws. */
export async function launchCloudPipelineRun(
  invoker: CoreCoworkInvoker,
  launch: CloudPipelineRunLaunch,
): Promise<CloudPipelineRunLaunchOutcome> {
  const params: CloudPipelineRunStartParams = {
    scope: { targetId: CLOUD_PIPELINE_RUN_TARGET_ID },
    definitionId: launch.definitionId,
    owner: launch.owner,
    ...(launch.inputs === undefined ? {} : { inputs: { ...launch.inputs } }),
    ...(launch.eventName === undefined ? {} : { eventName: launch.eventName }),
    ...(launch.modelChoices === undefined
      ? {}
      : {
          modelChoices: {
            definitionHash: launch.modelChoices.preflight.definitionHash,
            policyFingerprint: launch.modelChoices.preflight.policyFingerprint,
            choices: [...launch.modelChoices.choices],
          },
        }),
  };
  try {
    const started = await requestCloud(
      invoker,
      'core.pipeline.execution.start',
      { ...params, _meta: { idempotencyKey: launch.idempotencyKey } },
      CloudPipelineRunStartResultSchema,
    );
    return {
      kind: 'started',
      executionId: started.operation.operationId,
      admission: started.admission,
      statusReason: started.statusReason,
      replayed: started.replayed,
    };
  } catch (error) {
    if (payloadOf(error)?.code !== CLOUD_MODEL_UNCONFIRMED_CODE)
      return refusalOf(error);
  }
  try {
    const preflight = await requestCloud(
      invoker,
      'core.pipeline.cloudModels.preflight',
      { definitionId: launch.definitionId, owner: launch.owner },
      CloudModelPreflightResultSchema,
    );
    return {
      kind: 'models',
      message:
        launch.modelChoices === undefined ? CHOOSE_MODELS : CHOOSE_MODELS_AGAIN,
      preflight,
    };
  } catch (error) {
    return refusalOf(error);
  }
}
