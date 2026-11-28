import type { ChatMessage } from '@/stores/chatStore';

/**
 * Compute the set of user-message IDs whose turns have been rolled back by
 * one or more `revert_info` markers in the transcript.
 *
 * Reverting turn N rolls git state back to before turn N began, which also
 * discards any changes made by turns N+1, N+2, … (they built on top of N).
 * So each marker covers every user message from its `revertedFromMessageId`
 * up to (but not including) the marker's own position. A turn is "reverted"
 * if any marker in the transcript covers it.
 */
export function computeRevertedUserMessageIds(
  messages: ChatMessage[],
): Set<string> {
  const reverted = new Set<string>();
  const indexById = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    indexById.set(messages[i].id, i);
  }

  for (let markerIndex = 0; markerIndex < messages.length; markerIndex += 1) {
    const message = messages[markerIndex];
    if (message.role !== 'system' || message.blocks.length !== 1) continue;
    const block = message.blocks[0];
    if (block.type !== 'revert_info') continue;

    const startIndex = indexById.get(block.revertedFromMessageId);
    if (startIndex === undefined) continue;

    for (let i = startIndex; i < markerIndex; i += 1) {
      const candidate = messages[i];
      if (candidate.role === 'user') {
        reverted.add(candidate.id);
      }
      // A wake that started inside the reverted range shows as its own
      // display group, keyed `${timer.id}:wake`; the reset covers it too.
      const block = candidate.blocks[0];
      if (
        block?.type === 'turn_timer' &&
        block.turnId !== undefined &&
        block.spawnedBy !== undefined
      ) {
        reverted.add(`${candidate.id}:wake`);
      }
    }
  }

  return reverted;
}
