import {
  collectLoadedSubagentInputs,
  type LoadedSubagentInputs,
} from '@canopy/agent-transcript/lib/subagent-tree/native-inputs';
import {
  buildSubagentTree,
  type AgentUsage,
  type SubagentTree,
  type WorkflowRunSubagentInput,
} from '@canopy/agent-transcript';
import type {
  ManagedDelegationTreeEntry,
  BackgroundProcess,
  BackgroundProcessStatus,
} from '@canopy/desktop-shared/types';
import { overlayManagedDelegationSnapshot } from '@canopy/ui-app/managed-delegation-progress';
import type { SubagentTreeLoadState } from '@canopy/ui-app/subagents';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import type { ChatMessage } from '@/stores/chatStore';
import { currentLiveSnapshot } from '@/cloud-chats/cloud-delegation-cards';
import { isWebCoreScope } from '@/lib/chat-authority';
import { extractIpcErrorMessage } from '@/lib/errors';
import { useActivityStore } from '@/stores/activityStore';
import {
  chatDelegationKey,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  buildDesktopSubagentTreeInput,
  subagentTreeInputFingerprint,
} from './subagent-tree-input';
import {
  acquireWorkflowRun,
  getWorkflowRunEntry,
  subscribeWorkflowRunCache,
  workflowRunCacheKey,
} from './workflow-run-cache';
import type { WorkflowRunCacheEntry } from './workflow-run-cache';
import { workflowRunSubagentInput } from './workflow-run-inputs';
import { collectWorkflowRunLocations } from './workflow-run-launches';
import type { WorkflowRunLocation } from './workflow-run-launches';
import type { SubagentHostScope } from './subagent-scope';

const EMPTY_LOADED_INPUTS: LoadedSubagentInputs = {
  managed: [],
  claudeNative: [],
  codexNative: [],
};

const EMPTY_MANAGED_ENTRIES: ReadonlyMap<string, ManagedDelegationTreeEntry> =
  new Map();

const NO_LIVE_SNAPSHOTS: ReadonlyMap<string, AgentDelegationSnapshot> =
  new Map();

const ACTIVITY_REFETCH_DELAY_MS = 500;

export interface SubagentTreeStoreSnapshot {
  readonly tree: SubagentTree | null;
  readonly treeState: SubagentTreeLoadState;
  readonly settled: boolean;
  readonly rootChatOpen: boolean;
  readonly hydrated: boolean;
  readonly managedEntries: ReadonlyMap<string, ManagedDelegationTreeEntry>;
}

interface MutableTreeRecord {
  readonly key: string;
  readonly scope: SubagentHostScope;
  readonly rootChatId: string;
  /**
   * A cloud scope (CAN-7133): its delegates don't run on this computer, so
   * the tree comes only from the root chat's own cards, overlaid with their
   * live snapshots, and main is never asked.
   */
  readonly cloud: boolean;
  readonly paired: boolean;
  readonly listeners: Set<() => void>;
  snapshot: SubagentTreeStoreSnapshot;
  /** A cloud root's delegates as the web core last read them. */
  liveSnapshots: ReadonlyMap<string, AgentDelegationSnapshot>;
  consumers: number;
  hydrated: boolean;
  rootChatOpen: boolean;
  rootTitle: string;
  messages: readonly ChatMessage[] | null;
  agentUsage: Readonly<Record<string, AgentUsage>> | undefined;
  workflowLocations: readonly WorkflowRunLocation[];
  workflowInputs: readonly WorkflowRunSubagentInput[];
  workflowCacheEntries: ReadonlyMap<string, WorkflowRunCacheEntry>;
  /**
   * Whether every known workflow run has been read once. Until then the tree
   * reports loading, so a saved focus on a run is not mistaken for a removed
   * node. It latches, so a run launched later does not flip the tree back.
   */
  workflowReadsSettledOnce: boolean;
  workflowAcquisitions: Map<
    string,
    { readonly location: WorkflowRunLocation; readonly release: () => void }
  >;
  loaded: LoadedSubagentInputs;
  backgroundStatuses: ReadonlyMap<string, BackgroundAgentState>;
  latestEntries: readonly ManagedDelegationTreeEntry[] | null;
  managedEntryMap: ReadonlyMap<string, ManagedDelegationTreeEntry>;
  initialReadSettled: boolean;
  readFailed: boolean;
  error: string;
  inFlight: boolean;
  followUpQueued: boolean;
  activityTimer: ReturnType<typeof setTimeout> | null;
  unsubscribeDelegationActivity: (() => void) | null;
  unsubscribeBackgroundActivity: (() => void) | null;
  unsubscribeWorkflowRunCache: (() => void) | null;
  treeFingerprint: string | null;
}

const records = new Map<string, MutableTreeRecord>();

const INERT_SNAPSHOT: SubagentTreeStoreSnapshot = {
  tree: null,
  treeState: { status: 'loading' },
  settled: false,
  rootChatOpen: false,
  hydrated: false,
  managedEntries: EMPTY_MANAGED_ENTRIES,
};

function recordKey(scope: SubagentHostScope, rootChatId: string): string {
  return `${scope.projectId}/${scope.worktreeId}/${rootChatId}`;
}

function sameActivity(
  left: { readonly live: number; readonly queued: number } | undefined,
  right: { readonly live: number; readonly queued: number } | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.live === right.live &&
      left.queued === right.queued)
  );
}

function latestEntriesById(
  entries: readonly ManagedDelegationTreeEntry[],
): ReadonlyMap<string, ManagedDelegationTreeEntry> {
  const latest = new Map<string, ManagedDelegationTreeEntry>();
  for (const entry of entries) {
    const delegationId = entry.snapshot.delegationId;
    const previous = latest.get(delegationId);
    if (
      previous === undefined ||
      entry.runGeneration > previous.runGeneration ||
      (entry.runGeneration === previous.runGeneration &&
        entry.sequence > previous.sequence)
    ) {
      latest.set(delegationId, entry);
    }
  }
  return latest;
}

function hasLoadedFallback(
  loaded: LoadedSubagentInputs,
  workflowInputs: readonly WorkflowRunSubagentInput[],
): boolean {
  return (
    loaded.managed.length > 0 ||
    loaded.claudeNative.length > 0 ||
    loaded.codexNative.length > 0 ||
    workflowInputs.length > 0
  );
}

function hasPendingWorkflowRead(record: MutableTreeRecord): boolean {
  return record.workflowLocations.some(
    (location) => !getWorkflowRunEntry(location).loaded,
  );
}

function treeStateFor(record: MutableTreeRecord): SubagentTreeLoadState {
  if (!record.initialReadSettled) return { status: 'loading' };
  if (!record.workflowReadsSettledOnce && hasPendingWorkflowRead(record)) {
    return { status: 'loading' };
  }
  if (
    record.readFailed &&
    record.latestEntries === null &&
    !hasLoadedFallback(record.loaded, record.workflowInputs)
  ) {
    return {
      status: 'error',
      error: record.error,
      onRetry: (): void =>
        retrySubagentTreeRead(record.scope, record.rootChatId),
    };
  }
  return { status: 'ready' };
}

function createSnapshot(record: MutableTreeRecord): void {
  record.snapshot = {
    tree: record.snapshot.tree,
    treeState: treeStateFor(record),
    settled: record.initialReadSettled,
    rootChatOpen: record.rootChatOpen,
    hydrated: record.hydrated,
    managedEntries: record.managedEntryMap,
  };
}

function publish(record: MutableTreeRecord): void {
  createSnapshot(record);
  record.listeners.forEach((listener: () => void): void => listener());
}

function ensureRecord(
  scope: SubagentHostScope,
  rootChatId: string,
): MutableTreeRecord {
  const key = recordKey(scope, rootChatId);
  const current = records.get(key);
  if (current) return current;
  const record: MutableTreeRecord = {
    key,
    scope,
    rootChatId,
    cloud: isWebCoreScope(scope.projectId),
    paired: isPairedComputerId(scope.projectId),
    listeners: new Set(),
    snapshot: INERT_SNAPSHOT,
    liveSnapshots: NO_LIVE_SNAPSHOTS,
    consumers: 0,
    hydrated: false,
    rootChatOpen: false,
    rootTitle: rootChatId,
    messages: null,
    agentUsage: undefined,
    workflowLocations: [],
    workflowInputs: [],
    workflowCacheEntries: new Map(),
    workflowReadsSettledOnce: false,
    workflowAcquisitions: new Map(),
    loaded: EMPTY_LOADED_INPUTS,
    backgroundStatuses: new Map(),
    latestEntries: null,
    managedEntryMap: EMPTY_MANAGED_ENTRIES,
    initialReadSettled: false,
    readFailed: false,
    error: '',
    inFlight: false,
    followUpQueued: false,
    activityTimer: null,
    unsubscribeDelegationActivity: null,
    unsubscribeBackgroundActivity: null,
    unsubscribeWorkflowRunCache: null,
    treeFingerprint: null,
  };
  createSnapshot(record);
  records.set(key, record);
  return record;
}

function buildTree(record: MutableTreeRecord): boolean {
  if (!record.initialReadSettled) return false;
  const managedEntries = record.latestEntries;
  const input = buildDesktopSubagentTreeInput({
    root: { id: record.rootChatId, title: record.rootTitle },
    managedEntries,
    loaded: record.loaded,
    workflowRuns: record.workflowInputs,
  });
  const fingerprint = subagentTreeInputFingerprint(input);
  if (record.treeFingerprint !== fingerprint) {
    record.treeFingerprint = fingerprint;
    record.snapshot = {
      ...record.snapshot,
      tree: buildSubagentTree(input),
    };
    return true;
  }
  return false;
}

function sameTreeLoadState(
  left: SubagentTreeLoadState,
  right: SubagentTreeLoadState,
): boolean {
  if (left.status !== right.status) return false;
  return (
    left.status !== 'error' ||
    (right.status === 'error' && left.error === right.error)
  );
}

function publishWhenTreeOrStateChanges(
  record: MutableTreeRecord,
  treeChanged: boolean,
): void {
  const nextState = treeStateFor(record);
  if (!treeChanged && sameTreeLoadState(record.snapshot.treeState, nextState)) {
    return;
  }
  publish(record);
}

/** A background Claude agent's process status, and when it settled. */
interface BackgroundAgentState {
  readonly status: BackgroundProcessStatus;
  readonly settledAt?: number;
}

function backgroundStatusesFor(
  record: MutableTreeRecord,
  processes: readonly BackgroundProcess[],
): ReadonlyMap<string, BackgroundAgentState> {
  if (!record.messages) return new Map();
  const toolUseIds = new Set<string>();
  for (const message of record.messages) {
    for (const block of message.blocks) {
      if (
        block.type === 'tool_use' &&
        (block.toolName === 'Task' || block.toolName === 'Agent')
      ) {
        toolUseIds.add(block.toolUseId);
      }
    }
  }
  const statuses = new Map<string, BackgroundAgentState>();
  for (const process of processes) {
    if (
      process.chatId === record.rootChatId &&
      toolUseIds.has(process.toolUseId)
    ) {
      statuses.set(process.toolUseId, {
        status: process.status,
        ...(process.endedAt !== undefined
          ? { settledAt: process.endedAt }
          : {}),
      });
    }
  }
  return statuses;
}

function sameStatuses(
  left: ReadonlyMap<string, BackgroundAgentState>,
  right: ReadonlyMap<string, BackgroundAgentState>,
): boolean {
  if (left.size !== right.size) return false;
  let same = true;
  left.forEach((state: BackgroundAgentState, toolUseId: string): void => {
    const other = right.get(toolUseId);
    if (other?.status !== state.status || other.settledAt !== state.settledAt)
      same = false;
  });
  return same;
}

/**
 * A cloud root's messages with each delegate's latest own card at its live
 * state: a cloud card keeps its first state (CAN-7133). Only the root's own
 * cards are overlaid; a snapshot with no card there adds nothing. Earlier
 * runs' cards keep their own run and state. A live run newer than any card
 * is shown beside the latest card, as a run of its own; an older one is
 * ignored.
 */
function withLiveCards(
  messages: readonly ChatMessage[],
  live: ReadonlyMap<string, AgentDelegationSnapshot>,
): readonly ChatMessage[] {
  if (live.size === 0) return messages;
  const latestCards = new Map<string, ChatMessage['blocks'][number]>();
  const cardIds = new Set<string>();
  for (const message of messages)
    for (const block of message.blocks) {
      if (block.type !== 'delegated_agent_call') continue;
      cardIds.add(block.agentBlockId);
      const previous = latestCards.get(block.delegationId);
      if (
        previous?.type !== 'delegated_agent_call' ||
        block.runGeneration >= previous.runGeneration
      )
        latestCards.set(block.delegationId, block);
    }
  return messages.map((message): ChatMessage => {
    let touched = false;
    const blocks = message.blocks.flatMap((block) => {
      if (
        block.type !== 'delegated_agent_call' ||
        latestCards.get(block.delegationId) !== block
      )
        return [block];
      const snapshot = currentLiveSnapshot(
        block.runGeneration,
        live.get(block.delegationId),
      );
      if (snapshot === undefined) return [block];
      const liveRun = snapshot.runGeneration ?? 1;
      touched = true;
      const shown = {
        ...block,
        ...overlayManagedDelegationSnapshot(block, snapshot),
      };
      if (liveRun === block.runGeneration) return [shown];
      const runId = `delegated-agent-${block.delegationId}-run-${String(liveRun)}`;
      return [
        block,
        {
          ...shown,
          runGeneration: liveRun,
          agentBlockId: cardIds.has(runId) ? `${runId}-live` : runId,
        },
      ];
    });
    return touched ? { ...message, blocks } : message;
  });
}

function updateLoadedInputs(record: MutableTreeRecord): void {
  if (!record.messages) {
    record.loaded = EMPTY_LOADED_INPUTS;
    return;
  }
  const messages = record.cloud
    ? withLiveCards(record.messages, record.liveSnapshots)
    : record.messages;
  record.loaded = collectLoadedSubagentInputs(messages, {
    backgroundStatusFor: (toolUseId) =>
      record.backgroundStatuses.get(toolUseId)?.status,
    backgroundSettledAtFor: (toolUseId) =>
      record.backgroundStatuses.get(toolUseId)?.settledAt,
    ...(record.agentUsage ? { agentUsage: record.agentUsage } : {}),
  });
}

function sameWorkflowCacheEntries(
  left: ReadonlyMap<string, WorkflowRunCacheEntry>,
  right: ReadonlyMap<string, WorkflowRunCacheEntry>,
): boolean {
  if (left.size !== right.size) return false;
  let same = true;
  left.forEach((entry: WorkflowRunCacheEntry, key: string): void => {
    if (right.get(key) !== entry) same = false;
  });
  return same;
}

function refreshWorkflowInputs(record: MutableTreeRecord): boolean {
  const nextEntries = new Map<string, WorkflowRunCacheEntry>();
  for (const location of record.workflowLocations) {
    const key = workflowRunCacheKey(location);
    nextEntries.set(key, getWorkflowRunEntry(location));
  }
  if (sameWorkflowCacheEntries(record.workflowCacheEntries, nextEntries)) {
    return false;
  }
  record.workflowCacheEntries = nextEntries;
  if (
    record.workflowLocations.length > 0 &&
    Array.from(nextEntries.values()).every((entry) => entry.loaded)
  ) {
    record.workflowReadsSettledOnce = true;
  }
  record.workflowInputs = record.workflowLocations.flatMap((location) => {
    const entry = nextEntries.get(workflowRunCacheKey(location));
    if (!entry?.loaded) return [];
    return [
      workflowRunSubagentInput(
        location,
        entry.state,
        entry.status ?? 'interrupted',
      ),
    ];
  });
  return true;
}

function releaseWorkflowAcquisitions(record: MutableTreeRecord): void {
  record.workflowAcquisitions.forEach(({ release }): void => release());
  record.workflowAcquisitions.clear();
}

function syncWorkflowAcquisitions(record: MutableTreeRecord): void {
  const nextLocations = new Map<string, WorkflowRunLocation>(
    record.workflowLocations.map((location): [string, WorkflowRunLocation] => [
      workflowRunCacheKey(location),
      location,
    ]),
  );
  record.workflowAcquisitions.forEach((acquired, key): void => {
    const nextLocation = nextLocations.get(key);
    if (
      nextLocation === undefined ||
      acquired.location.taskId !== nextLocation.taskId ||
      acquired.location.toolUseId !== nextLocation.toolUseId
    ) {
      acquired.release();
      record.workflowAcquisitions.delete(key);
    }
  });
  if (record.consumers === 0 || record.paired) return;
  nextLocations.forEach((location: WorkflowRunLocation, key: string): void => {
    if (record.workflowAcquisitions.has(key)) return;
    record.workflowAcquisitions.set(key, {
      location,
      release: acquireWorkflowRun(location),
    });
  });
}

function updateWorkflowLocations(
  record: MutableTreeRecord,
  locations: readonly WorkflowRunLocation[],
): void {
  record.workflowLocations = locations;
  record.workflowCacheEntries = new Map();
  syncWorkflowAcquisitions(record);
  if (locations.length === 0) {
    record.workflowInputs = [];
    return;
  }
  refreshWorkflowInputs(record);
}

function onWorkflowRunCacheChanged(record: MutableTreeRecord): void {
  if (record.consumers === 0 || !refreshWorkflowInputs(record)) return;
  const treeChanged = buildTree(record);
  publishWhenTreeOrStateChanges(record, treeChanged);
}

function subscribeWorkflowRuns(record: MutableTreeRecord): void {
  record.workflowCacheEntries = new Map();
  record.unsubscribeWorkflowRunCache = subscribeWorkflowRunCache(() => {
    onWorkflowRunCacheChanged(record);
  });
  syncWorkflowAcquisitions(record);
  if (!refreshWorkflowInputs(record)) return;
  const treeChanged = buildTree(record);
  publishWhenTreeOrStateChanges(record, treeChanged);
}

function unsubscribeWorkflowRuns(record: MutableTreeRecord): void {
  record.unsubscribeWorkflowRunCache?.();
  record.unsubscribeWorkflowRunCache = null;
  releaseWorkflowAcquisitions(record);
  record.workflowCacheEntries = new Map();
}

function onBackgroundActivityChanged(
  record: MutableTreeRecord,
  processes: readonly BackgroundProcess[],
): void {
  if (record.consumers === 0) return;
  const nextStatuses = backgroundStatusesFor(record, processes);
  if (sameStatuses(record.backgroundStatuses, nextStatuses)) return;
  record.backgroundStatuses = nextStatuses;
  updateLoadedInputs(record);
  buildTree(record);
  publish(record);
}

function scheduleActivityRefresh(record: MutableTreeRecord): void {
  if (record.activityTimer !== null) clearTimeout(record.activityTimer);
  record.activityTimer = setTimeout((): void => {
    record.activityTimer = null;
    if (record.consumers === 0) return;
    if (record.inFlight) {
      record.followUpQueued = true;
      return;
    }
    void readTree(record);
  }, ACTIVITY_REFETCH_DELAY_MS);
}

function subscribeActivities(record: MutableTreeRecord): void {
  const activityKey = chatDelegationKey(
    record.scope.projectId,
    record.scope.worktreeId,
    record.rootChatId,
  );
  record.unsubscribeDelegationActivity = useDelegationActivityStore.subscribe(
    (state, previous): void => {
      if (
        !sameActivity(state.byChat[activityKey], previous.byChat[activityKey])
      ) {
        scheduleActivityRefresh(record);
      }
    },
  );
  const activityStoreKey = `${record.scope.projectId}/${record.scope.worktreeId}`;
  record.unsubscribeBackgroundActivity = useActivityStore.subscribe(
    (state): void => {
      onBackgroundActivityChanged(
        record,
        state.bgProcesses[activityStoreKey] ?? [],
      );
    },
  );
  onBackgroundActivityChanged(
    record,
    useActivityStore.getState().bgProcesses[activityStoreKey] ?? [],
  );
}

async function readTree(record: MutableTreeRecord): Promise<void> {
  if (record.consumers === 0) return;
  if (record.inFlight) {
    record.followUpQueued = true;
    return;
  }
  if (record.cloud || record.paired) {
    // Main holds no cloud or paired-computer delegate: the root's own cards are the whole tree.
    record.latestEntries = [];
    record.managedEntryMap = EMPTY_MANAGED_ENTRIES;
    record.initialReadSettled = true;
    buildTree(record);
    publish(record);
    return;
  }
  record.inFlight = true;
  try {
    const result = await window.api.managedDelegation.tree({
      projectId: record.scope.projectId,
      worktreeId: record.scope.worktreeId,
      chatId: record.rootChatId,
    });
    if (record.consumers === 0) return;
    if (result.ok) {
      record.latestEntries = result.entries;
      record.managedEntryMap = latestEntriesById(result.entries);
      record.readFailed = false;
      record.error = '';
    } else {
      record.readFailed = true;
      record.error = result.error;
    }
  } catch (error: unknown) {
    record.readFailed = true;
    record.error = extractIpcErrorMessage(error);
  } finally {
    record.inFlight = false;
    if (record.consumers > 0) {
      record.initialReadSettled = true;
      buildTree(record);
      publish(record);
    }
    if (record.consumers > 0 && record.followUpQueued) {
      record.followUpQueued = false;
      void readTree(record);
    }
  }
}

/** Adds one hook consumer and starts the shared read/activity subscriptions. */
export function acquireSubagentTree(
  scope: SubagentHostScope,
  rootChatId: string,
): () => void {
  const record = ensureRecord(scope, rootChatId);
  record.consumers += 1;
  if (record.consumers === 1) {
    subscribeActivities(record);
    subscribeWorkflowRuns(record);
    void readTree(record);
  }
  return (): void => {
    record.consumers = Math.max(0, record.consumers - 1);
    if (record.consumers !== 0) return;
    if (record.activityTimer !== null) {
      clearTimeout(record.activityTimer);
      record.activityTimer = null;
    }
    record.followUpQueued = false;
    record.unsubscribeDelegationActivity?.();
    record.unsubscribeDelegationActivity = null;
    record.unsubscribeBackgroundActivity?.();
    record.unsubscribeBackgroundActivity = null;
    unsubscribeWorkflowRuns(record);
    record.messages = null;
    record.agentUsage = undefined;
    record.workflowLocations = [];
    record.workflowInputs = [];
    record.workflowReadsSettledOnce = false;
    record.loaded = EMPTY_LOADED_INPUTS;
    record.backgroundStatuses = new Map();
    record.liveSnapshots = NO_LIVE_SNAPSHOTS;
  };
}

/** Updates just the root tab's messages/title projection for one active query. */
export function updateSubagentTreeRootChat(
  scope: SubagentHostScope,
  rootChatId: string,
  input: {
    readonly hydrated: boolean;
    readonly rootChatOpen: boolean;
    readonly title: string;
    readonly messages: readonly ChatMessage[] | null;
    readonly agentUsage?: Readonly<Record<string, AgentUsage>>;
  },
): void {
  const record = ensureRecord(scope, rootChatId);
  const nextMessages = input.rootChatOpen ? input.messages : null;
  const nextAgentUsage = input.rootChatOpen ? input.agentUsage : undefined;
  const messageChanged = record.messages !== nextMessages;
  const agentUsageChanged = record.agentUsage !== nextAgentUsage;
  const rootChanged =
    record.rootChatOpen !== input.rootChatOpen ||
    record.hydrated !== input.hydrated ||
    record.rootTitle !== input.title;
  record.hydrated = input.hydrated;
  record.rootChatOpen = input.rootChatOpen;
  record.rootTitle = input.title;
  record.agentUsage = nextAgentUsage;
  if (agentUsageChanged && !messageChanged) updateLoadedInputs(record);
  if (messageChanged) {
    record.messages = nextMessages;
    const worktreeKey = `${scope.projectId}/${scope.worktreeId}`;
    record.backgroundStatuses = backgroundStatusesFor(
      record,
      useActivityStore.getState().bgProcesses[worktreeKey] ?? [],
    );
    updateLoadedInputs(record);
    // Workflow runs are pipelines on this computer; cloud and paired roots have none.
    updateWorkflowLocations(
      record,
      nextMessages === null || record.cloud || record.paired
        ? []
        : collectWorkflowRunLocations(nextMessages),
    );
  }
  if (rootChanged || messageChanged || agentUsageChanged) {
    buildTree(record);
    publish(record);
  }
}

/**
 * Sets a cloud root's live delegate snapshots (CAN-7133). A local root's
 * tree reads main, so it ignores them.
 */
export function updateSubagentTreeLiveSnapshots(
  scope: SubagentHostScope,
  rootChatId: string,
  snapshots: ReadonlyMap<string, AgentDelegationSnapshot> | null,
): void {
  const record = ensureRecord(scope, rootChatId);
  const next = snapshots ?? NO_LIVE_SNAPSHOTS;
  if (!record.cloud || record.liveSnapshots === next) return;
  record.liveSnapshots = next;
  updateLoadedInputs(record);
  if (buildTree(record)) publish(record);
}

export function getSubagentTreeSnapshot(
  scope: SubagentHostScope | null,
  rootChatId: string | null,
): SubagentTreeStoreSnapshot {
  if (!scope || !rootChatId) return INERT_SNAPSHOT;
  return records.get(recordKey(scope, rootChatId))?.snapshot ?? INERT_SNAPSHOT;
}

export function subscribeSubagentTree(
  scope: SubagentHostScope,
  rootChatId: string,
  listener: () => void,
): () => void {
  const record = ensureRecord(scope, rootChatId);
  record.listeners.add(listener);
  return (): void => {
    record.listeners.delete(listener);
  };
}

function retrySubagentTreeRead(
  scope: SubagentHostScope,
  rootChatId: string,
): void {
  const record = ensureRecord(scope, rootChatId);
  if (record.consumers === 0) return;
  record.followUpQueued = false;
  void readTree(record);
}

/** Test-only state cleanup; production records are retained as cheap snapshots. */
export function resetSubagentTreeStoreForTests(): void {
  records.forEach((record: MutableTreeRecord): void => {
    if (record.activityTimer !== null) clearTimeout(record.activityTimer);
    record.unsubscribeDelegationActivity?.();
    record.unsubscribeBackgroundActivity?.();
    unsubscribeWorkflowRuns(record);
  });
  records.clear();
}
