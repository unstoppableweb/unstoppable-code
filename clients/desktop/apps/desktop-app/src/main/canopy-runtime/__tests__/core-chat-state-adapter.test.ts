import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import { queryPortalChatState } from '../../portal/adapters/chat-state-query';
import type { PortalAdapterContext } from '../../portal/adapters/types';
import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
  ChatSendMessageRequest,
  PersistedHostQueuedMessage,
} from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../desktop-runtime';
import { drainChatStateBeforeRuntimeShutdown } from '../chat-state-shutdown';

const snapshot: ChatStateSnapshot = {
  schemaVersion: 1,
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  revision: 7,
  tabsFile: {
    version: 1,
    activeTabId: 'chat-1',
    tabs: [
      {
        id: 'chat-1',
        title: 'First',
        createdAt: '2026-09-30T00:00:00.000Z',
        messages: [],
        unread: true,
        trackedPlanId: 'plan-1',
        trackedPlanImplementation: {
          planId: 'plan-1',
          revisionNumber: 2,
          userMessageId: 'implementation',
          startedAt: '2026-08-07T12:00:00.000Z',
          outcome: 'completed',
          endedAt: '2026-08-07T12:01:00.000Z',
        },
      },
      {
        id: 'file-1',
        title: 'Source',
        kind: 'file',
        filePath: '/private/worktree/source.ts',
        createdAt: '2026-09-30T01:00:00.000Z',
        messages: [],
      },
    ],
  },
  archives: [
    {
      chatId: 'archived-1',
      title: 'Archived',
      archivedAt: '2026-09-30T02:00:00.000Z',
      createdAt: '2026-09-29T02:00:00.000Z',
      turnCount: 1,
      unread: false,
      restorable: true,
    },
  ],
  runtimeByChatId: {
    'chat-1': { status: 'streaming', queuedMessageIds: ['queued-1'] },
  },
  queue: [
    {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      queue: [
        {
          id: 'queued-1',
          text: 'private prompt',
          attachmentPaths: ['/private/worktree/attachment.png'],
          origin: 'desktop',
          enqueuedAtMs: 7,
        },
      ],
    },
  ],
};

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.read' as const],
};

function createPort(): ChatStateCommandPort {
  return {
    getState: jest.fn().mockResolvedValue(snapshot),
    getTranscriptPage: jest.fn(),
    searchTranscript: jest.fn(),
    readVisual: jest.fn(),
    readToolOutput: jest.fn(),
    command: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => undefined),
  };
}

describe('core chat state read adapter', () => {
  it.each([false, true])(
    'keeps registered and Portal reads equivalent with durable turn present=%s',
    async (withTurn) => {
      const source = structuredClone(snapshot);
      if (withTurn)
        source.runtimeByChatId['chat-1'].turn = serializeChatTurnState(
          initialChatTurnState(),
        );
      const port = createPort();
      port.getState = jest.fn().mockResolvedValue(source);
      const runtime = createDesktopRuntime({ getChatStatePort: () => port });
      const context: PortalAdapterContext = {
        sessionId: 'turn-query-session',
        getWindow: () => null,
        enqueueEvent: jest.fn(),
        complete: jest.fn(),
        fail: jest.fn(),
      };
      try {
        const params = {
          scope: {
            workspaceId: source.projectId,
            worktreeId: source.worktreeId,
          },
        };
        const registered = await runtime.query(
          'core.chat.snapshot.get',
          params,
          { caller },
        );
        const legacy = await runtime.queryChatStateForLegacyIpc(params, {
          caller,
        });
        const portal = await queryPortalChatState(context, {
          projectId: source.projectId,
          worktreeId: source.worktreeId,
        });
        expect(registered).toEqual(legacy.canonicalResult);
        expect(registered.tabs.items[0]?.trackedPlanImplementation).toEqual(
          source.tabsFile.tabs[0]?.trackedPlanImplementation,
        );
        expect(portal).toEqual(legacy.legacyResult);
        expect(portal).toBe(source);
        expect(registered.runtimeByChatId['chat-1']).toEqual({
          status: 'streaming',
          queuedMessageIds: ['queued-1'],
        });
        expect(portal.runtimeByChatId['chat-1'].turn).toEqual(
          source.runtimeByChatId['chat-1'].turn,
        );
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it('projects custom names for live and archived chats without changing older title fallbacks', async () => {
    const port = createPort();
    jest.spyOn(port, 'getState').mockResolvedValue({
      ...snapshot,
      tabsFile: {
        ...snapshot.tabsFile,
        tabs: snapshot.tabsFile.tabs.map((tab) =>
          tab.id === 'chat-1' ? { ...tab, customTitle: 'My chat' } : tab,
        ),
      },
      archives: snapshot.archives.map((archive) => ({
        ...archive,
        customTitle: 'My archived chat',
      })),
    });
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });
    try {
      const result = await runtime.query(
        'core.chat.snapshot.get',
        {
          scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
        },
        { caller },
      );
      expect(result.tabs.items.map((tab) => tab.title)).toEqual([
        'My chat',
        'Source',
      ]);
      expect(result.archives[0]?.title).toBe('My archived chat');
      const list = await runtime.query(
        'core.chat.list',
        {
          scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
        },
        { caller },
      );
      expect(list.items.map((tab) => tab.title)).toEqual([
        'My chat',
        'My archived chat',
      ]);
    } finally {
      await runtime.shutdown();
    }
  });

  it('keeps dispatched legacy reads available while chat state drains on quit', async () => {
    const runtime = createDesktopRuntime({ getChatStatePort: createPort });
    let finishDrain: (() => void) | undefined;
    const drain = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDrain = resolve;
        }),
    );
    const shutdown = drainChatStateBeforeRuntimeShutdown(drain, () =>
      runtime.shutdown(),
    );
    await Promise.resolve();
    expect(drain).toHaveBeenCalledTimes(1);
    await expect(
      runtime.queryChatStateForLegacyIpc(
        { scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' } },
        { caller },
      ),
    ).resolves.toMatchObject({ canonicalResult: { revision: 7 } });
    finishDrain?.();
    await shutdown;
    await expect(
      runtime.queryChatStateForLegacyIpc(
        { scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' } },
        { caller },
      ),
    ).rejects.toThrow();
  });

  it('returns an exact legacy snapshot alongside a path-free canonical projection', async () => {
    const port = createPort();
    const getStateSpy = jest.spyOn(port, 'getState');
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });
    const result = await runtime.queryChatStateForLegacyIpc(
      { scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' } },
      { caller },
    );
    expect(result.legacyResult).toBe(snapshot);
    expect(result.canonicalResult).toMatchObject({
      revision: 7,
      tabs: {
        activeTabId: 'chat-1',
        items: [{ chatId: 'chat-1' }, { chatId: 'file-1' }],
      },
      queue: [{ chatId: 'chat-1', entries: [{ id: 'queued-1' }] }],
    });
    expect(JSON.stringify(result.canonicalResult)).not.toContain('/private/');
    // The web core's queued text, ids and state version (CAN-6509) are
    // optional: the desktop core leaves them out.
    expect(result.canonicalResult.queue).toEqual([
      {
        chatId: 'chat-1',
        entries: [
          { id: 'queued-1', origin: 'desktop', enqueuedAtMs: 7, revision: 1 },
        ],
      },
    ]);
    expect(getStateSpy).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await runtime.shutdown();
  });

  it('filters the snapshot while keeping its revision envelope and pages the tab list', async () => {
    const port = createPort();
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });
    const filtered = await runtime.query(
      'core.chat.snapshot.get',
      {
        scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
        chatId: 'chat-1',
      },
      { caller },
    );
    expect(filtered.revision).toBe(7);
    expect(filtered.tabs.items.map((item) => item.chatId)).toEqual(['chat-1']);
    const first = await runtime.query(
      'core.chat.list',
      {
        scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
        pageSize: 1,
      },
      { caller },
    );
    expect(first.items[0]).toMatchObject({
      chatId: 'chat-1',
      state: 'running',
      revision: 7,
    });
    expect(first.items[0]).not.toHaveProperty('updatedAt');
    expect(first.nextCursor).toBe('7:1');
    const second = await runtime.query(
      'core.chat.list',
      {
        scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
        pageSize: 1,
        cursor: first.nextCursor ?? undefined,
      },
      { caller },
    );
    expect(second.items).toMatchObject([
      { chatId: 'archived-1', state: 'archived' },
    ]);
    expect(second.nextCursor).toBeNull();
    for (const cursor of ['7:', ':0', '7:1.5', '7:NaN', '07:1']) {
      await expect(
        runtime.query(
          'core.chat.list',
          {
            scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
            cursor,
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    }
    await expect(
      runtime.query(
        'core.chat.list',
        {
          scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
          cursor: '6:1',
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'conflict' },
    });
    await runtime.shutdown();
  });

  it('filters evidenced internal runtime ids from portable snapshots without mutating state', async () => {
    const sourceSnapshot = structuredClone(snapshot);
    const target = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    const queuedMessage = (
      id: string,
      request: Pick<
        ChatSendMessageRequest,
        'internalRow' | 'managedDelegationDeliveryId'
      >,
    ): PersistedHostQueuedMessage => ({
      id,
      request: { ...target, userMessageId: id, text: id, ...request },
      origin: 'desktop',
      enqueuedAtMs: 1,
    });
    sourceSnapshot.runtimeByChatId['chat-1'] = {
      status: 'streaming',
      queuedMessageIds: [
        'internal-row',
        'legacy-row',
        'visible-row',
        'unknown-row',
      ],
      queuedMessages: [
        queuedMessage('internal-row', {
          managedDelegationDeliveryId: 'internal-row',
          internalRow: {
            kind: 'delegation-request',
            delegationId: 'delegate-1',
            displayLine: 'Waiting for parent input',
          },
        }),
        queuedMessage('legacy-row', {
          managedDelegationDeliveryId: 'legacy-delivery',
        }),
        queuedMessage('visible-row', {}),
      ],
    };
    const port = createPort();
    jest.spyOn(port, 'getState').mockResolvedValue(sourceSnapshot);
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });

    const projected = await runtime.query(
      'core.chat.snapshot.get',
      {
        scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
        chatId: 'chat-1',
      },
      { caller },
    );

    expect(projected.runtimeByChatId['chat-1']?.queuedMessageIds).toEqual([
      'visible-row',
      'unknown-row',
    ]);
    expect(sourceSnapshot.runtimeByChatId['chat-1']?.queuedMessageIds).toEqual([
      'internal-row',
      'legacy-row',
      'visible-row',
      'unknown-row',
    ]);
    await runtime.shutdown();
  });

  it('keeps legacy-valid long titles and date-only timestamps readable', async () => {
    const legacy = structuredClone(snapshot);
    const longTitle = 'x'.repeat(513);
    legacy.tabsFile.tabs[0].title = longTitle;
    legacy.tabsFile.tabs[0].createdAt = '2026-09-05';
    legacy.archives[0].title = longTitle;
    legacy.archives[0].createdAt = '2026-09-04';
    legacy.archives[0].archivedAt = '2026-09-05';
    const port = createPort();
    port.getState = jest.fn().mockResolvedValue(legacy);
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });
    const read = await runtime.queryChatStateForLegacyIpc(
      { scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' } },
      { caller },
    );
    expect(read.legacyResult).toBe(legacy);
    expect(read.canonicalResult.tabs.items[0]).toMatchObject({
      title: longTitle,
      createdAt: '2026-09-05',
    });
    const list = await runtime.query(
      'core.chat.list',
      { scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' } },
      { caller },
    );
    expect(list.items.map((item) => item.title)).toEqual([
      longTitle,
      longTitle,
    ]);
    await runtime.shutdown();
  });

  it('refuses revision 2 of a snapshot before reading the local port (CAN-6509)', async () => {
    const port = createPort();
    const getStateSpy = jest.spyOn(port, 'getState');
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });
    await expect(
      runtime.query(
        'core.chat.snapshot.get',
        {
          scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
          revision: 2,
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { unsupported: ['revision'], reason: 'unserved' },
      },
    });
    expect(getStateSpy).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it('rejects an explicit foreign target before reading the local port', async () => {
    const port = createPort();
    const getStateSpy = jest.spyOn(port, 'getState');
    const runtime = createDesktopRuntime({ getChatStatePort: () => port });
    await expect(
      runtime.query(
        'core.chat.snapshot.get',
        {
          scope: {
            workspaceId: 'project-1',
            worktreeId: 'worktree-1',
            targetId: 'remote-target',
          },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
    expect(getStateSpy).not.toHaveBeenCalled();
    await runtime.shutdown();
  });
});
