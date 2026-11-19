// Chat tab transcript residency: a tab's transcript stays in renderer memory
// only while a view shows it, plus a small recently-shown allowance per
// worktree. Hidden tabs beyond that drop back to the shape main sends for a
// hidden tab at hydration (`messages: []`, `transcriptLoaded: false`, no
// window), so `ChatContent` reloads them through `loadChatTranscriptPage` on
// open exactly as it does after a worktree reload.
//
// Design (see the slice report):
// - Visible = this renderer's chat interest (`focused` and `warm` refs,
//   `lib/chat-interest`: the panel layouts' visible chat panels, aux windows,
//   App Advisor and the Pipeline Assistant), the scope's `activeTabId`, and
//   every mounted `ChatContent` (`retainChatTranscriptView`).
// - Pinned by state = anything that would make a reload unsafe or lose live
//   presentation: a live or pending turn, optimistic sends, queue dispatch or
//   queue rows, queued-message editing, pending questions, approvals and plan
//   exits, unread replies, hook placeholders, setup queueing, stale catch-up
//   reads and provisional creation. See `isChatTranscriptPinnedByState`.
// - Of the remaining resident hidden tabs (`messages.length > 0`), the
//   `CHAT_TRANSCRIPT_HIDDEN_TAB_ALLOWANCE` most recently shown are kept; the
//   rest are evicted.
// - Sweeps run for the selected worktree only, throttled after a change to
//   its chat state, the pending records or the chat interest (tab switches
//   and eligibility changes such as a turn completing).
// - Eviction never writes main, never changes revisioned sync ownership, the
//   queue, settings or metadata, and adds no persisted field.

import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { loadedSubagentSummary } from '@canopy/agent-transcript/lib/subagent-tree/native-inputs';
import {
  collectWorkflowRunLocations,
  hasWorkflowLaunches,
} from '@/components/subagents/workflow-run-launches';
import type { ChatInterestChatRef } from '@canopy/desktop-shared/types';
import { chatsOwnLatestRuns } from '@/cloud-chats/cloud-delegation-cards';
import { isUnrefableTimeout, loadingKeys } from './hydration';
import { hasPendingTrackedPlanReview } from './plan-utils';
import { chatScopeKey } from './revisioned-sync';
import { isStaleChatCatchUpRunning } from './stale-catch-up';
import { tryChatStoreApi } from './store-ref';
import type { ChatState } from './state';
import type { ChatTab, WorktreeChatState } from './types';

/** The Subagents picker summary an evicted tab keeps. */
export type EvictedSubagentRoot = NonNullable<ChatTab['evictedSubagentRoot']>;

/** Recently shown hidden tabs per worktree that keep their transcript. */
export const CHAT_TRANSCRIPT_HIDDEN_TAB_ALLOWANCE = 4;

/** Delay between a residency-relevant change and the sweep it schedules. */
export const CHAT_TRANSCRIPT_RESIDENCY_SWEEP_DELAY_MS = 500;

/** One chat a view shows. */
export type ChatTranscriptViewRef = ChatInterestChatRef;

/** The chat interest fields residency reads (`lib/chat-interest`). */
export interface ChatTranscriptResidencyInterest {
  readonly focused: readonly ChatInterestChatRef[];
  readonly warm: readonly ChatInterestChatRef[];
}

/** Host ports, so the policy has no store-of-stores or IPC imports. */
export interface ChatTranscriptResidencyHost {
  /** This renderer's chat interest, or `null` before tracking starts. */
  currentInterest(): ChatTranscriptResidencyInterest | null;
  /** Called whenever the chat interest changes. Returns an unsubscribe. */
  subscribeInterest(listener: () => void): () => void;
  /** Wall-clock milliseconds; injectable for tests. */
  now(): number;
}

/** The chat state a residency decision reads. */
export type ChatTranscriptResidencyState = Pick<
  ChatState,
  | 'selectedWorktree'
  | 'worktreeChats'
  | 'chatStateSync'
  | 'pendingQuestions'
  | 'pendingApprovals'
  | 'pendingPlanExits'
>;

function viewKey(ref: ChatTranscriptViewRef): string {
  return `${ref.projectId}/${ref.worktreeId}\u0000${ref.chatId}`;
}

const retainedViews = new Map<string, number>();
const recentChatsByScope = new Map<string, Map<string, number>>();

let currentNow: () => number = () => Date.now();
let activeHost: ChatTranscriptResidencyHost | undefined;
let runningReferences = 0;
let runningGeneration = 0;
let pendingSweepTimer: ReturnType<typeof setTimeout> | null = null;
let applyingEviction = false;
let unsubscribeStore: (() => void) | undefined;
let unsubscribeInterest: (() => void) | undefined;

interface ResidentCandidate {
  chatId: string;
  tabIndex: number;
  lastShownAt: number;
}

function touch(ref: ChatTranscriptViewRef, at = currentNow()): void {
  const scopeKey = chatScopeKey(ref.projectId, ref.worktreeId);
  const scopeRecency =
    recentChatsByScope.get(scopeKey) ?? new Map<string, number>();
  scopeRecency.set(ref.chatId, at);
  recentChatsByScope.set(scopeKey, scopeRecency);
}

function scopeParts(scopeKey: string):
  | {
      projectId: string;
      worktreeId: string;
    }
  | undefined {
  const separator = scopeKey.indexOf('/');
  if (separator < 0) return undefined;
  return {
    projectId: scopeKey.slice(0, separator),
    worktreeId: scopeKey.slice(separator + 1),
  };
}

function staleCatchUpTarget(
  state: ChatTranscriptResidencyState,
  scopeKey: string,
  chatId: string,
): ChatInterestChatRef | undefined {
  const selected = state.selectedWorktree;
  if (
    selected &&
    chatScopeKey(selected.projectId, selected.worktreeId) === scopeKey
  ) {
    return { ...selected, chatId };
  }
  const parts = scopeParts(scopeKey);
  return parts ? { ...parts, chatId } : undefined;
}

function isResident(tab: ChatTab): boolean {
  return tab.kind !== 'file' && tab.messages.length > 0;
}

function visibleChatIds(
  scopeKey: string,
  scope: WorktreeChatState,
  currentInterest: ChatTranscriptResidencyInterest | null,
): Set<string> {
  const visible = new Set<string>();
  if (scope.activeTabId) visible.add(scope.activeTabId);
  for (const ref of [
    ...(currentInterest?.focused ?? []),
    ...(currentInterest?.warm ?? []),
  ]) {
    if (chatScopeKey(ref.projectId, ref.worktreeId) === scopeKey) {
      visible.add(ref.chatId);
    }
  }
  for (const tab of scope.tabs) {
    if ((retainedViews.get(`${scopeKey}\u0000${tab.id}`) ?? 0) > 0)
      visible.add(tab.id);
  }
  return visible;
}

function pruneRecency(worktreeChats: ChatState['worktreeChats']): void {
  Array.from(recentChatsByScope.entries()).forEach(
    ([scopeKey, scopeRecency]) => {
      const scope = worktreeChats[scopeKey];
      if (!scope) {
        recentChatsByScope.delete(scopeKey);
        return;
      }
      const currentIds = new Set(scope.tabs.map((tab) => tab.id));
      Array.from(scopeRecency.keys()).forEach((chatId) => {
        if (!currentIds.has(chatId)) scopeRecency.delete(chatId);
      });
      if (scopeRecency.size === 0) recentChatsByScope.delete(scopeKey);
    },
  );
}

function touchFocusedRefs(host: ChatTranscriptResidencyHost): void {
  const focused = host.currentInterest()?.focused ?? [];
  const at = host.now();
  currentNow = (): number => host.now();
  for (const ref of focused) touch(ref, at);
}

function touchSelectedActiveTab(
  state: ChatTranscriptResidencyState,
  host: ChatTranscriptResidencyHost,
): void {
  const selected = state.selectedWorktree;
  if (!selected) return;
  const scopeKey = chatScopeKey(selected.projectId, selected.worktreeId);
  const activeTabId = state.worktreeChats[scopeKey]?.activeTabId;
  if (!activeTabId) return;
  currentNow = (): number => host.now();
  touch({ ...selected, chatId: activeTabId }, host.now());
}

function clearPendingSweep(): void {
  if (pendingSweepTimer === null) return;
  clearTimeout(pendingSweepTimer);
  pendingSweepTimer = null;
}

function stopResidency(): void {
  clearPendingSweep();
  unsubscribeStore?.();
  unsubscribeInterest?.();
  unsubscribeStore = undefined;
  unsubscribeInterest = undefined;
  activeHost = undefined;
}

function scheduleSweep(): void {
  if (activeHost === undefined || pendingSweepTimer !== null) return;
  pendingSweepTimer = setTimeout(() => {
    pendingSweepTimer = null;
    const host = activeHost;
    if (host !== undefined) sweepChatTranscriptResidency(host);
  }, CHAT_TRANSCRIPT_RESIDENCY_SWEEP_DELAY_MS);
  if (isUnrefableTimeout(pendingSweepTimer)) pendingSweepTimer.unref();
}

/**
 * Mark `ref` as shown by a mounted view until the returned release runs.
 * Reference counted: two views of one chat keep it until both release.
 */
export function retainChatTranscriptView(
  ref: ChatTranscriptViewRef,
): () => void {
  const key = viewKey(ref);
  retainedViews.set(key, (retainedViews.get(key) ?? 0) + 1);
  touch(ref);
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    touch(ref);
    const count = (retainedViews.get(key) ?? 0) - 1;
    if (count > 0) retainedViews.set(key, count);
    else retainedViews.delete(key);
  };
}

/** Whether a mounted view currently retains `ref`. */
export function isChatTranscriptViewRetained(
  ref: ChatTranscriptViewRef,
): boolean {
  return (retainedViews.get(viewKey(ref)) ?? 0) > 0;
}

/**
 * Whether `tab`'s own state, or a pending record for it, forbids evicting its
 * transcript.
 */
export function isChatTranscriptPinnedByState(
  state: ChatTranscriptResidencyState,
  scopeKey: string,
  tab: ChatTab,
): boolean {
  if (
    tab.kind === 'file' ||
    tab.status === 'streaming' ||
    loadedSubagentSummary(tab.messages).live > 0 ||
    tab.claudeTerminal?.turnState === 'running' ||
    tab.pendingTurn !== undefined ||
    (tab.pendingUserMessages?.length ?? 0) > 0 ||
    tab.pendingQueueDispatch !== undefined ||
    (tab.pendingQueueMessages?.length ?? 0) > 0 ||
    tab.queuedMessages.length > 0 ||
    tab.editingQueuedMessageIndex !== undefined ||
    tab.pendingQueuedMessageEditId !== undefined ||
    tab.queuedHookPlaceholder === true ||
    tab.pendingPlanExit !== undefined ||
    hasPendingTrackedPlanReview(tab) ||
    tab.unread === true ||
    tab.pendingInitialCreation === true ||
    tab.provisionalFirstSend !== undefined ||
    tab.sendingLease !== undefined ||
    tab.cancelRequestedByUser === true ||
    tab.forceQueuedMessageCancelPending === true ||
    tab.stoppedTurnResume !== undefined
  ) {
    return true;
  }

  const pendingQuestion = Object.values(state.pendingQuestions).some(
    (question) =>
      question.answeredAt === undefined &&
      question.chatId === tab.id &&
      chatScopeKey(question.projectId, question.worktreeId) === scopeKey,
  );
  if (pendingQuestion) return true;

  const pendingApproval = Object.values(state.pendingApprovals).some(
    (approval) =>
      approval.chatId === tab.id &&
      chatScopeKey(approval.projectId, approval.worktreeId) === scopeKey,
  );
  if (pendingApproval) return true;

  const pendingPlanExit = Object.values(state.pendingPlanExits).some(
    (exit) =>
      exit.chatId === tab.id &&
      chatScopeKey(exit.projectId, exit.worktreeId) === scopeKey,
  );
  if (pendingPlanExit) return true;

  const catchUpTarget = staleCatchUpTarget(state, scopeKey, tab.id);
  return (
    catchUpTarget !== undefined && isStaleChatCatchUpRunning(catchUpTarget)
  );
}

/**
 * What the Subagents picker lists a tab by: its loaded rows, plus, while the
 * tab is unloaded, the summary an eviction kept. The two cover disjoint rows,
 * so counts add and workflow runs union.
 */
/**
 * A chat's own delegate cards' newest runs, with what an eviction of this
 * still-unloaded tab kept (CAN-7133).
 */
export function ownDelegationRunsOf(
  tab: ChatTab,
): Readonly<Record<string, number>> {
  const loaded = chatsOwnLatestRuns(tab.messages);
  const saved =
    tab.transcriptLoaded === false
      ? tab.evictedSubagentRoot?.ownDelegationRuns
      : undefined;
  if (saved === undefined) return loaded;
  const merged: Record<string, number> = { ...saved };
  for (const [id, run] of Object.entries(loaded))
    merged[id] = Math.max(merged[id] ?? 0, run);
  return merged;
}

export function subagentRootSummary(
  tab: ChatTab,
  backgroundStatusFor?: Parameters<typeof loadedSubagentSummary>[1],
): EvictedSubagentRoot {
  const native = loadedSubagentSummary(tab.messages, backgroundStatusFor);
  const launches = hasWorkflowLaunches(tab.messages);
  const locations = launches ? collectWorkflowRunLocations(tab.messages) : [];
  const saved =
    tab.transcriptLoaded === false ? tab.evictedSubagentRoot : undefined;
  if (!saved) {
    return {
      native,
      hasWorkflowLaunches: launches,
      workflowLocations: locations,
    };
  }
  const savedRunIds = new Set(saved.workflowLocations.map((run) => run.runId));
  const times = [saved.native.lastActivityAt, native.lastActivityAt].filter(
    (time): time is number => time !== undefined,
  );
  return {
    native: {
      hasNativeAgentBlocks:
        saved.native.hasNativeAgentBlocks || native.hasNativeAgentBlocks,
      total: saved.native.total + native.total,
      live: saved.native.live + native.live,
      ...(times.length > 0 ? { lastActivityAt: Math.max(...times) } : {}),
    },
    hasWorkflowLaunches: saved.hasWorkflowLaunches || launches,
    workflowLocations: [
      ...saved.workflowLocations,
      ...locations.filter((run) => !savedRunIds.has(run.runId)),
    ],
  };
}

/**
 * The evicted projection of one tab: main's hidden-tab shape. Keeps every
 * other field.
 */
export function evictChatTabTranscript(tab: ChatTab): ChatTab {
  const evicted: ChatTab = {
    ...tab,
    messages: [],
    transcriptLoaded: false,
  };
  delete evicted.transcriptWindow;
  if (tab.transcript !== undefined) {
    evicted.currentTodos = tab.transcript.todos;
    evicted.currentTaskTodos = tab.transcript.taskTodos;
  } else {
    delete evicted.currentTodos;
    delete evicted.currentTaskTodos;
  }
  // Keep what the Subagents picker lists this root by, including what an
  // earlier eviction of this still-unloaded tab kept.
  delete evicted.evictedSubagentRoot;
  const summary = subagentRootSummary(tab);
  const ownDelegationRuns = ownDelegationRunsOf(tab);
  const hasOwnDelegates = Object.keys(ownDelegationRuns).length > 0;
  if (
    summary.native.hasNativeAgentBlocks ||
    summary.hasWorkflowLaunches ||
    hasOwnDelegates
  ) {
    evicted.evictedSubagentRoot = {
      ...summary,
      ...(hasOwnDelegates ? { ownDelegationRuns } : {}),
    };
  }
  return evicted;
}

/**
 * Run one sweep of the selected worktree now. Returns the evicted chat ids.
 */
export function sweepChatTranscriptResidency(
  host?: ChatTranscriptResidencyHost,
): string[] {
  const api = tryChatStoreApi();
  if (!api) return [];
  const state = api.getState();
  pruneRecency(state.worktreeChats);

  const selected = state.selectedWorktree;
  if (!selected || selected.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return [];
  }
  const scopeKey = chatScopeKey(selected.projectId, selected.worktreeId);
  const scope = state.worktreeChats[scopeKey];
  if (
    !scope ||
    state.chatStateSync[scopeKey]?.phase !== 'live' ||
    loadingKeys.has(scopeKey)
  ) {
    return [];
  }

  const effectiveHost = host ?? activeHost;
  const at = effectiveHost?.now() ?? Date.now();
  if (effectiveHost !== undefined)
    currentNow = (): number => effectiveHost.now();
  const currentInterest = effectiveHost?.currentInterest() ?? null;
  const visible = visibleChatIds(scopeKey, scope, currentInterest);
  const scopeRecency =
    recentChatsByScope.get(scopeKey) ?? new Map<string, number>();
  recentChatsByScope.set(scopeKey, scopeRecency);
  for (const tab of scope.tabs) {
    if (visible.has(tab.id)) {
      touch({ ...selected, chatId: tab.id }, at);
    }
  }

  const candidates: ResidentCandidate[] = [];
  scope.tabs.forEach((tab, tabIndex) => {
    if (
      isResident(tab) &&
      !visible.has(tab.id) &&
      !isChatTranscriptPinnedByState(state, scopeKey, tab)
    ) {
      candidates.push({
        chatId: tab.id,
        tabIndex,
        lastShownAt: scopeRecency.get(tab.id) ?? 0,
      });
    }
  });
  candidates.sort(
    (left, right) =>
      right.lastShownAt - left.lastShownAt || right.tabIndex - left.tabIndex,
  );
  const toEvict = new Set(
    candidates
      .slice(CHAT_TRANSCRIPT_HIDDEN_TAB_ALLOWANCE)
      .map((candidate) => candidate.chatId),
  );

  const evictedIds: string[] = [];
  applyingEviction = true;
  try {
    api.setState((currentState) => {
      const currentSelected = currentState.selectedWorktree;
      const currentScope = currentState.worktreeChats[scopeKey];
      if (
        !currentSelected ||
        chatScopeKey(currentSelected.projectId, currentSelected.worktreeId) !==
          scopeKey ||
        currentScope !== scope
      ) {
        return currentState;
      }
      const visibleNow = visibleChatIds(
        scopeKey,
        currentScope,
        effectiveHost?.currentInterest() ?? null,
      );
      const nextTabs = currentScope.tabs.map((tab) => {
        if (
          !toEvict.has(tab.id) ||
          !isResident(tab) ||
          visibleNow.has(tab.id) ||
          isChatTranscriptPinnedByState(currentState, scopeKey, tab)
        ) {
          return tab;
        }
        evictedIds.push(tab.id);
        return evictChatTabTranscript(tab);
      });
      if (evictedIds.length === 0) return currentState;
      return {
        worktreeChats: {
          ...currentState.worktreeChats,
          [scopeKey]: { ...currentScope, tabs: nextTabs },
        },
      };
    });
  } finally {
    applyingEviction = false;
  }

  for (const chatId of evictedIds) scopeRecency.delete(chatId);
  if (scopeRecency.size === 0) recentChatsByScope.delete(scopeKey);
  return evictedIds;
}

/**
 * Start sweeping on residency-relevant changes. Reference counted per host
 * caller; returns a disposer.
 */
export function startChatTranscriptResidency(
  host: ChatTranscriptResidencyHost,
): () => void {
  // A view mounted without the assembled chat store (tests, isolated
  // surfaces) has no transcripts to bound.
  const api = tryChatStoreApi();
  if (!api) return (): void => undefined;
  runningReferences += 1;
  if (runningReferences === 1) {
    runningGeneration += 1;
    const generation = runningGeneration;
    activeHost = host;
    currentNow = (): number => host.now();
    unsubscribeStore = api.subscribe((state, previous) => {
      if (generation !== runningGeneration || applyingEviction) return;
      const selectedWorktreeChanged =
        state.selectedWorktree !== previous.selectedWorktree;
      const selected = state.selectedWorktree;
      const previousSelected = previous.selectedWorktree;
      const selectedScopeKey = selected
        ? chatScopeKey(selected.projectId, selected.worktreeId)
        : undefined;
      const previousSelectedScopeKey = previousSelected
        ? chatScopeKey(previousSelected.projectId, previousSelected.worktreeId)
        : undefined;
      const selectedScope = selectedScopeKey
        ? state.worktreeChats[selectedScopeKey]
        : undefined;
      const previousSelectedScope = previousSelectedScopeKey
        ? previous.worktreeChats[previousSelectedScopeKey]
        : undefined;
      const selectedScopeChanged =
        selectedScopeKey !== previousSelectedScopeKey ||
        selectedScope !== previousSelectedScope;
      const pendingRecordsChanged =
        state.pendingQuestions !== previous.pendingQuestions ||
        state.pendingApprovals !== previous.pendingApprovals ||
        state.pendingPlanExits !== previous.pendingPlanExits;

      if (
        selectedWorktreeChanged ||
        selectedScopeChanged ||
        pendingRecordsChanged
      ) {
        if (
          selectedWorktreeChanged ||
          selectedScope?.activeTabId !== previousSelectedScope?.activeTabId
        ) {
          touchSelectedActiveTab(state, host);
        }
        scheduleSweep();
      }
    });
    unsubscribeInterest = host.subscribeInterest(() => {
      if (generation !== runningGeneration) return;
      touchFocusedRefs(host);
      scheduleSweep();
    });
    scheduleSweep();
  }

  const generation = runningGeneration;
  let disposed = false;
  return (): void => {
    if (disposed) return;
    disposed = true;
    if (generation !== runningGeneration) return;
    runningReferences = Math.max(0, runningReferences - 1);
    if (runningReferences === 0) stopResidency();
  };
}
