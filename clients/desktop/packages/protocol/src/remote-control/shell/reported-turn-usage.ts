/** Latest provider-reported turn, never cumulative usage or account spend. */
export interface ReportedTurnUsage {
  /** Input excludes separately reported cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningIncludedInOutput?: boolean;
}

/** Reject malformed reports at a remote host boundary. */
export function parseReportedTurnUsage(
  value: unknown,
): ReportedTurnUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  if (
    !('inputTokens' in value) ||
    !counter(value.inputTokens) ||
    !('outputTokens' in value) ||
    !counter(value.outputTokens)
  )
    return undefined;
  const reasoning =
    'reasoningTokens' in value ? value.reasoningTokens : undefined;
  const read = 'cacheReadTokens' in value ? value.cacheReadTokens : undefined;
  const write =
    'cacheWriteTokens' in value ? value.cacheWriteTokens : undefined;
  const included =
    'reasoningIncludedInOutput' in value
      ? value.reasoningIncludedInOutput
      : undefined;
  if (
    (reasoning !== undefined && !counter(reasoning)) ||
    (read !== undefined && !counter(read)) ||
    (write !== undefined && !counter(write)) ||
    (included !== undefined && typeof included !== 'boolean') ||
    (included === true &&
      reasoning !== undefined &&
      reasoning > value.outputTokens)
  )
    return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(read !== undefined ? { cacheReadTokens: read } : {}),
    ...(write !== undefined ? { cacheWriteTokens: write } : {}),
    ...(included !== undefined ? { reasoningIncludedInOutput: included } : {}),
  };
}
function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
