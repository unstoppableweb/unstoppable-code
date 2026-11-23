/**
 * Golden (CAN-4174): a controller built on the portable adapter carries an
 * automation's initiation facts through untouched. Since revision 4 of
 * `core.chat.events` added `open`, a queued row a desktop sends in
 * `chat:get-state` (or a `chat:send-message` reply) can carry
 * `automationDispatch.initiated.presentation: 'open'`. The adapter's
 * `chat:get-state` and `chat:send-message` reply guards check only the top
 * level of the reply, so such a reply is admitted and used, and the reply is
 * deep-equal before and after: nothing in the adapter rejects, reads or
 * rewrites the value. Each reply is deep-frozen, so any write to it throws.
 */
import type { RemoteIpcTransport } from '@canopy/protocol/remote-control';
import { REMOTE_IPC_CHANNELS } from '@canopy/protocol/remote-control/channels';
import { createIpcCanopyClient } from '../index';

const C = REMOTE_IPC_CHANNELS;
const NOW = '2026-11-17T12:00:00.000Z';

const QUEUED_AUTOMATION_ROW = {
  id: 'queued-1',
  enqueuedAtMs: 1,
  request: {
    projectId: 'app-advisor',
    worktreeId: 'entry-a',
    chatId: 'adv-1',
    userMessageId: 'queued-1',
    text: 'Summarize my day',
    initiationSource: 'automation',
    automationDispatch: {
      version: 1,
      automationName: 'Morning summary',
      presentation: 'foreground',
      initiated: {
        origin: { kind: 'automation', sourceId: 'automation-1' },
        presentation: 'open',
      },
    },
  },
};

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function chatState(): object {
  return {
    tabsFile: {
      activeTabId: 'adv-1',
      tabs: [{ id: 'adv-1', title: 'First', createdAt: NOW }],
    },
    runtimeByChatId: {
      'adv-1': {
        status: 'idle',
        queuedMessageIds: ['queued-1'],
        queuedMessages: [QUEUED_AUTOMATION_ROW],
      },
    },
  };
}

interface Harness {
  readonly client: ReturnType<typeof createIpcCanopyClient>;
  readonly channels: string[];
}

function harness(replies: Record<string, () => unknown>): Harness {
  const channels: string[] = [];
  const transport: RemoteIpcTransport = {
    invoke: (channel) => {
      channels.push(channel);
      return Promise.resolve(replies[channel]?.());
    },
    send: (channel) => {
      channels.push(channel);
    },
    on: () => (): void => undefined,
  };
  const client = createIpcCanopyClient(transport, {
    capabilities: {
      localExecution: true,
      terminalPty: true,
      fileSystemAccess: 'read-write',
      voice: false,
      settingsScope: 'full',
      pipelines: 'execute',
      routing: 'in-memory',
      overviewNotifications: true,
      worktreeRecovery: true,
      worktreeRecoveryResolution: true,
      worktreeRecoveryReads: true,
    },
    appAdvisorTransport: transport,
    uploadFile: (fileName) => Promise.resolve(`/uploads/${fileName}`),
    openExternalUrl: () => undefined,
    now: () => NOW,
    randomId: () => 'random-id',
    workspaceContext: () => ({ kind: 'personal' }),
    forkWorktreeState: () => Promise.resolve(),
    logError: () => undefined,
    resolveLocalFileRoot: () => undefined,
  });
  return { client, channels };
}

describe("an automation's queued initiation facts pass through the portable adapter (CAN-4174)", () => {
  it('chat:get-state: the Orchestrator chat list admits and uses the reply, unchanged', async () => {
    const state = deepFreeze(chatState());
    const before = structuredClone(state);
    const { client, channels } = harness({
      [C.workEntriesList]: () => ({
        entries: [
          { id: 'entry-a', title: 'Plan', createdAt: NOW, lastMessageAt: NOW },
        ],
      }),
      [C.chatGetState]: () => state,
    });
    const value = await client.query('appAdvisor.chats', {});
    expect(channels).toEqual([C.workEntriesList, C.chatGetState]);
    expect(value.chats).toEqual([
      expect.objectContaining({ chatId: 'adv-1', workEntryId: 'entry-a' }),
    ]);
    expect(state).toStrictEqual(before);
  });

  it('chat:get-state: closing the tab reads the queued row from the reply, unchanged', async () => {
    const state = deepFreeze(chatState());
    const before = structuredClone(state);
    const { client, channels } = harness({ [C.chatGetState]: () => state });
    const receipt = await client.command('chat.closeTab', {
      payload: {
        projectId: 'app-advisor',
        worktreeId: 'entry-a',
        chatId: 'adv-1',
      },
    });
    // Refused because of the queued row the guard admitted.
    expect(receipt).toMatchObject({ ok: false });
    expect(receipt.error).toMatch(/active/);
    expect(channels).toEqual([C.chatGetState]);
    expect(state).toStrictEqual(before);
  });

  it('chat:send-message: the reply is admitted, unchanged', async () => {
    const result = deepFreeze({
      disposition: 'queued',
      queuedMessage: QUEUED_AUTOMATION_ROW,
    });
    const before = structuredClone(result);
    const { client, channels } = harness({ [C.chatSendMessage]: () => result });
    const receipt = await client.command('appAdvisor.send', {
      payload: {
        workEntryId: 'entry-a',
        chatId: 'adv-1',
        userMessageId: 'user-1',
        text: 'Plan it',
      },
    });
    expect(receipt).toMatchObject({ ok: true, chatId: 'adv-1' });
    expect(channels).toEqual([C.chatSendMessage]);
    expect(result).toStrictEqual(before);
  });
});
