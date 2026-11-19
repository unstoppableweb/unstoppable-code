import type {
  ChatTabsFile,
  RemoteControlTarget,
  WorktreeData,
} from '@canopy/desktop-shared/types';
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
import {
  listTrackedShellScripts,
  subscribeTrackedScriptsChanged,
} from '../lib/script-runner';
import { deriveWorktreeChatBadgesSummary } from '../lib/chat-badge-sync';
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

function buildExecutionStatuses(): Map<string, WorktreeRuntimeStatus> {
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

export function getWorktreeRuntimeStatuses(
  inputs: WorktreeRuntimeStatusInput[],
  target?: RemoteControlTarget,
): Promise<Map<string, WorktreeRuntimeStatus>> {
  // A read answers its caller alone: the Portal snapshot, the desktop session
  // snapshot or auto-archive.
  const sessions = buildSessionStatuses();
  const executions = buildExecutionStatuses();
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
  return Promise.resolve(statuses);
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
}
