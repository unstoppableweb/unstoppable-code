import { isBotsExperimentEnabled } from '../bots/gate';
import type { AgentSenderRuntimeSource } from '../agent-messaging/sender-context';

export const AUTOMATION_TURN_SCHEDULE_ERROR = {
  code: 'unsupported_action',
  message: 'An automation run cannot create or change schedules.',
} as const;

export async function refusesAutomationTurnScheduleMutation(
  caller: AgentSenderRuntimeSource,
): Promise<boolean> {
  if (!isBotsExperimentEnabled()) return false;
  const [{ getChatQueueService }, { getClaudeTerminalSessionService }] =
    await Promise.all([
      import('../services/chat-queue-service'),
      import('../integration/claude-terminal-session-service'),
    ]);
  return (
    getChatQueueService().runningAutomationTurn(caller) ||
    getClaudeTerminalSessionService().runningAutomationTurn(caller)
  );
}
