import { createHash } from 'node:crypto';
import {
  AgentPortError,
  CLOUD_RUN_RETRY_UNSUPPORTED,
  agentActionIdempotencyKey,
  agentActionResult,
  cancelCloudRun,
  getCloudRun,
  listCloudRuns,
  readCloudRun,
  resumeCloudRun,
  type AgentActionCall,
  type AgentActionDispatchOutput,
  type AgentJson,
  type AgentPipelineExecutionsPort,
  type CloudRunAccess,
  type PipelineExecutionAction,
} from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { dispatchWorktreeAction } from '../canopy-tools/worktree-actions';

type Call = AgentActionCall<CanopyInjectedToolRuntime>;

/**
 * Runs an execution action on the worktree action path these actions have
 * always taken: the calling chat's task runs and the global runs it
 * started, through the main-process execution handlers.
 */
async function dispatchExecutionAction(
  action: PipelineExecutionAction,
  call: Call,
): Promise<AgentActionDispatchOutput> {
  const runtime = call.host.worktreeActionRuntime;
  if (!runtime) {
    return {
      text: 'DispatchAction is only available for worktree chats.',
      isError: true,
    };
  }
  // A Stop's abort signal reaches the action, so a long dispatch can end early.
  return dispatchWorktreeAction(
    { action },
    call.signal ? { ...runtime, signal: call.signal } : runtime,
  );
}

/**
 * The control's key, one per tool call, as cloud chats key theirs. A worktree
 * chat's MCP call id restarts with each connection, so the key also takes the
 * turn (resolved for these calls) and the payload: a reused id in a later
 * turn, or for another run or pause, never replays an earlier control.
 */
function controlKey(action: PipelineExecutionAction, call: Call): string {
  const key = agentActionIdempotencyKey(action.type, call, action);
  const hash = createHash('sha256')
    .update(key)
    .update('\u0000')
    .update(JSON.stringify(action))
    .digest('hex');
  return `agent-action:${hash}`;
}

/** The calling chat's cloud run access, once cloud runs are available. */
async function cloudAccess(call: Call): Promise<CloudRunAccess | null> {
  const runtime = call.host.worktreeActionRuntime;
  if (!runtime) return null;
  const cloud = await import('./desktop-cloud-runs');
  if (!(await cloud.cloudRunsAvailable())) return null;
  return cloud.desktopCloudRunAccess(runtime);
}

function isNotFound(output: AgentActionDispatchOutput): boolean {
  return 'ok' in output && !output.ok && output.error?.code === 'not_found';
}

/**
 * An id that names no run on this computer may name a cloud run
 * (CAN-6354): while the signed-in account's web core serves cloud runs, the
 * action goes there. A run the cloud doesn't reach either keeps the local
 * answer.
 */
async function localOrCloud(
  action: Extract<PipelineExecutionAction, { executionId: string }>,
  call: Call,
  cloud: (access: CloudRunAccess) => Promise<AgentJson>,
): Promise<AgentActionDispatchOutput> {
  const local = await dispatchExecutionAction(action, call);
  if (!isNotFound(local)) return local;
  try {
    const access = await cloudAccess(call);
    if (access === null) return local;
    return agentActionResult(call, action.type, await cloud(access));
  } catch (error) {
    // Any other refusal is the family's to answer.
    if (error instanceof AgentPortError && error.code === 'not_found')
      return local;
    throw error;
  }
}

/**
 * The desktop pipeline executions port (CAN-6339): the calling chat's task
 * runs and the global runs it started, and its owner's cloud runs through
 * the shared cloud run calls (CAN-6354), as cloud chats answer theirs.
 */
export const desktopPipelineExecutionsPort: AgentPipelineExecutionsPort<CanopyInjectedToolRuntime> =
  {
    async list(action, call) {
      if (action.type !== 'pipeline.execution_list' || action.runOn !== 'cloud')
        return dispatchExecutionAction(action, call);
      const access = await cloudAccess(call);
      if (access === null) {
        const { CLOUD_RUNS_UNAVAILABLE_MESSAGE } =
          await import('./desktop-cloud-runs');
        throw new AgentPortError(
          'missing_capability',
          CLOUD_RUNS_UNAVAILABLE_MESSAGE,
        );
      }
      const body = await listCloudRuns(access, action);
      return agentActionResult(call, action.type, {
        scope: { owner: access.owner ?? null },
        ...body,
      });
    },
    get: (action, call) =>
      localOrCloud(action, call, (access) =>
        getCloudRun(access, action.executionId),
      ),
    cancel: (action, call) =>
      localOrCloud(action, call, (access) =>
        cancelCloudRun(access, action.executionId, controlKey(action, call)),
      ),
    resume: (action, call) =>
      localOrCloud(action, call, (access) =>
        resumeCloudRun(
          access,
          action.executionId,
          {
            ...(action.statusReasonIds === undefined
              ? {}
              : { statusReasonIds: action.statusReasonIds }),
            ...(action.pauseResponses === undefined
              ? {}
              : { pauseResponses: action.pauseResponses }),
          },
          controlKey(action, call),
          call.host.worktreeActionRuntime?.pipelineInitiationSource ??
            'automation',
        ),
      ),
    // A cloud run has no retry yet, as on cloud chats: say so for a cloud
    // run's id instead of not finding it.
    retry: (action, call) =>
      localOrCloud(action, call, async (access) => {
        await readCloudRun(access, action.executionId);
        throw new AgentPortError(
          'unsupported_action',
          CLOUD_RUN_RETRY_UNSUPPORTED,
        );
      }),
    retryMatrixJob: dispatchExecutionAction,
    cancelMatrixVariant: dispatchExecutionAction,
    chain: dispatchExecutionAction,
  };
