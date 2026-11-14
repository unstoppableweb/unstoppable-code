import type { Usage } from '@agentclientprotocol/sdk';

export interface AntigravityTokenUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function counter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 1.5.1 reports total = input + output; reasoning/cache are subsets, not
 * extra tokens. Keep missing optional counters unknown and never invent cost.
 */
export function antigravityTokenUsage(
  usage: Usage | null | undefined,
): AntigravityTokenUsage | undefined {
  if (!usage) return undefined;
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.thoughtTokens ?? 0,
    usage.cachedReadTokens ?? 0,
    usage.cachedWriteTokens ?? 0,
  ];
  const cache = (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0);
  if (
    !values.every(counter) ||
    !counter(cache) ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    cache > usage.inputTokens ||
    (usage.thoughtTokens ?? 0) > usage.outputTokens
  )
    return undefined;
  return {
    input_tokens: usage.inputTokens - cache,
    output_tokens: usage.outputTokens,
    ...(usage.thoughtTokens != null
      ? { reasoning_tokens: usage.thoughtTokens }
      : {}),
    ...(usage.cachedReadTokens != null
      ? { cache_read_input_tokens: usage.cachedReadTokens }
      : {}),
    ...(usage.cachedWriteTokens != null
      ? { cache_creation_input_tokens: usage.cachedWriteTokens }
      : {}),
  };
}
