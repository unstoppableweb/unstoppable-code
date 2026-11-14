import { TrackedPlanImplementationSchema } from '@canopy/protocol/portal';
import type {
  ChatReadSelection,
  TranscriptConsumeOptions,
} from '../services/chat-state-v2-backend';
import {
  type AgentModelConfig,
  type AgentProviderType,
  type ApprovalMode,
  type ChatModel,
  type ChatTabsFile,
  type PersistedChatMessage,
  type PersistedChatTab,
  type PluginSelectionTombstones,
  type SharedRunMetadata,
  type ModelHarness,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { chatInheritsProjectDefaults } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { isRecord } from './type-guards';
import { validateWorktreeChatScope } from './validation';
import { isPersistedChatMessage } from './persisted-chat-message-validation';
import {
  chatLastMessageRole,
  type ChatLastMessageRole,
} from './chat-last-message-role';

const pendingRoleReads = new Map<
  string,
  Promise<ChatLastMessageRole | undefined>
>();
const LEGACY_ROLE_MAX_MESSAGES = 500;

/** Additive legacy recovery through the canonical pinned, read-only preview.
 * No successful or unresolved result is retained across requests. Identity
 * includes the storage root and transcript revision, never just a chat id.
 * Larger legacy histories stay unknown until their next normal write.
 */
export async function readChatLastMessageRole(
  projectId: string,
  worktreeId: string,
  tab: PersistedChatTab,
): Promise<ChatLastMessageRole | undefined> {
  const role = chatLastMessageRole(tab);
  if (role || !tab.transcript) return role;
  const count = tab.transcript.messageCount;
  if (count === 0 || count === undefined || count > LEGACY_ROLE_MAX_MESSAGES)
    return undefined;
  const { resolveChatTabsFilePath } = await import('./resolve-worktree');
  const key = JSON.stringify([
    resolveChatTabsFilePath(projectId, worktreeId),
    tab.id,
    tab.transcript,
  ]);
  const pending = pendingRoleReads.get(key);
  if (pending) return pending;
  const read = (async (): Promise<ChatLastMessageRole | undefined> => {
    const { getChatStateService } =
      await import('../services/chat-state-service');
    return getChatStateService().consumeTranscriptPreview(
      { projectId, worktreeId },
      tab.id,
      async (messages, descriptor) => {
        if (descriptor.lastMessageRole) return descriptor.lastMessageRole;
        if (
          descriptor.messageCount === undefined ||
          descriptor.messageCount > LEGACY_ROLE_MAX_MESSAGES
        )
          return undefined;
        let recovered: ChatLastMessageRole | undefined;
        let scanned = 0;
        for await (const message of messages) {
          if (++scanned > LEGACY_ROLE_MAX_MESSAGES) return undefined;
          if (message.role === 'user' || message.role === 'assistant')
            recovered = message.role;
        }
        return recovered;
      },
    );
  })().catch(() => undefined);
  pendingRoleReads.set(key, read);
  try {
    return await read;
  } finally {
    if (pendingRoleReads.get(key) === read) pendingRoleReads.delete(key);
  }
}

export { isPersistedChatMessage } from './persisted-chat-message-validation';

export type { ChatTabsFile } from '@canopy/desktop-shared/types';

export async function readChatTabsFile(
  projectId: string,
  worktreeId: string,
  selection: ChatReadSelection = {},
): Promise<ChatTabsFile> {
  validateWorktreeChatScope(projectId, worktreeId);
  // Lazy import breaks the compatibility reader/state projection cycle.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  return getChatStateService().getCompatibilityTabs(
    {
      projectId,
      worktreeId,
    },
    selection,
  );
}

/** Explicit full-history consumer. Only this chat is read; artifact bodies
 * are restored for portability/reconstruction, never for ordinary UI pages. */
export async function readChatTranscript(
  projectId: string,
  worktreeId: string,
  chatId: string,
  fullOutputs = false,
  options?: TranscriptConsumeOptions,
): Promise<PersistedChatMessage[]> {
  // Lazy import breaks the compatibility reader/state projection cycle.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  return getChatStateService().consumeTranscript(
    { projectId, worktreeId },
    chatId,
    fullOutputs,
    async (rows) => {
      const messages: PersistedChatMessage[] = [];
      for await (const message of rows) messages.push(message);
      return messages;
    },
    options,
  );
}

/** Strict canonical metadata reader. Recovery failures propagate so search,
 * export and destructive callers can never mistake damaged history for empty. */
export async function readChatTabsFileForIndex(
  projectId: string,
  worktreeId: string,
): Promise<ChatTabsFile> {
  return readChatTabsFile(projectId, worktreeId);
}

export interface PersistedChatDispatchMetadata {
  /** Canonical transcript count, including thin metadata-only projections. */
  hasConversation?: boolean;
  executionHarnessExplicitlyChosen?: boolean;
  providerType?: AgentProviderType;
  executionHarness?: ModelHarness;
  model?: ChatModel;
  thinkingLevel?: ThinkingLevel;
  modelConfig?: AgentModelConfig;
  deferredToolsAllowed?: boolean;
  approvalMode?: ApprovalMode;
  /** The next turn owes the conversation after a provider switch (CAN-6445). */
  providerSwitchSeedPending?: true;
}

/**
 * The persisted global-default rejections for one chat tab, or `undefined`
 * when the tab/file is missing or has none. Best-effort accessor used by
 * plugin resolution to subtract chat-level tombstones from the global
 * default-plugin overlay.
 */
export interface PersistedChatPluginInheritance {
  tombstones?: PluginSelectionTombstones;
  /** See `chatInheritsProjectDefaults`; true for a chat not written yet. */
  inheritsProjectDefaults: boolean;
}

export async function readPersistedChatPluginInheritance(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<PersistedChatPluginInheritance> {
  const tabsFile = await readChatTabsFile(projectId, worktreeId);
  const tab = tabsFile.tabs.find((candidate) => candidate.id === chatId);
  return {
    ...(tab?.disabledGlobalPluginSelections
      ? { tombstones: tab.disabledGlobalPluginSelections }
      : {}),
    inheritsProjectDefaults: chatInheritsProjectDefaults(tab),
  };
}

export async function readPersistedChatDispatchMetadata(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<PersistedChatDispatchMetadata> {
  const tabsFile = await readChatTabsFile(projectId, worktreeId);
  const tab = tabsFile.tabs.find((candidate) => candidate.id === chatId);
  if (!tab) {
    return {};
  }

  return {
    hasConversation: (tab.transcript?.messageCount ?? tab.messages.length) > 0,
    ...(tab.executionHarnessExplicitlyChosen === true
      ? { executionHarnessExplicitlyChosen: true }
      : {}),
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...(tab.executionHarness ? { executionHarness: tab.executionHarness } : {}),
    ...(tab.model ? { model: tab.model } : {}),
    ...(tab.thinkingLevel ? { thinkingLevel: tab.thinkingLevel } : {}),
    ...(tab.modelConfig ? { modelConfig: tab.modelConfig } : {}),
    ...(typeof tab.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: tab.deferredToolsAllowed }
      : {}),
    ...(tab.approvalMode ? { approvalMode: tab.approvalMode } : {}),
    ...(tab.providerSwitchSeedPending === true
      ? { providerSwitchSeedPending: true }
      : {}),
  };
}

/**
 * The chat tab's persisted serialized execution context, or `undefined` when
 * the tab/file is missing or has none. Org memory reads it lazily, only for a
 * Personal project linked to an organization (CAN-3457).
 */
export async function readPersistedChatExecutionContext(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<string | undefined> {
  const tabsFile = await readChatTabsFile(projectId, worktreeId);
  const tab = tabsFile.tabs.find((candidate) => candidate.id === chatId);
  return tab?.executionContext;
}

/**
 * The persisted "Shared to …" metadata for a chat tab, or `null` when the chat
 * has never been shared (or the tab/file is missing). Presence of this metadata
 * is how the main process knows a chat is currently shared and should have new
 * turns auto-published — see `SharedRunAutoUpdater`.
 */
export async function readSharedRunMetadata(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<SharedRunMetadata | null> {
  const tabsFile = await readChatTabsFile(projectId, worktreeId);
  const tab = tabsFile.tabs.find((candidate) => candidate.id === chatId);
  return tab?.sharedRun ?? null;
}

export function isPersistedChatTab(value: unknown): value is PersistedChatTab {
  if (!isRecord(value)) {
    return false;
  }

  const id = value.id;
  const title = value.title;
  const messages = value.messages;
  const createdAt = value.createdAt;

  return (
    typeof id === 'string' &&
    typeof title === 'string' &&
    Array.isArray(messages) &&
    messages.every(isPersistedChatMessage) &&
    typeof createdAt === 'string' &&
    (value.trackedPlanImplementation === undefined ||
      value.trackedPlanImplementation === null ||
      TrackedPlanImplementationSchema.safeParse(value.trackedPlanImplementation)
        .success) &&
    (value.executionHarness === undefined ||
      value.executionHarness === 'cursor' ||
      value.executionHarness === 'copilot' ||
      value.executionHarness === 'antigravity' ||
      value.executionHarness === 'opencode' ||
      value.executionHarness === 'claude' ||
      value.executionHarness === 'codex')
  );
}

export function isChatTabsFile(value: unknown): value is ChatTabsFile {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    Array.isArray(value.tabs) &&
    value.tabs.every(isPersistedChatTab) &&
    typeof value.activeTabId === 'string'
  );
}
