import type { ApprovalsApi, ChatApi } from '@canopy/desktop-shared/types';
import { CoreCoworkRequestError } from '@canopy/app-state/core-cowork';
import { isWebCoreScope } from '@/lib/chat-authority';
import { reportUnhandledRendererRejection } from '@/lib/renderer-error-logging';
import { webCoreChatBackend } from './web-core';

/** The chat I/O a scope's authority must serve for the chat store. */
export type ChatBackendChatApi = Pick<
  ChatApi,
  | 'activeSessions'
  | 'archiveTab'
  | 'cancel'
  | 'cancelDeferredToolsReload'
  | 'cancelQueuedMessage'
  | 'changeModel'
  | 'command'
  | 'editQueuedMessage'
  | 'flushScope'
  | 'forceQueuedMessage'
  | 'forkCodexThread'
  | 'forkOpenWorktreeTabs'
  | 'generateHandoffSummary'
  | 'getChatQueueSnapshot'
  | 'getState'
  | 'getTranscriptPage'
  | 'loadArchives'
  | 'loadTabs'
  | 'markAllArchivesRead'
  | 'markArchiveRead'
  | 'onChatEvent'
  | 'onChatQueueUpdated'
  | 'onStateChanged'
  | 'onTabDescriptionUpdated'
  | 'preparePlanFileSystemInstruction'
  | 'readArchive'
  | 'resetToPoint'
  | 'restoreArchive'
  | 'resumeStoppedTurn'
  | 'sendMessage'
  | 'setQueuedHookChatInterfaceMode'
  | 'setQueuedMessageEditLock'
  | 'setStateScopes'
  | 'toggleCodexFastMode'
  | 'togglePlanMode'
  | 'toggleThinkingLevel'
  | 'updatePlugins'
>;

/** The approval I/O a scope's authority must serve for the chat store. */
export type ChatBackendApprovalsApi = Pick<
  ApprovalsApi,
  | 'dismiss'
  | 'getResolvedDefault'
  | 'onAutoResolved'
  | 'onCancelled'
  | 'onRequest'
  | 'pendingRequests'
  | 'respond'
  | 'respondSecretInput'
  | 'setMode'
>;

/**
 * Where the chat store reads and commands one chat authority's chats
 * (CAN-6175 D3). The store's state and the components over it are the same
 * for every authority; only this I/O differs.
 */
export interface ChatBackend {
  readonly chat: ChatBackendChatApi;
  readonly approvals: ChatBackendApprovalsApi;
}

/** The part of a chat scope that names its authority. */
export interface ChatBackendScope {
  readonly projectId: string;
}

/**
 * The local core over the preload bridge. Read on every access, so a page
 * or test that replaces `window.api` is honoured.
 */
const localBackend: ChatBackend & {
  readonly chat: ChatApi;
  readonly approvals: ApprovalsApi;
} = {
  get chat(): ChatApi {
    return window.api.chat;
  },
  get approvals(): ApprovalsApi {
    return window.api.approvals;
  },
};

/**
 * Whether an error is an authority's refusal to serve a chat member: the web
 * core backend's own refusal (`code`) or one the web core returned
 * (`payload.kind`).
 */
export function isCapabilityUnavailable(error: unknown): boolean {
  if (error instanceof CoreCoworkRequestError)
    return error.payload.kind === 'capability_unavailable';
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'capability_unavailable'
  );
}

/**
 * A `catch` handler for a call whose refusal the store treats as nothing to
 * do: an authority that does not serve the call settles it as `undefined`,
 * and any other failure still rejects.
 */
export function ignoreUnavailable(error: unknown): undefined {
  if (isCapabilityUnavailable(error)) return undefined;
  throw error;
}

/**
 * The rejection handler for a backend call nothing awaits: a refusal is
 * dropped (the UI hides those controls by capability), and any other failure
 * is logged exactly as an unhandled rejection was.
 */
export function reportUnlessUnavailable(error: unknown): void {
  if (!isCapabilityUnavailable(error)) reportUnhandledRendererRejection(error);
}

/**
 * The backend that serves this scope's chats: the web core's for a web core
 * scope, the local core's otherwise. A scope is never served by another
 * authority's backend.
 */
export function chatBackendFor(scope: ChatBackendScope): ChatBackend {
  return isWebCoreScope(scope.projectId) ? webCoreChatBackend() : localBackend;
}

/**
 * Whether this scope's backend answers transcript reads with turn frames.
 * The web core serves message pages only, so its window pages back by
 * `before` and never upgrades to a turn view.
 */
export function servesTurnPages(scope: ChatBackendScope): boolean {
  return !isWebCoreScope(scope.projectId);
}

/** Every backend, for subscriptions that are not tied to one scope. */
export function chatBackends(): readonly ChatBackend[] {
  return [localBackend, webCoreChatBackend()];
}

/**
 * Subscribes on every backend and returns one unsubscribe. A backend whose
 * subscribe returns undefined (it lacks the event) is skipped.
 */
export function subscribeEachChatBackend(
  subscribe: (backend: ChatBackend) => (() => void) | undefined,
): () => void {
  const unsubscribes = chatBackends().flatMap((backend) => {
    const unsubscribe = subscribe(backend);
    return unsubscribe === undefined ? [] : [unsubscribe];
  });
  return (): void => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/**
 * The local core, for behaviour only the local runtime has: hook chats, the
 * MCP ask-user bridge, Claude plan-exit requests and ad hoc migrations.
 */
export function localChatBackend(): {
  readonly chat: ChatApi;
  readonly approvals: ApprovalsApi;
} {
  return localBackend;
}
