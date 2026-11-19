/**
 * A chat's own delegate cards, read the same way wherever a cloud chat's
 * delegates are counted or shown (CAN-7133): the Subagents tree, its root
 * list and the transcript residency's evicted summary. Pure, so the chat
 * stores can read it without importing a host module.
 */
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import type { ChatMessage } from '@/stores/chat/types';

const latestRunsByMessages = new WeakMap<
  readonly ChatMessage[],
  Readonly<Record<string, number>>
>();

/**
 * Each of a chat's own delegates' newest card run, by delegation id: its
 * messages' own delegate cards, not a delegate's delegates in a card's
 * pages. Only ids and run numbers, nothing of the cards' content.
 */
export function chatsOwnLatestRuns(
  messages: readonly ChatMessage[],
): Readonly<Record<string, number>> {
  const cached = latestRunsByMessages.get(messages);
  if (cached !== undefined) return cached;
  const runs: Record<string, number> = {};
  for (const message of messages)
    for (const block of message.blocks)
      if (block.type === 'delegated_agent_call')
        runs[block.delegationId] = Math.max(
          runs[block.delegationId] ?? 0,
          block.runGeneration,
        );
  latestRunsByMessages.set(messages, runs);
  return runs;
}

/**
 * A delegate's live snapshot, unless a newer run is already on its card:
 * a run older than the newest card is superseded, so it neither shows nor
 * counts as live.
 */
export function currentLiveSnapshot(
  latestCardRun: number | undefined,
  snapshot: AgentDelegationSnapshot | undefined,
): AgentDelegationSnapshot | undefined {
  if (latestCardRun === undefined || snapshot === undefined) return undefined;
  return (snapshot.runGeneration ?? 1) >= latestCardRun ? snapshot : undefined;
}
