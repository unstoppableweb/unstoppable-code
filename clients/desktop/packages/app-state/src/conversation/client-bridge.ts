import type {
  PortalChatEventPayload,
  PortalChatMessage,
} from '@canopy/protocol/portal';
import type {
  ConversationPresentation,
  ConversationProjectedMessage,
} from '@canopy/app-core/conversation';

export interface ConversationHostBridgeTarget {
  emitChatMessage(payload: PortalChatEventPayload): void;
  /**
   * Open the turn's timer under its local user message id; the canonical id
   * lets the target match Auto-routing attribution recorded from the receipt.
   */
  startTurn(
    chatId: string,
    userMessageId: string,
    canonicalUserMessageId: string,
    startedAtMs?: number,
    hostOwnsTimer?: boolean,
  ): void;
  /** `turnId` is Core's id for the turn that stopped running. */
  settleTurn(
    chatId: string,
    status: 'complete' | 'failed',
    turnId?: string,
  ): void;
  resetStream(chatId: string): void;
}

export interface ConversationHostClientBridgeOptions {
  readonly onTranscriptReplaced?: (chatId: string) => void;
  readonly fallbackUserAuthor?: {
    readonly userId: string;
    readonly name: string;
    readonly image?: string;
  };
}

export interface ConversationHostClientBridge {
  apply(view: ConversationPresentation): void;
  reset(): void;
}

interface EmittedMessage {
  readonly signature: string;
}

function signatureOf(message: ConversationProjectedMessage): string {
  return JSON.stringify([
    message.role,
    message.status,
    message.content,
    message.parts ?? null,
    message.attachments ?? null,
    message.occurredAt,
    message.clientRequestId ?? null,
    message.author ?? null,
    message.sourceKey ?? null,
    message.presentationOrder ?? null,
  ]);
}

function toMessage(
  message: ConversationProjectedMessage,
  fallbackUserAuthor?: {
    readonly userId: string;
    readonly name: string;
    readonly image?: string;
  },
): PortalChatMessage {
  const timestamp = Date.parse(message.occurredAt);
  const author =
    message.author ??
    (message.role === 'user' ? fallbackUserAuthor : undefined);
  return {
    messageId: message.localMessageId,
    ...(message.presentationOrder === undefined
      ? {}
      : { presentationOrder: message.presentationOrder }),
    ...(message.clientRequestId === undefined
      ? {}
      : { clientRequestId: message.clientRequestId }),
    ...(author === undefined ? {} : { author }),
    ...(message.sourceKey === undefined
      ? {}
      : { sourceKey: message.sourceKey }),
    chatId: message.localChatId,
    ...(message.role === 'user' ? { promptSource: 'human' as const } : {}),
    role:
      message.role === 'system'
        ? 'system'
        : message.role === 'user'
          ? 'user'
          : 'assistant',
    status:
      message.status === 'streaming' ||
      message.status === 'failed' ||
      message.status === 'cancelled'
        ? message.status
        : 'complete',
    text: message.content,
    ...(message.parts === undefined ? {} : { parts: message.parts }),
    ...(message.attachments === undefined
      ? {}
      : { attachments: message.attachments }),
    createdAtMs: Number.isFinite(timestamp) ? timestamp : 0,
  };
}

export function createConversationHostClientBridge(
  target: ConversationHostBridgeTarget,
  options: ConversationHostClientBridgeOptions = {},
): ConversationHostClientBridge {
  const emitted = new Map<string, EmittedMessage>();
  let chatId: string | null = null;
  let activeTurnId: string | null = null;

  const settle = (status: 'complete' | 'failed' = 'complete'): void => {
    if (activeTurnId === null || chatId === null) return;
    const turnId = activeTurnId;
    activeTurnId = null;
    target.settleTurn(chatId, status, turnId);
  };

  const reset = (): void => {
    if (chatId !== null) target.resetStream(chatId);
    activeTurnId = null;
  };

  return {
    apply(view): void {
      if (view.hostStatus === 'revoked' || view.hostStatus === 'error') {
        reset();
        emitted.clear();
        chatId = null;
        return;
      }
      const binding = view.binding;
      if (binding === null) {
        reset();
        emitted.clear();
        chatId = null;
        return;
      }
      const nextChatId = binding.localChatId;
      if (chatId !== null && nextChatId !== chatId) {
        reset();
        emitted.clear();
      }
      chatId = nextChatId;

      const present = new Set<string>();
      for (const row of view.transcript) {
        for (const message of row.projected) {
          present.add(message.localMessageId);
          const signature = signatureOf(message);
          if (emitted.get(message.localMessageId)?.signature === signature) {
            continue;
          }
          emitted.set(message.localMessageId, { signature });
          target.emitChatMessage({
            scope: 'worktree',
            workspaceLocalId: binding.workspaceLocalId,
            worktreeLocalId: binding.worktreeLocalId,
            chatId,
            message: toMessage(message, options.fallbackUserAuthor),
          });
        }
      }
      let replaced = false;
      for (const messageId of Array.from(emitted.keys())) {
        if (present.has(messageId)) continue;
        emitted.delete(messageId);
        replaced = true;
      }
      if (replaced) options.onTranscriptReplaced?.(chatId);

      if (
        activeTurnId !== null &&
        view.activeExecution?.turnId !== activeTurnId
      ) {
        settle(
          view.activeExecution === null && view.sessionStatus === 'FAILED'
            ? 'failed'
            : 'complete',
        );
      }
      if (
        view.activeExecution !== null &&
        view.activeExecution.turnId !== activeTurnId
      ) {
        const canonicalUserMessageId = view.activeExecution.userMessageId;
        const userMessageId =
          view.transcript.find(
            (row) => row.canonical.id === canonicalUserMessageId,
          )?.projected[0]?.localMessageId ?? canonicalUserMessageId;
        activeTurnId = view.activeExecution.turnId;
        target.startTurn(
          chatId,
          userMessageId,
          canonicalUserMessageId,
          view.activeExecution.startedAtMs ?? undefined,
          true,
        );
      }
    },
    reset(): void {
      reset();
      emitted.clear();
      chatId = null;
    },
  };
}
