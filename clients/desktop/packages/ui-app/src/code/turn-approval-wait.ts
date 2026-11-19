import type { RemoteControlChatMessage } from '@canopy/protocol/remote-control/shell';
import {
  NO_TOOL_APPROVAL_WAIT,
  isAskUserQuestionToolName,
  isTurnTimerPaused,
  readToolCallResult,
  type ToolApprovalWait,
} from '@canopy/ui-shared/components';
import { normalizeChatMessageParts } from './ChatMessageView';

/** Every pending call and file of a paused turn waits. */
const PAUSED_TURN_WAIT: ToolApprovalWait = {
  isCallWaiting: () => true,
  isFileWaiting: () => true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** A question still waiting on its answer holds the turn for its own form. */
function awaitsAnswer(messages: readonly RemoteControlChatMessage[]): boolean {
  return messages.some((message) =>
    normalizeChatMessageParts(message.parts ?? []).some((part) => {
      if (part.kind !== 'tool_use' || !isRecord(part.data)) return false;
      const toolName =
        typeof part.data.toolName === 'string'
          ? part.data.toolName
          : typeof part.data.name === 'string'
            ? part.data.name
            : '';
      return (
        isAskUserQuestionToolName(toolName) &&
        readToolCallResult(part.data.result) === null
      );
    }),
  );
}

/**
 * The Portal's turn-level approval signal. The paired desktop projects no
 * pending-approval collection, only the turn timer's pause, so an unfinished
 * turn whose timer is paused marks every call still without a result as
 * waiting; a resume or the turn's end clears it. This is an approximation:
 * a pause names no single call, so an unrelated unresolved call in the same
 * turn waits too. A pending question is the turn's known other reason to
 * pause, so its turn keeps its own presentation. Cloud timers project no
 * pause, so cloud turns never wait (see `docs/tool-approvals.md`).
 */
export function remoteControlTurnApprovalWait({
  complete,
  timer,
  messages,
}: {
  readonly complete: boolean;
  readonly timer: unknown;
  readonly messages: readonly RemoteControlChatMessage[];
}): ToolApprovalWait {
  if (complete || !isRecord(timer)) return NO_TOOL_APPROVAL_WAIT;
  const paused = isTurnTimerPaused({
    finishedAt: readNumber(timer.completedAt) ?? null,
    pausedAt: readNumber(timer.pausedAt) ?? null,
    resumedAt: readNumber(timer.resumedAt) ?? null,
  });
  if (!paused || awaitsAnswer(messages)) return NO_TOOL_APPROVAL_WAIT;
  return PAUSED_TURN_WAIT;
}
