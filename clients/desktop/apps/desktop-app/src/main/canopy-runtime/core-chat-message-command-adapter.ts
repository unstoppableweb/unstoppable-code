import type { AgentSendAcceptanceFacts } from '@canopy/desktop-shared/lib/chat-send-actions';
import type {
  ChatSendMessageRequest,
  PersistedCommandReceipt,
} from '@canopy/desktop-shared/types';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CORE_INSTRUCTION_DEFINITIONS,
  CoreChatCommandReceiptSchema,
  type CanopyInstructionHandlerMap,
  type CanopyInstructionParams,
  type CanopyInstructionResult,
} from '@canopy/protocol/canopy-core';
import type {
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandExecutionOptions,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';
import {
  CanopyOperationError,
  canopyInvalidArgumentError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import type { DesktopDomainAdapter } from './desktop-runtime';
import type { ChatCommandRoute } from './core-chat-command-adapter';
import { ChatCommandKeyFingerprints } from './chat-command-key-fingerprints';

const legacyRequest = new AsyncLocalStorage<{
  request: ChatCommandEnvelope;
  executionOptions?: ChatCommandExecutionOptions;
  releaseAdmission?: () => void;
  acceptance?: AgentSendAcceptanceFacts;
}>();

export function withLegacyChatMessageCommand<Result>(
  request: ChatCommandEnvelope,
  call: () => Promise<Result>,
  releaseAdmission?: () => void,
  executionOptions?: ChatCommandExecutionOptions,
): Promise<Result> {
  return legacyRequest.run(
    { request, releaseAdmission, executionOptions },
    call,
  );
}

/** Main-only acceptance bookkeeping, carried beside the portable command. */
export function agentSendAcceptanceReceipt(
  request: ChatSendMessageRequest,
  acceptance: AgentSendAcceptanceFacts,
): Omit<PersistedCommandReceipt, 'revision'> | undefined {
  const context = legacyRequest.getStore();
  if (
    !request.agentSenderProvenance ||
    !context ||
    context.acceptance ||
    context.request.command.type !== 'chat.send_message' ||
    context.request.command.userMessageId !== request.userMessageId ||
    context.request.command.chatId !== request.chatId ||
    acceptance.acceptedInputId !== request.userMessageId ||
    context.request.projectId !== request.projectId ||
    context.request.worktreeId !== request.worktreeId
  )
    return undefined;
  return {
    commandId: context.request.commandId,
    outcome: 'applied',
    entityId: request.chatId,
    messageId: request.userMessageId,
    agentSendAcceptance: acceptance,
  };
}

export function reportAgentSendAccepted(
  request: ChatSendMessageRequest,
  acceptance: AgentSendAcceptanceFacts,
): void {
  const context = legacyRequest.getStore();
  if (!agentSendAcceptanceReceipt(request, acceptance) || !context) return;
  context.acceptance = acceptance;
  // A bookkeeping callback cannot turn a durable acceptance into a failed send.
  try {
    context.executionOptions?.onAgentSendAccepted?.(acceptance);
  } catch {
    /* Acceptance remains durable. */
  }
}

function requestScope(request: ChatCommandEnvelope): {
  workspaceId: string;
  worktreeId: string;
} {
  return { workspaceId: request.projectId, worktreeId: request.worktreeId };
}

function baseParams(request: ChatCommandEnvelope): {
  scope: { workspaceId: string; worktreeId: string };
  commandId: string;
  expectedRevision?: number;
  _meta: { idempotencyKey: string };
} {
  return {
    scope: requestScope(request),
    commandId: request.commandId,
    _meta: { idempotencyKey: request.commandId },
    ...(request.expectedRevision === undefined
      ? {}
      : { expectedRevision: request.expectedRevision }),
  };
}

function requireCommand<Type extends ChatCommand['type']>(
  command: ChatCommand,
  type: Type,
): Extract<ChatCommand, { type: Type }> {
  if (!isCommandType(command, type)) {
    throw new Error(`Expected ${type} chat command.`);
  }
  return command;
}

function isCommandType<Type extends ChatCommand['type']>(
  command: ChatCommand,
  type: Type,
): command is Extract<ChatCommand, { type: Type }> {
  return command.type === type;
}

type MessageInstructionName =
  | 'core.chat.message.send'
  | 'core.chat.queue.entry.cancel'
  | 'core.chat.queue.entry.update'
  | 'core.chat.queue.entry.force';

export const CHAT_MESSAGE_COMMAND_ROUTES: Partial<
  Record<ChatCommand['type'], ChatCommandRoute>
> = {
  'chat.send_message': {
    instruction: 'core.chat.message.send',
    toParams: (command, request) => {
      const send = requireCommand(command, 'chat.send_message');
      return {
        ...baseParams(request),
        chatId: send.chatId,
        messageId: send.userMessageId,
        text: send.text,
        ...(send.trackedPlanImplementation
          ? { trackedPlanImplementation: send.trackedPlanImplementation }
          : {}),
        ...(send.planReviewApproval
          ? { planReviewApproval: send.planReviewApproval }
          : {}),
      };
    },
    toLegacyResult: (result) => CoreChatCommandReceiptSchema.parse(result),
  },
  'chat.commit_terminal_initial_prompt': {
    instruction: 'core.chat.message.send',
    toParams: (command, request) => {
      const prompt = requireCommand(
        command,
        'chat.commit_terminal_initial_prompt',
      );
      return {
        ...baseParams(request),
        chatId: prompt.chatId,
        messageId: prompt.userMessageId,
        text: prompt.text,
        origin: {
          kind: 'terminalInitialPrompt',
          turnTimerMessageId: prompt.turnTimerMessageId,
        },
      };
    },
    toLegacyResult: (result) => CoreChatCommandReceiptSchema.parse(result),
  },
  'chat.cancel_queued_message': {
    instruction: 'core.chat.queue.entry.cancel',
    toParams: (command, request) => {
      const cancel = requireCommand(command, 'chat.cancel_queued_message');
      return {
        ...baseParams(request),
        chatId: cancel.chatId,
        entryId: cancel.queuedMessageId,
        ...(cancel.queuedMessageRevision !== undefined
          ? { entryRevision: cancel.queuedMessageRevision }
          : {}),
      };
    },
    toLegacyResult: (result) => CoreChatCommandReceiptSchema.parse(result),
  },
  'chat.edit_queued_message': {
    instruction: 'core.chat.queue.entry.update',
    toParams: (command, request) => {
      const edit = requireCommand(command, 'chat.edit_queued_message');
      return {
        ...baseParams(request),
        chatId: edit.chatId,
        entryId: edit.queuedMessageId,
        ...(edit.queuedMessageRevision !== undefined
          ? { entryRevision: edit.queuedMessageRevision }
          : {}),
        mutation: {
          kind: 'edit',
          text: edit.text,
          ...(edit.inputMode ? { inputMode: edit.inputMode } : {}),
        },
      };
    },
    toLegacyResult: (result) => CoreChatCommandReceiptSchema.parse(result),
  },
  'chat.steer_queued_message': {
    instruction: 'core.chat.queue.entry.update',
    toParams: (command, request) => {
      const steer = requireCommand(command, 'chat.steer_queued_message');
      return {
        ...baseParams(request),
        chatId: steer.chatId,
        entryId: steer.queuedMessageId,
        ...(steer.queuedMessageRevision !== undefined
          ? { entryRevision: steer.queuedMessageRevision }
          : {}),
        mutation: { kind: 'steer' },
      };
    },
    toLegacyResult: (result) => CoreChatCommandReceiptSchema.parse(result),
  },
  'chat.move_queued_message': {
    instruction: 'core.chat.queue.entry.update',
    toParams: (command, request) => {
      const move = requireCommand(command, 'chat.move_queued_message');
      return {
        ...baseParams(request),
        chatId: move.chatId,
        entryId: move.queuedMessageId,
        ...(move.queuedMessageRevision !== undefined
          ? { entryRevision: move.queuedMessageRevision }
          : {}),
        mutation: { kind: 'move', beforeEntryId: move.beforeQueuedMessageId },
      };
    },
    toLegacyResult: (result) => CoreChatCommandReceiptSchema.parse(result),
  },
  'chat.set_queued_message_edit_lock': {
    instruction: 'core.chat.queue.entry.update',
    toParams: (command, request) => {
      const lock = requireCommand(command, 'chat.set_queued_message_edit_lock');
      return {
        ...baseParams(request),
        chatId: lock.chatId,
        entryId: lock.queuedMessageId,
        ...(lock.queuedMessageRevision !== undefined
          ? { entryRevision: lock.queuedMessageRevision }
          : {}),
        mutation: {
          kind: 'lock',
          locked: lock.locked,
          ...(lock.acquisitionId !== undefined
            ? { acquisitionId: lock.acquisitionId }
            : {}),
        },
      };
    },
    toLegacyResult: (result) => CoreChatCommandReceiptSchema.parse(result),
  },
  'chat.force_queued_message': {
    instruction: 'core.chat.queue.entry.force',
    toParams: (command, request) => {
      const force = requireCommand(command, 'chat.force_queued_message');
      return {
        ...baseParams(request),
        chatId: force.chatId,
        entryId: force.queuedMessageId,
        ...(force.queuedMessageRevision !== undefined
          ? { entryRevision: force.queuedMessageRevision }
          : {}),
      };
    },
    toLegacyResult: (result) => CoreChatCommandReceiptSchema.parse(result),
  },
};

function queueUpdateCommand(
  params: CanopyInstructionParams<'core.chat.queue.entry.update'>,
): ChatCommand {
  const { mutation } = params;
  switch (mutation.kind) {
    case 'steer':
      return {
        type: 'chat.steer_queued_message',
        chatId: params.chatId,
        queuedMessageId: params.entryId,
        ...(params.entryRevision !== undefined
          ? { queuedMessageRevision: params.entryRevision }
          : {}),
      };
    case 'move':
      return {
        type: 'chat.move_queued_message',
        chatId: params.chatId,
        queuedMessageId: params.entryId,
        beforeQueuedMessageId: mutation.beforeEntryId,
        ...(params.entryRevision !== undefined
          ? { queuedMessageRevision: params.entryRevision }
          : {}),
      };
    case 'edit':
      return {
        type: 'chat.edit_queued_message',
        chatId: params.chatId,
        queuedMessageId: params.entryId,
        text: mutation.text,
        ...(mutation.inputMode ? { inputMode: mutation.inputMode } : {}),
        ...(params.entryRevision !== undefined
          ? { queuedMessageRevision: params.entryRevision }
          : {}),
      };
    case 'lock':
      return {
        type: 'chat.set_queued_message_edit_lock',
        chatId: params.chatId,
        queuedMessageId: params.entryId,
        locked: mutation.locked,
        ...(mutation.acquisitionId !== undefined
          ? { acquisitionId: mutation.acquisitionId }
          : {}),
        ...(params.entryRevision !== undefined
          ? { queuedMessageRevision: params.entryRevision }
          : {}),
      };
  }
}

type MessageHandlers = Pick<
  CanopyInstructionHandlerMap<CanopyHandlerContext>,
  MessageInstructionName
>;

export function createCoreChatMessageAdapter(
  getPort: () => ChatStateCommandPort,
  fingerprints = new ChatCommandKeyFingerprints(),
): DesktopDomainAdapter {
  const invoke = async <Name extends MessageInstructionName>(
    name: Name,
    params: CanopyInstructionParams<Name>,
    command: ChatCommand,
    context: CanopyHandlerContext,
  ): Promise<CanopyInstructionResult<MessageInstructionName>> => {
    if (
      context.metadata.idempotencyKey !== params.commandId ||
      params._meta.idempotencyKey !== params.commandId
    ) {
      throw canopyInvalidArgumentError(
        'Chat command id must match the idempotency key.',
      );
    }
    const release = fingerprints.claim(
      {
        projectId: params.scope.workspaceId,
        worktreeId: params.scope.worktreeId,
      },
      params.commandId,
      name,
      params,
    );
    try {
      return await invokeClaimed(name, params, command);
    } catch (error) {
      release();
      throw error;
    }
  };
  const invokeClaimed = async <Name extends MessageInstructionName>(
    name: Name,
    params: CanopyInstructionParams<Name>,
    command: ChatCommand,
  ): Promise<CanopyInstructionResult<MessageInstructionName>> => {
    const capture = legacyRequest.getStore();
    const captured = capture?.request;
    let request: ChatCommandEnvelope = captured ?? {
      schemaVersion: 1,
      commandId: params.commandId,
      projectId: params.scope.workspaceId,
      worktreeId: params.scope.worktreeId,
      ...(params.expectedRevision === undefined
        ? {}
        : { expectedRevision: params.expectedRevision }),
      command,
    };
    if (
      request.commandId !== params.commandId ||
      request.projectId !== params.scope.workspaceId ||
      request.worktreeId !== params.scope.worktreeId ||
      request.expectedRevision !== params.expectedRevision ||
      CHAT_MESSAGE_COMMAND_ROUTES[request.command.type]?.instruction !== name
    ) {
      throw new Error(`${name} requires a matching chat command.`);
    }
    const port = getPort();
    if (!captured && command.type === 'chat.edit_queued_message') {
      const scope = {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
      };
      const receipt = await port.getCommandReceipt?.({
        ...scope,
        commandId: request.commandId,
      });
      if (!receipt) {
        const snapshot = await port.getState(scope);
        if (
          params.expectedRevision !== undefined &&
          params.expectedRevision !== snapshot.revision
        ) {
          return CoreChatCommandReceiptSchema.parse({
            commandId: request.commandId,
            revision: snapshot.revision,
            outcome: 'conflict',
            reason: `Expected revision ${params.expectedRevision}, current revision is ${snapshot.revision}`,
          });
        }
        const entry = snapshot.queue
          .find((queue) => queue.chatId === command.chatId)
          ?.queue.find((entry) => entry.id === command.queuedMessageId);
        if (!entry) {
          return CoreChatCommandReceiptSchema.parse({
            commandId: request.commandId,
            revision: snapshot.revision,
            outcome: 'not_found',
          });
        }
        request = {
          ...request,
          expectedRevision: snapshot.revision,
          command: {
            ...command,
            fileReferences: entry.fileReferences,
            attachmentPaths: entry.attachmentPaths,
            attachmentPromptContexts: entry.attachmentPromptContexts,
          },
        };
      }
    }
    const result = capture?.executionOptions
      ? port.command(request, capture.executionOptions)
      : port.command(request);
    capture?.releaseAdmission?.();
    return CORE_INSTRUCTION_DEFINITIONS[name].result.parse(await result);
  };
  const instructions: MessageHandlers = {
    'core.chat.message.send': (params, context) => {
      // Desktop attachments and composer settings stay in the trusted
      // in-process binding; refused rather than dropped (CAN-6092).
      const unsupported = (
        ['attachments', 'model', 'modelConfig', 'fileReferences'] as const
      ).filter((field) => params[field] !== undefined);
      if (unsupported.length > 0)
        throw new CanopyOperationError({
          kind: 'capability_unavailable',
          message: 'These send fields are not available on this core.',
          details: { unsupported },
          retry: { kind: 'never' },
        });
      return invoke(
        'core.chat.message.send',
        params,
        params.origin
          ? {
              type: 'chat.commit_terminal_initial_prompt',
              chatId: params.chatId,
              userMessageId: params.messageId,
              turnTimerMessageId: params.origin.turnTimerMessageId,
              text: params.text,
            }
          : {
              type: 'chat.send_message',
              chatId: params.chatId,
              userMessageId: params.messageId,
              text: params.text,
              ...(params.trackedPlanImplementation
                ? {
                    trackedPlanImplementation: params.trackedPlanImplementation,
                  }
                : {}),
              ...(params.planReviewApproval
                ? { planReviewApproval: params.planReviewApproval }
                : {}),
            },
        context,
      );
    },
    'core.chat.queue.entry.cancel': (params, context) =>
      invoke(
        'core.chat.queue.entry.cancel',
        params,
        {
          type: 'chat.cancel_queued_message',
          chatId: params.chatId,
          queuedMessageId: params.entryId,
          ...(params.entryRevision !== undefined
            ? { queuedMessageRevision: params.entryRevision }
            : {}),
        },
        context,
      ),
    'core.chat.queue.entry.update': (params, context) =>
      invoke(
        'core.chat.queue.entry.update',
        params,
        queueUpdateCommand(params),
        context,
      ),
    'core.chat.queue.entry.force': (params, context) =>
      invoke(
        'core.chat.queue.entry.force',
        params,
        {
          type: 'chat.force_queued_message',
          chatId: params.chatId,
          queuedMessageId: params.entryId,
          ...(params.entryRevision !== undefined
            ? { queuedMessageRevision: params.entryRevision }
            : {}),
        },
        context,
      ),
  };
  return { instructions };
}
