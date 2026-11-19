import type {
  ChatCommandOutcome,
  ChatCommandRequest,
  ChatCommandResult,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';
import {
  projectQueueCancel,
  projectQueueEdit,
  projectQueueEditLock,
  projectQueueForce,
} from '../../ipc/chat-queue-projections';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../core-chat-command-adapter';
import { createDesktopRuntime } from '../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../desktop-runtime-identity';

jest.mock('../../services/chat-queue-service', () => ({
  ...jest.requireActual<object>('../../services/chat-queue-service'),
  getChatQueueService: jest.fn(() => {
    throw new Error('Queue interventions must enter through core.');
  }),
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const target = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' };

class MemoryQueuePort implements ChatStateCommandPort {
  public readonly commands: ChatCommandRequest[] = [];
  public outcome: ChatCommandOutcome = 'applied';
  public reason: string | undefined;
  private readonly receipts = new Map<string, ChatCommandResult>();

  public command(request: ChatCommandRequest): Promise<ChatCommandResult> {
    this.commands.push(request);
    const replay = this.receipts.get(request.commandId);
    if (replay)
      return Promise.resolve({ ...replay, outcome: 'already_applied' });
    const result: ChatCommandResult = {
      commandId: request.commandId,
      revision: 1,
      outcome: this.outcome,
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
    };
    if (this.outcome === 'applied')
      this.receipts.set(request.commandId, result);
    return Promise.resolve(result);
  }

  public getState = jest.fn();
  public getTranscriptPage = jest.fn();
  public searchTranscript = jest.fn();
  public readVisual = jest.fn();
  public readToolOutput = jest.fn();
  public subscribe = jest.fn((): (() => void) => () => undefined);
}

function compose(): {
  port: MemoryQueuePort;
  runtime: ReturnType<typeof createDesktopRuntime>;
  dispatch: (request: ChatCommandRequest) => Promise<ChatCommandResult>;
} {
  const port = new MemoryQueuePort();
  const runtime = createDesktopRuntime({
    chatCommandPort: port,
    getChatStatePort: () => port,
  });
  const dispatch = (request: ChatCommandRequest): Promise<ChatCommandResult> =>
    dispatchTrustedChatCommand(
      request,
      createChatCommandDispatchOptions(port, runtime, {
        principalId: 'local-desktop-user',
        clientInstanceId: 'desktop-main-chat',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'desktop',
        grants: ['core.chat.write'],
      }),
    );
  return { port, runtime, dispatch };
}

describe('queue interventions through core (CAN-4112)', () => {
  it('each desktop queue channel dispatches its core operation once', async () => {
    const { port, runtime, dispatch } = compose();
    try {
      const fileReferences = [
        { absolutePath: '/repo/notes.md', displayPath: 'notes.md' },
      ];
      await projectQueueEdit(
        { ...target, entryId: 'queue-1', text: 'Updated', fileReferences },
        dispatch,
      );
      await projectQueueCancel({ ...target, entryId: 'queue-2' }, dispatch);
      await projectQueueForce({ ...target, entryId: 'queue-3' }, dispatch);
      await projectQueueEditLock(
        { ...target, entryId: 'queue-4', locked: true },
        dispatch,
      );

      expect(port.commands.map((request) => request.command)).toEqual([
        {
          type: 'chat.edit_queued_message',
          chatId: 'chat-1',
          queuedMessageId: 'queue-1',
          text: 'Updated',
          fileReferences,
        },
        {
          type: 'chat.cancel_queued_message',
          chatId: 'chat-1',
          queuedMessageId: 'queue-2',
        },
        {
          type: 'chat.force_queued_message',
          chatId: 'chat-1',
          queuedMessageId: 'queue-3',
        },
        {
          type: 'chat.set_queued_message_edit_lock',
          chatId: 'chat-1',
          queuedMessageId: 'queue-4',
          locked: true,
        },
      ]);
      for (const request of port.commands) {
        expect(request).toMatchObject({
          projectId: 'ws-1',
          worktreeId: 'wt-1',
        });
        expect(request.commandId).toMatch(UUID);
      }
      expect(
        new Set(port.commands.map((request) => request.commandId)).size,
      ).toBe(4);
    } finally {
      await runtime.shutdown();
    }
  });

  it('queue channels keep their responses', async () => {
    const { port, runtime, dispatch } = compose();
    try {
      for (const outcome of ['not_found', 'rejected'] as const) {
        port.outcome = outcome;
        await expect(
          projectQueueEdit(
            { ...target, entryId: 'queue-1', text: 'x' },
            dispatch,
          ),
        ).resolves.toBeUndefined();
        await expect(
          projectQueueCancel({ ...target, entryId: 'queue-1' }, dispatch),
        ).resolves.toBeUndefined();
        await expect(
          projectQueueForce({ ...target, entryId: 'queue-1' }, dispatch),
        ).resolves.toBeUndefined();
      }
      port.outcome = 'rejected';
      port.reason = 'Another message operation is in progress';
      await expect(
        projectQueueEditLock(
          { ...target, entryId: 'queue-1', locked: true },
          dispatch,
        ),
      ).rejects.toThrow('Another message operation is in progress');
      await expect(
        projectQueueEditLock(
          { ...target, entryId: 'queue-1', locked: false },
          dispatch,
        ),
      ).rejects.toThrow('Another message operation is in progress');
      port.reason = undefined;
      await expect(
        projectQueueEditLock(
          { ...target, entryId: 'queue-1', locked: true },
          dispatch,
        ),
      ).rejects.toThrow('This message is no longer available to edit.');
    } finally {
      await runtime.shutdown();
    }
  });
});
