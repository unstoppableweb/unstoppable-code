import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { ConnectedExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import type {
  PipelineHostControl,
  PipelineHostErrorCode,
  PipelineHostLauncherCommand,
  PipelineHostLaunch,
  PipelineHostMessage,
  PipelineHostRequest,
  PipelineHostRequestMessage,
} from '@canopy/core-runtime/node/pipeline/host';
import type {
  WorkerPipelineHostRequest,
  WorkerPipelineLaunchEvent,
} from '@canopy/protocol/canopy-core';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type {
  ExecutionState,
  Pipeline,
  PipelinePauseResponse,
  PipelinePreferenceLocator,
  ResolvedPipelineExecutionTarget,
} from '@canopy/execution-engine/types/pipeline';
import { setBrandEnv } from '@canopy/execution-engine/brand/env';
import { applyModelRegistrySnapshot } from '@canopy/execution-engine/builtin-actions/_lib/model-registry';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { normalizeAgentModelConfig } from '@canopy/execution-engine/execution-types';
import {
  classifyDaemonPipeline,
  resolveDaemonPipelineInputs,
} from '../daemon-eligibility';
import { normalizeExecutionModelAliasPreferences } from '../executor/model-alias-preferences';
import { normalizePipelinePluginCollectionPreferences } from '../plugin-collection-store';
import { parseLaunchPluginCollections } from './plugin-collections';
import { listPipelineExecutionPage } from '../execution-list';
import {
  projectPipelineExecution,
  projectPipelineExecutionView,
} from '@canopy/execution-engine/node/pipelines/execution-projection';
import {
  cancelPipelineExecution,
  executePipeline,
  rerunPipelineExecution,
  resumePipeline,
  retryPipelineExecution,
} from '../executor';
import { recoverOrphanedPipelineExecutions } from '../executor/crash-recovery';
import {
  listExecutionSummaries,
  loadExecutionState,
  normalizeAgentChatAddress,
  normalizeCuratedPipelineSource,
  normalizeExecutionInitiator,
  normalizeSharedPipelineSource,
  requestExecutionCancellation,
} from '../executor/execution-state';
import {
  configurePipelineOwnerFence,
  createLeasePipelineOwnerFence,
  installPipelineOwnerFence,
  type PipelineLeaseOwnerFence,
  type PipelineOwnerInspector,
} from '@canopy/execution-engine/node/pipelines/executor/owner-fence';
import type {
  ExecutionHandle,
  ExecutionOptions,
  ExecutionResourceMonitor,
  ExecutionResourceRegistrationHandle,
  ExecutionRuntime,
} from '../executor/types';
import {
  createDaemonHostStepPort,
  type DaemonHostStepPort,
} from './host-steps';
import type { CodexRuntimeService } from '../../codex-runtime';
import {
  acquireDaemonPipelineCodexRuntime,
  shutdownDaemonPipelineCodexRuntime,
} from './codex-runtime';
import {
  createPipelineOwnerClient,
  type PipelineOwnerClientHost,
} from './owner-client';
import {
  createDaemonPipelineOwnerPorts,
  createDaemonPipelinePlanPorts,
  createDaemonPrecommitReporter,
} from './owner-ports';
import { createDaemonPipelineRuntime } from './runtime';
import { codexServablePluginCollections } from './codex-plugin-mcp';
import {
  createPipelineHostMemoryReader,
  isPipelineHostMemoryBudget,
} from './memory';

export interface ServePipelineHostOptions {
  readonly channel: ConnectedExecutionHostChannel;
  /** Process start identity for the owner fence; null on hosts that cannot prove it. */
  readonly inspectProcess: PipelineOwnerInspector | null;
}

const DRAIN_TIMEOUT_MS = 10_000;
/** How long runs get to pause once the core is lost before their steps are killed (CAN-6481). */
const CORE_LOSS_DRAIN_MS = 5_000;
/** When a host that lost its core exits regardless (CAN-6481). */
const CORE_LOSS_EXIT_MS = 15_000;
/**
 * How long a step's process group is kept after its leader exits, for
 * descendants that outlive it, unless its run ends first (CAN-6481). Short,
 * so a group id the system has since reused is never signalled.
 */
const RETIRED_PROCESS_GROUP_MS = 60_000;

const TERMINAL: ReadonlySet<ExecutionState['status']> = new Set<
  ExecutionState['status']
>(['success', 'failure', 'cancelled']);

function isSettled(state: ExecutionState): boolean {
  return state.status === 'paused' || TERMINAL.has(state.status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestMessage(value: unknown): value is PipelineHostRequestMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    isRecord(value.request) &&
    typeof value.request.op === 'string'
  );
}

/** A remote owner's owner-request floor, when it is one (CP-11). */
function positiveDeadline(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/** One line on stderr, without the launch, environment or inputs. */
function warn(message: string): void {
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', message, details: null })}\n`,
  );
}

function eventFor(state: ExecutionState): string {
  if (state.status === 'cancelled') return 'execution.cancelled';
  if (state.status === 'failure') return 'execution.failed';
  if (state.status === 'success') return 'execution.completed';
  if (state.status === 'paused') return 'execution.paused';
  return 'execution.updated';
}

/** A launch's preference locator; anything else is dropped. */
/**
 * A launch's trigger event as the executor takes it (CAN-6327): the text
 * goes in as `plan_text` or `task_text`, which the executor writes into the
 * run's own folder and hands the steps as `plan_path` or `task_path`.
 */
function launchEventOptions(
  event: WorkerPipelineLaunchEvent,
): Pick<ExecutionOptions, 'eventName' | 'eventData'> {
  return event.name === 'plan_ready'
    ? {
        eventName: 'plan_ready',
        eventData: {
          plan_ready: {
            plan_text: event.planText,
            ...(event.planId !== undefined && { planId: event.planId }),
          },
        },
      }
    : {
        eventName: 'task_ready',
        eventData: { task_ready: { task_text: event.taskText } },
      };
}

function parsePreferenceLocator(
  value: unknown,
): PipelinePreferenceLocator | undefined {
  if (!isRecord(value) || typeof value.value !== 'string') return undefined;
  const locatorValue = value.value;
  if (value.type === 'file' || value.type === 'shared')
    return { type: value.type, value: locatorValue };
  if (
    value.type !== 'stored' ||
    (value.source !== 'bundled' &&
      value.source !== 'user' &&
      value.source !== 'curated')
  )
    return undefined;
  return {
    type: 'stored',
    source: value.source,
    value: locatorValue,
    ...(typeof value.contentHash === 'string' && {
      contentHash: value.contentHash,
    }),
  };
}

/** Whether `dataRoot` is the data root this host resolves for itself. */
async function isOwnDataRoot(dataRoot: string): Promise<boolean> {
  try {
    const [own, sent] = await Promise.all([
      realpath(getCanopyDataDir()),
      realpath(dataRoot),
    ]);
    return own === sent;
  } catch {
    return false;
  }
}

/**
 * How a launch begins: a start runs it fresh; a recovery control runs a
 * stored run again with the launch's runtime and options (CAN-6103).
 */
interface LaunchRun {
  readonly begin: (
    pipeline: Pipeline,
    options: ExecutionOptions,
  ) => Promise<ExecutionHandle>;
  /** The host's answer for the run it began. */
  readonly answer: (state: ExecutionState) => unknown;
  /** What the host answers when the executor refuses it. */
  readonly refused: PipelineHostErrorCode;
}

const START: LaunchRun = {
  begin: (pipeline, options) => executePipeline(pipeline, options),
  answer: projectPipelineExecution,
  refused: 'start_failed',
};

/** A control's answer for the run it started (CAN-6103). */
function controlStarted(state: ExecutionState): unknown {
  return { outcome: 'started', execution: projectPipelineExecution(state) };
}

/** The options a replay takes: the launch's, without what it reads from the stored run. */
function replayOptionsOf(
  options: ExecutionOptions,
): Omit<
  ExecutionOptions,
  | 'pipelineId'
  | 'executionId'
  | 'inputs'
  | 'eventName'
  | 'eventData'
  | 'projectId'
  | 'worktreeId'
  | 'parentExecutionId'
  | 'parentStepId'
  | 'parentAttempt'
> {
  const {
    pipelineId: _pipelineId,
    executionId: _executionId,
    inputs: _inputs,
    eventName: _eventName,
    eventData: _eventData,
    projectId: _projectId,
    worktreeId: _worktreeId,
    parentExecutionId: _parentExecutionId,
    parentStepId: _parentStepId,
    parentAttempt: _parentAttempt,
    ...rest
  } = options;
  void [
    _pipelineId,
    _executionId,
    _inputs,
    _eventName,
    _eventData,
    _projectId,
    _worktreeId,
    _parentExecutionId,
    _parentStepId,
    _parentAttempt,
  ];
  return rest;
}

/** The executor's pause answers for a control's (CAN-4141). */
function pauseResponsesOf(
  control: Extract<
    PipelineHostControl,
    { operation: 'worker.pipeline.execution.resume' }
  >,
): PipelinePauseResponse[] | undefined {
  return control.params.pauseResponses?.map((response) => ({
    ...(response.checkpointId !== undefined && {
      checkpoint_id: response.checkpointId,
    }),
    job_id: response.jobId,
    step_id: response.stepId,
    ...(response.answers && { answers: response.answers }),
  }));
}

/**
 * The named pauses still current on a run, for a resume that answers
 * `stale_noop` when none is; every pause when it names none (CAN-4141).
 */
function currentReasonIds(
  state: ExecutionState,
  reasonIds: readonly string[] | undefined,
): string[] | undefined {
  if (!reasonIds) return undefined;
  const current = new Set(state.status_reasons.map((reason) => reason.id));
  if (state.shutdown_checkpoint) current.add(state.shutdown_checkpoint.id);
  return reasonIds.filter((reasonId) => current.has(reasonId));
}

interface LiveRun {
  readonly handle: ExecutionHandle;
  readonly runtime: ExecutionRuntime;
  /** Withdraws the run's pending owner requests (CAN-5095). */
  readonly ownerRequests?: AbortController;
}

/** Serves one pipeline host over its execution host channel (CAN-5086). */
export function servePipelineHost(options: ServePipelineHostOptions): void {
  const { channel } = options;
  let executionsDir: string | null = null;
  let admissionOpen = true;
  /** Set once the core is lost (CAN-6481): step groups are kept for the kill pass. */
  let coreLossStarted = false;
  let lastBundledActionsDir = '';
  const runs = new Map<string, LiveRun>();
  const exitRequests: number[] = [];
  /** Starts admitted but not yet answered; checkpoint and exit wait for them. */
  const admitting = new Set<Promise<void>>();
  /**
   * Each run until its executor settles. A run leaves `runs` on its outcome
   * event but still writes under the data root until then; checkpoint and
   * exit wait for it.
   */
  const finishing = new Map<ExecutionHandle, Promise<void>>();
  /**
   * Executions a start or a recovery control is admitting (CAN-6103), with
   * when it settles: two never launch an executor for the same execution,
   * and a cancel waits for the run it would otherwise miss.
   */
  const claimed = new Map<string, Promise<void>>();
  /** Runs `work` with `executionIds` claimed; false when one already is. */
  const claiming = async (
    executionIds: readonly string[],
    work: () => Promise<void>,
  ): Promise<boolean> => {
    if (executionIds.some((executionId) => claimed.has(executionId)))
      return false;
    const done = work();
    const settled = done.then(
      () => undefined,
      () => undefined,
    );
    for (const executionId of executionIds) claimed.set(executionId, settled);
    try {
      await done;
    } finally {
      for (const executionId of executionIds)
        if (claimed.get(executionId) === settled) claimed.delete(executionId);
    }
    return true;
  };
  /** Executions started `ownerBound`; only they take host steps and `pause` (CAN-5771). */
  const ownerBound = new Set<string>();
  let hostSteps: DaemonHostStepPort | null = null;
  /** Owner requests of model steps (CAN-5095). */
  let ownerRequests: PipelineOwnerClientHost | null = null;
  /** A remote owner's lease TTL, the least a short owner request waits (CP-11). */
  let ownerRequestDeadlineMs: number | undefined;
  let codexMcpLauncher: PipelineHostLauncherCommand | null = null;
  /** A cloud runner's lease fence (CAN-6198); null under the local fence. */
  let leaseFence: PipelineLeaseOwnerFence | null = null;
  /** Whether this runner incarnation's lease lapsed or was superseded. */
  const fenced = (): boolean =>
    leaseFence !== null && leaseFence.state() !== 'held';
  let dataRoot: string | null = null;
  /** The provider CLIs the host's first model-step launch named (D21). */
  let providerBinaries: { claude: string; codex: string } | null = null;
  let bundledResourcesDir: string | null = null;
  /** A sized host's memory, as configured (CAN-6325); null holds no step. */
  let readMemory: ReturnType<typeof createPipelineHostMemoryReader> | null =
    null;

  const post = (message: PipelineHostMessage): void => {
    channel.postMessage(message);
  };
  const respond = (id: number, value: unknown): void => {
    post({ kind: 'response', id, ok: true, value });
  };
  /** Tells the run's streams about a state no executor event reported. */
  const publish = (executionId: string, state: ExecutionState): void => {
    post({
      kind: 'execution',
      executionId,
      event: eventFor(state),
      execution: projectPipelineExecution(state),
    });
  };
  const fail = (id: number, code: PipelineHostErrorCode): void => {
    post({
      kind: 'response',
      id,
      ok: false,
      error: { code, message: 'The pipeline host refused the request.' },
    });
  };

  /**
   * Each step process group, so a lost core leaves none behind (CAN-6481):
   * kept while its leader runs, then briefly for descendants that outlive
   * it, and dropped when its run ends.
   */
  const processGroups = new Map<
    string,
    { readonly group: number; readonly executionId: string | undefined }
  >();
  const resourceMonitor: ExecutionResourceMonitor = {
    registerProcess(registration): ExecutionResourceRegistrationHandle {
      const processGroupId = registration.processGroupId ?? registration.pid;
      if (processGroupId === undefined)
        return { update(): void {}, unregister(): void {} };
      processGroups.set(registration.id, {
        group: processGroupId,
        executionId:
          registration.metadata?.type === 'pipeline'
            ? registration.metadata.pipeline.executionId
            : undefined,
      });
      post({
        kind: 'process',
        state: 'started',
        id: registration.id,
        processGroupId,
      });
      let exited = false;
      return {
        update(): void {},
        unregister(): void {
          if (exited) return;
          exited = true;
          setTimeout(() => {
            if (!coreLossStarted) processGroups.delete(registration.id);
          }, RETIRED_PROCESS_GROUP_MS).unref();
          post({ kind: 'process', state: 'exited', id: registration.id });
        },
      };
    },
    registerWorkItem(): ExecutionResourceRegistrationHandle {
      return { update(): void {}, unregister(): void {} };
    },
    readMemory: () => (readMemory ? readMemory() : Promise.resolve(undefined)),
  };

  const settleExits = (): void => {
    if (runs.size > 0 || admitting.size > 0 || finishing.size > 0) return;
    const pending = exitRequests.splice(0);
    if (pending.length === 0) return;
    void shutdownDaemonPipelineCodexRuntime()
      .catch(() => warn('The pipeline host could not stop its Codex runtime.'))
      .finally(() => {
        for (const id of pending) respond(id, null);
        channel.exit(0);
      });
  };

  /** Points the host's provider CLIs at the app's own, once (D21); false for other paths. */
  const useProviderBinaries = (binaries: {
    claude: string;
    codex: string;
  }): boolean => {
    if (providerBinaries)
      return (
        providerBinaries.claude === binaries.claude &&
        providerBinaries.codex === binaries.codex
      );
    providerBinaries = { ...binaries };
    setBrandEnv(process.env, 'CLAUDE_BINARY_PATH', binaries.claude);
    setBrandEnv(process.env, 'CODEX_BINARY_PATH', binaries.codex);
    return true;
  };

  /** Points the host's builtin skills at the app's own resources, once (CAN-5832); false for another folder. */
  const useBundledResources = (dir: string): boolean => {
    if (bundledResourcesDir !== null) return bundledResourcesDir === dir;
    bundledResourcesDir = dir;
    setBrandEnv(process.env, 'BUNDLED_RESOURCES_DIR', dir);
    return true;
  };

  const forget = (executionId: string, handle: ExecutionHandle): void => {
    if (runs.get(executionId)?.handle !== handle) return;
    runs.delete(executionId);
    ownerBound.delete(executionId);
    // Once the core is lost every group stays for its kill pass, including
    // those of runs that finish pausing first.
    if (!coreLossStarted)
      for (const [id, entry] of processGroups)
        if (entry.executionId === executionId) processGroups.delete(id);
    settleExits();
  };

  const runtimeFor = (dir: string, executionId: string): ExecutionRuntime =>
    runs.get(executionId)?.runtime ??
    createDaemonPipelineRuntime({
      executionsDir: dir,
      bundledActionsDir: lastBundledActionsDir,
      processEnvironment: {},
    });

  const start = async (
    id: number,
    dir: string,
    hostLaunch: PipelineHostLaunch,
    run: LaunchRun = START,
  ): Promise<void> => {
    if (!admissionOpen || fenced()) return fail(id, 'closed');
    const { params, launch, processEnvironment } = hostLaunch;
    // The daemon sends only worktree runs it verified (D6, D17); a cloud
    // runner also sends global and directory runs (CAN-6173). A worktree run
    // names its workspace and worktree; the others name neither.
    const worktree =
      params.runScope === 'worktree' &&
      params.workspaceId !== null &&
      params.worktreeId !== null
        ? {
            workspaceId: params.workspaceId,
            worktreeId: params.worktreeId,
            path: launch.cwd,
          }
        : null;
    if (
      params.runScope === 'worktree'
        ? worktree === null
        : params.workspaceId !== null || params.worktreeId !== null
    )
      return fail(id, 'start_failed');
    const target: ResolvedPipelineExecutionTarget = worktree
      ? {
          scope: 'worktree',
          workspace_id: worktree.workspaceId,
          worktree_id: worktree.worktreeId,
          path: worktree.path,
          created: false,
        }
      : params.runScope === 'global'
        ? { scope: 'global' }
        : { scope: 'directory', path: launch.cwd };
    lastBundledActionsDir = launch.bundledActionsDir;
    const isOwnerBound = launch.ownerBound === true;
    const launcher = codexMcpLauncher;
    const configuredRoot = dataRoot ?? path.dirname(dir);
    const runOwnerRequests = isOwnerBound ? new AbortController() : undefined;
    // The run's collections as its core resolved them (CAN-5832); a snapshot
    // that does not parse refuses the launch.
    const pluginCollections =
      isOwnerBound && launch.pluginCollectionSnapshots
        ? parseLaunchPluginCollections(launch.pluginCollectionSnapshots)
        : undefined;
    if (pluginCollections === null) return fail(id, 'start_failed');
    const runtime = createDaemonPipelineRuntime({
      executionsDir: dir,
      bundledActionsDir: launch.bundledActionsDir,
      processEnvironment,
      ...(pluginCollections && { pluginCollections }),
      onStepNotifications: (stepId, notifications): void => {
        for (const { title, body } of notifications)
          post({
            kind: 'notification',
            executionId: params.executionId,
            stepId,
            title,
            body,
          });
      },
      ...(launch.nodeProcess && { nodeProcess: launch.nodeProcess }),
      ...(launch.tsxRuntime && { tsxCli: launch.tsxRuntime }),
      resourceMonitor,
      ...(worktree && { worktree }),
      ...(isOwnerBound && hostSteps && { pipelineHostActions: hostSteps }),
      // A brokered run's pre-commit failures go to its owner (CAN-6739).
      ...(isOwnerBound &&
        ownerRequests &&
        launch.repositoryActions === 'brokered' && {
          reportPrecommitFailures: createDaemonPrecommitReporter(
            ownerRequests,
            {
              executionId: params.executionId,
              owner: params.owner,
              ...(runOwnerRequests && { signal: runOwnerRequests.signal }),
            },
          ),
        }),
      // A plan or task run's plan writes go to its owner (CAN-6327).
      ...(isOwnerBound &&
        ownerRequests &&
        launch.event && {
          plans: createDaemonPipelinePlanPorts(ownerRequests, {
            executionId: params.executionId,
            owner: params.owner,
          }),
        }),
      // Model ports only for a launch with model steps: Electron main answers
      // owner requests only for those (CAN-5095), and every other step must
      // not wait on it, as an unbound launch does not.
      ...(isOwnerBound &&
        ownerRequests &&
        launch.providerBinaries && {
          owner: createDaemonPipelineOwnerPorts(ownerRequests, {
            executionId: params.executionId,
            owner: params.owner,
            ...(runOwnerRequests && { signal: runOwnerRequests.signal }),
            // A remote owner (a cloud runner's web core, CAN-6422) arrives
            // with a lease fence or an owner deadline: its Feed tools run
            // here, over owner.ledger.operation.
            ...((leaseFence !== null ||
              ownerRequestDeadlineMs !== undefined) && {
              remoteLedgerTools: true,
            }),
            ...(launch.codexEnvironment && {
              codexEnvironment: launch.codexEnvironment,
            }),
          }),
          ...(launcher && {
            codexRuntime: (): CodexRuntimeService =>
              acquireDaemonPipelineCodexRuntime({
                dataRoot: configuredRoot,
                mcpLauncher: launcher,
                onProcess: (event) => post({ kind: 'process', ...event }),
              }),
          }),
        }),
    });
    let pipeline: Pipeline;
    try {
      pipeline = parsePipelineText(JSON.stringify(launch.pipeline));
    } catch {
      return fail(id, 'start_failed');
    }
    // Model steps resolve against their core's model registry; a later launch's wins.
    if (
      isOwnerBound &&
      launch.modelCatalog &&
      !applyModelRegistrySnapshot(launch.modelCatalog)
    )
      return fail(id, 'start_failed');
    const classification = classifyDaemonPipeline(
      pipeline,
      {
        runtime,
        repoPath: launch.repoPath ?? launch.cwd,
        // The run's aliases as its core resolved them at launch (CAN-5832).
        ...(isOwnerBound &&
          launch.modelAliasResolutions && {
            modelAliases: launch.modelAliasResolutions,
          }),
        ...(pluginCollections && {
          pluginCollections: new Set(Object.keys(pluginCollections)),
          // Read here from the snapshots, as the core read them (CAN-6168).
          codexPluginCollections:
            codexServablePluginCollections(pluginCollections),
        }),
        // The run's inputs, resolved as its core and executor do (CAN-6012).
        ...(isOwnerBound && {
          inputs: resolveDaemonPipelineInputs(pipeline, launch.inputs),
        }),
        ...(isOwnerBound && { env: launch.env }),
      },
      {
        hostSteps: isOwnerBound ? 'owner' : 'refuse',
        modelSteps: isOwnerBound ? 'claude_codex' : 'refuse',
        commitHooks:
          isOwnerBound && launch.precommitHooks === 'owner'
            ? 'owner'
            : 'refuse',
        // A cloud runner's sandbox holds the run's GitHub credentials, and
        // this host reports pre-commit failures itself (CAN-6739).
        repositoryActions:
          isOwnerBound && launch.repositoryActions === 'brokered'
            ? 'brokered'
            : 'refuse',
        // The executor resolves a composite's inputs as the classifier does;
        // which runs reach the host is the dispatching core's choice (CAN-6316 G4).
        compositeModels: isOwnerBound ? 'resolve' : 'refuse',
      },
    );
    if (!classification.eligible)
      return fail(
        id,
        classification.reason === 'host_step' ||
          classification.reason === 'host_paths' ||
          classification.reason === 'host_inputs'
          ? 'host_steps'
          : 'model_steps',
      );
    if (classification.modelSteps > 0) {
      // Model steps run the app's own CLIs (D21), Codex ones the run's Codex environment (D20).
      if (
        !launch.modelCatalog ||
        !launch.providerBinaries ||
        !useProviderBinaries(launch.providerBinaries) ||
        !launch.bundledResourcesDir ||
        !useBundledResources(launch.bundledResourcesDir)
      )
        return fail(id, 'start_failed');
      if (
        classification.modelHarnesses.includes('codex') &&
        (!launch.codexEnvironment || !launcher)
      )
        return fail(id, 'start_failed');
    }
    const { executionId } = params;
    let handle: ExecutionHandle | null = null;
    const executionOptions: ExecutionOptions = {
      cwd: launch.cwd,
      pipelineId: params.pipelineId,
      scope: params.runScope,
      target,
      executionCheckoutRoot: launch.executionCheckoutRoot,
      env: { ...launch.env },
      secretEnv: Object.keys(launch.secretEnv).length
        ? { ...launch.secretEnv }
        : undefined,
      inputs: launch.inputs,
      ...(launch.event && launchEventOptions(launch.event)),
      pipelineFileDir: launch.pipelineFileDir,
      pipelineDataDir: launch.pipelineDataDir,
      assetsDir: launch.assetsDir,
      assetPaths: launch.assetPaths,
      ...(launch.globalWorkspaceDir !== undefined && {
        globalWorkspaceDir: launch.globalWorkspaceDir,
      }),
      repoPath: launch.repoPath,
      runtime,
      ...(classification.modelSteps > 0 && {
        modelConfig: normalizeAgentModelConfig(launch.modelConfig),
        agentTerminalMode: false,
      }),
      ...(pluginCollections &&
        launch.pluginCollectionPreferences !== undefined && {
          pluginCollectionPreferences:
            normalizePipelinePluginCollectionPreferences(
              launch.pluginCollectionPreferences,
            ),
        }),
      ...(launch.modelAliasPreferences !== undefined && {
        // The executor's own normalizer: a run's reset entries must survive.
        modelAliasPreferences: normalizeExecutionModelAliasPreferences(
          launch.modelAliasPreferences,
        ),
      }),
      executionId,
      ...(worktree && {
        projectId: worktree.workspaceId,
        worktreeId: worktree.worktreeId,
      }),
      pipelinePreferenceLocator: parsePreferenceLocator(
        launch.pipelinePreferenceLocator,
      ),
      sharedPipelineSource: normalizeSharedPipelineSource(
        launch.sharedPipelineSource,
      ),
      curatedPipelineSource: normalizeCuratedPipelineSource(
        launch.curatedPipelineSource,
      ),
      executionContext: params.owner ?? undefined,
      initiationSource:
        params.initiationSource === 'unknown'
          ? undefined
          : params.initiationSource,
      initiator: normalizeExecutionInitiator(launch.initiator),
      agentOrigin: normalizeAgentChatAddress(launch.agentOrigin),
      onEvent: (event): void => {
        if (event.executionId !== executionId) return;
        post({
          kind: 'execution',
          executionId,
          event: event.type,
          execution: projectPipelineExecution(event.state),
        });
        if (handle && isSettled(event.state)) forget(executionId, handle);
      },
      onStepOutput: (event): void => {
        // Output dropped under congestion stays in the persisted step log.
        if (event.executionId !== executionId || channel.congested()) return;
        post({
          kind: 'output',
          executionId,
          jobId: event.jobId,
          stepId: event.stepId,
          attempt: event.attempt,
          ...(event.iteration !== undefined && { iteration: event.iteration }),
          stream: event.stream,
          text: event.data,
        });
      },
    };
    // A start never writes over a run the store holds: a start over may have
    // run its execution while it waited on its secrets (CAN-6103).
    if (
      run === START &&
      (runs.has(executionId) ||
        (await loadExecutionState(executionId, dir)) !== null)
    )
      return fail(id, 'start_failed');
    try {
      handle = await run.begin(pipeline, executionOptions);
    } catch (error) {
      warn('The pipeline host could not start a workflow run.');
      return fail(
        id,
        error instanceof Error &&
          error.message === `Execution "${executionId}" not found`
          ? 'not_found'
          : run.refused,
      );
    }
    const started = handle;
    // The executor rejects completion only on its own failure; observe it so
    // that failure never ends the host.
    const finished = started
      .waitForCompletion()
      .then(
        () => forget(executionId, started),
        () => {
          warn('A workflow run ended with an executor error.');
          const failed = started.getState();
          // A fenced incarnation reports nothing more (CAN-6198).
          if (TERMINAL.has(failed.status) && !fenced())
            publish(executionId, failed);
          forget(executionId, started);
        },
      )
      .finally(() => {
        finishing.delete(started);
        settleExits();
      })
      .catch(() => warn('The pipeline host could not retire a workflow run.'));
    finishing.set(started, finished);
    const state = started.getState();
    if (!isSettled(state)) {
      runs.set(executionId, {
        handle: started,
        runtime,
        ...(runOwnerRequests && { ownerRequests: runOwnerRequests }),
      });
      if (isOwnerBound) ownerBound.add(executionId);
    }
    respond(id, run.answer(state));
  };

  /** The stored state, or the live run's while it isn't terminal. */
  const currentState = async (
    dir: string,
    executionId: string,
  ): Promise<ExecutionState | null> => {
    const stored = await loadExecutionState(executionId, dir);
    return stored && TERMINAL.has(stored.status)
      ? stored
      : (runs.get(executionId)?.handle.getState() ?? stored);
  };

  const get = async (
    id: number,
    dir: string,
    executionId: string,
    detail: boolean,
  ): Promise<void> => {
    const state = await currentState(dir, executionId);
    if (state === null) return respond(id, null);
    respond(
      id,
      detail
        ? projectPipelineExecutionView(state, { detail: true })
        : projectPipelineExecution(state),
    );
  };

  const cancel = async (
    id: number,
    dir: string,
    executionId: string,
    mode: 'finalize' | 'drain',
  ): Promise<void> => {
    // A fenced incarnation changes no run, cancellations included (CAN-6198).
    if (fenced()) return fail(id, 'closed');
    const live = runs.get(executionId)?.handle;
    const ownerRequests = runs.get(executionId)?.ownerRequests;
    try {
      if (mode === 'drain') {
        if (live) {
          await requestExecutionCancellation(executionId, dir);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS);
          });
          const cancelling = live.cancel();
          // A step waiting on its owner ends only once that request does.
          ownerRequests?.abort();
          const outcome = await Promise.race([cancelling, timedOut]);
          clearTimeout(timer);
          if (outcome === 'timeout') return fail(id, 'drain_timed_out');
          return respond(id, projectPipelineExecution(outcome));
        }
        const stored = await loadExecutionState(executionId, dir);
        if (stored && TERMINAL.has(stored.status))
          return respond(id, projectPipelineExecution(stored));
        const cancelled = await cancelPipelineExecution(
          executionId,
          runtimeFor(dir, executionId),
          { allowRecoveredFallback: false },
        );
        publish(executionId, cancelled);
        return respond(id, projectPipelineExecution(cancelled));
      }
      if (live) void live.cancel().catch(() => undefined);
      ownerRequests?.abort();
      const cancelled = await cancelPipelineExecution(
        executionId,
        runtimeFor(dir, executionId),
      );
      // A live run's executor reports its own cancellation.
      if (!live) publish(executionId, cancelled);
      return respond(id, projectPipelineExecution(cancelled));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Execution "${executionId}" not found`
      )
        return fail(id, 'not_found');
      return fail(id, 'cancel_failed');
    }
  };

  const checkpoint = async (id: number): Promise<void> => {
    admissionOpen = false;
    await Promise.allSettled([...admitting]);
    const live = [...runs.values()].map(({ handle }) => handle);
    // Runs that already reported their outcome still clear their cancellation
    // marker under the data root; the answer waits for them too.
    const retiring = [...finishing]
      .filter(([handle]) => !live.includes(handle))
      .map(([, finished]) => finished);
    const pausing = live.map((handle) =>
      handle.pauseForShutdown
        ? handle.pauseForShutdown()
        : Promise.reject(new Error('The run cannot pause.')),
    );
    // A step waiting on its owner pauses only once that request ends; the
    // supervisor has already withdrawn its relays, so nothing would settle it.
    ownerRequests?.close();
    const settled = await Promise.allSettled(pausing);
    await Promise.allSettled(retiring);
    // Its app-servers end before the answer, so nothing outlives the checkpoint (D17).
    await shutdownDaemonPipelineCodexRuntime().catch(() =>
      warn('The pipeline host could not stop its Codex runtime.'),
    );
    if (settled.some((result) => result.status === 'rejected'))
      return fail(id, 'checkpoint_failed');
    respond(id, { checkpointedCount: live.length });
  };

  /**
   * Kills every step process group still known. A negative PID names a POSIX
   * group; Windows refuses it, and its job objects end the trees instead.
   */
  const killProcessGroups = (): void => {
    for (const group of new Set(
      [...processGroups.values()].map((entry) => entry.group),
    )) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // Already gone, or a platform without process groups.
      }
    }
  };

  /**
   * The core that launched this host is gone (CAN-6481), so no owner or
   * stream can reach its runs. Each run pauses as `core_lost`, ending its
   * steps; a step still alive after CORE_LOSS_DRAIN_MS is killed, and the
   * host exits. A resume reruns the interrupted step.
   */
  const coreLost = async (): Promise<void> => {
    coreLossStarted = true;
    const deadline = setTimeout(() => {
      killProcessGroups();
      channel.exit(1);
    }, CORE_LOSS_EXIT_MS);
    admissionOpen = false;
    await Promise.allSettled([...admitting]);
    const pausing = [...runs.values()].flatMap(({ handle }) => {
      const paused = handle.pauseForCoreLoss?.() ?? handle.pauseForShutdown?.();
      return paused ? [paused] : [];
    });
    // After the pause is under way, so a withdrawn owner or host call stops
    // its step as paused rather than failing it, as the checkpoint does.
    hostSteps?.close();
    ownerRequests?.close();
    const settled = Promise.allSettled(pausing);
    const within = async (ms: number): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
      clearTimeout(timer);
    };
    await within(CORE_LOSS_DRAIN_MS);
    // A step that ignored its stop, or a descendant that outlived its step,
    // is killed; its run then records the pause.
    killProcessGroups();
    await within(CORE_LOSS_DRAIN_MS);
    await shutdownDaemonPipelineCodexRuntime().catch(() => undefined);
    clearTimeout(deadline);
    channel.exit(0);
  };

  /** Pauses the owner-bound runs named: their owner is gone (CAN-5771). Admission stays open. */
  const pause = async (
    id: number,
    executionIds: string[],
    reason: 'owner_lost' | undefined,
  ): Promise<void> => {
    const live = executionIds
      .filter((executionId) => ownerBound.has(executionId))
      .flatMap((executionId) => {
        const run = runs.get(executionId);
        return run ? [run] : [];
      });
    const pausing = live.map(({ handle }) => {
      // A remote owner's loss records its own reason (CAN-6102).
      const paused =
        reason === 'owner_lost'
          ? handle.pauseForOwnerLoss?.()
          : handle.pauseForShutdown?.();
      return paused ?? Promise.reject(new Error('The run cannot pause.'));
    });
    for (const run of live) run.ownerRequests?.abort();
    const settled = await Promise.allSettled(pausing);
    if (settled.some((result) => result.status === 'rejected'))
      return fail(id, 'checkpoint_failed');
    respond(id, { pausedCount: live.length });
  };

  /**
   * Checkpoints one run so its host can roll over (CAN-6199); admission stays
   * open. A run that is not live answers as it is stored.
   */
  const checkpointRun = async (
    id: number,
    dir: string,
    executionId: string,
    drainMs: number,
  ): Promise<void> => {
    // A fenced incarnation checkpoints nothing: its runs already stopped (CAN-6198).
    if (fenced()) return fail(id, 'closed');
    // A run whose start is still being admitted is live once that settles.
    await Promise.allSettled([...admitting]);
    const run = runs.get(executionId);
    if (!run) {
      const stored = await currentState(dir, executionId);
      if (stored === null) return fail(id, 'not_found');
      return respond(id, projectPipelineExecution(stored));
    }
    const paused = run.handle.pauseForRollover?.({
      drainMs,
      // A step waiting on its owner ends only once that request does.
      onCheckpoint: () => run.ownerRequests?.abort(),
    });
    if (!paused) return fail(id, 'checkpoint_failed');
    try {
      return respond(id, projectPipelineExecution(await paused));
    } catch {
      return fail(id, 'checkpoint_failed');
    }
  };

  /** Waits for a run's executor to settle once it reported its outcome. */
  const settling = async (executionId: string): Promise<void> => {
    await Promise.all(
      [...finishing]
        .filter(([handle]) => handle.id === executionId)
        .map(([, finished]) => finished),
    );
  };

  /**
   * The run's handle while its executor runs. One that already reported
   * its outcome, which its store may show before the host retires it,
   * settles first, so a control that follows it at once finds it stored.
   */
  const liveHandle = async (
    executionId: string,
  ): Promise<ExecutionHandle | undefined> => {
    const live = runs.get(executionId)?.handle;
    if (!live || !isSettled(live.getState())) return live;
    await settling(executionId);
    return runs.get(executionId)?.handle;
  };

  /**
   * Resumes a run whose executor still runs its other jobs: its paused jobs
   * continue in place, as desktop resumes an active run (CAN-4141).
   */
  const resumeLive = async (
    id: number,
    live: ExecutionHandle,
    control: Extract<
      PipelineHostControl,
      { operation: 'worker.pipeline.execution.resume' }
    >,
    secretEnv: Readonly<Record<string, string>>,
  ): Promise<void> => {
    const current = live.getState();
    const { params } = control;
    const answered = (): void =>
      respond(id, {
        outcome: 'already_running',
        execution: projectPipelineExecution(current),
      });
    if (!live.resumePaused) return answered();
    const pauseResponses = pauseResponsesOf(control);
    const answering = (pauseResponses?.length ?? 0) > 0;
    let reasonIds =
      params.statusReasonIds ??
      (answering
        ? []
        : current.status_reasons
            .filter((reason) => reason.kind !== 'input_required')
            .map((reason) => reason.id));
    if (new Set(reasonIds).size !== reasonIds.length)
      return fail(id, 'control_failed');
    if (params.allowStaleNoop && params.statusReasonIds) {
      reasonIds = currentReasonIds(current, reasonIds) ?? [];
      if (reasonIds.length === 0 && !answering)
        return respond(id, {
          outcome: 'stale_noop',
          execution: projectPipelineExecution(current),
        });
    }
    if (reasonIds.length === 0 && !answering) return answered();
    try {
      await live.resumePaused(
        reasonIds,
        pauseResponses,
        params.persistInitiationSource ? params.initiationSource : undefined,
        undefined,
        // The control's own secrets replace the run's, none when it redeemed
        // none, as for a stored run.
        { secretEnv: { ...secretEnv } },
      );
    } catch {
      return fail(id, 'control_failed');
    }
    // The run as it is now, so an end posted before this answer shows in it.
    respond(id, controlStarted(live.getState()));
  };

  /**
   * Retries a stored run (CAN-4141): `failed_only` runs its failed work
   * again in place, `from_start` its snapshot as `hostLaunch`'s new
   * execution, never over a run the store holds.
   */
  const retryStored = async (
    id: number,
    dir: string,
    control: Extract<
      PipelineHostControl,
      { operation: 'worker.pipeline.execution.retry' }
    >,
    hostLaunch: PipelineHostLaunch,
  ): Promise<void> => {
    const { executionId, mode, initiationSource } = control.params;
    const target = hostLaunch.params.executionId;
    const fromStart = mode === 'from_start';
    // A start over runs as a new execution; a retry in place, as itself.
    if (fromStart ? target === executionId : target !== executionId)
      return fail(id, 'control_failed');
    if ((await liveHandle(executionId)) || (await liveHandle(target)))
      return fail(id, 'control_failed');
    await settling(executionId);
    if ((await loadExecutionState(executionId, dir)) === null)
      return fail(id, 'not_found');
    if (fromStart && (await loadExecutionState(target, dir)) !== null)
      return fail(id, 'control_failed');
    return start(id, dir, hostLaunch, {
      begin: (_pipeline, options) =>
        fromStart
          ? rerunPipelineExecution(executionId, {
              ...replayOptionsOf(options),
              executionId: target,
              ...(initiationSource !== undefined && { initiationSource }),
            })
          : retryPipelineExecution(executionId, replayOptionsOf(options)),
      answer: controlStarted,
      refused: 'control_failed',
    });
  };

  /**
   * Resumes a stored paused run (CAN-4141) with its launch, whatever paused
   * it: a lost owner, a checkpoint, a provider or an input request. The
   * executor checks each pause answer against the pause it names.
   */
  const resumeStored = async (
    id: number,
    dir: string,
    control: Extract<
      PipelineHostControl,
      { operation: 'worker.pipeline.execution.resume' }
    >,
    hostLaunch: PipelineHostLaunch,
  ): Promise<void> => {
    const { params } = control;
    const { executionId } = params;
    // A run that just paused still settles its executor; resume the stored run after.
    await settling(executionId);
    const stored = await loadExecutionState(executionId, dir);
    if (stored === null) return fail(id, 'not_found');
    const unchanged = (): void =>
      respond(id, {
        outcome: 'stale_noop',
        execution: projectPipelineExecution(stored),
      });
    const statusReasonIds = params.allowStaleNoop
      ? currentReasonIds(stored, params.statusReasonIds)
      : params.statusReasonIds;
    if (statusReasonIds?.length === 0) return unchanged();
    if (TERMINAL.has(stored.status))
      return params.allowStaleNoop ? unchanged() : fail(id, 'control_failed');
    const pauseResponses = pauseResponsesOf(control);
    return start(id, dir, hostLaunch, {
      begin: (_pipeline, options) => {
        const { inputs: _inputs, executionId: _id, ...rest } = options;
        void _inputs;
        void _id;
        return resumePipeline(executionId, {
          ...rest,
          ...(statusReasonIds && { statusReasonIds }),
          ...(pauseResponses && { pauseResponses }),
          initiationSource: params.persistInitiationSource
            ? params.initiationSource
            : stored.initiation_source,
        });
      },
      answer: controlStarted,
      refused: 'control_failed',
    });
  };

  /**
   * Runs a recovery control (CAN-4141) on a run this host's store holds, as
   * a cloud runner serves it (CAN-6103): a resume continues the run's
   * paused work, whatever paused it (a lost owner, a checkpoint or a
   * provider), validating each pause answer against the pause it names; a
   * retry runs its failed work again in place, or its snapshot again as a
   * new run. `hostLaunch` is the run's launch, resolved again for the
   * control, so the run continues with the runtime it started with.
   */
  const control = async (
    id: number,
    dir: string,
    request: PipelineHostControl,
    hostLaunch: PipelineHostLaunch,
  ): Promise<void> => {
    // A fenced incarnation changes no run (CAN-6198).
    if (!admissionOpen || fenced()) return fail(id, 'closed');
    const ran = await claiming(
      [request.params.executionId, hostLaunch.params.executionId],
      async () => {
        if (request.operation === 'worker.pipeline.execution.retry')
          return retryStored(id, dir, request, hostLaunch);
        const { executionId } = request.params;
        if (hostLaunch.params.executionId !== executionId)
          return fail(id, 'control_failed');
        const live = await liveHandle(executionId);
        if (live)
          return resumeLive(id, live, request, hostLaunch.launch.secretEnv);
        return resumeStored(id, dir, request, hostLaunch);
      },
    );
    if (!ran) fail(id, 'control_failed');
  };

  /** A start, unless a start or control of its execution is under way. */
  const claimedStart = async (
    id: number,
    dir: string,
    hostLaunch: PipelineHostLaunch,
  ): Promise<void> => {
    const ran = await claiming([hostLaunch.params.executionId], () =>
      start(id, dir, hostLaunch),
    );
    if (!ran) fail(id, 'start_failed');
  };

  const handle = async (
    id: number,
    request: PipelineHostRequest,
  ): Promise<void> => {
    if (request.op === 'configure') {
      // The host never overrides its data root: it refuses another one.
      if (!(await isOwnDataRoot(request.dataRoot))) return fail(id, 'closed');
      executionsDir = path.join(request.dataRoot, 'pipeline-executions');
      // A cloud runner fences with its delegation lease epoch, since every
      // incarnation runs as the same PIDs in its own container (CAN-6198).
      if (request.ownerLease) {
        leaseFence?.dispose();
        const fence = createLeasePipelineOwnerFence({
          lease: request.ownerLease,
        });
        leaseFence = fence;
        installPipelineOwnerFence(fence);
        // The supervisor stops this host and starts none for this
        // incarnation again, also when the lease was over at configure.
        const report = (): void => {
          const state = fence.state();
          if (state !== 'held') post({ kind: 'fenced', state });
        };
        if (fence.fenced.aborted) report();
        else fence.fenced.addEventListener('abort', report, { once: true });
      } else await configurePipelineOwnerFence(options.inspectProcess);
      dataRoot = request.dataRoot;
      codexMcpLauncher = request.codexMcpLauncher ?? null;
      readMemory = isPipelineHostMemoryBudget(request.memory)
        ? createPipelineHostMemoryReader({ budget: request.memory })
        : null;
      const hostChannel = {
        raise: (hostRequest: WorkerPipelineHostRequest): void =>
          post({ kind: 'hostRequest', request: hostRequest }),
        withdraw: (executionId: string, requestId: string): void =>
          post({ kind: 'hostRequestWithdrawn', executionId, requestId }),
      };
      hostSteps ??= createDaemonHostStepPort(hostChannel);
      ownerRequestDeadlineMs = positiveDeadline(request.ownerRequestDeadlineMs);
      ownerRequests ??= createPipelineOwnerClient(hostChannel, {
        minimumDeadlineMs: () => ownerRequestDeadlineMs,
      });
      return respond(id, null);
    }
    const dir = executionsDir;
    if (dir === null) return fail(id, 'closed');
    switch (request.op) {
      case 'start':
      case 'control': {
        const admitted =
          request.op === 'start'
            ? claimedStart(id, dir, request.start)
            : control(id, dir, request.control, request.start);
        const settle = (): void => {
          admitting.delete(admitted);
          settleExits();
        };
        admitting.add(admitted);
        void admitted.then(settle, settle);
        return admitted;
      }
      case 'get':
        return get(id, dir, request.executionId, request.detail === true);
      case 'list':
        return respond(
          id,
          await listPipelineExecutionPage(
            await listExecutionSummaries(dir),
            (executionId) => currentState(dir, executionId),
            request.query,
          ),
        );
      case 'cancel': {
        // A start or control admitting the run settles first, so the cancel
        // reaches the run it starts instead of a store it then overwrites;
        // the cancel then holds the run, so none starts it meanwhile.
        const { executionId } = request;
        for (
          let held = claimed.get(executionId);
          held;
          held = claimed.get(executionId)
        )
          await held;
        await claiming([executionId], () =>
          cancel(id, dir, executionId, request.mode),
        );
        return;
      }
      case 'sweep': {
        const errors = await recoverOrphanedPipelineExecutions(
          request.executionIds,
          dir,
        );
        return respond(id, { failureCount: errors.length });
      }
      case 'checkpoint':
        await checkpoint(id);
        hostSteps?.close();
        return;
      case 'hostSettled': {
        const { requestId, settlement } = request;
        if (
          !ownerRequests?.settle(requestId, settlement) &&
          settlement.kind !== 'owner'
        )
          hostSteps?.settle(requestId, settlement);
        return respond(id, null);
      }
      case 'pause':
        return pause(id, request.executionIds, request.reason);
      case 'checkpointRun':
        return checkpointRun(id, dir, request.executionId, request.drainMs);
      case 'lease':
        // The fence stops each run loop itself once the lease is gone.
        if (!leaseFence) return fail(id, 'closed');
        leaseFence.observe(request.observation);
        return respond(id, { state: leaseFence.state() });
      case 'ownerDeadline':
        ownerRequestDeadlineMs = positiveDeadline(
          request.ownerRequestDeadlineMs,
        );
        return respond(id, null);
      case 'exit':
        admissionOpen = false;
        hostSteps?.close();
        ownerRequests?.close();
        exitRequests.push(id);
        return settleExits();
    }
  };

  channel.onDisconnect(() => {
    void coreLost();
  });
  channel.on('message', (event) => {
    const message = event.data;
    if (!isRequestMessage(message)) return;
    handle(message.id, message.request).catch(() => {
      warn('The pipeline host could not answer a request.');
      fail(message.id, 'closed');
    });
  });
}
