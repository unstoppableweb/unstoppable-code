import type {
  ArchivedChatsFile,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';
import { chatDisplayLabel } from '@canopy/desktop-shared/lib/chat-display-label';
import {
  CoreChatDirectoryListResultSchema,
  type CanopyCallerDescriptor,
  type CoreChatDirectoryListParams,
} from '@canopy/protocol/canopy-core';
import type { CoreChatDirectoryHost } from '../core-chat-directory-adapter';
import { createDesktopRuntime } from '../desktop-runtime';

const readTabs = jest.fn<
  ReturnType<CoreChatDirectoryHost['readTabs']>,
  Parameters<CoreChatDirectoryHost['readTabs']>
>();
const readArchives = jest.fn<
  ReturnType<CoreChatDirectoryHost['readArchives']>,
  Parameters<CoreChatDirectoryHost['readArchives']>
>();

const reader: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test',
  grants: ['core.chat.read'],
};

const scope = { workspaceId: 'project-1', worktreeId: 'worktree-1' };

// Fixtures carry only the fields the read uses, plus the host paths it must drop.
function tabsFile(tabs: readonly Record<string, unknown>[]): ChatTabsFile {
  return { version: 1, tabs } as unknown as ChatTabsFile;
}

function archivesFile(ids: readonly string[]): ArchivedChatsFile {
  return {
    version: 1,
    archived: ids.map((id) => ({ tab: { id } })),
  } as unknown as ArchivedChatsFile;
}

const FIX_X_AT = Date.parse('2026-11-20T10:00:00.000Z');

function seed(): void {
  readTabs.mockResolvedValue(
    tabsFile([
      {
        id: 'chat-1',
        kind: 'chat',
        title: 'New chat',
        description: 'Fix X',
        createdAt: '2026-11-19T09:00:00.000Z',
        transcript: { lastMessageAt: FIX_X_AT },
        filePath: '/Users/someone/project/notes.md',
        pendingRevertAttachmentPath: '/Users/someone/.canopy/attach.bin',
      },
      {
        id: 'chat-2',
        kind: 'chat',
        title: 'Release notes',
        customTitle: 'Ship it',
        createdAt: '2026-11-19T11:00:00.000Z',
      },
      {
        id: 'file-1',
        kind: 'file',
        title: 'notes.md',
        filePath: '/Users/someone/project/notes.md',
        createdAt: '2026-11-19T12:00:00.000Z',
      },
    ]),
  );
  readArchives.mockResolvedValue(archivesFile(['chat-9']));
}

const ALLOWED_KEYS = new Set([
  'chatId',
  'title',
  'customTitle',
  'description',
  'createdAt',
  'lastActivityAt',
]);

async function list(
  caller: CanopyCallerDescriptor = reader,
  params: CoreChatDirectoryListParams = { scope },
): Promise<unknown> {
  const runtime = createDesktopRuntime({
    chatDirectoryHost: { readTabs, readArchives },
  });
  try {
    return await runtime.query('core.chat.directory.list', params, {
      caller,
    });
  } finally {
    await runtime.shutdown();
  }
}

describe('core.chat.directory.list (CAN-7693)', () => {
  beforeEach(() => {
    readTabs.mockReset();
    readArchives.mockReset();
  });

  it('lists live chats without file tabs and the archived chat ids', async () => {
    seed();
    const result = CoreChatDirectoryListResultSchema.parse(await list());
    expect(result.live.map((chat) => chat.chatId)).toEqual([
      'chat-1',
      'chat-2',
    ]);
    expect(result.archivedChatIds).toEqual(['chat-9']);
    expect(readTabs).toHaveBeenCalledWith('project-1', 'worktree-1');
    expect(readArchives).toHaveBeenCalledWith('project-1', 'worktree-1');
  });

  it('returns name fields only, never a host path', async () => {
    seed();
    const result = CoreChatDirectoryListResultSchema.parse(await list());
    for (const chat of result.live) {
      for (const key of Object.keys(chat)) expect(ALLOWED_KEYS).toContain(key);
    }
    expect(JSON.stringify(result)).not.toContain('/Users/');
  });

  it("gives the Agent Ledger's label for each chat", async () => {
    seed();
    const result = CoreChatDirectoryListResultSchema.parse(await list());
    const labels = result.live.map((chat) =>
      chatDisplayLabel({
        title: chat.title,
        customTitle: chat.customTitle,
        description: chat.description,
        fallback: '',
      }),
    );
    expect(labels).toEqual(['Fix X', 'Ship it']);
  });

  it('reports the last message time, and none for a chat without messages', async () => {
    seed();
    const result = CoreChatDirectoryListResultSchema.parse(await list());
    expect(result.live[0]).toMatchObject({
      createdAt: '2026-11-19T09:00:00.000Z',
      lastActivityAt: '2026-11-20T10:00:00.000Z',
    });
    expect(result.live[1]).not.toHaveProperty('lastActivityAt');
  });

  it('fails an unreadable scope as unavailable, never as an empty one', async () => {
    readTabs.mockRejectedValue(new Error('EACCES: chat_storage_v2'));
    readArchives.mockResolvedValue(archivesFile([]));
    await expect(list()).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'core.chat.directory.list.unavailable',
        retry: { kind: 'same_request', delayMs: 1000 },
      },
    });
  });

  it('refuses a remote target and a caller without core.chat.read', async () => {
    seed();
    await expect(
      list(reader, { scope: { ...scope, targetId: 't' } }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    await expect(
      list({ ...reader, grants: ['core.chat.write'] }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(readTabs).not.toHaveBeenCalled();
  });
});
