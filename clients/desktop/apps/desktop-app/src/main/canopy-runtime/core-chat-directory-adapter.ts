import type {
  ArchivedChatsFile,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';
import type {
  CanopyQueryHandlerMap,
  CanopyQueryResult,
  CoreChatDirectoryEntry,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  canopyCapabilityUnavailableError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/** Where a scope's chats are read; defaults to Electron main's chat state. */
export interface CoreChatDirectoryHost {
  readTabs(projectId: string, worktreeId: string): Promise<ChatTabsFile>;
  readArchives(
    projectId: string,
    worktreeId: string,
  ): Promise<ArchivedChatsFile>;
}

export function createDesktopChatDirectoryHost(): CoreChatDirectoryHost {
  return {
    readTabs: async (projectId, worktreeId) => {
      const { readChatTabsFile } = await import('../lib/chat-tabs-reader');
      return readChatTabsFile(projectId, worktreeId);
    },
    readArchives: async (projectId, worktreeId) => {
      const { readChatArchivesFile } = await import('../lib/chat-archives');
      return readChatArchivesFile(projectId, worktreeId);
    },
  };
}

function directoryEntry(
  tab: ChatTabsFile['tabs'][number],
): CoreChatDirectoryEntry {
  const lastMessageAt = tab.transcript?.lastMessageAt;
  return {
    chatId: tab.id,
    title: tab.title,
    ...(typeof tab.customTitle === 'string'
      ? { customTitle: tab.customTitle }
      : {}),
    ...(typeof tab.description === 'string'
      ? { description: tab.description }
      : {}),
    createdAt: typeof tab.createdAt === 'string' ? tab.createdAt : null,
    ...(typeof lastMessageAt === 'number' && Number.isFinite(lastMessageAt)
      ? { lastActivityAt: new Date(lastMessageAt).toISOString() }
      : {}),
  };
}

export function createCoreChatDirectoryAdapter(
  host: CoreChatDirectoryHost = createDesktopChatDirectoryHost(),
): Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  'core.chat.directory.list'
> {
  return {
    'core.chat.directory.list': async (
      params,
    ): Promise<CanopyQueryResult<'core.chat.directory.list'>> => {
      if (
        params.scope.targetId !== undefined ||
        (params.scope.authorityId !== undefined &&
          params.scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
      ) {
        throw canopyCapabilityUnavailableError(
          'The selected chat authority or target is unavailable.',
        );
      }
      const { workspaceId, worktreeId } = params.scope;
      let tabs: ChatTabsFile;
      let archives: ArchivedChatsFile;
      try {
        [tabs, archives] = await Promise.all([
          host.readTabs(workspaceId, worktreeId),
          host.readArchives(workspaceId, worktreeId),
        ]);
      } catch (error) {
        throw new CanopyOperationError(
          {
            kind: 'unavailable',
            code: 'core.chat.directory.list.unavailable',
            message: 'Chats cannot be read right now.',
            retry: { kind: 'same_request', delayMs: 1000 },
          },
          error,
        );
      }
      return {
        live: tabs.tabs
          .filter((tab) => tab.kind !== 'file')
          .map(directoryEntry),
        archivedChatIds: archives.archived.map((entry) => entry.tab.id),
      };
    },
  };
}
