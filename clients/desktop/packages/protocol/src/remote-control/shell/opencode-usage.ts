/** Native OpenCode reports; no account quota or billed spend is inferred. */
export interface OpenCodeReportedUsage {
  /** Sum of new assistant calls in the latest turn, excluding resumed history. */
  turn?: {
    /** Uncached input; cache reads and writes are separate. */
    inputTokens: number;
    /** Output excluding reasoning, which is shown separately. */
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCostUsd?: number;
  };
  /** Latest runtime-reported context, independent of summed turn counters. */
  context?: { usedTokens: number; maxTokens: number };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Shared validation for transcript replay and portable chat projections. */
export function parseOpenCodeReportedUsage(
  value: unknown,
): OpenCodeReportedUsage | undefined {
  if (!record(value)) return undefined;
  const report: OpenCodeReportedUsage = {};
  if (value.turn !== undefined) {
    const turn = value.turn;
    if (
      !record(turn) ||
      !counter(turn.inputTokens) ||
      !counter(turn.outputTokens) ||
      !counter(turn.reasoningTokens) ||
      !counter(turn.cacheReadTokens) ||
      !counter(turn.cacheWriteTokens)
    )
      return undefined;
    if (
      turn.estimatedCostUsd !== undefined &&
      (typeof turn.estimatedCostUsd !== 'number' ||
        !Number.isFinite(turn.estimatedCostUsd) ||
        turn.estimatedCostUsd < 0)
    )
      return undefined;
    report.turn = {
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      reasoningTokens: turn.reasoningTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheWriteTokens: turn.cacheWriteTokens,
      ...(turn.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: turn.estimatedCostUsd }
        : {}),
    };
  }
  if (value.context !== undefined) {
    const context = value.context;
    if (
      !record(context) ||
      !counter(context.usedTokens) ||
      !counter(context.maxTokens) ||
      context.maxTokens === 0
    )
      return undefined;
    report.context = {
      usedTokens: context.usedTokens,
      maxTokens: context.maxTokens,
    };
  }
  return report.turn || report.context ? report : undefined;
}
