import type { AutomationRunResult } from '@canopy/desktop-shared/types';
import type {
  ExecutionEvent,
  ExecutionState,
  PipelineChatSendRecord,
} from '@canopy/execution-engine/types/pipeline';
import { listExecutionChatSends } from '@canopy/execution-engine/node/pipelines/executor/chat-sends';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { logMainProcessError } from '../lib/main-process-logging';

/** The run-result fields that name a chat an automation sent to. */
export type AutomationRunChatFields = Pick<
  AutomationRunResult,
  | 'appAdvisorChatId'
  | 'standaloneChatId'
  | 'projectId'
  | 'worktreeId'
  | 'chatId'
  | 'userMessageId'
>;

/**
 * The run-result fields for a chat a pipeline sent to, in the shape the
 * automation chat actions use (CAN-5381): a bot chat as `appAdvisorChatId`, a
 * Cowork chat as `standaloneChatId` and `projectId`, and a code project chat
 * as its `projectId`/`worktreeId`/`chatId`. Always `userMessageId`.
 */
export function automationRunResultFromChatSend(
  record: PipelineChatSendRecord,
  projectType: 'code' | 'cowork' | undefined,
): AutomationRunChatFields {
  const { address, userMessageId } = record;
  if (address.kind === 'bot')
    return { appAdvisorChatId: address.chatId, userMessageId };
  if (projectType === 'cowork')
    return {
      standaloneChatId: address.chatId,
      projectId: address.projectId,
      userMessageId,
    };
  return {
    projectId: address.projectId,
    worktreeId: address.taskId,
    chatId: address.chatId,
    userMessageId,
  };
}

/**
 * The fields for the last chat an execution sent to, or `undefined` when it
 * sent nothing. A child pipeline's sends live on the child's execution and
 * are not included.
 */
export function lastChatSendRunResult(
  state: ExecutionState,
): AutomationRunChatFields | undefined {
  const sends = listExecutionChatSends(state);
  const last = sends[sends.length - 1];
  if (!last) return undefined;
  return automationRunResultFromChatSend(
    last,
    last.address.kind === 'project'
      ? isCoworkWorkspace(last.address.projectId)
        ? 'cowork'
        : 'code'
      : undefined,
  );
}

/** The last send handed over per execution, so repeated events skip it. */
const handedOver = new Map<string, string>();

/**
 * Hand an automation's execution to the automations service whenever it has
 * recorded a new send (CAN-4551), and when it ends (CAN-5381). The service is
 * loaded lazily: it starts pipelines itself.
 */
export function noteAutomationPipelineEvent(event: ExecutionEvent): void {
  const { state, executionId } = event;
  if (state.initiator?.kind !== 'automation') return;
  const ended =
    state.status === 'success' ||
    state.status === 'failure' ||
    state.status === 'cancelled';
  const sends = listExecutionChatSends(state);
  const last = sends[sends.length - 1]?.userMessageId;
  if (ended) handedOver.delete(executionId);
  if (last === undefined || (!ended && handedOver.get(executionId) === last))
    return;
  if (!ended) handedOver.set(executionId, last);
  void import('./service')
    .then(({ getAutomationsService }) =>
      getAutomationsService().recordPipelineRunChatSend(event),
    )
    .catch((error: unknown) =>
      logMainProcessError(
        'Failed to record the chat an automation pipeline sent to',
        error,
      ),
    );
}
