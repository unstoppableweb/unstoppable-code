/**
 * Renderer mirror of main's live provider background-task set, per chat.
 *
 * Main changes its live set before the matching chat event reaches the
 * renderer (provider events go through asynchronous canonical ingestion), so
 * this mirror can lead the transcript. Anything derived from a push is
 * provisional: the later real or synthetic `task_notification` must still win.
 *
 * Hydrated per worktree by {@link LiveBackgroundTaskState.refreshWorktree}
 * (`window.api.activity.listLiveBgTasks`) and kept current by
 * `onLiveBgTasksChanged`, whose events are absolute per-chat state. A chat
 * without a live provider session has no entry.
 *
 * Pushes only start once the renderer is up, so after a reload a worktree's
 * entries are trustworthy only once its snapshot was applied
 * ({@link isWorktreeLiveTasksHydrated}). Close, archive and removal checks
 * call {@link LiveBackgroundTaskState.ensureWorktreesHydrated} for worktrees
 * the user never opened before they read the close-blocking selectors.
 */
import { create } from 'zustand';
import { isWebCoreScope } from '@/lib/chat-authority';
import type { ChildToolLiveness } from '@canopy/agent-transcript';
import { isCloseBlockingTaskType } from '@canopy/desktop-shared/lib/background-work';
import type {
  ActivityLiveBgTasksChangedEvent,
  ActivityLiveBgTasksChatState,
  ActivityLiveBgTasksResponse,
} from '@canopy/desktop-shared/types';

type ActivityLiveBgTask = ActivityLiveBgTasksChatState['liveTasks'][number];

/** One chat's live provider session and its background tasks. */
export interface LiveBackgroundTaskChatEntry {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly sessionActive: boolean;
  readonly liveTasks: readonly ActivityLiveBgTask[];
}

/** A worktree (or Cowork Work Entry) whose mirror can be hydrated. */
export interface LiveBackgroundTaskWorktreeTarget {
  readonly projectId: string;
  readonly worktreeId: string;
}

/** A chat whose close-blocking provider work just ended. */
export interface LiveBackgroundTaskChatTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

export interface LiveBackgroundTaskState {
  /** Keyed by {@link liveBackgroundTaskKey}; only chats with a live session. */
  byChat: Readonly<Record<string, LiveBackgroundTaskChatEntry>>;
  /**
   * `${projectId}/${worktreeId}` keys whose snapshot has been applied. Read it
   * through {@link isWorktreeLiveTasksHydrated}, which also covers a renderer
   * without the pull bridge.
   */
  hydratedWorktrees: Readonly<Record<string, true>>;
  /**
   * Replace one chat's state with a pushed absolute event (`sessionActive:
   * false` removes the entry). Returns the chat's previous entry so callers
   * can compute which tasks the push removed.
   */
  applyPush: (
    event: ActivityLiveBgTasksChangedEvent,
  ) => LiveBackgroundTaskChatEntry | undefined;
  /**
   * Pull main's snapshot for one worktree and merge it with every push that
   * arrived while the pull was in flight, in one update. Chats of the worktree
   * absent from both are removed. Resolves the merged per-chat record, or
   * `null` when the bridge is missing or the pull fails.
   */
  refreshWorktree: (
    projectId: string,
    worktreeId: string,
  ) => Promise<ActivityLiveBgTasksResponse | null>;
  /**
   * Pull the snapshot of every target not yet hydrated, joining pulls already
   * in flight. Resolves once each has finished, successfully or not; never
   * rejects.
   */
  ensureWorktreesHydrated: (
    targets: readonly LiveBackgroundTaskWorktreeTarget[],
  ) => Promise<void>;
  /** Forget every entry (tests and teardown). */
  reset: () => void;
}

/** The store key for one chat: `${projectId}/${worktreeId}/${chatId}`. */
export function liveBackgroundTaskKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}/${worktreeId}/${chatId}`;
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function liveTasksEqual(
  left: readonly ActivityLiveBgTask[],
  right: readonly ActivityLiveBgTask[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (task, index) => JSON.stringify(task) === JSON.stringify(right[index]),
    )
  );
}

/** Keep `previous` when nothing changed, so subscribers do not re-render. */
function reuseEntry(
  previous: LiveBackgroundTaskChatEntry | undefined,
  next: LiveBackgroundTaskChatEntry,
): LiveBackgroundTaskChatEntry {
  return previous !== undefined &&
    previous.sessionActive === next.sessionActive &&
    liveTasksEqual(previous.liveTasks, next.liveTasks)
    ? previous
    : next;
}

function toEntry(
  projectId: string,
  worktreeId: string,
  chatId: string,
  state: ActivityLiveBgTasksChatState,
): LiveBackgroundTaskChatEntry {
  return {
    projectId,
    worktreeId,
    chatId,
    sessionActive: state.sessionActive,
    liveTasks: [...state.liveTasks],
  };
}

function recordsShallowEqual(
  left: Readonly<Record<string, LiveBackgroundTaskChatEntry>>,
  right: Readonly<Record<string, LiveBackgroundTaskChatEntry>>,
): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

/** Pushes received while a worktree pull is in flight, per worktree. */
const pendingPushBuffers = new Map<
  string,
  Set<ActivityLiveBgTasksChangedEvent[]>
>();

/** `ensureWorktreesHydrated` pulls in flight, per worktree. */
const hydrationsInFlight = new Map<string, Promise<unknown>>();

function hasPullBridge(): boolean {
  const activityApi =
    typeof window === 'undefined' ? undefined : window.api?.activity;
  return typeof activityApi?.listLiveBgTasks === 'function';
}

function tasksBlockClose(
  liveTasks: readonly ActivityLiveBgTask[] | undefined,
): boolean {
  return (
    liveTasks?.some((task) => isCloseBlockingTaskType(task.taskType)) === true
  );
}

type SettledListener = (target: LiveBackgroundTaskChatTarget) => void;
const settledListeners = new Set<SettledListener>();

function notifySettled(targets: readonly LiveBackgroundTaskChatTarget[]): void {
  for (const target of targets) {
    settledListeners.forEach((listener: SettledListener): void => {
      try {
        listener(target);
      } catch {
        // One listener's failure must not starve the others.
      }
    });
  }
}

/**
 * Subscribe to chats whose close-blocking provider work (agents, workflows)
 * just ended: a push or a fresh snapshot took the chat from blocking to not.
 * Shell-only changes never fire. Listeners run after the mirror is updated.
 */
export function subscribeChatProviderWorkSettled(
  listener: SettledListener,
): () => void {
  settledListeners.add(listener);
  return (): void => {
    settledListeners.delete(listener);
  };
}

export const useLiveBackgroundTaskStore = create<LiveBackgroundTaskState>(
  (set, get) => ({
    byChat: {},
    hydratedWorktrees: {},
    applyPush: (event): LiveBackgroundTaskChatEntry | undefined => {
      pendingPushBuffers
        .get(worktreeKey(event.projectId, event.worktreeId))
        ?.forEach((buffer): void => {
          buffer.push(event);
        });
      const key = liveBackgroundTaskKey(
        event.projectId,
        event.worktreeId,
        event.chatId,
      );
      const byChat = get().byChat;
      const previous = byChat[key];
      const settled =
        tasksBlockClose(previous?.liveTasks) &&
        !(event.sessionActive && tasksBlockClose(event.liveTasks));
      if (!event.sessionActive) {
        if (previous === undefined) return previous;
        const next = { ...byChat };
        delete next[key];
        set({ byChat: next });
      } else {
        const entry = reuseEntry(
          previous,
          toEntry(event.projectId, event.worktreeId, event.chatId, event),
        );
        if (entry !== previous) {
          set({ byChat: { ...byChat, [key]: entry } });
        }
      }
      if (settled) {
        notifySettled([
          {
            projectId: event.projectId,
            worktreeId: event.worktreeId,
            chatId: event.chatId,
          },
        ]);
      }
      return previous;
    },
    refreshWorktree: async (
      projectId,
      worktreeId,
    ): Promise<ActivityLiveBgTasksResponse | null> => {
      // main tracks only local chats' background work; a web core chat's
      // agent tasks come from its own snapshot (CAN-5976).
      if (isWebCoreScope(projectId)) return null;
      const activityApi =
        typeof window === 'undefined' ? undefined : window.api?.activity;
      if (typeof activityApi?.listLiveBgTasks !== 'function') return null;

      const bufferKey = worktreeKey(projectId, worktreeId);
      const buffer: ActivityLiveBgTasksChangedEvent[] = [];
      let buffers = pendingPushBuffers.get(bufferKey);
      if (buffers === undefined) {
        buffers = new Set();
        pendingPushBuffers.set(bufferKey, buffers);
      }
      buffers.add(buffer);

      let snapshot: ActivityLiveBgTasksResponse;
      try {
        snapshot = await activityApi.listLiveBgTasks({ projectId, worktreeId });
      } catch {
        return null;
      } finally {
        buffers.delete(buffer);
        if (buffers.size === 0) pendingPushBuffers.delete(bufferKey);
      }

      // Pushes are absolute and newer than whatever the snapshot saw for
      // their chat, so replaying them keeps a stale snapshot from winning.
      const merged = new Map<string, ActivityLiveBgTasksChatState>();
      for (const [chatId, chatState] of Object.entries(snapshot.chats)) {
        merged.set(chatId, chatState);
      }
      for (const event of buffer) {
        merged.set(event.chatId, {
          sessionActive: event.sessionActive,
          liveTasks: event.liveTasks,
        });
      }

      const previous = get().byChat;
      const next: Record<string, LiveBackgroundTaskChatEntry> = {};
      const prefix = `${bufferKey}/`;
      for (const [key, entry] of Object.entries(previous)) {
        if (!key.startsWith(prefix)) next[key] = entry;
      }
      const chats: Record<string, ActivityLiveBgTasksChatState> = {};
      for (const [chatId, chatState] of Array.from(merged.entries())) {
        if (!chatState.sessionActive) continue;
        const key = liveBackgroundTaskKey(projectId, worktreeId, chatId);
        const entry = reuseEntry(
          previous[key],
          toEntry(projectId, worktreeId, chatId, chatState),
        );
        next[key] = entry;
        chats[chatId] = {
          sessionActive: entry.sessionActive,
          liveTasks: [...entry.liveTasks],
        };
      }
      const settled: LiveBackgroundTaskChatTarget[] = [];
      for (const [key, entry] of Object.entries(previous)) {
        if (
          key.startsWith(prefix) &&
          tasksBlockClose(entry.liveTasks) &&
          !tasksBlockClose(next[key]?.liveTasks)
        ) {
          settled.push({
            projectId: entry.projectId,
            worktreeId: entry.worktreeId,
            chatId: entry.chatId,
          });
        }
      }
      const hydratedWorktrees = get().hydratedWorktrees;
      const alreadyHydrated = hydratedWorktrees[bufferKey] === true;
      const byChatChanged = !recordsShallowEqual(previous, next);
      if (byChatChanged || !alreadyHydrated) {
        set({
          ...(byChatChanged ? { byChat: next } : {}),
          ...(alreadyHydrated
            ? {}
            : {
                hydratedWorktrees: { ...hydratedWorktrees, [bufferKey]: true },
              }),
        });
      }
      notifySettled(settled);
      return { chats };
    },
    ensureWorktreesHydrated: async (targets): Promise<void> => {
      const pulls: Promise<unknown>[] = [];
      const seen = new Set<string>();
      for (const { projectId, worktreeId } of targets) {
        const key = worktreeKey(projectId, worktreeId);
        if (seen.has(key)) continue;
        seen.add(key);
        if (isWorktreeLiveTasksHydrated(projectId, worktreeId, get())) continue;
        let pull = hydrationsInFlight.get(key);
        if (pull === undefined) {
          const started = get()
            .refreshWorktree(projectId, worktreeId)
            .finally((): void => {
              if (hydrationsInFlight.get(key) === started) {
                hydrationsInFlight.delete(key);
              }
            });
          hydrationsInFlight.set(key, started);
          pull = started;
        }
        pulls.push(pull);
      }
      await Promise.all(pulls);
    },
    reset: (): void => {
      set({ byChat: {}, hydratedWorktrees: {} });
    },
  }),
);

/**
 * Whether the mirror's view of this worktree can be trusted: its snapshot was
 * applied, or the renderer has no bridge to pull one (tests, older preload),
 * so pushes are all it will ever know.
 */
export function isWorktreeLiveTasksHydrated(
  projectId: string,
  worktreeId: string,
  state: Pick<
    LiveBackgroundTaskState,
    'hydratedWorktrees'
  > = useLiveBackgroundTaskStore.getState(),
): boolean {
  return (
    state.hydratedWorktrees[worktreeKey(projectId, worktreeId)] === true ||
    !hasPullBridge()
  );
}

/**
 * Whether this chat has live provider work that blocks close (agents and
 * workflows; never shells, MCP tasks or untyped tasks).
 */
export function selectChatProviderBlocksClose(
  state: Pick<LiveBackgroundTaskState, 'byChat'>,
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return tasksBlockClose(
    state.byChat[liveBackgroundTaskKey(projectId, worktreeId, chatId)]
      ?.liveTasks,
  );
}

/**
 * Which of this chat's open child tool calls may still be running, for the
 * shared tool-closing rule. Derived exactly as main derives it: every live
 * task counts, whatever its type. Before the worktree's snapshot is applied
 * an absent entry proves nothing, so the answer is `unknown`.
 */
export function selectChildToolLiveness(
  state: Pick<LiveBackgroundTaskState, 'byChat' | 'hydratedWorktrees'>,
  projectId: string,
  worktreeId: string,
  chatId: string,
): ChildToolLiveness {
  if (!isWorktreeLiveTasksHydrated(projectId, worktreeId, state)) {
    return { kind: 'unknown' };
  }
  const entry =
    state.byChat[liveBackgroundTaskKey(projectId, worktreeId, chatId)];
  if (entry === undefined) return { kind: 'no-live-session' };
  return {
    kind: 'known',
    liveParentToolUseIds: entry.liveTasks.flatMap((task) =>
      task.toolUseId === undefined ? [] : [task.toolUseId],
    ),
    hasUncorrelatedLiveTask: entry.liveTasks.some(
      (task) => task.toolUseId === undefined,
    ),
  };
}

/** Whether any chat in this worktree (or Cowork Work Entry) blocks close. */
export function selectWorktreeProviderBlocksClose(
  state: Pick<LiveBackgroundTaskState, 'byChat'>,
  projectId: string,
  worktreeId: string,
): boolean {
  return Object.values(state.byChat).some(
    (entry) =>
      entry.projectId === projectId &&
      entry.worktreeId === worktreeId &&
      tasksBlockClose(entry.liveTasks),
  );
}

/** Live provider tasks per worktree (or Work Entry) of a project, shells included. */
export function selectLiveTaskCountsByWorktree(
  state: Pick<LiveBackgroundTaskState, 'byChat'>,
  projectId: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of Object.values(state.byChat)) {
    if (entry.projectId !== projectId || entry.liveTasks.length === 0) continue;
    counts[entry.worktreeId] =
      (counts[entry.worktreeId] ?? 0) + entry.liveTasks.length;
  }
  return counts;
}

/** Whether any chat in this workspace (project or Cowork project) blocks close. */
export function selectWorkspaceProviderBlocksClose(
  state: Pick<LiveBackgroundTaskState, 'byChat'>,
  projectId: string,
): boolean {
  return Object.values(state.byChat).some(
    (entry) =>
      entry.projectId === projectId && tasksBlockClose(entry.liveTasks),
  );
}

/** Non-reactive read of {@link selectChatProviderBlocksClose}. */
export function chatProviderBlocksClose(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return selectChatProviderBlocksClose(
    useLiveBackgroundTaskStore.getState(),
    projectId,
    worktreeId,
    chatId,
  );
}

/**
 * Receives each push after the store applied it: the chat's previous entry
 * (undefined when none was known) and the pushed absolute state.
 */
export type LiveBackgroundTaskPushHandler = (
  previous: LiveBackgroundTaskChatEntry | undefined,
  next: ActivityLiveBgTasksChangedEvent,
) => void;

let pushHandler: LiveBackgroundTaskPushHandler | null = null;

/**
 * Install the consumer of pushes (the activity store registers itself at
 * module load). A seam rather than an import, because the activity store
 * already imports this store for its pull path.
 */
export function setLiveBackgroundTaskPushHandler(
  handler: LiveBackgroundTaskPushHandler | null,
): void {
  pushHandler = handler;
}

let disposeInitialization: (() => void) | null = null;

/**
 * Keep the store current from main's pushes for the app's lifetime and hand
 * each one to the push handler. Idempotent; returns a disposer. A renderer
 * without the bridge (tests, older preload) is a no-op.
 */
export function initializeLiveBackgroundTaskStore(): () => void {
  if (disposeInitialization !== null) {
    return disposeInitialization;
  }
  const api = typeof window === 'undefined' ? undefined : window.api?.activity;
  if (typeof api?.onLiveBgTasksChanged !== 'function') {
    return (): void => {};
  }

  let disposed = false;
  const unsubscribe = api.onLiveBgTasksChanged((event): void => {
    if (disposed) return;
    const previous = useLiveBackgroundTaskStore.getState().applyPush(event);
    try {
      pushHandler?.(previous, event);
    } catch {
      // The mirror stays correct even if a consumer fails.
    }
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (disposeInitialization === dispose) {
      disposeInitialization = null;
    }
  };
  disposeInitialization = dispose;
  return dispose;
}

/**
 * Test-only: drop the subscription, pending pull buffers, settle listeners,
 * hydration and every entry. The registered push handler stays: the activity
 * store installs it once, at module load.
 */
export function resetLiveBackgroundTaskStoreForTests(): void {
  disposeInitialization?.();
  disposeInitialization = null;
  pendingPushBuffers.clear();
  hydrationsInFlight.clear();
  settledListeners.clear();
  useLiveBackgroundTaskStore.setState({ byChat: {}, hydratedWorktrees: {} });
}
