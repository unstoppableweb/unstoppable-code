/**
 * Workflow schedules (CAN-5782): the automation records that run one user
 * pipeline, shown together on its Workflow page. Every user workflow has the
 * same page and can take schedules, whether it was converted from a chat
 * automation (CAN-4551) or made as a workflow.
 *
 * A converted automation's schedule keeps the owner marker while it exists
 * and still runs the pipeline. Extra schedules are plain records that target
 * the pipeline.
 * CAN-6065: every schedule runs as the first one does. An Orchestrator
 * pipeline is hidden from agents by its own `agentHidden` flag before it
 * takes another schedule; an agent's grant is the pipeline's, honored for
 * the schedules of its own agent author or a person; an install stays on
 * the owner, whose package every schedule resolves, and moves to the next
 * schedule when the owner is removed.
 */
import { isWorkflowOnlyTriggerTypes } from '@canopy/desktop-shared/lib/schedule-run-event';
import { scheduleApprovalFacts } from '../pipelines/pipeline-person-approval';
import type {
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { PipelineAgentAuthor } from '@canopy/execution-engine/types/pipeline';
import {
  loadPipelinePluginCollectionPreferences,
  savePipelinePluginCollectionPreferences,
} from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import type {
  PipelineInfo,
  PipelinePackageRef,
  PipelineWorkflowPageInfo,
  WorkflowScheduleValues,
  PipelineDistributionMode,
} from '@canopy/protocol/pipelines';
import { resolveChildPipelineRef } from '@canopy/desktop-shared/node/pipelines/child-pipeline-ref';
import { logMainProcessError } from '../lib/main-process-logging';
import { isRecord } from '../lib/type-guards';
import {
  getStoredPipelineBySource,
  readStoredPipelineRevision,
} from '../pipelines/pipeline-service';
import {
  markUserPipelineAgentHidden,
  markUserPipelineWorkflowPage,
  readPipelineLocalMetadata,
  releaseUserPipelineOwnerAutomation,
  setUserPipelineOwnerAutomation,
  type PipelineLocalMetadata,
} from '../pipelines/pipeline-local-metadata-store';
import { runsAsAuthor } from './chat-automation-native-grant';
import { ownsOrchestratorPromptPipeline } from './owned-pipeline';
import { firesLocally } from './cloud-schedules';

type PipelineAction = Extract<AutomationAction, { type: 'worktree_pipeline' }>;

/**
 * Why an agent's schedule is refused on a workflow whose runs carry what it
 * was installed or granted with for someone else (CAN-6065).
 */
export const AGENT_SCHEDULE_REFUSED =
  "Agents can't add schedules to a workflow someone installed or another agent created.";

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
 * matches: it counts when it runs with no project and a user workflow has
 * that id (CAN-5782: whatever made the workflow), or when that id carries
 * workflow facts.
 */
export function scheduledUserPipelineId(
  activity: Pick<ScheduledActivity, 'action'>,
): string | undefined {
  const { action } = activity;
  if (action.type !== 'worktree_pipeline') return undefined;
  if (action.pipelineSource === 'user') return action.pipelineId;
  if (action.pipelineSource !== undefined) return undefined;
  const metadata = userPipelineMetadata(action.pipelineId);
  if (
    metadata.ownerAutomationId !== undefined ||
    metadata.workflowPage === true ||
    metadata.agentHidden === true
  )
    return action.pipelineId;
  // A `global` target runs with no project whatever `workspaceId` holds,
  // as the scheduler reads it; a record with neither has none either. A
  // record tied to a project looks for its project's workflow first, which
  // only its fire resolves.
  const noProject =
    action.target?.kind === 'global' ||
    (action.target === undefined && action.workspaceId === undefined);
  return noProject &&
    readStoredPipelineRevision(action.pipelineId)?.source === 'user'
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
 * The agent a run of `activity` acts for (CAN-7228): its agent author,
 * unless a person saved the user pipeline it runs after the agent wrote
 * the schedule and no agent has written the pipeline since. That run is
 * the person's, and may use what they chose, plugin selections included.
 * A later agent write of either makes it the agent's again.
 */
export function scheduleRunAgentAuthor(
  activity: Pick<ScheduledActivity, 'action' | 'agentAuthor'>,
): PipelineAgentAuthor | undefined {
  const author = activity.agentAuthor;
  if (author === undefined) return undefined;
  const pipelineId = scheduledUserPipelineId(activity);
  if (pipelineId === undefined) return author;
  const metadata = userPipelineMetadata(pipelineId);
  if (metadata.agentAuthor !== undefined) return author;
  const personAt = Date.parse(metadata.personAuthoredAt ?? '');
  const agentAt = Date.parse(author.recordedAt);
  // An unreadable time keeps the agent's: it fails closed.
  return Number.isFinite(personAt) &&
    Number.isFinite(agentAt) &&
    personAt > agentAt
    ? undefined
    : author;
}

/**
 * The person's takeover a run of an agent's schedule relied on (CAN-7228):
 * their save of `pipelineId` at `personAuthoredAt`, in place of the agent.
 */
export interface SchedulePersonTakeover {
  pipelineId: string;
  personAuthoredAt: string;
  agent: PipelineAgentAuthor;
}

/** The takeover {@link scheduleRunAgentAuthor} applies to `activity`, if any. */
export function schedulePersonTakeover(
  activity: Pick<ScheduledActivity, 'action' | 'agentAuthor'>,
): SchedulePersonTakeover | undefined {
  const agent = activity.agentAuthor;
  if (agent === undefined || scheduleRunAgentAuthor(activity) !== undefined)
    return undefined;
  const pipelineId = scheduledUserPipelineId(activity);
  const personAuthoredAt =
    pipelineId === undefined
      ? undefined
      : userPipelineMetadata(pipelineId).personAuthoredAt;
  return pipelineId === undefined || personAuthoredAt === undefined
    ? undefined
    : { pipelineId, personAuthoredAt, agent };
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

/** The installed owner of a workflow, whose install its schedules run with. */
export function installedPipelineOwner(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
  metadata: PipelineLocalMetadata = userPipelineMetadata(pipelineId),
): ScheduledActivity | undefined {
  const owner = pipelineOwnerRecord(activities, pipelineId, metadata);
  return owner?.installedFrom !== undefined ? owner : undefined;
}

/**
 * The refusal for a schedule written by `author` (an agent, else a person)
 * starting to target `pipelineId` (create or retarget), or `undefined`.
 * CAN-6065: a workflow takes any number of schedules, except an agent's on
 * one someone installed or another agent was granted.
 */
export function addedScheduleRefusal(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
  author: PipelineAgentAuthor | undefined,
): string | undefined {
  if (author === undefined) return undefined;
  const metadata = userPipelineMetadata(pipelineId);
  if (
    isAgentGrantedPipeline(metadata) &&
    !runsAsAuthor(author, metadata.agentAuthor)
  )
    return AGENT_SCHEDULE_REFUSED;
  const installed = installedPipelineOwner(activities, pipelineId, metadata);
  if (installed !== undefined && !runsAsAuthor(author, installed.agentAuthor))
    return AGENT_SCHEDULE_REFUSED;
  return undefined;
}

/**
 * CAN-6065: the installed owner of the workflow page `activity` runs, when
 * `activity` is another of its schedules: its runs carry that install's
 * definition, so they are authorized as the owner's are.
 */
export function inheritedInstallOwner(
  activities: readonly ScheduledActivity[],
  activity: Pick<ScheduledActivity, 'id' | 'action'>,
): ScheduledActivity | undefined {
  const pipelineId = scheduledUserPipelineId(activity);
  if (pipelineId === undefined) return undefined;
  const owner = installedPipelineOwner(activities, pipelineId);
  return owner !== undefined && owner.id !== activity.id ? owner : undefined;
}

/** The install a schedule's run applies, and the record that holds it. */
export interface ScheduleInstall {
  holder: ScheduledActivity;
  required: PipelinePackageRef;
}

/**
 * CAN-6065: the capability package a run of `activity` applies: an owner's
 * own, else, for another schedule of an installed workflow page, its owner's,
 * when the schedule runs as the owner's author. `undefined` for anything else.
 */
export function scheduleInstall(
  activities: readonly ScheduledActivity[],
  activity: ScheduledActivity,
): ScheduleInstall | undefined {
  const pipelineId = scheduledUserPipelineId(activity);
  if (pipelineId === undefined) return undefined;
  const owner = installedPipelineOwner(activities, pipelineId);
  const required = owner?.installedFrom?.capabilityPackage;
  if (owner === undefined || required === undefined) return undefined;
  if (
    owner.id !== activity.id &&
    !runsAsAuthor(activity.agentAuthor, owner.agentAuthor)
  )
    return undefined;
  return { holder: owner, required };
}

/**
 * CAN-6065: the schedule that takes the install when its installed owner is
 * removed while other schedules still run the pipeline: the first of them
 * that runs as the owner's author. `undefined` when the owner isn't
 * installed or nothing else takes it.
 */
export function installSuccessor(
  activities: readonly ScheduledActivity[],
  owner: ScheduledActivity,
  pipelineId: string,
): ScheduledActivity | undefined {
  if (installedPipelineOwner(activities, pipelineId)?.id !== owner.id)
    return undefined;
  return pipelineSchedules(activities, pipelineId).find(
    (activity) =>
      activity.id !== owner.id &&
      activity.installedFrom === undefined &&
      runsAsAuthor(activity.agentAuthor, owner.agentAuthor),
  );
}

/**
 * CAN-6065: before a record starts to target an Orchestrator workflow page,
 * marks its pipeline `agentHidden`, so every schedule on it stays hidden
 * from denied agents whichever record is deleted. Returns whether the
 * pipeline is hidden, or needs no hiding.
 */
export function hideOrchestratorPipelineForSchedule(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
): boolean {
  const metadata = userPipelineMetadata(pipelineId);
  if (metadata.agentHidden === true) return true;
  const owner = pipelineOwnerRecord(activities, pipelineId, metadata);
  if (owner === undefined || !ownsOrchestratorPromptPipeline(owner))
    return true;
  return markUserPipelineAgentHidden(pipelineId);
}

/** Why an installed owner can't move to another pipeline while shared. */
export const INSTALLED_OWNER_RETARGET_REFUSED =
  "This schedule holds what the workflow was installed with, so it can't run another workflow. Remove it from the workflow's page instead.";

/** A handoff whose stored facts are written, and their undo. */
export interface InstallHandoff {
  undo: () => Promise<void>;
}

/**
 * CAN-6065: before an installed owner is removed while `successor` still
 * runs its pipeline, gives `successor` the owner's package install, install
 * receipt and owner marker, so package update and uninstall find the
 * install on a schedule that stays. `undefined` when a write didn't land;
 * what did is undone. The caller moves `installedFrom` itself.
 */
export async function handOffInstall(
  owner: Pick<ScheduledActivity, 'id'>,
  successor: Pick<ScheduledActivity, 'id'>,
  pipelineId: string,
): Promise<InstallHandoff | undefined> {
  const [
    {
      copyAutomationCapabilityPackageInstall,
      removeAutomationCapabilityPackageInstall,
    },
    { bindResourceInstallLocalId },
  ] = await Promise.all([
    import('../pipelines/pipeline-package-service'),
    import('../lib/resource-install-context'),
  ]);
  // The owner still holds its install, so dropping the copy releases nothing.
  const dropCopy = (): Promise<void> =>
    removeAutomationCapabilityPackageInstall(successor.id).catch(
      () => undefined,
    );
  if (!(await copyAutomationCapabilityPackageInstall(owner.id, successor.id))) {
    await dropCopy();
    return undefined;
  }
  try {
    await bindResourceInstallLocalId('automations', owner.id, successor.id);
  } catch {
    await dropCopy();
    return undefined;
  }
  setUserPipelineOwnerAutomation(pipelineId, successor.id);
  const undo = async (): Promise<void> => {
    setUserPipelineOwnerAutomation(pipelineId, owner.id);
    await dropCopy();
  };
  if (userPipelineMetadata(pipelineId).ownerAutomationId !== successor.id) {
    await undo();
    return undefined;
  }
  return { undo };
}

/**
 * After a write that left `pipelineId` with more than one schedule, marks
 * its workflow, so a sourceless schedule still finds it when its owner goes.
 */
export function markSharedWorkflowPage(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
): void {
  if (pipelineSchedules(activities, pipelineId).length > 1)
    markUserPipelineWorkflowPage(pipelineId);
}

/**
 * CAN-7285: an installed automation owns the bundled pipeline its install
 * saved for it (`installedFrom.bundledPipelineLocalId`), as a converted chat
 * automation owns its own: the Library shows the two as one row, and
 * deleting the automation deletes the pipeline. A pipeline a live record
 * already owns, one kept as a workflow page, and one another record also
 * runs are left alone. Returns whether this call recorded the marker.
 */
export function claimInstalledPipeline(
  activities: readonly ScheduledActivity[],
  activity: ScheduledActivity,
): boolean {
  const { action } = activity;
  // Wherever it runs: every user workflow's page edits each schedule's
  // destination (CAN-5782), so a project or task target claims it too.
  if (
    action.type !== 'worktree_pipeline' ||
    action.pipelineSource !== 'user' ||
    activity.installedFrom?.bundledPipelineLocalId !== action.pipelineId
  )
    return false;
  const pipelineId = action.pipelineId;
  const metadata = userPipelineMetadata(pipelineId);
  if (
    metadata.ownerAutomationId === activity.id ||
    metadata.workflowPage === true ||
    metadata.agentHidden === true ||
    pipelineOwnerRecord(activities, pipelineId, metadata) !== undefined ||
    // Any other record that may run it, including one with no
    // `pipelineSource`, which runs the stored pipeline of its id.
    activities.some(
      (other) =>
        other.id !== activity.id &&
        other.action.type === 'worktree_pipeline' &&
        other.action.pipelineId === pipelineId &&
        (other.action.pipelineSource === undefined ||
          other.action.pipelineSource === 'user'),
    ) ||
    !getStoredPipelineBySource('user', pipelineId).success
  )
    return false;
  setUserPipelineOwnerAutomation(pipelineId, activity.id);
  return userPipelineMetadata(pipelineId).ownerAutomationId === activity.id;
}

/**
 * CAN-7285: whether a workflow reads input `key` only as data its steps
 * use, such as a tracker key: inside a `run` script or an `if:` condition (a
 * step's or a job's), or through an `env` variable (the workflow's, a job's
 * or a step's) that no other field reads back as `env.NAME`. Any other
 * reference (a step's `with` or `target`, a job's other fields), or none at
 * all, is not, so where it runs is still checked.
 */
export function usesInputOnlyInRunScripts(
  pipeline: unknown,
  key: string,
): boolean {
  // Dot or bracket access, as the executor resolves both.
  const access = (scope: string, rawName: string): string => {
    const name = rawName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `\\b${scope}(?:\\.${name}\\b|\\[\\s*['"]${name}['"]\\s*\\])`;
  };
  const pattern = (scope: string, name: string): RegExp =>
    new RegExp(`\\$\\{\\{[^}]*${access(scope, name)}[^}]*\\}\\}`);
  const input = pattern('inputs', key);
  // An `if:` is an expression on its own, with or without `${{ }}`.
  const bareInput = new RegExp(access('inputs', key));
  const mentions = (value: unknown, reference: RegExp): boolean => {
    if (typeof value === 'string') return reference.test(value);
    if (Array.isArray(value))
      return value.some((entry) => mentions(entry, reference));
    if (isRecord(value))
      return Object.values(value).some((entry) => mentions(entry, reference));
    return false;
  };
  if (!isRecord(pipeline)) return false;
  // Every field the workflow's runs read, with whether it is run text or an
  // env layer (whose variables a run script reads by name).
  const fields: { kind: 'run' | 'if' | 'env' | 'other'; value: unknown }[] = [];
  const add = (field: string, value: unknown, inStep = false): void => {
    fields.push({
      kind:
        field === 'if'
          ? 'if'
          : inStep && field === 'run'
            ? 'run'
            : field === 'env'
              ? 'env'
              : 'other',
      value,
    });
  };
  for (const [field, value] of Object.entries(pipeline)) {
    if (field !== 'jobs') {
      add(field, value);
      continue;
    }
    if (!isRecord(value)) return false;
    for (const job of Object.values(value)) {
      if (!isRecord(job)) continue;
      for (const [jobField, jobValue] of Object.entries(job)) {
        if (jobField !== 'steps') {
          add(jobField, jobValue);
          continue;
        }
        if (!Array.isArray(jobValue)) continue;
        for (const step of jobValue) {
          if (!isRecord(step)) continue;
          for (const [stepField, stepValue] of Object.entries(step))
            add(stepField, stepValue, true);
        }
      }
    }
  }
  // The env variables that carry the input.
  const carriers = new Set<string>();
  for (const field of fields) {
    if (field.kind !== 'env' || !isRecord(field.value)) continue;
    for (const [name, value] of Object.entries(field.value))
      if (mentions(value, input)) carriers.add(name);
  }
  let read = false;
  for (const field of fields) {
    if (field.kind === 'run') {
      read ||= mentions(field.value, input);
      continue;
    }
    if (field.kind === 'if') {
      read ||= mentions(field.value, bareInput);
      continue;
    }
    // An env value that reads the input, or another carrier, stays text.
    if (field.kind === 'env') continue;
    if (mentions(field.value, input)) return false;
    for (const name of carriers)
      if (mentions(field.value, pattern('env', name))) return false;
  }
  return read || carriers.size > 0;
}

/**
 * CAN-7285: brings an installed automation's owner marker in line with
 * {@link claimInstalledPipeline}: it claims the bundled pipeline when the
 * install qualifies. A destination change keeps the marker (CAN-5782): the
 * workflow's page shows every schedule wherever it runs, and the schedules
 * added there inherit the install through it. Returns whether the marker
 * changed.
 */
export function reconcileInstalledPipelineOwner(
  activities: readonly ScheduledActivity[],
  activity: ScheduledActivity,
): boolean {
  return claimInstalledPipeline(activities, activity);
}

/**
 * The record whose install supplies the bundled pipeline package a run of
 * `activity` applies: the record itself when its install saved the pipeline
 * it runs, else (CAN-6065, CAN-7285) the installed owner of the workflow
 * page it runs, when it runs as the owner's author and the owner's install
 * saved that pipeline.
 */
export function bundledPackageHolder(
  activities: readonly ScheduledActivity[],
  activity: ScheduledActivity,
): ScheduledActivity | undefined {
  const { action } = activity;
  if (action.type !== 'worktree_pipeline') return undefined;
  if (
    action.pipelineSource === 'user' &&
    activity.installedFrom?.bundledPipelineLocalId === action.pipelineId
  )
    return activity;
  const pipelineId = scheduledUserPipelineId(activity);
  const holder = scheduleInstall(activities, activity)?.holder;
  return pipelineId !== undefined &&
    holder !== undefined &&
    holder.id !== activity.id &&
    holder.installedFrom?.bundledPipelineLocalId === pipelineId
    ? holder
    : undefined;
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
 * runs: an installed record's package binding is bound to it and can't
 * outlive it. An agent's grant is the pipeline's, and stays (CAN-6065).
 */
export function keepPipelineRefusal(
  activity: ScheduledActivity,
): string | undefined {
  return activity.installedFrom?.capabilityPackage !== undefined
    ? KEEP_PIPELINE_REFUSED
    : undefined;
}

/** What a Remove that keeps the pipeline keeps, or why it can't. */
export interface KeptWorkflowPipeline {
  pipelineId: string;
  lastScheduleValues: WorkflowScheduleValues;
  refusal?: string;
}

/**
 * What deleting `activity` with `keepPipeline` keeps: only a workflow's last
 * schedule keeps anything this way (another schedule keeps the pipeline
 * anyway).
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
    isSharedByOtherSchedules(activities, activity, pipelineId)
  )
    return undefined;
  const refusal = keepPipelineRefusal(activity);
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

/** The facts the pipeline list carries for a user workflow's page. */
export function workflowPageInfo(
  activities: readonly ScheduledActivity[],
  pipelineId: string,
): PipelineWorkflowPageInfo {
  const metadata = userPipelineMetadata(pipelineId);
  const empty = pipelineSchedules(activities, pipelineId).length === 0;
  return {
    ...(isAgentGrantedPipeline(metadata) ? { agentGranted: true } : {}),
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
 * What each user pipeline calls, by its id, cached per stored revision so a
 * list reads each definition once until it changes.
 */
const calledCache = new Map<
  string,
  { readonly version: string; readonly called: ReadonlySet<string> }
>();

function calledByRow(row: PipelineInfo): ReadonlySet<string> {
  const version = `${String(row.revision ?? 0)}:${row.updatedAt}`;
  const cached = calledCache.get(row.id);
  if (cached?.version === version) return cached.called;
  const called = calledUserPipelineIds(row.id);
  calledCache.set(row.id, { version, called });
  return called;
}

/**
 * Per user pipeline, how many user workflows call it (`all`), and how many of
 * those declare the Workflow trigger (`workflowTrigger`).
 */
function workflowCallerCounts(rows: readonly PipelineInfo[]): {
  readonly all: ReadonlyMap<string, number>;
  readonly workflowTrigger: ReadonlyMap<string, number>;
} {
  const all = new Map<string, number>();
  const workflowTrigger = new Map<string, number>();
  const users = rows.filter((row) => row.source === 'user');
  const ids = new Set(users.map((row) => row.id));
  for (const [id] of calledCache) if (!ids.has(id)) calledCache.delete(id);
  for (const row of users) {
    const declaresWorkflow = (row.triggerTypes ?? []).includes('workflow');
    for (const called of calledByRow(row)) {
      if (!ids.has(called)) continue;
      all.set(called, (all.get(called) ?? 0) + 1);
      if (declaresWorkflow)
        workflowTrigger.set(called, (workflowTrigger.get(called) ?? 0) + 1);
    }
  }
  return { all, workflowTrigger };
}

/** How a package install runs: packaged unless marked definition-only. */
function installedDistributionMode(
  mode: PipelineDistributionMode | undefined,
): PipelineDistributionMode {
  return mode === 'definition_only' ? 'definition_only' : 'package';
}

/** The pipeline list's user rows with their workflow-page facts. */
export async function withWorkflowPageInfo(
  rows: PipelineInfo[],
): Promise<PipelineInfo[]> {
  if (!rows.some((row) => row.source === 'user')) return rows;
  const activities = await storedActivities();
  const { all: callers, workflowTrigger: triggerCallers } =
    workflowCallerCounts(rows);
  // CAN-5782: a pipeline-owned package install, which the stored index
  // leaves out, so Settings never offers a trigger edit that would break the
  // install's YAML pin.
  const { listPackageInstalls } =
    await import('../pipelines/pipeline-package-service');
  const installs = new Map(
    (await listPackageInstalls().catch(() => [])).map((record) => [
      record.localPipelineId,
      // A record with no mode runs as packaged, as the run's resolver reads
      // every mode but definition_only (older records carry none).
      installedDistributionMode(record.distributionMode),
    ]),
  );
  return Promise.all(
    rows.map(async (rawRow) => {
      if (rawRow.source !== 'user') return rawRow;
      const installedMode = installs.get(rawRow.id);
      const row =
        rawRow.distributionMode === undefined && installedMode !== undefined
          ? { ...rawRow, distributionMode: installedMode }
          : rawRow;
      const page = workflowPageInfo(activities, row.id);
      // CAN-5782: a workflow whose only trigger is Workflow shows whether its
      // saved content is approved for its schedules' timed runs.
      const facts = isWorkflowOnlyTriggerTypes(row.triggerTypes ?? ['dispatch'])
        ? await scheduleApprovalFacts(row.id)
        : undefined;
      // A schedule that runs it with its automation install's own package
      // is refused whatever the approval says, as the scheduler refuses it.
      const automationPackage =
        facts !== undefined &&
        pipelineSchedules(activities, row.id).some((activity) => {
          // Only a holder with its own capability package resolves one; an
          // inline install's bundled ID alone runs on the ordinary approval.
          const installed = bundledPackageHolder(
            activities,
            activity,
          )?.installedFrom;
          return (
            installed?.bundledPipelineLocalId !== undefined &&
            installed.capabilityPackage !== undefined
          );
        });
      const scheduleApproval =
        facts === undefined
          ? undefined
          : automationPackage
            ? { ...facts, approved: false, automationPackage: true as const }
            : facts;
      const workflowPage = {
        ...page,
        ...(scheduleApproval ? { scheduleApproval } : {}),
      };
      const workflowCallers = callers.get(row.id);
      const workflowTriggerCallers = triggerCallers.get(row.id);
      return {
        ...row,
        workflowPage,
        ...(workflowCallers ? { workflowCallers } : {}),
        ...(workflowTriggerCallers ? { workflowTriggerCallers } : {}),
      };
    }),
  );
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
 * Duplicate of a user workflow: the copy opens with no agent marker
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
 * Decision 6: a workflow's name is its schedules' name. A name-only
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
