import type {
  ChatBackend,
  ChatBackendApprovalsApi,
  ChatBackendChatApi,
} from '../backend';
import { createRelayCoreCoworkInvoker } from '@/cloud-chats/relay-invoker';
import {
  createWebCoreChatBackendCore,
  webCoreUnavailable,
  type CloudTabModel,
  type WebCoreAttachmentFile,
  type WebCoreChatBackendCore,
} from './web-core-chat-backend';
import type { LiveChat } from './live-follower';
import { clearTaskCreations } from './task-creations';
import { useWebCoreLiveReplyStore } from './live-replies';
import { cloudChatBackgroundProcesses } from './agent-task-processes';
import type { CoreCoworkInvoker } from '@canopy/app-state/core-cowork';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import {
  clearWebCoreModelCatalog,
  loadWebCoreModelCatalog,
  useWebCoreModelCatalogStore,
  webCoreModelOption,
} from './model-catalog';

const refuse = (member: string) => (): Promise<never> =>
  Promise.reject(webCoreUnavailable(member));

const noSubscription = (): (() => void) => () => undefined;

/**
 * The store's backend for a web core scope: R3's members over the web core,
 * empty reads where it serves nothing yet, and a refusal for the rest. The
 * UI hides what is refused here by capability (CAN-6175 D4).
 */
export function createWebCoreChatBackend(
  core: WebCoreChatBackendCore,
): ChatBackend {
  const chat: ChatBackendChatApi = {
    getState: core.getState,
    setStateScopes: core.setStateScopes,
    onStateChanged: core.onStateChanged,
    getTranscriptPage: core.getTranscriptPage,
    command: core.command,
    sendMessage: core.sendMessage,
    cancel: core.cancel,
    loadTabs: async (req) => (await core.getState(req)).tabsFile,
    loadArchives: core.loadArchives,
    archiveTab: core.archiveTab,
    restoreArchive: core.restoreArchive,
    // Queued text is not served yet (CAN-6106).
    getChatQueueSnapshot: () => Promise.resolve([]),
    // Main owns no journal for a web core scope: nothing to flush.
    flushScope: () => Promise.resolve(),
    onChatEvent: noSubscription,
    onChatQueueUpdated: noSubscription,
    onTabDescriptionUpdated: noSubscription,
    activeSessions: refuse('Active sessions'),
    cancelDeferredToolsReload: refuse('Deferred tool reloads'),
    cancelQueuedMessage: refuse('Queued messages'),
    changeModel: refuse('Changing the model'),
    editQueuedMessage: refuse('Queued messages'),
    forceQueuedMessage: refuse('Queued messages'),
    forkCodexThread: refuse('Codex thread forks'),
    forkOpenWorktreeTabs: refuse('Forking open tabs'),
    generateHandoffSummary: refuse('Handoff summaries'),
    markAllArchivesRead: refuse('Archive read state'),
    markArchiveRead: refuse('Archive read state'),
    preparePlanFileSystemInstruction: refuse('Plan files'),
    readArchive: refuse('Reading archived chats'),
    resetToPoint: refuse('Reset to point'),
    resumeStoppedTurn: refuse('Resuming a stopped turn'),
    setQueuedHookChatInterfaceMode: refuse('Hook chats'),
    setQueuedMessageEditLock: refuse('Queued messages'),
    toggleCodexFastMode: core.toggleCodexFastMode,
    togglePlanMode: refuse('Plan mode'),
    toggleThinkingLevel: core.toggleThinkingLevel,
    updatePlugins: refuse('Plugin selections'),
  };
  const approvals: ChatBackendApprovalsApi = {
    // Approvals in cloud chats come with their own row (CAN-6175 section 4).
    pendingRequests: () => Promise.resolve([]),
    onRequest: noSubscription,
    onCancelled: noSubscription,
    onAutoResolved: noSubscription,
    respond: refuse('Approvals'),
    respondSecretInput: refuse('Approvals'),
    dismiss: refuse('Approvals'),
    getResolvedDefault: refuse('Approvals'),
    setMode: refuse('Approval mode'),
  };
  return { chat, approvals };
}

const relayInvoker = (): CoreCoworkInvoker | null =>
  typeof window !== 'undefined' && window.canopyCore
    ? createRelayCoreCoworkInvoker(window.canopyCore)
    : null;

/**
 * Where a web core chat's background processes go: the activity tray. The
 * renderer wires it where it installs the cloud chat runtime, so this module
 * never imports the activity store, whose import chain reaches the chat store
 * that imports this backend.
 */
export interface WebCoreAgentTasksPublisher {
  publish(
    scope: { readonly projectId: string; readonly worktreeId: string },
    chatId: string,
    processes: readonly BackgroundProcess[],
  ): void;
}

let agentTasksPublisher: WebCoreAgentTasksPublisher | null = null;

/** Sets, or with `null` clears, where web core agent tasks are published. */
export function setWebCoreAgentTasksPublisher(
  publisher: WebCoreAgentTasksPublisher | null,
): void {
  agentTasksPublisher = publisher;
}

let backend: ChatBackend | null = null;
let core: WebCoreChatBackendCore | null = null;

/** The one web core backend, so the store can compare backends by identity. */
export function webCoreChatBackend(): ChatBackend {
  if (backend !== null) return backend;
  core = createWebCoreChatBackendCore({
    invoker: relayInvoker,
    publishLive: (key, chat) =>
      useWebCoreLiveReplyStore.getState().set(key, chat),
    modelOption: (projectId, model) =>
      webCoreModelOption(
        useWebCoreModelCatalogStore.getState(),
        projectId,
        model,
      ),
    uploadAttachment: (target, file) =>
      window.api.cloudChats.uploadAttachment(target, file),
    publishAgentTasks: (scope, chatId, tasks) => {
      if (agentTasksPublisher === null) {
        // A debug note, not an error: with no publisher there is no tray.
        // eslint-disable-next-line no-console
        console.debug(
          'Dropped web core agent tasks: no publisher is installed',
          chatId,
        );
        return;
      }
      agentTasksPublisher.publish(
        scope,
        chatId,
        cloudChatBackgroundProcesses(chatId, tasks),
      );
    },
  });
  backend = createWebCoreChatBackend(core);
  return backend;
}

/** Uploads a file the composer attaches to a web core chat (CAN-6175 R6). */
export function uploadWebCoreChatAttachment(
  target: { projectId: string; worktreeId: string; chatId: string },
  file: WebCoreAttachmentFile,
): ReturnType<WebCoreChatBackendCore['uploadAttachment']> {
  webCoreChatBackend();
  if (core === null) return Promise.resolve({ ok: false, reason: 'disabled' });
  return core.uploadAttachment(target, file);
}

/** Ends every web core stream: the connection went offline or was turned off. */
export function closeWebCoreChatBackend(): void {
  core?.closeAll();
  clearTaskCreations();
  useWebCoreLiveReplyStore.getState().clear();
  clearWebCoreModelCatalog();
}

/** The web core chats this window shows, which follow their live reply. */
export function followWebCoreLiveChats(chats: readonly LiveChat[]): void {
  webCoreChatBackend();
  core?.setLiveChats(chats);
}

/** A store chat id as the web core names it, or null for a local chat. */
export function webCoreChatId(chatId: string): string | null {
  webCoreChatBackend();
  return core?.webCoreChatId(chatId) ?? null;
}

/**
 * The model the web core runs for a cloud chat tab, as the newest revision
 * this window has seen names it, or undefined before any names it (CAN-6345).
 */
export function webCoreTabModel(target: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}): CloudTabModel | undefined {
  webCoreChatBackend();
  return core?.webCoreTabModel(target);
}

/**
 * Notes the window's newest model pick for a cloud chat tab as the composer
 * shows it, or null once it settles (CAN-6345).
 */
export function pickWebCoreTabModel(
  target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  },
  choice: CloudTabModel | null,
): void {
  webCoreChatBackend();
  core?.pickWebCoreTabModel(target, choice);
}

/** Reads a web core workspace's models for its chats' composers. */
export function loadWebCoreModels(projectId: string): Promise<void> {
  return loadWebCoreModelCatalog(projectId, relayInvoker);
}
