import { performance } from 'node:perf_hooks';
import { getObservabilityService } from '../observability';

export interface PortalCommandGroupDrop {
  reason: 'count' | 'bytes';
  eventTypes: Record<string, number>;
  chunkCount: number;
}

export type PortalSnapshotSection =
  | 'workspaces_list'
  | 'worktrees'
  | 'standalone_chats'
  | 'chat_summaries'
  | 'activity_summary'
  | 'plans'
  | 'scripts'
  | 'hooks'
  | 'mcp'
  | 'pipelines'
  | 'files'
  | 'diff'
  | 'pr'
  | 'summary';

export function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

export function elapsedSinceTimestamp(
  timestamp: string,
  nowMs = Date.now(),
): number | undefined {
  const startedAt = Date.parse(timestamp);
  if (!Number.isFinite(startedAt)) {
    return undefined;
  }
  return Math.max(0, nowMs - startedAt);
}

export function recordPortalSnapshotTiming(input: {
  commandId: string;
  stage:
    | 'command_received'
    | 'snapshot_build_started'
    | 'snapshot_section_completed'
    | 'snapshot_build_completed'
    | 'snapshot_event_posted'
    | 'snapshot_event_dropped'
    | 'snapshot_queued'
    | 'snapshot_dequeued'
    | 'snapshot_coalesced'
    | 'snapshot_drained';
  elapsedMs?: number;
  section?: PortalSnapshotSection;
  scope?: string;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatLocalId?: string;
  entityCount?: number;
  requestClass?: 'foreground' | 'background';
  queueDepth?: number;
  activeCount?: number;
  drop?: PortalCommandGroupDrop;
}): void {
  getObservabilityService().recordSessionDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'portal_snapshot_timing',
    sessionKey: `portal-command:${input.commandId}`,
    projectId: input.workspaceLocalId ?? '',
    worktreeId: input.worktreeLocalId ?? '',
    chatId: input.chatLocalId ?? '',
    // Deliberate divergence from other recordSessionDiagnostic callers:
    // portal snapshot timing has no agent provider in scope, so there is no
    // real value to report. Analytics filtering on providerType must treat
    // 'unknown' as "not provider-scoped", not as a data bug.
    providerType: 'unknown',
    portalCommandId: input.commandId,
    portalSnapshotStage: input.stage,
    portalSnapshotRequestClass: input.requestClass,
    portalSnapshotQueueDepth: input.queueDepth,
    portalSnapshotActiveCount: input.activeCount,
    ...(input.elapsedMs === undefined ? {} : { elapsedMs: input.elapsedMs }),
    ...(input.section ? { portalSnapshotSection: input.section } : {}),
    ...(input.scope ? { portalSnapshotScope: input.scope } : {}),
    ...(input.entityCount === undefined
      ? {}
      : { portalSnapshotEntityCount: input.entityCount }),
    ...(input.drop
      ? {
          portalSnapshotDropReason: input.drop.reason,
          portalSnapshotDroppedEventTypes: Object.keys(input.drop.eventTypes),
          portalSnapshotDroppedChunkCount: input.drop.chunkCount,
        }
      : {}),
  });
}

export interface PortalOutboxLatencyAggregate {
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  meanEnqueueToAckMs: number;
  maxEnqueueToAckMs: number;
  eventCount: number;
  selected: boolean;
}

export function recordPortalOutboxUploadLatency(input: {
  sessionId: string;
  batchSize: number;
  queueDepthAfterSelection: number;
  oldestEventAgeMs: number;
  /**
   * True when every event in the batch was a command completion/failure
   * control event — the CAN-2360 control-lane fast path. Kept as an explicit
   * label (not a skip) so the lane's latency win stays observable while
   * bulk-pressure dashboards can filter these near-empty batches out.
   */
  controlOnly: boolean;
  latencyAggregates: PortalOutboxLatencyAggregate[];
}): void {
  try {
    const batchTimestamp = new Date().toISOString();
    for (const aggregate of input.latencyAggregates) {
      getObservabilityService().recordSessionDiagnostic({
        version: 1,
        timestamp: batchTimestamp,
        kind: 'portal_outbox_upload_latency',
        sessionKey: `portal-session:${input.sessionId}`,
        projectId: aggregate.workspaceLocalId ?? '',
        worktreeId: aggregate.worktreeLocalId ?? '',
        chatId: '',
        providerType: 'unknown',
        portalOutboxBatchTimestamp: batchTimestamp,
        portalOutboxBatchSize: input.batchSize,
        portalOutboxQueueDepthAfterSelection: input.queueDepthAfterSelection,
        portalOutboxOldestEventAgeMs: input.oldestEventAgeMs,
        portalOutboxControlOnly: input.controlOnly,
        portalOutboxMeanEnqueueToAckMs: aggregate.meanEnqueueToAckMs,
        portalOutboxMaxEnqueueToAckMs: aggregate.maxEnqueueToAckMs,
        portalOutboxEventCount: aggregate.eventCount,
        portalOutboxSelected: aggregate.selected,
      });
    }
  } catch {
    // Diagnostics must never affect portal delivery.
  }
}

export function recordWorktreeStatsTiming(input: {
  workspaceId: string;
  worktreeId: string;
  elapsedMs: number;
  diffStatsElapsedMs?: number;
  skipFetch?: boolean;
  mode: 'full' | 'diff_only';
  outcome?: 'success' | 'failure';
}): void {
  try {
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'worktree_stats_timing',
      sessionKey: `worktree-stats:${input.workspaceId}:${input.worktreeId}`,
      projectId: input.workspaceId,
      worktreeId: input.worktreeId,
      chatId: '',
      providerType: 'unknown',
      elapsedMs: input.elapsedMs,
      worktreeStatsMode: input.mode,
      ...(input.outcome === undefined
        ? {}
        : { worktreeStatsOutcome: input.outcome }),
      ...(input.skipFetch === undefined
        ? {}
        : { worktreeStatsSkipFetch: input.skipFetch }),
      ...(input.diffStatsElapsedMs === undefined
        ? {}
        : { diffStatsElapsedMs: input.diffStatsElapsedMs }),
    });
  } catch {
    // Diagnostics must never affect stats collection.
  }
}
