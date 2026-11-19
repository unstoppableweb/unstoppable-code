import type { RemoteControlChatUsage } from '../remote-control/shell';

/**
 * A cloud chat's running usage, as the composer's context meter reads it
 * from the chat's answers. The web folds it from REST's conversation rows
 * and the desktop from the web core's revision 2 answer meters (CAN-6509),
 * so both meters show the same figures for the same chat (CAN-6755).
 */

/** Token usage for one answer; a harness reports what it knows. */
export interface ChatUsageTokens {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** The last call's context size; absent when the harness reports none. */
  readonly contextTokens?: number;
  readonly contextWindow?: number;
}

/** The model an answer ran on, as Core names it. */
export interface ChatUsageModelRef {
  readonly id: string;
  /** Declared context window in tokens, when the source carries one. */
  readonly contextWindow?: number;
}

/** One assistant answer, in transcript order. */
export interface ChatUsageAnswer {
  readonly usage?: ChatUsageTokens;
  readonly model?: ChatUsageModelRef;
  /**
   * What the answer cost in USD once Core priced it: 0 for a free answer,
   * absent while it is pending or when its price is unreadable.
   */
  readonly costUsd?: number;
  /** When the answer was written, to order it against a compaction. */
  readonly createdAtMs?: number;
}

/** A context compaction the chat went through. */
export interface ChatUsageCompaction {
  readonly tokensAfter?: number;
  readonly occurredAtMs?: number;
}

/** A model's catalog context window by model id, when the catalog knows it. */
export type CatalogContextWindow = (modelId: string) => number | undefined;

/**
 * Resolve the context window the meter sizes itself to (REG-2943), in the
 * order the sources are trusted: the turn's own usage report, then the model
 * snapshot core stamped on the answer, then the catalog entry for that model.
 * `undefined` when none of them knows — the meter then hides its bar.
 */
export function resolveChatContextWindow(
  usage: ChatUsageTokens | undefined,
  model: ChatUsageModelRef | string | undefined,
  catalogContextWindow: CatalogContextWindow = () => undefined,
): number | undefined {
  if (usage?.contextWindow !== undefined && usage.contextWindow > 0) {
    return usage.contextWindow;
  }
  const snapshotWindow =
    typeof model === 'string' ? undefined : model?.contextWindow;
  if (snapshotWindow !== undefined && snapshotWindow > 0) return snapshotWindow;
  const modelId = typeof model === 'string' ? model : model?.id;
  const catalogWindow =
    modelId === undefined ? undefined : catalogContextWindow(modelId);
  return catalogWindow !== undefined && catalogWindow > 0
    ? catalogWindow
    : undefined;
}

/**
 * The context size a usage report carries. Core computes `contextTokens`
 * itself and omits it when the harness reports no context size (Codex reports
 * per-turn totals only), so nothing stands in for it: an absent value keeps
 * the context row hidden rather than showing a per-turn figure as occupancy.
 */
function contextTokensOf(
  usage: ChatUsageTokens | undefined,
): number | undefined {
  return usage?.contextTokens;
}

/**
 * The chat's running usage as the transcript knows it: counters summed over
 * every assistant row, the newest row's context size, and cost only when at
 * least one answer was priced (a chat whose every cost is still pending or
 * unavailable hides the Cost row rather than claiming $0). A compaction that
 * landed after the newest answer supplies the current context size instead.
 * `undefined` when no assistant row reported usage or a model at all.
 */
export function foldChatUsage(
  answers: readonly ChatUsageAnswer[],
  options: {
    readonly catalogContextWindow?: CatalogContextWindow;
    readonly compactions?: readonly ChatUsageCompaction[];
  } = {},
): RemoteControlChatUsage | undefined {
  if (answers.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let sawUsage = false;
  let totalCostUsd: number | undefined;
  for (const answer of answers) {
    if (answer.costUsd !== undefined)
      totalCostUsd = (totalCostUsd ?? 0) + answer.costUsd;
    if (answer.usage === undefined) continue;
    sawUsage = true;
    inputTokens += answer.usage.inputTokens ?? 0;
    outputTokens += answer.usage.outputTokens ?? 0;
    cacheReadTokens += answer.usage.cacheReadTokens ?? 0;
    cacheWriteTokens += answer.usage.cacheWriteTokens ?? 0;
  }
  const newestFirst = [...answers].reverse();
  const latest = newestFirst.find(
    (answer) => answer.usage !== undefined || answer.model !== undefined,
  );
  if (!sawUsage && latest === undefined) return undefined;
  // The context size comes from the newest row that MEASURED one; a newer
  // row that carries only a model (a failed or tool-loop turn) must not erase
  // it, matching the live patch that keeps the previous value.
  const latestMeasured = newestFirst.find(
    (answer) => contextTokensOf(answer.usage) !== undefined,
  );
  let contextWindow: number | undefined;
  for (const answer of newestFirst) {
    contextWindow = resolveChatContextWindow(
      answer.usage,
      answer.model,
      options.catalogContextWindow,
    );
    if (contextWindow !== undefined) break;
  }
  let contextTokens = contextTokensOf(latestMeasured?.usage);
  const latestCompaction = (options.compactions ?? [])
    .filter((compaction) => compaction.tokensAfter !== undefined)
    .reduce<
      ChatUsageCompaction | undefined
    >((best, candidate) => (best === undefined || (candidate.occurredAtMs ?? 0) >= (best.occurredAtMs ?? 0) ? candidate : best), undefined);
  if (
    latestCompaction?.tokensAfter !== undefined &&
    (latestCompaction.occurredAtMs ?? 0) > (latestMeasured?.createdAtMs ?? 0)
  ) {
    contextTokens = latestCompaction.tokensAfter;
  }
  return {
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    numTurns: answers.length,
    ...(latest?.model?.id === undefined ? {} : { model: latest.model.id }),
  };
}
