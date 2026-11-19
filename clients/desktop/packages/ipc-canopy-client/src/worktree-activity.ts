/**
 * A worktree's plan, script, hook, pipeline and summary rows over desktop IPC
 * (CAN-5985). The computer reads them with the same builders Portal's
 * worktree snapshot uses and answers with those entity envelopes, so a
 * client projects them exactly as it projects Portal's.
 *
 * `worktree.activityChanged` listens to the pushes the desktop's own panels
 * refresh on (pipeline runs, tracked plans, hook and script runs, the worktree
 * summary), one listener per channel for each subscription, and to changes
 * this client made itself (a log read, a hook pause), which the computer does
 * not announce. Subscribers re-read the rows.
 */
import type {
  DomainEventMap,
  QueryMap,
  SubscriptionFilter,
  Unsubscribe,
} from '@canopy/app-core';
import type { RemoteControlEntityEnvelope } from '@canopy/protocol/remote-control/shell';
import {
  REMOTE_IPC_CHANNELS as C,
  type RemoteIpcChannel,
} from '@canopy/protocol/remote-control/channels';
import type { ChannelClient } from './channel-client';
import { anyPayload, isRecord, reply } from './decoders';

type ActivityEvent = DomainEventMap['worktree.activityChanged'];
type ActivityReason = ActivityEvent['reason'];
type ActivityHandler = (event: ActivityEvent) => void;

/** The worktree a change belongs to, when the computer named it. */
interface ActivityScope {
  readonly projectId?: string;
  readonly worktreeId?: string;
}

/** The entity types the computer serves for a worktree's panels. */
const ACTIVITY_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'plan',
  'script_descriptor',
  'script_run',
  'hook_descriptor',
  'hook_run',
  'pipeline',
  'pipeline_run',
  'worktree_summary',
]);

const isActivityEntities = reply<{
  readonly entities: readonly RemoteControlEntityEnvelope[];
}>(
  (value) =>
    isRecord(value) &&
    Array.isArray(value.entities) &&
    value.entities.every(
      (entity: unknown) =>
        isRecord(entity) &&
        typeof entity.entityType === 'string' &&
        ACTIVITY_ENTITY_TYPES.has(entity.entityType) &&
        typeof entity.localId === 'string' &&
        (entity.parentLocalId === undefined ||
          typeof entity.parentLocalId === 'string'),
    ),
);

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/** `{ projectId, worktreeId }`, the scope of every push but pipeline runs. */
function namedScope(payload: unknown): ActivityScope {
  if (!isRecord(payload)) return {};
  const projectId = stringField(payload, 'projectId');
  const worktreeId = stringField(payload, 'worktreeId');
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(worktreeId === undefined ? {} : { worktreeId }),
  };
}

/** A pipeline execution event names its run's worktree in the run state. */
function executionScope(payload: unknown): ActivityScope {
  if (!isRecord(payload) || !isRecord(payload.state)) return {};
  const projectId = stringField(payload.state, 'project_id');
  const worktreeId = stringField(payload.state, 'worktree_id');
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(worktreeId === undefined ? {} : { worktreeId }),
  };
}

const ACTIVITY_PUSHES: readonly {
  readonly channel: RemoteIpcChannel;
  readonly reason: ActivityReason;
  readonly scope: (payload: unknown) => ActivityScope;
}[] = [
  {
    channel: C.pipelinesExecutionEvent,
    reason: 'pipelines',
    scope: executionScope,
  },
  { channel: C.trackedPlansUpdated, reason: 'plans', scope: namedScope },
  { channel: C.hookStarted, reason: 'hooks', scope: namedScope },
  { channel: C.hookComplete, reason: 'hooks', scope: namedScope },
  { channel: C.scriptStarted, reason: 'scripts', scope: namedScope },
  { channel: C.scriptComplete, reason: 'scripts', scope: namedScope },
  { channel: C.worktreeSummaryUpdated, reason: 'summary', scope: namedScope },
  {
    channel: C.worktreeSummaryGenerating,
    reason: 'summary',
    scope: namedScope,
  },
];

/** A change outside the filter's worktree; one the computer did not scope passes. */
function outsideFilter(
  scope: ActivityScope,
  filter: SubscriptionFilter | undefined,
): boolean {
  return (
    (filter?.projectId !== undefined &&
      scope.projectId !== undefined &&
      filter.projectId !== scope.projectId) ||
    (filter?.worktreeId !== undefined &&
      scope.worktreeId !== undefined &&
      filter.worktreeId !== scope.worktreeId)
  );
}

export interface WorktreeActivityHandlers {
  readonly query: (
    args: QueryMap['worktree.activity']['args'],
  ) => Promise<QueryMap['worktree.activity']['result']>;
  readonly subscribe: (
    handler: ActivityHandler,
    filter?: SubscriptionFilter,
  ) => Unsubscribe;
  /** A change this client made that the computer does not announce. */
  readonly changed: (
    scope: { readonly projectId: string; readonly worktreeId: string },
    reason: ActivityReason,
  ) => void;
}

export function createWorktreeActivityHandlers(
  channels: ChannelClient,
  now: () => string,
): WorktreeActivityHandlers {
  const local = new Set<{
    readonly handler: ActivityHandler;
    readonly filter: SubscriptionFilter | undefined;
  }>();

  const deliver = (
    handler: ActivityHandler,
    filter: SubscriptionFilter | undefined,
    scope: ActivityScope,
    reason: ActivityReason,
  ): void => {
    if (outsideFilter(scope, filter)) return;
    handler({ ...scope, reason, occurredAt: now() });
  };

  return {
    query: async (args) => {
      const reply = await channels.invoke(
        C.worktreeActivityEntities,
        isActivityEntities,
        { projectId: args.projectId, worktreeId: args.worktreeId },
      );
      return { entities: reply.entities };
    },
    subscribe: (handler, filter) => {
      const entry = { handler, filter };
      local.add(entry);
      const stops = ACTIVITY_PUSHES.map(({ channel, reason, scope }) =>
        channels.listen(channel, anyPayload, (payload) =>
          deliver(handler, filter, scope(payload), reason),
        ),
      );
      let stopped = false;
      return (): void => {
        if (stopped) return;
        stopped = true;
        local.delete(entry);
        for (const stop of stops) stop();
      };
    },
    changed: (scope, reason) => {
      for (const { handler, filter } of [...local]) {
        deliver(handler, filter, scope, reason);
      }
    },
  };
}
