import type {
  AgentActionErrorCode,
  AgentJson,
  AgentPipelineRunExecution,
  AgentPipelineRunRejectionReason,
  AgentPipelineRunResult,
  AgentPipelinesPort,
  PipelineRunAction,
  PipelineRunWatcher,
} from '@canopy/agent-actions';
import {
  AgentPortError,
  APP_ADVISOR_PIPELINE_RUN_TARGET_MESSAGE,
} from '@canopy/agent-actions';
import {
  buildPipelineRunArtifactReceipt,
  withAgentArtifacts,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import type { ExecutePipelineRequestOptions } from '@canopy/execution-engine/node/pipelines/executor';
import {
  DEFAULT_PIPELINE_SCOPES,
  executionContextSatisfies,
} from '@canopy/execution-engine/pipelines/scope';
import type {
  AppAdvisorActionErrorCode,
  AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import {
  getTriggerTypes,
  type ExecutionState,
  type PipelineAgentChatAddress,
  type PipelineData,
  type PipelineExecutionInitiator,
} from '@canopy/execution-engine/types/pipeline';
import type { BrowserWindow } from 'electron';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import {
  agentResourceActionFailure,
  loadAgentGlobalPipelineById,
  loadAgentPipelineById,
} from '../canopy-tools/resource-actions';
import {
  initiatorForWorktreeRuntime,
  pipelineExecutionArtifact,
  pipelineSourceExecutionOptions,
  resolveScopedEventPath,
  runtimeExecutionScope,
  type WorktreeActionRuntime,
} from '../canopy-tools/worktree-actions';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import {
  preflightGlobalStart,
  type GlobalStartRefusal,
} from '../pipelines/pipeline-global-start';
import { agentPipelineOwnerContext } from '../pipelines/pipeline-owner-policy';
import type {
  CloudRunAgentChat,
  CloudRunAgentDestination,
} from '../pipelines/cloud-pipeline-runs';
import { CLOUD_PIPELINE_RUN_TARGET_ID } from '@canopy/protocol/canopy-core/core/pipeline/cloud-runs';
import { inlineWatcherSetupJson } from './desktop-legacy-family';
import { worktreeWatcherDestination } from './desktop-watcher-port';

type Host = CanopyInjectedToolRuntime;

const INLINE_WATCHERS_UNAVAILABLE =
  'Inline watcher setup is only available for worktree chats.';

function rejected(
  reason: AgentPipelineRunRejectionReason,
  message: string,
): AgentPipelineRunResult {
  return { status: 'rejected', reason, message };
}

function notFound(pipelineId: string): AgentPipelineRunResult {
  return rejected('not_found', `Pipeline ${pipelineId} was not found.`);
}

function isAgentJson(value: unknown): value is AgentJson {
  if (value === null) return true;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return true;
  if (Array.isArray(value)) return value.every(isAgentJson);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isAgentJson);
}

function toAgentJson(value: unknown): AgentJson | undefined {
  const cloned: unknown = JSON.parse(JSON.stringify(value ?? null));
  return isAgentJson(cloned) ? cloned : undefined;
}

/** The started run without host paths. */
function runExecution(state: ExecutionState): AgentPipelineRunExecution {
  return {
    executionId: state.id,
    pipelineId: state.pipeline_id,
    pipelineName: state.pipeline_snapshot.name,
    executionStatus: state.status,
    executionScope: state.scope ?? 'directory',
    ...(state.execution_context !== undefined
      ? { owner: state.execution_context }
      : {}),
    ...(state.project_id !== undefined ? { projectId: state.project_id } : {}),
    ...(state.worktree_id !== undefined
      ? { worktreeId: state.worktree_id }
      : {}),
    eventName: state.event_name ?? 'dispatch',
    startedAt: state.started_at,
  };
}

function artifactsJson(receipts: readonly unknown[]): AgentJson | undefined {
  return toAgentJson(
    withAgentArtifacts({ ok: true, result: {} }, receipts).result
      .agentArtifacts,
  );
}

/** The agent action code of a pipeline loading failure. */
function loadFailureCode(
  code: AppAdvisorActionErrorCode | undefined,
): AgentActionErrorCode {
  switch (code) {
    case 'missing_capability':
    case 'authentication_failed':
    case 'authorization_conflict':
    case 'stale_content_hash':
    case 'validation_failed':
    case 'read_only_source':
      return code;
    default:
      return 'execution_failed';
  }
}

/**
 * Loading errors keep the codes the legacy action reported: not found is a
 * rejection, anything else fails the call without starting a run.
 */
function loadFailure(cause: unknown): AgentPipelineRunResult {
  const failure = agentResourceActionFailure(cause);
  const message = failure.error?.message ?? 'The pipeline could not be loaded.';
  if (failure.error?.code === 'not_found')
    return rejected('not_found', message);
  throw new AgentPortError(
    loadFailureCode(failure.error?.code),
    message,
    failure.error?.retryable === true,
  );
}

function globalRefusal(refusal: GlobalStartRefusal): AgentPipelineRunResult {
  return rejected(refusal.reason, refusal.message);
}

function eventOptions(
  eventName: NonNullable<PipelineRunAction['runMode']>,
  action: Pick<PipelineRunAction, 'planId'>,
  paths: { planPath: string | null; taskPath: string | null },
): Pick<ExecutePipelineRequestOptions, 'eventName' | 'eventData'> {
  return {
    eventName,
    ...(eventName === 'plan_ready'
      ? {
          eventData: {
            plan_ready: {
              ...(paths.planPath ? { plan_path: paths.planPath } : {}),
              ...(action.planId ? { planId: action.planId } : {}),
            },
          },
        }
      : {}),
    ...(eventName === 'task_ready'
      ? {
          eventData: {
            task_ready: {
              ...(paths.taskPath ? { task_path: paths.taskPath } : {}),
              ...(paths.planPath ? { plan_path: paths.planPath } : {}),
            },
          },
        }
      : {}),
  };
}

function inputOptions(
  action: Pick<PipelineRunAction, 'inputs'>,
): Pick<ExecutePipelineRequestOptions, 'inputs'> {
  return action.inputs && Object.keys(action.inputs).length > 0
    ? { inputs: action.inputs }
    : {};
}

async function startRun(args: {
  pipeline: PipelineData;
  options: ExecutePipelineRequestOptions;
  getWindow: () => BrowserWindow | null;
}): Promise<{ state: ExecutionState } | { result: AgentPipelineRunResult }> {
  const { startPipelineExecutionFromMain } =
    await import('../pipelines/pipeline-handlers');
  const started = await startPipelineExecutionFromMain({
    pipeline: args.pipeline.content,
    getWindow: args.getWindow,
    options: args.options,
  });
  if (!started.success)
    return { result: rejected('execution_failed', started.error) };
  return { state: started.data };
}

/** The calling tool's id, and a Stop's abort signal for watcher setup. */
interface WatcherCall {
  toolUseId?: string;
  signal?: AbortSignal;
}

interface WatcherTarget {
  destination: AppAdvisorWatcherDestination;
  projectId: string;
  worktreeId: string;
}

/**
 * Arm the run's completion watchers. The run has started, so a failure is
 * reported in the result and never thrown.
 */
async function setupRunWatchers(
  action: PipelineRunAction,
  state: ExecutionState,
  target: WatcherTarget | null,
  call: WatcherCall,
): Promise<AgentJson> {
  if (!target) return { ok: false, error: INLINE_WATCHERS_UNAVAILABLE };
  try {
    // Defer the scheduler-backed service until a run asks for watchers.
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    const setup = await getAppAdvisorWatcherService().setup(
      {
        watchers: (action.watchers ?? []).map((watcher: PipelineRunWatcher) => {
          const terminalStatuses =
            watcher.target?.terminalStatuses ?? watcher.terminalStatuses;
          return {
            trigger: 'worktree_pipeline_completion' as const,
            ...(watcher.label ? { label: watcher.label } : {}),
            target: {
              kind: 'worktree_pipeline' as const,
              projectId: target.projectId,
              worktreeId: target.worktreeId,
              executionId: state.id,
              ...(terminalStatuses?.length ? { terminalStatuses } : {}),
            },
            ...(watcher.followUpInstruction
              ? { followUpInstruction: watcher.followUpInstruction }
              : {}),
            ...(watcher.allowDuplicate !== undefined
              ? { allowDuplicate: watcher.allowDuplicate }
              : {}),
          };
        }),
      },
      target.destination,
      {
        toolUseId: call.toolUseId,
        ...(call.signal ? { signal: call.signal } : {}),
      },
    );
    return inlineWatcherSetupJson(setup);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'Pipeline execution started, but inline watcher setup failed.',
    };
  }
}

async function startedResult(args: {
  action: PipelineRunAction;
  state: ExecutionState;
  receipts: readonly unknown[];
  watcherTarget: WatcherTarget | null;
  watcherCall: WatcherCall;
}): Promise<AgentPipelineRunResult> {
  const { action, state } = args;
  let agentArtifacts: AgentJson | undefined;
  try {
    agentArtifacts =
      args.receipts.length > 0 ? artifactsJson(args.receipts) : undefined;
  } catch {
    // The run started; a receipt that can't be built is left out.
    agentArtifacts = undefined;
  }
  const inlineWatcherSetup = action.watchers?.length
    ? await setupRunWatchers(
        action,
        state,
        args.watcherTarget,
        args.watcherCall,
      )
    : undefined;
  return {
    status: 'started',
    execution: runExecution(state),
    ...(agentArtifacts !== undefined ? { agentArtifacts } : {}),
    ...(inlineWatcherSetup !== undefined ? { inlineWatcherSetup } : {}),
  };
}

/** A run in a scoped chat's own task or Cowork folder. */
async function runInScopedTask(
  action: PipelineRunAction,
  runtime: WorktreeActionRuntime,
  host: Host,
  watcherCall: WatcherCall,
): Promise<AgentPipelineRunResult> {
  const executionScope = runtimeExecutionScope(runtime);
  // Directory runtimes (Cowork) always run at the workspace folder root;
  // there are no per-repo checkouts to select with repoId.
  const cwd =
    action.repoId && executionScope === 'worktree'
      ? resolveWorktreeCwd(runtime.projectId, runtime.worktreeId, action.repoId)
      : runtime.cwd;
  let pipeline: PipelineData | null;
  try {
    pipeline = await loadAgentPipelineById(action.pipelineId, runtime, cwd);
  } catch (cause) {
    return loadFailure(cause);
  }
  if (!pipeline) return notFound(action.pipelineId);
  const declaredScopes = pipeline.info.scopes ?? DEFAULT_PIPELINE_SCOPES;
  if (!executionContextSatisfies(declaredScopes, executionScope)) {
    // pipeline.list also shows global pipelines here; point to how they run.
    return rejected(
      'unsupported_scope',
      `Pipeline ${action.pipelineId} declares scopes [${declaredScopes.join(
        ', ',
      )}] and cannot run in this ${
        executionScope === 'directory' ? 'workspace folder' : 'task'
      } (${executionScope} scope). ${
        declaredScopes.includes('global')
          ? 'Run it with scope: "global" to start it with no project.'
          : 'Use pipeline.list to find runnable pipelines.'
      }`,
    );
  }
  const eventName = action.runMode ?? 'dispatch';
  if (!getTriggerTypes(pipeline.content.on).includes(eventName)) {
    return rejected(
      'invalid_target',
      `Pipeline ${action.pipelineId} does not declare the ${eventName} run mode.`,
    );
  }
  if (action.runOn === 'cloud') {
    const owner = await agentPipelineOwnerContext({
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
    });
    if ('refusal' in owner) return rejected('owner_unavailable', owner.refusal);
    return runInCloud(
      action,
      pipeline,
      owner.owner,
      watcherCall,
      {
        workspaceId: runtime.projectId,
        ...(executionScope === 'worktree'
          ? { worktreeId: runtime.worktreeId }
          : {}),
        ...(action.repoId ? { repoId: action.repoId } : {}),
      },
      agentChatOf(initiatorForWorktreeRuntime(runtime)),
    );
  }
  const { createElectronExecutionRuntime } =
    await import('../pipelines/execution-runtime');
  const { executionsDir } = createElectronExecutionRuntime();
  const planPath = action.planPath
    ? await resolveScopedEventPath(action.planPath, cwd, executionsDir, runtime)
    : null;
  if (action.planPath && !planPath) {
    return rejected(
      'invalid_target',
      'planPath must be inside the current worktree or pipeline executions directory.',
    );
  }
  const taskPath = action.taskPath
    ? await resolveScopedEventPath(action.taskPath, cwd, executionsDir, runtime)
    : null;
  if (action.taskPath && !taskPath) {
    return rejected(
      'invalid_target',
      'taskPath must be inside the current worktree or pipeline executions directory.',
    );
  }
  const started = await startRun({
    pipeline,
    getWindow: runtime.getWindow,
    options: {
      cwd,
      pipelineId: pipeline.info.id,
      pipelineFilePath:
        pipeline.info.source === 'project' ? pipeline.info.filePath : undefined,
      repoPath: pipeline.info.source === 'project' ? cwd : undefined,
      ...pipelineSourceExecutionOptions(pipeline),
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
      ...(executionScope === 'directory'
        ? {
            scope: 'directory' as const,
            target: { scope: 'directory' as const, path: cwd },
          }
        : {
            scope: 'worktree' as const,
            target: {
              scope: 'worktree' as const,
              workspace_id: runtime.projectId,
              worktree_id: runtime.worktreeId,
              path: cwd,
              created: false,
            },
          }),
      initiationSource: 'app_advisor',
      initiator: initiatorForWorktreeRuntime(runtime),
      ...eventOptions(eventName, action, { planPath, taskPath }),
      ...inputOptions(action),
    },
  });
  if ('result' in started) return started.result;
  const destination = worktreeWatcherDestination(host);
  return startedResult({
    action,
    state: started.state,
    receipts: [
      pipelineExecutionArtifact(
        action.type,
        started.state,
        runtime,
        action.repoId,
      ),
    ],
    watcherTarget: destination
      ? {
          destination,
          projectId: destination.projectId,
          worktreeId: destination.worktreeId,
        }
      : null,
    watcherCall,
  });
}

/**
 * App Advisor's run in a task main validated before dispatch. It starts with
 * the options the renderer used to send, from main, and records the Advisor
 * chat as the initiator.
 */
async function runInAppAdvisorTask(
  action: PipelineRunAction,
  target: { projectId: string; worktreeId: string },
  destination: AppAdvisorWatcherDestination,
  host: Host,
  watcherCall: WatcherCall,
): Promise<AgentPipelineRunResult> {
  const { assertNotSplitLocked } =
    await import('../services/split-lock-service');
  try {
    assertNotSplitLocked(
      target.projectId,
      target.worktreeId,
      'running a pipeline',
    );
  } catch (error) {
    return rejected(
      'invalid_target',
      error instanceof Error ? error.message : 'This task is locked.',
    );
  }
  let cwd: string;
  let pipeline: PipelineData | null;
  const getWindow = host.appAdvisorPipelineWindow ?? ((): null => null);
  try {
    cwd = resolveWorktreeCwd(
      target.projectId,
      target.worktreeId,
      action.repoId,
    );
    pipeline = await loadAgentPipelineById(
      action.pipelineId,
      {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: destination.chatId,
        cwd,
        getWindow,
      },
      cwd,
    );
  } catch (cause) {
    return loadFailure(cause);
  }
  if (!pipeline) return notFound(action.pipelineId);
  const eventName = action.runMode ?? 'dispatch';
  if (!getTriggerTypes(pipeline.content.on).includes(eventName)) {
    return rejected(
      'invalid_target',
      `Pipeline ${action.pipelineId} does not support ${eventName}.`,
    );
  }
  if (action.runOn === 'cloud') {
    const owner = await agentPipelineOwnerContext(target);
    if ('refusal' in owner) return rejected('owner_unavailable', owner.refusal);
    return runInCloud(action, pipeline, owner.owner, watcherCall, {
      workspaceId: target.projectId,
      worktreeId: target.worktreeId,
      ...(action.repoId ? { repoId: action.repoId } : {}),
    });
  }
  const chat: PipelineAgentChatAddress = {
    projectId: destination.projectId,
    worktreeId: destination.worktreeId,
    chatId: destination.chatId,
  };
  const started = await startRun({
    pipeline,
    getWindow,
    options: {
      cwd,
      pipelineId: pipeline.info.id,
      ...pipelineSourceExecutionOptions(pipeline),
      pipelineFilePath:
        pipeline.info.source === 'project' ? pipeline.info.filePath : undefined,
      repoPath: pipeline.info.source === 'project' ? cwd : undefined,
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      initiationSource: 'app_advisor',
      initiator: { kind: 'app_advisor', chat },
      // Main's implicit plan approval reads the top-level plan id.
      ...(eventName === 'plan_ready' && action.planId
        ? { planId: action.planId }
        : {}),
      ...eventOptions(eventName, action, {
        planPath: action.planPath ?? null,
        taskPath: action.taskPath ?? null,
      }),
      ...inputOptions(action),
    },
  });
  if ('result' in started) return started.result;
  const state = started.state;
  return startedResult({
    action,
    state,
    receipts: [
      buildPipelineRunArtifactReceipt({
        operation: action.type,
        executionId: state.id,
        pipelineId: state.pipeline_id,
        pipelineName: state.pipeline_snapshot.name,
        initialStatus:
          state.status === 'paused' || state.status === 'running'
            ? state.status
            : 'pending',
        queuedAt: state.started_at,
        ...(state.status === 'running' ? { startedAt: state.started_at } : {}),
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        ...(action.repoId ? { repoId: action.repoId } : {}),
        navigationTarget: {
          kind: 'pipeline_execution',
          executionId: state.id,
          projectId: target.projectId,
          worktreeId: target.worktreeId,
        },
      }),
    ],
    watcherTarget: { destination, ...target },
    watcherCall,
  });
}

interface GlobalRunSource {
  /** The chat whose project's saved owner the run takes. */
  ownerTarget: { projectId: string; worktreeId?: string };
  initiator: PipelineExecutionInitiator;
  getWindow: () => BrowserWindow | null;
}

function globalRunSource(host: Host): GlobalRunSource | null {
  const scoped = host.worktreeActionRuntime;
  if (scoped)
    return {
      ownerTarget: {
        projectId: scoped.projectId,
        worktreeId: scoped.worktreeId,
      },
      initiator: initiatorForWorktreeRuntime(scoped),
      getWindow: scoped.getWindow,
    };
  const destination = worktreeWatcherDestination(host);
  // Only App Advisor's runtime carries its pipeline window; another runtime
  // with a watcher destination is never recorded as App Advisor.
  const getWindow = host.appAdvisorPipelineWindow;
  if (!destination || !getWindow) return null;
  // App Advisor has no project owner; the selected context captured for
  // this dispatch stands in for it.
  return {
    ownerTarget: { projectId: destination.projectId },
    initiator: {
      kind: 'app_advisor',
      chat: {
        projectId: destination.projectId,
        worktreeId: destination.worktreeId,
        chatId: destination.chatId,
      },
    },
    getWindow,
  };
}

/**
 * A run with no project. Its owner is the calling chat's project owner,
 * never the payload; it never binds or rewrites a pipeline's saved owner.
 */
async function runGlobal(
  action: PipelineRunAction,
  host: Host,
  call: WatcherCall,
): Promise<AgentPipelineRunResult> {
  const source = globalRunSource(host);
  if (!source)
    return rejected('invalid_target', 'This chat cannot start pipeline runs.');
  const owner = await agentPipelineOwnerContext(source.ownerTarget);
  if ('refusal' in owner) return rejected('owner_unavailable', owner.refusal);
  let pipeline: PipelineData | null;
  try {
    pipeline = await loadAgentGlobalPipelineById(
      action.pipelineId,
      owner.owner,
    );
  } catch (cause) {
    // An owned definition outside the caller's reach is not disclosed. A
    // failure that says nothing about the definition (offline, no Cloud
    // capability, signed out) keeps its code so the agent can act on it.
    const failure = agentResourceActionFailure(cause).error;
    if (
      failure?.retryable === true ||
      failure?.code === 'missing_capability' ||
      failure?.code === 'authentication_failed'
    )
      return loadFailure(cause);
    return notFound(action.pipelineId);
  }
  if (!pipeline || pipeline.info.source === 'project')
    return notFound(action.pipelineId);
  // A run with no project starts only by dispatch.
  if (!getTriggerTypes(pipeline.content.on).includes('dispatch')) {
    return rejected(
      'invalid_target',
      `Pipeline ${action.pipelineId} does not declare the dispatch run mode.`,
    );
  }
  if (action.runOn === 'cloud')
    return runInCloud(
      action,
      pipeline,
      owner.owner,
      call,
      undefined,
      agentChatOf(source.initiator),
    );
  const options: ExecutePipelineRequestOptions = {
    pipelineId: pipeline.info.id,
    ...pipelineSourceExecutionOptions(pipeline),
    scope: 'global',
    target: { scope: 'global' },
    eventName: 'dispatch',
    initiationSource: 'app_advisor',
    initiator: source.initiator,
    executionContext: owner.owner,
    ...inputOptions(action),
  };
  // The start repeats these checks; running them here first keeps a refusal's
  // typed reason, which the start reports only as an error message.
  const refusal = await preflightGlobalStart(pipeline.content, options);
  if (refusal) return globalRefusal(refusal);
  const started = await startRun({
    pipeline,
    getWindow: source.getWindow,
    options,
  });
  if ('result' in started) return started.result;
  // A run with no task has no receipt card or watcher target yet.
  return {
    status: 'started',
    execution: runExecution(started.state),
  };
}

const CLOUD_REFUSAL_REASONS: Readonly<
  Partial<Record<string, AgentPipelineRunRejectionReason>>
> = {
  cloud_destination_unavailable: 'unsupported_scope',
  cloud_source_unavailable: 'invalid_target',
  cloud_target_unavailable: 'invalid_target',
  cloud_owner_required: 'owner_unavailable',
};

/**
 * `runOn: "cloud"` (CAN-6187): the run starts in the web core through the
 * same main-process path the Run dialog uses, under the calling chat's
 * owner. An agent can't confirm cloud models, so a workflow whose model
 * steps have none saved is refused until the person picks them once in the
 * Run dialog; nothing runs on this computer.
 *
 * Without `scope: "global"` (CAN-6354) the start names the calling chat's
 * project, and its task for a worktree chat, for the web core to admit or
 * refuse with its own reason.
 */
/**
 * The agent chat a cloud start names (CAN-6391), so the run reports which
 * desktop chat started it; Orchestrator's runs name none, since it watches
 * no cloud runs.
 */
function agentChatOf(
  initiator: PipelineExecutionInitiator,
): CloudRunAgentChat | undefined {
  return initiator.kind === 'agent' ? initiator.chat : undefined;
}

async function runInCloud(
  action: PipelineRunAction,
  pipeline: PipelineData,
  owner: string,
  call: WatcherCall,
  destination?: CloudRunAgentDestination,
  chat?: CloudRunAgentChat,
): Promise<AgentPipelineRunResult> {
  const { info } = pipeline;
  const { startAgentCloudPipelineRun } =
    await import('../pipelines/cloud-pipeline-runs');
  const result = await startAgentCloudPipelineRun(
    {
      pipelineId:
        info.source === 'curated' && info.curatedKey !== undefined
          ? `curated:${info.curatedKey}`
          : info.id,
      scope: 'global',
      target: { scope: 'global' },
      eventName: 'dispatch',
      requestedOwner: owner,
      targetId: CLOUD_PIPELINE_RUN_TARGET_ID,
      // A redelivered tool call resends the same start, which the web core
      // answers with the run it recorded; a new call starts a new run.
      ...(call.toolUseId !== undefined
        ? { cloudIdempotencyKey: `agent-tool-call:${call.toolUseId}` }
        : {}),
      ...inputOptions(action),
      ...(info.source === 'shared' &&
      info.serverId !== undefined &&
      info.remoteId !== undefined
        ? {
            sharedPipeline: {
              serverId: info.serverId,
              remoteId: info.remoteId,
            },
          }
        : {}),
    },
    destination,
    chat,
  );
  if (result.success)
    return {
      status: 'started',
      execution: {
        executionId: result.cloudRun.operationId,
        pipelineId: info.id,
        pipelineName: info.name,
        executionStatus: result.cloudRun.admission,
        executionScope:
          destination === undefined
            ? 'global'
            : destination.worktreeId === undefined
              ? 'directory'
              : 'worktree',
        ...(destination === undefined
          ? {}
          : {
              projectId: destination.workspaceId,
              ...(destination.worktreeId === undefined
                ? {}
                : { worktreeId: destination.worktreeId }),
            }),
        owner,
        eventName: 'dispatch',
        startedAt: new Date().toISOString(),
        location: 'cloud',
      },
    };
  if (result.errorCode === 'cloud_start_uncertain')
    return rejected(
      'execution_failed',
      'The cloud run may have started. Check the Runs list before starting another; a new pipeline.run call starts a new run.',
    );
  if (result.errorCode === 'cloud_models_unconfirmed')
    return rejected(
      'execution_failed',
      'Some agent steps need a cloud model. Ask the person to choose them once in the Run dialog with Run on: Cloud; later cloud runs reuse them.',
    );
  return rejected(
    CLOUD_REFUSAL_REASONS[result.errorCode] ?? 'execution_failed',
    result.error,
  );
}

async function runDesktopPipeline(
  action: PipelineRunAction,
  host: Host,
  watcherCall: WatcherCall,
): Promise<AgentPipelineRunResult> {
  if (action.scope === 'global') return runGlobal(action, host, watcherCall);
  if (host.worktreeActionRuntime)
    return runInScopedTask(
      action,
      host.worktreeActionRuntime,
      host,
      watcherCall,
    );
  const destination = worktreeWatcherDestination(host);
  if (host.appAdvisorPipelineTarget && destination)
    return runInAppAdvisorTask(
      action,
      host.appAdvisorPipelineTarget,
      destination,
      host,
      watcherCall,
    );
  return rejected('invalid_target', APP_ADVISOR_PIPELINE_RUN_TARGET_MESSAGE);
}

/**
 * Desktop `pipeline.run`: every start goes through the main-process start
 * path. Scoped chats run in their own task or folder; App Advisor runs in
 * the task main validated, or globally; a global run takes the calling
 * chat's owner and records that chat as its initiator.
 */
export const desktopPipelinesPort: AgentPipelinesPort<Host> = {
  run: (action, call) => runDesktopPipeline(action, call.host, call),
};
