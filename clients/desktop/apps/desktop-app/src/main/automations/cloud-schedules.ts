/**
 * Cloud workflow schedules on the desktop (CAN-6183, cloud pipelines CP-71,
 * decisions P3 and P7).
 *
 * A workflow schedule whose `executionLocation` is `cloud` is stored
 * server-side through `core.pipeline.schedule.*` on the web core. The desktop
 * keeps a stub: the record with `executionLocation: 'cloud'`, the server id
 * in `cloudSchedule`, and `enabled: false`, so neither this scheduler nor a
 * desktop that predates the field ever fires it. The server record is
 * authoritative: its values are shown in place of the stub's, and moving the
 * schedule back deletes it server-side before the stub turns into a local
 * record again, so one slot never fires in both places.
 *
 * This module holds the pure parts: which records fire here, what a move
 * sends, how a deleted server record becomes a local record again, and the
 * remote's contract; `cloud-schedule-remote.ts` is the web core client.
 * `AutomationsService` runs the moves inside its mutation
 * queue. The Run in control that calls them is CP-47; firing is CP-46.
 */
import { createHash } from 'node:crypto';
import type {
  CanopyErrorPayload,
  PipelineSchedule,
  PipelineScheduleCreateParams,
  PipelineScheduleDestination,
  PipelineScheduleTrigger,
  PipelineScheduleUpdateParams,
  PipelineScheduleWorkflowInput,
} from '@canopy/protocol/canopy-core';
import {
  buildSharedPipelineId,
  parseSharedPipelineLocalId,
} from '@canopy/protocol/pipelines';
import type {
  AutomationAction,
  AutomationCloudScheduleStub,
  AutomationTrigger,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { isRecord } from '../lib/type-guards';

type PipelineAction = Extract<AutomationAction, { type: 'worktree_pipeline' }>;

/**
 * The server records of this desktop's cloud stubs, as main last read them,
 * by schedule id. `AutomationsService` writes it; projections read it.
 */
const cloudRecords = new Map<string, PipelineSchedule>();

export function cloudScheduleRecordCache(): Map<string, PipelineSchedule> {
  return cloudRecords;
}

/** The server record of a cloud stub, as main last read it. */
export function cachedCloudRecord(
  activity: ScheduledActivity,
): PipelineSchedule | undefined {
  const scheduleId = activity.cloudSchedule?.scheduleId;
  return isCloudScheduleStub(activity) && scheduleId !== undefined
    ? cloudRecords.get(scheduleId)
    : undefined;
}

/** Whether this desktop fires `activity`: absent or `local` only. */
export function firesLocally(
  activity: Pick<ScheduledActivity, 'executionLocation'>,
): boolean {
  return (
    activity.executionLocation === undefined ||
    activity.executionLocation === 'local'
  );
}

/** Whether `activity` is a cloud stub this desktop can act on. */
export function isCloudScheduleStub(
  activity: Pick<ScheduledActivity, 'executionLocation' | 'cloudSchedule'>,
): activity is ScheduledActivity & {
  cloudSchedule: AutomationCloudScheduleStub;
} {
  return (
    activity.executionLocation === 'cloud' &&
    activity.cloudSchedule !== undefined
  );
}

/** A stored stub's shape; a malformed one is dropped from its record. */
export function isPersistedCloudScheduleStub(
  value: unknown,
): value is AutomationCloudScheduleStub {
  return (
    isRecord(value) &&
    (value.scheduleId === undefined ||
      (typeof value.scheduleId === 'string' && value.scheduleId.length > 0)) &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    typeof value.movedAt === 'string' &&
    typeof value.localEnabled === 'boolean' &&
    (value.moveBackKey === undefined ||
      (typeof value.moveBackKey === 'string' && value.moveBackKey.length > 0))
  );
}

/**
 * Normalizes a stored record's location fields in place: a non-string
 * location is kept as an unknown one (never fired), a malformed stub is
 * dropped, and the renderer projection is never read back.
 */
export function normalizePersistedLocation(
  value: Record<string, unknown>,
): void {
  if (
    value.executionLocation !== undefined &&
    typeof value.executionLocation !== 'string'
  )
    value.executionLocation = 'unknown';
  if (
    value.cloudSchedule !== undefined &&
    !isPersistedCloudScheduleStub(value.cloudSchedule)
  )
    delete value.cloudSchedule;
  delete value.cloudRecord;
}

export const CLOUD_SCHEDULE_MESSAGES = {
  stub: 'This schedule runs in the cloud. Change it where it runs.',
  notStub: "This schedule doesn't run in the cloud.",
  alreadyCloud: 'This schedule already runs in the cloud.',
  unknownLocation: "This schedule runs somewhere this version can't manage.",
  notPipeline: 'Only workflow schedules can run in the cloud.',
  noDestination:
    'Choose where this schedule runs before moving it to the cloud.',
  bundled: "Built-in workflows can't run in the cloud yet.",
  orchestrator: 'Orchestrator workflows stay on this computer.',
  installed: 'Installed workflows stay on this computer for now.',
  agent: 'Schedules an agent wrote stay on this computer for now.',
  review: 'Review the shared workflow before moving this schedule.',
  running: 'This schedule is running. Move it after the run finishes.',
  signedOut: 'Sign in to move schedules to the cloud.',
  otherAccount:
    'This schedule belongs to another cloud account. Sign in to that account to change it.',
  workflowMissing: "Couldn't read this workflow to move it to the cloud.",
  pending:
    "Couldn't confirm the move with the cloud. The schedule is paused here until you move it again.",
  unreachable: "Couldn't reach the cloud. Nothing changed; try again.",
} as const;

/** The web core's typed refusal, or null for a transport failure. */
export class CloudScheduleRemoteError extends Error {
  constructor(readonly payload: CanopyErrorPayload | null) {
    super(payload?.message ?? 'The cloud could not be reached.');
  }

  /** Whether the call certainly changed nothing on the server. */
  get definite(): boolean {
    const kind = this.payload?.kind;
    return (
      kind === 'invalid_argument' ||
      kind === 'permission_denied' ||
      kind === 'failed_precondition' ||
      kind === 'capability_unavailable' ||
      kind === 'resource_exhausted' ||
      kind === 'unauthenticated' ||
      kind === 'conflict' ||
      kind === 'not_found' ||
      kind === 'already_exists'
    );
  }
}

/** What main needs from the web core's schedule store. */
export interface CloudScheduleRemote {
  /** The signed-in cloud account, or null when signed out. */
  accountId(): Promise<string | null>;
  create(
    params: Omit<PipelineScheduleCreateParams, '_meta'>,
  ): Promise<PipelineSchedule>;
  /** Null when the schedule is gone. */
  get(scheduleId: string): Promise<PipelineSchedule | null>;
  findBySourceRecord(sourceRecordId: string): Promise<PipelineSchedule | null>;
  list(): Promise<PipelineSchedule[]>;
  update(
    params: Omit<PipelineScheduleUpdateParams, '_meta'>,
  ): Promise<PipelineSchedule>;
  /**
   * The schedule as it was deleted, or null when it was already gone. The
   * same `idempotencyKey` replays the first answer.
   */
  delete(
    scheduleId: string,
    idempotencyKey: string,
  ): Promise<PipelineSchedule | null>;
}

/** Until main wires the web core, every call is refused as unavailable. */
export const UNAVAILABLE_CLOUD_SCHEDULE_REMOTE: CloudScheduleRemote = {
  accountId: () => Promise.resolve(null),
  create: () => Promise.reject(unavailable()),
  get: () => Promise.reject(unavailable()),
  findBySourceRecord: () => Promise.reject(unavailable()),
  list: () => Promise.reject(unavailable()),
  update: () => Promise.reject(unavailable()),
  delete: () => Promise.reject(unavailable()),
};

function unavailable(): CloudScheduleRemoteError {
  return new CloudScheduleRemoteError({
    kind: 'capability_unavailable',
    message: "Cloud schedules aren't available.",
    retry: { kind: 'never' },
  });
}

/** The workflow a move pins (P7), or a refusal. */
export function cloudScheduleWorkflow(
  action: PipelineAction,
  readUserPipeline: (pipelineId: string) => string | null,
): PipelineScheduleWorkflowInput | { readonly refusal: string } {
  switch (action.pipelineSource) {
    case 'shared':
      return {
        kind: 'definition',
        source: 'shared',
        definitionId: action.sharedPipeline
          ? buildSharedPipelineId(
              action.sharedPipeline.serverId,
              action.sharedPipeline.remoteId,
            )
          : action.pipelineId,
      };
    case 'curated':
      return {
        kind: 'definition',
        source: 'curated',
        definitionId: action.pipelineId.startsWith('curated:')
          ? action.pipelineId
          : `curated:${action.pipelineId}`,
      };
    case 'project':
      return {
        kind: 'definition',
        source: 'project',
        definitionId: action.pipelineId,
      };
    case 'bundled':
      return { refusal: CLOUD_SCHEDULE_MESSAGES.bundled };
    case 'user':
    case undefined: {
      // A workflow that exists on this desktop only travels as a snapshot.
      const document = readUserPipeline(action.pipelineId);
      if (document === null)
        return { refusal: CLOUD_SCHEDULE_MESSAGES.workflowMissing };
      return {
        kind: 'snapshot',
        document,
        contentHash: createHash('sha256')
          .update(document, 'utf8')
          .digest('hex'),
        packageDigest: null,
      };
    }
  }
}

/** Where a pipeline action's runs go, or null for a legacy record with no target. */
export function cloudScheduleDestination(
  action: PipelineAction,
): PipelineScheduleDestination | null {
  const target = action.target;
  if (target === undefined) return null;
  switch (target.kind) {
    case 'global':
      return { kind: 'global' };
    case 'new_worktree':
      return action.workspaceId
        ? {
            kind: 'new_worktree',
            workspaceId: action.workspaceId,
            ...(action.baseWorktreeId
              ? { baseWorktreeId: action.baseWorktreeId }
              : {}),
            ...(action.repoId ? { repoId: action.repoId } : {}),
          }
        : null;
    case 'task':
      return action.workspaceId
        ? {
            kind: 'task',
            workspaceId: action.workspaceId,
            taskId: target.taskId,
          }
        : null;
    case 'project':
      return action.workspaceId
        ? {
            kind: 'project',
            workspaceId: action.workspaceId,
            ...(action.repoId ? { repoId: action.repoId } : {}),
          }
        : null;
  }
}

/** The desktop's `local` trigger read in `timeZone`. */
export function cloudScheduleTrigger(
  trigger: AutomationTrigger,
  timeZone: string,
): PipelineScheduleTrigger {
  return trigger.kind === 'cron'
    ? { kind: 'cron', expression: trigger.expression, timeZone }
    : {
        kind: 'one_time',
        runAt: new Date(trigger.runAt).toISOString(),
        timeZone,
      };
}

/** The time zone this desktop reads `local` triggers in. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The local record a deleted server record turns back into: the stub with
 * the server's values and no cloud fields. Times read in the server's zone
 * come back as this desktop's local time.
 */
export function localRecordFromCloud(
  stub: ScheduledActivity,
  record: PipelineSchedule | null,
  enabledWithoutRecord: boolean,
): ScheduledActivity {
  const rest: ScheduledActivity = { ...stub };
  delete rest.executionLocation;
  delete rest.cloudSchedule;
  delete rest.cloudRecord;
  if (record === null) return { ...rest, enabled: enabledWithoutRecord };
  const { action } = rest;
  const next: ScheduledActivity = {
    ...rest,
    executionContext: record.owner,
    name: record.name,
    enabled: record.enabled,
    schedule:
      record.trigger.kind === 'cron'
        ? {
            kind: 'cron',
            expression: record.trigger.expression,
            timezone: 'local',
          }
        : { kind: 'one_time', runAt: record.trigger.runAt, timezone: 'local' },
    action:
      action.type === 'worktree_pipeline'
        ? withDestination(
            withWorkflow(
              { ...action, inputs: { ...record.inputs } },
              record.workflow,
            ),
            record.destination,
          )
        : action,
  };
  if (record.runCondition === null) delete next.ifCommand;
  else next.ifCommand = record.runCondition;
  return next;
}

/**
 * The action running the server's workflow: a definition changed in the
 * cloud is named again; a snapshot is this desktop's own pipeline, which it
 * uploaded, so the action keeps it.
 */
function withWorkflow(
  action: PipelineAction,
  workflow: PipelineSchedule['workflow'],
): PipelineAction {
  if (workflow.kind === 'snapshot') return action;
  const current = cloudScheduleWorkflow(action, () => null);
  if (
    !('refusal' in current) &&
    current.kind === 'definition' &&
    current.source === workflow.source &&
    current.definitionId === workflow.definitionId
  )
    return action;
  const rest: PipelineAction = { ...action };
  delete rest.sharedPipeline;
  delete rest.projectPipelineFilename;
  if (workflow.source === 'shared') {
    const shared = parseSharedPipelineLocalId(workflow.definitionId);
    return {
      ...rest,
      pipelineSource: 'shared',
      pipelineId: workflow.definitionId,
      ...(shared === null
        ? {}
        : {
            sharedPipeline: {
              serverId: shared.serverId,
              remoteId: shared.remoteId,
            },
          }),
    };
  }
  return {
    ...rest,
    pipelineSource: workflow.source,
    pipelineId: workflow.definitionId,
  };
}

function withDestination(
  action: PipelineAction,
  destination: PipelineScheduleDestination,
): PipelineAction {
  const rest: PipelineAction = { ...action };
  delete rest.workspaceId;
  delete rest.baseWorktreeId;
  delete rest.repoId;
  switch (destination.kind) {
    case 'global':
      return { ...rest, target: { kind: 'global' } };
    case 'new_worktree':
      return {
        ...rest,
        target: { kind: 'new_worktree' },
        workspaceId: destination.workspaceId,
        ...(destination.baseWorktreeId
          ? { baseWorktreeId: destination.baseWorktreeId }
          : {}),
        ...(destination.repoId ? { repoId: destination.repoId } : {}),
      };
    case 'task':
      return {
        ...rest,
        target: { kind: 'task', taskId: destination.taskId },
        workspaceId: destination.workspaceId,
      };
    case 'project':
      return {
        ...rest,
        target: { kind: 'project' },
        workspaceId: destination.workspaceId,
        ...(destination.repoId ? { repoId: destination.repoId } : {}),
      };
  }
}

/**
 * The stub as the renderer shows it: the server record's values in place of
 * the stub's, and the record itself in `cloudRecord`. A stub main has not
 * read the record of yet shows as stored.
 */
export function projectCloudScheduleStub(
  activity: ScheduledActivity,
  record: PipelineSchedule | undefined,
): ScheduledActivity {
  if (!isCloudScheduleStub(activity) || record === undefined) return activity;
  const shown = localRecordFromCloud(activity, record, false);
  return {
    ...shown,
    executionLocation: activity.executionLocation,
    cloudSchedule: activity.cloudSchedule,
    cloudRecord: record,
  };
}
