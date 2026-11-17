import type {
  ChatStateCommandPort,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  CoreChatArchiveParamsSchema,
  CoreChatDeleteParamsSchema,
} from '@canopy/protocol/canopy-core';
import type { ChatArchiveTarget } from '../lib/chat-archive-bookkeeping';
import { logMainProcessError } from '../lib/main-process-logging';
import { revokeClosedChatSecrets } from '../agent-secrets/lifecycle';
import type { createCoreChatCommandAdapter } from './core-chat-command-adapter';

/** Bookkeeping after a committed core archive or restore (CAN-4113 D4). */
export interface CoreChatArchiveEffects {
  archived(
    target: ChatArchiveTarget,
    archive: { archivedAt: string; keepSession: boolean },
  ): Promise<void>;
  restored(
    scope: { projectId: string; worktreeId: string },
    tab: PersistedChatTab,
  ): Promise<void>;
}

/** The desktop bookkeeping, loaded on first use. Each step logs and never throws. */
export function createDesktopChatArchiveEffects(): CoreChatArchiveEffects {
  const step = async (
    name: string,
    target: { worktreeId: string; chatId: string },
    run: () => Promise<void> | void,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      logMainProcessError(
        '[core.chat.archive] ' +
          name +
          ' failed for ' +
          target.worktreeId +
          '/' +
          target.chatId +
          ':',
        error,
      );
    }
  };
  return {
    archived: async (target, { archivedAt, keepSession }) => {
      const bookkeeping = await import('../lib/chat-archive-bookkeeping');
      await step('Ledger handback', target, () =>
        bookkeeping.recordChatArchived(target, archivedAt),
      );
      if (keepSession) return;
      await step('Deferred-tools reload cancel', target, () =>
        bookkeeping.cancelArchivedChatDeferredToolsReload(target),
      );
      await step('Delegate watcher removal', target, () =>
        bookkeeping.removeArchivedChatDelegateWatchers(target),
      );
    },
    restored: async (scope, tab) => {
      const bookkeeping = await import('../lib/chat-archive-bookkeeping');
      await step(
        'Search index restore',
        { worktreeId: scope.worktreeId, chatId: tab.id },
        () => bookkeeping.recordChatRestored(scope, tab),
      );
    },
  };
}

type ChatCommandAdapter = ReturnType<typeof createCoreChatCommandAdapter>;
type ChatLifecycleResult = Awaited<
  ReturnType<ChatCommandAdapter['instructions']['core.chat.archive']>
>;
type ArchiveOrDeleteParams =
  | ReturnType<typeof CoreChatArchiveParamsSchema.parse>
  | ReturnType<typeof CoreChatDeleteParamsSchema.parse>;

/**
 * The command adapter with `core.chat.archive` and `core.chat.delete` wrapped
 * so a committed archive or restore runs its bookkeeping. `effects: null`
 * returns the adapter unchanged.
 */
export function withChatArchiveEffects(
  adapter: ChatCommandAdapter,
  getPort: () => ChatStateCommandPort | null,
  effects: CoreChatArchiveEffects | null,
): ChatCommandAdapter {
  if (effects === null) return adapter;

  const runBookkeeping = async (
    parsed: ArchiveOrDeleteParams,
    result: ChatLifecycleResult,
  ): Promise<void> => {
    try {
      if (result.outcome !== 'applied' && result.outcome !== 'already_applied')
        return;
      const { action } = parsed;
      const archived: { chatId: string; keepSession: boolean }[] = [];
      // Discarded chats leave no archive entry but still close.
      const discarded: string[] = [];
      let restoreId: string | undefined;
      switch (action.type) {
        case 'chat.archive_tab':
          archived.push({
            chatId: action.tabId,
            keepSession: action.keepSession === true,
          });
          break;
        case 'chat.close_tab':
          if (action.mode !== 'discard')
            archived.push({ chatId: action.tabId, keepSession: false });
          else discarded.push(action.tabId);
          break;
        case 'chat.close_tabs':
          for (const target of action.targets) {
            if (target.mode !== 'discard')
              archived.push({ chatId: target.tabId, keepSession: false });
            else discarded.push(target.tabId);
          }
          break;
        case 'chat.restore_archive':
          restoreId = action.targetTabId ?? action.archiveEntryId;
          break;
      }
      if (
        archived.length === 0 &&
        discarded.length === 0 &&
        restoreId === undefined
      )
        return;
      const port = getPort();
      if (!port) return;
      const { projectId, worktreeId } = parsed;
      const snapshot = await port.getState({ projectId, worktreeId });
      const isOpen = (chatId: string): boolean =>
        snapshot.tabsFile.tabs.some((candidate) => candidate.id === chatId);
      // A discarded or archived chat's agent secrets go with it, whatever the
      // archive keeps (CONTRACTS.md §8). Like the bookkeeping below, a chat
      // open again (restored after a replayed command) keeps its secrets.
      for (const chatId of discarded)
        if (!isOpen(chatId))
          await revokeClosedChatSecrets({ projectId, worktreeId, chatId });
      for (const { chatId, keepSession } of archived) {
        const entry = snapshot.archives.find(
          (archive) => archive.chatId === chatId,
        );
        if (
          !entry ||
          snapshot.tabsFile.tabs.some((candidate) => candidate.id === chatId)
        )
          continue;
        // A restore and a newer archive may commit before this read; that
        // archive runs its own bookkeeping. A receipt written before
        // CAN-5848 carries no archivedAt and stays unfenced.
        if (
          result.archivedAt !== undefined &&
          entry.archivedAt !== result.archivedAt
        )
          continue;
        await revokeClosedChatSecrets({ projectId, worktreeId, chatId });
        // A replay may follow a restore and a newer archive with other
        // settings, so it reruns only the keyed handback and the index.
        await effects.archived(
          { projectId, worktreeId, chatId },
          {
            archivedAt: entry.archivedAt,
            keepSession: keepSession || result.outcome === 'already_applied',
          },
        );
      }
      if (restoreId !== undefined) {
        const tab =
          snapshot.tabsFile.tabs.find(
            (candidate) => candidate.id === restoreId,
          ) ??
          (result.entityId
            ? snapshot.tabsFile.tabs.find(
                (candidate) => candidate.id === result.entityId,
              )
            : undefined);
        if (tab) await effects.restored({ projectId, worktreeId }, tab);
      }
    } catch (error) {
      logMainProcessError(
        '[core.chat.archive] Archive bookkeeping failed',
        error,
      );
    }
  };

  const archive = async (params: unknown): Promise<ChatLifecycleResult> => {
    const parsed = CoreChatArchiveParamsSchema.parse(params);
    const result = await adapter.instructions['core.chat.archive'](params);
    await runBookkeeping(parsed, result);
    return result;
  };
  const remove = async (params: unknown): Promise<ChatLifecycleResult> => {
    const parsed = CoreChatDeleteParamsSchema.parse(params);
    const result = await adapter.instructions['core.chat.delete'](params);
    await runBookkeeping(parsed, result);
    return result;
  };
  return {
    ...adapter,
    instructions: {
      ...adapter.instructions,
      'core.chat.archive': archive,
      'core.chat.delete': remove,
    },
  };
}
