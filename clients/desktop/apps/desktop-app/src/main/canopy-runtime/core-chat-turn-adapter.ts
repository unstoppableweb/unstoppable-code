import type {
  CanopyInstructionHandlerMap,
  CanopyInstructionResult,
} from '@canopy/protocol/canopy-core';
import { chatDisplayLabel } from '@canopy/protocol';
import type {
  ArchivedChatSummary,
  ChatCancelRequest,
  ChatCancelResult,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import {
  CanopyOperationError,
  canopyInternalError,
} from '@canopy/core-runtime';
import { listState } from './core-chat-state-adapter';

type TurnCancelResult = CanopyInstructionResult<'core.chat.turn.cancel'>;

/** Desktop effects behind `core.chat.turn.cancel`. */
export interface CoreChatTurnCancelHost {
  /**
   * Scopes that may hold `chatId`: those with turn state in this process and
   * those the chat-search index lists. `getState` confirms each.
   */
  scopesForChat(chatId: string): Promise<readonly ChatCancelRequest[]>;
  getState(scope: ChatCancelRequest): Promise<ChatStateSnapshot>;
  /** The user's Stop, only while `userMessageId` is the active turn; else null. */
  stop(
    request: ChatCancelRequest,
    userMessageId: string,
  ): Promise<ChatCancelResult | null>;
}

const notFound = (): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'not_found',
    message: 'The chat was not found.',
    retry: { kind: 'never' },
  });

function archivedResult(
  state: ChatStateSnapshot,
  chat: ArchivedChatSummary,
): TurnCancelResult {
  return {
    chatId: chat.chatId,
    workspaceId: state.projectId,
    worktreeId: state.worktreeId,
    title: chatDisplayLabel({
      customTitle: chat.customTitle,
      fallback: chat.title,
    }),
    state: 'archived',
    revision: state.revision,
    ...(chat.providerType === undefined
      ? {}
      : { providerId: chat.providerType }),
    ...(chat.model === undefined ? {} : { modelId: chat.model }),
    createdAt: chat.createdAt,
    updatedAt: chat.archivedAt,
  };
}

/** A chat's summary as core.chat.turn.cancel and core.chat.question.respond return it; null when the chat is not open. */
export function chatSummaryOf(
  state: ChatStateSnapshot,
  chatId: string,
): TurnCancelResult | null {
  const tab = state.tabsFile.tabs.find((item) => item.id === chatId);
  if (!tab) return null;
  const runtime = state.runtimeByChatId[chatId];
  return {
    chatId: tab.id,
    workspaceId: state.projectId,
    worktreeId: state.worktreeId,
    title: chatDisplayLabel({
      customTitle: tab.customTitle,
      fallback: tab.title,
    }),
    // The state after this Stop: idle once settled, as for a turn
    // already over; another turn may have started since.
    state: listState(runtime?.status),
    revision: state.revision,
    ...(tab.providerType === undefined ? {} : { providerId: tab.providerType }),
    ...(tab.model === undefined ? {} : { modelId: tab.model }),
    createdAt: tab.createdAt,
    updatedAt:
      runtime?.lastActivityAt === undefined
        ? tab.createdAt
        : new Date(runtime.lastActivityAt).toISOString(),
  };
}

/**
 * Exact-turn Stop (CAN-5485). A desktop turn is named by its user message id,
 * the id `core.chat.message.send` takes and the transcript's turn view returns.
 */
export function createCoreChatTurnAdapter(
  host: CoreChatTurnCancelHost,
): Pick<CanopyInstructionHandlerMap, 'core.chat.turn.cancel'> {
  return {
    'core.chat.turn.cancel': async (params): Promise<TurnCancelResult> => {
      // Desktop's Stop is always the user's, as the web core's is.
      if (params.reason !== 'user')
        throw new CanopyOperationError({
          kind: 'capability_unavailable',
          message: 'Desktop chats do not serve these fields.',
          details: {
            unsupported: ['reason'],
            reason: `cancel_${params.reason}_unsupported`,
          },
          retry: {
            kind: 'after_refresh',
            resource: 'core.runtime.manifest.get',
          },
        });
      let scope: ChatCancelRequest | undefined;
      let state: ChatStateSnapshot | undefined;
      let archived:
        | { state: ChatStateSnapshot; chat: ArchivedChatSummary }
        | undefined;
      let readError: unknown;
      for (const candidate of await host.scopesForChat(params.chatId)) {
        let read: ChatStateSnapshot;
        try {
          read = await host.getState(candidate);
        } catch (error) {
          // An indexed scope can be gone; another candidate may still hold it.
          readError = error;
          continue;
        }
        if (read.tabsFile.tabs.some((tab) => tab.id === params.chatId)) {
          scope = candidate;
          state = read;
          if (
            read.runtimeByChatId[params.chatId]?.activeTurn?.userMessageId ===
            params.turnId
          )
            break;
        } else {
          const chat = read.archives.find(
            (item) => item.chatId === params.chatId,
          );
          if (chat) archived ??= { state: read, chat };
        }
      }
      if (!scope || !state) {
        // An archived chat runs no turn: nothing to stop, as for a turn over.
        if (archived) return archivedResult(archived.state, archived.chat);
        if (readError !== undefined)
          throw canopyInternalError('Chat state read failed.', readError);
        throw notFound();
      }
      const stopped = await host.stop(scope, params.turnId);
      // Read after the attempt either way, so the reply is never stale.
      state = await host.getState(scope);
      const summary = chatSummaryOf(state, params.chatId);
      if (!summary) throw notFound();
      return {
        ...summary,
        ...(stopped?.resumableTurn
          ? { resumableTurn: stopped.resumableTurn }
          : {}),
      };
    },
  };
}
