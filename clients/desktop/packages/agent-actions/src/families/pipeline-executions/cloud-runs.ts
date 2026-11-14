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
import { sha256Hex } from '../../sha256';

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

/** A cloud run's terminal status, as a watcher filters on it. */
export type CloudRunTerminalStatus = 'success' | 'failure' | 'cancelled';

function terminalStatusOf(
  status: WorkerPipelineExecutionStatus,
): CloudRunTerminalStatus | null {
  return status === 'success' || status === 'failure' || status === 'cancelled'
    ? status
    : null;
}

/**
 * What identifies one pause of a cloud run for its watchers (CAN-6391): the
 * run, and when the whole run paused, which its detail keeps while it stays
 * paused, so every read of one pause gives one key and a run that pauses
 * again has a new one. Null while the run isn't paused, and while its
 * detail has not caught up with a pause its summary shows, so a view that
 * pairs a new status with older detail never names a pause.
 */
export function cloudRunPauseKey(
  view: WorkerPipelineExecutionView,
): string | null {
  const pausedAt = view.detail?.pausedAt ?? null;
  if (view.execution.status !== 'paused' || pausedAt === null) return null;
  return sha256Hex(JSON.stringify([view.execution.executionId, pausedAt]));
}

/** What a cloud run watcher's look at its runs found. */
export type CloudRunWatchLook =
  /** A run paused, and its watcher has not reported this pause yet. */
  | {
      readonly kind: 'paused';
      readonly view: WorkerPipelineExecutionView;
      readonly pauseKey: string;
    }
  /** A run ended with a status the watcher fires on. */
  | {
      readonly kind: 'ended';
      readonly view: WorkerPipelineExecutionView;
      readonly status: CloudRunTerminalStatus;
    }
  /** The run ended with a status the watcher does not fire on. */
  | { readonly kind: 'unwatched' }
  /** Nothing to report yet. */
  | { readonly kind: 'live' };

export interface CloudRunWatchFilter {
  /** The terminal statuses that fire the watcher; empty fires on all. */
  readonly terminalStatuses: readonly CloudRunTerminalStatus[];
  /** Whether the watcher already reported this pause of this run. */
  readonly reported: (executionId: string, pauseKey: string) => boolean;
  /**
   * When the watcher was armed: a pause that began before it is not
   * reported, as a watcher only hears of pauses after it is armed.
   */
  readonly armedAt?: string;
}

/**
 * One watched run's state for its watcher: a pause it has not reported, an
 * end with a status it fires on (`ended`) or with another (`unwatched`), or
 * neither (`live`).
 */
export function lookAtWatchedCloudRun(
  view: WorkerPipelineExecutionView,
  filter: CloudRunWatchFilter,
): CloudRunWatchLook {
  // A paused run whose detail has not caught up is looked at again later.
  if (view.execution.status === 'paused' && view.detail?.pausedAt == null)
    return { kind: 'live' };
  const pauseKey = cloudRunPauseKey(view);
  if (pauseKey !== null) {
    const pausedAt = view.detail?.pausedAt ?? null;
    const before =
      filter.armedAt !== undefined &&
      pausedAt !== null &&
      Date.parse(pausedAt) < Date.parse(filter.armedAt);
    return before || filter.reported(view.execution.executionId, pauseKey)
      ? { kind: 'live' }
      : { kind: 'paused', view, pauseKey };
  }
  const status = terminalStatusOf(view.execution.status);
  if (status === null) return { kind: 'live' };
  return filter.terminalStatuses.length === 0 ||
    filter.terminalStatuses.includes(status)
    ? { kind: 'ended', view, status }
    : { kind: 'unwatched' };
}

/**
 * What a watcher on the runs a chat starts later reports next, given those
 * runs oldest first: the oldest pause it has not reported, then the oldest
 * end it fires on. A pause comes first because reporting it leaves the
 * watcher armed, and an end consumes it. A run that ended with a status the
 * watcher does not fire on is passed over, since another run may still fire
 * it, so this is never `unwatched`.
 */
export function lookAtWatchedCloudRuns(
  views: readonly WorkerPipelineExecutionView[],
  filter: CloudRunWatchFilter,
): CloudRunWatchLook {
  const looks = views.map((view) => lookAtWatchedCloudRun(view, filter));
  return (
    looks.find((look) => look.kind === 'paused') ??
    looks.find((look) => look.kind === 'ended') ?? { kind: 'live' }
  );
}

/** Pages one look at the runs started since a watcher was armed reads. */
const CLOUD_RUN_WATCH_PAGES_MAX = 2;

/**
 * The runs the caller reaches that started at or after `since`, oldest
 * first, of one workflow when `pipelineId` names it (CAN-6391): what a
 * watcher on the runs a chat starts later looks at. The list is read newest
 * first and stops at the first run that started before `since`, after two
 * pages of 100 at most; `complete` is false when runs that started since
 * were left unread.
 */
export async function listCloudRunsStartedSince(
  access: CloudRunAccess,
  filters: { readonly since: string; readonly pipelineId?: string },
): Promise<{
  readonly runs: WorkerPipelineExecutionView[];
  readonly complete: boolean;
}> {
  const since = Date.parse(filters.since);
  const runs: WorkerPipelineExecutionView[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CLOUD_RUN_WATCH_PAGES_MAX; page++) {
    const answer = await called(
      access,
      '',
      'worker.pipeline.execution.list',
      {
        ...(access.owner === undefined ? {} : { owner: access.owner }),
        ...(filters.pipelineId === undefined
          ? {}
          : { pipelineId: filters.pipelineId }),
        detail: true,
        limit: CLOUD_RUN_LIST_LIMIT_MAX,
        ...(cursor === undefined ? {} : { cursor }),
      },
      WorkerPipelineExecutionListResultSchema,
    );
    for (const view of answer.executions) {
      if (Date.parse(view.execution.startedAt) < since)
        return { runs: runs.reverse(), complete: true };
      if (access.reaches(view)) runs.push(view);
    }
    cursor = answer.nextCursor ?? undefined;
    if (cursor === undefined) return { runs: runs.reverse(), complete: true };
  }
  return { runs: runs.reverse(), complete: false };
}

/** Live runs a watcher on later runs keeps reading by id, at most. */
export const CLOUD_RUN_WATCH_TRACKED_MAX = 50;

/**
 * One look of a watcher on the runs a chat starts later (CAN-6391): the
 * runs the list shows back to `since`, plus the live runs an earlier look
 * found (`tracked`), read by id, all at once, when the list no longer shows
 * them, since newer runs can push a run past the pages one look reads.
 * `tracked` comes back as the runs still live or ended unreported, newest
 * last, for the next look: a tracked run the caller no longer reaches is
 * dropped, and one that could not be read now is kept for the next look.
 * `inView` is every run the look listed or tracked: the runs a watcher may
 * still hear of, whose reported pauses it keeps.
 */
export async function lookAtLaterCloudRuns(
  access: CloudRunAccess,
  filters: {
    readonly since: string;
    readonly pipelineId?: string;
    readonly tracked: readonly string[];
  },
  filter: CloudRunWatchFilter,
): Promise<{
  readonly look: CloudRunWatchLook;
  readonly tracked: string[];
  readonly inView: string[];
  readonly complete: boolean;
}> {
  const later = await listCloudRunsStartedSince(access, {
    since: filters.since,
    ...(filters.pipelineId === undefined
      ? {}
      : { pipelineId: filters.pipelineId }),
  });
  const listed = new Set(later.runs.map((view) => view.execution.executionId));
  const unlisted = filters.tracked.filter((id) => !listed.has(id));
  const reads = await Promise.allSettled(
    unlisted.map((executionId) => readCloudRun(access, executionId)),
  );
  const views = [...later.runs];
  const unread: string[] = [];
  reads.forEach((read, index) => {
    const executionId = unlisted[index];
    if (read.status === 'fulfilled') views.push(read.value);
    else if (
      executionId !== undefined &&
      (!(read.reason instanceof AgentPortError) ||
        read.reason.code !== 'not_found')
    )
      unread.push(executionId);
  });
  views.sort(
    (left, right) =>
      Date.parse(left.execution.startedAt) -
      Date.parse(right.execution.startedAt),
  );
  return {
    look: lookAtWatchedCloudRuns(views, filter),
    // A run that ended with a watched status stays tracked until a look
    // reports its end: a pause reported first leaves it for the next look.
    tracked: [
      ...unread,
      ...views
        .filter(
          (view) =>
            terminalStatusOf(view.execution.status) === null ||
            lookAtWatchedCloudRun(view, filter).kind === 'ended',
        )
        .map((view) => view.execution.executionId),
    ].slice(-CLOUD_RUN_WATCH_TRACKED_MAX),
    inView: [...listed, ...unlisted],
    complete: later.complete && unread.length === 0,
  };
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
