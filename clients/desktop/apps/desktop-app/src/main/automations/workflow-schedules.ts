/**
 * Workflow schedules (CAN-5782): the automation records that run one user
 * pipeline, shown together on its Workflow page. A converted chat
 * automation's pipeline (CAN-4551) is a workflow page; so is one kept after
 * its owner marker was cleared (`workflowPage`).
 *
 * The first schedule keeps the owner marker while it exists and still runs
 * the pipeline, so everything keyed on it (agent hiding of Orchestrator
 * prompts, the native grant, the package overlay) keeps working. Extra
 * schedules are plain records that target the pipeline.
 */
import type {
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import {
  loadPipelinePluginCollectionPreferences,
  savePipelinePluginCollectionPreferences,
} from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import type {
  PipelineInfo,
  PipelineWorkflowPageInfo,
  WorkflowScheduleValues,
  WorkflowSingleScheduleReason,
} from '@canopy/protocol/pipelines';
import { resolveChildPipelineRef } from '@canopy/desktop-shared/node/pipelines/child-pipeline-ref';
import { logMainProcessError } from '../lib/main-process-logging';
import { isRecord } from '../lib/type-guards';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import {
  markUserPipelineWorkflowPage,
  readPipelineLocalMetadata,
  releaseUserPipelineOwnerAutomation,
  setUserPipelineOwnerAutomation,
  type PipelineLocalMetadata,
} from '../pipelines/pipeline-local-metadata-store';
import { ownsOrchestratorPromptPipeline } from './owned-pipeline';
import { firesLocally } from './cloud-schedules';

type PipelineAction = Extract<AutomationAction, { type: 'worktree_pipeline' }>;

/** Why a second schedule is refused, by why the pipeline is single-schedule. */
export const SINGLE_SCHEDULE_MESSAGES: Readonly<
  Record<WorkflowSingleScheduleReason, string>
> = {
  orchestrator_prompt: 'Orchestrator workflows can have one schedule.',
  agent_grant: 'Workflows an agent created can have one schedule.',
  installed_package: 'Installed workflows can have one schedule.',
};

/** Why a workflow's Delete is refused while one of its schedules runs. */
export const WORKFLOW_DELETE_RUNNING =
  'A schedule is running. Delete the workflow after the run finishes.';

/** Why a workflow's Delete is refused when its pipeline couldn't be deleted. */
export const WORKFLOW_DELETE_FAILED =
  "Couldn't delete this workflow. Nothing was deleted; try again.";

/** Why Remove can't keep the workflow when its last schedule goes. */
export const KEEP_PIPELINE_REFUSED =
  "This workflow can't stay without its schedule. Delete the workflow instead.";

/**
 * The user pipeline a record runs, if it runs one. An action with no
 * `pipelineSource` runs the stored pipeline of its id when no project one
 * matches, so it counts when that id carries workflow facts.
 */
export function scheduledUserPipelineId(
  activity: Pick<ScheduledActivity, 'action'>,
): string | undefined {
  const { action } = activity;
  if (action.type !== 'worktree_pipeline') return undefined;
  if (action.pipelineSource === 'user') return action.pipelineId;
  if (action.pipelineSource !== undefined) return undefined;
  const metadata = userPipelineMetadata(action.pipelineId);
  return metadata.ownerAutomationId !== undefined ||
    metadata.workflowPage === true ||
    metadata.agentHidden === true
    ? action.pipelineId
    : undefined;
}

export function userPipelineMetadata(
  pipelineId: string,
): PipelineLocalMetadata {
  return readPipelineLocalMetadata({
    type: 'stored',
    source: 'user',
    value: pipelineId,
  });
}

/**
 * Whether a record runs an Orchestrator pipeline whose owner marker was
 * cleared (`agentHidden`): it counts as an Orchestrator automation.
 */
export function targetsAgentHiddenPipeline(
  activity: Pick<ScheduledActivity, 'action'>,
): boolean {
  const pipelineId = scheduledUserPipelineId(activity);
  return (
    pipelineId !== undefined &&
    userPipelineMetadata(pipelineId).agentHidden === true
  );
}

/** Every record that runs `pipelineId`. */
export function pipelineSchedules(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
): ScheduledActivity[] {
  return activities.filter(
    (activity) => scheduledUserPipelineId(activity) === pipelineId,
  );
}

/** The live record the pipeline's owner marker names, if it still runs it. */
export function pipelineOwnerRecord(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
  metadata: PipelineLocalMetadata = userPipelineMetadata(pipelineId),
): ScheduledActivity | undefined {
  const { ownerAutomationId } = metadata;
  if (ownerAutomationId === undefined) return undefined;
  return activities.find(
    (activity) =>
      activity.id === ownerAutomationId &&
      scheduledUserPipelineId(activity) === pipelineId,
  );
}

/** Whether the pipeline is a workflow page. */
export function isWorkflowPagePipeline(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
  metadata: PipelineLocalMetadata = userPipelineMetadata(pipelineId),
): boolean {
  return (
    metadata.workflowPage === true ||
    pipelineOwnerRecord(activities, pipelineId, metadata) !== undefined
  );
}

/**
 * Whether an agent wrote the pipeline and main granted its runs authority
 * (CAN-5479). A person's own grant protects nothing on their runs, so it
 * isn't one.
 */
export function isAgentGrantedPipeline(
  metadata: PipelineLocalMetadata,
): boolean {
  return (
    metadata.agentAuthor !== undefined && metadata.nativeGrant !== undefined
  );
}

/**
 * Why the pipeline can have only one schedule, if it can: its Orchestrator
 * prompt (marked owner or `agentHidden`), an agent's grant, or its owner's
 * capability-package install.
 */
export function singleScheduleReason(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
  metadata: PipelineLocalMetadata = userPipelineMetadata(pipelineId),
): WorkflowSingleScheduleReason | undefined {
  const owner = pipelineOwnerRecord(activities, pipelineId, metadata);
  if (
    metadata.agentHidden === true ||
    (owner !== undefined && ownsOrchestratorPromptPipeline(owner))
  )
    return 'orchestrator_prompt';
  if (isAgentGrantedPipeline(metadata)) return 'agent_grant';
  if (owner?.installedFrom?.capabilityPackage !== undefined)
    return 'installed_package';
  return undefined;
}

/**
 * The refusal for `activity` starting to target `pipelineId` (create or
 * retarget), or `undefined`. Other workflow pages accept extra schedules.
 */
export function addedScheduleRefusal(
  activities: readonly ScheduledActivity[],
  activityId: string | undefined,
  pipelineId: string,
): string | undefined {
  const metadata = userPipelineMetadata(pipelineId);
  if (!isWorkflowPagePipeline(activities, pipelineId, metadata))
    return undefined;
  const others = pipelineSchedules(activities, pipelineId).filter(
    (activity) => activity.id !== activityId,
  );
  if (others.length === 0) return undefined;
  const reason = singleScheduleReason(activities, pipelineId, metadata);
  return reason === undefined ? undefined : SINGLE_SCHEDULE_MESSAGES[reason];
}

/**
 * After a write that left `pipelineId` with more than one schedule, marks
 * it a workflow page, so it stays one when its owner goes.
 */
export function markSharedWorkflowPage(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
): void {
  if (!isWorkflowPagePipeline(activities, pipelineId)) return;
  if (pipelineSchedules(activities, pipelineId).length > 1)
    markUserPipelineWorkflowPage(pipelineId);
}

/** Whether another record than `owner` runs the pipeline it owns. */
export function isSharedByOtherSchedules(
  activities: readonly ScheduledActivity[],
  owner: Pick<ScheduledActivity, 'id'>,
  pipelineId: string,
): boolean {
  return pipelineSchedules(activities, pipelineId).some(
    (activity) => activity.id !== owner.id,
  );
}

/** The run values a schedule's action holds, for the next one. */
export function scheduleValuesOf(
  action: PipelineAction,
): WorkflowScheduleValues {
  return {
    ...(action.inputs !== undefined ? { inputs: { ...action.inputs } } : {}),
    ...(action.target !== undefined
      ? { target: structuredClone(action.target) }
      : {}),
    ...(action.workspaceId !== undefined
      ? { workspaceId: action.workspaceId }
      : {}),
    ...(action.repoId !== undefined ? { repoId: action.repoId } : {}),
    ...(action.modelAliasPreferences !== undefined
      ? { modelAliasPreferences: structuredClone(action.modelAliasPreferences) }
      : {}),
    ...(action.pluginCollectionPreferences !== undefined
      ? {
          pluginCollectionPreferences: structuredClone(
            action.pluginCollectionPreferences,
          ),
        }
      : {}),
  };
}

/**
 * Clears the owner marker of a pipeline that stays and marks it a workflow
 * page, read before the marker goes: an Orchestrator prompt stays hidden
 * from denied agents (`agentHidden`). Returns whether it persisted.
 */
export function releaseOwnedPipeline(
  owner: Pick<ScheduledActivity, 'id' | 'action'>,
  pipelineId: string,
  lastScheduleValues?: WorkflowScheduleValues,
): boolean {
  return releaseUserPipelineOwnerAutomation(pipelineId, {
    agentHidden: ownsOrchestratorPromptPipeline(owner),
    ...(lastScheduleValues ? { lastScheduleValues } : {}),
  });
}

/** Why a delete or retarget that keeps a workflow refused to go on. */
export const WORKFLOW_RELEASE_FAILED =
  "This workflow's schedules couldn't be updated. Try again.";

/** A release an update runs once nothing can refuse it, and its undo. */
export interface OwnedPipelineRelease {
  /** `false` when the release didn't persist; the update refuses then. */
  release: () => boolean;
  /** Names the owner again, after the update's write failed. */
  restore: () => void;
}

/**
 * The release an update of `owner` needs when it stops running the pipeline
 * it owns while other records still run it: the hiding facts are durable
 * before the owner goes. `undefined` when it keeps the pipeline or no other
 * record runs it.
 */
export function sharedPipelineRelease(
  activities: readonly ScheduledActivity[],
  owner: Pick<ScheduledActivity, 'id' | 'action'>,
  pipelineId: string,
  nextAction: AutomationAction | undefined,
): OwnedPipelineRelease | undefined {
  if (
    nextAction === undefined ||
    scheduledUserPipelineId({ action: nextAction }) === pipelineId ||
    !isSharedByOtherSchedules(activities, owner, pipelineId)
  )
    return undefined;
  return {
    release: () => releaseOwnedPipeline(owner, pipelineId),
    restore: () => setUserPipelineOwnerAutomation(pipelineId, owner.id),
  };
}

/**
 * Why `keepPipeline` can't keep the pipeline its last schedule `activity`
 * runs: an installed record's package binding, or an agent's grant, is
 * bound to it and can't outlive it.
 */
export function keepPipelineRefusal(
  activity: ScheduledActivity,
  pipelineId: string,
): string | undefined {
  if (activity.installedFrom?.capabilityPackage !== undefined)
    return KEEP_PIPELINE_REFUSED;
  if (isAgentGrantedPipeline(userPipelineMetadata(pipelineId)))
    return KEEP_PIPELINE_REFUSED;
  return undefined;
}

/** What a Remove that keeps the pipeline keeps, or why it can't. */
export interface KeptWorkflowPipeline {
  pipelineId: string;
  lastScheduleValues: WorkflowScheduleValues;
  refusal?: string;
}

/**
 * What deleting `activity` with `keepPipeline` keeps: only the last schedule
 * of a workflow page keeps anything this way (another schedule keeps the
 * pipeline anyway).
 */
export function keptWorkflowPipeline(
  activities: readonly ScheduledActivity[],
  activity: ScheduledActivity,
  requested: boolean,
): KeptWorkflowPipeline | undefined {
  const { action } = activity;
  if (!requested || action.type !== 'worktree_pipeline') return undefined;
  const pipelineId = scheduledUserPipelineId(activity);
  if (
    pipelineId === undefined ||
    !isWorkflowPagePipeline(activities, pipelineId) ||
    isSharedByOtherSchedules(activities, activity, pipelineId)
  )
    return undefined;
  const refusal = keepPipelineRefusal(activity, pipelineId);
  return {
    pipelineId,
    lastScheduleValues: scheduleValuesOf(action),
    ...(refusal !== undefined ? { refusal } : {}),
  };
}

/** Keeps a removed last schedule's values on a pipeline it didn't own. */
export function keepLastScheduleValues(
  pipelineId: string,
  lastScheduleValues: WorkflowScheduleValues,
): boolean {
  return releaseUserPipelineOwnerAutomation(pipelineId, {
    agentHidden: false,
    lastScheduleValues,
  });
}

/** The facts the pipeline list carries for a workflow page, if it is one. */
export function workflowPageInfo(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
): PipelineWorkflowPageInfo | undefined {
  const metadata = userPipelineMetadata(pipelineId);
  if (!isWorkflowPagePipeline(activities, pipelineId, metadata))
    return undefined;
  const reason = singleScheduleReason(activities, pipelineId, metadata);
  const empty = pipelineSchedules(activities, pipelineId).length === 0;
  return {
    ...(reason !== undefined ? { singleSchedule: { reason } } : {}),
    ...(empty && metadata.lastScheduleValues !== undefined
      ? { lastScheduleValues: structuredClone(metadata.lastScheduleValues) }
      : {}),
  };
}

/** Every stored activity, read where no service call already holds them. */
async function storedActivities(): Promise<ScheduledActivity[]> {
  const { getAutomationsService } = await import('./service');
  return getAutomationsService().allActivities();
}

/** An env layer's string values; anything else a run wouldn't read either. */
function envLayer(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === 'string' ? [[key, entry]] : [],
    ),
  );
}

/**
 * The user pipelines a stored pipeline calls through `builtin/run-pipeline`
 * steps whose child a run resolves from the YAML alone (a literal id, or env
 * values the YAML fixes), as the child resolver reads it. A stored file is
 * parsed without being validated, so a job or step that isn't well formed is
 * skipped rather than failing the whole list.
 */
function calledUserPipelineIds(pipelineId: string): ReadonlySet<string> {
  const stored = getStoredPipelineBySource('user', pipelineId);
  const called = new Set<string>();
  if (!stored.success || !stored.data) return called;
  const pipeline: unknown = stored.data.content;
  if (!isRecord(pipeline) || !isRecord(pipeline.jobs)) return called;
  for (const job of Object.values(pipeline.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    const steps: readonly unknown[] = job.steps;
    for (const step of steps) {
      if (!isRecord(step) || step.uses !== 'builtin/run-pipeline') continue;
      const ref = isRecord(step.with) ? step.with.pipeline : undefined;
      if (typeof ref !== 'string' || !ref.trim()) continue;
      const resolved = resolveChildPipelineRef({
        ref,
        pipelineEnv: envLayer(pipeline.env),
        jobEnv: envLayer(job.env),
        stepEnv: envLayer(step.env),
      });
      if (resolved.kind === 'literal') called.add(resolved.raw);
      else if (resolved.kind === 'resolved') called.add(resolved.evaluated);
    }
  }
  called.delete(pipelineId);
  return called;
}

/**
 * Phase 09: per user pipeline, how many workflow pages call it. Only the
 * workflow pages' definitions are read.
 */
function workflowCallerCounts(
  activities: readonly ScheduledActivity[],
  userIds: readonly string[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const ids = new Set(userIds);
  for (const id of userIds) {
    if (!isWorkflowPagePipeline(activities, id)) continue;
    for (const called of calledUserPipelineIds(id))
      if (ids.has(called)) counts.set(called, (counts.get(called) ?? 0) + 1);
  }
  return counts;
}

/** The pipeline list's user rows with their workflow-page facts. */
export async function withWorkflowPageInfo(
  rows: PipelineInfo[],
): Promise<PipelineInfo[]> {
  if (!rows.some((row) => row.source === 'user')) return rows;
  const activities = await storedActivities();
  const callers = workflowCallerCounts(
    activities,
    rows.flatMap((row) => (row.source === 'user' ? [row.id] : [])),
  );
  return rows.map((row) => {
    if (row.source !== 'user') return row;
    const workflowPage = workflowPageInfo(activities, row.id);
    const workflowCallers = callers.get(row.id);
    return workflowPage || workflowCallers
      ? {
          ...row,
          ...(workflowPage ? { workflowPage } : {}),
          ...(workflowCallers ? { workflowCallers } : {}),
        }
      : row;
  });
}

export const WORKFLOW_DUPLICATE_FAILED =
  "This workflow couldn't be duplicated. Try again.";

export const INSTALLED_WORKFLOW_DUPLICATE_REFUSED =
  "Installed workflows can't be duplicated: a copy would run without its packaged skills and plugins.";

/** Why Duplicate refuses a workflow page, as `canDuplicateAutomation` does. */
export async function workflowPageDuplicateRefusal(
  pipelineId: string,
): Promise<string | undefined> {
  const activities = await storedActivities();
  const owner = pipelineOwnerRecord(activities, pipelineId);
  return owner?.installedFrom?.capabilityPackage !== undefined
    ? INSTALLED_WORKFLOW_DUPLICATE_REFUSED
    : undefined;
}

/**
 * Duplicate of a workflow page: the copy opens as one, with no agent marker
 * (core copies none), Orchestrator hiding kept, its first schedule's run
 * values (or the kept ones) for Add schedule, and the plugin preferences a
 * conversion keeps under the pipeline's id, which core doesn't copy.
 */
export async function copyWorkflowPageFacts(
  sourceId: string,
  copyId: string,
): Promise<boolean> {
  const activities = await storedActivities();
  const metadata = userPipelineMetadata(sourceId);
  if (!isWorkflowPagePipeline(activities, sourceId, metadata)) return true;
  const owner = pipelineOwnerRecord(activities, sourceId, metadata);
  const first = owner ?? pipelineSchedules(activities, sourceId)[0];
  const lastScheduleValues =
    first?.action.type === 'worktree_pipeline'
      ? scheduleValuesOf(first.action)
      : metadata.lastScheduleValues;
  const recorded = releaseUserPipelineOwnerAutomation(copyId, {
    agentHidden:
      metadata.agentHidden === true ||
      (owner !== undefined && ownsOrchestratorPromptPipeline(owner)),
    ...(lastScheduleValues ? { lastScheduleValues } : {}),
  });
  // An Orchestrator copy without its hiding fact would show its prompt.
  if (!recorded) return false;
  const preferences = loadPipelinePluginCollectionPreferences({
    type: 'stored',
    source: 'user',
    value: sourceId,
  });
  if (Object.keys(preferences).length > 0)
    await savePipelinePluginCollectionPreferences(
      { type: 'stored', source: 'user', value: copyId },
      preferences,
      'electron_main',
    );
  return true;
}

/**
 * Decision 6: a workflow page's name is its schedules' name. A name-only
 * write keeps each record's author; a record that refuses it keeps its name
 * and is logged.
 */
export async function copyWorkflowNameToSchedules(
  pipelineId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') return;
  let activities: ScheduledActivity[];
  try {
    activities = await storedActivities();
  } catch (error) {
    logMainProcessError('Failed to rename a workflow’s schedules', error);
    return;
  }
  if (!isWorkflowPagePipeline(activities, pipelineId)) return;
  const { getAutomationsService } = await import('./service');
  const service = getAutomationsService();
  for (const schedule of pipelineSchedules(activities, pipelineId)) {
    // A cloud schedule takes the name where it is stored (CAN-6183).
    if (schedule.name === trimmed || !firesLocally(schedule)) continue;
    // The pipeline is already saved: one schedule's failure, refused or
    // thrown, neither fails the save nor stops the others.
    try {
      const renamed = await service.update({ id: schedule.id, name: trimmed });
      if (!renamed.ok)
        logMainProcessError('Failed to rename a workflow schedule', {
          operation: 'copy-workflow-name',
        });
    } catch (error) {
      logMainProcessError('Failed to rename a workflow schedule', error);
    }
  }
}
