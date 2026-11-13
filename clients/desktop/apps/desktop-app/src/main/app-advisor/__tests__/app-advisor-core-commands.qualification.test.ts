jest.mock('../../canopy-runtime/chat-turn-stop', () => ({
  stopChatTurnExactly: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../../lib/chat-turn-cancel', () => ({
  cancelChatTurn: jest.fn(() => Promise.resolve({ outcome: 'interrupted' })),
  captureChatTurnStop: jest.fn(),
  captureChatTurnStopsForChat: jest.fn(() => []),
  adoptPreparingSendSession: jest.fn((context: unknown) => context),
  isChatTurnStopCurrent: jest.fn(() => true),
}));
jest.mock('../../services/chat-queue-service', () => ({
  getChatQueueService: (): object => ({ onTurnTerminal: jest.fn() }),
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    ingestProviderEvent: jest.fn(() => Promise.resolve()),
    getCompatibilityArchives: jest.fn(() => Promise.resolve({ archived: [] })),
  }),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyStreamFrame } from '@canopy/core-runtime';
import {
  APP_ADVISOR_PROJECT_ID,
  type ChatCommandRequest,
  type ChatCommandResult,
  type ChatGetStateRequest,
  type ChatRuntimeState,
  type ChatStateChangedEvent,
  type ChatStateCommandPort,
  type ChatStateSnapshot,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  CanopyCallerDescriptor,
  CanopyStreamEnd,
  CanopyStreamItem,
} from '@canopy/protocol/canopy-core';
import { beginChatTurnRun } from '../../agent-runs/turn-runs';
import { stopChatTurnExactly } from '../../canopy-runtime/chat-turn-stop';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../../canopy-runtime/core-operation-adapter';
import type { CoreChatTurnCancelHost } from '../../canopy-runtime/core-chat-turn-adapter';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { setChatStateCommandPort } from '../../ipc/chat-state';

type ChatFrame = CanopyStreamFrame<
  CanopyStreamItem<'core.chat.events'>,
  CanopyStreamEnd<'core.chat.events'>
>;

const advisor = { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'entry-1' };
const stopExactly = jest.mocked(stopChatTurnExactly);

/** One App Advisor scope's chat state, as main's chat state port serves it. */
class AdvisorChatStatePort implements ChatStateCommandPort {
  public readonly received: ChatCommandRequest[] = [];
  public readonly listeners = new Set<(event: ChatStateChangedEvent) => void>();
  public readonly tabs: PersistedChatTab[] = [];
  public readonly runtime: Record<string, ChatRuntimeState> = {};
  public revision = 0;

  public readonly getTranscriptPage = jest.fn();
  public readonly searchTranscript = jest.fn();
  public readonly readToolOutput = jest.fn();
  public readonly readVisual = jest.fn();

  public subscribe(
    listener: (event: ChatStateChangedEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public getState(request: ChatGetStateRequest): Promise<ChatStateSnapshot> {
    return Promise.resolve({
      schemaVersion: 1,
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      revision: this.revision,
      tabsFile: {
        version: 1,
        activeTabId: this.tabs[0]?.id ?? null,
        tabs: structuredClone(this.tabs),
      },
      archives: [],
      runtimeByChatId: structuredClone(this.runtime),
      queue: [],
    });
  }

  public command(request: ChatCommandRequest): Promise<ChatCommandResult> {
    this.received.push(request);
    const command = request.command;
    if (command.type === 'chat.send_message') {
      this.runtime[command.chatId] = {
        status: 'streaming',
        activeTurn: { userMessageId: command.userMessageId, startedAt: 1 },
        queuedMessageIds: [],
      };
      this.revision += 1;
      return Promise.resolve({
        commandId: request.commandId,
        revision: this.revision,
        outcome: 'applied',
        entityId: command.chatId,
      });
    }
    return Promise.resolve({
      commandId: request.commandId,
      revision: this.revision,
      outcome: 'rejected',
      reason: 'Unsupported in this port.',
    });
  }

  /** A frame the chat state service committed for this scope. */
  public commit(tab: PersistedChatTab): void {
    this.tabs.push(tab);
    this.revision += 1;
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: `event-${this.revision}`,
      occurredAt: '2026-11-06T00:00:00.000Z',
      projectId: advisor.projectId,
      worktreeId: advisor.worktreeId,
      baseRevision: this.revision - 1,
      revision: this.revision,
      changes: [{ type: 'tab.upserted', tab: structuredClone(tab) }],
    };
    for (const listener of Array.from(this.listeners)) listener(event);
  }
}

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'any-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test',
  grants: ['core.chat.read', 'core.chat.write', 'core.operation.cancel'],
};

const advisorTab = (id: string): PersistedChatTab => ({
  id,
  title: 'Advisor chat',
  createdAt: '2026-11-06T00:00:00.000Z',
  messages: [],
});

let root: string;
let operations: CoreOperationAdapter;
let port: AdvisorChatStatePort;
let stop: jest.Mock;
let runtime: ReturnType<typeof createDesktopRuntime>;

beforeEach(() => {
  stopExactly.mockClear();
  root = mkdtempSync(join(tmpdir(), 'can-4133-commands-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  port = new AdvisorChatStatePort();
  stop = jest.fn(() => Promise.resolve(null));
  const turnCancelHost: CoreChatTurnCancelHost = {
    scopesForChat: (chatId) => Promise.resolve([{ ...advisor, chatId }]),
    getState: (scope) => port.getState(scope),
    stop,
  };
  setChatStateCommandPort(port);
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    chatCommandPort: port,
    getChatStatePort: () => port,
    turnCancelHost,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  setChatStateCommandPort(null);
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor chats through core chat commands (CAN-4133)', () => {
  it('core.chat.message.send starts a turn with no window', async () => {
    port.commit(advisorTab('advisor-chat'));

    await expect(
      runtime.instruction(
        'core.chat.message.send',
        {
          scope: {
            workspaceId: advisor.projectId,
            worktreeId: advisor.worktreeId,
          },
          commandId: 'send-1',
          chatId: 'advisor-chat',
          messageId: 'message-1',
          text: 'Summarize my open pull requests',
          _meta: { idempotencyKey: 'send-1' },
        },
        { caller, metadata: { idempotencyKey: 'send-1' } },
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });

    const sends = port.received.filter(
      (request) => request.command.type === 'chat.send_message',
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-1',
      command: { chatId: 'advisor-chat', userMessageId: 'message-1' },
    });
  });

  it('core.chat.turn.cancel stops the exact App Advisor turn', async () => {
    port.commit(advisorTab('advisor-chat'));
    port.runtime['advisor-chat'] = {
      status: 'streaming',
      activeTurn: { userMessageId: 'message-1', startedAt: 1 },
      queuedMessageIds: [],
    };

    await runtime.instruction(
      'core.chat.turn.cancel',
      { chatId: 'advisor-chat', turnId: 'message-1', reason: 'user' },
      { caller },
    );

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(
      { ...advisor, chatId: 'advisor-chat' },
      'message-1',
    );
  });

  it('core.operation.cancel stops the exact turn', async () => {
    const run = await beginChatTurnRun({
      scope: {
        workspaceId: advisor.projectId,
        worktreeId: advisor.worktreeId,
        chatId: 'advisor-chat',
      },
      turnId: 'message-1',
      eventNamespace: 'initial',
      providerId: 'claude',
      model: 'model',
      initiationSource: 'user',
    });
    const parent = await run.execute(async () => {
      const { items } = await operations.service.list({
        kinds: ['core.chat.turn.run'],
        limit: 5,
      });
      return items[0];
    });
    if (!parent) throw new Error('Missing turn run.');

    await runtime.instruction(
      'core.operation.cancel',
      { operationId: parent.operationId, reason: 'stop' },
      { caller },
    );

    expect(stopExactly).toHaveBeenCalledTimes(1);
    expect(stopExactly).toHaveBeenCalledWith(
      { ...advisor, chatId: 'advisor-chat' },
      'message-1',
    );
  });

  it('committed App Advisor frames reach core.chat.events', async () => {
    const controller = new AbortController();
    const events = await runtime.openStream(
      'core.chat.events',
      { scope: advisor },
      { caller, signal: controller.signal },
    );
    const frames = events.frames[Symbol.asyncIterator]();

    port.commit(advisorTab('advisor-chat'));

    let frame: ChatFrame | undefined;
    for (let read = 0; read < 10; read += 1) {
      const next = await frames.next();
      if (next.done) break;
      frame = next.value;
      if (
        frame.kind === 'item' &&
        JSON.stringify(frame).includes('advisor-chat')
      )
        break;
    }
    controller.abort();
    expect(frame?.kind).toBe('item');
    expect(JSON.stringify(frame)).toContain('advisor-chat');
  });
});
