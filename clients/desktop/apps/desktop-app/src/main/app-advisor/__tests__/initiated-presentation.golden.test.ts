// CAN-4174 migration golden: the desktop's reaction to `chat.initiated`,
// subscribed to the real desktop runtime's `core.chat.events` at revision 4,
// beside the subscribers that must not change: the legacy chat:state-changed
// push (which remote controllers also receive) and a revision-less stream.
// Only the chat state port and the Orchestrator window surface are replaced.
import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';
import { createCanopyClient } from '@canopy/core-client';
import { CANOPY_STREAM_DEFINITIONS } from '@canopy/protocol/canopy-core';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { createInterimInMemoryBindingProvider } from '../../canopy-runtime/renderer-relay/interim-in-memory-binding';
import {
  startInitiatedPresentation,
  type InitiatedPresentationStream,
} from '../initiated-presentation';

const mockWarn = jest.fn();
jest.mock('../../lib/main-process-logging', () => ({
  ...jest.requireActual<object>('../../lib/main-process-logging'),
  logMainProcessWarn: (...args: unknown[]): void => {
    mockWarn(...args);
  },
}));

const BOT = { projectId: 'app-advisor', worktreeId: 'app-advisor' };
const PROJECT = { projectId: 'project-1', worktreeId: 'worktree-1' };
const ATTACHED = '2026-11-17T12:00:00.000Z';
const LIVE = '2026-11-17T12:00:01.000Z';
const BEFORE = '2026-11-17T11:59:59.000Z';

const caller = (
  clientInstanceId: string,
): {
  principalId: string;
  clientInstanceId: string;
  authorityId: string;
  interfaceKind: 'test';
  grants: 'core.chat.read'[];
} => ({
  principalId: 'test-user',
  clientInstanceId,
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.read' as const],
});

function harness(ensure: jest.Mock = jest.fn(() => Promise.resolve({}))): {
  runtime: ReturnType<typeof createDesktopRuntime>;
  emit: (
    scope: { projectId: string; worktreeId: string },
    presentation: 'focus' | 'open' | 'none',
    acceptedAt?: string,
  ) => ChatStateChangedEvent;
  ensure: jest.Mock;
  start: () => ReturnType<typeof startInitiatedPresentation>;
} {
  const listeners = new Set<(event: ChatStateChangedEvent) => void>();
  const port: ChatStateCommandPort = {
    getState: jest.fn(),
    getTranscriptPage: jest.fn(),
    searchTranscript: jest.fn(),
    readToolOutput: jest.fn(),
    readVisual: jest.fn(),
    command: jest.fn(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const runtime = createDesktopRuntime({ getChatStatePort: () => port });
  let revision = 0;
  const emit = (
    scope: { projectId: string; worktreeId: string },
    presentation: 'focus' | 'open' | 'none',
    acceptedAt = LIVE,
  ): ChatStateChangedEvent => {
    revision += 1;
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: `event-${revision}`,
      occurredAt: acceptedAt,
      ...scope,
      baseRevision: revision - 1,
      revision,
      changes: [
        {
          type: 'chat.initiated',
          chatId: `chat-${revision}`,
          userMessageId: `input-${revision}`,
          origin: { kind: 'automation', sourceId: 'automation-1' },
          presentation,
          acceptedAt,
        },
      ],
    };
    listeners.forEach((listener) => listener(event));
    return event;
  };
  const start = (): ReturnType<typeof startInitiatedPresentation> =>
    startInitiatedPresentation({
      openChatEvents: (params) =>
        runtime.openStream('core.chat.events', params, {
          caller: caller('electron-main-initiated-presentation'),
        }),
      surfaces: { ensureAppAdvisorWindow: ensure },
      now: () => new Date(ATTACHED),
    });
  return { runtime, emit, ensure, start };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

beforeEach(() => mockWarn.mockClear());

describe('the Orchestrator window as a reaction to chat.initiated (CAN-4174)', () => {
  it('focus opens the window on the chat and open opens it without selecting, once each, after the commit', async () => {
    const h = harness();
    const presentation = await h.start();
    try {
      h.emit(BOT, 'focus');
      // Never inside the commit's publication: a later microtask.
      expect(h.ensure).not.toHaveBeenCalled();
      await settle();
      h.emit(BOT, 'open');
      await settle();
      expect(h.ensure.mock.calls).toEqual([
        [{ chatId: 'chat-1' }],
        [undefined],
      ]);
    } finally {
      presentation.stop();
      await h.runtime.shutdown();
    }
  });

  it('none, a project chat and a send accepted before it subscribed do nothing', async () => {
    const h = harness();
    const presentation = await h.start();
    try {
      h.emit(BOT, 'none');
      h.emit(PROJECT, 'focus');
      h.emit(PROJECT, 'open');
      h.emit(BOT, 'focus', BEFORE);
      await settle();
      expect(h.ensure).not.toHaveBeenCalled();
    } finally {
      presentation.stop();
      await h.runtime.shutdown();
    }
  });

  it('a window failure is logged and the next send still presents', async () => {
    const ensure = jest
      .fn()
      .mockRejectedValueOnce(new Error('no display'))
      .mockResolvedValue({});
    const h = harness(ensure);
    const presentation = await h.start();
    try {
      h.emit(BOT, 'focus');
      await settle();
      expect(mockWarn).toHaveBeenCalledWith(
        'Opening the Orchestrator window for an automation failed',
        expect.objectContaining({ presentation: 'focus' }),
      );
      h.emit(BOT, 'open');
      await settle();
      expect(ensure.mock.calls).toEqual([[{ chatId: 'chat-1' }], [undefined]]);
    } finally {
      presentation.stop();
      await h.runtime.shutdown();
    }
  });

  it('leaves the legacy push and revision-less subscribers on the stand-in', async () => {
    const h = harness();
    const legacy = await h.runtime.openChatEventsForLegacyIpc(
      { scope: 'all' },
      { caller: caller('electron-main-chat-push') },
    );
    const plain = await h.runtime.openStream(
      'core.chat.events',
      { scope: 'all' },
      { caller: caller('web-relay') },
    );
    const presentation = await h.start();
    try {
      const event = h.emit(BOT, 'focus');
      await settle();
      expect(h.ensure.mock.calls).toEqual([[{ chatId: 'chat-1' }]]);
      const standIn = {
        type: 'tab.metadata_patched',
        tabId: 'chat-1',
        patch: {},
      };
      const legacyFrame =
        await legacy.handle.frames[Symbol.asyncIterator]().next();
      if (legacyFrame.done || legacyFrame.value.kind !== 'item')
        throw new Error('Expected a chat event item.');
      expect(legacyFrame.value.item.changes).toStrictEqual([standIn]);
      expect(legacy.takeLegacyEvent(legacyFrame.value.cursor)).toEqual({
        ...event,
        changes: [standIn],
      });
      const plainFrame = await plain.frames[Symbol.asyncIterator]().next();
      if (plainFrame.done || plainFrame.value.kind !== 'item')
        throw new Error('Expected a chat event item.');
      expect(plainFrame.value.item.changes).toStrictEqual([standIn]);
    } finally {
      presentation.stop();
      legacy.handle.close();
      plain.close();
      await h.runtime.shutdown();
    }
  });

  it('reads a presentation it does not know as open: the window opens, no chat is selected', async () => {
    let push: Parameters<InitiatedPresentationStream['onFrame']>[0] = () =>
      undefined;
    const ensure: jest.Mock = jest.fn(
      (): Promise<{ open: boolean; focused: boolean }> =>
        Promise.resolve({ open: true, focused: true }),
    );
    const presentation = await startInitiatedPresentation({
      openChatEvents: () =>
        Promise.resolve({
          onFrame: (listener) => {
            push = listener;
            return (): void => undefined;
          },
          close: () => undefined,
        }),
      surfaces: { ensureAppAdvisorWindow: ensure },
      now: () => new Date(ATTACHED),
    });
    try {
      push({
        kind: 'item',
        item: {
          ...BOT,
          changes: [
            { type: 'tab.metadata_patched', tabId: 'chat-other', patch: {} },
            {
              type: 'chat.initiated',
              chatId: 'chat-1',
              userMessageId: 'input-1',
              origin: { kind: 'automation', sourceId: 'automation-1' },
              presentation: 'spotlight',
              acceptedAt: LIVE,
            },
          ],
        },
      });
      await settle();
      // Opened, never selecting this chat or any other.
      expect(ensure.mock.calls).toEqual([[undefined]]);
    } finally {
      presentation.stop();
    }
  });

  it('advertises no core.chat.events revision: initialize and the manifest list none', async () => {
    const runtime = createDesktopRuntime({ getChatStatePort: () => null });
    const abort = new AbortController();
    try {
      const connection = await createInterimInMemoryBindingProvider(runtime)({
        caller: { ...caller('renderer'), interfaceKind: 'desktop' },
        webContentsId: 1,
        signal: abort.signal,
      });
      const client = await createCanopyClient({
        connection,
        clientName: 'initiated-presentation-golden',
        clientVersion: '0.0.0',
        definitions: {
          queries: {},
          instructions: {},
          streams: {
            'core.chat.events': CANOPY_STREAM_DEFINITIONS['core.chat.events'],
          },
        },
        signal: abort.signal,
      });
      // Served, so a client may open it, but with no revision to negotiate.
      expect(client.manifest.has('streams', 'core.chat.events')).toBe(true);
      expect(client.manifest.schemaRevisions?.size ?? 0).toBe(0);
      const manifest = await runtime.query(
        'core.runtime.manifest.get',
        { includeUnavailable: true },
        { caller: { ...caller('manifest'), grants: ['core.runtime.read'] } },
      );
      expect(
        manifest.operations.filter(
          (operation) => 'schemaRevision' in operation,
        ),
      ).toEqual([]);
    } finally {
      abort.abort();
      await runtime.shutdown();
    }
  });
});
