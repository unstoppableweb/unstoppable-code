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
  CLOUD_RUN_WORKTREE_PREPARING_CODE,
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
  type CanopyCallerDescriptor,
  isUnknownKeyedWriteOutcome,
  type CanopyErrorPayload,
  type CanopyInstructionDefinitionMap,
  type CanopyQueryDefinitionMap,
  type CloudModelPreflightResult,
  type CloudPipelineRunCheckout,
  type CloudPipelineRunStartParams,
  type CloudPipelineRunStartResult as WireStartResult,
  type CoreRuntimeManifestOperation,
} from '@canopy/protocol/canopy-core';
import {
  connectWebCore,
  type WebCoreBindingOptions,
} from '../canopy-cloud/web-core-connection';
import { desktopWebCoreBindingOptions } from '../ipc/cloud-chats';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { getWorktreePathForCaller } from '../ipc/open-in';
import {
  githubRepositoryOfRemote,
  LOCAL_CHECKOUT_COPY,
  LOCAL_CHECKOUT_GIT,
  resolveLocalCheckout,
  type LocalCheckoutGit,
} from './cloud-run-local-checkout';

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
  "Cloud runs can use No project or a task's Git worktree. Choose one, or run on this computer.";
export const CLOUD_RUN_TARGET_UNAVAILABLE =
  "This computer can't run workflows there.";
export const CLOUD_RUN_PROJECT_MODELS_UNAVAILABLE =
  "This project workflow has steps whose models need a cloud model, which can't be chosen for a project workflow yet. Pick cloud models in the workflow file, or run it on this computer.";
export const CLOUD_RUN_SOURCE_UNAVAILABLE =
  'Only shared and curated workflows can run in the cloud for now. Run this one on this computer.';

/** A task's worktree a cloud run goes with (CAN-6869). */
export interface CloudRunLocalTask {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly repoId?: string;
}

/**
 * Where a cloud start goes: no project, a task's worktree (CAN-6869, which
 * runs at its pushed branch), or the refusal for any other destination.
 */
export function cloudRunDestinationOf(
  request: Pick<
    CloudPipelineRunRequest,
    'scope' | 'target' | 'cwd' | 'projectId' | 'worktreeId' | 'cloudRepoId'
  >,
): 'global' | CloudRunLocalTask | CloudPipelineRunStartResult {
  if (
    request.scope === 'global' &&
    (request.target === undefined || request.target.scope === 'global') &&
    request.cwd === undefined &&
    request.projectId === undefined &&
    request.worktreeId === undefined &&
    request.cloudRepoId === undefined
  )
    return 'global';
  if (
    request.scope === 'worktree' &&
    (request.target === undefined || request.target.scope === 'worktree') &&
    request.projectId !== undefined &&
    request.worktreeId !== undefined
  )
    return {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      ...(request.cloudRepoId === undefined
        ? {}
        : { repoId: request.cloudRepoId }),
    };
  return refused(
    'cloud_destination_unavailable',
    CLOUD_RUN_DESTINATION_UNAVAILABLE,
  );
}

/**
 * A Portal run in the cloud: Portal runs go to a task, whose run in the
 * cloud needs the push warning only this computer's Run dialog shows
 * (CAN-6869), so the Portal can't start one yet.
 */
export const REMOTE_CONTROL_CLOUD_RUN_UNAVAILABLE =
  "Cloud runs of a task start from this computer's Run dialog for now. Run on this computer, or start it there.";

/**
 * Why a Portal run with a `targetId` is refused: it never runs on this
 * computer instead.
 */
export function remoteControlRunLocationRefusal(targetId: string): string {
  return targetId === CLOUD_PIPELINE_RUN_TARGET_ID
    ? REMOTE_CONTROL_CLOUD_RUN_UNAVAILABLE
    : CLOUD_RUN_TARGET_UNAVAILABLE;
}

/**
 * The web core's definition id for a workflow it can read, or null. A task's
 * run also reads its project workflows (`project--<path>`), from the pushed
 * branch (CAN-6869, CAN-6672).
 */
function cloudDefinitionId(
  request: CloudPipelineRunRequest,
  inCheckout: boolean,
): string | null {
  if (request.sharedPipeline !== undefined)
    return request.sharedPipeline.serverId === CANOPY_CLOUD_SERVER_ID
      ? `shared:${CANOPY_CLOUD_SERVER_ID}:${request.sharedPipeline.remoteId}`
      : null;
  if (request.pipelineId.startsWith('curated:')) return request.pipelineId;
  return inCheckout && request.pipelineId.startsWith('project--')
    ? request.pipelineId
    : null;
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

/**
 * A failed start or model preflight, in the Run dialog's terms. Only the
 * keyed start may have been recorded: the preflight is a read after a start
 * that recorded nothing, so its failure is always a refusal (CAN-7470).
 */
function failure(
  error: unknown,
  {
    destination,
    keyed,
  }: {
    readonly destination?: CloudRunAgentDestination;
    readonly keyed: boolean;
  },
): CloudPipelineRunStartResult {
  const payload = payloadOf(error);
  // A task's cloud worktree still being set up recorded nothing: the Run
  // dialog sends the same start again shortly (CAN-6869).
  if (payload?.code === CLOUD_RUN_WORKTREE_PREPARING_CODE)
    return refused('cloud_worktree_preparing', payload.message);
  // No payload, or an outcome that may have been recorded (CAN-7196): the
  // Run dialog keeps the launch's key.
  if (keyed && (payload === null || isUnknownKeyedWriteOutcome(payload)))
    return refused(
      'cloud_start_uncertain',
      "Couldn't confirm the cloud run started. Try again; it won't start twice.",
    );
  if (payload === null)
    return refused(
      'cloud_unavailable',
      "Cloud runs aren't available right now. Run on this computer, or try again later.",
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
  checkout?: CloudPipelineRunCheckout,
): CloudStart | CloudPipelineRunStartResult {
  if (request.targetId !== CLOUD_PIPELINE_RUN_TARGET_ID)
    return refused('cloud_target_unavailable', CLOUD_RUN_TARGET_UNAVAILABLE);
  const definitionId = cloudDefinitionId(request, checkout !== undefined);
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
      ...(checkout === undefined ? {} : { checkout }),
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
export async function startCloudPipelineRun(
  request: CloudPipelineRunRequest,
  source: CloudPipelineRunCalls = productionCalls(),
  local: CloudRunLocalCheckoutDeps = PRODUCTION_LOCAL_CHECKOUT,
): Promise<CloudPipelineRunStartResult> {
  const destination = cloudRunDestinationOf(request);
  if (destination === 'global')
    return startCloudRun(request, undefined, source);
  if ('success' in destination) return destination;
  // A task runs at its pushed branch (CAN-6869): its worktree's folder comes
  // from its project and task, never from the request.
  if (request.targetId !== CLOUD_PIPELINE_RUN_TARGET_ID)
    return refused('cloud_target_unavailable', CLOUD_RUN_TARGET_UNAVAILABLE);
  let cwd: string;
  try {
    cwd = await local.worktreePath(destination);
  } catch {
    return refused(
      'cloud_destination_unavailable',
      CLOUD_RUN_DESTINATION_UNAVAILABLE,
    );
  }
  // A resend after a start that may have been recorded, or one waiting for
  // its cloud worktree, sends the checkout that start sent, so it replays
  // rather than changing under its key; one whose task moved since is
  // refused, never sent at another repository, branch or head.
  const key = request.cloudIdempotencyKey;
  const sent =
    key === undefined ? undefined : resolvedCheckouts.get(key)?.checkout;
  if (key !== undefined && sent !== undefined) {
    const [origin, branch, head] = await Promise.all([
      local.git.originUrl(cwd).catch(() => null),
      local.git.branch(cwd).catch(() => ''),
      local.git.head(cwd).catch(() => null),
    ]);
    const repository =
      origin === null ? null : githubRepositoryOfRemote(origin);
    if (
      repository?.toLowerCase() !== sent.repository.toLowerCase() ||
      branch.trim() !== sent.branch ||
      head !== sent.headSha
    )
      return refused(
        'cloud_destination_unavailable',
        LOCAL_CHECKOUT_COPY.movedSinceSent,
      );
    return settle(
      key,
      await startCloudRun(request, undefined, source, undefined, sent),
    );
  }
  const outcome = await resolveLocalCheckout(
    cwd,
    request.cloudCheckoutConfirmed,
    (confirmed) => local.push(destination, cwd, confirmed),
    local.git,
  ).catch((error: unknown) => ({
    kind: 'refused' as const,
    message:
      error instanceof Error
        ? `Couldn't push this task's branch: ${error.message}`
        : "Couldn't read this task's branch.",
  }));
  if (outcome.kind === 'refused')
    return refused('cloud_destination_unavailable', outcome.message);
  if (outcome.kind === 'confirm')
    return {
      success: false,
      errorCode: 'cloud_checkout_unconfirmed',
      error:
        'The cloud runs only what this branch has on GitHub. Confirm before it runs.',
      checkout: outcome.state,
    };
  const result = await startCloudRun(
    request,
    undefined,
    source,
    undefined,
    outcome.checkout,
  );
  if (key === undefined) return result;
  rememberCheckout(key, outcome.checkout);
  return settle(key, result);
}

/**
 * Keeps a launch's checkout until its run starts, once any send of it came
 * back uncertain (it may be recorded) or preparing (it is being resent): a
 * later resend then goes at exactly that checkout, or is refused if the task
 * moved, whatever came back in between. A launch that never had such an
 * answer forgets it on a refusal, so the next send reads the task afresh.
 */
function settle(
  key: string,
  result: CloudPipelineRunStartResult,
): CloudPipelineRunStartResult {
  const entry = resolvedCheckouts.get(key);
  if (result.success) resolvedCheckouts.delete(key);
  else if (
    result.errorCode === 'cloud_start_uncertain' ||
    result.errorCode === 'cloud_worktree_preparing'
  ) {
    if (entry !== undefined) entry.held = true;
  } else if (entry?.held !== true) resolvedCheckouts.delete(key);
  return result;
}

/** The most launches whose resolved checkout main keeps for their resends. */
const RESOLVED_CHECKOUTS_MAX = 64;
/** A launch's resolved checkout, and whether a send of it may be recorded or resent. */
const resolvedCheckouts = new Map<
  string,
  { readonly checkout: CloudPipelineRunCheckout; held: boolean }
>();

function rememberCheckout(
  key: string,
  checkout: CloudPipelineRunCheckout,
): void {
  resolvedCheckouts.delete(key);
  resolvedCheckouts.set(key, { checkout, held: false });
  for (const oldest of resolvedCheckouts.keys()) {
    if (resolvedCheckouts.size <= RESOLVED_CHECKOUTS_MAX) break;
    resolvedCheckouts.delete(oldest);
  }
}

/** A task's worktree folder, its Git and its push; the real ones in production. */
export interface CloudRunLocalCheckoutDeps {
  worktreePath(task: CloudRunLocalTask): Promise<string>;
  readonly git: LocalCheckoutGit;
  /** Pushes exactly the confirmed commit, through the task's worker. */
  push(
    task: CloudRunLocalTask,
    cwd: string,
    confirmed: { readonly branch: string; readonly headSha: string },
  ): Promise<void>;
}

/**
 * Main's own trusted caller for a confirmed push: the Run dialog's warning
 * is the person's authorization, as the Portal's Git actions are theirs.
 */
const CLOUD_RUN_PUSH_CALLER: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'electron-main-cloud-run-push',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [],
};

const PRODUCTION_LOCAL_CHECKOUT: CloudRunLocalCheckoutDeps = {
  worktreePath: (task) =>
    Promise.resolve().then(() =>
      getWorktreePathForCaller({
        projectId: task.projectId,
        worktreeId: task.worktreeId,
        ...(task.repoId === undefined ? {} : { repoId: task.repoId }),
      }),
    ),
  git: LOCAL_CHECKOUT_GIT,
  async push(task, cwd, confirmed) {
    const [{ getActiveDesktopRuntime }, { pushConfirmedWorktreeHead }] =
      await Promise.all([
        import('../canopy-runtime/desktop-runtime'),
        import('../canopy-runtime/worker-git-commit-push-dispatch'),
      ]);
    await pushConfirmedWorktreeHead(
      getActiveDesktopRuntime(),
      CLOUD_RUN_PUSH_CALLER,
      { projectId: task.projectId, worktreeId: task.worktreeId },
      {
        repoPath: cwd,
        ...(task.repoId === undefined ? {} : { repoId: task.repoId }),
      },
      confirmed,
    );
  },
};

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
  // An agent's run goes with no project, or to its chat's place through
  // `destination`; the request itself never names one.
  if (destination === undefined) {
    const named = cloudRunDestinationOf(request);
    if (named !== 'global')
      return Promise.resolve(
        'success' in named
          ? named
          : refused(
              'cloud_destination_unavailable',
              CLOUD_RUN_DESTINATION_UNAVAILABLE,
            ),
      );
  }
  return startCloudRun(request, destination, source, chat);
}

async function startCloudRun(
  request: CloudPipelineRunRequest,
  destination: CloudRunAgentDestination | undefined,
  source: CloudPipelineRunCalls,
  chat?: CloudRunAgentChat,
  checkout?: CloudPipelineRunCheckout,
): Promise<CloudPipelineRunStartResult> {
  const start = cloudStartOf(request, destination, chat, checkout);
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
      return failure(error, { destination, keyed: true });
  }
  // The cloud model preflight reads shared and curated workflows only: a
  // project workflow is in the task's pushed branch, which the preflight
  // can't name yet (a CAN-6672 follow-up), so the dialog can't ask.
  if (definitionId.startsWith('project--'))
    return refused('cloud_run_refused', CLOUD_RUN_PROJECT_MODELS_UNAVAILABLE);
  try {
    return askForModels(
      request.cloudModelChoices === undefined
        ? 'Choose a cloud model for each agent step first.'
        : 'This workflow or its model policy changed. Choose the cloud models again.',
      await source.preflight({ definitionId, owner }),
    );
  } catch (error) {
    return failure(error, { keyed: false });
  }
}
