import { initialChatTurnState } from '@canopy/agent-transcript/turn';
import type { PersistedChatTurnState } from '@canopy/agent-transcript/turn';
import type {
  ApprovalRule,
  ChatRuntimeState,
  ChatSendMessageRequest,
  ChatStateChange,
  ChatStateChangedEvent,
  ChatStateCommandPort,
  PersistedHostQueuedMessage,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type {
  CanopyStreamEnd,
  CanopyStreamItem,
} from '@canopy/protocol/canopy-core';
import type { CanopyStreamFrame } from '@canopy/core-runtime';
import { createDesktopRuntime } from '../desktop-runtime';

type ChatFrame = CanopyStreamFrame<
  CanopyStreamItem<'core.chat.events'>,
  CanopyStreamEnd<'core.chat.events'>
>;

async function nextFrame(frames: AsyncIterator<ChatFrame>): Promise<ChatFrame> {
  const result = await frames.next();
  if (result.done) throw new Error('Stream ended before the terminal frame.');
  return result.value;
}

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'electron-main-chat-push',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.read' as const],
};

function persistedTurnState(): PersistedChatTurnState {
  const { cursors, ...persistedState } = initialChatTurnState();
  void cursors;
  return persistedState;
}

function makeHarness(): {
  runtime: ReturnType<typeof createDesktopRuntime>;
  subscribe: ChatStateCommandPort['subscribe'];
  listeners: Set<(event: ChatStateChangedEvent) => void>;
  emit: (revision: number) => ChatStateChangedEvent;
} {
  const listeners = new Set<(event: ChatStateChangedEvent) => void>();
  const subscribe = jest.fn(
    (listener: (event: ChatStateChangedEvent) => void): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  );
  const port: ChatStateCommandPort = {
    getState: jest.fn(),
    getTranscriptPage: jest.fn(),
    searchTranscript: jest.fn(),
    readToolOutput: jest.fn(),
    readVisual: jest.fn(),
    command: jest.fn(),
    subscribe,
  };
  const runtime = createDesktopRuntime({ getChatStatePort: () => port });
  const emit = (revision: number): ChatStateChangedEvent => {
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: `event-${revision}`,
      occurredAt: '2026-09-30T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: revision - 1,
      revision,
      changes: [{ type: 'tab.removed', tabId: `tab-${revision}` }],
    };
    Array.from(listeners).forEach((listener) => {
      listener(event);
    });
    return event;
  };
  return { runtime, subscribe, listeners, emit };
}

describe('core.chat.events desktop stream', () => {
  it.each([null, { version: 2, credentials: 'private-future-field' }])(
    'omits unsupported MCP display records without losing the batch or legacy event (%j)',
    async (record) => {
      const { runtime, listeners } = makeHarness();
      const opened = await runtime.openChatEventsForLegacyIpc(
        { scope: 'all' },
        { caller },
      );
      try {
        const message: PersistedChatMessage = {
          id: 'recovery-message',
          role: 'system',
          timestamp: 1,
          blocks: [
            { type: 'text', text: 'Readable history' },
            { type: 'mcp_activation', record },
          ],
        };
        const event: ChatStateChangedEvent = {
          schemaVersion: 1,
          eventId: 'recovery-event',
          occurredAt: '2026-10-16T00:00:00.000Z',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          baseRevision: 0,
          revision: 1,
          changes: [
            { type: 'message.upserted', chatId: 'chat-1', message },
            {
              type: 'messages.replaced',
              chatId: 'chat-1',
              messages: [message],
              removedMessageIds: [],
            },
            {
              type: 'tab.upserted',
              tab: {
                id: 'chat-1',
                title: 'Recovery',
                messages: [message],
                createdAt: '2026-10-16T00:00:00.000Z',
              },
            },
          ],
        };
        listeners.forEach((listener) => listener(event));
        const frame = await nextFrame(
          opened.handle.frames[Symbol.asyncIterator](),
        );
        if (frame.kind !== 'item')
          throw new Error('Expected a chat event item.');
        const projected = { ...message, blocks: [message.blocks[0]] };
        expect(frame.item).toMatchObject({
          revision: 1,
          changes: [
            { type: 'message.upserted', message: projected },
            { type: 'messages.replaced', messages: [projected] },
            { type: 'tab.upserted', tab: { messages: [projected] } },
          ],
        });
        expect(opened.takeLegacyEvent(frame.cursor)).toBe(event);
        expect(message.blocks[1]).toEqual({ type: 'mcp_activation', record });
      } finally {
        opened.handle.close();
        await runtime.shutdown();
      }
    },
  );

  it('refuses revision 2 before subscribing (CAN-6509)', async () => {
    const { runtime, subscribe } = makeHarness();
    try {
      for (const scope of [
        'all' as const,
        { projectId: 'project-1', worktreeId: 'worktree-1' },
      ]) {
        const stream = await runtime.openStream(
          'core.chat.events',
          { scope, revision: 2 },
          { caller },
        );
        try {
          // The refusal ends the stream; nothing was read for it.
          expect(
            await nextFrame(stream.frames[Symbol.asyncIterator]()),
          ).toMatchObject({
            kind: 'end',
            error: {
              kind: 'capability_unavailable',
              details: { unsupported: ['revision'], reason: 'unserved' },
            },
          });
        } finally {
          stream.close();
        }
      }
      expect(subscribe).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
    }
  });

  it('carries custom title set and clear patches through the portable event stream', async () => {
    const { runtime, listeners } = makeHarness();
    const stream = await runtime.openStream(
      'core.chat.events',
      { scope: 'all' },
      { caller },
    );
    try {
      const frames = stream.frames[Symbol.asyncIterator]();
      let revision = 0;
      for (const customTitle of ['My chat', null]) {
        revision += 1;
        const event: ChatStateChangedEvent = {
          schemaVersion: 1,
          eventId: `rename-${revision}`,
          occurredAt: '2026-09-30T00:00:00.000Z',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          baseRevision: revision - 1,
          revision,
          changes: [
            {
              type: 'tab.metadata_patched',
              tabId: 'chat-1',
              patch: { customTitle },
            },
          ],
        };
        listeners.forEach((listener) => listener(event));
        expect(await nextFrame(frames)).toMatchObject({
          kind: 'item',
          item: { changes: [{ patch: { customTitle } }] },
        });
      }
    } finally {
      stream.close();
      await runtime.shutdown();
    }
  });
  it('replays batches committed while only another scope was subscribed', async () => {
    const { runtime, emit } = makeHarness();
    const scopedCaller = { ...caller, clientInstanceId: 'scoped-consumer' };
    const other = await runtime.openStream(
      'core.chat.events',
      { scope: { projectId: 'project-2', worktreeId: 'worktree-2' } },
      { caller: scopedCaller },
    );
    const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };
    const first = await runtime.openStream(
      'core.chat.events',
      { scope },
      { caller: scopedCaller },
    );
    emit(1);
    const frame = await nextFrame(first.frames[Symbol.asyncIterator]());
    if (frame.kind !== 'item') throw new Error('Expected a chat event item.');
    first.close();
    await Promise.resolve();
    emit(2);
    const replayed: ChatFrame[] = [];
    const resumed = await runtime.openStream(
      'core.chat.events',
      { scope, cursor: frame.cursor },
      { caller: scopedCaller, onFrame: (item) => replayed.push(item) },
    );
    expect(replayed).toMatchObject([{ kind: 'item', item: { revision: 2 } }]);
    emit(3);
    expect(replayed).toMatchObject([
      { kind: 'item', item: { revision: 2 } },
      { kind: 'item', item: { revision: 3 } },
    ]);
    resumed.close();
    other.close();
    await runtime.shutdown();
  });

  it('filters scoped subscriptions before emission and replay', async () => {
    const { runtime, listeners } = makeHarness();
    const scopedCaller = { ...caller, clientInstanceId: 'scoped-consumer' };
    const scoped = await runtime.openStream(
      'core.chat.events',
      { scope: { projectId: 'project-1', worktreeId: 'worktree-1' } },
      { caller: scopedCaller },
    );
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'scoped-event',
      occurredAt: '2026-09-30T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [{ type: 'tab.removed', tabId: 'tab-1' }],
    };
    listeners.forEach((listener) => listener({ ...event, projectId: 'other' }));
    listeners.forEach((listener) => listener(event));
    const frame = await nextFrame(scoped.frames[Symbol.asyncIterator]());
    expect(frame).toMatchObject({
      kind: 'item',
      item: { projectId: 'project-1' },
    });
    if (frame.kind !== 'item') throw new Error('Expected a scoped item.');
    const otherScope = await runtime.openStream(
      'core.chat.events',
      {
        scope: { projectId: 'other', worktreeId: 'worktree-1' },
        cursor: frame.cursor,
      },
      { caller: scopedCaller },
    );
    expect(
      await nextFrame(otherScope.frames[Symbol.asyncIterator]()),
    ).toMatchObject({
      kind: 'end',
      error: { code: 'core.chat.snapshotRequired' },
    });
    scoped.close();
    otherScope.close();
    await runtime.shutdown();
  });

  it('preserves each revisioned batch and replays after an in-window cursor', async () => {
    const { runtime, emit, subscribe } = makeHarness();
    const first = await runtime.openChatEventsForLegacyIpc(
      { scope: 'all' },
      { caller },
    );
    expect(first.handle.openResult).toEqual({
      subscriptionId: first.handle.requestId,
      acceptedCursor: null,
    });
    expect(subscribe).toHaveBeenCalledTimes(1);
    const firstFrames = first.handle.frames[Symbol.asyncIterator]();
    const direct = [emit(1), emit(2)];
    const frame1 = await nextFrame(firstFrames);
    const frame2 = await nextFrame(firstFrames);
    if (frame1.kind !== 'item' || frame2.kind !== 'item')
      throw new Error('Expected two chat event items.');
    expect(first.takeLegacyEvent(frame1.cursor)).toBe(direct[0]);
    expect(first.takeLegacyEvent(frame2.cursor)).toBe(direct[1]);
    expect(frame2.item).toMatchObject({
      baseRevision: 1,
      revision: 2,
      changes: direct[1].changes,
    });
    const resumed = await runtime.openChatEventsForLegacyIpc(
      { scope: 'all', cursor: frame1.cursor },
      { caller },
    );
    const resumedFrame = await nextFrame(
      resumed.handle.frames[Symbol.asyncIterator](),
    );
    expect(resumed.handle.openResult.acceptedCursor).toEqual(frame1.cursor);
    expect(resumedFrame).toMatchObject({
      kind: 'item',
      item: { eventId: direct[1].eventId, revision: 2 },
    });
    resumed.handle.close();
    first.handle.close();
    await runtime.shutdown();
  });

  it('streams an aggregate revision as one portable event with one cursor', async () => {
    const { runtime, listeners } = makeHarness();
    const scopedCaller = { ...caller, clientInstanceId: 'aggregate-consumer' };
    const opened = await runtime.openStream(
      'core.chat.events',
      { scope: { projectId: 'project-1', worktreeId: 'worktree-1' } },
      { caller: scopedCaller },
    );
    const changes: ChatStateChange[] = [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'growing text 1' }],
          timestamp: 1,
        },
      },
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'growing text 2' }],
          timestamp: 1,
        },
      },
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'final content' }],
          timestamp: 1,
        },
      },
      {
        type: 'runtime.patched',
        chatId: 'chat-1',
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          lastActivityAt: 10,
        },
      },
      {
        type: 'runtime.patched',
        chatId: 'chat-1',
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          lastActivityAt: 11,
        },
      },
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'assistant-2',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'new row' }],
          timestamp: 2,
        },
      },
    ];
    const aggregate: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'aggregate-event',
      occurredAt: '2026-09-30T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 40,
      revision: 41,
      changes,
    };

    listeners.forEach((listener) => listener(aggregate));
    const frame = await nextFrame(opened.frames[Symbol.asyncIterator]());
    if (frame.kind !== 'item') throw new Error('Expected a chat event item.');

    expect(frame.item).toMatchObject({
      schemaVersion: 1,
      eventId: 'aggregate-event',
      baseRevision: 40,
      revision: 41,
      changes,
    });
    expect(frame.item.changes).toEqual(changes);
    expect(frame.item.changes[2]).toMatchObject({
      type: 'message.upserted',
      message: {
        id: 'assistant-1',
        blocks: [{ type: 'text', text: 'final content' }],
      },
    });
    expect(frame.cursor).toMatchObject({ sequence: 41 });

    opened.close();
    await runtime.shutdown();
  });

  it('accepts cursors issued to another subscriber and during replay', async () => {
    const { runtime, emit } = makeHarness();
    const first = await runtime.openChatEventsForLegacyIpc(
      { scope: 'all' },
      { caller },
    );
    const otherCaller = { ...caller, clientInstanceId: 'other-consumer' };
    const second = await runtime.openStream(
      'core.chat.events',
      { scope: 'all' },
      { caller: otherCaller },
    );
    emit(1);
    emit(2);
    const firstFrames = first.handle.frames[Symbol.asyncIterator]();
    const secondFrames = second.frames[Symbol.asyncIterator]();
    await nextFrame(firstFrames);
    const firstSecond = await nextFrame(firstFrames);
    const secondFirst = await nextFrame(secondFrames);
    await nextFrame(secondFrames);
    if (firstSecond.kind !== 'item' || secondFirst.kind !== 'item')
      throw new Error('Expected chat event items.');
    const resumed = await runtime.openStream(
      'core.chat.events',
      { scope: 'all', cursor: secondFirst.cursor },
      { caller: otherCaller },
    );
    const replay = await nextFrame(resumed.frames[Symbol.asyncIterator]());
    if (replay.kind !== 'item') throw new Error('Expected replay item.');
    emit(3);
    const replayResumed = await runtime.openStream(
      'core.chat.events',
      { scope: 'all', cursor: replay.cursor },
      { caller: otherCaller },
    );
    expect(
      await nextFrame(replayResumed.frames[Symbol.asyncIterator]()),
    ).toMatchObject({
      kind: 'item',
      item: { revision: 3 },
    });
    replayResumed.close();
    resumed.close();
    second.close();
    first.handle.close();
    await runtime.shutdown();
  });

  it('accepts a cursor resumed from inside its onFrame listener', async () => {
    const { runtime, emit } = makeHarness();
    const subscriber = { ...caller, clientInstanceId: 'reentrant-consumer' };
    const resumedFrames: ChatFrame[] = [];
    let resumedPromise: ReturnType<typeof runtime.openStream> | undefined;
    const first = await runtime.openStream(
      'core.chat.events',
      { scope: 'all' },
      {
        caller: subscriber,
        onFrame: (frame) => {
          if (frame.kind === 'item' && !resumedPromise) {
            resumedPromise = runtime.openStream(
              'core.chat.events',
              { scope: 'all', cursor: frame.cursor },
              {
                caller: subscriber,
                onFrame: (item) => resumedFrames.push(item),
              },
            );
          }
        },
      },
    );
    emit(1);
    const resumed = await resumedPromise;
    if (!resumed) throw new Error('Expected a reentrant subscription.');
    emit(2);
    expect(resumedFrames).toMatchObject([
      { kind: 'item', item: { revision: 2 } },
    ]);
    resumed.close();
    first.close();
    await runtime.shutdown();
  });

  it('bounds replay cursor aliases for retained batches', async () => {
    const { runtime, emit } = makeHarness();
    const live = await runtime.openChatEventsForLegacyIpc(
      { scope: 'all' },
      { caller },
    );
    emit(1);
    emit(2);
    const frames = live.handle.frames[Symbol.asyncIterator]();
    const first = await nextFrame(frames);
    const second = await nextFrame(frames);
    if (first.kind !== 'item' || second.kind !== 'item')
      throw new Error('Expected chat event items.');
    const otherCaller = { ...caller, clientInstanceId: 'other-consumer' };
    for (let index = 0; index < 130; index += 1) {
      const replay = await runtime.openStream(
        'core.chat.events',
        { scope: 'all', cursor: first.cursor },
        { caller: otherCaller },
      );
      expect(
        await nextFrame(replay.frames[Symbol.asyncIterator]()),
      ).toMatchObject({
        kind: 'item',
        item: { revision: 2 },
      });
      replay.close();
    }
    const expired = await runtime.openStream(
      'core.chat.events',
      { scope: 'all', cursor: second.cursor },
      { caller: otherCaller },
    );
    expect(
      await nextFrame(expired.frames[Symbol.asyncIterator]()),
    ).toMatchObject({
      kind: 'end',
      error: { code: 'core.chat.snapshotRequired' },
    });
    live.handle.close();
    await runtime.shutdown();
  });

  it('forwards large batches and undefined optional fields', async () => {
    const { runtime, listeners } = makeHarness();
    const opened = await runtime.openChatEventsForLegacyIpc(
      { scope: 'all' },
      { caller },
    );
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'large-event',
      occurredAt: '2026-09-30T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [
        {
          type: 'tab.order_changed',
          tabIds: Array.from({ length: 4000 }, (_, i) => `tab-${i}`),
        },
        {
          type: 'tab.active_changed',
          activeTabId: 'tab-1',
          lastActiveEditableChatId: undefined,
        },
      ],
    };
    listeners.forEach((listener) => listener(event));
    const frame = await nextFrame(opened.handle.frames[Symbol.asyncIterator]());
    expect(frame).toMatchObject({ kind: 'item', item: event });
    if (frame.kind !== 'item') throw new Error('Expected a chat event item.');
    expect(opened.takeLegacyEvent(frame.cursor)).toBe(event);
    opened.handle.close();
    await runtime.shutdown();
  });

  it('projects host paths out of the stream while retaining the exact legacy event', async () => {
    const { runtime, listeners } = makeHarness();
    const opened = await runtime.openChatEventsForLegacyIpc(
      { scope: 'all' },
      { caller },
    );
    const pathMessage: PersistedChatMessage = {
      id: 'message-1',
      role: 'user',
      blocks: [
        { type: 'image', path: '/private/repo/image.png', alt: 'image' },
        {
          type: 'file_references',
          references: [
            {
              displayPath: '/private/repo/file.ts',
              absolutePath: '/private/repo/file.ts',
            },
          ],
        },
        {
          type: 'compaction_info',
          timestamp: 1,
          provider: 'claude',
          interfaceMode: 'canopy',
          transcriptPath: '/private/repo/transcript.json',
        },
      ],
      timestamp: 1,
      attachmentPaths: ['/private/repo/attachment.txt'],
      attachmentPromptContexts: [
        {
          attachmentPath: '/private/repo/attachment.txt',
          promptKind: 'linear-ticket',
        },
      ],
    };
    const approvalRule: ApprovalRule = {
      id: 'rule-1',
      behavior: 'allow',
      target: { kind: 'file-write', path: '/private/repo/out.ts' },
      createdAt: '2026-09-30T00:00:00.000Z',
      origin: 'prompt',
    };
    const staleSession = {
      droppedMessageText: 'retry',
      droppedFileReferences: [
        {
          displayPath: '/private/repo/stale.ts',
          absolutePath: '/private/repo/stale.ts',
        },
      ],
    };
    const hiddenMessage: PersistedChatMessage = {
      id: 'hidden-1',
      role: 'user',
      hidden: true,
      blocks: [{ type: 'text', text: 'host-only orchestration input' }],
      timestamp: 2,
    };
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'file-event',
      occurredAt: '2026-09-30T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [
        {
          type: 'tab.upserted',
          tab: {
            id: 'file-tab',
            title: 'File',
            messages: [pathMessage],
            createdAt: '2026-09-30T00:00:00.000Z',
            kind: 'file',
            filePath: '/private/repo/file.ts',
            pendingRevertAttachmentPath: '/private/repo/revert.md',
            fileDiffContext: {
              path: '/private/repo/file.ts',
              source: 'uncommitted',
            },
            sessionApprovalRules: [approvalRule],
            staleSessionDetected: staleSession,
          },
        },
        {
          type: 'tab.metadata_patched',
          tabId: 'file-tab',
          patch: {
            filePath: '/private/repo/next.ts',
            sessionApprovalRules: [approvalRule],
            staleSessionDetected: staleSession,
            pinned: true,
          },
        },
        {
          type: 'message.upserted',
          chatId: 'file-tab',
          message: pathMessage,
        },
        {
          type: 'messages.replaced',
          chatId: 'file-tab',
          messages: [pathMessage, hiddenMessage],
          removedMessageIds: [],
        },
        {
          type: 'message.upserted',
          chatId: 'file-tab',
          message: hiddenMessage,
        },
      ],
    };
    listeners.forEach((listener) => listener(event));
    const frame = await nextFrame(opened.handle.frames[Symbol.asyncIterator]());
    if (frame.kind !== 'item') throw new Error('Expected a chat event item.');
    expect(JSON.stringify(frame.item)).not.toContain('/private/repo');
    expect(JSON.stringify(frame.item)).not.toContain('host-only orchestration');
    expect(frame.item.revision).toBe(event.revision);
    expect(frame.item.changes).toMatchObject([
      { type: 'tab.upserted', tab: { id: 'file-tab', kind: 'file' } },
      {
        type: 'tab.metadata_patched',
        tabId: 'file-tab',
        patch: { pinned: true },
      },
      { type: 'message.upserted', message: { id: 'message-1' } },
      {
        type: 'messages.replaced',
        messages: [{ id: 'message-1' }, { id: 'hidden-1', blocks: [] }],
      },
      { type: 'message.upserted', message: { id: 'hidden-1', blocks: [] } },
    ]);
    expect(opened.takeLegacyEvent(frame.cursor)).toBe(event);
    opened.handle.close();
    await runtime.shutdown();
  });

  it('ends with snapshot-required for a foreign cursor and cancels on close', async () => {
    const { runtime, listeners } = makeHarness();
    const stale = await runtime.openChatEventsForLegacyIpc(
      { scope: 'all', cursor: { daemonEpoch: 'foreign', sequence: 1 } },
      { caller },
    );
    const staleFrame = await nextFrame(
      stale.handle.frames[Symbol.asyncIterator](),
    );
    expect(staleFrame).toMatchObject({
      kind: 'end',
      outcome: 'error',
      error: {
        kind: 'failed_precondition',
        code: 'core.chat.snapshotRequired',
      },
    });
    const live = await runtime.openChatEventsForLegacyIpc(
      { scope: 'all' },
      { caller },
    );
    await new Promise(setImmediate);
    live.handle.close();
    const end = await nextFrame(live.handle.frames[Symbol.asyncIterator]());
    expect(end).toMatchObject({ kind: 'end', outcome: 'cancelled' });
    await new Promise(setImmediate);
    expect(listeners.size).toBe(0);
    await runtime.shutdown();
  });

  it('filters internal queue ids from portable runtime patch events', async () => {
    const { runtime, listeners } = makeHarness();
    const opened = await runtime.openStream(
      'core.chat.events',
      { scope: { projectId: 'project-1', worktreeId: 'worktree-1' } },
      { caller: { ...caller, clientInstanceId: 'scoped-consumer' } },
    );
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
    const runtimeState: ChatRuntimeState & { turn: PersistedChatTurnState } = {
      status: 'streaming',
      queuedMessageIds: ['internal-row', 'visible-row', 'unknown-row'],
      turn: persistedTurnState(),
      queuedMessages: [
        queuedMessage('internal-row', {
          managedDelegationDeliveryId: 'internal-row',
          internalRow: {
            kind: 'delegation-request',
            delegationId: 'delegate-1',
            displayLine: 'Waiting for parent input',
          },
        }),
        queuedMessage('visible-row', {}),
      ],
    };
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: 'runtime-patch-event',
      occurredAt: '2026-10-13T00:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [
        { type: 'runtime.patched', chatId: 'chat-1', runtime: runtimeState },
      ],
    };

    listeners.forEach((listener) => listener(event));
    const frame = await nextFrame(opened.frames[Symbol.asyncIterator]());

    if (frame.kind !== 'item') throw new Error('Expected a chat event item.');
    expect(frame.item.changes).toMatchObject([
      {
        type: 'runtime.patched',
        runtime: { queuedMessageIds: ['visible-row', 'unknown-row'] },
      },
    ]);
    expect(frame.item.changes[0]).not.toHaveProperty('runtime.queuedMessages');
    expect(frame.item.changes[0]).not.toHaveProperty('runtime.turn');
    expect(runtimeState.queuedMessageIds).toEqual([
      'internal-row',
      'visible-row',
      'unknown-row',
    ]);
    opened.close();
    await runtime.shutdown();
  });

  it('requires a snapshot after the live window expires and ends on abort', async () => {
    const { runtime, emit } = makeHarness();
    const controller = new AbortController();
    const live = await runtime.openChatEventsForLegacyIpc(
      { scope: 'all' },
      { caller, signal: controller.signal },
    );
    await new Promise(setImmediate);
    emit(1);
    const first = await nextFrame(live.handle.frames[Symbol.asyncIterator]());
    if (first.kind !== 'item') throw new Error('Expected chat event item.');
    for (let revision = 2; revision <= 130; revision += 1) emit(revision);
    const stale = await runtime.openChatEventsForLegacyIpc(
      { scope: 'all', cursor: first.cursor },
      { caller },
    );
    expect(
      await nextFrame(stale.handle.frames[Symbol.asyncIterator]()),
    ).toMatchObject({
      kind: 'end',
      outcome: 'error',
      error: { code: 'core.chat.snapshotRequired' },
    });
    controller.abort();
    const frames = live.handle.frames[Symbol.asyncIterator]();
    let terminal: ChatFrame;
    do {
      terminal = await nextFrame(frames);
    } while (terminal.kind === 'item');
    expect(terminal).toMatchObject({ kind: 'end', outcome: 'cancelled' });
    await runtime.shutdown();
  });
});
