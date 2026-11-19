import type { ExternalAgentSender } from '@canopy/protocol/portal';
import { RpcPublicError } from '../transport/rpc-peer';
import type {
  ChatCommand,
  ChatCommandExecutionOptions,
  ChatCommandRequest,
  ChatCommandResult,
  McpQuestionAnswer,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import type { ChatQuestionRespondOutcome } from '../../chat-questions/respond';

/**
 * A hosted agent session's `chat:command`, served by this computer itself
 * rather than replayed through the bridge window (CAN-5985). The session's
 * argument policy (`hostedInvocationAllowed`) has already admitted the call:
 * a new chat, a message, or an answer to an ordinary question. Here the host
 *
 * - stamps the agent attribution it derived from the authenticated session on
 *   every message and answer, as Portal stamps an external agent's command
 *   origin, so the person sees who sent it;
 * - starts a new chat on the same default model Portal's create resolves, so
 *   the first prompt runs; and
 * - refuses an answer to a secret-input question, which only the person may
 *   give.
 */

type CreateTabCommand = Extract<ChatCommand, { type: 'chat.create_tab' }>;

/**
 * What Portal's create resolves for a new chat (`resolveRemoteCreateTabSeed`):
 * the starting model and settings, or why no model can run one.
 */
export type HostedCreateTabSeed =
  | { readonly refusal: string }
  | Omit<CreateTabCommand, 'type' | 'tabId'>;

/** Who a hosted session's chat commands are attributed to. */
export interface HostedChatAttribution {
  readonly sender: ExternalAgentSender;
  /** The pinned hosted root the session acts for. */
  readonly rootDeviceId: string;
  /** The delegated session's own device. */
  readonly sessionDeviceId: string;
}

export interface HostedQuestionAnswerRequest {
  readonly scope: { readonly projectId: string; readonly worktreeId: string };
  readonly chatId: string;
  readonly questionId: string;
  readonly answers: McpQuestionAnswer[];
  readonly commandId: string;
  readonly attribution: HostedChatAttribution;
}

export interface HostedChatDispatchDeps {
  /** The chat command validation renderer IPC applies (no main-only fields). */
  validate(request: unknown): ChatCommandRequest;
  /** Main's trusted chat dispatch, as Portal's commands use it. */
  dispatch(
    request: ChatCommandRequest,
    attribution: HostedChatAttribution,
    options?: ChatCommandExecutionOptions,
  ): Promise<ChatCommandResult>;
  /** Portal's create seed for a new chat in `projectId`. */
  createSeed(projectId: string, model?: string): Promise<HostedCreateTabSeed>;
  /** Portal's create preflight for an explicitly chosen model. */
  modelRefusal(
    target: { projectId: string; worktreeId: string; chatId: string },
    model: string,
  ): Promise<string | null>;
  /** The persisted question a request ID names, if any. */
  pendingQuestion(
    scope: { projectId: string; worktreeId: string },
    chatId: string,
    questionId: string,
  ): Promise<PersistedPendingQuestion | undefined>;
  /** Portal's question settlement (`respondToChatQuestion`). */
  answerQuestion(
    request: HostedQuestionAnswerRequest,
  ): Promise<ChatQuestionRespondOutcome>;
  /** Whether an accepted send started its turn or waits in the queue. */
  sendDelivery?(
    target: { projectId: string; worktreeId: string; chatId: string },
    userMessageId: string,
  ): Promise<{ delivery?: 'accepted' | 'queued' }>;
}

/** A send's reply also says whether it started or was queued, as Portal's does. */
export type HostedChatCommandResult = ChatCommandResult & {
  delivery?: 'accepted' | 'queued';
};

export const HOSTED_SECRET_ANSWER_REFUSAL =
  "Agents can't answer a secret question. Answer it on this computer.";

function refused(
  request: ChatCommandRequest,
  outcome: 'rejected' | 'not_found' | 'conflict',
  reason?: string,
): ChatCommandResult {
  // Refused before anything changed, so no revision was written.
  return {
    commandId: request.commandId,
    revision: 0,
    outcome,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function createHostedChatDispatcher(
  deps: HostedChatDispatchDeps,
): (
  request: unknown,
  attribution: HostedChatAttribution,
) => Promise<HostedChatCommandResult> {
  return async (value, attribution) => {
    const request = deps.validate(value);
    const command = request.command;
    switch (command.type) {
      case 'chat.create_tab': {
        const target = {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: command.tabId,
        };
        if (command.model !== undefined) {
          const refusal = await deps.modelRefusal(target, command.model);
          if (refusal !== null) return refused(request, 'rejected', refusal);
        }
        const seed = await deps.createSeed(request.projectId, command.model);
        // Never a modelless chat, whose first prompt could not run.
        if ('refusal' in seed)
          return refused(request, 'rejected', seed.refusal);
        return deps.dispatch(
          {
            ...request,
            origin: 'portal',
            command: {
              ...seed,
              type: 'chat.create_tab',
              tabId: command.tabId,
              ...(command.planMode === undefined
                ? {}
                : { planMode: command.planMode }),
            },
          },
          attribution,
        );
      }
      case 'chat.send_message': {
        if (command.model !== undefined) {
          const refusal = await deps.modelRefusal(
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: command.chatId,
            },
            command.model,
          );
          if (refusal !== null) return refused(request, 'rejected', refusal);
        }
        const sent = await deps.dispatch(
          {
            ...request,
            origin: 'portal',
            command: { ...command, agentSent: attribution.sender },
          },
          attribution,
        );
        if (
          deps.sendDelivery === undefined ||
          (sent.outcome !== 'applied' && sent.outcome !== 'already_applied')
        )
          return sent;
        return {
          ...sent,
          ...(await deps.sendDelivery(
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: command.chatId,
            },
            sent.messageId ?? command.userMessageId,
          )),
        };
      }
      case 'chat.answer_question': {
        const scope = {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
        };
        const record = await deps.pendingQuestion(
          scope,
          command.chatId,
          command.questionId,
        );
        if (record?.questions.some((question) => question.secret === true)) {
          return refused(request, 'rejected', HOSTED_SECRET_ANSWER_REFUSAL);
        }
        const outcome = await deps.answerQuestion({
          scope,
          chatId: command.chatId,
          questionId: command.questionId,
          answers: command.answers,
          commandId: request.commandId,
          attribution,
        });
        switch (outcome.status) {
          case 'applied':
          case 'already_settled':
            return outcome.result;
          case 'not_found':
            return refused(request, 'not_found');
          case 'conflict':
            return refused(request, 'conflict');
          case 'cancelled':
            return refused(
              request,
              'rejected',
              'The question is no longer awaiting a response.',
            );
          case 'invalid':
            return refused(request, 'rejected', outcome.message);
          case 'unavailable':
            // The answer may or may not have been taken: never a refusal.
            throw new RpcPublicError(
              'The chat state service is temporarily unavailable.',
            );
        }
        break;
      }
      default:
        break;
    }
    return refused(
      request,
      'rejected',
      'Agents can only start chats, send messages and answer questions.',
    );
  };
}
