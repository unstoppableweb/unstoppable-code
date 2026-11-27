import path from 'node:path';
import type {
  ChatTabsFile,
  RemoteControlTarget,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { listExecutionSummariesForArchival } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/execution-engine/types/pipeline';
import {
  listBackgroundWorkTargets,
  subscribeBackgroundWork,
} from '../agents/background-work';
import { subscribeDelegationActivity } from '../agents/delegation/activity';
import {
  getAllActiveSessionInfos,
  subscribeChatSessionActivity,
} from '../agents/session-manager';
import {
  listActiveHookRunTargets,
  subscribeActiveHookRunsChanged,
} from '../lib/hook-runner';
import { getDataDir } from '../lib/paths';
import {
  listTrackedShellScripts,
  subscribeTrackedScriptsChanged,
} from '../lib/script-runner';
import { deriveWorktreeChatBadgesSummary } from '../lib/chat-badge-sync';
import { subscribeDurablePausedPipelinesChanged } from '../pipelines/paused-pipeline-cache-signal';
import {
  clearBroadcastPipelineExecutionTracking,
  listBroadcastPausedPipelineTargets,
  subscribePipelineLifecycleTransitions,
  type PipelineExecutionTarget,
} from '../pipelines/pipeline-execution-event-broadcaster';
import {
  getActivePipelineExecutionHandles,
  subscribeToActiveCountChange,
} from '../pipelines/pipeline-execution-registry';
import { workerTerminal } from '../terminal/worker-terminal';
import { subscribePipelineRunUpdates } from './pipelines-service';
import { requestDesktopSessionSnapshotInvalidation } from './desktop-session-snapshot-invalidation';

const SESSION_REFRESH_DELAY_MS = 35;

export interface WorktreeRuntimeStatus {
  isStreaming?: boolean;
  hasBackgroundWork?: true;
  /** The worktree's background tasks (D11), summed over its chats. */
  backgroundTasks?: number;
  hasUnread?: boolean;
  awaitingApproval?: boolean;
  lastActivityAt?: string;
  pipelineStatus?: 'running' | 'paused';
  terminalStatus?: 'running';
  scriptStatus?: 'running';
  hookStatus?: 'running';
  isRunningRun?: boolean;
}

export interface WorktreeRuntimeStatusOptions {
  /**
   * Include settled paused workflows (hydrated from persisted execution state
   * and live pause broadcasts after a paused run leaves `activeExecutions`).
   * Defaults to `true`. Auto Delete passes `false` so settled pauses do not
   * block cleanup while still-active handles keep blocking it.
   */
  includeSettledPausedPipelines?: boolean;
}

interface WorktreeRuntimeStatusInput {
  workspaceId: string;
  worktree: WorktreeData;
}

interface SessionStatus {
  isStreaming: boolean;
  hasBackgroundWork?: boolean;
  backgroundTasks?: number;
  lastActivityAt?: number;
}

interface PersistedStatus {
  hasUnread?: boolean;
  awaitingApproval?: boolean;
  lastActivityAt?: number;
}

interface MirroredBadges {
  hasUnread: boolean;
  awaitingApproval: boolean;
}

let started = false;
let unsubscribeSessionActivity: (() => void) | null = null;
let unsubscribeDelegationActivity: (() => void) | null = null;
let unsubscribeBackgroundWork: (() => void) | null = null;
let unsubscribePipelineCount: (() => void) | null = null;
let unsubscribePipelineUpdates: (() => void) | null = null;
let unsubscribeTerminalActivity: (() => void) | null = null;
let unsubscribeScriptActivity: (() => void) | null = null;
let unsubscribeHookActivity: (() => void) | null = null;
let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
// These maps hold one entry per worktree observed this process session.
// They are bounded by the user's worktree set (not by activity volume); stale
// entries for deleted worktrees are inert. Persisted statuses follow every
// chat write, so they outlive a stop; the badge mirror clears on stop.
const persistedStatuses = new Map<string, PersistedStatus>();
// The worktrees.json badge mirror as of the latest snapshot.
const mirroredBadges = new Map<string, MirroredBadges>();

interface DurablePausedPipelineEntry extends PipelineExecutionTarget {
  ancestorIds: readonly string[];
}

// Durable paused workflows hydrated once at cold start and updated in memory
// from live lifecycle broadcasts and explicit archive/restore/relocation
// invalidations.
const durablePausedByExecutionId = new Map<
  string,
  DurablePausedPipelineEntry
>();
const liveNonTerminalParentByExecutionId = new Map<
  string,
  string | undefined
>();
let durablePausedHydrated = false;
let durablePausedHydration: Promise<boolean> | null = null;
let durablePausedHydrationEpoch = 0;
let hydratedExecutionsDir: string | null = null;
let inFlightHydrationNonPausedIds: Set<string> | null = null;
let inFlightHydrationTerminalIds: Set<string> | null = null;
let inFlightHydrationLivePaused: Map<
  string,
  DurablePausedPipelineEntry
> | null = null;

function getExecutionsDir(): string {
  return path.join(getDataDir(), 'pipeline-executions');
}

function isTerminalPipelineStatus(status: ExecutionSummary['status']): boolean {
  return status === 'success' || status === 'failure' || status === 'cancelled';
}

function resolveHydratedAncestorIds(
  summary: ExecutionSummary,
  summaryById: ReadonlyMap<string, ExecutionSummary>,
  terminalIds: ReadonlySet<string>,
): string[] | null {
  const ancestors: string[] = [];
  const visited = new Set<string>([summary.id]);
  let parentId = summary.parent_execution_id;
  while (parentId !== undefined) {
    if (visited.has(parentId) || terminalIds.has(parentId)) {
      return null;
    }
    visited.add(parentId);
    const parent = summaryById.get(parentId);
    if (!parent || isTerminalPipelineStatus(parent.status)) {
      return null;
    }
    ancestors.push(parentId);
    parentId = parent.parent_execution_id;
  }
  return ancestors;
}

function resolveLivePausedAncestorIds(
  executionId: string,
  parentExecutionId: string | undefined,
): string[] | null {
  if (parentExecutionId === undefined) {
    return [];
  }
  const activeById = new Map<string, ExecutionState>();
  for (const handle of getActivePipelineExecutionHandles()) {
    const state = handle.getState();
    activeById.set(state.id, state);
  }
  const ancestors: string[] = [];
  const visited = new Set<string>([executionId]);
  let currentParentId: string | undefined = parentExecutionId;
  while (currentParentId !== undefined) {
    if (
      visited.has(currentParentId) ||
      inFlightHydrationTerminalIds?.has(currentParentId)
    ) {
      return null;
    }
    visited.add(currentParentId);
    if (liveNonTerminalParentByExecutionId.has(currentParentId)) {
      ancestors.push(currentParentId);
      currentParentId = liveNonTerminalParentByExecutionId.get(currentParentId);
      continue;
    }
    const activeParent = activeById.get(currentParentId);
    if (activeParent && !isTerminalPipelineStatus(activeParent.status)) {
      ancestors.push(currentParentId);
      currentParentId = activeParent.parent_execution_id;
      continue;
    }
    const durableParent = durablePausedByExecutionId.get(currentParentId);
    if (durableParent) {
      ancestors.push(currentParentId);
      for (const ancestorId of durableParent.ancestorIds) {
        if (
          visited.has(ancestorId) ||
          inFlightHydrationTerminalIds?.has(ancestorId)
        ) {
          return null;
        }
        visited.add(ancestorId);
        ancestors.push(ancestorId);
      }
      return ancestors;
    }
    return null;
  }
  return ancestors;
}

function prunePausedMapForTerminalExecution(
  map: Map<string, DurablePausedPipelineEntry>,
  executionId: string,
): void {
  map.delete(executionId);
  for (const [id, entry] of Array.from(map.entries())) {
    if (entry.ancestorIds.includes(executionId)) {
      map.delete(id);
    }
  }
}

function pruneLiveNonTerminalAncestry(executionId: string): void {
  liveNonTerminalParentByExecutionId.delete(executionId);
  const removed = new Set<string>([executionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, parentId] of Array.from(
      liveNonTerminalParentByExecutionId.entries(),
    )) {
      if (parentId !== undefined && removed.has(parentId)) {
        liveNonTerminalParentByExecutionId.delete(id);
        removed.add(id);
        changed = true;
      }
    }
  }
}

function clearDurablePausedCacheState(): void {
  durablePausedHydrationEpoch += 1;
  durablePausedHydration = null;
  durablePausedHydrated = false;
  hydratedExecutionsDir = null;
  inFlightHydrationNonPausedIds = null;
  inFlightHydrationTerminalIds = null;
  inFlightHydrationLivePaused = null;
  durablePausedByExecutionId.clear();
}

async function ensureDurablePausedPipelinesHydrated(): Promise<void> {
  const executionsDir = getExecutionsDir();
  if (
    hydratedExecutionsDir !== null &&
    hydratedExecutionsDir !== executionsDir
  ) {
    clearDurablePausedCacheState();
  }
  while (!durablePausedHydrated) {
    if (durablePausedHydration) {
      const failed = await durablePausedHydration;
      if (failed && !durablePausedHydrated && durablePausedHydration === null) {
        return;
      }
      continue;
    }
    const epoch = ++durablePausedHydrationEpoch;
    const nonPausedDuringRead = new Set<string>();
    const terminalDuringRead = new Set<string>();
    const livePausedDuringRead = new Map<string, DurablePausedPipelineEntry>();
    inFlightHydrationNonPausedIds = nonPausedDuringRead;
    inFlightHydrationTerminalIds = terminalDuringRead;
    inFlightHydrationLivePaused = livePausedDuringRead;
    const run: Promise<boolean> = listExecutionSummariesForArchival(
      executionsDir,
    )
      .then(({ summaries, unreadableFiles }): boolean => {
        if (
          epoch !== durablePausedHydrationEpoch ||
          durablePausedHydration !== run
        ) {
          return false;
        }
        const summaryById = new Map<string, ExecutionSummary>();
        for (const summary of summaries) {
          summaryById.set(summary.id, summary);
        }
        durablePausedByExecutionId.clear();
        for (const summary of summaries) {
          if (
            summary.status === 'paused' &&
            summary.project_id &&
            summary.worktree_id &&
            !nonPausedDuringRead.has(summary.id)
          ) {
            const ancestorIds = resolveHydratedAncestorIds(
              summary,
              summaryById,
              terminalDuringRead,
            );
            if (ancestorIds !== null) {
              durablePausedByExecutionId.set(summary.id, {
                projectId: summary.project_id,
                worktreeId: summary.worktree_id,
                ancestorIds,
              });
            }
          }
        }
        for (const [id, entry] of livePausedDuringRead) {
          durablePausedByExecutionId.set(id, entry);
        }
        hydratedExecutionsDir = executionsDir;
        // Leave hydration retryable when any execution state file could not be
        // read so a transiently unreadable pause appears once the file recovers.
        if (unreadableFiles.length > 0) {
          return true;
        }
        durablePausedHydrated = true;
        return false;
      })
      .catch((): boolean => true)
      .finally((): void => {
        if (inFlightHydrationNonPausedIds === nonPausedDuringRead) {
          inFlightHydrationNonPausedIds = null;
        }
        if (inFlightHydrationTerminalIds === terminalDuringRead) {
          inFlightHydrationTerminalIds = null;
        }
        if (inFlightHydrationLivePaused === livePausedDuringRead) {
          inFlightHydrationLivePaused = null;
        }
        if (durablePausedHydration === run) durablePausedHydration = null;
      });
    durablePausedHydration = run;
    const failed = await run;
    if (failed && !durablePausedHydrated && durablePausedHydration === null) {
      return;
    }
  }
}

/**
 * Invalidates the durable paused-workflow index after archive, restore,
 * relocation, or deletion modifies persisted execution files outside live
 * transitions.
 */
export function invalidateDurablePausedPipelinesCache(
  executionIds?: readonly string[],
): void {
  if (executionIds && executionIds.length > 0) {
    clearBroadcastPipelineExecutionTracking(executionIds);
    for (const executionId of executionIds) {
      pruneLiveNonTerminalAncestry(executionId);
    }
  }
  clearDurablePausedCacheState();
  requestDesktopSessionSnapshotInvalidation('pipeline.lifecycle');
}

subscribeDurablePausedPipelinesChanged(invalidateDurablePausedPipelinesCache);
subscribePipelineLifecycleTransitions((event): void => {
  const nextStatus = event.state.status;
  const isTerminal =
    event.type === 'execution.completed' ||
    event.type === 'execution.cancelled' ||
    event.type === 'execution.failed' ||
    nextStatus === 'success' ||
    nextStatus === 'failure' ||
    nextStatus === 'cancelled';
  if (isTerminal) {
    pruneLiveNonTerminalAncestry(event.executionId);
    prunePausedMapForTerminalExecution(
      durablePausedByExecutionId,
      event.executionId,
    );
    if (inFlightHydrationLivePaused) {
      prunePausedMapForTerminalExecution(
        inFlightHydrationLivePaused,
        event.executionId,
      );
    }
    inFlightHydrationNonPausedIds?.add(event.executionId);
    inFlightHydrationTerminalIds?.add(event.executionId);
    return;
  }
  liveNonTerminalParentByExecutionId.set(
    event.executionId,
    event.state.parent_execution_id,
  );
  if (
    nextStatus === 'paused' &&
    event.state.project_id &&
    event.state.worktree_id
  ) {
    const ancestorIds = resolveLivePausedAncestorIds(
      event.executionId,
      event.state.parent_execution_id,
    );
    if (ancestorIds !== null) {
      const entry: DurablePausedPipelineEntry = {
        projectId: event.state.project_id,
        worktreeId: event.state.worktree_id,
        ancestorIds,
      };
      inFlightHydrationNonPausedIds?.delete(event.executionId);
      inFlightHydrationLivePaused?.set(event.executionId, entry);
      durablePausedByExecutionId.set(event.executionId, entry);
      return;
    }
    liveNonTerminalParentByExecutionId.delete(event.executionId);
  }
  durablePausedByExecutionId.delete(event.executionId);
  inFlightHydrationLivePaused?.delete(event.executionId);
  inFlightHydrationNonPausedIds?.add(event.executionId);
});

function statusKey(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}\0${worktreeId}`;
}

function bucketActivityAt(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return new Date(Math.floor(value / 1000) * 1000).toISOString();
}

function buildSessionStatuses(): Map<string, SessionStatus> {
  const statuses = new Map<string, SessionStatus>();
  for (const session of getAllActiveSessionInfos()) {
    const key = statusKey(session.projectId, session.worktreeId);
    const current = statuses.get(key);
    statuses.set(key, {
      isStreaming: current?.isStreaming === true || session.turnActive,
      lastActivityAt: Math.max(
        current?.lastActivityAt ?? 0,
        session.lastActivityAt,
      ),
    });
  }
  // Delegates are background work (D15): they count toward the worktree's
  // background tasks, never its streaming turn (turn-state phase 41f).
  for (const target of listBackgroundWorkTargets()) {
    if (!target.hasBackgroundWork) continue;
    const key = statusKey(target.projectId, target.worktreeId);
    const current = statuses.get(key);
    statuses.set(key, {
      ...current,
      isStreaming: current?.isStreaming ?? false,
      hasBackgroundWork: true,
      backgroundTasks: (current?.backgroundTasks ?? 0) + target.backgroundTasks,
    });
  }
  return statuses;
}

function buildExecutionStatuses(
  includeSettledPausedPipelines: boolean,
): Map<string, WorktreeRuntimeStatus> {
  const statuses = new Map<string, WorktreeRuntimeStatus>();
  for (const handle of getActivePipelineExecutionHandles()) {
    const state = handle.getState();
    if (!state.project_id || !state.worktree_id) continue;
    const key = statusKey(state.project_id, state.worktree_id);
    const current = statuses.get(key);
    if (state.status === 'running') {
      statuses.set(key, {
        ...current,
        pipelineStatus: 'running',
        isRunningRun: true,
      });
    } else if (
      state.status === 'paused' &&
      current?.pipelineStatus !== 'running'
    ) {
      statuses.set(key, { ...current, pipelineStatus: 'paused' });
    }
  }
  if (includeSettledPausedPipelines) {
    for (const target of durablePausedByExecutionId.values()) {
      const key = statusKey(target.projectId, target.worktreeId);
      const current = statuses.get(key);
      if (current?.pipelineStatus !== 'running') {
        statuses.set(key, { ...current, pipelineStatus: 'paused' });
      }
    }
    for (const target of listBroadcastPausedPipelineTargets()) {
      const key = statusKey(target.projectId, target.worktreeId);
      const current = statuses.get(key);
      if (current?.pipelineStatus !== 'running') {
        statuses.set(key, { ...current, pipelineStatus: 'paused' });
      }
    }
  }
  for (const target of workerTerminal.runningWorktrees()) {
    const key = statusKey(target.projectId, target.worktreeId);
    statuses.set(key, { ...statuses.get(key), terminalStatus: 'running' });
  }
  for (const tracking of listTrackedShellScripts()) {
    const key = statusKey(tracking.projectId, tracking.worktreeId);
    statuses.set(key, { ...statuses.get(key), scriptStatus: 'running' });
  }
  for (const target of listActiveHookRunTargets()) {
    const key = statusKey(target.projectId, target.worktreeId);
    statuses.set(key, { ...statuses.get(key), hookStatus: 'running' });
  }
  return statuses;
}

function combineStatus(
  key: string,
  sessions: Map<string, SessionStatus>,
  executions: Map<string, WorktreeRuntimeStatus>,
): WorktreeRuntimeStatus {
  const session = sessions.get(key);
  const persisted = persistedStatuses.get(key);
  const execution = executions.get(key);
  const badges = mirroredBadges.get(key);
  const liveLastActivityAt = session?.lastActivityAt;
  const persistedLastActivityAt = persisted?.lastActivityAt;
  const lastActivityAt =
    liveLastActivityAt === undefined && persistedLastActivityAt === undefined
      ? undefined
      : Math.max(liveLastActivityAt ?? 0, persistedLastActivityAt ?? 0);
  const bucketedActivityAt = bucketActivityAt(lastActivityAt);

  return {
    ...(session?.isStreaming === true ? { isStreaming: true } : {}),
    ...(session?.hasBackgroundWork === true ? { hasBackgroundWork: true } : {}),
    ...(session?.backgroundTasks
      ? { backgroundTasks: session.backgroundTasks }
      : {}),
    // Live chat writes are always at least as fresh as the asynchronously
    // flushed mirror, so they win over it.
    ...(persisted?.hasUnread === true ||
    (persisted?.hasUnread === undefined && badges?.hasUnread === true)
      ? { hasUnread: true }
      : {}),
    ...(persisted?.awaitingApproval === true ||
    (persisted?.awaitingApproval === undefined &&
      badges?.awaitingApproval === true)
      ? { awaitingApproval: true }
      : {}),
    ...(bucketedActivityAt ? { lastActivityAt: bucketedActivityAt } : {}),
    ...execution,
  };
}

function scheduleSessionRefresh(): void {
  if (!started || sessionRefreshTimer !== null) return;
  requestDesktopSessionSnapshotInvalidation('runtime-status.session-refresh');
  // Coalesce a burst of activity into one invalidation request per window.
  sessionRefreshTimer = setTimeout((): void => {
    sessionRefreshTimer = null;
  }, SESSION_REFRESH_DELAY_MS);
}

export function startWorktreeRuntimeStatusService(): void {
  if (started) return;
  started = true;
  unsubscribeSessionActivity = subscribeChatSessionActivity(
    scheduleSessionRefresh,
  );
  unsubscribeDelegationActivity = subscribeDelegationActivity(
    scheduleSessionRefresh,
  );
  unsubscribeBackgroundWork = subscribeBackgroundWork(scheduleSessionRefresh);
  unsubscribePipelineCount = subscribeToActiveCountChange(
    scheduleSessionRefresh,
  );
  unsubscribePipelineUpdates = subscribePipelineRunUpdates(
    scheduleSessionRefresh,
  );
  // Only the running-detector flip and exit affect getRunningWorktreeTargets;
  // filtering keeps per-chunk terminalOutput events from scheduling refreshes.
  unsubscribeTerminalActivity = workerTerminal.addEventListener(
    (event): void => {
      if (event.type === 'runningChanged' || event.type === 'exit') {
        scheduleSessionRefresh();
      }
    },
  );
  unsubscribeScriptActivity = subscribeTrackedScriptsChanged(
    scheduleSessionRefresh,
  );
  unsubscribeHookActivity = subscribeActiveHookRunsChanged(
    scheduleSessionRefresh,
  );
}

export function stopWorktreeRuntimeStatusService(): void {
  started = false;
  unsubscribeSessionActivity?.();
  unsubscribeSessionActivity = null;
  unsubscribeDelegationActivity?.();
  unsubscribeDelegationActivity = null;
  unsubscribeBackgroundWork?.();
  unsubscribeBackgroundWork = null;
  unsubscribePipelineCount?.();
  unsubscribePipelineCount = null;
  unsubscribePipelineUpdates?.();
  unsubscribePipelineUpdates = null;
  unsubscribeTerminalActivity?.();
  unsubscribeTerminalActivity = null;
  unsubscribeScriptActivity?.();
  unsubscribeScriptActivity = null;
  unsubscribeHookActivity?.();
  unsubscribeHookActivity = null;
  if (sessionRefreshTimer !== null) {
    clearTimeout(sessionRefreshTimer);
    sessionRefreshTimer = null;
  }
  mirroredBadges.clear();
}

export async function getWorktreeRuntimeStatuses(
  inputs: WorktreeRuntimeStatusInput[],
  target?: RemoteControlTarget,
  options?: WorktreeRuntimeStatusOptions,
): Promise<Map<string, WorktreeRuntimeStatus>> {
  // A read answers its caller alone: the Portal snapshot, the desktop session
  // snapshot or auto-archive.
  const includeSettledPausedPipelines =
    options?.includeSettledPausedPipelines !== false;
  if (includeSettledPausedPipelines) {
    await ensureDurablePausedPipelinesHydrated();
  }
  const sessions = buildSessionStatuses();
  const executions = buildExecutionStatuses(includeSettledPausedPipelines);
  const selected = inputs.filter(
    ({ workspaceId, worktree }) =>
      (!target?.workspaceLocalId || target.workspaceLocalId === workspaceId) &&
      (!target?.worktreeLocalId || target.worktreeLocalId === worktree.id),
  );
  // Never reads chat storage: badges come from live chat writes, else from
  // the worktrees.json mirror every chat write updates; durable activity is
  // the worktree's own lastTouchedAt, which the snapshot projection merges.
  const statuses = new Map<string, WorktreeRuntimeStatus>();
  for (const { workspaceId, worktree } of selected) {
    const key = statusKey(workspaceId, worktree.id);
    mirroredBadges.set(key, {
      hasUnread: (worktree.chatBadges?.unreadChats.length ?? 0) > 0,
      awaitingApproval: (worktree.chatBadges?.approvalChats.length ?? 0) > 0,
    });
    statuses.set(key, combineStatus(key, sessions, executions));
  }
  return statuses;
}

export function handleChatTabsWritten(
  workspaceId: string,
  worktreeId: string,
  data: ChatTabsFile,
): void {
  const summary = deriveWorktreeChatBadgesSummary(data);
  const key = statusKey(workspaceId, worktreeId);
  persistedStatuses.set(key, {
    hasUnread: summary.unreadChats.length > 0,
    awaitingApproval: summary.approvalChats.length > 0,
    lastActivityAt: Date.now(),
  });
}

export function resetWorktreeRuntimeStatusServiceForTests(): void {
  stopWorktreeRuntimeStatusService();
  persistedStatuses.clear();
  liveNonTerminalParentByExecutionId.clear();
  clearDurablePausedCacheState();
}
