import type {
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionSummary,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { pipelineSharePath } from '@canopy/protocol/pipelines';
import { authorShareRemoteIds } from '@canopy/protocol/sharing';
import {
  describeFiveFieldCron,
  type WorkflowLastRunState,
} from '@canopy/ui-shared/lib';
import { ownShareAudienceText } from '@canopy/ui-shared/components';
import {
  describePipelineTriggers,
  describeRunUnavailable,
  describeStepCount,
  formatOneTimeTrigger,
  pipelineTriggerKinds,
  type WorkflowLibraryAction,
  type WorkflowLibraryRow,
  type WorkflowLibrarySource,
  type WorkflowStepGlyph,
  type WorkflowTriggerKind,
  WORKFLOW_NO_PROJECT,
  withoutAutomationOwnedPipelines,
} from '@canopy/ui-app/workflows';
import { canDuplicateAutomation } from './automation-duplicate';
import { automationLibraryKey } from './run-feed';
import { activityProjectId } from './schedule-filter';

/**
 * The desktop Library rows (CAN-3981): a pure projection over what the
 * renderer already loads. Every automation is a row and every pipeline is a
 * row; a pipeline and the automations that run it are never folded together.
 * Nothing here reads or writes a store, so the page passes in the current
 * context's activities, pipelines and executions.
 */

/** Who shared an item, as the row's source suffix shows it. */
export interface LibrarySharer {
  /** A person, team or organization name. */
  readonly name: string;
  /** The name is a person's, so session replay masks it. */
  readonly isPerson: boolean;
}

/** A share visible to the user that they have not added yet. */
export interface LibrarySharedAutomation {
  readonly remoteId: string;
  readonly name: string;
  readonly triggerKind: 'cron' | 'one_time';
  readonly actionType: AutomationAction['type'];
  readonly sharer?: LibrarySharer;
  /** Cloud account that created the share. */
  readonly createdById?: string;
  /** ISO 8601. */
  readonly updatedAt?: string;
}

export interface LibraryProjectionInput {
  /** Activities in the current context. */
  readonly activities: readonly ScheduledActivity[];
  /** The hot window; a running run marks its automation as running now. */
  readonly recentRuns: readonly ScheduledActivityRun[];
  /** User, project, built-in and shared pipelines the page lists. */
  readonly pipelines: readonly PipelineInfo[];
  /**
   * User pipelines an automation in any context owns (CAN-4551), as main
   * confirmed them; each folds into its automation's row.
   */
  readonly ownedPipelineIds?: ReadonlySet<string>;
  /** The existing pipeline enable toggle's state, keyed by pipeline id. */
  readonly disabledPipelineIds: ReadonlySet<string>;
  /** Every retained execution, for a pipeline's Last run. */
  readonly executions: readonly ExecutionSummary[];
  /** Shares in the current context under the current access rules. */
  readonly sharedAutomations: readonly LibrarySharedAutomation[];
  /**
   * Shares the user has added in any context. A copy may run in a project
   * the current context does not list, and its share is still added.
   * Defaults to the shares `activities` were installed from.
   */
  readonly installedRemoteIds?: ReadonlySet<string>;
  /** Installs in flight, by share id; their Add is disabled. */
  readonly installingRemoteIds?: ReadonlySet<string>;
  /**
   * Signed-in Canopy Cloud account id. A share it created that exactly one
   * local pipeline or automation links to folds into that local row; absent
   * folds nothing.
   */
  readonly viewerId?: string | null;
  /** Epoch milliseconds. */
  readonly now: number;
  readonly locale?: string;
  /** Project of the list's working directory, for project pipelines. */
  readonly currentProjectId?: string;
  /**
   * The selected worktree (CAN-965): its copies of project pipelines are the
   * ones listed and the ones that run. A project row shows its name only when
   * the row's file is in this checkout, so rows still listed from the
   * previous worktree during a switch are never labelled with the new one.
   */
  readonly currentWorktree?: { readonly name: string; readonly cwd: string };
  /** `getAutomationNextRun`: the renderer-authoritative next occurrence. */
  readonly nextRun: (activity: ScheduledActivity, now: Date) => Date | null;
  readonly projectName: (projectId: string) => string | undefined;
  readonly chatTitle: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ) => string | undefined;
  /**
   * A pipeline's steps when its definition is loaded. `undefined` leaves the
   * chain to the step count, or to the name alone.
   */
  readonly pipelineSteps?: (
    pipeline: PipelineInfo,
  ) => readonly WorkflowStepGlyph[] | undefined;
  /** Who shared an installed copy, by the share it was installed from. */
  readonly sharerForInstalled?: (
    activity: ScheduledActivity,
  ) => LibrarySharer | undefined;
  /** Why an automation's target cannot be used, when it cannot. */
  readonly targetUnavailable?: (
    activity: ScheduledActivity,
  ) => string | undefined;
}

export function pipelineLibraryKey(pipeline: PipelineInfo): string {
  // Ids are unique per source only; project rows add their file and shared
  // rows their remote id, as the document locator does.
  if (pipeline.source === 'shared') {
    return `pipeline:shared:${pipeline.remoteId ?? pipeline.id}`;
  }
  if (pipeline.source === 'project') {
    return `pipeline:project:${pipeline.filePath ?? pipeline.id}`;
  }
  return `pipeline:${pipeline.source}:${pipeline.id}`;
}

export function sharedAutomationLibraryKey(remoteId: string): string {
  return `shared-automation:${remoteId}`;
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sharedByLabel(sharer: LibrarySharer | undefined): string {
  return sharer ? `Shared by ${sharer.name}` : 'Shared';
}

function pipelineSource(pipeline: PipelineInfo): WorkflowLibrarySource {
  switch (pipeline.source) {
    case 'user':
      return 'mine';
    case 'project':
      return 'project';
    case 'shared':
      return 'shared';
    case 'bundled':
    case 'curated':
      return 'built-in';
  }
}

function pipelineSharer(pipeline: PipelineInfo): LibrarySharer | undefined {
  const owner = pipeline.owner;
  if (!owner || !owner.name) return undefined;
  return { name: owner.name, isPerson: owner.type === 'user' };
}

export function executionLastRunState(
  status: ExecutionSummary['status'],
): WorkflowLastRunState {
  switch (status) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    case 'cancelled':
      return 'canceled';
    default:
      return 'running';
  }
}

/** Newest top-level execution per pipeline id. */
export function latestExecutions(
  executions: readonly ExecutionSummary[],
): ReadonlyMap<string, ExecutionSummary> {
  const latest = new Map<string, ExecutionSummary>();
  for (const execution of executions) {
    if (execution.parent_execution_id !== undefined) continue;
    const current = latest.get(execution.pipeline_id);
    if (
      current === undefined ||
      (parseTime(execution.started_at) ?? 0) >
        (parseTime(current.started_at) ?? 0)
    ) {
      latest.set(execution.pipeline_id, execution);
    }
  }
  return latest;
}

/** Canonical shared item identity; public snapshot URLs are independent wire facts. */
export function pipelineShareLinkItemId(
  pipeline: PipelineInfo,
): string | undefined {
  if (pipeline.source !== 'shared' || !pipeline.remoteId) return undefined;
  return pipeline.publicShare ||
    pipeline.shareScope === 'team' ||
    pipeline.shareScope === 'organization'
    ? pipeline.remoteId
    : undefined;
}

/** Compatibility projection for consumers that still require a route path. */
export function pipelineShareLinkPath(
  pipeline: PipelineInfo,
): string | undefined {
  const itemId = pipelineShareLinkItemId(pipeline);
  return itemId ? pipelineSharePath(itemId) : undefined;
}

function pipelineActions(
  pipeline: PipelineInfo,
  manual: boolean,
): readonly WorkflowLibraryAction[] {
  const actions: WorkflowLibraryAction[] = ['toggle'];
  if (manual) actions.push('run');
  actions.push('edit', 'view-runs', 'duplicate');
  if (pipelineShareLinkItemId(pipeline) !== undefined)
    actions.push('copy-link');
  if (pipeline.source === 'shared') {
    // Remote management authority does not supply an editable local source.
    // Local definitions retain Share through their own library row.
    if (pipeline.canDelete === true) actions.push('delete');
    return actions;
  }
  actions.push('share');
  if (!pipeline.readonly) actions.push('delete');
  return actions;
}

/** `filePath` is in the checkout at `cwd` (either path separator). */
function isInsideCheckout(cwd: string, filePath: string | undefined): boolean {
  if (!filePath) return false;
  const root = cwd.replace(/[\\/]+$/, '');
  return filePath.startsWith(`${root}/`) || filePath.startsWith(`${root}\\`);
}

function projectPipelineRow(
  pipeline: PipelineInfo,
  input: LibraryProjectionInput,
  latest: ReadonlyMap<string, ExecutionSummary>,
): WorkflowLibraryRow {
  const triggers = pipelineTriggerKinds(pipeline.triggerTypes ?? []);
  const manual = triggers.includes('manual');
  const source = pipelineSource(pipeline);
  const steps = input.pipelineSteps?.(pipeline);
  const sharer = source === 'shared' ? pipelineSharer(pipeline) : undefined;
  // Executions carry the pipeline id but not its source, so two pipelines
  // that share an id across sources share a Last run.
  const execution = latest.get(pipeline.id);
  const lastRunState = execution
    ? executionLastRunState(execution.status)
    : undefined;
  const projectId =
    pipeline.source === 'project' ? input.currentProjectId : undefined;
  return {
    key: pipelineLibraryKey(pipeline),
    kind: 'pipeline',
    name: pipeline.name,
    triggers,
    triggerText: describePipelineTriggers(triggers),
    steps: steps ?? [],
    summary: steps ? describeStepCount(steps.length) : '',
    ...(pipeline.description ? { searchText: pipeline.description } : {}),
    source,
    ...(source === 'mine'
      ? pipeline.remote
        ? { sourceLabel: ownShareAudienceText(pipeline.remote.shareScope) }
        : {}
      : {
          sourceLabel:
            source === 'shared'
              ? sharedByLabel(sharer)
              : source === 'project'
                ? 'From project'
                : 'Built-in',
        }),
    ...(sharer?.isPerson ? { sourceIsPerson: true } : {}),
    ...(execution && lastRunState
      ? {
          lastRun: {
            state: lastRunState,
            ...(lastRunState === 'running'
              ? {}
              : {
                  at: parseTime(execution.completed_at ?? execution.started_at),
                }),
          },
        }
      : {}),
    changedAt: parseTime(pipeline.updatedAt),
    enabled: !input.disabledPipelineIds.has(pipeline.id),
    ...(projectId
      ? { projectId, projectName: input.projectName(projectId) }
      : {}),
    ...(pipeline.source === 'project' &&
    input.currentWorktree &&
    isInsideCheckout(input.currentWorktree.cwd, pipeline.filePath)
      ? { sourceDetail: input.currentWorktree.name }
      : {}),
    actions: pipelineActions(pipeline, manual),
    ...(manual
      ? {}
      : { runUnavailableLabel: describeRunUnavailable(triggers) }),
  };
}

interface AutomationChain {
  readonly steps: readonly WorkflowStepGlyph[];
  readonly summary: string;
  /** The pipeline this automation runs is not in the list. */
  readonly missingPipeline: boolean;
}

/**
 * The listed pipeline an automation's `worktree_pipeline` action runs. Ids
 * are unique per source only, so a recorded source picks among same-id
 * pipelines; without one the first match wins.
 */
export function findTargetPipeline(
  action: Extract<AutomationAction, { type: 'worktree_pipeline' }>,
  pipelines: readonly PipelineInfo[],
): PipelineInfo | undefined {
  const sameId = pipelines.filter(
    (pipeline) => pipeline.id === action.pipelineId,
  );
  if (action.pipelineSource === undefined) return sameId[0];
  return (
    sameId.find((pipeline) => pipeline.source === action.pipelineSource) ??
    undefined
  );
}

function automationChain(
  action: AutomationAction,
  input: LibraryProjectionInput,
): AutomationChain {
  switch (action.type) {
    case 'app_advisor_prompt':
      return {
        steps: ['advisor'],
        summary: `Ask ${ORCHESTRATOR_LABEL}`,
        missingPipeline: false,
      };
    case 'standalone_prompt':
    case 'worktree_prompt': {
      const project = input.projectName(
        action.type === 'standalone_prompt'
          ? action.chatProjectId
          : action.workspaceId,
      );
      return {
        steps: ['chat'],
        summary: project ? `Start chat in ${project}` : 'Start chat',
        missingPipeline: false,
      };
    }
    case 'worktree_session_prompt': {
      const chat =
        input.chatTitle(action.workspaceId, action.worktreeId, action.chatId) ??
        action.chatTitle;
      return {
        steps: ['message'],
        summary: chat ? `Send message to ${chat}` : 'Send message',
        missingPipeline: false,
      };
    }
    case 'worktree_pipeline': {
      const target = findTargetPipeline(action, input.pipelines);
      const name = target?.name ?? action.pipelineName ?? action.pipelineId;
      if (!target) {
        // The chain shows the pipeline's name alone.
        return { steps: ['pipeline'], summary: name, missingPipeline: true };
      }
      const steps = input.pipelineSteps?.(target);
      return steps
        ? {
            steps,
            summary: describeStepCount(steps.length),
            missingPipeline: false,
          }
        : { steps: ['pipeline'], summary: name, missingPipeline: false };
    }
    case 'pipeline_execution_resume':
      return {
        steps: ['pipeline'],
        summary: `Resume ${action.pipelineName}`,
        missingPipeline: false,
      };
  }
}

function automationAttention(
  activity: ScheduledActivity,
  chain: AutomationChain,
  input: LibraryProjectionInput,
): string | undefined {
  if (activity.sharedPipelineReview) {
    return 'Review needed: the shared workflow changed';
  }
  if (chain.missingPipeline) return 'The workflow it runs is missing';
  const unavailable = input.targetUnavailable?.(activity);
  if (unavailable) return unavailable;
  if (activity.failureCount === 1) return 'The last run failed';
  if (activity.failureCount > 1) {
    return `Failed the last ${String(activity.failureCount)} runs`;
  }
  return undefined;
}

/** An automation's trigger kind and the schedule text its Library row shows. */
export function automationTrigger(
  activity: ScheduledActivity,
  locale: string | undefined,
): { readonly kind: WorkflowTriggerKind; readonly text: string } {
  if (activity.schedule.kind === 'cron') {
    return {
      kind: 'schedule',
      // The raw expression shows only when it has no plain-language form.
      text:
        describeFiveFieldCron(activity.schedule.expression) ??
        activity.schedule.expression,
    };
  }
  const runAt = parseTime(activity.schedule.runAt);
  return {
    kind: 'once',
    text:
      runAt === undefined
        ? activity.schedule.runAt
        : formatOneTimeTrigger(runAt, locale),
  };
}

/** A compact schedule for Customize rows; the Library keeps the full text. */
export function compactAutomationTrigger(
  trigger: ReturnType<typeof automationTrigger>,
): string {
  if (trigger.kind === 'once') {
    return `Once · ${trigger.text.replace(' at ', ', ')}`;
  }
  const weekday = /^Every weekday at (.+)$/.exec(trigger.text);
  if (weekday?.[1]) return `Weekdays · ${weekday[1]}`;
  const daily = /^Every day at (.+)$/.exec(trigger.text);
  if (daily?.[1]) return `Daily · ${daily[1]}`;
  const weekly = /^Every ([A-Z][a-z]+) at (.+)$/.exec(trigger.text);
  if (weekly?.[1] && weekly[2]) {
    return `Weekly · ${weekly[1].slice(0, 3)} ${weekly[2]}`;
  }
  return trigger.text;
}

function automationActions(
  activity: ScheduledActivity,
): readonly WorkflowLibraryAction[] {
  const actions: WorkflowLibraryAction[] = [
    'toggle',
    'run',
    'edit',
    'view-runs',
  ];
  if (canDuplicateAutomation(activity)) actions.push('duplicate');
  // A usage-limit resume binds to a local execution, so it is not shared.
  if (activity.action.type !== 'pipeline_execution_resume') {
    actions.push('share');
  }
  actions.push('delete');
  return actions;
}

function projectAutomationRow(
  activity: ScheduledActivity,
  runningActivityIds: ReadonlySet<string>,
  input: LibraryProjectionInput,
): WorkflowLibraryRow {
  const trigger = automationTrigger(activity, input.locale);
  const chain = automationChain(activity.action, input);
  const installed = activity.installedFrom !== undefined;
  const sharer = installed ? input.sharerForInstalled?.(activity) : undefined;
  const attention = automationAttention(activity, chain, input);
  const next = input.nextRun(activity, new Date(input.now));
  const projectId = activityProjectId(activity);
  const projectName = projectId ? input.projectName(projectId) : undefined;
  const lastRun: WorkflowLibraryRow['lastRun'] = runningActivityIds.has(
    activity.id,
  )
    ? { state: 'running' }
    : activity.lastResult
      ? {
          state: activity.lastResult.status,
          at: parseTime(activity.lastResult.completedAt),
        }
      : undefined;
  return {
    key: automationLibraryKey(activity.id),
    kind: 'automation',
    name: activity.name,
    triggers: [trigger.kind],
    triggerText: trigger.text,
    // An If command is the automation's own gate, shown before its action.
    steps: activity.ifCommand ? ['gate', ...chain.steps] : chain.steps,
    summary: chain.summary,
    // A copy keeps its suffix even after the share is revoked.
    source: installed ? 'shared' : 'mine',
    ...(installed
      ? { sourceLabel: sharedByLabel(sharer) }
      : activity.remote
        ? { sourceLabel: 'Shared by you' }
        : {}),
    ...(sharer?.isPerson ? { sourceIsPerson: true } : {}),
    ...(attention ? { attention } : {}),
    ...(lastRun ? { lastRun } : {}),
    ...(next ? { nextRunAt: next.getTime() } : {}),
    changedAt: parseTime(activity.updatedAt),
    enabled: activity.enabled,
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    actions: automationActions(activity),
  };
}

function sharedAutomationGlyph(
  actionType: AutomationAction['type'],
): WorkflowStepGlyph {
  switch (actionType) {
    case 'app_advisor_prompt':
      return 'advisor';
    case 'standalone_prompt':
    case 'worktree_prompt':
      return 'chat';
    case 'worktree_session_prompt':
      return 'message';
    case 'worktree_pipeline':
    case 'pipeline_execution_resume':
      return 'pipeline';
  }
}

const SHARED_AUTOMATION_SUMMARIES: Readonly<Record<WorkflowStepGlyph, string>> =
  {
    advisor: `Ask ${ORCHESTRATOR_LABEL}`,
    chat: 'Start chat',
    message: 'Send message',
    pipeline: 'Run a workflow',
    gate: '',
    agent: '',
    script: '',
    input: '',
    step: '',
  };

function projectSharedAutomationRow(
  share: LibrarySharedAutomation,
  input: LibraryProjectionInput,
): WorkflowLibraryRow {
  const glyph = sharedAutomationGlyph(share.actionType);
  return {
    key: sharedAutomationLibraryKey(share.remoteId),
    kind: 'automation',
    name: share.name,
    triggers: [share.triggerKind === 'cron' ? 'schedule' : 'once'],
    // The schedule itself is read once the share is added.
    triggerText: share.triggerKind === 'cron' ? 'On a schedule' : 'One time',
    steps: [glyph],
    summary: SHARED_AUTOMATION_SUMMARIES[glyph],
    source: 'shared',
    sourceLabel: sharedByLabel(share.sharer),
    ...(share.sharer?.isPerson ? { sourceIsPerson: true } : {}),
    changedAt: parseTime(share.updatedAt),
    installable: true,
    ...(input.installingRemoteIds?.has(share.remoteId)
      ? { installing: true }
      : {}),
    actions: ['add'],
  };
}

/**
 * The schedules of each workflow page (CAN-5782), by pipeline: every record
 * the projection marks with `workflowSchedule`.
 */
export function workflowPageSchedules(
  activities: readonly ScheduledActivity[],
): ReadonlyMap<string, readonly ScheduledActivity[]> {
  const byPipeline = new Map<string, ScheduledActivity[]>();
  for (const activity of activities) {
    const pipelineId = activity.workflowSchedule?.pipelineId;
    if (pipelineId === undefined) continue;
    const list = byPipeline.get(pipelineId) ?? [];
    list.push(activity);
    byPipeline.set(pipelineId, list);
  }
  return byPipeline;
}

/**
 * The record a workflow page's Library row stands on: the owner, which
 * carries the converted chat action, else the oldest schedule.
 */
export function workflowPageRowActivity(
  schedules: readonly ScheduledActivity[],
): ScheduledActivity | undefined {
  return (
    schedules.find((activity) => activity.workflowSchedule?.owner === true) ??
    [...schedules].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    )[0]
  );
}

/**
 * One row for a workflow page with several schedules: "N schedules", how
 * many are on and no switch of its own, the earliest next run among those
 * on, and the latest last run. Its filters match any schedule: every trigger
 * kind and project, and the first schedule's warning when its own has none.
 */
function projectWorkflowPageRow(
  schedules: readonly ScheduledActivity[],
  rowActivity: ScheduledActivity,
  runningActivityIds: ReadonlySet<string>,
  input: LibraryProjectionInput,
): WorkflowLibraryRow {
  const row = projectAutomationRow(rowActivity, runningActivityIds, input);
  const scheduleRows = schedules.map((activity) =>
    activity === rowActivity
      ? row
      : projectAutomationRow(activity, runningActivityIds, input),
  );
  const attention =
    row.attention ??
    scheduleRows.find((entry) => entry.attention !== undefined)?.attention;
  const on = schedules.filter((activity) => activity.enabled);
  const now = new Date(input.now);
  const nextRuns = on.flatMap((activity) => {
    const next = input.nextRun(activity, now);
    return next ? [next.getTime()] : [];
  });
  const nextRunAt = nextRuns.length > 0 ? Math.min(...nextRuns) : undefined;
  const running = schedules.some((activity) =>
    runningActivityIds.has(activity.id),
  );
  const latest = schedules
    .flatMap((activity) =>
      activity.lastResult
        ? [
            {
              state: activity.lastResult.status,
              at: parseTime(activity.lastResult.completedAt),
            },
          ]
        : [],
    )
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
  const { nextRunAt: _nextRunAt, lastRun: _lastRun, ...rest } = row;
  void _nextRunAt;
  void _lastRun;
  return {
    ...rest,
    triggers: [...new Set([row, ...scheduleRows].flatMap((e) => e.triggers))],
    triggerText: `${String(schedules.length)} schedules`,
    ...(attention ? { attention } : {}),
    scheduleProjectIds: [
      ...new Set(
        scheduleRows.map((entry) => entry.projectId ?? WORKFLOW_NO_PROJECT),
      ),
    ],
    enabled: on.length > 0,
    scheduleCounts: { on: on.length, total: schedules.length },
    ...(running
      ? { lastRun: { state: 'running' as const } }
      : latest
        ? { lastRun: latest }
        : {}),
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    actions: row.actions.filter((action) => action !== 'toggle'),
  };
}

/**
 * What a Library Delete on an automation row removes (CAN-5782), for its
 * confirmation. Main deletes it in one write and refuses a running schedule
 * itself; this only says so before the person confirms.
 */
export type WorkflowDeletePlan =
  | { ok: true; schedules: readonly ScheduledActivity[] }
  | { ok: false; error: string };

export const WORKFLOW_DELETE_RUNNING =
  'A schedule is running. Delete the workflow after the run finishes.';

/**
 * A workflow page's row is the workflow (Decision 6), so Delete removes all
 * of its schedules and its pipeline; a run in any of them refuses it.
 */
export function workflowDeletePlan(
  activity: ScheduledActivity,
  activities: readonly ScheduledActivity[],
  runningActivityIds: ReadonlySet<string>,
): WorkflowDeletePlan {
  const pipelineId = activity.workflowSchedule?.pipelineId;
  if (pipelineId === undefined) return { ok: true, schedules: [activity] };
  const schedules = activities.filter(
    (entry) => entry.workflowSchedule?.pipelineId === pipelineId,
  );
  if (
    schedules.length > 1 &&
    schedules.some((entry) => runningActivityIds.has(entry.id))
  ) {
    return { ok: false, error: WORKFLOW_DELETE_RUNNING };
  }
  return { ok: true, schedules };
}

/**
 * CAN-6035: how many workflow pages call the user pipeline `pipelineId`
 * through `builtin/run-pipeline`, so its Delete can warn that they will fail.
 * Main counts only the refs a workflow page's YAML fixes (`workflowCallers`).
 */
export function workflowCallerCount(
  pipelineId: string | undefined,
  pipelines: readonly PipelineInfo[],
): number {
  if (pipelineId === undefined) return 0;
  return (
    pipelines.find(
      (pipeline) => pipeline.source === 'user' && pipeline.id === pipelineId,
    )?.workflowCallers ?? 0
  );
}

/** The Library Delete confirmation's sentence for a deletable row. */
export function workflowDeleteMessage({
  scheduleCount,
  running,
  callers,
}: {
  readonly scheduleCount: number;
  readonly running: boolean;
  readonly callers: number;
}): string {
  const removes =
    scheduleCount > 1
      ? `Deletes the workflow and its ${String(scheduleCount)} schedules.`
      : running
        ? 'A run is in progress and will be stopped.'
        : null;
  const breaks =
    callers > 0
      ? `${String(callers)} ${callers === 1 ? 'workflow that calls' : 'workflows that call'} it will fail.`
      : null;
  return [removes, breaks, 'This cannot be undone.']
    .filter((sentence) => sentence !== null)
    .join(' ');
}

/** Every Library row for the current context, automations then pipelines. */
export function projectLibraryRows(
  input: LibraryProjectionInput,
): readonly WorkflowLibraryRow[] {
  const runningActivityIds = new Set(
    input.recentRuns
      .filter((run) => run.status === 'running')
      .map((run) => run.activityId),
  );
  const latest = latestExecutions(input.executions);
  // A share and the user's added copy of it are one row: the added copy.
  const installedRemoteIds =
    input.installedRemoteIds ??
    new Set(
      input.activities.flatMap((activity) =>
        activity.installedFrom ? [activity.installedFrom.remoteId] : [],
      ),
    );
  // CAN-5782: a workflow page is one row, however many schedules it has;
  // its pipeline doesn't get a row of its own while it has any.
  const pages = workflowPageSchedules(input.activities);
  const folded = new Set<string>();
  const pageRows: WorkflowLibraryRow[] = [];
  for (const schedules of pages.values()) {
    const rowActivity = workflowPageRowActivity(schedules);
    if (rowActivity === undefined) continue;
    for (const activity of schedules) folded.add(activity.id);
    pageRows.push(
      schedules.length === 1
        ? projectAutomationRow(rowActivity, runningActivityIds, input)
        : projectWorkflowPageRow(
            schedules,
            rowActivity,
            runningActivityIds,
            input,
          ),
    );
  }
  const hiddenPipelineIds = new Set([
    ...(input.ownedPipelineIds ?? []),
    ...pages.keys(),
  ]);
  // The user's own share and the local copy it links to are one row: the
  // local copy. Shared rows never carry `remote`, so these sets hold author
  // links only; each fold still checks the share's creator. Only a listed
  // local copy absorbs its share, so a copy in another context leaves it.
  const viewerId = input.viewerId;
  const authorAutomationIds = authorShareRemoteIds(input.activities, viewerId);
  // Only a listed local copy absorbs its share: one hidden under its
  // automation or Workflow page leaves the share visible.
  const listedPipelines = withoutAutomationOwnedPipelines(
    input.pipelines,
    hiddenPipelineIds,
  );
  const authorPipelineIds = authorShareRemoteIds(listedPipelines, viewerId);
  const pipelines = listedPipelines.filter(
    (pipeline) =>
      !(
        viewerId &&
        pipeline.source === 'shared' &&
        pipeline.createdBy?.id === viewerId &&
        pipeline.remoteId &&
        authorPipelineIds.has(pipeline.remoteId)
      ),
  );
  return [
    ...input.activities
      .filter((activity) => !folded.has(activity.id))
      .map((activity) =>
        projectAutomationRow(activity, runningActivityIds, input),
      ),
    ...pageRows,
    ...input.sharedAutomations
      .filter(
        (share) =>
          !installedRemoteIds.has(share.remoteId) &&
          !(
            viewerId &&
            share.createdById === viewerId &&
            authorAutomationIds.has(share.remoteId)
          ),
      )
      .map((share) => projectSharedAutomationRow(share, input)),
    ...pipelines.map((pipeline) => projectPipelineRow(pipeline, input, latest)),
  ];
}
