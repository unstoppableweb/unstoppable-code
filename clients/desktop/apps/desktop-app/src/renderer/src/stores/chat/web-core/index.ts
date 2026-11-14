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
import { clearCloudTaskDeletions } from './task-deletions';
import { useWebCoreLiveReplyStore } from './live-replies';
import { useWebCoreStartingTurnStore } from './starting-turns';
import { tryChatStoreApi } from '../store-ref';
import { runtimeRunsTurn } from '../runtime-runs-turn';
import { cloudChatBackgroundProcesses } from './agent-task-processes';
import { cloudWorkspaceFilesChanged } from '@/cloud-chats/cloud-workspace-file-list';
import { webCoreLocalId } from '@/lib/chat-authority';
import { cloudChatAttachmentAdded } from '@/cloud-chats/cloud-chat-attachment-list';
import type { CoreCoworkInvoker } from '@canopy/app-state/core-cowork';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import {
  clearWebCoreModelCatalog,
  loadWebCoreModelCatalog,
  retryWebCoreModelCatalog,
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
    searchTranscript: core.searchTranscript,
    // A search the web core already runs finishes there; the find bar drops
    // its answer by generation.
    cancelTranscriptSearch: () => Promise.resolve(),
    command: core.command,
    sendMessage: core.sendMessage,
    cancel: core.cancel,
    loadTabs: async (req) => (await core.getState(req)).tabsFile,
    loadArchives: core.loadArchives,
    archiveTab: core.archiveTab,
    restoreArchive: core.restoreArchive,
    // Queued prompts as the web core serves them: Remove (CAN-6644), Edit
    // and Run now (CAN-6651) reach Core with the entry's revision.
    getChatQueueSnapshot: core.getQueue,
    // Main owns no journal for a web core scope: nothing to flush.
    flushScope: () => Promise.resolve(),
    onChatEvent: noSubscription,
    onChatQueueUpdated: core.onQueueUpdated,
    onTabDescriptionUpdated: noSubscription,
    activeSessions: refuse('Active sessions'),
    cancelDeferredToolsReload: refuse('Deferred tool reloads'),
    cancelQueuedMessage: core.cancelQueued,
    changeModel: refuse('Changing the model'),
    editQueuedMessage: core.editQueued,
    forceQueuedMessage: core.forceQueued,
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
    setQueuedMessageEditLock: core.setQueuedEditLock,
    toggleCodexFastMode: core.toggleCodexFastMode,
    togglePlanMode: refuse('Plan mode'),
    toggleThinkingLevel: core.toggleThinkingLevel,
    updatePlugins: refuse('Plugin selections'),
  };
  const approvals: ChatBackendApprovalsApi = {
    // The shown cloud chats' tool approvals, over the web core (CAN-6515).
    pendingRequests: core.approvals.pendingRequests,
    onRequest: core.approvals.onRequest,
    onCancelled: core.approvals.onCancelled,
    // Cloud chats have no approval modes, so nothing resolves by itself.
    onAutoResolved: noSubscription,
    respond: core.approvals.respond,
    respondSecretInput: refuse('Secret input approvals'),
    dismiss: core.approvals.dismiss,
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

/**
 * What the window does with a cloud task the web core said was deleted
 * (CAN-6614): the cloud chats runtime keeps its row while the task holds a
 * draft. Installed beside the agent tasks publisher, for the same reason.
 */
let taskDeletionHandler:
  | ((scope: {
      readonly projectId: string;
      readonly worktreeId: string;
    }) => void)
  | null = null;

/** Whether a store chat holds unsent work; installed with the handler below. */
let unsentWorkCheck:
  | ((
      scope: { readonly projectId: string; readonly worktreeId: string },
      chatId: string,
    ) => boolean)
  | null = null;

/** Sets, or with `null` clears, how the backend asks about unsent work. */
export function setWebCoreUnsentWorkCheck(check: typeof unsentWorkCheck): void {
  unsentWorkCheck = check;
}

/** Sets, or with `null` clears, what handles a cloud task deleted elsewhere. */
export function setWebCoreTaskDeletionHandler(
  handler: typeof taskDeletionHandler,
): void {
  taskDeletionHandler = handler;
}

let backend: ChatBackend | null = null;
let core: WebCoreChatBackendCore | null = null;
let followingStoreRuntimes = false;

/**
 * Tells the web core backend each time the store's chat runtimes change, so
 * a sent turn stops reading starting once the store runs it (CAN-6677).
 */
function followStoreRuntimes(): void {
  if (followingStoreRuntimes) return;
  const api = tryChatStoreApi();
  if (api === undefined) return;
  followingStoreRuntimes = true;
  api.subscribe((state, previous) => {
    if (state.runtimeByChatId !== previous.runtimeByChatId)
      core?.storeRuntimesChanged();
  });
}

/** The one web core backend, so the store can compare backends by identity. */
export function webCoreChatBackend(): ChatBackend {
  if (backend !== null) return backend;
  core = createWebCoreChatBackendCore({
    invoker: relayInvoker,
    publishLive: (key, chat) =>
      useWebCoreLiveReplyStore.getState().set(key, chat),
    publishTurnStarting: (key, starting) =>
      useWebCoreStartingTurnStore.getState().set(key, starting),
    storeRunsTurn: (target) => {
      followStoreRuntimes();
      return runtimeRunsTurn(
        tryChatStoreApi()?.getState().runtimeByChatId[target.chatId],
      );
    },
    modelOption: (projectId, model) =>
      webCoreModelOption(
        useWebCoreModelCatalogStore.getState(),
        projectId,
        model,
      ),
    uploadAttachment: (target, file) =>
      window.api.cloudChats.uploadAttachment(target, file),
    onWorkspaceFilesChanged: (scope) => {
      const workspaceId = webCoreLocalId(scope.projectId);
      if (workspaceId !== null)
        cloudWorkspaceFilesChanged(window.canopyCore, workspaceId);
    },
    onTaskDeleted: (scope) => taskDeletionHandler?.(scope),
    holdsUnsentWork: (scope, chatId) =>
      unsentWorkCheck?.(scope, chatId) ?? false,
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
  followStoreRuntimes();
  return backend;
}

/** Uploads a file the composer attaches to a web core chat (CAN-6175 R6). */
export function uploadWebCoreChatAttachment(
  target: { projectId: string; worktreeId: string; chatId: string },
  file: WebCoreAttachmentFile,
): ReturnType<WebCoreChatBackendCore['uploadAttachment']> {
  webCoreChatBackend();
  const backendCore = core;
  if (backendCore === null)
    return Promise.resolve({ ok: false, reason: 'disabled' });
  return backendCore.uploadAttachment(target, file).then((result) => {
    // The activity rail lists the chat's attachments (CAN-6175 R8d).
    const chatId = backendCore.webCoreChatId(target.chatId);
    if (result.ok && chatId !== null)
      cloudChatAttachmentAdded(window.canopyCore, chatId);
    return result;
  });
}

/** Ends every web core stream: the connection went offline or was turned off. */
export function closeWebCoreChatBackend(): void {
  core?.closeAll();
  clearTaskCreations();
  clearCloudTaskDeletions();
  useWebCoreLiveReplyStore.getState().clear();
  useWebCoreStartingTurnStore.getState().clear();
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

/** Try again on a web core workspace whose models could not be read. */
export function retryWebCoreModels(projectId: string): Promise<void> {
  return retryWebCoreModelCatalog(projectId, relayInvoker);
}
