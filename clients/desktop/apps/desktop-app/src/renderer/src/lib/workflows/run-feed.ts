import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type {
  AppAdvisorWatcherSummary,
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/execution-engine/types/pipeline';
import type { WorkerPipelineExecutionView } from '@canopy/protocol/canopy-core';
import { compactPipelineStatusReasonLabel } from '@canopy/ui-shared/lib';
import {
  NO_PROJECT_LABEL,
  cloudWorkflowRunRow,
  isListedCloudRun,
  normalizeAutomationRunStatus,
  sortWorkflowRunRows,
  workflowRunStarterOf,
  workflowRunStatusFromPipeline,
  workflowRunStatusFromWatcher,
  type WorkflowAutomationRunRow,
  type WorkflowPipelineRunRow,
  type WorkflowRunAction,
  type WorkflowRunResult,
  type WorkflowRunRow,
  type WorkflowRunStarter,
  type WorkflowRunStatus,
  type WorkflowWatcherRunRow,
  type WorkflowWatcherState,
} from '@canopy/ui-app/workflows';
import { resolveAutomationPipelineTarget } from '@canopy/desktop-shared/lib/automation-pipeline-target';
import { workflowPageIdForActivity } from './edit-target';

/**
 * The desktop Runs feed (CAN-3981): one projection over the stores the
 * renderer already loads. Pure, so every relationship rule is unit-tested:
 *
 * - An automation row is built from its `ScheduledActivityRun`, never
 *   inferred from a pipeline execution.
 * - A `worktree_pipeline` run owns the execution it created: that execution
 *   supplies the row's live status and actions and is left out of the
 *   Pipeline rows. A `pipeline_execution_resume` run references an execution
 *   started elsewhere, so the execution keeps its own Pipeline row.
 */

/** Names the feed shows; each returns `undefined` when the target is gone. */
export interface RunFeedNames {
  readonly project: (projectId: string) => string | undefined;
  readonly worktree: (
    projectId: string,
    worktreeId: string,
  ) => string | undefined;
  readonly chat: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ) => string | undefined;
  /** Where a watcher reports, such as `canopy · Inbox chat`. */
  readonly watcherDestination: (
    watcher: AppAdvisorWatcherSummary,
  ) => string | undefined;
}

export interface RunFeedInput {
  /** Every retained execution, from the global execution projection. */
  readonly executions: readonly ExecutionSummary[];
  /**
   * The executions were listed. While they are still loading, or the listing
   * failed, a missing execution says nothing about what is retained. Defaults
   * to `true`.
   */
  readonly executionsKnown?: boolean;
  /** The hot window, then any older pages loaded with Load more. */
  readonly runs: readonly ScheduledActivityRun[];
  /** Every activity, in or out of the current context. */
  readonly activities: readonly ScheduledActivity[];
  /** Active and completed watchers. */
  readonly watchers: readonly AppAdvisorWatcherSummary[];
  /** Scope rules from `useAutomationScope`; the feed adds none of its own. */
  readonly activityInScope: (activity: ScheduledActivity) => boolean;
  /**
   * Scope for a run whose activity was deleted. The run carries no target of
   * its own, so the host decides (Personal keeps them, as it keeps
   * executions with no project).
   */
  readonly orphanRunInScope: (run: ScheduledActivityRun) => boolean;
  readonly executionInScope: (execution: ExecutionSummary) => boolean;
  /**
   * The signed-in account's cloud runs (CAN-6326), present only while the
   * feed may list them. Their rows say they ran in the cloud, and every
   * pipeline row then says where it ran.
   */
  readonly cloudRuns?: readonly WorkerPipelineExecutionView[];
  readonly cloudRunInScope?: (view: WorkerPipelineExecutionView) => boolean;
  readonly watcherInScope: (watcher: AppAdvisorWatcherSummary) => boolean;
  /**
   * Actions the existing execution handlers allow for one execution
   * (`lib/execution-actions.ts` gates). The feed never decides these.
   */
  readonly executionActions: (
    execution: ExecutionSummary,
  ) => readonly WorkflowRunAction[];
  /** Whether an automation run's destination still opens, and why not. */
  readonly automationRunResult: (
    run: ScheduledActivityRun,
    activity: ScheduledActivity | undefined,
  ) => WorkflowRunResult;
  /**
   * Whether an automation run's result names a chat (CAN-5381): a pipeline
   * run records the chat it sent to once its execution ends.
   */
  readonly automationRunOpensChat?: (run: ScheduledActivityRun) => boolean;
  readonly names: RunFeedNames;
}

export function automationRunKey(runId: string): string {
  return `automation-run:${runId}`;
}

export function pipelineRunKey(executionId: string): string {
  return `pipeline-run:${executionId}`;
}

export function watcherRunKey(watcherId: string): string {
  return `watcher:${watcherId}`;
}

export function automationLibraryKey(activityId: string): string {
  return `automation:${activityId}`;
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function automationRunStarter(run: ScheduledActivityRun): WorkflowRunStarter {
  switch (run.trigger) {
    case 'scheduled':
      return 'schedule';
    case 'catch_up':
      return 'catch-up';
    case 'manual':
      return 'run-now';
    case undefined:
      // Runs recorded before `trigger` existed carry only `manual`.
      return run.manual ? 'run-now' : 'schedule';
  }
}

function executionStarter(execution: ExecutionSummary): WorkflowRunStarter {
  return workflowRunStarterOf({
    initiator: execution.initiator,
    event: execution.event_name,
    hook: execution.trigger_source?.kind === 'hook',
  });
}

/** Where a pipeline automation with no project runs. */
const PIPELINE_NO_PROJECT_LABEL = 'No project';
/** A stored pipeline destination the validator would reject. */
const PIPELINE_DESTINATION_UNAVAILABLE_LABEL = 'Unavailable destination';

function joinWhere(
  project: string | undefined,
  place: string | undefined,
): string | undefined {
  if (project && place) return `${project} · ${place}`;
  return project ?? place;
}

function pipelineAutomationWhere(
  action: Extract<AutomationAction, { type: 'worktree_pipeline' }>,
  names: RunFeedNames,
): string | undefined {
  const destination = resolveAutomationPipelineTarget(action);
  // Stored data the validator rejects keeps its row; nothing picks a
  // fallback project for it.
  if (!destination) return PIPELINE_DESTINATION_UNAVAILABLE_LABEL;
  switch (destination.kind) {
    case 'global':
      return PIPELINE_NO_PROJECT_LABEL;
    case 'project':
      return names.project(destination.workspaceId);
    case 'task':
      // A Work Entry or removed worktree has no name here; never show its ID.
      return joinWhere(
        names.project(destination.workspaceId),
        names.worktree(destination.workspaceId, destination.taskId) ??
          'existing task',
      );
    case 'new_worktree':
      return joinWhere(names.project(destination.workspaceId), 'new worktree');
  }
}

function automationRunWhere(
  action: AutomationAction | undefined,
  run: ScheduledActivityRun,
  names: RunFeedNames,
): string | undefined {
  if (action === undefined) {
    const projectId = run.target?.workspaceId ?? run.result?.projectId;
    return projectId ? names.project(projectId) : undefined;
  }
  switch (action.type) {
    case 'app_advisor_prompt':
      return ORCHESTRATOR_LABEL;
    case 'standalone_prompt':
      return joinWhere(names.project(action.chatProjectId), 'new chat');
    case 'worktree_prompt':
      return joinWhere(
        names.project(action.workspaceId),
        action.existingWorktreeId
          ? (names.worktree(action.workspaceId, action.existingWorktreeId) ??
              'new chat')
          : 'new worktree',
      );
    case 'worktree_session_prompt':
      return joinWhere(
        names.project(action.workspaceId),
        names.chat(action.workspaceId, action.worktreeId, action.chatId) ??
          action.chatTitle,
      );
    case 'worktree_pipeline':
      return pipelineAutomationWhere(action, names);
    case 'pipeline_execution_resume':
      return action.projectId ? names.project(action.projectId) : undefined;
  }
}

/** One action in the three tenses a run's detail line needs. */
interface ActionPhrases {
  readonly running: string;
  readonly done: string;
  readonly failed: string;
}

/** The recorded result is all that is known once the automation is deleted. */
function deletedAutomationPhrases(run: ScheduledActivityRun): ActionPhrases {
  if (run.result?.pipelineExecutionId) {
    return {
      running: 'Running a workflow',
      done: 'Ran a workflow',
      failed: 'The workflow failed',
    };
  }
  if (run.result?.appAdvisorChatId) {
    return {
      running: `Asking ${ORCHESTRATOR_LABEL}`,
      done: `Asked ${ORCHESTRATOR_LABEL}`,
      failed: `Could not ask ${ORCHESTRATOR_LABEL}`,
    };
  }
  return {
    running: 'Running',
    done: 'Ran an automation that was deleted',
    failed: 'The run failed',
  };
}

function automationActionPhrases(
  action: AutomationAction,
  names: RunFeedNames,
): ActionPhrases {
  switch (action.type) {
    case 'app_advisor_prompt':
      return {
        running: `Asking ${ORCHESTRATOR_LABEL}`,
        done: `Asked ${ORCHESTRATOR_LABEL}`,
        failed: `Could not ask ${ORCHESTRATOR_LABEL}`,
      };
    case 'standalone_prompt':
    case 'worktree_prompt': {
      const project = names.project(
        action.type === 'standalone_prompt'
          ? action.chatProjectId
          : action.workspaceId,
      );
      const target = project ? ` in ${project}` : '';
      return {
        running: `Starting a chat${target}`,
        done: `Started a chat${target}`,
        failed: `Could not start a chat${target}`,
      };
    }
    case 'worktree_session_prompt': {
      const chat =
        names.chat(action.workspaceId, action.worktreeId, action.chatId) ??
        action.chatTitle;
      const target = chat ? ` to ${chat}` : ' to a chat';
      return {
        running: `Sending a message${target}`,
        done: `Sent a message${target}`,
        failed: `Could not send a message${target}`,
      };
    }
    case 'worktree_pipeline': {
      const name = action.pipelineName ?? action.pipelineId;
      return {
        running: `Running workflow ${name}`,
        done: `Workflow ${name} finished`,
        failed: `Workflow ${name} failed`,
      };
    }
    case 'pipeline_execution_resume':
      return {
        running: `Resuming workflow ${action.pipelineName}`,
        done: `Resumed workflow ${action.pipelineName}`,
        failed: `Could not resume workflow ${action.pipelineName}`,
      };
  }
}

/** What the run did, as a present, past or failed phrase. */
function describeAutomationAction(
  action: AutomationAction | undefined,
  run: ScheduledActivityRun,
  status: WorkflowRunStatus,
  names: RunFeedNames,
): string {
  const phrases = action
    ? automationActionPhrases(action, names)
    : deletedAutomationPhrases(run);
  if (status === 'running' || status === 'queued') return phrases.running;
  return status === 'failure' ? phrases.failed : phrases.done;
}

function describeSkip(run: ScheduledActivityRun): string {
  switch (run.skipReason) {
    case 'if_command_exit':
      return 'If command did not pass, so nothing ran';
    case 'idempotency':
      return 'If command reported a result already handled, so nothing ran';
    case 'already_running':
      return 'The previous run was still going, so this one was skipped';
    case undefined:
      return 'Skipped, so nothing ran';
  }
}

function describeMissed(run: ScheduledActivityRun): string {
  const omitted = run.omittedCount ?? 0;
  if (omitted <= 0) return 'The app was not running';
  const more = run.missedOccurrencesTruncated === true ? ' or more' : '';
  return `The app was not running. ${String(omitted)}${more} more missed`;
}

/**
 * The detail line, in the order the run happened: the If command gate when
 * there is one, then the action and its outcome.
 */
function automationRunDetail(
  run: ScheduledActivityRun,
  activity: ScheduledActivity | undefined,
  status: WorkflowRunStatus,
  names: RunFeedNames,
  outputGone: boolean,
): string {
  if (status === 'skipped') return describeSkip(run);
  if (status === 'missed') return describeMissed(run);
  if (run.ifCommandError) {
    return `If command could not run: ${run.ifCommandError}`;
  }
  const parts: string[] = [];
  const gated =
    activity?.ifCommand !== undefined || run.ifCommandOutput !== undefined;
  if (gated) parts.push('If command passed');
  if (status === 'canceled') {
    parts.push('Canceled');
  } else {
    const action = describeAutomationAction(
      activity?.action,
      run,
      status,
      names,
    );
    parts.push(
      status === 'failure' && run.error ? `${action}: ${run.error}` : action,
    );
  }
  if (outputGone) parts.push('The run output is no longer kept');
  return parts.join(' · ');
}

function executionDetail(execution: ExecutionSummary): string | undefined {
  if (execution.status === 'paused') {
    const label = compactPipelineStatusReasonLabel(execution.status_reasons);
    return label === 'Paused' ? 'Waiting for you' : label;
  }
  return undefined;
}

function mergeActions(
  ...groups: readonly (readonly WorkflowRunAction[])[]
): readonly WorkflowRunAction[] {
  return Array.from(new Set(groups.flat()));
}

function automationRunEndedAt(run: ScheduledActivityRun): number | undefined {
  const completed = parseTime(run.completedAt);
  if (completed !== undefined) return completed;
  const started = parseTime(run.startedAt);
  return started !== undefined && run.durationMs !== undefined
    ? started + run.durationMs
    : undefined;
}

function automationRowResult(
  run: ScheduledActivityRun,
  activity: ScheduledActivity | undefined,
  status: WorkflowRunStatus,
  outputGone: boolean,
  hasLiveExecution: boolean,
  input: RunFeedInput,
): WorkflowRunResult {
  // A skipped or missed run did nothing, so it has nothing to open.
  if (status === 'skipped' || status === 'missed') return { available: false };
  if (outputGone) {
    return { available: false, reason: 'The run output is no longer kept.' };
  }
  if (hasLiveExecution) return { available: true };
  return input.automationRunResult(run, activity);
}

function buildAutomationRow(
  run: ScheduledActivityRun,
  activity: ScheduledActivity | undefined,
  executionsById: ReadonlyMap<string, ExecutionSummary>,
  input: RunFeedInput,
): { row: WorkflowAutomationRunRow; ownedExecutionId: string | undefined } {
  const recorded = normalizeAutomationRunStatus(run.status);
  const executionId = run.result?.pipelineExecutionId;
  const linked =
    executionId !== undefined ? executionsById.get(executionId) : undefined;
  // Only the run that created the execution owns it. The run record does not
  // say which action it ran, so the automation's action decides while it has
  // one of the two pipeline actions. Start times are not used then: a retry
  // restarts a resumed execution's clock, after its resume run. Once the
  // automation is deleted or runs something else, an execution that started
  // no earlier than the run is taken as the one it created.
  const owns =
    executionId !== undefined &&
    (activity?.action.type === 'worktree_pipeline' ||
      (activity?.action.type !== 'pipeline_execution_resume' &&
        linked !== undefined &&
        (parseTime(linked.started_at) ?? 0) >=
          (parseTime(run.startedAt) ?? Number.POSITIVE_INFINITY)));
  const execution = owns ? linked : undefined;
  const outputGone =
    owns &&
    execution === undefined &&
    recorded !== 'running' &&
    input.executionsKnown !== false;
  // While the linked execution is retained it is the live source of truth:
  // the automation's own record ends when the pipeline is dispatched.
  const status: WorkflowRunStatus = execution
    ? workflowRunStatusFromPipeline(execution.status)
    : recorded;
  const result = automationRowResult(
    run,
    activity,
    status,
    outputGone,
    execution !== undefined,
    input,
  );
  const row: WorkflowAutomationRunRow = {
    kind: 'automation',
    key: automationRunKey(run.id),
    runId: run.id,
    activityId: run.activityId,
    name: run.activityName || activity?.name || 'Automation',
    status,
    starter: automationRunStarter(run),
    where: automationRunWhere(activity?.action, run, input.names),
    startedAt: parseTime(run.startedAt),
    endedAt: execution
      ? parseTime(execution.completed_at)
      : automationRunEndedAt(run),
    detail: automationRunDetail(run, activity, status, input.names, outputGone),
    ...(status === 'skipped' && run.ifCommandOutput
      ? { output: run.ifCommandOutput }
      : {}),
    actions: mergeActions(
      // Hide is the execution's own flag; this row is the automation's run.
      execution
        ? input
            .executionActions(execution)
            .filter((action) => action !== 'hide')
        : [],
      run.cancellable === true && run.status === 'running' ? ['cancel'] : [],
      // The row opens its execution, so the chat it sent to is an action.
      execution && input.automationRunOpensChat?.(run) === true
        ? ['go-to-chat']
        : [],
      // A workflow schedule's run opens its Workflow page (CAN-5782).
      activity && workflowPageIdForActivity(activity) !== undefined
        ? ['open-workflow']
        : [],
      activity ? ['open-library'] : [],
    ),
    ...(activity ? { libraryRowKey: automationLibraryKey(activity.id) } : {}),
    ...(executionId !== undefined && owns
      ? { linkedExecutionId: executionId }
      : {}),
    cancellable: run.cancellable === true && run.status === 'running',
    result,
  };
  return { row, ownedExecutionId: execution ? executionId : undefined };
}

function buildPipelineRow(
  execution: ExecutionSummary,
  input: RunFeedInput,
): WorkflowPipelineRunRow {
  // A run with no project says so; a recorded project that is gone keeps the
  // missing-project rendering.
  const project =
    execution.project_id === undefined
      ? NO_PROJECT_LABEL
      : input.names.project(execution.project_id);
  const worktree =
    execution.project_id && execution.worktree_id
      ? input.names.worktree(execution.project_id, execution.worktree_id)
      : undefined;
  return {
    kind: 'pipeline',
    key: pipelineRunKey(execution.id),
    name: execution.pipeline_name,
    status: workflowRunStatusFromPipeline(execution.status),
    starter: executionStarter(execution),
    ...(input.cloudRuns === undefined ? {} : { location: 'local' }),
    where: joinWhere(project, worktree),
    startedAt: parseTime(execution.started_at),
    endedAt: parseTime(execution.completed_at),
    detail: executionDetail(execution),
    actions: input.executionActions(execution),
    result: { available: true },
    summary: execution,
  };
}

function watcherState(watcher: AppAdvisorWatcherSummary): WorkflowWatcherState {
  switch (watcher.status) {
    case 'active':
      return 'watching';
    case 'firing':
      return 'firing';
    case 'fired':
      return 'fired';
    case 'delivery_failed':
      return 'delivery-failed';
  }
}

function buildWatcherRow(
  watcher: AppAdvisorWatcherSummary,
  input: RunFeedInput,
): WorkflowWatcherRunRow {
  const state = watcherState(watcher);
  const subscriberLabel = input.names.watcherDestination(watcher);
  return {
    kind: 'watcher',
    key: watcherRunKey(watcher.id),
    watcherId: watcher.id,
    state,
    name: watcher.label,
    status: workflowRunStatusFromWatcher(state),
    starter: 'chat',
    where: subscriberLabel,
    ...(subscriberLabel ? { subscriberLabel } : {}),
    startedAt: parseTime(watcher.createdAt),
    endedAt: parseTime(watcher.completedAt ?? watcher.firedAt),
    detail:
      state === 'delivery-failed'
        ? (watcher.deliveryError ?? 'The result could not be delivered')
        : undefined,
    // A cancelled watcher is deleted, so it simply leaves the feed.
    actions:
      state === 'watching'
        ? ['cancel', 'inspect', 'go-to-chat']
        : ['inspect', 'go-to-chat'],
    result: { available: true },
  };
}

/** Runs by id, first occurrence wins, so a Load more page never duplicates. */
export function mergeAutomationRuns(
  ...pages: readonly (readonly ScheduledActivityRun[])[]
): ScheduledActivityRun[] {
  const seen = new Set<string>();
  const merged: ScheduledActivityRun[] = [];
  for (const page of pages) {
    for (const run of page) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      merged.push(run);
    }
  }
  return merged;
}

/** The feed's rows for the current context: active first, then newest. */
export function buildWorkflowRunRows(
  input: RunFeedInput,
): readonly WorkflowRunRow[] {
  const activitiesById = new Map(
    input.activities.map((activity) => [activity.id, activity]),
  );
  const executionsById = new Map(
    input.executions.map((execution) => [execution.id, execution]),
  );
  const rows: WorkflowRunRow[] = [];
  const ownedExecutionIds = new Set<string>();

  for (const run of mergeAutomationRuns(input.runs)) {
    const activity = activitiesById.get(run.activityId);
    const inScope = activity
      ? input.activityInScope(activity)
      : input.orphanRunInScope(run);
    if (!inScope) continue;
    const { row, ownedExecutionId } = buildAutomationRow(
      run,
      activity,
      executionsById,
      input,
    );
    rows.push(row);
    if (ownedExecutionId !== undefined) ownedExecutionIds.add(ownedExecutionId);
  }

  for (const execution of input.executions) {
    // A sub-pipeline is part of its parent's run, and a hidden run was
    // dismissed by the user.
    if (execution.parent_execution_id !== undefined) continue;
    if (execution.hidden === true) continue;
    if (ownedExecutionIds.has(execution.id)) continue;
    if (!input.executionInScope(execution)) continue;
    rows.push(buildPipelineRow(execution, input));
  }

  for (const view of input.cloudRuns ?? []) {
    if (!isListedCloudRun(view)) continue;
    if (input.cloudRunInScope && !input.cloudRunInScope(view)) continue;
    rows.push(cloudWorkflowRunRow(view));
  }

  for (const watcher of input.watchers) {
    if (!input.watcherInScope(watcher)) continue;
    rows.push(buildWatcherRow(watcher, input));
  }

  return sortWorkflowRunRows(rows);
}

/**
 * An automation's Runs section in the edit shell (CAN-4072): the feed rows
 * for its own runs, in the feed's order. A run that started a pipeline
 * already carries that execution's status and actions; a resume run's
 * execution belongs to the pipeline that started it.
 */
export function runsForAutomation(
  rows: readonly WorkflowRunRow[],
  activityId: string,
): readonly WorkflowRunRow[] {
  return rows.filter(
    (row) => row.kind === 'automation' && row.activityId === activityId,
  );
}

/**
 * The activities Load more fans out to: those with a run in the loaded
 * window, and those that have run before. The hot window is one list shared
 * by every automation, so a frequent one can push another's runs out of it;
 * `lastResult` says that automation still has history. One that never ran is
 * left out.
 */
export function activitiesWithRunHistory(
  runs: readonly ScheduledActivityRun[],
  activities: readonly ScheduledActivity[],
  activityInScope: (activity: ScheduledActivity) => boolean,
): readonly ScheduledActivity[] {
  const withRuns = new Set(runs.map((run) => run.activityId));
  return activities.filter(
    (activity) =>
      (withRuns.has(activity.id) || activity.lastResult !== undefined) &&
      activityInScope(activity),
  );
}

/** Older runs are fetched per automation, this many automations at a time. */
const LOAD_MORE_CONCURRENCY = 3;
const LOAD_MORE_PAGE_SIZE = 50;
/** How many pages one Load more reads while every run is already listed. */
const LOAD_MORE_MAX_ROUNDS = 5;

export interface OlderAutomationRunsRequest {
  /** The automations whose history may hold older runs. */
  readonly activities: readonly ScheduledActivity[];
  /**
   * Each automation's next page: absent before its first page, `null` once
   * its history is fully read. Updated in place as pages arrive.
   */
  readonly cursors: Map<string, string | null>;
  /** Runs the feed already lists. */
  readonly listedRunIds: ReadonlySet<string>;
  readonly listRuns: (request: {
    activityId: string;
    limit: number;
    cursor?: string;
  }) => Promise<{
    readonly runs: readonly ScheduledActivityRun[];
    readonly nextCursor: string | null;
  }>;
}

/**
 * Reads the next page of each automation's run history. An automation's
 * first page repeats runs the hot window already lists, so this keeps paging
 * until a run that is not listed yet arrives, every history is fully read, or
 * a page fails. A failed page keeps its cursor, so it is asked for again.
 */
export async function loadOlderAutomationRuns({
  activities,
  cursors,
  listedRunIds,
  listRuns,
}: OlderAutomationRunsRequest): Promise<{
  readonly loaded: readonly ScheduledActivityRun[];
  readonly failed: boolean;
}> {
  const loaded: ScheduledActivityRun[] = [];
  let failed = false;
  for (
    let round = 0, added = false;
    round < LOAD_MORE_MAX_ROUNDS && !added && !failed;
    round += 1
  ) {
    const queue = activities.filter(
      (activity) => cursors.get(activity.id) !== null,
    );
    if (queue.length === 0) break;
    const worker = async (): Promise<void> => {
      for (
        let activity = queue.shift();
        activity !== undefined;
        activity = queue.shift()
      ) {
        const cursor = cursors.get(activity.id);
        try {
          const response = await listRuns({
            activityId: activity.id,
            limit: LOAD_MORE_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          });
          loaded.push(...response.runs);
          cursors.set(activity.id, response.nextCursor);
        } catch {
          // One automation's history failing leaves the others loadable.
          failed = true;
        }
      }
    };
    await Promise.all(
      Array.from({ length: LOAD_MORE_CONCURRENCY }, () => worker()),
    );
    added = loaded.some((run) => !listedRunIds.has(run.id));
  }
  return { loaded, failed };
}
