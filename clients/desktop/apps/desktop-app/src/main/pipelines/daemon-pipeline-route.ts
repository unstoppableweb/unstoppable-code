import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { CanopyOperationError } from '@canopy/core-runtime';
import { CanopyClientError } from '@canopy/core-client';
import type { RedeemedExecutionSecrets } from '@canopy/core-runtime/node/execution-secrets';
import {
  PipelineDrainTimeoutError,
  pipelineExecutionNotFoundError,
  pipelineStartFailedError,
} from '@canopy/core-runtime/node/pipeline';
import {
  CanopyChildEnvironmentSchema,
  WORKER_PIPELINE_GRANTS,
  WorkerPipelineHostLaunchSchema,
  type CanopyCallerDescriptor,
  type WorkerPipelineCancelMode,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionResult,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineHostLaunch,
} from '@canopy/protocol/canopy-core';
import {
  classifyDaemonPipeline,
  DAEMON_PIPELINE_REFUSAL_REASONS,
  resolveDaemonPipelineInputs,
  type DaemonModelAliasResolution,
} from '@canopy/execution-engine/node/pipelines/daemon-eligibility';
import { resolveExecutionModelAliasPreferences } from '@canopy/execution-engine/node/pipelines/executor/model-alias-preferences';
import { resolveExecutionPluginCollections } from '@canopy/execution-engine/node/pipelines/executor/plugin-collection-resolution';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import {
  getSecretValues,
  resolvePipelineModelAliasTarget,
} from '@canopy/execution-engine/node/pipelines/executor/step-runner';
import {
  DAEMON_PIPELINE_PLATFORMS,
  daemonPipelineProcessEnvironment,
  isDaemonPipelineLaunchInRoots,
} from '@canopy/desktop-shared/node/pipelines/daemon-launch';
import type {
  ExecutionOptions,
  PipelineStepNotification,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  ExecutionState,
  Pipeline,
  PipelineModelAliasPreference,
  ResolvedPipelinePluginCollectionSnapshot,
} from '@canopy/execution-engine/types/pipeline';
import {
  daemonUnreachableReason,
  markUnreachable,
} from '../canopy-runtime/electron-daemon-connection';
import {
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
} from '../canopy-runtime/electron-daemon-access';
import type { ElectronDaemonClient } from '../canopy-runtime/electron-daemon-host';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';
import {
  recordDaemonRoute,
  recordDaemonRouteDecision,
  type DaemonRouteNote,
} from '../canopy-runtime/daemon-route-telemetry';
import { isDaemonPipelineOwnerPossible } from '../canopy-runtime/electron-daemon-owner';
import { getExecutionAccounting } from '../execution-accounting';
import {
  DaemonPipelineExecutionHandle,
  registerDaemonPipelineExecution,
  type DaemonPipelineEventsFrame,
  type DaemonPipelineEventsSubscription,
} from './daemon-pipeline-execution';
import {
  catchUpDaemonCommitHooks,
  clearDaemonCommitHooksPending,
  hasDaemonCommitHooksPending,
  hasDaemonCommitSteps,
  markDaemonCommitHooksPending,
  type DaemonCommitHookScope,
} from './daemon-pipeline-commit-hooks';
import {
  ensureDaemonPipelineOwnerSettlement,
  expectDaemonPipelineHostSteps,
  type DaemonPipelineHostStepsTarget,
} from './daemon-pipeline-owner';
import type { DaemonPipelineRouteContext } from './daemon-pipeline-route-context';
import { desktopPipelineHostActionsOf } from './pipeline-host-requests';
import { isErrnoException } from '../lib/type-guards';
import { attachDaemonPipelineOwnerRun } from './daemon-pipeline-model-owner';
import { resolveCodexRuntimeEnvironmentProfile } from '../lib/user-environment-runtime';
import { buildModelRegistrySnapshot } from '@canopy/execution-engine/node/pipelines/executor/model-registry-snapshot';
import { resolveAnthropicMockEnvOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import {
  getBundledClaudeBinaryPath,
  getBundledCodexBinaryPath,
  getBundledSkillsDir,
} from './config-paths';

/**
 * Routing of renderer workflow starts to the daemon's pipeline host
 * (CAN-5086), by default on eligible hosts (CAN-5960). Only the
 * `pipelines:execute` IPC handler opens a route; every other caller runs
 * in process. Both hosts run the same executor over the same execution
 * store, so a run either host started needs no repair in the other.
 */

export { DAEMON_PIPELINE_PLATFORMS };

export interface DaemonPipelineRouteInput {
  readonly platform: PlatformOperatingSystem | null;
  readonly context: DaemonPipelineRouteContext | undefined;
  /** Main's record says the daemon cannot be reached right now. */
  readonly daemonLatched: boolean;
}

/** Why a renderer start stays in process, or `null` when it may go to the daemon. */
export function daemonPipelineRouteExclusion(
  input: DaemonPipelineRouteInput,
): 'platform' | 'caller' | 'latched' | null {
  if (!isDaemonPipelinePlatformEligible(input.platform)) return 'platform';
  if (input.context?.localWindow !== true) return 'caller';
  if (input.daemonLatched) return 'latched';
  return null;
}

/** Whether a renderer start may go to the daemon, as code (D6). */
export function isDaemonPipelineRouteEligible(
  input: DaemonPipelineRouteInput,
): boolean {
  return daemonPipelineRouteExclusion(input) === null;
}

function isDaemonPipelinePlatformEligible(
  platform: PlatformOperatingSystem | null,
): boolean {
  return platform !== null && DAEMON_PIPELINE_PLATFORMS[platform] === true;
}

function hostPlatform(): PlatformOperatingSystem | null {
  try {
    return hostPlatformOperatingSystem();
  } catch {
    return null;
  }
}

/** Reads only local state: the platform and the health latch. */
export function selectDaemonPipeline(
  context: DaemonPipelineRouteContext | undefined,
): boolean {
  const exclusion = daemonPipelineRouteExclusion({
    platform: hostPlatform(),
    context,
    daemonLatched: getElectronDaemonHealth().isLatched(),
  });
  if (exclusion !== null) recordDaemonRoute('workflows', exclusion);
  return exclusion === null;
}

/** Records a launch the route could not build (CAN-5093 field evidence). */
export function noteDaemonPipelineIneligible(
  reason: DaemonPipelineIneligibleReason,
): void {
  recordDaemonRoute('workflows', reason);
}

export const DAEMON_PIPELINE_INELIGIBLE_REASONS = [
  'initiation',
  'scope',
  'trigger',
  'portal',
  'nested',
  'package',
  'limits',
  'roots',
  // CAN-5095: the Claude terminal worker stays in process.
  'terminal_mode',
  ...DAEMON_PIPELINE_REFUSAL_REASONS,
] as const;
export type DaemonPipelineIneligibleReason =
  (typeof DAEMON_PIPELINE_INELIGIBLE_REASONS)[number];

/** The host-local launch a start sends, apart from the secrets redeemed at dispatch. */
export interface DaemonPipelineLaunch {
  readonly pipelineLaunch: Omit<WorkerPipelineHostLaunch, 'secretEnv'>;
  /** The base environment, `_execution.childEnvironment` (D4). */
  readonly processEnvironment: Readonly<Record<string, string>>;
}

/** The defined string entries of an environment. */
function definedEntries(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment))
    if (value !== undefined) defined[key] = value;
  return defined;
}

/** What a launch with model steps adds (CAN-5095 D20 to D22): host-local, never in params. */
function modelStepLaunch(
  options: ExecutionOptions,
  classification: { readonly modelHarnesses: readonly string[] },
  agentAliases: boolean,
): Record<string, unknown> {
  // Each step resolves its Agent's base model again, as in process (CAN-5832),
  // so a run with an Agent alias may reach Codex though it launched on Claude.
  const codexEnvironment =
    classification.modelHarnesses.includes('codex') || agentAliases
      ? resolveCodexRuntimeEnvironmentProfile({
          runtime: 'pipeline',
          ...(options.projectId ? { workspaceId: options.projectId } : {}),
        })
      : undefined;
  return {
    ...(options.modelConfig !== undefined && {
      modelConfig: options.modelConfig,
    }),
    providerBinaries: {
      claude: getBundledClaudeBinaryPath(),
      codex: getBundledCodexBinaryPath(),
    },
    // Where the app's builtin skills live; the daemon runs from another
    // folder of the same bundle (CAN-5832).
    bundledResourcesDir: path.dirname(getBundledSkillsDir()),
    modelCatalog: buildModelRegistrySnapshot(),
    // Electron main runs `git-commit-push`'s precommit-failure hook (CAN-6012 D3).
    precommitHooks: 'owner',
    ...(codexEnvironment && {
      codexEnvironment: {
        environment: definedEntries(codexEnvironment.environment),
        logicalWorkspaceEnvironmentId:
          codexEnvironment.logicalWorkspaceEnvironmentId,
      },
    }),
  };
}

/** A run's model aliases as its executor will merge and resolve them (CAN-5832). */
interface LaunchModelAliases {
  readonly preferences?: Record<string, PipelineModelAliasPreference>;
  /** Each alias a step could resolve; an alias that would fail is absent. */
  readonly resolutions: Record<string, DaemonModelAliasResolution>;
  /** Some alias names an Agent, which its steps resolve again. */
  readonly agents: boolean;
}

async function resolveLaunchModelAliases(
  pipeline: Pipeline,
  options: ExecutionOptions,
): Promise<LaunchModelAliases | undefined> {
  if (!pipeline.model_aliases?.length) return undefined;
  let preferences: Record<string, PipelineModelAliasPreference> | undefined;
  try {
    preferences = resolveExecutionModelAliasPreferences(pipeline, options);
  } catch {
    // Unreadable preferences: no alias resolves, so its steps run in process.
    return { resolutions: {}, agents: false };
  }
  const resolveAgent = options.runtime.resolvePipelineAgentModelAlias;
  const scope = {
    ...(options.projectId !== undefined && { projectId: options.projectId }),
    ...(options.worktreeId !== undefined && {
      worktreeId: options.worktreeId,
    }),
    ...(options.executionContext !== undefined && {
      executionContext: options.executionContext,
    }),
  };
  const resolutions: Record<string, DaemonModelAliasResolution> = {};
  let agents = false;
  for (const alias of pipeline.model_aliases) {
    const target = await resolvePipelineModelAliasTarget(
      alias,
      preferences?.[alias.id],
      (agentId) =>
        resolveAgent ? resolveAgent(agentId, scope) : Promise.resolve(null),
    ).catch(() => null);
    if (!target) continue;
    resolutions[alias.id] = { base: target.base, plugins: target.plugins };
    agents ||= target.agent;
  }
  return { ...(preferences && { preferences }), resolutions, agents };
}

/** A run's plugin collections as its executor will resolve them at start (CAN-5832). */
interface LaunchPluginCollections {
  readonly snapshots: Record<string, ResolvedPipelinePluginCollectionSnapshot>;
}

/**
 * Resolves the run's collections with the executor's own function; null
 * when that fails (the run then fails at start in process, as before). A
 * collection's standalone MCP servers go as references: an SDK step drops
 * them in process too (CAN-6011, CAN-6277).
 */
async function resolveLaunchPluginCollections(
  pipeline: Pipeline,
  options: ExecutionOptions,
): Promise<LaunchPluginCollections | null | undefined> {
  if (!pipeline.plugin_collections?.length) return undefined;
  // From the normalized pipeline, as the executor resolves them, so each
  // snapshot is keyed by the trimmed id the executor looks up.
  const resolved = await Promise.resolve()
    .then(() =>
      resolveExecutionPluginCollections(normalizePipeline(pipeline), options),
    )
    .catch(() => null);
  return resolved ? { snapshots: resolved.snapshots } : null;
}

export async function buildDaemonPipelineLaunch(
  pipeline: Pipeline,
  options: ExecutionOptions,
): Promise<
  | { readonly ok: true; readonly launch: DaemonPipelineLaunch }
  | { readonly ok: false; readonly reason: DaemonPipelineIneligibleReason }
> {
  // A renderer start leaves its source unset; agents, hooks, automations and
  // Portal name theirs. Its scope is derived as dispatch derives runScope.
  if (
    options.initiationSource !== undefined &&
    options.initiationSource !== 'user'
  )
    return { ok: false, reason: 'initiation' };
  if (options.portalCommandId !== undefined)
    return { ok: false, reason: 'portal' };
  const scope =
    options.scope ??
    (options.worktreeId !== undefined ? 'worktree' : 'directory');
  if (scope !== 'worktree' || !options.projectId || !options.worktreeId)
    return { ok: false, reason: 'scope' };
  // A renderer dispatch names the executor's default event, `dispatch`.
  if (
    options.planId !== undefined ||
    (options.eventName !== undefined && options.eventName !== 'dispatch') ||
    options.eventData !== undefined
  )
    return { ok: false, reason: 'trigger' };
  if (
    options.parentExecutionId !== undefined ||
    (options.depth ?? 0) > 0 ||
    (options.childPipelineAuthorizations?.length ?? 0) > 0
  )
    return { ok: false, reason: 'nested' };
  if (
    options.pipelinePackage !== undefined ||
    options.pipelinePackageOverlay !== undefined
  )
    return { ok: false, reason: 'package' };
  // Host steps go to the daemon only when this app spawned it and holds the
  // desktop host the run's steps are applied with (CAN-5771); Claude and
  // Codex model steps only when this app owns it and answers their owner
  // requests (CAN-5095).
  const ownerPossible = isDaemonPipelineOwnerPossible();
  const aliases = ownerPossible
    ? await resolveLaunchModelAliases(pipeline, options)
    : undefined;
  const collections = ownerPossible
    ? await resolveLaunchPluginCollections(pipeline, options)
    : undefined;
  const classification = classifyDaemonPipeline(
    pipeline,
    {
      runtime: options.runtime,
      repoPath: options.repoPath ?? options.cwd,
      ...(aliases && { modelAliases: aliases.resolutions }),
      ...(collections && {
        pluginCollections: new Set(Object.keys(collections.snapshots)),
      }),
      // A step's model may name a run input (CAN-6012).
      ...(ownerPossible && {
        inputs: resolveDaemonPipelineInputs(pipeline, options.inputs),
      }),
      // An action's model preference variable comes from the run's env (CAN-6012).
      ...(ownerPossible && options.env && { env: options.env }),
    },
    {
      hostSteps:
        ownerPossible &&
        desktopPipelineHostActionsOf(options.runtime) !== undefined
          ? 'owner'
          : 'refuse',
      modelSteps: ownerPossible ? 'claude_codex' : 'refuse',
      commitHooks: ownerPossible ? 'owner' : 'refuse',
    },
  );
  if (!classification.eligible)
    return { ok: false, reason: classification.reason };
  const hasModelSteps = classification.modelSteps > 0;
  // D6: the terminal worker runs in Electron main. Plugin collection and
  // model alias preferences reach the host in the launch (CAN-5832).
  if (hasModelSteps && options.agentTerminalMode === true)
    return { ok: false, reason: 'terminal_mode' };
  const inputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.inputs ?? {})) {
    if (typeof value !== 'string') return { ok: false, reason: 'limits' };
    inputs[name] = value;
  }
  const candidate: Record<string, unknown> = {
    pipeline,
    cwd: options.cwd,
    bundledActionsDir: options.runtime.bundledActionsDir,
    repoPath: options.repoPath,
    pipelineFileDir: options.pipelineFileDir,
    pipelineDataDir: options.pipelineDataDir,
    assetsDir: options.assetsDir,
    assetPaths: options.assetPaths,
    executionCheckoutRoot: options.executionCheckoutRoot,
    target: options.target,
    pipelinePreferenceLocator: options.pipelinePreferenceLocator,
    sharedPipelineSource: options.sharedPipelineSource,
    curatedPipelineSource: options.curatedPipelineSource,
    initiator: options.initiator,
    agentOrigin: options.agentOrigin,
    env: {
      ...(options.env ?? {}),
      // UI-automation seam: an E2E build gives daemon model steps the mock LLM
      // route its in-process step environment carries; production folds it out.
      ...(hasModelSteps && resolveAnthropicMockEnvOverride()),
    },
    ...(options.inputs !== undefined && { inputs }),
    nodeProcess: {
      command: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
    secretEnv: {},
    ...(((classification.hostSteps ?? 0) > 0 || hasModelSteps) && {
      ownerBound: true,
    }),
    ...(hasModelSteps &&
      modelStepLaunch(options, classification, aliases?.agents === true)),
    ...(hasModelSteps &&
      aliases && {
        ...(aliases.preferences && {
          modelAliasPreferences: aliases.preferences,
        }),
        modelAliasResolutions: aliases.resolutions,
      }),
    ...(hasModelSteps &&
      collections && {
        ...(options.pluginCollectionPreferences !== undefined && {
          pluginCollectionPreferences: options.pluginCollectionPreferences,
        }),
        pluginCollectionSnapshots: collections.snapshots,
      }),
  };
  // Only defined members cross; JSON drops nothing else the schema admits.
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate))
    if (value !== undefined) defined[key] = value;
  const parsed = WorkerPipelineHostLaunchSchema.safeParse(
    JSON.parse(JSON.stringify(defined)),
  );
  const processEnvironment = daemonPipelineProcessEnvironment();
  if (
    !parsed.success ||
    !CanopyChildEnvironmentSchema.safeParse(processEnvironment).success
  )
    return { ok: false, reason: 'limits' };
  const worktreePath =
    options.target?.scope === 'worktree' ? options.target.path : options.cwd;
  if (!isDaemonPipelineLaunchInRoots(parsed.data, worktreePath))
    return { ok: false, reason: 'roots' };
  const { secretEnv: _secretEnv, ...pipelineLaunch } = parsed.data;
  void _secretEnv;
  return { ok: true, launch: { pipelineLaunch, processEnvironment } };
}

/**
 * Whether `error` means the daemon could not be reached; records the
 * background service warning when it does.
 */
export function noteDaemonPipelineFallback(error: unknown): boolean {
  const reason = daemonUnreachableReason(error);
  if (reason === null) return false;
  getElectronDaemonHealth().noteFallback('pipelines', reason);
  return true;
}

const owner = new AbortController();

/** Main's own workflow session with the daemon, under its verified authority. */
async function client(): Promise<ElectronDaemonClient> {
  getElectronDaemonHealth().setConsumerEnabled('pipelines', true);
  const { authorityId } = await getElectronDaemonFilesContext();
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-main:pipelines',
    authorityId,
    interfaceKind: 'desktop',
    grants: [WORKER_PIPELINE_GRANTS.read, WORKER_PIPELINE_GRANTS.write],
  };
  return (await getElectronDaemonConnections().get(caller, owner.signal))
    .client;
}

/** A daemon run's step notifications, shown in its space as an in-process run's are (CAN-5868). */
async function daemonPipelineNotifications(): Promise<
  (state: ExecutionState) => (notification: PipelineStepNotification) => void
> {
  const [{ deliverPipelineStepNotifications }, { getMainWindow }] =
    await Promise.all([
      import('./execution-runtime-hooks'),
      import('../lib/main-window-focus'),
    ]);
  return (state) => (notification) => {
    deliverPipelineStepNotifications(
      [notification],
      { projectId: state.project_id, worktreeId: state.worktree_id },
      getMainWindow,
    );
  };
}

/**
 * A followed run's `git-commit-push` hook scope (CAN-6012 D3): its stored
 * worktree, the one its notifications use. A run without one runs no hook.
 */
async function daemonCommitHooks(state: ExecutionState): Promise<
  | {
      readonly scope: DaemonCommitHookScope;
      readonly getWindow: () => BrowserWindow | null;
    }
  | undefined
> {
  if (!state.project_id || !state.worktree_id) return undefined;
  const { getMainWindow } = await import('../lib/main-window-focus');
  return {
    scope: { projectId: state.project_id, worktreeId: state.worktree_id },
    getWindow: getMainWindow,
  };
}

/**
 * Runs the precommit-failure hook for commit results of daemon runs this app
 * sent that settled while nothing followed them (CAN-6012 D3): at startup,
 * after the surviving runs are followed again, and before a recovery control
 * takes a run over in the app.
 */
export async function catchUpDaemonCommitHooksFor(
  executionIds: readonly string[],
  executionsDir: string,
): Promise<readonly string[]> {
  return catchUpDaemonCommitHooks({
    executionIds,
    executionsDir,
    load: (executionId) => loadExecutionState(executionId, executionsDir),
    scopeOf: daemonCommitHooks,
  });
}

export const DAEMON_COMMIT_HOOK_TAKEOVER_REFUSED_MESSAGE =
  'This workflow run still has commit hooks to check. Try again in a moment.';

/**
 * Before the app takes a daemon run over (resume or retry in process), every
 * commit result the daemon left unclaimed is drained; a drain that fails
 * refuses the takeover, so in-process hooks never run beside unclaimed ones.
 */
export async function drainDaemonCommitHooksBeforeTakeover(
  executionId: string,
  executionsDir: string,
  drain: typeof catchUpDaemonCommitHooksFor = catchUpDaemonCommitHooksFor,
): Promise<void> {
  const failed = await drain([executionId], executionsDir);
  if (failed.length > 0)
    throw new Error(DAEMON_COMMIT_HOOK_TAKEOVER_REFUSED_MESSAGE);
}

/** Opens a run's `worker.pipeline.execution.events` on the daemon. */
async function openDaemonPipelineEvents(
  target: ElectronDaemonClient,
  executionId: string,
  onFrame: (frame: DaemonPipelineEventsFrame) => void,
): Promise<DaemonPipelineEventsSubscription> {
  const stream = await target.openStream('worker.pipeline.execution.events', {
    executionId,
  });
  stream.onFrame(onFrame);
  return { close: (): void => stream.close() };
}

function clientErrorCode(error: unknown): string | undefined {
  return error instanceof CanopyClientError ? error.payload.code : undefined;
}

/** A reached daemon's refusal, as the operation's answer. */
function answerOf(error: unknown): unknown {
  return error instanceof CanopyClientError
    ? new CanopyOperationError(error.payload, error)
    : error;
}

/** The caller fields an owner-bound run's host steps are applied with (CAN-5771). */
function hostStepsContext(
  options: ExecutionOptions,
  pipelineName: string | undefined,
): DaemonPipelineHostStepsTarget['hostSteps']['context'] {
  return {
    ...(options.pipelineId !== undefined && {
      pipelineId: options.pipelineId,
    }),
    ...(pipelineName !== undefined && { pipelineName }),
    ...(options.executionContext !== undefined && {
      executionContext: options.executionContext,
    }),
    ...(options.initiationSource !== undefined && {
      initiationSource: options.initiationSource,
    }),
    ...(options.agentOrigin !== undefined && {
      agentOrigin: options.agentOrigin,
    }),
    ...(options.initiator !== undefined && { initiator: options.initiator }),
  };
}

/** Where a routed start went: the daemon, or back to in process (D13). */
export type DaemonPipelineStartResult =
  | { readonly kind: 'daemon'; readonly handle: DaemonPipelineExecutionHandle }
  | { readonly kind: 'in_process' };

/** Start a staged daemon launch, or report that it must run in process (D13); recorded once (CAN-5093). */
export function startPipelineInDaemon(
  args: Parameters<typeof startPipelineRoute>[0],
): Promise<DaemonPipelineStartResult> {
  return recordDaemonRouteDecision('workflows', (note) =>
    startPipelineRoute(args, note),
  );
}

async function startPipelineRoute(
  args: {
    readonly params: WorkerPipelineExecutionStartParams;
    readonly launch: DaemonPipelineLaunch;
    readonly secrets: RedeemedExecutionSecrets;
    readonly options: ExecutionOptions;
  },
  note: DaemonRouteNote<'workflows'>,
): Promise<DaemonPipelineStartResult> {
  const { params, launch, secrets, options } = args;
  if (!CanopyChildEnvironmentSchema.safeParse(secrets.env).success) {
    note('environment');
    return { kind: 'in_process' };
  }
  const ownerBound = launch.pipelineLaunch.ownerBound === true;
  const hostActions = desktopPipelineHostActionsOf(options.runtime);
  if (ownerBound) {
    if (!hostActions) {
      note('host_actions');
      return { kind: 'in_process' };
    }
    // Nothing was sent: an owner that cannot settle is no background warning.
    try {
      await ensureDaemonPipelineOwnerSettlement();
    } catch {
      note('owner_unavailable');
      return { kind: 'in_process' };
    }
  }
  // A host request can come before the start returns: the run's host steps
  // are known from before the send until its mirror is registered.
  const launchName: unknown = launch.pipelineLaunch.pipeline['name'];
  const release =
    ownerBound && hostActions
      ? expectDaemonPipelineHostSteps(params.executionId, {
          executionsDir: options.runtime.executionsDir,
          hostSteps: {
            context: hostStepsContext(
              options,
              typeof launchName === 'string' ? launchName : undefined,
            ),
            actions: hostActions,
          },
        })
      : (): void => undefined;
  // A model step can ask its owner before the start returns (CAN-5095): its
  // run's owner context answers from the start's own scope until it settles.
  const detachOwner = launch.pipelineLaunch.providerBinaries
    ? attachDaemonPipelineOwnerRun({
        executionId: params.executionId,
        scope: () => ({
          ...(options.projectId !== undefined && {
            projectId: options.projectId,
          }),
          ...(options.worktreeId !== undefined && {
            worktreeId: options.worktreeId,
          }),
          ...(options.executionContext !== undefined && {
            executionContext: options.executionContext,
          }),
          folder: options.executionCheckoutRoot ?? options.cwd,
        }),
        secretValues: getSecretValues(secrets.env),
      })
    : undefined;
  let handedOff = false;
  try {
    let session: ElectronDaemonClient;
    try {
      session = await client();
    } catch (error) {
      if (noteDaemonPipelineFallback(error)) {
        note('unreachable');
        return { kind: 'in_process' };
      }
      throw error;
    }
    const { secrets: _bindings, ...paramsWithoutSecrets } = params;
    void _bindings;
    const send = (
      target: ElectronDaemonClient,
    ): Promise<WorkerPipelineExecutionResult> =>
      target.instruction(
        'worker.pipeline.execution.start',
        paramsWithoutSecrets,
        {
          metadata: { idempotencyKey: params.executionId },
          execution: {
            childEnvironment: { ...launch.processEnvironment },
            pipelineLaunch: {
              ...launch.pipelineLaunch,
              secretEnv: { ...secrets.env },
            },
          },
        },
      );
    // Startup catches up on a commit step that settles while nothing
    // follows the run (CAN-6012 D3); a run that falls back is the app's.
    const commitHooksPending =
      launch.pipelineLaunch.precommitHooks === 'owner' &&
      hasDaemonCommitSteps(launch.pipelineLaunch.pipeline);
    if (commitHooksPending)
      await markDaemonCommitHooksPending(
        options.runtime.executionsDir,
        params.executionId,
      );
    const fallBack = async (): Promise<{ kind: 'in_process' }> => {
      if (commitHooksPending)
        await clearDaemonCommitHooksPending(
          options.runtime.executionsDir,
          params.executionId,
        );
      return { kind: 'in_process' };
    };
    try {
      await send(session);
    } catch (error) {
      if (clientErrorCode(error) === 'worker.pipeline.hostUnavailable') {
        getElectronDaemonHealth().noteFallback('pipelines', 'host_unavailable');
        note('host_unavailable');
        return fallBack();
      }
      // The daemon saw no owner subscription and ran nothing (CAN-5771).
      if (clientErrorCode(error) === 'worker.pipeline.ownerUnavailable') {
        note('owner_unavailable');
        return fallBack();
      }
      const dropped =
        session.signal.aborted && !owner.signal.aborted
          ? markUnreachable(error, 'connection_lost')
          : error;
      if (daemonUnreachableReason(dropped) === null) throw answerOf(error);
      // The start may have run: resend it once, keyed, never in process.
      try {
        session = await client();
        await send(session);
      } catch (resendError) {
        throw pipelineStartFailedError(resendError);
      }
    }
    // The daemon accepted the start: the run is the daemon's from here.
    note('served');
    const { executionId } = params;
    const executionsDir = options.runtime.executionsDir;
    const state = await loadExecutionState(executionId, executionsDir);
    if (!state)
      throw pipelineStartFailedError(
        new Error('The background workflow run has no stored state.'),
      );
    const host = await import('./pipeline-worker-host');
    const dispatch = await import('./pipeline-worker-dispatch');
    const notifications = await daemonPipelineNotifications();
    const openEvents = async (
      onFrame: (frame: DaemonPipelineEventsFrame) => void,
    ): Promise<DaemonPipelineEventsSubscription> =>
      openDaemonPipelineEvents(
        session.signal.aborted ? await client() : session,
        executionId,
        onFrame,
      );
    const handle = new DaemonPipelineExecutionHandle({
      executionId,
      initialState: state,
      executionsDir,
      openEvents,
      cancel: (): Promise<WorkerPipelineExecution> =>
        cancelPipelineInDaemon(executionId, 'finalize'),
      deliverEvent: (event): void =>
        host.deliverDaemonPipelineEvent(event, { executionsDir }),
      deliverOutput: (event): void => host.deliverDaemonPipelineOutput(event),
      deliverNotification: notifications(state),
      commitHooks: await daemonCommitHooks(state),
      sweep: async (id): Promise<void> => {
        await dispatch.sweepOrphanedPipelinesThroughLocalWorker([id]);
      },
      ...(options.runtime.lifecycle && {
        lifecycle: options.runtime.lifecycle,
      }),
      ...(ownerBound &&
        hostActions && {
          ownerBound: true,
          hostSteps: {
            context: hostStepsContext(options, state.pipeline_snapshot.name),
            actions: hostActions,
          },
        }),
      ...(detachOwner && { detachOwner }),
    });
    handedOff = true;
    registerDaemonPipelineExecution(handle);
    if (options.onEvent || options.onStepOutput)
      handle.addObservers({
        ...(options.onEvent && { onEvent: options.onEvent }),
        ...(options.onStepOutput && { onStepOutput: options.onStepOutput }),
      });
    try {
      await options.beforeStart?.(state);
    } finally {
      // The run is in the daemon either way; keep following it.
      handle.follow();
    }
    return { kind: 'daemon', handle };
  } finally {
    release();
    // A start that never reached a mirror releases what its steps were given.
    if (!handedOff) void detachOwner?.(null);
  }
}

/** Cancel or drain a daemon run Electron main follows (D11). */
export async function cancelPipelineInDaemon(
  executionId: string,
  mode: WorkerPipelineCancelMode,
): Promise<WorkerPipelineExecution> {
  try {
    const result = await (
      await client()
    ).instruction(
      'worker.pipeline.execution.cancel',
      { executionId, mode },
      { metadata: { idempotencyKey: randomUUID() } },
    );
    return result.execution;
  } catch (error) {
    const code = clientErrorCode(error);
    if (code === 'worker.pipeline.drainTimedOut')
      throw new PipelineDrainTimeoutError();
    if (code === 'worker.pipeline.executionNotFound')
      throw pipelineExecutionNotFoundError();
    throw answerOf(error);
  }
}

function isLiveOtherProcess(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === 'EPERM';
  }
}

/**
 * Runs an earlier launch left running under another live owner, such as the
 * daemon's pipeline host, stay active work after a restart (CAN-5086). Main
 * reopens each one's events on the daemon, so its output and step events
 * stream again (CAN-5869); a run the daemon is not running, or any run on a
 * host without daemon workflows, is followed through the store until it
 * settles.
 */
export async function followSurvivingDaemonRuns(
  executionIds: readonly string[],
  executionsDir: string,
): Promise<void> {
  const host = await import('./pipeline-worker-host');
  const dispatch = await import('./pipeline-worker-dispatch');
  const notifications = await daemonPipelineNotifications();
  const daemonServes = isDaemonPipelinePlatformEligible(hostPlatform());
  for (const executionId of executionIds) {
    const state = await loadExecutionState(executionId, executionsDir).catch(
      () => null,
    );
    if (
      !state ||
      (state.status !== 'running' && state.status !== 'pending') ||
      !isLiveOtherProcess(state.owner_pid)
    )
      continue;
    const handle = new DaemonPipelineExecutionHandle({
      executionId,
      initialState: state,
      executionsDir,
      ...(daemonServes && {
        openEvents: async (
          onFrame: (frame: DaemonPipelineEventsFrame) => void,
        ): Promise<DaemonPipelineEventsSubscription> =>
          openDaemonPipelineEvents(await client(), executionId, onFrame),
      }),
      cancel: (): Promise<WorkerPipelineExecution> =>
        cancelPipelineInDaemon(executionId, 'finalize'),
      deliverEvent: (event): void =>
        host.deliverDaemonPipelineEvent(event, { executionsDir }),
      deliverOutput: (event): void => host.deliverDaemonPipelineOutput(event),
      deliverNotification: notifications(state),
      // Only a run this app marked is its to hook (CAN-6012 D3).
      ...((await hasDaemonCommitHooksPending(executionsDir, executionId)) && {
        commitHooks: await daemonCommitHooks(state),
      }),
      sweep: async (id): Promise<void> => {
        await dispatch.sweepOrphanedPipelinesThroughLocalWorker([id]);
      },
      // A resumed run skips the start lifecycle, so it takes only the wake
      // lock that start would have taken.
      lifecycle: {
        onExecutionSettled: getExecutionAccounting().keepAwake(
          'pipeline',
          executionId,
        ),
      },
    });
    registerDaemonPipelineExecution(handle);
    handle.follow({ resumed: true });
  }
}
