/**
 * CAN-5782: a save that changes how a workflow's schedules run checks them
 * first. The editor's save boundary (`saveEditorPipeline`) runs it under the
 * pipeline's schedule guard, before the write, when the pipeline has enabled
 * schedules and the save changes the event `scheduleRunEvent` picks for them
 * or removes Manual or Workflow.
 */
import { scheduleRunEvent } from '@canopy/desktop-shared/lib/schedule-run-event';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  getNormalizedTriggerInputDefs,
  resolvePipelineInputs,
} from '@canopy/execution-engine/node/pipelines/executor';
import {
  getTriggerInputDefs,
  getTriggerTypes,
  type Pipeline,
  type PipelineInputDef,
} from '@canopy/execution-engine/types/pipeline';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';

/** Why a save would stop or break its schedules, if it would. */
export type ScheduleSaveRefusal =
  | { readonly kind: 'blocked'; readonly message: string }
  | {
      readonly kind: 'needs_confirmation';
      readonly message: string;
      /** The schedules that would stop, sorted. */
      readonly scheduleIds: readonly string[];
    };

const quoted = (activity: ScheduledActivity): string => `“${activity.name}”`;

/**
 * The refusal for saving `next` over `previous`, or `null` when the save
 * leaves every enabled schedule running as it can. `confirmed` names the
 * schedules an agent created that the person confirmed may stop; it counts
 * only when it is exactly the set that would stop now.
 */
/**
 * Whether saving `next` over `previous` changes how schedules run: the
 * event `scheduleRunEvent` picks, or Manual or Workflow removed. Only then
 * does the save need the schedules at all.
 */
export function saveChangesScheduleTriggers(
  previous: Pipeline,
  next: Pipeline,
): boolean {
  const before = getTriggerTypes(previous.on);
  const after = getTriggerTypes(next.on);
  const removes = (type: 'dispatch' | 'workflow'): boolean =>
    before.includes(type) && !after.includes(type);
  return (
    scheduleRunEvent(after) !== scheduleRunEvent(before) ||
    removes('dispatch') ||
    removes('workflow')
  );
}

/**
 * An enabled sourceless schedule of `pipelineId` that runs in a project, whose
 * fire looks for a project workflow with that ID before the stored one.
 */
export function isSourcelessProjectSchedule(
  activity: ScheduledActivity,
  pipelineId: string,
): boolean {
  const { action } = activity;
  return (
    activity.enabled &&
    action.type === 'worktree_pipeline' &&
    action.pipelineId === pipelineId &&
    action.pipelineSource === undefined &&
    action.target?.kind !== 'global' &&
    action.workspaceId !== undefined
  );
}

export function scheduleSaveRefusal(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
  previous: Pipeline,
  next: Pipeline,
  confirmed: readonly string[] | undefined,
  /**
   * The page's unsaved schedule inputs, by schedule ID, which it writes
   * right after this save: checked in place of the stored ones, so a
   * trigger change and the inputs that fit it save together.
   */
  pendingInputs: Readonly<Record<string, Record<string, string>>> = {},
  /**
   * Sourceless schedules whose fire finds a project workflow with this ID
   * first ({@link isSourcelessProjectSchedule}), so they don't run this one.
   */
  findsProjectPipeline: ReadonlySet<string> = new Set(),
): ScheduleSaveRefusal | null {
  // Every enabled record the scheduler would run this stored pipeline for:
  // its user source, or no source unless its fire finds a project workflow
  // with this ID first.
  const enabled = activities.filter((activity) => {
    const { action } = activity;
    if (
      !activity.enabled ||
      action.type !== 'worktree_pipeline' ||
      action.pipelineId !== pipelineId
    )
      return false;
    if (action.pipelineSource === 'user') return true;
    return (
      action.pipelineSource === undefined &&
      !(
        isSourcelessProjectSchedule(activity, pipelineId) &&
        findsProjectPipeline.has(activity.id)
      )
    );
  });
  if (enabled.length === 0) return null;
  if (!saveChangesScheduleTriggers(previous, next)) return null;
  const after = getTriggerTypes(next.on);
  const event = scheduleRunEvent(after);
  if (event === 'unsupported')
    return {
      kind: 'blocked',
      message: `This change leaves no Manual or Workflow trigger, so ${scheduleCount(enabled.length)} couldn't run. Keep one of them, or turn the schedules off first.`,
    };
  // The executor's own view: its normalized definition (model aliases
  // resolved) for the event the schedules would run as.
  // An agent's schedules stop once Manual is gone (they need it to run), so
  // the stop confirmation covers them, not this input check.
  const agentStops = after.includes('dispatch')
    ? []
    : enabled.filter((activity) => activity.agentAuthor !== undefined);
  const declared = executorInputDefs(next, event);
  const broken = enabled.flatMap((activity) => {
    if (
      activity.action.type !== 'worktree_pipeline' ||
      agentStops.includes(activity)
    )
      return [];
    try {
      resolvePipelineInputs(
        declared,
        pendingInputs[activity.id] ?? activity.action.inputs,
      );
      return [];
    } catch {
      return [activity];
    }
  });
  if (broken.length > 0)
    return {
      kind: 'blocked',
      message: `${listed(broken)} ${broken.length === 1 ? 'uses an input' : 'use inputs'} the ${event === 'workflow' ? 'Workflow' : 'Manual'} trigger wouldn't accept after this change. Update ${broken.length === 1 ? 'its inputs' : 'their inputs'} or the trigger's first.`,
    };
  const stoppingIds = agentStops.map((activity) => activity.id).sort();
  const confirmedIds = [...(confirmed ?? [])].sort();
  if (
    agentStops.length > 0 &&
    (confirmedIds.length !== stoppingIds.length ||
      confirmedIds.some((id, index) => id !== stoppingIds[index]))
  )
    return {
      kind: 'needs_confirmation',
      message: `${listed(agentStops)} ${agentStops.length === 1 ? 'was' : 'were'} created by an agent and would stop running, because an agent's schedules need a Manual trigger.`,
      scheduleIds: stoppingIds,
    };
  return null;
}

/** A definition's inputs for `event` as the executor resolves them. */
export function executorInputDefs(
  pipeline: Pipeline,
  event: 'dispatch' | 'workflow',
): Record<string, PipelineInputDef> {
  let normalized: ReturnType<typeof normalizePipeline>;
  try {
    normalized = normalizePipeline(pipeline);
  } catch {
    // A definition the executor can't normalize is refused by the save's
    // own validation; its raw inputs stand in until then.
    return getTriggerInputDefs(pipeline.on, event) ?? {};
  }
  return getNormalizedTriggerInputDefs(normalized, event) ?? {};
}

function scheduleCount(count: number): string {
  return count === 1 ? '1 schedule' : `${String(count)} schedules`;
}

function listed(activities: readonly ScheduledActivity[]): string {
  const names = activities.slice(0, 3).map(quoted);
  const more = activities.length - names.length;
  return more > 0
    ? `${names.join(', ')} and ${String(more)} more`
    : names.length === 2
      ? `${names[0]} and ${names[1]}`
      : names.join(', ');
}
