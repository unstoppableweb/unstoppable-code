import { randomUUID } from 'node:crypto';
import type {
  ChatCommandExecutionOptions,
  ChatCommandRequest,
  ChatCommandResult,
  ChatStateCommandPort,
  McpAnswerUserResponse,
  McpQuestionAnswer,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import type {
  ChatWaitLifecycle,
  ChatWaitScope,
} from '@canopy/core-runtime/node/agent/waits';
import {
  validateQuestionControlAnswers,
  type ExternalAgentSender,
} from '@canopy/protocol/portal';
import { getDesktopChatWaits } from '../chat-waits/desktop-chat-waits';
import { getChatStateCommandPort } from '../ipc/chat-state';

const SETTLED_QUESTION_SCOPE_LIMIT = 256;
// A settled wait leaves the lifecycle, but its answered record stays. The
// renderer names a question only by request id, so a duplicate answer needs
// the scope to reach that record and settle as already answered (D6).
const settledQuestionScopes = new Map<string, ChatWaitScope>();
const observedLifecycles = new WeakSet<ChatWaitLifecycle>();

function questionWaits(): ChatWaitLifecycle {
  const lifecycle = getDesktopChatWaits();
  if (observedLifecycles.has(lifecycle)) return lifecycle;
  observedLifecycles.add(lifecycle);
  lifecycle.observe({
    opened: (): void => undefined,
    settled: ({ waitId, kind, scope }): void => {
      if (kind !== 'question' || !scope) return;
      settledQuestionScopes.delete(waitId);
      settledQuestionScopes.set(waitId, scope);
      if (settledQuestionScopes.size <= SETTLED_QUESTION_SCOPE_LIMIT) return;
      const oldest = settledQuestionScopes.keys().next().value;
      if (oldest !== undefined) settledQuestionScopes.delete(oldest);
    },
  });
  return lifecycle;
}

// shortcut: kept for the process, one entry per hot-reload question; prune on
// settle if person-only questions become common.
const personOnlyQuestions = new Set<string>();

/**
 * Mark a question only a person may answer, such as consent to run Mods
 * (decision 21): an answer counts only when its caller vouches that a person
 * gave it (`answeredByPerson`), and an external agent's answer or dismissal
 * is refused.
 */
export function markPersonOnlyChatQuestion(questionId: string): void {
  personOnlyQuestions.add(questionId);
}

/** Remember settled questions' scopes from now on; call before questions open. */
export function trackSettledChatQuestions(): void {
  questionWaits();
}

export type ChatQuestionResponse =
  | { kind: 'answer'; answers: McpQuestionAnswer[] }
  | { kind: 'dismiss' };

export type QuestionCommandExecutionOptions = ChatCommandExecutionOptions & {
  agentSent?: ExternalAgentSender;
  answeredByPerson?: true;
  /**
   * Set only by the `secretRequest.submit` / `secretRequest.decline`
   * handlers, after they stored the values. A RequestSecrets question
   * refuses every other answer or dismissal.
   */
  secretRequestSettlement?: true;
};

export interface RespondToChatQuestionRequest {
  scope: { projectId: string; worktreeId: string };
  chatId: string;
  /** The persisted question's requestId, the core wait's waitId (CAN-4128 D3). */
  questionId: string;
  response: ChatQuestionResponse;
  commandId: string;
  origin?: ChatCommandRequest['origin'];
  /** `agentSent` carries a trusted Portal sender's provenance. */
  executionOptions?: QuestionCommandExecutionOptions;
  /** A trusted external agent sent this answer or dismissal. */
  externalAgent?: ExternalAgentSender;
  /** Defaults to getChatStateCommandPort(). */
  port?: ChatStateCommandPort | null;
  /** Defaults to the port's command. Portal passes its trusted dispatch. */
  dispatch?: (
    request: ChatCommandRequest,
    executionOptions?: QuestionCommandExecutionOptions,
  ) => Promise<ChatCommandResult>;
}

export type ChatQuestionRespondOutcome =
  | { status: 'applied'; result: ChatCommandResult }
  | { status: 'already_settled'; result: ChatCommandResult }
  | { status: 'not_found' }
  | { status: 'cancelled' }
  | { status: 'invalid'; message: string }
  | { status: 'conflict' }
  | { status: 'unavailable' };

/**
 * The answer checks chat.answer_question runs, applied before dispatch: its
 * rejections after this point are storage or handoff failures, not bad input.
 */
function answerValidationError(
  record: PersistedPendingQuestion,
  answers: readonly McpQuestionAnswer[],
): string | undefined {
  if (record.delivery !== 'async')
    return validateQuestionControlAnswers(record.questions, answers);
  if (answers.length !== record.questions.length)
    return 'Answer every question before submitting';
  const invalid = record.questions.some((question, index) => {
    const answer = answers[index];
    return (
      !answer ||
      (answer.questionId !== undefined && answer.questionId !== question.id) ||
      answer.selectedOptions.length > 1 ||
      answer.selectedOptions.some(
        (option) => !question.options.includes(option),
      ) ||
      (!answer.selectedOptions.length && !answer.freeformText?.trim())
    );
  });
  return invalid ? 'Invalid question answer' : undefined;
}

/** The one settlement path for an ordinary chat question (CAN-4128 D4). */
export async function respondToChatQuestion(
  request: RespondToChatQuestionRequest,
): Promise<ChatQuestionRespondOutcome> {
  if (
    personOnlyQuestions.has(request.questionId) &&
    // Fails closed: a caller that does not vouch for a person (an MCP, CLI,
    // HTTP or daemon client of core.chat.question.respond) cannot answer.
    ((request.externalAgent ?? request.executionOptions?.agentSent) !==
      undefined ||
      (request.response.kind === 'answer' &&
        request.executionOptions?.answeredByPerson !== true))
  ) {
    return {
      status: 'invalid',
      message: 'Only a person can answer this question.',
    };
  }
  const port =
    request.port === undefined ? getChatStateCommandPort() : request.port;
  if (!port) return { status: 'unavailable' };
  const { scope, chatId, questionId, response } = request;

  let record: PersistedPendingQuestion | undefined;
  let secretRequestPending = false;
  try {
    const state = await port.getState(scope);
    record = state.tabsFile.pendingQuestions?.find(
      (question) =>
        question.requestId === questionId && question.chatId === chatId,
    );
    // The chat state also settles a question by its tool-use id alias.
    secretRequestPending =
      state.tabsFile.pendingQuestions?.some(
        (question) =>
          question.chatId === chatId &&
          (question.requestId === questionId ||
            question.toolUseId === questionId) &&
          question.questions.some((entry) => entry.secretRequest !== undefined),
      ) === true;
  } catch {
    return { status: 'unavailable' };
  }
  // A secret request settles only through its own form's channel, which
  // stores the values first; any other caller would resume the agent without
  // them, or with an answer it made up.
  if (
    secretRequestPending &&
    request.executionOptions?.secretRequestSettlement !== true
  )
    return {
      status: 'invalid',
      message: 'Answer this secret request in its form on this computer.',
    };
  // An answer must never commit for a provider that stopped listening (D7).
  if (
    response.kind === 'answer' &&
    record &&
    record.answeredAt === undefined &&
    record.delivery !== 'async' &&
    !getDesktopChatWaits().isOpen(questionId)
  )
    return { status: 'cancelled' };
  if (response.kind === 'answer' && record && record.answeredAt === undefined) {
    const invalid = answerValidationError(record, response.answers);
    if (invalid !== undefined) return { status: 'invalid', message: invalid };
  }

  const command: ChatCommandRequest = {
    schemaVersion: 1,
    commandId: request.commandId,
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    ...(request.origin ? { origin: request.origin } : {}),
    command:
      response.kind === 'answer'
        ? {
            type: 'chat.answer_question',
            chatId,
            questionId,
            answers: response.answers,
          }
        : { type: 'chat.dismiss_question', chatId, questionId },
  };
  const dispatch =
    request.dispatch ??
    ((
      next: ChatCommandRequest,
      options?: QuestionCommandExecutionOptions,
    ): Promise<ChatCommandResult> =>
      options ? port.command(next, options) : port.command(next));
  let result: ChatCommandResult;
  try {
    result = request.executionOptions
      ? await dispatch(command, request.executionOptions)
      : await dispatch(command);
  } catch {
    return { status: 'unavailable' };
  }

  switch (result.outcome) {
    case 'applied':
      return { status: 'applied', result };
    case 'already_applied':
      return { status: 'already_settled', result };
    case 'not_found':
      return { status: 'not_found' };
    case 'conflict':
      return { status: 'conflict' };
    case 'rejected':
      // Answers were validated above, so a reasoned rejection failed to commit.
      return result.reason === undefined
        ? { status: 'cancelled' }
        : { status: 'unavailable' };
  }
}

/** The chat of a waiting or recently settled question, by its request id. */
export function chatQuestionScope(requestId: string): ChatWaitScope | null {
  return (
    questionWaits().scopeOf(requestId) ??
    settledQuestionScopes.get(requestId) ??
    null
  );
}

/** Renderer IPC: settle a question by its request id, with a fresh command id. */
export function respondToLiveChatQuestion(
  requestId: string,
  response: ChatQuestionResponse,
  executionOptions?: QuestionCommandExecutionOptions,
): Promise<ChatQuestionRespondOutcome> {
  const live =
    questionWaits().scopeOf(requestId) ??
    settledQuestionScopes.get(requestId) ??
    null;
  if (!live) return Promise.resolve({ status: 'not_found' });
  return respondToChatQuestion({
    scope: { projectId: live.workspaceId, worktreeId: live.worktreeId },
    chatId: live.chatId,
    questionId: requestId,
    response,
    commandId: randomUUID(),
    ...(executionOptions ? { executionOptions } : {}),
  });
}

/**
 * The renderer's mcp:answer-user result. An unavailable chat state rejects, so
 * the renderer keeps the card for a retry instead of sending the answer as a
 * new message while the provider still waits (CAN-4128 review, D6 amended).
 */
export async function answerChatQuestionFromRenderer(
  requestId: string,
  answers: McpQuestionAnswer[],
): Promise<McpAnswerUserResponse> {
  // Only the window's question card sends this, so a person answered.
  const outcome = await respondToLiveChatQuestion(
    requestId,
    { kind: 'answer', answers },
    { answeredByPerson: true },
  );
  if (outcome.status === 'unavailable')
    throw new Error('The chat state service is temporarily unavailable.');
  return {
    accepted:
      outcome.status === 'applied' || outcome.status === 'already_settled',
  };
}
