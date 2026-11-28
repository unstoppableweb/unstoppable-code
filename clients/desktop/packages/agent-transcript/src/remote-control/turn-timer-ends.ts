import { isRootUserTurnBoundary } from '../lib/turn-boundary';
import type { PersistedChatMessage } from '../types';
import type { RemoteControlChatMessage } from '@canopy/protocol/remote-control/shell';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Main-owned outcomes, keyed by the turn's user message. */
export interface TurnTimerEndRecords {
  turnEnds?: Readonly<
    Record<string, { outcome: 'completed' | 'failed' | 'cancelled' }>
  >;
  unacceptedTurnEnds?: Readonly<Record<string, 'failed' | 'cancelled'>>;
  interruptedTurns?: Readonly<Record<string, unknown>>;
}

/**
 * The key a timer's recorded end is filed under: a canonical timer's own
 * prompt, or for one with no prompt its wake (`${timer.id}:wake`), as the
 * desktop renderer reads it; a legacy timer's turn prompt.
 */
function turnTimerEndOwner(
  message: PersistedChatMessage,
  turnPrompt: string | undefined,
): string | undefined {
  const block = message.blocks[0];
  if (block?.type !== 'turn_timer') return undefined;
  if (block.turnId === undefined) return turnPrompt;
  return block.userMessageId ?? `${message.id}:wake`;
}

/**
 * Lays each completed timer's end over its projected message as `endReason`.
 * A recorded end describes its prompt's latest run, so only that run's timer
 * takes it (and a restart's interruption mark); without a record, a timer's
 * own cancelled or failed outcome is its end.
 */
export function withTurnTimerEnds(
  rootMessages: readonly PersistedChatMessage[],
  projected: readonly RemoteControlChatMessage[],
  records: TurnTimerEndRecords,
): RemoteControlChatMessage[] {
  const latestTimerByOwner = new Map<string, string>();
  const owners: (string | undefined)[] = [];
  let prompt: string | undefined;
  for (const message of rootMessages) {
    if (isRootUserTurnBoundary(message)) prompt = message.id;
    const owner = turnTimerEndOwner(message, prompt);
    owners.push(owner);
    if (owner !== undefined) latestTimerByOwner.set(owner, message.id);
  }
  return projected.map((message, index) => {
    const source = rootMessages[index];
    const owner = owners[index];
    if (
      source === undefined ||
      owner === undefined ||
      !message.parts?.some((part) => part.kind === 'turn_timer')
    )
      return message;
    const latest = latestTimerByOwner.get(owner) === source.id;
    const recorded = latest
      ? (records.turnEnds?.[owner]?.outcome ??
        records.unacceptedTurnEnds?.[owner])
      : undefined;
    const interrupted =
      latest && records.interruptedTurns?.[owner] !== undefined;
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (
          part.kind !== 'turn_timer' ||
          !isRecord(part.data) ||
          typeof part.data.completedAt !== 'number'
        )
          return part;
        const own = part.data.outcome;
        const end =
          recorded === 'failed' || recorded === 'cancelled'
            ? recorded
            : interrupted
              ? 'interrupted'
              : recorded === undefined &&
                  (own === 'failed' || own === 'cancelled')
                ? own
                : undefined;
        return end === undefined
          ? part
          : { ...part, data: { ...part.data, endReason: end } };
      }),
    };
  });
}
