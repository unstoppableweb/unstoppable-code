import type { ChatTab } from '../types';
import {
  getWorktreeEntry,
  isCurrentWorktreeEntry,
} from '../attention-landing-intent';
// Revisioned chat-state slice (frontend plan).
//
// Binds the pure sync engine (`revisioned-sync.ts`), canonical delta
// application (`canonical-changes.ts`), and the typed command dispatch layer
// (`revisioned-commands.ts`) to the chat store. When the main process
// exposes the revisioned chat service (`chat:get-state` / `chat:command` /
// `chat:state-changed`), scopes hydrated here become read-only projections of
// main-owned canonical state: committed deltas apply in revision order, gaps
// trigger a single snapshot refresh with the approved recovery UX, and
// mutations flow through typed command envelopes with per-command optimistic
// overlays. When the service is unavailable (older main process), callers
// fall back to the legacy hydration path.
import type { StateCreator } from 'zustand';
import { readTryItDraft } from '@/lib/tryItDraftStorage';
import type {
  ChatCommand,
  ChatGetStateRequest,
  ChatStateChangedEvent,
  ChatStateScopesDeclaration,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import { getProviderForModel } from '@canopy/desktop-shared/types';
import { isPlanProposal } from '@canopy/desktop-shared/plan-review';
import { MAX_DECLARED_CHAT_STATE_SCOPES } from '@canopy/desktop-shared/lib/chat-state-cadence';
import { chatStoreApi } from '../store-ref';
import { requestTabDiscovery } from '../discovery';
import { requestDiscoveryForCommittedPluginChanges } from '../committed-plugin-discovery';
import {
  recordStaleChatCatchUpChanges,
  invalidateStaleChatCatchUpScope,
} from '../stale-catch-up';
import {
  RevisionedChatSync,
  chatScopeKey,
  type ChatScopeSyncStatus,
} from '../revisioned-sync';
import {
  OptimisticCommandTracker,
  classifyChatCommandResult,
  createChatCommandEnvelope,
  type ChatCommandDisposition,
} from '../revisioned-commands';
import {
  CHAT_STATE_COMMAND_FAILED_NOTICE,
  CHAT_STATE_CONFLICT_NOTICE,
} from '../revisioned-copy';
import {
  applyCanonicalChanges,
  applyRuntimeStatusesToTabs,
  preserveRendererOnlyTabFields,
  type CanonicalScopeProjection,
} from '../canonical-changes';
import { fromPersistedTabs } from '../persisted-tabs';
import {
  attachHostQueueSummariesFromQueueSnapshots,
  attachHostQueueMirror,
  hostQueueViewsToQueuedMessages,
  preserveHostQueueSummaries,
} from '../queue-mirror';
import { hydratePendingQuestionsFromFile } from '../pending-questions';
import {
  hydratedKeys,
  pendingEagerChatCreation,
  revisionedSetupPendingKeys,
  speculativeHydrationKeys,
  pruneUnreadWorktreeKey,
  recordWorktreeChatTouch,
  scheduleIdleChatUnload,
} from '../hydration';
import {
  resolveBillingSeed,
  resolveDefaultChatInterfaceMode,
  resolveDeferredToolsAllowedDefault,
  resolveTabDefaults,
} from '../defaults';
import { getDefaultPlugins } from '../tab-utils';
import {
  beginTranscriptPerformanceStage,
  markTranscriptPerformanceCommitStart,
  recordTranscriptPerformanceCorrelation,
  recordTranscriptPerformanceCounter,
} from '@/lib/transcript-performance';
import { requestChatInterestRedeclare } from '@/lib/chat-interest/redeclare';
import { sanitizePluginSelectionsWithCachedSupport } from '../plugin-provider-support';
import type { PendingQuestion } from '../types';
import type { ChatRevisionedSlice, ChatState } from '../state';
import { pendingTabCreation } from '../pending-tab-creation';
import {
  isTaskBeingCreated,
  taskCreationSettled,
} from '../web-core/task-creations';
import { isWebCoreScope } from '@/lib/chat-authority';
import { pendingApprovalModeTransitions } from './approvals';
import { useIngestionLagStore } from '@/stores/ingestionLagStore';
import { chatHasLiveDelegates } from '../../delegationActivityStore';
import { chatProviderBlocksClose } from '../../liveBackgroundTaskStore';
import { chatBackendFor, chatBackends, localChatBackend } from '../backend';

// ---------------------------------------------------------------------------
// Module state (engine + tracker singletons, availability detection)
// ---------------------------------------------------------------------------

type RevisionedAvailability = 'unknown' | 'available' | 'unavailable';

let availability: RevisionedAvailability = 'unknown';
let controller: RevisionedChatSync | null = null;
const commandTracker = new OptimisticCommandTracker();
/** Chat id -> whether the queued unread mark is the user's manual mark. */
const pendingUnreadByScope = new Map<string, Map<string, boolean>>();
interface OptimisticActiveTabSelection {
  token: number;
  tabId: string;
  rollbackTabId: string;
  confirmedRevision?: number;
}
const optimisticActiveTabByScope = new Map<
  string,
  OptimisticActiveTabSelection
>();
const canonicalActiveTabByScope = new Map<string, string>();
let optimisticActiveTabToken = 0;
interface OptimisticClosedTab {
  token: number;
  confirmedRevision?: number;
}
const optimisticClosedTabsByScope = new Map<
  string,
  Map<string, OptimisticClosedTab>
>();
let optimisticTabCloseToken = 0;
const initialHydrations = new Map<
  string,
  Promise<'installed' | 'unavailable' | 'failed'>
>();
export function chatHasCloseBlockingWork(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return (
    chatHasLiveDelegates(projectId, worktreeId, chatId) ||
    chatProviderBlocksClose(projectId, worktreeId, chatId)
  );
}

/**
 * Preserve a newer user tab choice while older committed activation events
 * are still crossing the main/renderer boundary. The overlay is scoped and
 * monotonic so rapid B -> C clicks cannot be rolled back by B settling late.
 */
export function beginOptimisticActiveTabSelection(
  projectId: string,
  worktreeId: string,
  tabId: string,
): number {
  const token = ++optimisticActiveTabToken;
  const key = chatScopeKey(projectId, worktreeId);
  const chatState = chatStoreApi().getState().worktreeChats[key];
  const canonicalActiveTabId = canonicalActiveTabByScope.get(key);
  optimisticActiveTabByScope.set(key, {
    token,
    tabId,
    rollbackTabId:
      (canonicalActiveTabId &&
      chatState?.tabs.some((tab) => tab.id === canonicalActiveTabId)
        ? canonicalActiveTabId
        : chatState?.activeTabId) ?? '',
  });
  return token;
}

export function confirmOptimisticActiveTabSelection(
  projectId: string,
  worktreeId: string,
  token: number,
  revision: number,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  const selection = optimisticActiveTabByScope.get(key);
  if (!selection || selection.token !== token) return;
  selection.confirmedRevision = revision;
  const appliedRevision =
    chatStoreApi().getState().chatStateSync[key]?.revision;
  if (appliedRevision !== null && appliedRevision !== undefined) {
    if (appliedRevision >= revision) optimisticActiveTabByScope.delete(key);
  }
}

export function rollbackOptimisticActiveTabSelection(
  projectId: string,
  worktreeId: string,
  token: number,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  const selection = optimisticActiveTabByScope.get(key);
  if (!selection || selection.token !== token) return;
  optimisticActiveTabByScope.delete(key);
  chatStoreApi().setState((state) => {
    const chatState = state.worktreeChats[key];
    const canonicalActiveTabId = canonicalActiveTabByScope.get(key);
    const rollbackTabId =
      canonicalActiveTabId &&
      chatState?.tabs.some((tab) => tab.id === canonicalActiveTabId)
        ? canonicalActiveTabId
        : selection.rollbackTabId;
    if (
      !chatState ||
      chatState.activeTabId !== selection.tabId ||
      !chatState.tabs.some((tab) => tab.id === rollbackTabId)
    ) {
      return {};
    }
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [key]: { ...chatState, activeTabId: rollbackTabId },
      },
    };
  });
}

/** Keep tabs hidden after an optimistic panel close until its commit arrives. */
export function beginOptimisticTabClose(
  projectId: string,
  worktreeId: string,
  tabIds: readonly string[],
): number {
  const token = ++optimisticTabCloseToken;
  const key = chatScopeKey(projectId, worktreeId);
  const tabs =
    optimisticClosedTabsByScope.get(key) ??
    new Map<string, OptimisticClosedTab>();
  for (const tabId of tabIds) tabs.set(tabId, { token });
  optimisticClosedTabsByScope.set(key, tabs);
  return token;
}

export function confirmOptimisticTabClose(
  projectId: string,
  worktreeId: string,
  token: number,
  revision: number,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  const tabs = optimisticClosedTabsByScope.get(key);
  if (!tabs) return;
  const appliedRevision =
    chatStoreApi().getState().chatStateSync[key]?.revision;
  for (const [tabId, close] of Array.from(tabs.entries())) {
    if (close.token !== token) continue;
    if (
      appliedRevision !== null &&
      appliedRevision !== undefined &&
      appliedRevision >= revision
    ) {
      tabs.delete(tabId);
    } else {
      close.confirmedRevision = revision;
    }
  }
  if (tabs.size === 0) optimisticClosedTabsByScope.delete(key);
}

export function rollbackOptimisticTabClose(
  projectId: string,
  worktreeId: string,
  token: number,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  const tabs = optimisticClosedTabsByScope.get(key);
  if (!tabs) return;
  let removed = false;
  for (const [tabId, close] of Array.from(tabs.entries())) {
    if (close.token === token) {
      tabs.delete(tabId);
      removed = true;
    }
  }
  if (tabs.size === 0) optimisticClosedTabsByScope.delete(key);
  if (removed) getController().forceRefresh(projectId, worktreeId);
}

function enqueuePendingUnread(
  projectId: string,
  worktreeId: string,
  chatId: string,
  manual: boolean,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  const pending = pendingUnreadByScope.get(key) ?? new Map<string, boolean>();
  // Last write wins: a later automatic mark replaces a queued manual one.
  pending.set(chatId, manual);
  pendingUnreadByScope.set(key, pending);
}

/** Drops a queued unread mark the user has since replaced with a read. */
export function dropPendingUnread(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  pendingUnreadByScope.get(chatScopeKey(projectId, worktreeId))?.delete(chatId);
}

function flushPendingUnread(projectId: string, worktreeId: string): void {
  const key = chatScopeKey(projectId, worktreeId);
  const pending = pendingUnreadByScope.get(key);
  if (!pending || pending.size === 0) return;
  pendingUnreadByScope.delete(key);
  pending.forEach((manual: boolean, chatId: string) => {
    void persistUnreadWhenScopeLive(
      projectId,
      worktreeId,
      chatId,
      manual ? { manual: true } : undefined,
    );
  });
}

/**
 * Commit focus-derived unread state once the canonical scope is writable.
 * `manual` records the user's own "Mark as unread".
 */
export async function persistUnreadWhenScopeLive(
  projectId: string,
  worktreeId: string,
  chatId: string,
  options?: { manual?: true },
): Promise<void> {
  const key = chatScopeKey(projectId, worktreeId);
  const api = chatStoreApi();
  const manual = options?.manual === true;
  const phase = api.getState().chatStateSync[key]?.phase;
  if (phase === 'refreshing' || phase === 'refresh_error') {
    enqueuePendingUnread(projectId, worktreeId, chatId, manual);
    return;
  }
  const disposition = await api
    .getState()
    .dispatchChatCommand(
      { projectId, worktreeId },
      manual
        ? { type: 'chat.mark_unread', chatId, manual: true }
        : { type: 'chat.mark_unread', chatId },
    );
  const latestPhase = api.getState().chatStateSync[key]?.phase;
  if (
    disposition === 'transport_failed' &&
    (latestPhase === 'refreshing' || latestPhase === 'refresh_error')
  ) {
    enqueuePendingUnread(projectId, worktreeId, chatId, manual);
  } else if (manual && disposition === 'rejected') {
    // A refused manual mark (an older remote-control host rejects the flag)
    // must not leave the optimistic unread on screen.
    refreshChatScopeRevisioned(projectId, worktreeId);
  }
}

/**
 * Synchronous pre-check for hydration call sites: true only when the
 * revisioned chat service might be reachable. Keeps the legacy hydration
 * path free of extra async hops when the preload (or a test double) does not
 * expose `chat.getState` at all.
 */
export function revisionedChatStateSupported(): boolean {
  return (
    availability !== 'unavailable' &&
    typeof localChatBackend().chat.getState === 'function'
  );
}

function isRevisionedUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes('No handler registered')) return true;
  const code: unknown = 'code' in error ? error.code : undefined;
  return code === 'unavailable';
}

function getController(): RevisionedChatSync {
  if (controller) return controller;
  controller = new RevisionedChatSync(
    {
      getState: (request): Promise<ChatStateSnapshot> => {
        const { chat } = chatBackendFor(request);
        if (typeof chat.getState !== 'function') {
          return Promise.reject(
            Object.assign(new Error('Revisioned chat state is unavailable.'), {
              code: 'unavailable',
            }),
          );
        }
        return chat.getState(request);
      },
    },
    {
      installSnapshot: (snapshot, context): void => {
        installSnapshotIntoStore(snapshot, context.reason);
      },
      applyCommittedEvent: (event): void => {
        applyCommittedEventToStore(event);
      },
      onStatusChanged: (projectId, worktreeId, status): void => {
        publishScopeStatus(projectId, worktreeId, status);
      },
      onTrackedScopesChanged: (scopes): void => {
        declareChatStateScopes(scopes);
      },
    },
  );
  // Nothing is tracked yet: events for every scope would be ignored.
  declareChatStateScopes([]);
  return controller;
}

/**
 * Tell main which scopes this window applies `chat:state-changed` for, so it
 * sends no others. The controller is this window's only consumer of that
 * channel; it ignores every other scope (revisioned-sync rule 8). Called
 * synchronously before each snapshot query, so main routes the scope to this
 * window before it reads the snapshot. A rejected declaration leaves main
 * sending every scope. The window's chat interest is declared again on the
 * next frame as well.
 */
function declareChatStateScopes(scopes: ChatGetStateRequest[]): void {
  requestChatInterestRedeclare();
  for (const backend of chatBackends()) {
    const { chat } = backend;
    if (typeof chat.setStateScopes !== 'function') continue;
    const owned = scopes.filter((scope) => chatBackendFor(scope) === backend);
    const declaration: ChatStateScopesDeclaration =
      owned.length > MAX_DECLARED_CHAT_STATE_SCOPES
        ? { kind: 'all' }
        : { kind: 'scopes', scopes: owned };
    void Promise.resolve(chat.setStateScopes(declaration)).catch((): void => {
      // Main fails open (every scope) when it rejects a declaration.
    });
  }
}

// ---------------------------------------------------------------------------
// Store mutation helpers (called from engine host callbacks)
// ---------------------------------------------------------------------------

function bumpedDelegationHints(
  state: ChatState,
  key: string,
): ChatState['delegationStreamHints'] {
  return {
    ...state.delegationStreamHints,
    [key]: {
      epoch: (state.delegationStreamHints[key]?.epoch ?? 0) + 1,
      runs: {},
    },
  };
}

function publishScopeStatus(
  projectId: string,
  worktreeId: string,
  status: ChatScopeSyncStatus | null,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  chatStoreApi().setState((state) => {
    const next = { ...state.chatStateSync };
    if (status === null) delete next[key];
    else next[key] = status;
    const invalidates =
      status === null ||
      (status.phase === 'refreshing' &&
        state.chatStateSync[key]?.phase !== 'refreshing');
    return {
      chatStateSync: next,
      ...(invalidates
        ? { delegationStreamHints: bumpedDelegationHints(state, key) }
        : {}),
    };
  });
  if (status?.phase === 'live') {
    const selection = optimisticActiveTabByScope.get(key);
    if (
      selection?.confirmedRevision !== undefined &&
      status.revision !== null &&
      status.revision >= selection.confirmedRevision
    ) {
      optimisticActiveTabByScope.delete(key);
    }
    const closingTabs = optimisticClosedTabsByScope.get(key);
    if (closingTabs && status.revision !== null) {
      for (const [tabId, close] of Array.from(closingTabs.entries())) {
        if (
          close.confirmedRevision !== undefined &&
          status.revision >= close.confirmedRevision
        ) {
          closingTabs.delete(tabId);
        }
      }
      if (closingTabs.size === 0) optimisticClosedTabsByScope.delete(key);
    }
    flushPendingUnread(projectId, worktreeId);
    const api = chatStoreApi();
    if (
      api.getState().worktreeChats[key]?.tabs.length === 0 &&
      !speculativeHydrationKeys.has(key)
    ) {
      void api.getState().ensureWorktreeHasChatTab({ projectId, worktreeId });
    }
  }
}

function scopePendingQuestions(
  pendingQuestions: Record<string, PendingQuestion>,
  projectId: string,
  worktreeId: string,
): string[] {
  return Object.entries(pendingQuestions)
    .filter(
      ([, pending]) =>
        pending.projectId === projectId && pending.worktreeId === worktreeId,
    )
    .map(([requestId]) => requestId);
}

function commandChatIds(command: ChatCommand): string[] {
  if (command.type === 'chat.create_tab') return [];
  if (command.type === 'chat.close_tabs') {
    return command.targets.map((target) => target.tabId);
  }
  if (command.type === 'chat.reorder_tabs') return command.tabIds;
  if (command.type === 'chat.fork_tab') {
    return [command.sourceTabId, command.targetTabId];
  }
  if (command.type === 'chat.import_session') return [command.targetChatId];
  if (command.type === 'chat.restore_archive') {
    return command.targetTabId ? [command.targetTabId] : [];
  }
  if ('tabId' in command && typeof command.tabId === 'string') {
    return [command.tabId];
  }
  if ('chatId' in command && typeof command.chatId === 'string') {
    return [command.chatId];
  }
  return [];
}

/** Keep the legacy request lookup consistent with the canonical tab projection. */
function reconcilePlanExitRequests(
  current: ChatState,
  projectId: string,
  worktreeId: string,
  tabs: readonly ChatTab[],
): ChatState['pendingPlanExits'] {
  let next = current.pendingPlanExits;
  for (const entry of Object.values(current.pendingPlanExits)) {
    if (entry.projectId !== projectId || entry.worktreeId !== worktreeId)
      continue;
    const tab = tabs.find((candidate) => candidate.id === entry.chatId);
    if (
      tab?.pendingPlanExit &&
      tab.pendingPlanExitRequestId === entry.requestId
    )
      continue;
    if (next === current.pendingPlanExits) next = { ...next };
    delete next[entry.requestId];
  }
  return next;
}

function recoverUntrackedPlanProposals(
  projectId: string,
  worktreeId: string,
): void {
  const state = chatStoreApi().getState();
  for (const tab of state.worktreeChats[chatScopeKey(projectId, worktreeId)]
    ?.tabs ?? []) {
    const input = tab.pendingPlanExit;
    const source = input?.source;
    if (
      tab.pendingPlanExitRequestId &&
      input &&
      (source === 'cursor' || source === 'codex') &&
      isPlanProposal(input)
    ) {
      state.handlePlanExitRequest(
        {
          projectId,
          worktreeId,
          chatId: tab.id,
          requestId: tab.pendingPlanExitRequestId,
          source,
          toolInput: input,
        },
        'recover',
      );
    }
  }
}

/**
 * Install a canonical snapshot as the scope's client projection. On
 * Renderer-only presentation state (composer attachments, local queue rows,
 * live editing state) is preserved per tab whenever a scope already exists.
 * On `refresh`, outstanding optimistic command overlays are also dropped — the
 * snapshot supersedes them.
 */
function installSnapshotIntoStore(
  snapshot: ChatStateSnapshot,
  reason: 'hydrate' | 'refresh',
): void {
  const api = chatStoreApi();
  const { projectId, worktreeId } = snapshot;
  invalidateStaleChatCatchUpScope(projectId, worktreeId);
  const key = chatScopeKey(projectId, worktreeId);
  const state = api.getState();
  canonicalActiveTabByScope.set(key, snapshot.tabsFile.activeTabId);

  const modelDefaults = state.modelDefaults;
  const resolvedDefaults = resolveTabDefaults(projectId, modelDefaults);
  const defaultProviderType = resolvedDefaults.model
    ? getProviderForModel(resolvedDefaults.model)
    : undefined;
  const defaultPluginSelections = sanitizePluginSelectionsWithCachedSupport(
    getDefaultPlugins(projectId, worktreeId, state.worktreeDefaultPlugins),
    defaultProviderType,
  );

  const chatState = fromPersistedTabs(
    snapshot.tabsFile,
    defaultPluginSelections,
    resolvedDefaults.model,
    resolvedDefaults.thinkingLevel,
    resolveDefaultChatInterfaceMode(projectId, modelDefaults),
    resolvedDefaults.modelConfig,
    resolveDeferredToolsAllowedDefault(
      projectId,
      worktreeId,
      state.deferredToolsDefaults,
    ),
    resolveBillingSeed(modelDefaults),
    defaultProviderType,
    false,
  );

  // Canonical runtime state governs streaming controls; the renderer never
  // infers durable lifecycle from provider events or session probes here.
  chatState.tabs = applyRuntimeStatusesToTabs(
    chatState.tabs,
    snapshot.runtimeByChatId,
  );

  const previous = state.worktreeChats[key];
  if (reason === 'refresh') {
    commandTracker.dropScope(projectId, worktreeId);
    optimisticActiveTabByScope.delete(key);
    optimisticClosedTabsByScope.delete(key);
  }
  if (previous) {
    chatState.tabs = chatState.tabs.map((tab) =>
      preserveRendererOnlyTabFields(
        previous.tabs.find((prev) => prev.id === tab.id),
        tab,
      ),
    );
    // Re-derive status from canonical runtime after preserving transient
    // fields (preserve keeps the previous status by default).
    chatState.tabs = applyRuntimeStatusesToTabs(
      chatState.tabs,
      snapshot.runtimeByChatId,
    );
  }

  if (previous) {
    const eagerTabs = previous.tabs.filter(
      (tab) =>
        tab.pendingInitialCreation &&
        !chatState.tabs.some((canonical) => canonical.id === tab.id),
    );
    if (eagerTabs.length) {
      chatState.tabs = [...chatState.tabs, ...eagerTabs];
      chatState.activeTabId = previous.activeTabId;
      chatState.lastActiveEditableChatId = previous.lastActiveEditableChatId;
    }
  }

  // A manual choice made while this initial snapshot was in flight wins.
  const entry = getWorktreeEntry(key);
  if (
    reason === 'hydrate' &&
    entry?.explicitTabId !== undefined &&
    chatState.tabs.some((tab) => tab.id === entry.explicitTabId)
  ) {
    chatState.activeTabId = entry.explicitTabId;
  }

  const queuedByChatId = new Map(
    snapshot.queue.map((entry) => [
      entry.chatId,
      hostQueueViewsToQueuedMessages(entry.queue),
    ]),
  );
  chatState.tabs = attachHostQueueMirror(chatState.tabs, queuedByChatId);
  chatState.tabs = attachHostQueueSummariesFromQueueSnapshots(
    chatState.tabs,
    snapshot.queue,
  );

  const hydratedPendingQuestions = hydratePendingQuestionsFromFile(
    snapshot.tabsFile,
    projectId,
    worktreeId,
    chatState,
  );

  api.setState((current) => {
    let tabDrafts = current.tabDrafts;
    for (const tab of chatState.tabs) {
      if (tab.id in tabDrafts) continue;
      const restored = readTryItDraft(tab.id);
      if (restored) tabDrafts = { ...tabDrafts, [tab.id]: restored.content };
    }
    const pendingQuestions = { ...current.pendingQuestions };
    for (const requestId of scopePendingQuestions(
      pendingQuestions,
      projectId,
      worktreeId,
    )) {
      delete pendingQuestions[requestId];
    }
    Object.assign(pendingQuestions, hydratedPendingQuestions);

    const runtimeByChatId = { ...current.runtimeByChatId };
    for (const tab of current.worktreeChats[key]?.tabs ?? []) {
      delete runtimeByChatId[tab.id];
    }
    Object.assign(runtimeByChatId, snapshot.runtimeByChatId);

    const hasUnreadTab = chatState.tabs.some((tab) => tab.unread === true);
    const unreadWorktreeKeys = hasUnreadTab
      ? current.unreadWorktreeKeys.has(key)
        ? current.unreadWorktreeKeys
        : new Set(Array.from(current.unreadWorktreeKeys).concat(key))
      : pruneUnreadWorktreeKey(current.unreadWorktreeKeys, key, chatState.tabs);

    return {
      tabDrafts,
      delegationStreamHints: bumpedDelegationHints(current, key),
      pendingPlanExits: reconcilePlanExitRequests(
        current,
        projectId,
        worktreeId,
        chatState.tabs,
      ),
      worktreeChats: { ...current.worktreeChats, [key]: chatState },
      archivedChats: {
        ...current.archivedChats,
        [key]: snapshot.archives,
      },
      runtimeByChatId,
      pendingQuestions,
      unreadWorktreeKeys,
      ...(snapshot.recoveryError
        ? {
            chatStateNotices: {
              ...current.chatStateNotices,
              [key]: {
                kind: 'command_failed' as const,
                message: snapshot.recoveryError,
              },
            },
          }
        : {}),
    };
  });
  recoverUntrackedPlanProposals(projectId, worktreeId);
}

function applyCommittedEventToStore(event: ChatStateChangedEvent): void {
  const receiptStartedAt = performance.now();
  const finishReceiptStage = beginTranscriptPerformanceStage('event_receipt', {
    changes: event.changes.length,
  });
  const api = chatStoreApi();
  const stateBeforeEvent = api.getState();
  const { projectId, worktreeId } = event;
  const key = chatScopeKey(projectId, worktreeId);
  const correlationId = `${key}:${event.revision}`;
  recordTranscriptPerformanceCounter('canonical_revision_receipts');
  const commitChatIds = new Set<string>();
  for (const change of event.changes) {
    switch (change.type) {
      case 'delegation.card_state_updated':
      case 'messages.omitted':
      case 'transcript.updated':
      case 'message.upserted':
      case 'message.removed':
      case 'messages.replaced':
      case 'runtime.patched':
      case 'archive.removed':
      case 'archive.read_state_changed':
        commitChatIds.add(change.chatId);
        break;
      case 'tab.upserted':
        commitChatIds.add(change.tab.id);
        break;
      case 'tab.removed':
      case 'tab.metadata_patched':
        commitChatIds.add(change.tabId);
        break;
      case 'tab.active_changed':
        commitChatIds.add(change.activeTabId);
        break;
      case 'pending_question.upserted':
        commitChatIds.add(change.question.chatId);
        break;
      case 'pending_question.removed':
        commitChatIds.add(change.chatId);
        break;
      case 'archive.upserted':
        commitChatIds.add(change.archive.chatId);
        break;
      case 'tab.order_changed':
        break;
    }
  }
  const publicationStartedAt = performance.now();
  const finishPublicationStage = beginTranscriptPerformanceStage(
    'store_publication',
    { changes: event.changes.length },
  );
  commitChatIds.forEach((chatId) => {
    markTranscriptPerformanceCommitStart(chatId, correlationId, {
      changes: event.changes.length,
      revisionReceipts: 1,
    });
  });
  api.setState((current) => {
    const chatState = current.worktreeChats[key];
    if (!chatState) return {};

    const projection: CanonicalScopeProjection = {
      chatState,
      archives: current.archivedChats[key] ?? [],
      runtimeByChatId: current.runtimeByChatId,
      pendingQuestions: current.pendingQuestions,
      delegationStreamHints: current.delegationStreamHints[key],
    };
    let next = applyCanonicalChanges(projection, event.changes, {
      projectId,
      worktreeId,
    });
    if (event.changes.some((change) => change.type === 'tab.upserted')) {
      next = {
        ...next,
        chatState: {
          ...next.chatState,
          tabs: preserveHostQueueSummaries(chatState.tabs, next.chatState.tabs),
        },
      };
    }
    for (const change of event.changes) {
      if (change.type === 'tab.active_changed') {
        canonicalActiveTabByScope.set(key, change.activeTabId);
      }
    }
    recordStaleChatCatchUpChanges(event);
    const optimisticallyClosedTabs = optimisticClosedTabsByScope.get(key);
    if (optimisticallyClosedTabs?.size) {
      const tabs = next.chatState.tabs.filter(
        (tab) => !optimisticallyClosedTabs.has(tab.id),
      );
      if (tabs.length !== next.chatState.tabs.length) {
        const activeTabId = tabs.some(
          (tab) => tab.id === next.chatState.activeTabId,
        )
          ? next.chatState.activeTabId
          : (tabs[0]?.id ?? '');
        next = {
          ...next,
          chatState: { ...next.chatState, tabs, activeTabId },
        };
      }
    }
    const optimisticSelection = optimisticActiveTabByScope.get(key);
    if (
      optimisticSelection &&
      next.chatState.activeTabId !== optimisticSelection.tabId &&
      next.chatState.tabs.some((tab) => tab.id === optimisticSelection.tabId)
    ) {
      next = {
        ...next,
        chatState: {
          ...next.chatState,
          activeTabId: optimisticSelection.tabId,
        },
      };
    }

    const hasUnreadTab = next.chatState.tabs.some((tab) => tab.unread === true);
    const unreadWorktreeKeys = hasUnreadTab
      ? current.unreadWorktreeKeys.has(key)
        ? current.unreadWorktreeKeys
        : new Set(Array.from(current.unreadWorktreeKeys).concat(key))
      : pruneUnreadWorktreeKey(
          current.unreadWorktreeKeys,
          key,
          next.chatState.tabs,
        );

    return {
      pendingPlanExits: reconcilePlanExitRequests(
        current,
        event.projectId,
        event.worktreeId,
        next.chatState.tabs,
      ),
      worktreeChats: { ...current.worktreeChats, [key]: next.chatState },
      // Unchanged archives keep the map's identity, so a selector of the
      // whole map (the Cowork page) does not re-render for every commit. A
      // scope without an entry still gets one, as before.
      archivedChats:
        current.archivedChats[key] === next.archives
          ? current.archivedChats
          : { ...current.archivedChats, [key]: next.archives },
      delegationStreamHints:
        next.delegationStreamHints === current.delegationStreamHints[key]
          ? current.delegationStreamHints
          : {
              ...current.delegationStreamHints,
              [key]: next.delegationStreamHints ?? { epoch: 0, runs: {} },
            },
      runtimeByChatId: next.runtimeByChatId,
      pendingQuestions: next.pendingQuestions,
      unreadWorktreeKeys,
    };
  });
  finishPublicationStage();
  finishReceiptStage();
  recordTranscriptPerformanceCorrelation(
    correlationId,
    'store_publication',
    performance.now() - publicationStartedAt,
    { changes: event.changes.length },
  );
  recordTranscriptPerformanceCorrelation(
    correlationId,
    'event_receipt',
    performance.now() - receiptStartedAt,
    { changes: event.changes.length },
  );
  requestDiscoveryForCommittedPluginChanges(
    event,
    stateBeforeEvent.worktreeChats[key]?.tabs ?? [],
    requestTabDiscovery,
  );
}

// ---------------------------------------------------------------------------
// Slice
// ---------------------------------------------------------------------------

export const createRevisionedSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatRevisionedSlice
> = (set, get) => ({
  delegationStreamHints: {},
  chatStateSync: {},
  runtimeByChatId: {},
  chatStateNotices: {},

  handleChatStateChanged: (event): void => {
    if (availability === 'unavailable') return;
    getController().handleEvent(event);
  },

  hydrateChatScopeRevisioned: async (
    projectId,
    worktreeId,
    options,
  ): Promise<'installed' | 'unavailable' | 'failed'> => {
    if (availability === 'unavailable') return 'unavailable';
    if (typeof chatBackendFor({ projectId }).chat.getState !== 'function') {
      availability = 'unavailable';
      return 'unavailable';
    }
    const sync = getController();
    const key = chatScopeKey(projectId, worktreeId);
    const pendingHydration = initialHydrations.get(key);
    if (pendingHydration) return pendingHydration;
    if (sync.getStatus(projectId, worktreeId)?.phase === 'live') {
      return 'installed';
    }
    if (options?.speculative) speculativeHydrationKeys.add(key);

    // Defaults for empty-scope tabs come from the shared model-defaults
    // machinery; load them before the snapshot installs synchronously.
    try {
      await get().ensureModelDefaultsLoaded();
    } catch {
      // Defaults are a display nicety; canonical state still installs.
    }

    const hydration = (async (): Promise<
      'installed' | 'unavailable' | 'failed'
    > => {
      try {
        const result = await sync.hydrate(projectId, worktreeId);
        if (result === 'failed') return 'failed';
        availability = 'available';
        hydratedKeys.add(key);
        revisionedSetupPendingKeys.add(key);
        recordWorktreeChatTouch(key);
        // A scope hydrated outside a load (prefetch, refresh) still ages out.
        scheduleIdleChatUnload();
        return 'installed';
      } catch (error) {
        if (
          availability !== 'available' &&
          isRevisionedUnavailableError(error)
        ) {
          availability = 'unavailable';
          return 'unavailable';
        }
        // Unrecoverable load error: surface the inline load-error treatment
        // (never a blank starter chat) and let Retry re-issue the hydration.
        set((state) => ({
          chatStateSync: {
            ...state.chatStateSync,
            [key]: {
              phase: 'refresh_error',
              revision: null,
              ...(error instanceof Error && error.message.length > 0
                ? { reason: error.message }
                : {}),
            },
          },
        }));
        return 'failed';
      } finally {
        initialHydrations.delete(key);
      }
    })();
    initialHydrations.set(key, hydration);
    return hydration;
  },

  retryChatStateRefresh: (projectId, worktreeId): void => {
    const sync = getController();
    if (sync.isTracking(projectId, worktreeId)) {
      sync.retry(projectId, worktreeId);
      return;
    }
    // Initial hydration failed; clear the synthetic error status and retry
    // the full hydration.
    const key = chatScopeKey(projectId, worktreeId);
    set((state) => {
      const chatStateSync = { ...state.chatStateSync };
      delete chatStateSync[key];
      return { chatStateSync };
    });
    const entry = getWorktreeEntry(key);
    void get()
      .hydrateChatScopeRevisioned(projectId, worktreeId)
      .then((result) => {
        const selected = get().selectedWorktree;
        if (
          result === 'installed' &&
          isCurrentWorktreeEntry(entry) &&
          selected?.projectId === projectId &&
          selected.worktreeId === worktreeId
        ) {
          return get().loadTabs();
        }
      });
  },

  refreshChatScopeRevisioned: (projectId, worktreeId): void => {
    controller?.forceRefresh(projectId, worktreeId);
  },

  releaseChatScopeRevisioned: (projectId, worktreeId): void => {
    const key = chatScopeKey(projectId, worktreeId);
    const epochBeforeRelease = get().delegationStreamHints[key]?.epoch ?? 0;
    controller?.release(projectId, worktreeId);
    commandTracker.dropScope(projectId, worktreeId);
    useIngestionLagStore.getState().clearForScope(projectId, worktreeId);
    pendingUnreadByScope.delete(key);
    optimisticActiveTabByScope.delete(key);
    canonicalActiveTabByScope.delete(key);
    optimisticClosedTabsByScope.delete(key);
    set((state) => {
      const chatStateSync = { ...state.chatStateSync };
      delete chatStateSync[key];
      const chatStateNotices = { ...state.chatStateNotices };
      delete chatStateNotices[key];
      const runtimeByChatId = { ...state.runtimeByChatId };
      for (const tab of state.worktreeChats[key]?.tabs ?? []) {
        delete runtimeByChatId[tab.id];
      }
      return {
        chatStateSync,
        chatStateNotices,
        runtimeByChatId,
        // release() publishes null for a tracked scope; untracked releases
        // still fence old cache entries without double-bumping tracked ones.
        delegationStreamHints:
          (state.delegationStreamHints[key]?.epoch ?? 0) === epochBeforeRelease
            ? bumpedDelegationHints(state, key)
            : state.delegationStreamHints,
      };
    });
  },

  dismissChatStateNotice: (projectId, worktreeId): void => {
    const key = chatScopeKey(projectId, worktreeId);
    set((state) => {
      if (!(key in state.chatStateNotices)) return {};
      const chatStateNotices = { ...state.chatStateNotices };
      delete chatStateNotices[key];
      return { chatStateNotices };
    });
  },

  dispatchChatCommand: async (
    scope,
    command,
    options,
  ): Promise<ChatCommandDisposition> => {
    if (
      command.type === 'chat.steer_queued_message' ||
      (command.type === 'chat.input_delivery_action' &&
        ['save', 'resend', 'resend-original'].includes(command.action))
    ) {
      await pendingApprovalModeTransitions(
        scope.projectId,
        scope.worktreeId,
        command.chatId,
      );
    }
    const key = chatScopeKey(scope.projectId, scope.worktreeId);
    for (const chatId of commandChatIds(command)) {
      const eagerCreation = pendingEagerChatCreation({ ...scope, chatId });
      if (eagerCreation && !(await eagerCreation)) return 'transport_failed';
    }
    const pendingCreations = commandChatIds(command)
      .map((chatId) =>
        pendingTabCreation(scope.projectId, scope.worktreeId, chatId),
      )
      .filter(
        (creation): creation is Promise<ChatCommandDisposition> =>
          creation !== undefined,
      );
    for (const creation of Array.from(new Set(pendingCreations))) {
      const creationDisposition = await creation;
      if (creationDisposition !== 'accepted') return creationDisposition;
    }
    // A cloud task this window opened before the web core created it takes
    // its changes once it exists and its first read from the web core is
    // live, as its sends do; one whose create failed drops them, and its
    // creation notice says why (CAN-6098).
    if (isWebCoreScope(scope.projectId) && isTaskBeingCreated(scope)) {
      const created = await taskCreationSettled(scope).then(
        () => true,
        () => false,
      );
      if (!created) return 'transport_failed';
      await waitForChatScopeLive(scope.projectId, scope.worktreeId);
    }
    const sync = get().chatStateSync[key];
    if (sync?.phase === 'refreshing' || sync?.phase === 'refresh_error') {
      // Send and destructive actions are disabled while the scope refreshes
      // or shows the load-error treatment; nothing was submitted.
      return 'transport_failed';
    }

    const envelope = createChatCommandEnvelope(scope, command, {
      ...(options?.commandId ? { commandId: options.commandId } : {}),
      ...(options?.expectedRevision !== undefined
        ? { expectedRevision: options.expectedRevision }
        : {}),
    });
    const tracked = Boolean(options?.rollback || options?.reconcile);
    if (tracked) {
      commandTracker.register({
        commandId: envelope.commandId,
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        rollback: options?.rollback ?? ((): void => undefined),
        ...(options?.reconcile ? { reconcile: options.reconcile } : {}),
      });
    }

    const setNotice = (
      kind: 'conflict' | 'command_failed',
      message: string,
    ): void => {
      set((state) => ({
        chatStateNotices: {
          ...state.chatStateNotices,
          [key]: { kind, message },
        },
      }));
    };

    try {
      if (typeof chatBackendFor(envelope).chat.command !== 'function') {
        throw Object.assign(new Error('Chat commands are unavailable.'), {
          code: 'unavailable',
        });
      }
      const result = await chatBackendFor(envelope).chat.command(envelope);
      try {
        options?.onResult?.(result);
      } catch {
        // The command result is already durable; sequencing observers must
        // not reinterpret a committed command as a transport failure.
      }
      const settled = tracked ? commandTracker.settleResult(result) : null;
      const disposition =
        options?.acceptNotFound === true && result.outcome === 'not_found'
          ? 'accepted'
          : (settled?.disposition ?? classifyChatCommandResult(result));
      if (disposition === 'conflict') {
        // Stale destructive command: never auto-retry; refresh the view.
        setNotice('conflict', CHAT_STATE_CONFLICT_NOTICE);
        getController().forceRefresh(scope.projectId, scope.worktreeId);
      } else if (disposition === 'rejected') {
        setNotice('command_failed', CHAT_STATE_COMMAND_FAILED_NOTICE);
      }
      return disposition;
    } catch {
      if (tracked) commandTracker.settleTransportFailure(envelope.commandId);
      setNotice('command_failed', CHAT_STATE_COMMAND_FAILED_NOTICE);
      return 'transport_failed';
    }
  },
});

/**
 * Reconcile an uncertain settings-command outcome using the canonical snapshot.
 */
export function refreshChatScopeRevisioned(
  projectId: string,
  worktreeId: string,
): void {
  const sync = getController();
  if (sync.isTracking(projectId, worktreeId)) {
    sync.forceRefresh(projectId, worktreeId);
  } else {
    void chatStoreApi()
      .getState()
      .hydrateChatScopeRevisioned(projectId, worktreeId);
  }
}

export function isScopeRevisionedLive(
  state: Pick<ChatState, 'chatStateSync'>,
  projectId: string,
  worktreeId: string,
): boolean {
  const sync = state.chatStateSync[chatScopeKey(projectId, worktreeId)];
  return sync !== undefined && sync.phase !== 'hydrating';
}

/**
 * Wait for a scope refresh that is already in progress to return to its live
 * projection. Idempotent metadata commands can use this to retry once instead
 * of being lost in the narrow race between a live pre-check and dispatch.
 */
export function waitForChatScopeLive(
  projectId: string,
  worktreeId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const api = chatStoreApi();
  const key = chatScopeKey(projectId, worktreeId);
  const initialPhase = api.getState().chatStateSync[key]?.phase;
  if (initialPhase === 'live') return Promise.resolve(true);
  if (initialPhase !== 'refreshing') return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = (): void => undefined;
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(live);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = api.subscribe((state) => {
      const phase = state.chatStateSync[key]?.phase;
      if (phase === 'live') finish(true);
      else if (phase !== 'refreshing') finish(false);
    });

    const currentPhase = api.getState().chatStateSync[key]?.phase;
    if (currentPhase === 'live') finish(true);
    else if (currentPhase !== 'refreshing') finish(false);
  });
}

/** True while send/destructive controls must be disabled for the scope. */
export function isChatScopeCommandBlocked(
  state: Pick<ChatState, 'chatStateSync'>,
  projectId: string,
  worktreeId: string,
): boolean {
  const phase = state.chatStateSync[chatScopeKey(projectId, worktreeId)]?.phase;
  return phase === 'refreshing' || phase === 'refresh_error';
}

/** Stable selector factory for one exact run, including empty-snapshot epochs. */
export function selectDelegationStreamHint(
  scopeKey: string,
  chatId: string,
  delegationId: string,
  generation: number,
): (state: ChatState) => { epoch: number; streamRevision: number } | undefined {
  const runKey = `${chatId}:${delegationId}:${generation}`;
  let selected: { epoch: number; streamRevision: number } | undefined;
  return (state) => {
    const scope = state.delegationStreamHints[scopeKey];
    if (!scope) {
      selected = undefined;
      return selected;
    }
    const streamRevision = scope.runs[runKey]?.streamRevision ?? 0;
    if (
      selected?.epoch !== scope.epoch ||
      selected.streamRevision !== streamRevision
    ) {
      selected = { epoch: scope.epoch, streamRevision };
    }
    return selected;
  };
}
