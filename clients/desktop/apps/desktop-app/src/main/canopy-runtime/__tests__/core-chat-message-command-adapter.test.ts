import type {
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandExecutionOptions,
  ChatCommandResult,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../desktop-runtime';
import { CHAT_MESSAGE_COMMAND_ROUTES } from '../core-chat-message-command-adapter';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../core-chat-command-adapter';

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.chat.write' as const],
};

function request(
  command: ChatCommand,
  expectedRevision?: number,
): ChatCommandEnvelope {
  return {
    schemaVersion: 1,
    commandId: 'command-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    origin: 'portal',
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    command,
  };
}

function createPort(result: ChatCommandResult): {
  port: ChatStateCommandPort;
  command: jest.Mock<Promise<ChatCommandResult>>;
} {
  const command = jest.fn(() => Promise.resolve(result));
  const port: ChatStateCommandPort = {
    command,
    getState: jest.fn(),
    getTranscriptPage: jest.fn(),
    searchTranscript: jest.fn(),
    readVisual: jest.fn(),
    readToolOutput: jest.fn(),
    subscribe: jest.fn(() => () => {}),
  };
  return { port, command };
}

describe('chat message command adapter', () => {
  const receipt: ChatCommandResult = {
    commandId: 'command-1',
    revision: 8,
    outcome: 'applied',
    messageId: 'message-1',
  };

  it.each<[string, ChatCommand]>([
    [
      'send',
      {
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Hello',
        attachmentPaths: ['/local/file'],
      },
    ],
    [
      'terminal prompt',
      {
        type: 'chat.commit_terminal_initial_prompt',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        turnTimerMessageId: 'timer-1',
        text: 'Hello',
      },
    ],
    [
      'queue cancel',
      {
        type: 'chat.cancel_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'queue-1',
      },
    ],
    [
      'queue move',
      {
        type: 'chat.move_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'queue-2',
        beforeQueuedMessageId: 'queue-1',
      },
    ],
    [
      'queue move to tail',
      {
        type: 'chat.move_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'queue-1',
        beforeQueuedMessageId: null,
      },
    ],
    [
      'queue edit',
      {
        type: 'chat.edit_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'queue-1',
        text: 'Updated',
      },
    ],
    [
      'queue steer',
      {
        type: 'chat.steer_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'queue-1',
      },
    ],
    [
      'queue force',
      {
        type: 'chat.force_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'queue-1',
      },
    ],
  ])(
    'preserves the exact %s legacy command and receipt',
    async (_name, chatCommand) => {
      const { port, command } = createPort(receipt);
      const runtime = createDesktopRuntime({
        chatCommandPort: port,
      });
      const envelope = request(chatCommand, 7);
      const result = await dispatchTrustedChatCommand(
        envelope,
        createChatCommandDispatchOptions(port, runtime, caller),
      );
      expect(result).toEqual(receipt);
      expect(command).toHaveBeenCalledWith(envelope);
      await runtime.shutdown();
    },
  );

  it('carries plan review identity through the portable message contract', async () => {
    const { port, command } = createPort(receipt);
    const runtime = createDesktopRuntime({ chatCommandPort: port });
    const instruction = jest.spyOn(runtime, 'instruction');
    const approval = {
      requestId: 'review-1',
      planId: 'plan-1',
      revisionNumber: 2,
    };
    const send = {
      type: 'chat.send_message' as const,
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Implement.',
      planReviewApproval: approval,
      trackedPlanImplementation: {
        planId: approval.planId,
        revisionNumber: approval.revisionNumber,
        userMessageId: 'message-1',
        startedAt: '2026-08-07T12:00:00.000Z',
      },
    };
    try {
      await dispatchTrustedChatCommand(
        request(send),
        createChatCommandDispatchOptions(port, runtime, caller),
      );
      expect(instruction).toHaveBeenCalledWith(
        'core.chat.message.send',
        expect.objectContaining({
          planReviewApproval: approval,
          trackedPlanImplementation: send.trackedPlanImplementation,
        }),
        expect.anything(),
      );
      expect(command).toHaveBeenCalledWith(request(send));
      command.mockClear();
      await runtime.instruction(
        'core.chat.message.send',
        {
          scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
          commandId: 'portable-approval',
          chatId: 'chat-1',
          messageId: 'message-2',
          text: 'Implement.',
          planReviewApproval: approval,
          trackedPlanImplementation: {
            ...send.trackedPlanImplementation,
            userMessageId: 'message-2',
          },
          _meta: { idempotencyKey: 'portable-approval' },
        },
        { caller, metadata: { idempotencyKey: 'portable-approval' } },
      );
      expect(command.mock.calls).toHaveProperty(
        '0.0.command.planReviewApproval',
        approval,
      );
      expect(command.mock.calls).toHaveProperty(
        '0.0.command.trackedPlanImplementation.userMessageId',
        'message-2',
      );
      expect(command.mock.calls).toHaveProperty(
        '0.0.command.userMessageId',
        'message-2',
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it.each(['Code', 'Cowork'])(
    '%s preserves trusted attachment identity and live authorization through canonical send and replay',
    async (mode) => {
      const { port, command } = createPort(receipt);
      const runtime = createDesktopRuntime({ chatCommandPort: port });
      const instruction = jest.spyOn(runtime, 'instruction');
      const envelope = {
        ...request({
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: '',
          attachmentPaths: ['/local/original'],
        }),
        projectId: mode === 'Cowork' ? 'cowork-project' : 'project-1',
      };
      const executionOptions: ChatCommandExecutionOptions = {
        canCommitSend: jest.fn(() => true),
        portalSend: {
          chatId: 'chat-1',
          userMessageId: 'message-1',
          fingerprint: 'a'.repeat(64),
        },
      };
      const baseOptions = createChatCommandDispatchOptions(
        port,
        runtime,
        caller,
      );
      const options = {
        ...baseOptions,
        executionOptions,
        instruction: async (
          ...args: Parameters<typeof baseOptions.instruction>
        ): ReturnType<typeof baseOptions.instruction> => {
          await Promise.resolve();
          return baseOptions.instruction(...args);
        },
      };
      try {
        await expect(
          dispatchTrustedChatCommand(envelope, options),
        ).resolves.toEqual(receipt);
        expect(command).toHaveBeenNthCalledWith(1, envelope, executionOptions);
        command.mockResolvedValueOnce({
          ...receipt,
          outcome: 'already_applied',
        });
        const replay = { ...envelope, commandId: 'command-retry' };
        await expect(
          dispatchTrustedChatCommand(replay, options),
        ).resolves.toMatchObject({ outcome: 'already_applied' });
        expect(command).toHaveBeenNthCalledWith(2, replay, executionOptions);
        expect(instruction).toHaveBeenCalledWith(
          'core.chat.message.send',
          expect.objectContaining({ text: '', messageId: 'message-1' }),
          expect.objectContaining({ caller }),
        );
        await dispatchTrustedChatCommand(
          {
            ...request({
              type: 'chat.cancel_queued_message',
              chatId: 'chat-1',
              queuedMessageId: 'queue-1',
            }),
            commandId: 'command-2',
          },
          baseOptions,
        );
        expect(command.mock.calls[2]).toHaveLength(1);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.each(['Code', 'Cowork'])(
    '%s cannot lose a pairing-revocation guard across canonical dispatch awaits',
    async (mode) => {
      const { port } = createPort(receipt);
      let authorized = true;
      const executionOptions: ChatCommandExecutionOptions = {
        canCommitSend: () => authorized,
        portalSend: {
          chatId: 'chat-1',
          userMessageId: 'message-1',
          fingerprint: 'b'.repeat(64),
        },
      };
      const guardedCommand = jest.fn(
        async (
          _request: ChatCommandEnvelope,
          options?: ChatCommandExecutionOptions,
        ): Promise<ChatCommandResult> => {
          await Promise.resolve();
          return options?.canCommitSend?.() === false
            ? { ...receipt, outcome: 'rejected', reason: 'Pairing revoked' }
            : receipt;
        },
      );
      port.command = guardedCommand;
      const runtime = createDesktopRuntime({ chatCommandPort: port });
      const baseOptions = createChatCommandDispatchOptions(
        port,
        runtime,
        caller,
      );
      const options = {
        ...baseOptions,
        executionOptions,
        instruction: async (
          ...args: Parameters<typeof baseOptions.instruction>
        ): ReturnType<typeof baseOptions.instruction> => {
          await Promise.resolve();
          authorized = false;
          return baseOptions.instruction(...args);
        },
      };
      const envelope = {
        ...request({
          type: 'chat.send_message',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: '',
          attachmentPaths: ['/local/original'],
        }),
        projectId: mode === 'Cowork' ? 'cowork-project' : 'project-1',
      };
      try {
        await expect(
          dispatchTrustedChatCommand(envelope, options),
        ).resolves.toMatchObject({
          outcome: 'rejected',
          reason: 'Pairing revoked',
        });
        expect(guardedCommand).toHaveBeenCalledWith(envelope, executionOptions);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it('releases admission after invoking a long-running send', async () => {
    const { port, command } = createPort(receipt);
    let finishSend: (() => void) | undefined;
    command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSend = (): void => resolve(receipt);
        }),
    );
    const runtime = createDesktopRuntime({ chatCommandPort: port });
    const options = createChatCommandDispatchOptions(port, runtime, caller);
    const send = dispatchTrustedChatCommand(
      request({
        type: 'chat.send_message',
        chatId: 'chat-1',
        userMessageId: 'message-1',
        text: 'Hello',
      }),
      options,
    );
    try {
      await expect(
        dispatchTrustedChatCommand(
          {
            ...request({
              type: 'chat.cancel_queued_message',
              chatId: 'chat-1',
              queuedMessageId: 'queue-1',
            }),
            commandId: 'command-2',
          },
          options,
        ),
      ).resolves.toEqual(receipt);
      expect(command).toHaveBeenCalledTimes(2);
    } finally {
      finishSend?.();
      await send;
      await runtime.shutdown();
    }
  });

  it('refuses attachment references before any effect', async () => {
    const { port, command } = createPort(receipt);
    const runtime = createDesktopRuntime({ chatCommandPort: port });
    try {
      await expect(
        runtime.instruction(
          'core.chat.message.send',
          {
            scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
            commandId: 'attachments',
            chatId: 'chat-1',
            messageId: 'message-1',
            text: 'See the file.',
            attachments: [{ attachmentId: 'att-1' }],
            _meta: { idempotencyKey: 'attachments' },
          },
          { caller, metadata: { idempotencyKey: 'attachments' } },
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'capability_unavailable' },
      });
      expect(command).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
    }
  });

  it('refuses message settings and workspace files it cannot honor, naming them, before any effect', async () => {
    const { port, command } = createPort(receipt);
    const runtime = createDesktopRuntime({ chatCommandPort: port });
    try {
      await expect(
        runtime.instruction(
          'core.chat.message.send',
          {
            scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
            commandId: 'settings',
            chatId: 'chat-1',
            messageId: 'message-1',
            text: 'Use these settings.',
            model: 'claude-sonnet',
            modelConfig: { thinkingLevel: 'high', fastMode: true },
            fileReferences: [
              { kind: 'workspace-file', workspaceFileId: 'file-1' },
            ],
            _meta: { idempotencyKey: 'settings' },
          },
          { caller, metadata: { idempotencyKey: 'settings' } },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          details: { unsupported: ['model', 'modelConfig', 'fileReferences'] },
        },
      });
      expect(command).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
    }
  });

  it('preserves an absent revision and a replayed receipt', async () => {
    const replay = { ...receipt, outcome: 'already_applied' as const };
    const { port, command } = createPort(replay);
    const runtime = createDesktopRuntime({
      chatCommandPort: port,
    });
    const envelope = request({
      type: 'chat.cancel_queued_message',
      chatId: 'chat-1',
      queuedMessageId: 'queue-1',
    });
    expect(
      await dispatchTrustedChatCommand(
        envelope,
        createChatCommandDispatchOptions(port, runtime, caller),
      ),
    ).toEqual(replay);
    expect(command).toHaveBeenCalledWith(envelope);
    await runtime.shutdown();
  });

  it('reconstructs a portable queue command without a legacy capture', async () => {
    const { port, command } = createPort(receipt);
    const runtime = createDesktopRuntime({
      chatCommandPort: port,
    });
    expect(
      await runtime.instruction(
        'core.chat.queue.entry.update',
        {
          scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
          commandId: 'command-1',
          _meta: { idempotencyKey: 'command-1' },
          chatId: 'chat-1',
          entryId: 'queue-1',
          mutation: { kind: 'steer' },
        },
        { caller, metadata: { idempotencyKey: 'command-1' } },
      ),
    ).toEqual(receipt);
    expect(command).toHaveBeenCalledWith({
      schemaVersion: 1,
      commandId: 'command-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      command: {
        type: 'chat.steer_queued_message',
        chatId: 'chat-1',
        queuedMessageId: 'queue-1',
      },
    });
    await runtime.shutdown();
  });

  it.each(['queue-1', null] as const)(
    'reconstructs a portable queue move before %s without a legacy capture',
    async (beforeEntryId) => {
      const { port, command } = createPort(receipt);
      const runtime = createDesktopRuntime({ chatCommandPort: port });
      try {
        expect(
          await runtime.instruction(
            'core.chat.queue.entry.update',
            {
              scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
              commandId: 'command-1',
              _meta: { idempotencyKey: 'command-1' },
              chatId: 'chat-1',
              entryId: 'queue-2',
              expectedRevision: 7,
              mutation: { kind: 'move', beforeEntryId },
            },
            { caller, metadata: { idempotencyKey: 'command-1' } },
          ),
        ).toEqual(receipt);
        expect(command).toHaveBeenCalledWith({
          schemaVersion: 1,
          commandId: 'command-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          expectedRevision: 7,
          command: {
            type: 'chat.move_queued_message',
            chatId: 'chat-1',
            queuedMessageId: 'queue-2',
            beforeQueuedMessageId: beforeEntryId,
          },
        });
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.each(['wire', 'dispatcher'] as const)(
    'rejects a %s key that differs from the durable command id',
    async (source) => {
      const { port, command } = createPort(receipt);
      const runtime = createDesktopRuntime({
        chatCommandPort: port,
      });
      try {
        await expect(
          runtime.instruction(
            'core.chat.queue.entry.cancel',
            {
              scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
              commandId: 'command-1',
              _meta: {
                idempotencyKey: source === 'wire' ? 'another-key' : 'command-1',
              },
              chatId: 'chat-1',
              entryId: 'queue-1',
            },
            {
              caller,
              metadata: {
                idempotencyKey:
                  source === 'dispatcher' ? 'another-key' : 'command-1',
              },
            },
          ),
        ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
        expect(command).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it('carries entry revisions between core params and chat commands', async () => {
    const { port, command } = createPort(receipt);
    const runtime = createDesktopRuntime({ chatCommandPort: port });
    try {
      await runtime.instruction(
        'core.chat.queue.entry.force',
        {
          scope: { workspaceId: 'project-1', worktreeId: 'worktree-1' },
          commandId: 'command-1',
          _meta: { idempotencyKey: 'command-1' },
          chatId: 'chat-1',
          entryId: 'queue-1',
          entryRevision: 4,
        },
        { caller, metadata: { idempotencyKey: 'command-1' } },
      );
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          command: {
            type: 'chat.force_queued_message',
            chatId: 'chat-1',
            queuedMessageId: 'queue-1',
            queuedMessageRevision: 4,
          },
        }),
      );
    } finally {
      await runtime.shutdown();
    }
    const cancel: ChatCommand = {
      type: 'chat.cancel_queued_message',
      chatId: 'chat-1',
      queuedMessageId: 'queue-1',
      queuedMessageRevision: 2,
    };
    expect(
      CHAT_MESSAGE_COMMAND_ROUTES['chat.cancel_queued_message']?.toParams(
        cancel,
        request(cancel),
      ),
    ).toMatchObject({ entryId: 'queue-1', entryRevision: 2 });
  });
});
