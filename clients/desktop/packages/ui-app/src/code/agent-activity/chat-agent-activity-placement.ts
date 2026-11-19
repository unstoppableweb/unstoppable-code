import { useMemo, useRef } from 'react';
import {
  placeAgentActivity,
  type AgentActivityPlacement,
  type AgentArtifactReceiptV1,
} from '@canopy/protocol/agent-artifacts';
import type {
  RemoteControlChatMessage,
  RemoteControlChatTurnGroup,
} from '@canopy/protocol/remote-control/shell';
import { collectTurnAgentArtifacts } from './turn-agent-artifacts';

// Without live keys from the host, each run stays in its home turn.
const NO_LIVE_RUNS: ReadonlySet<string> = new Set();

interface TurnReceipts {
  readonly messages: readonly RemoteControlChatMessage[];
  readonly receipts: readonly AgentArtifactReceiptV1[];
}

function sameMessages(
  left: readonly RemoteControlChatMessage[],
  right: readonly RemoteControlChatMessage[],
): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => message === right[index])
  );
}

/**
 * Each turn's Agent activity receipts after placing every run once across
 * the chat (`placeAgentActivity`, CAN-4690); a run in `liveRunKeys` is the
 * host's to list while live, so no turn lists it. A turn whose messages are
 * unchanged reuses its collected receipts, and placement keeps unchanged
 * turns' arrays, so streaming a delta re-collects only the turn it touched.
 */
export function useChatAgentActivityPlacement(
  turnGroups: readonly RemoteControlChatTurnGroup[],
  messagesById: Readonly<Record<string, RemoteControlChatMessage | undefined>>,
  liveRunKeys: ReadonlySet<string> = NO_LIVE_RUNS,
): Readonly<Record<string, readonly AgentArtifactReceiptV1[]>> {
  const collectedRef = useRef(new Map<string, TurnReceipts>());
  const placementRef = useRef<AgentActivityPlacement | undefined>(undefined);
  return useMemo(() => {
    const collected = new Map<string, TurnReceipts>();
    const byTurn: Record<string, readonly AgentArtifactReceiptV1[]> = {};
    for (const turnGroup of turnGroups) {
      const messages = [
        ...turnGroup.intermediateMessageIds,
        ...turnGroup.finalMessageIds,
      ].flatMap((id) => {
        const message = messagesById[id];
        return message ? [message] : [];
      });
      const prior = collectedRef.current.get(turnGroup.userMessageId);
      const entry =
        prior && sameMessages(prior.messages, messages)
          ? prior
          : { messages, receipts: collectTurnAgentArtifacts(messages) };
      collected.set(turnGroup.userMessageId, entry);
      byTurn[turnGroup.userMessageId] = entry.receipts;
    }
    collectedRef.current = collected;
    const placement = placeAgentActivity(
      byTurn,
      turnGroups.map((turnGroup) => turnGroup.userMessageId),
      liveRunKeys,
      placementRef.current,
    );
    placementRef.current = placement;
    return placement.byTurn;
  }, [liveRunKeys, messagesById, turnGroups]);
}
