import { createMemoryUlidFactory } from '@canopy/protocol/memory-sync';
import type { BotId } from '@canopy/protocol/chat-targets';

/** Creates lowercase public Bot IDs from the shared monotonic ULID source. */
export function createBotIdGenerator(now: () => Date): () => BotId {
  const nextUlid = createMemoryUlidFactory({ now: () => now().getTime() });
  return (): BotId => {
    const botId: BotId = `bot_${nextUlid().toLowerCase()}`;
    return botId;
  };
}
