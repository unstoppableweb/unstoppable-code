import type { ZodType, z } from 'zod';
import {
  WorkerPipelineControlResultSchema,
  WorkerPipelineExecutionGetResultSchema,
  WorkerPipelineExecutionListResultSchema,
  WorkerPipelineExecutionResultSchema,
  type CanopyErrorPayload,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionDetail,
  type WorkerPipelineExecutionStatus,
  type WorkerPipelineExecutionView,
  type WorkerPipelinePauseResponse,
} from '@canopy/protocol/canopy-core';
import { AgentPortError } from '../../port/environment-port';
import type { AgentJson } from '../../response';

/**
 * The execution actions on cloud runs (CAN-6339, CAN-6354): list, read,
 * cancel and resume through the web core's `worker.pipeline.execution.*`
 * operations (CAN-6214). Cloud chats (web) and desktop chats and
 * Orchestrator answer with these rows, details and refusals, so an agent
 * sees one contract on every host.
 *
 * The host supplies the web core call and decides which runs the caller
 * reaches; any other run, including one the owner may not read, is
 * `not_found`, so a caller never learns that another run exists. Every
 * control is keyed by the caller's key, so a redelivered call is answered by
 * the web core's receipt instead of applying twice.
 */

/** Rows one list call returns at most, and pages it reads to fill them. */
const CLOUD_RUN_LIST_LIMIT_DEFAULT = 20;
const CLOUD_RUN_LIST_LIMIT_MAX = 100;
const CLOUD_RUN_LIST_PAGES_MAX = 5;

/** Why a cloud run has no retry: the cloud runner can't run it again in place. */
export const CLOUD_RUN_RETRY_UNSUPPORTED =
  'Cloud runs cannot be retried here yet. Start the workflow again with pipeline.run.';
export const CLOUD_RUN_MATRIX_RETRY_UNSUPPORTED =
  'The cloud runner does not retry matrix jobs yet.';
export const CLOUD_RUN_VARIANT_CANCEL_UNSUPPORTED =
  'The cloud runner does not cancel matrix variants yet.';
export const CLOUD_RUN_CHAIN_UNSUPPORTED =
  'Cloud runs have no plan file to follow up with.';

/** How a host reaches the web core and which cloud runs its caller reaches. */
export interface CloudRunAccess {
  /** One web core call; a refusal rejects with an error `payloadOf` reads. */
  readonly call: <Result extends ZodType>(
    method: string,
    params: Record<string, unknown>,
    result: Result,
  ) => Promise<z.output<Result>>;
  readonly payloadOf: (error: unknown) => CanopyErrorPayload | null;
  /** The owner whose runs a list pages; every owner the account reads when absent. */
  readonly owner?: string;
  /** Whether the caller reaches this run, read with its detail. */
  readonly reaches: (view: WorkerPipelineExecutionView) => boolean;
  /** The `not_found` message for a run the caller doesn't reach. */
  readonly notFoundMessage: (executionId: string) => string;
}

export interface CloudRunListFilters {
  readonly query?: string;
  readonly pipelineId?: string;
  readonly status?: WorkerPipelineExecutionStatus;
  readonly limit?: number;
}

export interface CloudRunResume {
  readonly statusReasonIds?: readonly string[];
  readonly pauseResponses?: readonly WorkerPipelinePauseResponse[];
}

function notFound(access: CloudRunAccess, executionId: string): AgentPortError {
  return new AgentPortError('not_found', access.notFoundMessage(executionId));
}

/** A web core refusal as the port's refusal; anything else passes through. */
function refusal(
  access: CloudRunAccess,
  error: unknown,
  executionId: string,
): unknown {
  const payload = access.payloadOf(error);
  if (payload === null) return error;
  const { kind, message } = payload;
  switch (kind) {
    case 'not_found':
    case 'permission_denied':
      return notFound(access, executionId);
    case 'invalid_argument':
      return new AgentPortError('invalid_payload', message);
    case 'failed_precondition':
    case 'conflict':
      return new AgentPortError('invalid_target', message);
    case 'unavailable':
    case 'deadline_exceeded':
    case 'resource_exhausted':
      return new AgentPortError('surface_unavailable', message, true);
    default:
      return new AgentPortError('execution_failed', message);
  }
}

async function called<Result extends ZodType>(
  access: CloudRunAccess,
  executionId: string,
  method: string,
  params: Record<string, unknown>,
  result: Result,
): Promise<z.output<Result>> {
  try {
    return await access.call(method, params, result);
  } catch (error) {
    throw refusal(access, error, executionId);
  }
}

/** The run's summary row, without host paths. */
function cloudRunRow(execution: WorkerPipelineExecution): {
  [key: string]: AgentJson;
} {
  return {
    executionId: execution.executionId,
    pipelineId: execution.pipelineId,
    pipelineName: execution.name,
    status: execution.status,
    owner: execution.owner,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    pendingPauseCount: execution.pendingPauseCount,
    error: execution.error,
    location: 'cloud',
  };
}

/** The run's detail: its jobs, and what a pause waits for. */
function cloudRunDetails(
  execution: WorkerPipelineExecution,
  detail: WorkerPipelineExecutionDetail | undefined,
): AgentJson {
  return {
    ...cloudRunRow(execution),
    // Matrix jobs list their variants: cancel and selective retry name them
    // by their physical job id.
    jobs: (detail?.jobs ?? []).map(
      (job): AgentJson => ({
        jobId: job.jobId,
        name: job.name,
        kind: job.kind,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        variants: job.variants.map(
          (variant): AgentJson => ({
            variantJobId: variant.jobId,
            name: variant.name,
            status: variant.status,
            conclusion: variant.conclusion,
            matrixJson: JSON.stringify(variant.matrix),
          }),
        ),
      }),
    ),
    // Workflow-written values (matrix values, pause-form defaults and
    // options) may look like paths; as JSON text they never read as host
    // paths, and they reach the agent exactly as the workflow wrote them.
    pendingPausesJson: JSON.stringify(detail?.pendingPauses ?? []),
    statusReasonsJson: JSON.stringify(detail?.statusReasons ?? []),
  };
}

/** Whether the run's name, workflow id or id contains the query. */
function matchesQuery(
  execution: WorkerPipelineExecution,
  query: string | undefined,
): boolean {
  const needle = query?.trim().toLowerCase() ?? '';
  return (
    needle.length === 0 ||
    [execution.name, execution.pipelineId, execution.executionId].some(
      (value) => value.toLowerCase().includes(needle),
    )
  );
}

/**
 * The newest runs the caller reaches, filtered: at most the limit (100 at
 * most), from up to five pages, with `complete: false` when more were left
 * unread, matches past the limit included.
 */
export async function listCloudRuns(
  access: CloudRunAccess,
  filters: CloudRunListFilters,
): Promise<{ [key: string]: AgentJson }> {
  const limit = Math.min(
    filters.limit ?? CLOUD_RUN_LIST_LIMIT_DEFAULT,
    CLOUD_RUN_LIST_LIMIT_MAX,
  );
  const rows: AgentJson[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (
    let page = 0;
    page < CLOUD_RUN_LIST_PAGES_MAX && rows.length < limit;
    page++
  ) {
    const answer = await called(
      access,
      '',
      'worker.pipeline.execution.list',
      {
        ...(access.owner === undefined ? {} : { owner: access.owner }),
        ...(filters.pipelineId === undefined
          ? {}
          : { pipelineId: filters.pipelineId }),
        ...(filters.status === undefined ? {} : { statuses: [filters.status] }),
        detail: true,
        limit: CLOUD_RUN_LIST_LIMIT_MAX,
        ...(cursor === undefined ? {} : { cursor }),
      },
      WorkerPipelineExecutionListResultSchema,
    );
    const matching = answer.executions.filter(
      (item) =>
        access.reaches(item) && matchesQuery(item.execution, filters.query),
    );
    const room = limit - rows.length;
    for (const item of matching.slice(0, room))
      rows.push(cloudRunRow(item.execution));
    cursor = answer.nextCursor ?? undefined;
    // Matches past the limit on the last page were left unread too.
    complete = cursor === undefined && matching.length <= room;
    if (cursor === undefined) break;
  }
  return {
    filters: {
      query: filters.query ?? '',
      pipelineId: filters.pipelineId ?? null,
      status: filters.status ?? null,
      limit,
    },
    returned: rows.length,
    // False when more runs were left unread past the pages one call reads.
    complete,
    executions: rows,
  };
}

/** The run with its detail, once the caller reaches it. */
export async function readCloudRun(
  access: CloudRunAccess,
  executionId: string,
): Promise<WorkerPipelineExecutionView> {
  const view = await called(
    access,
    executionId,
    'worker.pipeline.execution.get',
    { executionId, detail: true },
    WorkerPipelineExecutionGetResultSchema,
  );
  if (!access.reaches(view)) throw notFound(access, executionId);
  return view;
}

/** `pipeline.execution_get`: the summary with its jobs, pauses and reasons. */
export async function getCloudRun(
  access: CloudRunAccess,
  executionId: string,
): Promise<AgentJson> {
  const view = await readCloudRun(access, executionId);
  return { execution: cloudRunDetails(view.execution, view.detail) };
}

/** `pipeline.execution_cancel` through the web core's keyed cancel. */
export async function cancelCloudRun(
  access: CloudRunAccess,
  executionId: string,
  key: string,
): Promise<AgentJson> {
  await readCloudRun(access, executionId);
  const answer = await called(
    access,
    executionId,
    'worker.pipeline.execution.cancel',
    { executionId, _meta: { idempotencyKey: key } },
    WorkerPipelineExecutionResultSchema,
  );
  return { execution: cloudRunRow(answer.execution) };
}

/**
 * `pipeline.execution_resume` through the web core's keyed resume. An
 * agent's answers are the automation's, never a person's, and the rest of
 * the run is attributed to it.
 */
export async function resumeCloudRun(
  access: CloudRunAccess,
  executionId: string,
  resume: CloudRunResume,
  key: string,
  initiationSource: 'automation' | 'portal' = 'automation',
): Promise<AgentJson> {
  await readCloudRun(access, executionId);
  const answer = await called(
    access,
    executionId,
    'worker.pipeline.execution.resume',
    {
      requestId: key,
      executionId,
      ...(resume.statusReasonIds === undefined
        ? {}
        : { statusReasonIds: resume.statusReasonIds }),
      ...(resume.pauseResponses === undefined
        ? {}
        : { pauseResponses: resume.pauseResponses }),
      initiationSource,
      persistInitiationSource: true,
      _meta: { idempotencyKey: key },
    },
    WorkerPipelineControlResultSchema,
  );
  return { outcome: answer.outcome, execution: cloudRunRow(answer.execution) };
}
