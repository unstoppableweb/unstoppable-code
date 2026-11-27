import type {
  ApprovalRequestEvent,
  ChatGetStateRequest,
  ChatInterestDeclaration,
  RemoteControlState,
} from '@canopy/desktop-shared/types';
import { requestChatInterestRedeclare } from '@/lib/chat-interest/redeclare';
import {
  getPairedComputersApi,
  subscribeOneWindowEnabled,
} from '@/stores/oneWindowStore';
import {
  pairedComputerAddress,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import type { ChatBackend } from '../backend';
import { chatScopeKey } from '../revisioned-sync';
import { clearFailedStaleChatCatchUpForScope } from '../stale-catch-up-reset';
import { tryChatStoreApi } from '../store-ref';
import {
  bumpPairedComputerConnectionEpoch,
  clearPairedComputerConnectionState,
  publishPairedComputerConnectionState,
} from './connection-store';
import {
  clearPairedComputerModelCatalog,
  markPairedComputerModelCatalogFailed,
  publishPairedComputerModelCatalog,
} from './model-catalog';
import {
  createPairedComputerChatBackendCore,
  type PairedComputerChatBackendCore,
} from './paired-computer-chat-backend';

let core: PairedComputerChatBackendCore | null = null;
let lifecycleSubscribed = false;

function isRemoteControlRunning(state: RemoteControlState): boolean {
  return (
    state.available &&
    state.signedIn &&
    state.relayStatus !== 'stopped' &&
    state.relayStatus !== 'unavailable'
  );
}

function clearDeviceApprovalDefaultsCache(deviceId?: string): void {
  const api = tryChatStoreApi();
  if (!api) return;
  api.setState((state) => {
    let changed = false;
    const next = { ...state.approvalDefaultsCache };
    for (const key of Object.keys(state.approvalDefaultsCache)) {
      const slash = key.indexOf('/');
      const projectId = slash >= 0 ? key.slice(0, slash) : key;
      const parsed = pairedComputerAddress(projectId);
      if (parsed === null) continue;
      if (deviceId === undefined || parsed.deviceId === deviceId) {
        delete next[key];
        changed = true;
      }
    }
    return changed ? { approvalDefaultsCache: next } : state;
  });
}

function reconcileDevicePendingApprovals(
  deviceId: string,
  incoming: readonly ApprovalRequestEvent[],
): void {
  const api = tryChatStoreApi();
  if (!api) return;
  const incomingById = new Map(
    incoming.map((event) => [event.requestId, event] as const),
  );
  api.setState((state) => {
    const next = { ...state.pendingApprovals };
    let changed = false;
    for (const [requestId, existing] of Object.entries(
      state.pendingApprovals,
    )) {
      const parsed = pairedComputerAddress(existing.projectId);
      if (parsed === null || parsed.deviceId !== deviceId) continue;
      if (!incomingById.has(requestId)) {
        delete next[requestId];
        changed = true;
      }
    }
    for (const [requestId, event] of incomingById) {
      if (next[requestId] !== event) {
        next[requestId] = event;
        changed = true;
      }
    }
    return changed ? { pendingApprovals: next } : state;
  });
}

function handleDeviceReconnectedInStore(
  deviceId: string,
  scopes: readonly ChatGetStateRequest[],
): void {
  clearDeviceApprovalDefaultsCache(deviceId);
  const api = tryChatStoreApi();
  if (!api) return;
  // Mark loaded tabs on this computer stale before refreshing so body-less
  // snapshots trigger paged catch-up without losing or duplicating messages.
  api.setState((state) => {
    let nextWorktreeChats: typeof state.worktreeChats | null = null;
    for (const scope of scopes) {
      const key = chatScopeKey(scope.projectId, scope.worktreeId);
      const wc = state.worktreeChats[key];
      if (!wc) continue;
      let tabsChanged = false;
      const tabs = wc.tabs.map((tab) => {
        if (tab.transcriptLoaded === false || tab.transcriptStale === true) {
          return tab;
        }
        tabsChanged = true;
        return { ...tab, transcriptStale: true as const };
      });
      if (!tabsChanged) continue;
      nextWorktreeChats ??= { ...state.worktreeChats };
      nextWorktreeChats[key] = { ...wc, tabs };
    }
    return nextWorktreeChats ? { worktreeChats: nextWorktreeChats } : state;
  });

  for (const scope of scopes) {
    const parsed = pairedComputerAddress(scope.projectId);
    if (parsed === null || parsed.deviceId !== deviceId) continue;
    api
      .getState()
      .recoverChatScopeAfterReconnect(scope.projectId, scope.worktreeId);
    // Clear prior failed catch-up entries for already-stale tabs so focused
    // chats retry transcript catch-up once the reconnect scope refresh settles.
    clearFailedStaleChatCatchUpForScope(scope.projectId, scope.worktreeId);
  }
}

function rehydrateTrackedPairedScopes(): void {
  const api = tryChatStoreApi();
  if (!api || !core) return;
  const state = api.getState();
  const scopesByDevice = new Map<string, ChatGetStateRequest[]>();
  const allPairedScopes: ChatGetStateRequest[] = [];
  for (const key of Object.keys(state.chatStateSync)) {
    const slash = key.indexOf('/');
    if (slash <= 0) continue;
    const projectId = key.slice(0, slash);
    const worktreeId = key.slice(slash + 1);
    const parsed = pairedComputerAddress(projectId);
    if (parsed === null) continue;
    const scope: ChatGetStateRequest = { projectId, worktreeId };
    allPairedScopes.push(scope);
    const list = scopesByDevice.get(parsed.deviceId) ?? [];
    list.push(scope);
    scopesByDevice.set(parsed.deviceId, list);
  }
  if (allPairedScopes.length === 0) return;
  void core.backend.chat.setStateScopes({
    kind: 'scopes',
    scopes: allPairedScopes,
  });
  requestChatInterestRedeclare();
  for (const [deviceId, scopes] of scopesByDevice) {
    handleDeviceReconnectedInStore(deviceId, scopes);
  }
}

function ensureLifecycleSubscriptions(): void {
  if (lifecycleSubscribed) return;
  lifecycleSubscribed = true;
  subscribeOneWindowEnabled((enabled, previous) => {
    if (previous && !enabled) {
      core?.closeAll();
      return;
    }
    if (!previous && enabled) {
      rehydrateTrackedPairedScopes();
    }
  });
  useRemoteControlStore.subscribe((next, prev) => {
    const nextRunning = isRemoteControlRunning(next.state);
    const prevRunning = isRemoteControlRunning(prev.state);
    const relayConnected =
      nextRunning &&
      next.state.relayStatus === 'connected' &&
      prev.state.relayStatus !== 'connected';
    if ((nextRunning && !prevRunning) || relayConnected) {
      core?.reacquireRemoteControlOffDevices();
    }
  });
}

function getCore(): PairedComputerChatBackendCore {
  if (core !== null) return core;
  ensureLifecycleSubscriptions();
  core = createPairedComputerChatBackendCore({
    getApi: getPairedComputersApi,
    onConnectionState: publishPairedComputerConnectionState,
    onDeviceReconnectEpoch: bumpPairedComputerConnectionEpoch,
    onConnectionCleared: (deviceId) => {
      clearPairedComputerConnectionState(deviceId);
      clearDeviceApprovalDefaultsCache(deviceId);
    },
    onModelCatalog: publishPairedComputerModelCatalog,
    onModelCatalogFailed: markPairedComputerModelCatalogFailed,
    onModelCatalogCleared: clearPairedComputerModelCatalog,
    onDeviceReconnected: handleDeviceReconnectedInStore,
    onPendingApprovalsSnapshot: reconcileDevicePendingApprovals,
    getRevisionedRuntime: ({ chatId }) =>
      tryChatStoreApi()?.getState().runtimeByChatId[chatId],
  });
  return core;
}

/** The singleton paired-computer chat backend for the main renderer window. */
export function pairedComputerChatBackend(): ChatBackend {
  return getCore().backend;
}

/** Declares focused/warm chat interest for paired computers (one-window mode). */
export function declarePairedComputerChatInterest(
  declaration: ChatInterestDeclaration,
): Promise<void> {
  if (getPairedComputersApi() === null) {
    core?.closeAll();
    return Promise.resolve();
  }
  if (
    core === null &&
    declaration.focused.length === 0 &&
    declaration.warm.length === 0
  ) {
    return Promise.resolve();
  }
  return getCore().setInterest(declaration);
}

/** Reads the paired computer's model registry once per hold (no options). */
export function loadPairedComputerModels(projectId: string): Promise<void> {
  const parsed = pairedComputerAddress(projectId);
  if (parsed === null) return Promise.resolve();
  return getCore().loadModelCatalog(parsed.deviceId);
}

/** Releases every paired-computer chat hold and clears cached state. */
export function closePairedComputerChats(): void {
  core?.closeAll();
}
