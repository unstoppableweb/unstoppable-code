import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { pipelineCloudRunsFromManifest } from '@canopy/app-core';
import {
  CanopyClientError,
  createCanopyClient,
  type CanopyClient,
} from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import type {
  CanopyCoreRelayLikeReply,
  CoreCoworkInvoker,
} from '@canopy/app-state/core-cowork';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import type {
  CloudPipelineRunRefusalCode,
  CloudPipelineRunStartResult,
  PipelineCloudRunsAvailability,
  PipelineRunLocationRequest,
} from '@canopy/desktop-shared/types/pipeline-cloud-runs';
import {
  CLOUD_MODEL_UNCONFIRMED_CODE,
  CLOUD_PIPELINE_RUN_TARGET_ID,
  CORE_PIPELINE_CLOUD_MODEL_QUERY_DEFINITIONS,
  CORE_PIPELINE_CLOUD_RUN_INSTRUCTION_DEFINITIONS,
  CORE_PIPELINE_RUN_READ_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CanopyRequestMetadataSchema,
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_QUERY_DEFINITIONS,
  composeCanopyInstructionRegistries,
  composeCanopyQueryRegistries,
  type CanopyErrorPayload,
  type CanopyInstructionDefinitionMap,
  type CanopyQueryDefinitionMap,
  type CloudModelPreflightResult,
  type CloudPipelineRunStartParams,
  type CloudPipelineRunStartResult as WireStartResult,
  type CoreRuntimeManifestOperation,
} from '@canopy/protocol/canopy-core';
import {
  connectWebCore,
  type WebCoreBindingOptions,
} from '../canopy-cloud/web-core-connection';
import { desktopWebCoreBindingOptions } from '../ipc/cloud-chats';

/**
 * Cloud runs started from this computer (CAN-6187, plan CP-37).
 *
 * A manual run's location is its own field (decision P6). A run with the
 * cloud `targetId` never runs here: main starts it in the web core with
 * `core.pipeline.execution.start` on its own web core connection, as the
 * signed-in account, after the CAN-6174 model preflight. The web core is the
 * run's authority (ADR 31); this computer only asks.
 *
 * Whether to offer the cloud at all is the CAN-6085 capability axis, read
 * from the same connection's manifest with `pipelineCloudRunsFromManifest`.
 */

/** Each call is short: a manifest read, or a preflight and a start. */
const CALL_TIMEOUT_MS = 30_000;
/** How long one availability read answers the Run dialog. */
const AVAILABILITY_TTL_MS = 60_000;

/** The web core calls main makes for cloud runs; the fake web core in tests. */
export interface CloudPipelineRunCalls {
  manifest(): Promise<readonly CoreRuntimeManifestOperation[]>;
  preflight(params: {
    definitionId: string;
    owner: string;
  }): Promise<CloudModelPreflightResult>;
  start(
    params: CloudPipelineRunStartParams,
    idempotencyKey: string,
  ): Promise<WireStartResult>;
  /**
   * One of `CLOUD_RUN_AGENT_OPERATIONS`, as the renderer relay answers it:
   * `_meta` in `params` is the call's metadata.
   */
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<CanopyCoreRelayLikeReply>;
}

const DEFINITIONS = {
  queries: composeCanopyQueryRegistries(
    CORE_TRANSPORT_QUERY_DEFINITIONS,
    CORE_PIPELINE_CLOUD_MODEL_QUERY_DEFINITIONS,
  ),
  instructions: composeCanopyInstructionRegistries(
    CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    CORE_PIPELINE_CLOUD_RUN_INSTRUCTION_DEFINITIONS,
  ),
};

/**
 * The run reads and controls desktop agents call on a cloud run (CAN-6354):
 * the execution actions' subset of what the Runs feed reaches through the
 * renderer relay (`WEB_CORE_PIPELINE_RUN_RELAY_OPERATIONS`).
 */
export const CLOUD_RUN_AGENT_OPERATIONS: ReadonlySet<string> = new Set([
  'worker.pipeline.execution.list',
  'worker.pipeline.execution.get',
  'worker.pipeline.execution.cancel',
  'worker.pipeline.execution.resume',
  'worker.pipeline.execution.retry',
  'core.pipeline.execution.artifact.read',
]);

function agentOperations<D>(
  map: Readonly<Record<string, D>>,
): Record<string, D> {
  return Object.fromEntries(
    Object.entries(map).filter(([name]) =>
      CLOUD_RUN_AGENT_OPERATIONS.has(name),
    ),
  );
}

const AGENT_DEFINITIONS: {
  readonly queries: CanopyQueryDefinitionMap;
  readonly instructions: CanopyInstructionDefinitionMap;
} = {
  queries: agentOperations(
    composeCanopyQueryRegistries(
      CORE_TRANSPORT_QUERY_DEFINITIONS,
      WORKER_PIPELINE_QUERY_DEFINITIONS,
      CORE_PIPELINE_RUN_READ_QUERY_DEFINITIONS,
    ),
  ),
  instructions: agentOperations(WORKER_PIPELINE_INSTRUCTION_DEFINITIONS),
};

function unavailableOperation(method: string): CanopyCoreRelayLikeReply {
  return {
    ok: false,
    error: {
      kind: 'capability_unavailable',
      message: `${method} is not available here.`,
      retry: { kind: 'never' },
    },
  };
}

/**
 * Each call on a connection of its own, opened with main's web core binding
 * and closed once the call settles. Cloud runs aren't behind the cloud chats
 * flag: the web core serves them behind its own rollout flag.
 */
export function createWebCoreCloudPipelineRunCalls(
  binding: WebCoreBindingOptions,
  clientVersion: string,
): CloudPipelineRunCalls {
  const withClient = async <
    Q extends CanopyQueryDefinitionMap,
    I extends CanopyInstructionDefinitionMap,
    T,
  >(
    definitions: { readonly queries: Q; readonly instructions: I },
    call: (client: CanopyClient<Q, I>, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const client = await createCanopyClient({
      connection: await connectWebCore(binding, signal),
      clientName: 'canopy-desktop-cloud-pipeline-runs',
      clientVersion,
      definitions: { ...definitions, streams: {} },
      signal,
    });
    try {
      return await call(client, signal);
    } finally {
      await client.close();
    }
  };
  return {
    manifest: () =>
      withClient(DEFINITIONS, async (client) => {
        const result = await client.query('core.runtime.manifest.get', {});
        return result.operations;
      }),
    preflight: (params) =>
      withClient(DEFINITIONS, (client) =>
        client.query('core.pipeline.cloudModels.preflight', params),
      ),
    start: (params, idempotencyKey) =>
      withClient(DEFINITIONS, (client) =>
        client.instruction('core.pipeline.execution.start', params, {
          metadata: { idempotencyKey },
        }),
      ),
    request: async (method, params) => {
      // Only the listed names, so `in` never reaches a prototype member.
      const kind = !CLOUD_RUN_AGENT_OPERATIONS.has(method)
        ? null
        : method in AGENT_DEFINITIONS.queries
          ? 'query'
          : method in AGENT_DEFINITIONS.instructions
            ? 'instruction'
            : null;
      if (kind === null) return unavailableOperation(method);
      const { _meta: meta, ...rest } = params;
      const metadata = CanopyRequestMetadataSchema.safeParse(meta ?? {});
      if (!metadata.success) return unavailableOperation(method);
      try {
        const value = await withClient(AGENT_DEFINITIONS, (client, signal) => {
          const options = { metadata: metadata.data, signal };
          return kind === 'query'
            ? client.query(method, rest, options)
            : client.instruction(method, rest, options);
        });
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: payloadOf(error) ?? {
            kind: 'unavailable',
            message: error instanceof Error ? error.message : String(error),
            retry: { kind: 'same_request' },
          },
        };
      }
    },
  };
}

let calls: CloudPipelineRunCalls | null = null;

function productionCalls(): CloudPipelineRunCalls {
  if (calls === null) {
    const binding = desktopWebCoreBindingOptions();
    // Another account, or none, may see another manifest.
    binding.onAccountChange(() => resetPipelineCloudRunsAvailability());
    calls = createWebCoreCloudPipelineRunCalls(
      { ...binding, isEnabled: () => true },
      app.getVersion(),
    );
  }
  return calls;
}

let cached: {
  readonly at: number;
  readonly answer: Promise<PipelineCloudRunsAvailability>;
} | null = null;

/**
 * Whether the Run dialog may offer "Run on: Cloud". Fails closed: signed
 * out, unreachable or a manifest without every cloud run operation answers
 * false.
 */
export function readPipelineCloudRunsAvailability(
  source: CloudPipelineRunCalls = productionCalls(),
  now: number = Date.now(),
): Promise<PipelineCloudRunsAvailability> {
  if (cached !== null && now - cached.at < AVAILABILITY_TTL_MS)
    return cached.answer;
  const answer = source
    .manifest()
    .then((operations) => ({
      pipelineCloudRuns:
        pipelineCloudRunsFromManifest(operations).pipelineCloudRuns === true,
    }))
    .catch(() => {
      // A failed read is not remembered: the next dialog reads again.
      if (cached?.answer === answer) cached = null;
      return { pipelineCloudRuns: false };
    });
  cached = { at: now, answer };
  return answer;
}

/**
 * Desktop agents' carrier for the shared cloud run reads and controls
 * (`@canopy/app-state/cloud-pipeline-runs`): main's own web core calls, as
 * the signed-in account, never the renderer relay, which serves the main
 * window only. It opens no streams.
 */
export function cloudPipelineRunsAgentInvoker(
  source: CloudPipelineRunCalls = productionCalls(),
): CoreCoworkInvoker {
  return {
    request: (method, params) => source.request(method, params),
    openStream: (method) =>
      Promise.reject(new Error(`${method} is not available to agents.`)),
  };
}

/** Forgets the last availability read, such as after an account change. */
export function resetPipelineCloudRunsAvailability(): void {
  cached = null;
}

/** What a cloud start needs from the `pipelines:execute` request. */
export interface CloudPipelineRunRequest extends PipelineRunLocationRequest {
  pipelineId: string;
  scope?: string;
  target?: { scope: string };
  cwd?: string;
  projectId?: string;
  worktreeId?: string;
  eventName?: string;
  inputs?: Record<string, string>;
  requestedOwner?: string;
  sharedPipeline?: { serverId: string; remoteId: string };
}

function refused(
  errorCode: CloudPipelineRunRefusalCode,
  error: string,
): CloudPipelineRunStartResult {
  return { success: false, error, errorCode };
}

// "No project" is the Run dialog's label for a run with no destination
// (`NO_PROJECT_LABEL` in @canopy/ui-app, which main doesn't import).
export const CLOUD_RUN_DESTINATION_UNAVAILABLE =
  'Cloud runs can only use No project for now. Choose No project, or run on this computer.';
export const CLOUD_RUN_TARGET_UNAVAILABLE =
  "This computer can't run workflows there.";
export const CLOUD_RUN_SOURCE_UNAVAILABLE =
  'Only shared and curated workflows can run in the cloud for now. Run this one on this computer.';

/**
 * The refusal for a destination a cloud run can't use yet, or null. Version
 * 1 starts runs with no project only; a task or project run in the cloud is
 * CP-36 and CP-29.
 */
export function cloudRunDestinationRefusal(
  request: Pick<
    CloudPipelineRunRequest,
    'scope' | 'target' | 'cwd' | 'projectId' | 'worktreeId'
  >,
): CloudPipelineRunStartResult | null {
  const global =
    request.scope === 'global' &&
    (request.target === undefined || request.target.scope === 'global') &&
    request.cwd === undefined &&
    request.projectId === undefined &&
    request.worktreeId === undefined;
  return global
    ? null
    : refused(
        'cloud_destination_unavailable',
        CLOUD_RUN_DESTINATION_UNAVAILABLE,
      );
}

/**
 * Why a Portal run with a `targetId` is refused: Portal runs go to a task,
 * which a cloud run can't use yet, so it never runs on this computer.
 */
export function portalRunLocationRefusal(targetId: string): string {
  return targetId === CLOUD_PIPELINE_RUN_TARGET_ID
    ? CLOUD_RUN_DESTINATION_UNAVAILABLE
    : CLOUD_RUN_TARGET_UNAVAILABLE;
}

/** The web core's definition id for a workflow it can read, or null. */
function cloudDefinitionId(request: CloudPipelineRunRequest): string | null {
  if (request.sharedPipeline !== undefined)
    return request.sharedPipeline.serverId === CANOPY_CLOUD_SERVER_ID
      ? `shared:${CANOPY_CLOUD_SERVER_ID}:${request.sharedPipeline.remoteId}`
      : null;
  return request.pipelineId.startsWith('curated:') ? request.pipelineId : null;
}

function payloadOf(error: unknown): CanopyErrorPayload | null {
  return error instanceof CanopyClientError ||
    error instanceof CanopyTransportError
    ? error.payload
    : null;
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

/** Kinds after which the web core may have recorded the start. */
const UNCERTAIN_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'unavailable',
  'deadline_exceeded',
  // A call cut off by its deadline: the client closes it as `cancelled`.
  'cancelled',
  'internal',
]);

/**
 * Where an agent's cloud run goes when it isn't a run with no project
 * (CAN-6354): the calling chat's project, and its task for a worktree chat.
 * The web core decides whether it runs there; this computer never does.
 */
export interface CloudRunAgentDestination {
  readonly workspaceId: string;
  readonly worktreeId?: string;
  readonly repoId?: string;
}

function failure(
  error: unknown,
  destination?: CloudRunAgentDestination,
): CloudPipelineRunStartResult {
  const payload = payloadOf(error);
  // No payload, an outcome that may have been recorded, or one the web core
  // says to retry with the same key: the Run dialog keeps the launch's key.
  if (
    payload === null ||
    UNCERTAIN_KINDS.has(payload.kind) ||
    payload.retry.kind === 'same_idempotency_key'
  )
    return refused(
      'cloud_start_uncertain',
      "Couldn't confirm the cloud run started. Try again; it won't start twice.",
    );
  // A destination the web core doesn't run cloud runs in yet is refused with
  // its own reason, not as cloud runs being unavailable.
  if (
    destination !== undefined &&
    payload.kind === 'capability_unavailable' &&
    payload.code !== 'core.pipeline.targetUnavailable'
  )
    return refused('cloud_destination_unavailable', payload.message);
  if (
    payload.kind === 'capability_unavailable' ||
    payload.kind === 'unauthenticated'
  )
    return refused(
      'cloud_unavailable',
      payload.kind === 'unauthenticated'
        ? 'Sign in to run workflows in the cloud.'
        : "Cloud runs aren't available right now. Run on this computer, or try again later.",
    );
  return refused('cloud_run_refused', refusalMessage(payload));
}

/** What a cloud start sends, once the request passes main's own checks. */
interface CloudStart {
  readonly definitionId: string;
  readonly owner: string;
  readonly params: CloudPipelineRunStartParams;
}

/** The start to send, or why main refuses it without asking the web core. */
function cloudStartOf(
  request: CloudPipelineRunRequest,
  destination: CloudRunAgentDestination | undefined,
  chat?: CloudRunAgentChat,
): CloudStart | CloudPipelineRunStartResult {
  if (request.targetId !== CLOUD_PIPELINE_RUN_TARGET_ID)
    return refused('cloud_target_unavailable', CLOUD_RUN_TARGET_UNAVAILABLE);
  if (destination === undefined) {
    const refusal = cloudRunDestinationRefusal(request);
    if (refusal !== null) return refusal;
  }
  const definitionId = cloudDefinitionId(request);
  if (definitionId === null)
    return refused('cloud_source_unavailable', CLOUD_RUN_SOURCE_UNAVAILABLE);
  const owner = request.requestedOwner ?? '';
  if (owner === '')
    return refused(
      'cloud_owner_required',
      'Choose who owns this run before running it in the cloud.',
    );
  const eventName =
    request.eventName === 'dispatch' || request.eventName === 'workflow'
      ? request.eventName
      : undefined;
  // CAN-3379 (#5803): when run chats land, the run-chat destination goes on
  // this start beside the location, never in place of it.
  return {
    definitionId,
    owner,
    params: {
      scope: {
        targetId: CLOUD_PIPELINE_RUN_TARGET_ID,
        ...(destination === undefined
          ? {}
          : {
              workspaceId: destination.workspaceId,
              ...(destination.worktreeId === undefined
                ? {}
                : { worktreeId: destination.worktreeId }),
              ...(destination.repoId === undefined
                ? {}
                : { repoId: destination.repoId }),
            }),
      },
      definitionId,
      owner,
      ...(request.inputs === undefined ? {} : { inputs: request.inputs }),
      ...(eventName === undefined ? {} : { eventName }),
      ...(request.cloudModelChoices === undefined
        ? {}
        : { modelChoices: request.cloudModelChoices }),
      ...(chat === undefined
        ? {}
        : {
            chat: {
              projectId: chat.projectId,
              worktreeId: chat.worktreeId,
              chatId: chat.chatId,
            },
          }),
    },
  };
}

/** The launch's key when it is a usable one, a fresh one otherwise. */
function idempotencyKeyOf(key: unknown): string {
  return typeof key === 'string' && key.length > 0 && key.length <= 512
    ? key
    : randomUUID();
}

function askForModels(
  error: string,
  cloudModels: CloudModelPreflightResult,
): CloudPipelineRunStartResult {
  return {
    success: false,
    errorCode: 'cloud_models_unconfirmed',
    error,
    cloudModels,
  };
}

/**
 * Starts a run with a cloud `targetId` in the web core, or answers why not.
 * The keyed start goes first: the web core answers a resent key with the run
 * it recorded before reading anything, and refuses a run whose model steps
 * have no confirmed cloud model with `cloudModelsUnconfirmed`, recording
 * nothing. Only then does main read the model preflight, so the Run dialog
 * asks for the models before any run starts. Nothing runs on this computer.
 */
export function startCloudPipelineRun(
  request: CloudPipelineRunRequest,
  source: CloudPipelineRunCalls = productionCalls(),
): Promise<CloudPipelineRunStartResult> {
  return startCloudRun(request, undefined, source);
}

/** The chat whose agent starts a cloud run, as desktop names it. */
export interface CloudRunAgentChat {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/**
 * An agent's cloud start (CAN-6354): as `startCloudPipelineRun`, and a run
 * in the calling chat's project or task names it in the start's scope,
 * beside the location, for the web core to admit or refuse. The calling
 * chat goes on the start too (CAN-6391), which the web core reports as the
 * run's agent initiator, so its desktop watchers know which chat started it.
 */
export function startAgentCloudPipelineRun(
  request: CloudPipelineRunRequest,
  destination: CloudRunAgentDestination | undefined,
  chat: CloudRunAgentChat | undefined,
  source: CloudPipelineRunCalls = productionCalls(),
): Promise<CloudPipelineRunStartResult> {
  return startCloudRun(request, destination, source, chat);
}

async function startCloudRun(
  request: CloudPipelineRunRequest,
  destination: CloudRunAgentDestination | undefined,
  source: CloudPipelineRunCalls,
  chat?: CloudRunAgentChat,
): Promise<CloudPipelineRunStartResult> {
  const start = cloudStartOf(request, destination, chat);
  if (!('params' in start)) return start;
  const { definitionId, owner } = start;
  try {
    const started = await source.start(
      start.params,
      idempotencyKeyOf(request.cloudIdempotencyKey),
    );
    return {
      success: true,
      cloudRun: {
        operationId: started.operation.operationId,
        admission: started.admission,
        statusReason: started.statusReason,
        replayed: started.replayed,
      },
    };
  } catch (error) {
    if (payloadOf(error)?.code !== CLOUD_MODEL_UNCONFIRMED_CODE)
      return failure(error, destination);
  }
  try {
    return askForModels(
      request.cloudModelChoices === undefined
        ? 'Choose a cloud model for each agent step first.'
        : 'This workflow or its model policy changed. Choose the cloud models again.',
      await source.preflight({ definitionId, owner }),
    );
  } catch (error) {
    return failure(error);
  }
}
