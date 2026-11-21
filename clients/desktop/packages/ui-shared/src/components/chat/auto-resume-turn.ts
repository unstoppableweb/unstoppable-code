import { isRootUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { messageHasAgentActivity } from '@canopy/agent-transcript/lib/message-agent-activity';
import type { PersistedChatMessage } from '@canopy/agent-transcript';
import {
  readChatAutoResume,
  type AutoResumeMetadata,
  type RemoteControlChatMessage,
} from '@canopy/protocol/remote-control/shell';

interface TurnProjection<Message> {
  readonly root: (message: Message) => boolean;
  readonly candidate: (message: Message) => string | undefined;
  readonly hasActivity: (message: Message) => boolean;
  readonly settlement: (
    message: Message,
    turnId: string,
  ) => boolean | undefined;
}

function outputlessResumes<Message>(
  messages: readonly Message[],
  projection: TurnProjection<Message>,
): ReadonlySet<string> {
  const result = new Set<string>();
  let candidate: string | undefined;
  let settled = false;
  for (const message of messages) {
    if (projection.root(message)) {
      if (candidate !== undefined && settled) result.add(candidate);
      candidate = projection.candidate(message);
      settled = false;
    } else if (candidate !== undefined) {
      if (projection.hasActivity(message)) candidate = undefined;
      else settled = projection.settlement(message, candidate) ?? settled;
    }
  }
  if (candidate !== undefined && settled) result.add(candidate);
  return result;
}

function usageResend(metadata: AutoResumeMetadata | undefined): boolean {
  return metadata?.reason === 'usage_limit' && metadata.resendsUserMessage;
}

function timerSettlement(
  data: unknown,
  turnId: string,
  standalone: boolean,
): boolean | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if ('spawnedBy' in data && data.spawnedBy !== undefined) return undefined;
  const owner = 'userMessageId' in data ? data.userMessageId : undefined;
  if (owner === undefined ? !standalone : owner !== turnId) return undefined;
  return (
    'completedAt' in data &&
    typeof data.completedAt === 'number' &&
    Number.isFinite(data.completedAt)
  );
}

export function outputlessPersistedAutoResumes(
  messages: readonly PersistedChatMessage[],
  partialTurnIds: ReadonlySet<string>,
): ReadonlySet<string> {
  return outputlessResumes(messages, {
    root: isRootUserTurnBoundary,
    candidate: (message) =>
      message.userMessageSource === 'auto_resume' &&
      usageResend(message.autoResume) &&
      !partialTurnIds.has(message.id)
        ? message.id
        : undefined,
    hasActivity: messageHasAgentActivity,
    settlement: (message, turnId) => {
      const timer = message.blocks.find((block) => block.type === 'turn_timer');
      return timerSettlement(
        timer,
        turnId,
        message.role === 'system' && message.blocks.length === 1,
      );
    },
  });
}

const REMOTE_ACTIVITY_PARTS = new Set([
  'image',
  'thinking',
  'tool_use',
  'tool_result',
  'agent',
]);

export function outputlessProjectedAutoResumes(
  contiguousMessages: readonly RemoteControlChatMessage[],
  trailingTurnActive: boolean,
): ReadonlySet<string> {
  const lastRoot = trailingTurnActive
    ? contiguousMessages.findLast(
        (message) => message.role === 'user' && message.continuesTurn !== true,
      )
    : undefined;
  return outputlessResumes(contiguousMessages, {
    root: (message) =>
      message.role === 'user' && message.continuesTurn !== true,
    candidate: (message) =>
      message !== lastRoot &&
      message.status !== 'streaming' &&
      usageResend(readChatAutoResume(message))
        ? message.messageId
        : undefined,
    hasActivity: (message) =>
      (message.role === 'assistant' && message.text.trim().length > 0) ||
      (message.role !== 'user' &&
        (message.hasAgentActivity === true ||
          message.parts?.some(
            (part) =>
              REMOTE_ACTIVITY_PARTS.has(part.kind) ||
              (message.role === 'assistant' && part.kind === 'text'),
          ) === true)),
    settlement: (message, turnId) => {
      const timer = message.parts?.find((part) => part.kind === 'turn_timer');
      return timerSettlement(
        timer?.data,
        turnId,
        message.role === 'system' && message.parts?.length === 1,
      );
    },
  });
}

export function autoResumeIsMarkerOnly(
  metadata: AutoResumeMetadata | undefined,
  outputless: boolean,
): boolean {
  return (
    !!metadata &&
    (!metadata.resendsUserMessage || (outputless && usageResend(metadata)))
  );
}
