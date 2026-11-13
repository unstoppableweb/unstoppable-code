import type { CloudRunAccess } from '@canopy/agent-actions/families/pipeline-executions/cloud-runs';
import { AgentPortError } from '@canopy/agent-actions/port/environment-port';
import type { AgentJson } from '@canopy/agent-actions/response';
import { requestCloud } from '@canopy/app-state/cloud-pipeline-runs';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import type {
  AppAdvisorActionError,
  AppAdvisorJson,
} from '@canopy/desktop-shared/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { cloudRunsInvoker } from '@/lib/workflows/cloud-runs';

/**
 * Orchestrator's execution actions on cloud runs (CAN-6354, plan CP-42):
 * the shared cloud run calls of `@canopy/agent-actions` over the renderer
 * relay the Runs feed reads (CAN-6326), answering what cloud chats answer.
 * Orchestrator acts for the person across their owners, so it reaches every
 * cloud run the signed-in account reads, as its local execution actions
 * reach every run on this computer.
 */

type ActionAnswer = {
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
};

const CLOUD_RUNS_UNAVAILABLE: ActionAnswer = {
  ok: false,
  error: {
    code: 'missing_capability',
    message:
      "Cloud runs aren't available right now: sign in, or try again later.",
  },
};

/** Whether main says the signed-in account's web core serves cloud runs. */
async function cloudRunsAvailable(): Promise<boolean> {
  try {
    return (await window.pipelines.cloudRunsAvailability()).pipelineCloudRuns;
  } catch (error) {
    // Main answers false on every failure it knows; this one is unexpected.
    reportClientAppError(error);
    return false;
  }
}

/** Every cloud run the account reads, over the relay; null without it. */
async function cloudAccess(): Promise<CloudRunAccess | null> {
  const invoker = cloudRunsInvoker();
  if (invoker === null || !(await cloudRunsAvailable())) return null;
  return {
    call: (method, params, result) =>
      requestCloud(invoker, method, params, result),
    payloadOf: (error) =>
      error instanceof CoreCoworkRequestError ? error.payload : null,
    reaches: () => true,
    notFoundMessage: (executionId) =>
      `No workflow run has the id ${executionId}.`,
  };
}

async function answered(
  run: (access: CloudRunAccess) => Promise<AgentJson>,
  access: CloudRunAccess,
): Promise<ActionAnswer> {
  try {
    return { ok: true, result: await run(access) };
  } catch (error) {
    if (!(error instanceof AgentPortError)) throw error;
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryable ? { retryable: true } : {}),
      },
    };
  }
}

/** A cloud call, or why cloud runs can't be reached here. */
export async function withCloudRuns(
  run: (access: CloudRunAccess) => Promise<AgentJson>,
): Promise<ActionAnswer> {
  const access = await cloudAccess();
  return access === null ? CLOUD_RUNS_UNAVAILABLE : answered(run, access);
}

/**
 * The cloud answer for an id that names no run on this computer, or null to
 * answer locally: a failed local read, cloud runs unavailable, or a run the
 * cloud doesn't know either.
 */
export async function cloudExecutionAnswer(
  executionId: string,
  run: (access: CloudRunAccess) => Promise<AgentJson>,
): Promise<ActionAnswer | null> {
  const local = await window.pipelines.getExecution(executionId);
  if (!local.success || local.data) return null;
  const access = await cloudAccess();
  if (access === null) return null;
  const answer = await answered(run, access);
  return !answer.ok && answer.error?.code === 'not_found' ? null : answer;
}
