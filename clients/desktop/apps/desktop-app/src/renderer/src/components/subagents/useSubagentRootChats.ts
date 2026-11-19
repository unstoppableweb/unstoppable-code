import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useShallow } from 'zustand/shallow';
import type {
  BackgroundProcess,
  ManagedDelegationRootEntry,
} from '@canopy/desktop-shared/types';
import { isLiveDelegationSnapshot } from '@canopy/app-state/core-cowork';
import type { SubagentRootChatSummary } from '@canopy/ui-app/subagents';
import {
  forgetSubagentDrafts,
  useSubagentViewStateStore,
} from '@canopy/ui-app/subagents';
import { currentLiveSnapshot } from '@/cloud-chats/cloud-delegation-cards';
import {
  heldCloudDelegationSnapshots,
  subscribeHeldCloudDelegations,
} from '@/cloud-chats/cloud-delegation-stop';
import { isWebCoreScope } from '@/lib/chat-authority';
import { getChatTabLabel } from '@/lib/chatTabLabel';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { hydratedKeys } from '@/stores/chat/hydration';
import {
  ownDelegationRunsOf,
  subagentRootSummary,
} from '@/stores/chat/transcript-residency';
import { useActivityStore } from '@/stores/activityStore';
import { useDelegationActivityStore } from '@/stores/delegationActivityStore';
import {
  acquireWorkflowRun,
  getWorkflowRunCacheVersion,
  getWorkflowRunEntry,
  subscribeWorkflowRunCache,
  workflowRunCacheKey,
} from './workflow-run-cache';
import { workflowAgentInputState } from './workflow-run-inputs';
import type { WorkflowRunLocation } from './workflow-run-launches';
import { subagentScopeKey, type SubagentHostScope } from './subagent-scope';

const ROOTS_REFETCH_DELAY_MS = 500;
const EMPTY_TABS: readonly ChatTab[] = [];

interface RootChatActivity {
  readonly live: number;
  readonly queued: number;
}

interface RootChatsStoreSnapshot {
  readonly roots: readonly ManagedDelegationRootEntry[] | null;
  readonly activityByChat: ReadonlyMap<string, RootChatActivity>;
  readonly loading: boolean;
}

interface MutableRootChatsRecord {
  readonly key: string;
  readonly scope: SubagentHostScope;
  /** A cloud scope: main holds none of its delegates (CAN-7133). */
  readonly cloud: boolean;
  readonly listeners: Set<() => void>;
  readonly previouslyListedRootIds: Set<string>;
  snapshot: RootChatsStoreSnapshot;
  consumers: number;
  inFlight: boolean;
  followUpQueued: boolean;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  unsubscribeActivity: (() => void) | null;
}

interface LoadedChatsProjection {
  readonly hydrated: boolean;
  readonly tabs: readonly ChatTab[];
}

export interface UseSubagentRootChatsOptions {
  readonly enabled: boolean;
}

export interface SubagentRootChatsResult {
  readonly rootChats: readonly SubagentRootChatSummary[];
  readonly loading: boolean;
}

const records = new Map<string, MutableRootChatsRecord>();
const EMPTY_ACTIVITY = new Map<string, RootChatActivity>();
const EMPTY_SNAPSHOT: RootChatsStoreSnapshot = {
  roots: null,
  activityByChat: EMPTY_ACTIVITY,
  loading: true,
};
const EMPTY_PROJECTION: LoadedChatsProjection = {
  hydrated: false,
  tabs: EMPTY_TABS,
};
const NOOP_UNSUBSCRIBE = (): void => undefined;

function sameActivity(
  left: RootChatActivity | undefined,
  right: RootChatActivity | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.live === right.live &&
      left.queued === right.queued)
  );
}

function activityByChat(
  scope: SubagentHostScope,
): ReadonlyMap<string, RootChatActivity> {
  const next = new Map<string, RootChatActivity>();
  for (const entry of Object.values(
    useDelegationActivityStore.getState().byChat,
  )) {
    if (
      entry.projectId === scope.projectId &&
      entry.worktreeId === scope.worktreeId
    ) {
      next.set(entry.chatId, { live: entry.live, queued: entry.queued });
    }
  }
  return next;
}

function sameActivityMap(
  left: ReadonlyMap<string, RootChatActivity>,
  right: ReadonlyMap<string, RootChatActivity>,
): boolean {
  if (left.size !== right.size) return false;
  let same = true;
  left.forEach((activity: RootChatActivity, chatId: string): void => {
    if (!sameActivity(activity, right.get(chatId))) same = false;
  });
  return same;
}

function recordKey(scope: SubagentHostScope): string {
  return subagentScopeKey(scope);
}

function ensureRecord(scope: SubagentHostScope): MutableRootChatsRecord {
  const key = recordKey(scope);
  const current = records.get(key);
  if (current) return current;
  const record: MutableRootChatsRecord = {
    key,
    scope,
    cloud: isWebCoreScope(scope.projectId),
    listeners: new Set(),
    previouslyListedRootIds: new Set(),
    snapshot: EMPTY_SNAPSHOT,
    consumers: 0,
    inFlight: false,
    followUpQueued: false,
    refreshTimer: null,
    unsubscribeActivity: null,
  };
  records.set(key, record);
  return record;
}

function publish(record: MutableRootChatsRecord): void {
  record.listeners.forEach((listener: () => void): void => listener());
}

function updateActivitySnapshot(
  record: MutableRootChatsRecord,
  nextActivity: ReadonlyMap<string, RootChatActivity>,
): void {
  if (sameActivityMap(record.snapshot.activityByChat, nextActivity)) return;
  record.snapshot = { ...record.snapshot, activityByChat: nextActivity };
  publish(record);
}

function scheduleRootsRefresh(record: MutableRootChatsRecord): void {
  if (record.refreshTimer !== null) clearTimeout(record.refreshTimer);
  record.refreshTimer = setTimeout((): void => {
    record.refreshTimer = null;
    if (record.consumers === 0) return;
    if (record.inFlight) {
      record.followUpQueued = true;
      return;
    }
    void readRoots(record);
  }, ROOTS_REFETCH_DELAY_MS);
}

function subscribeActivity(record: MutableRootChatsRecord): void {
  const current = activityByChat(record.scope);
  record.snapshot = { ...record.snapshot, activityByChat: current };
  record.unsubscribeActivity = useDelegationActivityStore.subscribe(
    (state, previous): void => {
      let scopeChanged = false;
      const chatIds = new Set<string>();
      for (const entry of Object.values(state.byChat)) {
        if (
          entry.projectId === record.scope.projectId &&
          entry.worktreeId === record.scope.worktreeId
        ) {
          chatIds.add(entry.chatId);
        }
      }
      for (const entry of Object.values(previous.byChat)) {
        if (
          entry.projectId === record.scope.projectId &&
          entry.worktreeId === record.scope.worktreeId
        ) {
          chatIds.add(entry.chatId);
        }
      }
      for (const chatId of Array.from(chatIds)) {
        const key = `${record.scope.projectId}/${record.scope.worktreeId}/${chatId}`;
        if (!sameActivity(state.byChat[key], previous.byChat[key])) {
          scopeChanged = true;
          break;
        }
      }
      updateActivitySnapshot(record, activityByChat(record.scope));
      if (scopeChanged) scheduleRootsRefresh(record);
    },
  );
}

async function readRoots(record: MutableRootChatsRecord): Promise<void> {
  if (record.consumers === 0) return;
  if (record.inFlight) {
    record.followUpQueued = true;
    return;
  }
  if (record.cloud) {
    // A cloud root's delegates are its own cards, counted from its tab.
    record.snapshot = { ...record.snapshot, roots: [], loading: false };
    publish(record);
    return;
  }
  record.inFlight = true;
  try {
    const roots = await window.api.managedDelegation.roots({
      projectId: record.scope.projectId,
      worktreeId: record.scope.worktreeId,
    });
    if (record.consumers > 0) {
      record.snapshot = {
        ...record.snapshot,
        roots,
        loading: false,
      };
    }
  } catch {
    if (record.consumers > 0) {
      record.snapshot = { ...record.snapshot, loading: false };
    }
  } finally {
    record.inFlight = false;
    if (record.consumers > 0) publish(record);
    if (record.consumers > 0 && record.followUpQueued) {
      record.followUpQueued = false;
      void readRoots(record);
    }
  }
}

function subscribeRoots(
  scope: SubagentHostScope,
  listener: () => void,
): () => void {
  const record = ensureRecord(scope);
  record.listeners.add(listener);
  return (): void => {
    record.listeners.delete(listener);
  };
}

function getRootsSnapshot(
  scope: SubagentHostScope | null,
): RootChatsStoreSnapshot {
  if (!scope) return EMPTY_SNAPSHOT;
  return records.get(recordKey(scope))?.snapshot ?? EMPTY_SNAPSHOT;
}

function acquireRoots(scope: SubagentHostScope): () => void {
  const record = ensureRecord(scope);
  record.consumers += 1;
  if (record.consumers === 1) {
    subscribeActivity(record);
    void readRoots(record);
  }
  return (): void => {
    record.consumers = Math.max(0, record.consumers - 1);
    if (record.consumers !== 0) return;
    if (record.refreshTimer !== null) {
      clearTimeout(record.refreshTimer);
      record.refreshTimer = null;
    }
    record.followUpQueued = false;
    record.unsubscribeActivity?.();
    record.unsubscribeActivity = null;
  };
}

const EMPTY_PROCESSES: readonly BackgroundProcess[] = [];

/**
 * A cloud root's delegates: the ones on its own cards (CAN-7133). A card
 * keeps its first state, so a delegate counts live only by a snapshot the
 * window already holds for that chat, and only one no older than its newest
 * card, as the tree reads it; nothing here starts a read.
 */
interface CloudRootDelegates {
  readonly total: number;
  readonly live: number;
  readonly lastActivityAt?: number;
}

function cloudRootDelegates(
  scope: SubagentHostScope,
  tab: ChatTab,
): CloudRootDelegates | undefined {
  // An evicted transcript's own cards are kept with its summary.
  const runs = Object.entries(ownDelegationRunsOf(tab));
  if (runs.length === 0) return undefined;
  const held = heldCloudDelegationSnapshots({ ...scope, chatId: tab.id });
  let live = 0;
  for (const [id, latestCardRun] of runs) {
    const snapshot = currentLiveSnapshot(latestCardRun, held?.get(id));
    if (snapshot !== undefined && isLiveDelegationSnapshot(snapshot)) live += 1;
  }
  return { total: runs.length, live };
}

/** What the held cloud snapshots add to a scope's root counts, as a key. */
function heldCloudLiveKey(
  scope: SubagentHostScope,
  tabs: readonly ChatTab[],
): string {
  return tabs
    .map((tab) => `${tab.id}:${cloudRootDelegates(scope, tab)?.live ?? 0}`)
    .join('\n');
}

function toRootChatSummary(
  scope: SubagentHostScope,
  tabs: readonly ChatTab[],
  snapshot: RootChatsStoreSnapshot,
  processes: readonly BackgroundProcess[],
): readonly SubagentRootChatSummary[] {
  const cloud = isWebCoreScope(scope.projectId);
  // A background Claude task is live while its process is queued or running.
  const backgroundStatuses = new Map(
    processes.map((process) => [
      `${process.chatId}\u0000${process.toolUseId}`,
      process.status,
    ]),
  );
  const rootsByChat = new Map(
    (snapshot.roots ?? []).map((entry) => [entry.chatId, entry]),
  );
  const summaries: SubagentRootChatSummary[] = [];
  for (const tab of tabs) {
    if (tab.kind === 'file') continue;
    const summary = subagentRootSummary(tab, (toolUseId) =>
      backgroundStatuses.get(`${tab.id}\u0000${toolUseId}`),
    );
    const { native } = summary;
    // Workflow runs are pipelines on this computer; a cloud root has none.
    const hasWorkflowLaunch = !cloud && summary.hasWorkflowLaunches;
    const workflowLocations = cloud ? [] : summary.workflowLocations;
    const managed = cloud
      ? cloudRootDelegates(scope, tab)
      : rootsByChat.get(tab.id);
    if (
      !(managed && managed.total > 0) &&
      !native.hasNativeAgentBlocks &&
      !hasWorkflowLaunch
    ) {
      continue;
    }
    const activity = snapshot.activityByChat.get(tab.id);
    let total = (managed?.total ?? 0) + native.total;
    let workflowLive = 0;
    let lastActivityAt = latestTimestamp(
      managed?.lastActivityAt,
      native.lastActivityAt,
    );
    let workflowLoading = false;
    for (const location of workflowLocations) {
      lastActivityAt = latestTimestamp(lastActivityAt, location.launchedAt);
      const entry = getWorkflowRunEntry(location);
      if (!entry.loaded) {
        workflowLoading = true;
        continue;
      }
      lastActivityAt = latestTimestamp(
        lastActivityAt,
        entry.state?.lastActivityAt,
      );
      for (const agent of entry.state?.agents ?? []) {
        if (!/^[A-Za-z0-9_-]+$/.test(agent.agentId)) continue;
        total += 1;
        const agentState = workflowAgentInputState(agent.state);
        if (
          entry.status === 'running' &&
          (agentState === 'queued' || agentState === 'running')
        ) {
          workflowLive += 1;
        }
      }
    }
    const existingLive = Math.max(
      managed?.live ?? 0,
      (activity?.live ?? 0) + (activity?.queued ?? 0),
    );
    summaries.push({
      id: tab.id,
      title: getChatTabLabel(tab),
      total,
      live: existingLive + native.live + workflowLive,
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      ...(snapshot.loading || workflowLoading ? { loading: true } : {}),
    });
  }
  return summaries;
}

function latestTimestamp(
  current: number | undefined,
  next: number | undefined,
): number | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.max(current, next);
}

function closedListedRoots(
  record: MutableRootChatsRecord,
  openTabIds: ReadonlySet<string>,
  currentRootIds: readonly string[],
): readonly string[] {
  const closed = Array.from(record.previouslyListedRootIds).filter(
    (rootId) => !openTabIds.has(rootId),
  );
  for (const rootId of closed) record.previouslyListedRootIds.delete(rootId);
  for (const rootId of currentRootIds) {
    if (openTabIds.has(rootId)) record.previouslyListedRootIds.add(rootId);
  }
  return closed;
}

function forgetClosedRoots(scopeKey: string, rootIds: readonly string[]): void {
  if (rootIds.length === 0) return;
  useSubagentViewStateStore
    .getState()
    .forgetSubagentRootChats(scopeKey, rootIds);
  for (const rootId of rootIds) forgetSubagentDrafts(rootId);
}

/** Lists open root chats with managed or provider-native subagents (D4). */
export function useSubagentRootChats(
  scope: SubagentHostScope,
  options: UseSubagentRootChatsOptions,
): SubagentRootChatsResult {
  const enabled = options.enabled;
  const scopeId = subagentScopeKey(scope);

  const loaded = useChatStore(
    useShallow((state): LoadedChatsProjection => {
      if (!enabled) return EMPTY_PROJECTION;
      const hydrated = hydratedKeys.has(scopeId);
      const tabs = hydrated
        ? (state.worktreeChats[scopeId]?.tabs ?? EMPTY_TABS)
        : EMPTY_TABS;
      return { hydrated, tabs };
    }),
  );

  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      enabled ? subscribeRoots(scope, listener) : NOOP_UNSUBSCRIBE,
    [enabled, scope],
  );
  const getSnapshot = useCallback(() => getRootsSnapshot(scope), [scope]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const workflowCacheVersion = useSyncExternalStore(
    subscribeWorkflowRunCache,
    getWorkflowRunCacheVersion,
    getWorkflowRunCacheVersion,
  );

  useEffect(() => {
    if (!enabled) return undefined;
    return acquireRoots(scope);
  }, [enabled, scope, scopeId]);

  const cloud = isWebCoreScope(scope.projectId);
  const getHeldLiveKey = useCallback(
    (): string =>
      enabled && cloud ? heldCloudLiveKey(scope, loaded.tabs) : '',
    [cloud, enabled, loaded.tabs, scope],
  );
  const heldLiveKey = useSyncExternalStore(
    subscribeHeldCloudDelegations,
    getHeldLiveKey,
    getHeldLiveKey,
  );

  const workflowLocations = useMemo((): readonly WorkflowRunLocation[] => {
    if (!enabled || !loaded.hydrated || cloud) return [];
    const locations = new Map<string, WorkflowRunLocation>();
    for (const tab of loaded.tabs) {
      if (tab.kind === 'file') continue;
      for (const location of subagentRootSummary(tab).workflowLocations) {
        const key = workflowRunCacheKey(location);
        if (!locations.has(key)) locations.set(key, location);
      }
    }
    return Array.from(locations.values());
  }, [cloud, enabled, loaded.hydrated, loaded.tabs]);
  const workflowLocationKeys = useMemo(
    () =>
      JSON.stringify(
        workflowLocations
          .map((location) => workflowRunCacheKey(location))
          .sort(),
      ),
    [workflowLocations],
  );
  const workflowLocationsRef = useRef(workflowLocations);
  workflowLocationsRef.current = workflowLocations;

  useEffect(() => {
    if (!enabled) return undefined;
    const releases = workflowLocationsRef.current.map((location) =>
      acquireWorkflowRun(location),
    );
    return (): void => releases.forEach((release) => release());
  }, [enabled, workflowLocationKeys]);

  const backgroundProcesses = useActivityStore(
    (state): readonly BackgroundProcess[] =>
      enabled
        ? (state.bgProcesses[scopeId] ?? EMPTY_PROCESSES)
        : EMPTY_PROCESSES,
  );
  const rootChats = useMemo((): readonly SubagentRootChatSummary[] => {
    // Summaries read the workflow run cache and the held cloud snapshots; a
    // new version of either recounts them.
    void workflowCacheVersion;
    void heldLiveKey;
    return enabled && loaded.hydrated
      ? toRootChatSummary(scope, loaded.tabs, snapshot, backgroundProcesses)
      : [];
  }, [
    backgroundProcesses,
    enabled,
    heldLiveKey,
    loaded.hydrated,
    loaded.tabs,
    scope,
    snapshot,
    workflowCacheVersion,
  ]);

  useEffect(() => {
    if (!enabled || !loaded.hydrated) return;
    const record = ensureRecord(scope);
    const openTabIds = new Set(loaded.tabs.map((tab) => tab.id));
    const currentRootIds = rootChats.map((root) => root.id);
    forgetClosedRoots(
      scopeId,
      closedListedRoots(record, openTabIds, currentRootIds),
    );
  }, [enabled, loaded.hydrated, loaded.tabs, rootChats, scope, scopeId]);

  return {
    rootChats,
    loading: enabled && (!loaded.hydrated || snapshot.loading),
  };
}
