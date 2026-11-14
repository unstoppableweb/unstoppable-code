import {
  parseReportedTurnUsage,
  type ReportedTurnUsage,
} from '@canopy/protocol/portal';

/** Read a normalized ACP result as a complete snapshot, including unknowns. */
export function parseAntigravityTurnUsage(
  value: unknown,
): ReportedTurnUsage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  return (
    parseReportedTurnUsage({
      inputTokens: 'input_tokens' in value ? value.input_tokens : undefined,
      outputTokens: 'output_tokens' in value ? value.output_tokens : undefined,
      reasoningIncludedInOutput: true,
      reasoningTokens:
        'reasoning_tokens' in value ? value.reasoning_tokens : undefined,
      cacheReadTokens:
        'cache_read_input_tokens' in value
          ? value.cache_read_input_tokens
          : undefined,
      cacheWriteTokens:
        'cache_creation_input_tokens' in value
          ? value.cache_creation_input_tokens
          : undefined,
    }) ?? null
  );
}
