import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type {
  ApprovalAutoResolvedEvent,
  ApprovalMode,
  ApprovalRequestEvent,
  ApprovalResolvedDefaultRequest,
  ChatActiveSessions,
  ChatCancelResult,
  ChatCommandEnvelope,
  ChatCommandResult,
  ChatEvent,
  ChatGetStateRequest,
  ChatInterestDeclaration,
  ChatLoadTabsRequest,
  ChatQueueUpdatedEvent,
  ChatRuntimeState,
  ChatRuntimeStatus,
  ChatSendMessageRequest,
  ChatSendMessageResult,
  ChatStateChangedEvent,
  ChatStateScopesDeclaration,
  ChatStateSnapshot,
  ChatTabsFile,
  ChatTranscriptPageRequest,
  ModelRegistrySnapshot,
  PairedComputerState,
  PairedComputerUpdate,
  PairedComputersApi,
} from '@canopy/desktop-shared/types';
import {
  isCapabilityUnavailable,
  type ChatBackend,
  type ChatBackendApprovalsApi,
  type ChatBackendCancelRequest,
  type ChatBackendCancelResult,
  type ChatBackendChatApi,
  type ChatBackendScope,
  type ChatBackendSecretRequestApi,
} from '../backend';

type TranscriptPage = Awaited<
  ReturnType<ChatBackendChatApi['getTranscriptPage']>
>;
import {
  buildOneWindowCancelRequest,
  buildOneWindowSendCommandEnvelope,
  buildPairedTranscriptPageRequest,
  pairedComputerUnavailable,
  parsePairedDeviceProject,
  parsePairedDeviceScope,
  parsePairedDeviceTarget,
  qualifyActiveSessions,
  qualifyApprovalAutoResolvedEvent,
  qualifyApprovalCancelledEvent,
  qualifyApprovalRequestEvent,
  qualifyChatEvent,
  qualifyChatStateChangedEvent,
  qualifyChatStateSnapshot,
  qualifyPairedId,
  qualifyQueueUpdatedEvent,
  qualifyTabsFile,
  sanitizePairedTranscriptPage,
  translateSendCommandResult,
} from './translate';

export interface PairedComputerChatBackendOptions {
  readonly getApi: () => PairedComputersApi | null;
  readonly onConnectionState?: (
    deviceId: string,
    state: PairedComputerState,
  ) => void;
  readonly onDeviceReconnectEpoch?: (deviceId: string) => void;
  readonly onConnectionCleared?: (deviceId?: string) => void;
  readonly onModelCatalog?: (
    deviceId: string,
    snapshot: ModelRegistrySnapshot,
  ) => void;
  readonly onModelCatalogFailed?: (deviceId: string) => void;
  readonly onModelCatalogCleared?: (deviceId?: string) => void;
  readonly onDeviceReconnected?: (
    deviceId: string,
    scopes: readonly ChatGetStateRequest[],
  ) => void;
  readonly onPendingApprovalsSnapshot?: (
    deviceId: string,
    approvals: readonly ApprovalRequestEvent[],
  ) => void;
  readonly getRevisionedRuntime?: (target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  }) => ChatRuntimeState | undefined;
}

export interface PairedComputerChatBackendCore {
  readonly backend: ChatBackend;
  readonly setInterest: (declaration: ChatInterestDeclaration) => Promise<void>;
  readonly loadModelCatalog: (deviceId: string) => Promise<void>;
  readonly reacquireRemoteControlOffDevices: () => void;
  readonly closeAll: () => void;
}

interface HeldDevice {
  readonly deviceId: string;
  readonly api: PairedComputersApi;
  readonly unsubscribeStateChanged: () => void;
  readonly unsubscribeUpdate: () => void;
  holdId: string | null;
  state: PairedComputerState | null;
  everConnected: boolean;
  wasDisconnected: boolean;
  disposed: boolean;
  activeCalls: number;
  holdPromise: Promise<PairedComputerState>;
  declaredScopes: ChatGetStateRequest[];
  declaredInterest: ChatInterestDeclaration | null;
  modelCatalogLoaded: boolean;
  modelCatalogPromise: Promise<void> | null;
  reconnectInFlight: boolean;
  reconnectQueued: boolean;
  approvalSyncSeq: number;
  readonly activeApprovalSyncs: Map<number, ApprovalDelta[]>;
}

type ApprovalDelta =
  | { readonly kind: 'request'; readonly event: ApprovalRequestEvent }
  | { readonly kind: 'remove'; readonly requestId: string };

const refuse = (member: string) => (): Promise<never> =>
  Promise.reject(pairedComputerUnavailable(member));

const noSubscription = (): (() => void) => () => undefined;

const ACTIVE_TURN_STATUSES: ReadonlySet<ChatRuntimeStatus> = new Set([
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function localScopeKey(scope: {
  readonly projectId: string;
  readonly worktreeId: string;
}): string {
  return `${scope.projectId}\u0000${scope.worktreeId}`;
}

function hasCapability(
  state: PairedComputerState | null,
  capability: string,
): boolean {
  return (
    state?.status === 'connected' && state.capabilities.includes(capability)
  );
}

function sameDeclaredScopes(
  a: readonly ChatGetStateRequest[],
  b: readonly ChatGetStateRequest[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i]?.projectId !== b[i]?.projectId ||
      a[i]?.worktreeId !== b[i]?.worktreeId
    ) {
      return false;
    }
  }
  return true;
}

function isChatStateChangedPayload(
  value: unknown,
): value is ChatStateChangedEvent {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.eventId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.revision === 'number' &&
    Array.isArray(value.changes)
  );
}

function isChatEventPayload(value: unknown): value is ChatEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string'
  );
}

function isChatQueueUpdatedPayload(
  value: unknown,
): value is ChatQueueUpdatedEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    Array.isArray(value.queue)
  );
}

function isApprovalRequestPayload(
  value: unknown,
): value is ApprovalRequestEvent {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    isRecord(value.details) &&
    typeof value.details.kind === 'string'
  );
}

function isApprovalCancelledPayload(
  value: unknown,
): value is { requestId: string } {
  return isRecord(value) && typeof value.requestId === 'string';
}

function isApprovalAutoResolvedPayload(
  value: unknown,
): value is ApprovalAutoResolvedEvent {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string'
  );
}

function isChatStateSnapshotPayload(
  value: unknown,
): value is ChatStateSnapshot {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.revision === 'number' &&
    isRecord(value.tabsFile) &&
    isRecord(value.runtimeByChatId) &&
    Array.isArray(value.queue)
  );
}

function isChatTabsFilePayload(value: unknown): value is ChatTabsFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.tabs) &&
    typeof value.activeTabId === 'string'
  );
}

function isChatActiveSessionsPayload(
  value: unknown,
): value is ChatActiveSessions {
  return isRecord(value) && Array.isArray(value.activeChatIds);
}

function isTranscriptPagePayload(value: unknown): value is TranscriptPage {
  return (
    isRecord(value) &&
    Array.isArray(value.messages) &&
    typeof value.transcriptRevision === 'number'
  );
}

function isChatCommandResultPayload(
  value: unknown,
): value is ChatCommandResult {
  return (
    isRecord(value) &&
    typeof value.commandId === 'string' &&
    typeof value.revision === 'number' &&
    typeof value.outcome === 'string'
  );
}

function isChatCancelResultPayload(value: unknown): value is ChatCancelResult {
  return isRecord(value);
}

function isModelRegistrySnapshotPayload(
  value: unknown,
): value is ModelRegistrySnapshot {
  return (
    isRecord(value) &&
    Array.isArray(value.claude) &&
    Array.isArray(value.codex) &&
    Array.isArray(value.ollama)
  );
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === 'ask' || value === 'auto' || value === 'full-access';
}

function hasAnyInterest(declaration: ChatInterestDeclaration | null): boolean {
  if (declaration === null) return false;
  return (
    declaration.focused.length > 0 ||
    declaration.warm.length > 0 ||
    (declaration.focusedRuns?.length ?? 0) > 0
  );
}

function invokeDevice<T>(
  api: PairedComputersApi,
  deviceId: string,
  channel: string,
  args: unknown[],
  guard: (value: unknown) => value is T,
): Promise<T> {
  return api.invoke(deviceId, channel, args).then((result) => {
    if (!guard(result)) {
      throw new Error(
        `Unexpected response from paired computer on ${channel}.`,
      );
    }
    return result;
  });
}

/**
 * Paired-computer chat backend for the one-window desktop shell (CAN-7767).
 *
 * Talks exclusively through `window.api.pairedComputers` and the reviewed
 * `ONE_WINDOW_CAPABILITY_CHANNELS` allowlist. Every outgoing address is
 * stripped to the paired computer's local ID; every incoming payload is
 * qualified with `computer-<deviceId>:`. Unsupported members refuse with
 * `capability_unavailable`.
 */
export function createPairedComputerChatBackendCore(
  options: PairedComputerChatBackendOptions,
): PairedComputerChatBackendCore {
  const heldDevices = new Map<string, HeldDevice>();
  const declaredScopesByDevice = new Map<string, ChatGetStateRequest[]>();
  const declaredInterestByDevice = new Map<string, ChatInterestDeclaration>();
  const everHeldDevices = new Set<string>();
  const remoteControlOffDevices = new Set<string>();
  const endedDevices = new Set<string>();
  const canonicalActiveTurnByChat = new Map<string, string>();
  const optimisticActiveTurnByChat = new Map<string, string>();
  const scopeRevisionByKey = new Map<string, number>();

  const stateChangedListeners = new Set<
    (event: ChatStateChangedEvent) => void
  >();
  const chatEventListeners = new Set<(event: ChatEvent) => void>();
  const queueUpdatedListeners = new Set<
    (event: ChatQueueUpdatedEvent) => void
  >();
  const approvalRequestListeners = new Set<
    (event: ApprovalRequestEvent) => void
  >();
  const approvalCancelledListeners = new Set<
    (event: { requestId: string }) => void
  >();
  const approvalAutoResolvedListeners = new Set<
    (event: ApprovalAutoResolvedEvent) => void
  >();

  function requireApi(): PairedComputersApi {
    const api = options.getApi();
    if (api === null) {
      throw pairedComputerUnavailable('Paired computer chats');
    }
    return api;
  }

  function recordRuntimeActiveTurn(
    qualifiedChatId: string,
    runtime: ChatRuntimeState | undefined,
  ): void {
    // Once canonical runtime arrives for this chat, any optimistic send ID is superseded.
    if (runtime !== undefined) {
      optimisticActiveTurnByChat.delete(qualifiedChatId);
    }
    const userMessageId = runtime?.activeTurn?.userMessageId;
    if (
      runtime !== undefined &&
      ACTIVE_TURN_STATUSES.has(runtime.status) &&
      typeof userMessageId === 'string' &&
      userMessageId.length > 0
    ) {
      canonicalActiveTurnByChat.set(qualifiedChatId, userMessageId);
      return;
    }
    if (runtime !== undefined && !ACTIVE_TURN_STATUSES.has(runtime.status)) {
      canonicalActiveTurnByChat.delete(qualifiedChatId);
    }
  }

  function recordSnapshotRuntime(snapshot: ChatStateSnapshot): void {
    const key = `${snapshot.projectId}/${snapshot.worktreeId}`;
    const previousRevision = scopeRevisionByKey.get(key) ?? -1;
    // Never let an older snapshot overwrite runtime state from a newer commit.
    if (snapshot.revision < previousRevision) return;
    scopeRevisionByKey.set(key, snapshot.revision);
    for (const tab of snapshot.tabsFile.tabs) {
      recordRuntimeActiveTurn(tab.id, snapshot.runtimeByChatId[tab.id]);
    }
    for (const [chatId, runtime] of Object.entries(snapshot.runtimeByChatId)) {
      recordRuntimeActiveTurn(chatId, runtime);
    }
  }

  function isScopeDeclaredOnDevice(
    device: HeldDevice,
    localProjectId: string,
    localWorktreeId: string,
  ): boolean {
    return device.declaredScopes.some(
      (scope) =>
        scope.projectId === localProjectId &&
        scope.worktreeId === localWorktreeId,
    );
  }

  function qualifiedScopesForDevice(device: HeldDevice): ChatGetStateRequest[] {
    return device.declaredScopes.map((scope) => ({
      projectId: qualifyPairedId(device.deviceId, scope.projectId),
      worktreeId: qualifyPairedId(device.deviceId, scope.worktreeId),
    }));
  }

  async function fetchFencedPendingApprovals(
    device: HeldDevice,
  ): Promise<ApprovalRequestEvent[] | null> {
    if (
      device.disposed ||
      !hasCapability(device.state, 'approvals') ||
      device.declaredScopes.length === 0
    ) {
      return null;
    }
    // Fence live approval events while the snapshot read is in flight so an
    // older snapshot never hides a newer request or resurrects a settled one.
    const seq = ++device.approvalSyncSeq;
    const buffered: ApprovalDelta[] = [];
    device.activeApprovalSyncs.set(seq, buffered);
    try {
      const raw = await device.api.invoke(
        device.deviceId,
        'approval:pending-requests',
        [],
      );
      if (
        device.disposed ||
        device.approvalSyncSeq !== seq ||
        !Array.isArray(raw)
      ) {
        return null;
      }
      const allowedScopes = new Set(
        device.declaredScopes.map((scope) => localScopeKey(scope)),
      );
      const merged = new Map<string, ApprovalRequestEvent>();
      for (const item of raw) {
        if (!isApprovalRequestPayload(item)) continue;
        if (!allowedScopes.has(localScopeKey(item))) continue;
        try {
          const qualified = qualifyApprovalRequestEvent(device.deviceId, item);
          merged.set(qualified.requestId, qualified);
        } catch (error: unknown) {
          reportClientAppError(error);
        }
      }
      for (const delta of buffered) {
        if (delta.kind === 'request') {
          merged.set(delta.event.requestId, delta.event);
        } else {
          merged.delete(delta.requestId);
        }
      }
      const approvals = Array.from(merged.values());
      // Commit inside the open fence before releasing it so no cancellation
      // arriving on a subsequent tick can be overwritten by this snapshot.
      options.onPendingApprovalsSnapshot?.(device.deviceId, approvals);
      return approvals;
    } finally {
      device.activeApprovalSyncs.delete(seq);
    }
  }

  function syncPendingApprovalsForDevice(device: HeldDevice): Promise<void> {
    return fetchFencedPendingApprovals(device)
      .then(() => undefined)
      .catch((error: unknown) => {
        reportClientAppError(error);
      });
  }

  function loadModelCatalogForDevice(device: HeldDevice): Promise<void> {
    if (device.disposed || device.modelCatalogLoaded) {
      return Promise.resolve();
    }
    if (device.modelCatalogPromise !== null) {
      return device.modelCatalogPromise;
    }
    if (
      device.state !== null &&
      device.state.status === 'connected' &&
      !device.state.capabilities.includes('composer')
    ) {
      return Promise.resolve();
    }
    const read = invokeDevice(
      device.api,
      device.deviceId,
      'model-registry:get',
      [],
      isModelRegistrySnapshotPayload,
    )
      .then((snapshot) => {
        if (device.disposed) return;
        device.modelCatalogLoaded = true;
        options.onModelCatalog?.(device.deviceId, snapshot);
      })
      .catch((error: unknown) => {
        reportClientAppError(error);
        if (device.disposed) return;
        options.onModelCatalogFailed?.(device.deviceId);
      })
      .finally(() => {
        if (device.modelCatalogPromise === read) {
          device.modelCatalogPromise = null;
        }
      });
    device.modelCatalogPromise = read;
    return read;
  }

  function sendDeclaredScopesToDevice(device: HeldDevice): Promise<void> {
    if (device.disposed || device.state?.status !== 'connected') {
      return Promise.resolve();
    }
    const declaration: ChatStateScopesDeclaration = {
      kind: 'scopes',
      scopes: device.declaredScopes,
    };
    return device.api
      .invoke(device.deviceId, 'chat:set-state-scopes', [declaration])
      .then(() => undefined)
      .catch((error: unknown) => {
        reportClientAppError(error);
      });
  }

  function sendDeclaredInterestToDevice(device: HeldDevice): Promise<void> {
    if (
      device.disposed ||
      device.state?.status !== 'connected' ||
      device.declaredInterest === null
    ) {
      return Promise.resolve();
    }
    return device.api
      .invoke(device.deviceId, 'chat:set-interest', [device.declaredInterest])
      .then(() => undefined)
      .catch((error: unknown) => {
        reportClientAppError(error);
      });
  }

  function runReconnectRecovery(device: HeldDevice): void {
    if (device.disposed) return;
    if (device.reconnectInFlight) {
      device.reconnectQueued = true;
      return;
    }
    device.reconnectInFlight = true;
    device.wasDisconnected = false;
    void (async (): Promise<void> => {
      try {
        await sendDeclaredScopesToDevice(device);
        await sendDeclaredInterestToDevice(device);
        if (device.disposed) return;
        const scopes = qualifiedScopesForDevice(device);
        if (scopes.length > 0) {
          options.onDeviceReconnected?.(device.deviceId, scopes);
        }
        await syncPendingApprovalsForDevice(device);
        if (!device.modelCatalogLoaded) {
          await loadModelCatalogForDevice(device);
        }
      } finally {
        device.reconnectInFlight = false;
        if (device.reconnectQueued && !device.disposed) {
          device.reconnectQueued = false;
          runReconnectRecovery(device);
        }
      }
    })();
  }

  function handleStateChanged(
    deviceId: string,
    state: PairedComputerState,
  ): void {
    const device = heldDevices.get(deviceId);
    if (!device || device.disposed) return;
    const previousStatus = device.state?.status;
    device.state = state;
    options.onConnectionState?.(deviceId, state);

    if (state.status === 'connected') {
      remoteControlOffDevices.delete(deviceId);
      endedDevices.delete(deviceId);
      const reconnecting =
        device.everConnected &&
        (device.wasDisconnected || previousStatus !== 'connected');
      device.everConnected = true;
      if (reconnecting) {
        runReconnectRecovery(device);
      } else {
        void sendDeclaredScopesToDevice(device);
        void sendDeclaredInterestToDevice(device);
        void syncPendingApprovalsForDevice(device);
        void loadModelCatalogForDevice(device);
      }
      return;
    }

    if (device.everConnected) {
      device.wasDisconnected = true;
    }
    if (
      state.status === 'unavailable' &&
      (state.reason === 'not-paired' ||
        state.reason === 'ended' ||
        state.reason === 'remote-control-off' ||
        state.reason === 'one-window-off')
    ) {
      if (state.reason === 'remote-control-off') {
        remoteControlOffDevices.add(deviceId);
        endedDevices.delete(deviceId);
      } else if (state.reason === 'ended') {
        endedDevices.add(deviceId);
        remoteControlOffDevices.delete(deviceId);
      } else {
        remoteControlOffDevices.delete(deviceId);
        endedDevices.delete(deviceId);
      }
      releaseDeviceHold(deviceId, { keepConnectionState: true });
    }
  }

  function handleUpdate(deviceId: string, update: PairedComputerUpdate): void {
    const device = heldDevices.get(deviceId);
    if (!device || device.disposed) return;

    if (update.type === 'reconnected') {
      device.everConnected = true;
      options.onDeviceReconnectEpoch?.(deviceId);
      runReconnectRecovery(device);
      return;
    }

    const payload = update.args[0];
    try {
      switch (update.channel) {
        case 'chat:state-changed': {
          if (!isChatStateChangedPayload(payload)) return;
          if (
            !isScopeDeclaredOnDevice(
              device,
              payload.projectId,
              payload.worktreeId,
            )
          ) {
            return;
          }
          const qualified = qualifyChatStateChangedEvent(deviceId, payload);
          const scopeKey = `${qualified.projectId}/${qualified.worktreeId}`;
          const previousRevision = scopeRevisionByKey.get(scopeKey) ?? -1;
          if (qualified.revision >= previousRevision) {
            scopeRevisionByKey.set(scopeKey, qualified.revision);
            for (const change of qualified.changes) {
              if (change.type === 'runtime.patched') {
                recordRuntimeActiveTurn(change.chatId, change.runtime);
              } else if (change.type === 'tab.removed') {
                canonicalActiveTurnByChat.delete(change.tabId);
                optimisticActiveTurnByChat.delete(change.tabId);
              }
            }
          }
          for (const listener of stateChangedListeners) listener(qualified);
          return;
        }
        case 'chat:event': {
          if (!isChatEventPayload(payload)) return;
          if (
            !isScopeDeclaredOnDevice(
              device,
              payload.projectId,
              payload.worktreeId,
            )
          ) {
            return;
          }
          const qualified = qualifyChatEvent(deviceId, payload);
          for (const listener of chatEventListeners) listener(qualified);
          return;
        }
        case 'chat:queue-updated': {
          if (!isChatQueueUpdatedPayload(payload)) return;
          if (
            !isScopeDeclaredOnDevice(
              device,
              payload.projectId,
              payload.worktreeId,
            )
          ) {
            return;
          }
          const qualified = qualifyQueueUpdatedEvent(deviceId, payload);
          for (const listener of queueUpdatedListeners) listener(qualified);
          return;
        }
        case 'approval:request': {
          if (!isApprovalRequestPayload(payload)) return;
          if (
            !isScopeDeclaredOnDevice(
              device,
              payload.projectId,
              payload.worktreeId,
            )
          ) {
            return;
          }
          const qualified = qualifyApprovalRequestEvent(deviceId, payload);
          for (const queue of device.activeApprovalSyncs.values()) {
            queue.push({ kind: 'request', event: qualified });
          }
          for (const listener of approvalRequestListeners) listener(qualified);
          return;
        }
        case 'approval:cancelled': {
          if (!isApprovalCancelledPayload(payload)) return;
          const qualified = qualifyApprovalCancelledEvent(deviceId, payload);
          for (const queue of device.activeApprovalSyncs.values()) {
            queue.push({ kind: 'remove', requestId: qualified.requestId });
          }
          for (const listener of approvalCancelledListeners)
            listener(qualified);
          return;
        }
        case 'approval:auto-resolved': {
          if (!isApprovalAutoResolvedPayload(payload)) return;
          if (
            !isScopeDeclaredOnDevice(
              device,
              payload.projectId,
              payload.worktreeId,
            )
          ) {
            return;
          }
          const qualified = qualifyApprovalAutoResolvedEvent(deviceId, payload);
          for (const queue of device.activeApprovalSyncs.values()) {
            queue.push({ kind: 'remove', requestId: qualified.requestId });
          }
          for (const listener of approvalAutoResolvedListeners) {
            listener(qualified);
          }
          return;
        }
      }
    } catch (error: unknown) {
      // Drop spoofed or malformed payloads (e.g. already-qualified cross-device IDs).
      reportClientAppError(error);
    }
  }

  function releaseDeviceHold(
    deviceId: string,
    opts: { readonly keepConnectionState?: boolean } = {},
  ): void {
    const device = heldDevices.get(deviceId);
    if (!device) return;
    heldDevices.delete(deviceId);
    device.disposed = true;
    device.unsubscribeStateChanged();
    device.unsubscribeUpdate();
    if (device.holdId !== null) {
      const holdId = device.holdId;
      device.holdId = null;
      void device.api.release(holdId).catch((error: unknown) => {
        reportClientAppError(error);
      });
    }
    if (!opts.keepConnectionState) {
      options.onConnectionCleared?.(deviceId);
    }
    options.onModelCatalogCleared?.(deviceId);
  }

  function maybeReleaseIdleDevice(device: HeldDevice): void {
    if (
      device.disposed ||
      device.activeCalls > 0 ||
      device.declaredScopes.length > 0 ||
      hasAnyInterest(device.declaredInterest)
    ) {
      return;
    }
    releaseDeviceHold(device.deviceId);
  }

  function ensureHeld(deviceId: string): HeldDevice {
    const api = requireApi();
    const existing = heldDevices.get(deviceId);
    if (existing && !existing.disposed && existing.api === api) {
      return existing;
    }
    if (existing) {
      releaseDeviceHold(deviceId);
    }

    // Subscribe BEFORE holding so no state change or push is missed.
    const unsubscribeStateChanged = api.onStateChanged(deviceId, (state) => {
      handleStateChanged(deviceId, state);
    });
    const unsubscribeUpdate = api.onUpdate(deviceId, (update) => {
      handleUpdate(deviceId, update);
    });

    let resolveInitial!: (state: PairedComputerState) => void;
    let rejectInitial!: (error: unknown) => void;
    const holdPromise = new Promise<PairedComputerState>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    void holdPromise.catch((error: unknown) => {
      reportClientAppError(error);
    });

    const persistedScopes = declaredScopesByDevice.get(deviceId) ?? [];
    const persistedInterest = declaredInterestByDevice.get(deviceId) ?? null;
    const reholding = everHeldDevices.has(deviceId);
    everHeldDevices.add(deviceId);

    const device: HeldDevice = {
      deviceId,
      api,
      unsubscribeStateChanged,
      unsubscribeUpdate,
      holdId: null,
      state: null,
      everConnected: reholding,
      wasDisconnected: reholding,
      disposed: false,
      activeCalls: 0,
      holdPromise,
      declaredScopes: [...persistedScopes],
      declaredInterest: persistedInterest,
      modelCatalogLoaded: false,
      modelCatalogPromise: null,
      reconnectInFlight: false,
      reconnectQueued: false,
      approvalSyncSeq: 0,
      activeApprovalSyncs: new Map(),
    };
    heldDevices.set(deviceId, device);

    api
      .hold(deviceId)
      .then((result) => {
        if (device.disposed) {
          void api.release(result.holdId).catch((error: unknown) => {
            reportClientAppError(error);
          });
          resolveInitial(result.state);
          return;
        }
        device.holdId = result.holdId;
        if (device.state === null) {
          handleStateChanged(deviceId, result.state);
        }
        resolveInitial(device.state ?? result.state);
      })
      .catch((error: unknown) => {
        reportClientAppError(error);
        if (heldDevices.get(deviceId) === device) {
          heldDevices.delete(deviceId);
          device.disposed = true;
          device.unsubscribeStateChanged();
          device.unsubscribeUpdate();
        }
        rejectInitial(error);
      });

    return device;
  }

  async function withHeldDevice<T>(
    deviceId: string,
    requiredCapability: string,
    action: (device: HeldDevice) => Promise<T>,
  ): Promise<T> {
    endedDevices.delete(deviceId);
    const device = ensureHeld(deviceId);
    device.activeCalls += 1;
    try {
      const state = await device.holdPromise;
      if (device.disposed) {
        throw pairedComputerUnavailable('Paired computer chats');
      }
      const effectiveState = device.state ?? state;
      if (
        effectiveState.status === 'connected' &&
        !effectiveState.capabilities.includes(requiredCapability)
      ) {
        throw pairedComputerUnavailable(
          `Paired computer ${requiredCapability}`,
        );
      }
      return await action(device);
    } finally {
      device.activeCalls -= 1;
      maybeReleaseIdleDevice(device);
    }
  }

  function addListener<T>(set: Set<T>, cb: T): () => void {
    set.add(cb);
    return (): void => {
      set.delete(cb);
    };
  }

  const chat: ChatBackendChatApi = {
    getState: async (req: ChatGetStateRequest): Promise<ChatStateSnapshot> => {
      const scope = parsePairedDeviceScope(req);
      return withHeldDevice(scope.deviceId, 'chats', async (device) => {
        const raw = await invokeDevice(
          device.api,
          scope.deviceId,
          'chat:get-state',
          [{ projectId: scope.projectId, worktreeId: scope.worktreeId }],
          isChatStateSnapshotPayload,
        );
        if (
          raw.projectId !== scope.projectId ||
          raw.worktreeId !== scope.worktreeId
        ) {
          throw new Error(
            'Paired computer returned chat state for an unexpected scope.',
          );
        }
        const snapshot = qualifyChatStateSnapshot(scope.deviceId, raw);
        recordSnapshotRuntime(snapshot);
        void loadModelCatalogForDevice(device);
        void syncPendingApprovalsForDevice(device);
        return snapshot;
      });
    },

    setStateScopes: async (
      declaration: ChatStateScopesDeclaration,
    ): Promise<void> => {
      const api = options.getApi();
      if (api === null) return;
      if (declaration.kind !== 'scopes') {
        // Never send `{ kind: 'all' }` to a paired computer: only explicitly
        // tracked scopes for that computer should be pushed over the tunnel.
        return;
      }
      const scopesByDevice = new Map<string, ChatGetStateRequest[]>();
      for (const scope of declaration.scopes) {
        const parsed = parsePairedDeviceScope(scope);
        const list = scopesByDevice.get(parsed.deviceId) ?? [];
        list.push({
          projectId: parsed.projectId,
          worktreeId: parsed.worktreeId,
        });
        scopesByDevice.set(parsed.deviceId, list);
      }

      for (const deviceId of Array.from(declaredScopesByDevice.keys())) {
        if (!scopesByDevice.has(deviceId)) {
          declaredScopesByDevice.delete(deviceId);
          if (!hasAnyInterest(declaredInterestByDevice.get(deviceId) ?? null)) {
            everHeldDevices.delete(deviceId);
            remoteControlOffDevices.delete(deviceId);
            endedDevices.delete(deviceId);
          }
        }
      }

      const writes: Promise<void>[] = [];
      for (const [deviceId, scopes] of scopesByDevice) {
        const previousScopes = declaredScopesByDevice.get(deviceId) ?? [];
        const scopesChanged = !sameDeclaredScopes(previousScopes, scopes);
        declaredScopesByDevice.set(deviceId, [...scopes]);
        if (
          !heldDevices.has(deviceId) &&
          (endedDevices.has(deviceId) ||
            (remoteControlOffDevices.has(deviceId) && !scopesChanged))
        ) {
          continue;
        }
        const device = ensureHeld(deviceId);
        const changed = !sameDeclaredScopes(device.declaredScopes, scopes);
        device.declaredScopes = [...scopes];
        if (changed) {
          writes.push(sendDeclaredScopesToDevice(device));
        }
      }
      for (const device of Array.from(heldDevices.values())) {
        if (scopesByDevice.has(device.deviceId)) continue;
        if (device.declaredScopes.length > 0) {
          device.declaredScopes = [];
          writes.push(sendDeclaredScopesToDevice(device));
        }
        maybeReleaseIdleDevice(device);
      }
      await Promise.all(writes);
    },

    onStateChanged: (cb) => addListener(stateChangedListeners, cb),

    loadTabs: async (req: ChatLoadTabsRequest): Promise<ChatTabsFile> => {
      const scope = parsePairedDeviceScope(req);
      return withHeldDevice(scope.deviceId, 'chats', async (device) => {
        const raw = await invokeDevice(
          device.api,
          scope.deviceId,
          'chat:load-tabs',
          [{ projectId: scope.projectId, worktreeId: scope.worktreeId }],
          isChatTabsFilePayload,
        );
        return qualifyTabsFile(scope.deviceId, raw);
      });
    },

    activeSessions: async (
      req: ChatLoadTabsRequest,
    ): Promise<ChatActiveSessions> => {
      const scope = parsePairedDeviceScope(req);
      return withHeldDevice(scope.deviceId, 'chats', async (device) => {
        const raw = await invokeDevice(
          device.api,
          scope.deviceId,
          'chat:active-sessions',
          [{ projectId: scope.projectId, worktreeId: scope.worktreeId }],
          isChatActiveSessionsPayload,
        );
        return qualifyActiveSessions(scope.deviceId, raw);
      });
    },

    getTranscriptPage: async (
      req: ChatTranscriptPageRequest,
    ): Promise<TranscriptPage> => {
      const target = parsePairedDeviceTarget(req);
      return withHeldDevice(target.deviceId, 'chats', async (device) => {
        const stripped = buildPairedTranscriptPageRequest(target, req);
        const page = await invokeDevice(
          device.api,
          target.deviceId,
          'chat:get-transcript-page',
          [stripped],
          isTranscriptPagePayload,
        );
        return sanitizePairedTranscriptPage(target.deviceId, page);
      });
    },

    getChatQueueSnapshot: async (req): Promise<ChatQueueUpdatedEvent[]> => {
      const scope = parsePairedDeviceScope(req);
      return withHeldDevice(scope.deviceId, 'chats', async (device) => {
        const raw = await device.api.invoke(
          scope.deviceId,
          'chat:queue-get-snapshot',
          [{ projectId: scope.projectId, worktreeId: scope.worktreeId }],
        );
        if (!Array.isArray(raw)) return [];
        const events: ChatQueueUpdatedEvent[] = [];
        for (const item of raw) {
          if (isChatQueueUpdatedPayload(item)) {
            events.push(qualifyQueueUpdatedEvent(scope.deviceId, item));
          }
        }
        return events;
      });
    },

    command: async (req: ChatCommandEnvelope): Promise<ChatCommandResult> => {
      parsePairedDeviceScope(req);
      // Tab activation and reorder are window-local choices: they never cross
      // the tunnel or steal focus on the paired computer.
      if (
        req.command.type === 'chat.activate_tab' ||
        req.command.type === 'chat.reorder_tabs'
      ) {
        return {
          commandId: req.commandId,
          revision:
            scopeRevisionByKey.get(`${req.projectId}/${req.worktreeId}`) ?? 0,
          outcome: 'applied',
        };
      }
      if (req.command.type === 'chat.send_message') {
        const target = parsePairedDeviceTarget({
          projectId: req.projectId,
          worktreeId: req.worktreeId,
          chatId: req.command.chatId,
        });
        const envelope = buildOneWindowSendCommandEnvelope({
          target,
          text: req.command.text,
          userMessageId: req.command.userMessageId,
          commandId: req.commandId,
        });
        return withHeldDevice(target.deviceId, 'send', async (device) =>
          invokeDevice(
            device.api,
            target.deviceId,
            'chat:command',
            [envelope],
            isChatCommandResultPayload,
          ),
        );
      }
      throw pairedComputerUnavailable(req.command.type);
    },

    sendMessage: async (
      req: ChatSendMessageRequest,
    ): Promise<ChatSendMessageResult> => {
      const target = parsePairedDeviceTarget(req);
      if (
        (req.attachmentPaths !== undefined && req.attachmentPaths.length > 0) ||
        (req.fileReferences !== undefined && req.fileReferences.length > 0)
      ) {
        throw pairedComputerUnavailable('Attachments and file references');
      }
      const envelope = buildOneWindowSendCommandEnvelope({
        target,
        text: req.text,
        userMessageId: req.userMessageId,
      });
      const storeRuntime = options.getRevisionedRuntime?.({
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        chatId: req.chatId,
      });
      const alreadyActive =
        (storeRuntime !== undefined &&
          ACTIVE_TURN_STATUSES.has(storeRuntime.status)) ||
        canonicalActiveTurnByChat.has(req.chatId) ||
        optimisticActiveTurnByChat.has(req.chatId);
      const seededOptimisticTurn = !alreadyActive;
      if (seededOptimisticTurn) {
        optimisticActiveTurnByChat.set(
          req.chatId,
          envelope.command.userMessageId,
        );
      }
      try {
        const result = await withHeldDevice(
          target.deviceId,
          'send',
          async (device) =>
            invokeDevice(
              device.api,
              target.deviceId,
              'chat:command',
              [envelope],
              isChatCommandResultPayload,
            ),
        );
        return translateSendCommandResult(result);
      } catch (error) {
        if (
          seededOptimisticTurn &&
          optimisticActiveTurnByChat.get(req.chatId) ===
            envelope.command.userMessageId
        ) {
          optimisticActiveTurnByChat.delete(req.chatId);
        }
        throw error;
      }
    },

    cancel: async (
      req: ChatBackendCancelRequest,
    ): Promise<ChatBackendCancelResult> => {
      const target = parsePairedDeviceTarget(req);
      const storeRuntime = options.getRevisionedRuntime?.({
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        chatId: req.chatId,
      });
      const expectedUserMessageId =
        storeRuntime !== undefined
          ? ACTIVE_TURN_STATUSES.has(storeRuntime.status)
            ? storeRuntime.activeTurn?.userMessageId
            : optimisticActiveTurnByChat.get(req.chatId)
          : (canonicalActiveTurnByChat.get(req.chatId) ??
            optimisticActiveTurnByChat.get(req.chatId));
      if (
        expectedUserMessageId === undefined ||
        expectedUserMessageId.length === 0
      ) {
        return { outcome: 'turn_not_active' };
      }
      const payload = buildOneWindowCancelRequest({
        target,
        expectedUserMessageId,
      });
      return withHeldDevice(target.deviceId, 'send', async (device) =>
        invokeDevice(
          device.api,
          target.deviceId,
          'chat:cancel',
          [payload],
          isChatCancelResultPayload,
        ),
      );
    },

    // Main owns no journal for paired computer scopes.
    flushScope: () => Promise.resolve(),
    onChatEvent: (cb) => addListener(chatEventListeners, cb),
    onChatQueueUpdated: (cb) => addListener(queueUpdatedListeners, cb),
    onTabDescriptionUpdated: noSubscription,

    // Unsupported members: every one fails closed with `capability_unavailable`.
    archiveTab: refuse('Archiving chats'),
    cancelDeferredToolsReload: refuse('Deferred tool reloads'),
    cancelTranscriptSearch: refuse('Transcript search'),
    cancelQueuedMessage: refuse('Cancelling queued messages'),
    changeModel: refuse('Changing the model'),
    editQueuedMessage: refuse('Editing queued messages'),
    forceQueuedMessage: refuse('Running queued messages early'),
    forkCodexThread: refuse('Forking chats'),
    forkOpenWorktreeTabs: refuse('Forking open tabs'),
    generateHandoffSummary: refuse('Handoff summaries'),
    loadArchives: refuse('Archived chats'),
    markAllArchivesRead: refuse('Archive read state'),
    markArchiveRead: refuse('Archive read state'),
    preparePlanFileSystemInstruction: refuse('Plan mode'),
    readArchive: refuse('Reading archived chats'),
    resetToPoint: refuse('Reset to point'),
    restoreArchive: refuse('Restoring archived chats'),
    resumeStoppedTurn: refuse('Resuming a stopped turn'),
    searchTranscript: refuse('Transcript search'),
    setQueuedHookChatInterfaceMode: refuse('Hook chats'),
    setQueuedMessageEditLock: refuse('Editing queued messages'),
    toggleCodexFastMode: refuse('Fast mode'),
    togglePlanMode: refuse('Plan mode'),
    toggleThinkingLevel: refuse('Thinking level'),
    updatePlugins: refuse('Plugin selections'),
  };

  const approvals: ChatBackendApprovalsApi = {
    getResolvedDefault: async (
      req: ApprovalResolvedDefaultRequest,
    ): Promise<ApprovalMode> => {
      const project = parsePairedDeviceProject(req.projectId);
      const stripped: ApprovalResolvedDefaultRequest = {
        projectId: project.projectId,
        ...(req.worktreeId !== undefined
          ? {
              worktreeId: parsePairedDeviceScope({
                projectId: req.projectId,
                worktreeId: req.worktreeId,
              }).worktreeId,
            }
          : {}),
      };
      return withHeldDevice(project.deviceId, 'composer', async (device) =>
        invokeDevice(
          device.api,
          project.deviceId,
          'approval:resolved-default',
          [stripped],
          isApprovalMode,
        ),
      );
    },

    pendingRequests: async (
      scope?: ChatBackendScope,
    ): Promise<ApprovalRequestEvent[]> => {
      const targetDeviceId =
        scope !== undefined
          ? parsePairedDeviceProject(scope.projectId).deviceId
          : null;
      const devices = Array.from(heldDevices.values()).filter(
        (device) =>
          (targetDeviceId === null || device.deviceId === targetDeviceId) &&
          !device.disposed &&
          device.state?.status === 'connected' &&
          device.state.capabilities.includes('approvals'),
      );
      if (devices.length === 0) return [];
      // Open a fence on every held device before reading so a cancellation
      // arriving on one device while another device's read is still in flight
      // is reconciled before returning the merged hydration snapshot.
      const fences = devices.map((device) => {
        const seq = ++device.approvalSyncSeq;
        const buffered: ApprovalDelta[] = [];
        device.activeApprovalSyncs.set(seq, buffered);
        return { device, seq, buffered };
      });
      try {
        const settled = await Promise.allSettled(
          fences.map(async ({ device }) =>
            device.api.invoke(device.deviceId, 'approval:pending-requests', []),
          ),
        );
        const results: ApprovalRequestEvent[] = [];
        for (let i = 0; i < fences.length; i += 1) {
          const fence = fences[i];
          const outcome = settled[i];
          if (!fence || !outcome) continue;
          if (outcome.status === 'rejected') {
            reportClientAppError(outcome.reason);
            continue;
          }
          const raw = outcome.value;
          if (fence.device.disposed || !Array.isArray(raw)) {
            continue;
          }
          const allowedScopes = new Set(
            fence.device.declaredScopes.map((scope) => localScopeKey(scope)),
          );
          const merged = new Map<string, ApprovalRequestEvent>();
          for (const item of raw) {
            if (!isApprovalRequestPayload(item)) continue;
            if (!allowedScopes.has(localScopeKey(item))) continue;
            try {
              const qualified = qualifyApprovalRequestEvent(
                fence.device.deviceId,
                item,
              );
              merged.set(qualified.requestId, qualified);
            } catch (error: unknown) {
              reportClientAppError(error);
            }
          }
          for (const delta of fence.buffered) {
            if (delta.kind === 'request') {
              merged.set(delta.event.requestId, delta.event);
            } else {
              merged.delete(delta.requestId);
            }
          }
          results.push(...merged.values());
        }
        return results;
      } finally {
        for (const { device, seq } of fences) {
          device.activeApprovalSyncs.delete(seq);
        }
      }
    },

    onRequest: (cb) => addListener(approvalRequestListeners, cb),
    onCancelled: (cb) => addListener(approvalCancelledListeners, cb),
    onAutoResolved: (cb) => addListener(approvalAutoResolvedListeners, cb),

    respond: refuse('Answering tool approvals'),
    respondSecretInput: refuse('Answering secret approvals'),
    dismiss: refuse('Dismissing tool approvals'),
    setMode: refuse('Changing approval mode'),
  };

  const secretRequests: ChatBackendSecretRequestApi = {
    submit: refuse('Answering secret requests'),
    decline: refuse('Declining secret requests'),
  };

  async function setInterest(
    declaration: ChatInterestDeclaration,
  ): Promise<void> {
    const api = options.getApi();
    if (api === null) return;

    const byDevice = new Map<
      string,
      {
        focused: ChatInterestDeclaration['focused'];
        warm: ChatInterestDeclaration['warm'];
      }
    >();
    const bucket = (
      deviceId: string,
    ): {
      focused: ChatInterestDeclaration['focused'];
      warm: ChatInterestDeclaration['warm'];
    } => {
      let entry = byDevice.get(deviceId);
      if (!entry) {
        entry = { focused: [], warm: [] };
        byDevice.set(deviceId, entry);
      }
      return entry;
    };

    for (const ref of declaration.focused) {
      const parsed = parsePairedDeviceTarget(ref);
      bucket(parsed.deviceId).focused.push({
        projectId: parsed.projectId,
        worktreeId: parsed.worktreeId,
        chatId: parsed.chatId,
      });
    }
    for (const ref of declaration.warm) {
      const parsed = parsePairedDeviceTarget(ref);
      bucket(parsed.deviceId).warm.push({
        projectId: parsed.projectId,
        worktreeId: parsed.worktreeId,
        chatId: parsed.chatId,
      });
    }

    for (const deviceId of Array.from(declaredInterestByDevice.keys())) {
      if (!byDevice.has(deviceId)) {
        declaredInterestByDevice.delete(deviceId);
        if ((declaredScopesByDevice.get(deviceId)?.length ?? 0) === 0) {
          everHeldDevices.delete(deviceId);
          remoteControlOffDevices.delete(deviceId);
          endedDevices.delete(deviceId);
        }
      }
    }

    const writes: Promise<void>[] = [];
    for (const [deviceId, refs] of byDevice) {
      const nextInterest: ChatInterestDeclaration = {
        focused: refs.focused,
        warm: refs.warm,
      };
      declaredInterestByDevice.set(deviceId, nextInterest);
      if (
        !heldDevices.has(deviceId) &&
        (endedDevices.has(deviceId) || remoteControlOffDevices.has(deviceId))
      ) {
        continue;
      }
      const device = ensureHeld(deviceId);
      device.declaredInterest = nextInterest;
      writes.push(sendDeclaredInterestToDevice(device));
    }
    for (const device of Array.from(heldDevices.values())) {
      if (byDevice.has(device.deviceId)) continue;
      if (hasAnyInterest(device.declaredInterest)) {
        device.declaredInterest = { focused: [], warm: [] };
        writes.push(sendDeclaredInterestToDevice(device));
      } else {
        device.declaredInterest = null;
      }
      maybeReleaseIdleDevice(device);
    }
    await Promise.all(writes);
  }

  async function loadModelCatalog(deviceId: string): Promise<void> {
    const api = options.getApi();
    if (api === null) return;
    await withHeldDevice(deviceId, 'composer', (device) =>
      loadModelCatalogForDevice(device),
    ).catch((error: unknown) => {
      if (!isCapabilityUnavailable(error)) reportClientAppError(error);
    });
  }

  function reacquireRemoteControlOffDevices(): void {
    if (options.getApi() === null) return;
    for (const deviceId of Array.from(remoteControlOffDevices)) {
      const hasScopes = (declaredScopesByDevice.get(deviceId)?.length ?? 0) > 0;
      const hasInterest = hasAnyInterest(
        declaredInterestByDevice.get(deviceId) ?? null,
      );
      if (!hasScopes && !hasInterest) {
        remoteControlOffDevices.delete(deviceId);
        continue;
      }
      if (heldDevices.has(deviceId)) {
        remoteControlOffDevices.delete(deviceId);
        continue;
      }
      remoteControlOffDevices.delete(deviceId);
      ensureHeld(deviceId);
    }
  }

  function closeAll(): void {
    for (const deviceId of Array.from(heldDevices.keys())) {
      releaseDeviceHold(deviceId);
    }
    declaredScopesByDevice.clear();
    declaredInterestByDevice.clear();
    everHeldDevices.clear();
    remoteControlOffDevices.clear();
    endedDevices.clear();
    canonicalActiveTurnByChat.clear();
    optimisticActiveTurnByChat.clear();
    scopeRevisionByKey.clear();
    options.onConnectionCleared?.();
    options.onModelCatalogCleared?.();
  }

  return {
    backend: { chat, approvals, secretRequests },
    setInterest,
    loadModelCatalog,
    reacquireRemoteControlOffDevices,
    closeAll,
  };
}
