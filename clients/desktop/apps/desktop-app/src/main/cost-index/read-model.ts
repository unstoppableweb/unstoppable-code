import { accountProxyAccountKey } from '@canopy/desktop-shared/lib/account-proxy';
import {
  COST_BILLING_BASES,
  costTokenCount,
  createEmptyCostTotals,
  type CostActivityStats,
  type CostAttributedItem,
  type CostBackgroundRow,
  type CostBillingBasis,
  type CostChatRow,
  type CostChatRequest,
  type CostContextCategory,
  type CostContextView,
  type CostModelRow,
  type CostPipelineRunRow,
  type CostProxyAccountRow,
  type CostScopeRef,
  type CostScopeView,
  type CostSource,
  type CostSourceBreakdown,
  type CostStatus,
  type CostTokenTotals,
  type CostTotals,
  type PipelineRunChildCost,
  type PipelineRunCostView,
  type PipelineRunStepCost,
  type SessionBreakdownView,
} from '@canopy/protocol/cost-view';
import type {
  CostChatAggregate,
  CostChatFile,
  CostChatIdentity,
  CostScopeLocation,
  CostSummaryChat,
  CostSummaryFile,
  CostTurnPoint,
  CostTurnRecord,
  CostUnattachedFile,
} from './types';

export { classifyAuditEntry } from './classifier';

const USD_SCALE = 100_000_000;
type ToolCountKey = keyof NonNullable<CostTurnRecord['toolCounts']>;

// Typed as a full record so a new tool count must be listed before it compiles.
const TOOL_COUNT_KEY_SET: Readonly<Record<ToolCountKey, true>> = {
  thinking: true,
  bash: true,
  read: true,
  readLines: true,
  writeEdit: true,
  plan: true,
  fileEdit: true,
  fileAdd: true,
  fileDelete: true,
  search: true,
  grep: true,
  web: true,
  agent: true,
  workflow: true,
  tasks: true,
  taskStop: true,
  skills: true,
  monitor: true,
  claude: true,
  scheduleWakeup: true,
  askUser: true,
  scriptOutput: true,
  watcher: true,
  canopy: true,
  graph: true,
  appAdvisor: true,
  pipelineEditor: true,
  mcp: true,
  other: true,
};
const TOOL_COUNT_KEYS: readonly ToolCountKey[] = Object.keys(
  TOOL_COUNT_KEY_SET,
).filter((key): key is ToolCountKey => key in TOOL_COUNT_KEY_SET);

interface MutableTokens {
  input: number;
  output: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
}

interface MutableActivity {
  turnCount: number;
  toolCallCount: number;
  subagentCount: number;
  plansCreated: number;
  plansApproved: number;
  toolCounts: Map<string, number>;
}

interface AggregateAccumulator {
  tokens: MutableTokens;
  bySourceUsd: Record<CostSource, number>;
  byBillingUsd: Record<CostBillingBasis, number>;
  notPricedCount: number;
  notPricedByBilling: Partial<Record<CostBillingBasis, number>>;
  hasEstimate: boolean;
  hasCodexEstimate: boolean;
  chatUsd: number;
  chatTurnCount: number;
  subagentItems: CostAttributedItem[];
  delegationItems: CostAttributedItem[];
  backgroundRows: Map<
    string,
    {
      runCount: number;
      usd: number;
      notPricedCount: number;
      tokens: MutableTokens;
    }
  >;
  chatTurnsByModel: Map<string, ModelAccumulator>;
  byModel: Map<string, ModelAccumulator>;
  byProxyAccount: Map<string, ProxyAccountAccumulator>;
  points: CostTurnPoint[];
  compactions: { total: number; auto: number; manual: number };
  activity: MutableActivity;
  latestContext?: { at: string; endTokens: number; windowTokens: number };
  categorySnapshot?: { at: string; categories: readonly CostContextCategory[] };
  peakContext?: { usedTokens: number; windowTokens: number };
  firstActivityAt?: string;
  lastActivityAt?: string;
}

interface ModelAccumulator {
  turnCount: number;
  usd: number;
  notPricedCount: number;
  tokens: MutableTokens;
}

interface ProxyAccountAccumulator {
  label: string;
  provider?: string;
  turnShare: number;
  requestCount: number;
  usd: number;
  notPricedCount: number;
}

interface WorkContribution {
  source: CostSource;
  billingBasis: CostBillingBasis;
  tokens: CostTokenTotals;
  usd?: number;
  costStatus: CostStatus;
  model?: string;
  isCodex: boolean;
  countNotPriced: boolean;
}

function emptyTokens(): MutableTokens {
  return {
    input: 0,
    output: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function addTokens(target: MutableTokens, addition: CostTokenTotals): void {
  target.input += addition.input;
  target.output += addition.output;
  target.cacheReadInputTokens += addition.cacheReadInputTokens;
  target.cacheCreationInputTokens += addition.cacheCreationInputTokens;
  target.reasoningOutputTokens += addition.reasoningOutputTokens;
}

function sumTokens(
  left: CostTokenTotals,
  right: CostTokenTotals,
): CostTokenTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheReadInputTokens:
      left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheCreationInputTokens:
      left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

function subtractTokens(
  total: CostTokenTotals,
  subtraction: CostTokenTotals,
): CostTokenTotals {
  return {
    input: Math.max(0, total.input - subtraction.input),
    output: Math.max(0, total.output - subtraction.output),
    cacheReadInputTokens: Math.max(
      0,
      total.cacheReadInputTokens - subtraction.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: Math.max(
      0,
      total.cacheCreationInputTokens - subtraction.cacheCreationInputTokens,
    ),
    reasoningOutputTokens: Math.max(
      0,
      total.reasoningOutputTokens - subtraction.reasoningOutputTokens,
    ),
  };
}

function hasTokens(tokens: CostTokenTotals): boolean {
  return (
    tokens.input > 0 ||
    tokens.output > 0 ||
    tokens.cacheReadInputTokens > 0 ||
    tokens.cacheCreationInputTokens > 0 ||
    tokens.reasoningOutputTokens > 0
  );
}

function roundUsd(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * USD_SCALE + Number.EPSILON) / USD_SCALE;
}

function finiteUsd(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function pricedAmount(
  value: number | undefined,
  basis: CostBillingBasis,
  status: CostStatus,
): number | undefined {
  if (basis === 'org_gateway' || basis === 'local' || status === 'not_priced') {
    return undefined;
  }
  return finiteUsd(value);
}

function emptyAccumulator(): AggregateAccumulator {
  return {
    tokens: emptyTokens(),
    bySourceUsd: {
      chat: 0,
      pipeline: 0,
      subagents: 0,
      delegations: 0,
      background: 0,
    },
    byBillingUsd: {
      subscription: 0,
      ai_credits: 0,
      account_proxy: 0,
      api_key: 0,
      org_gateway: 0,
      local: 0,
      unknown: 0,
    },
    notPricedCount: 0,
    notPricedByBilling: {},
    hasEstimate: false,
    hasCodexEstimate: false,
    chatUsd: 0,
    chatTurnCount: 0,
    subagentItems: [],
    delegationItems: [],
    backgroundRows: new Map(),
    chatTurnsByModel: new Map(),
    byModel: new Map(),
    byProxyAccount: new Map(),
    points: [],
    compactions: { total: 0, auto: 0, manual: 0 },
    activity: {
      turnCount: 0,
      toolCallCount: 0,
      subagentCount: 0,
      plansCreated: 0,
      plansApproved: 0,
      toolCounts: new Map(),
    },
  };
}

function addModelContribution(
  target: Map<string, ModelAccumulator>,
  model: string | undefined,
  tokens: CostTokenTotals,
  usd: number | undefined,
  notPriced: boolean,
): void {
  if (!model) return;
  const current = target.get(model) ?? {
    turnCount: 0,
    usd: 0,
    notPricedCount: 0,
    tokens: emptyTokens(),
  };
  current.turnCount += 1;
  current.usd += usd ?? 0;
  if (notPriced) current.notPricedCount += 1;
  addTokens(current.tokens, tokens);
  target.set(model, current);
}

function addWorkContribution(
  accumulator: AggregateAccumulator,
  contribution: WorkContribution,
): void {
  const amount = finiteUsd(contribution.usd);
  addTokens(accumulator.tokens, contribution.tokens);
  accumulator.bySourceUsd[contribution.source] += amount ?? 0;
  accumulator.byBillingUsd[contribution.billingBasis] += amount ?? 0;
  const isNotPriced =
    amount === undefined &&
    contribution.countNotPriced &&
    hasTokens(contribution.tokens);
  if (isNotPriced) {
    accumulator.notPricedCount += 1;
    accumulator.notPricedByBilling[contribution.billingBasis] =
      (accumulator.notPricedByBilling[contribution.billingBasis] ?? 0) + 1;
  }
  // Every priced Codex amount is an estimate, including a partly priced one.
  const isEstimate =
    contribution.costStatus === 'estimated' ||
    (contribution.costStatus === 'partial' && contribution.isCodex);
  if (amount !== undefined && isEstimate) {
    accumulator.hasEstimate = true;
    if (contribution.isCodex) accumulator.hasCodexEstimate = true;
  }
  addModelContribution(
    accumulator.byModel,
    contribution.model,
    contribution.tokens,
    amount,
    isNotPriced,
  );
}

/**
 * Credits each account that served a record with its share of the record's
 * requests: that share of the turn and of its dollars. Rows leave the label
 * empty; the store joins it when a view is read.
 */
function addProxyAccountContribution(
  target: Map<string, ProxyAccountAccumulator>,
  record: CostTurnRecord,
  amount: number | undefined,
): void {
  const usage = record.accountProxy;
  if (!usage) return;
  const totalRequests = usage.accounts.reduce(
    (total, account) => total + account.requests,
    0,
  );
  if (totalRequests <= 0) return;
  const notPriced = amount === undefined && hasTokens(record.tokens);
  for (const account of usage.accounts) {
    const key = accountProxyAccountKey(usage.connectionId, account.authIndex);
    const share = account.requests / totalRequests;
    const current = target.get(key) ?? {
      label: '',
      turnShare: 0,
      requestCount: 0,
      usd: 0,
      notPricedCount: 0,
    };
    if (account.provider) current.provider = account.provider;
    current.turnShare += share;
    current.requestCount += account.requests;
    current.usd += (amount ?? 0) * share;
    if (notPriced) current.notPricedCount += 1;
    target.set(key, current);
  }
}

/**
 * The per-basis unpriced counts of one or more totals, summed. Sparse: holds
 * only bases above zero, and is omitted when none is, so no empty object
 * reaches a view or a sealed file.
 */
function notPricedByBillingField(
  ...counts: readonly (
    | Readonly<Partial<Record<CostBillingBasis, number>>>
    | undefined
  )[]
): Pick<CostTotals, 'notPricedByBilling'> {
  const summed: Partial<Record<CostBillingBasis, number>> = {};
  let any = false;
  for (const basis of COST_BILLING_BASES) {
    const count = counts.reduce(
      (total, value) => total + (value?.[basis] ?? 0),
      0,
    );
    if (count > 0) {
      summed[basis] = count;
      any = true;
    }
  }
  return any ? { notPricedByBilling: summed } : {};
}

function roundShare(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function proxyAccountRows(
  values: ReadonlyMap<string, ProxyAccountAccumulator>,
): readonly CostProxyAccountRow[] {
  return Array.from(values.entries())
    .map(([accountKey, value]) => ({
      accountKey,
      label: value.label,
      ...(value.provider ? { provider: value.provider } : {}),
      turnShare: roundShare(value.turnShare),
      requestCount: value.requestCount,
      usd: roundUsd(value.usd),
      notPricedCount: value.notPricedCount,
    }))
    .sort(
      (left, right) =>
        right.turnShare - left.turnShare ||
        right.usd - left.usd ||
        left.accountKey.localeCompare(right.accountKey),
    );
}

function mergeProxyAccountRows(
  left: readonly CostProxyAccountRow[] | undefined,
  right: readonly CostProxyAccountRow[] | undefined,
): readonly CostProxyAccountRow[] {
  const values = new Map<string, ProxyAccountAccumulator>();
  for (const row of [...(left ?? []), ...(right ?? [])]) {
    const current = values.get(row.accountKey) ?? {
      label: '',
      turnShare: 0,
      requestCount: 0,
      usd: 0,
      notPricedCount: 0,
    };
    if (row.label) current.label = row.label;
    if (row.provider) current.provider = row.provider;
    current.turnShare += row.turnShare;
    current.requestCount += row.requestCount;
    current.usd += row.usd;
    current.notPricedCount += row.notPricedCount;
    values.set(row.accountKey, current);
  }
  return proxyAccountRows(values);
}

function recordSource(record: CostTurnRecord): CostSource {
  switch (record.source) {
    case 'chat':
      return 'chat';
    case 'pipeline':
      return 'pipeline';
    case 'delegation':
      return 'delegations';
    case 'background':
      return 'background';
  }
}

function itemAmount(item: CostAttributedItem): number | undefined {
  return pricedAmount(item.usd, item.billingBasis, item.costStatus);
}

function recordAmount(record: CostTurnRecord): number | undefined {
  return pricedAmount(record.costUsd, record.billingBasis, record.costStatus);
}

function recordSort(left: CostTurnRecord, right: CostTurnRecord): number {
  return (
    left.startedAt.localeCompare(right.startedAt) ||
    left.entryId.localeCompare(right.entryId)
  );
}

function statusForAmount(
  amount: number | undefined,
  status: CostStatus,
): CostStatus {
  return amount === undefined ? 'not_priced' : status;
}

function addBackgroundRecord(
  accumulator: AggregateAccumulator,
  record: CostTurnRecord,
  amount: number | undefined,
): void {
  const kind = record.helperKind ?? 'other';
  const row = accumulator.backgroundRows.get(kind) ?? {
    runCount: 0,
    usd: 0,
    notPricedCount: 0,
    tokens: emptyTokens(),
  };
  row.runCount += 1;
  row.usd += amount ?? 0;
  if (amount === undefined && hasTokens(record.tokens)) row.notPricedCount += 1;
  addTokens(row.tokens, record.tokens);
  accumulator.backgroundRows.set(kind, row);
}

function addChatActivity(
  accumulator: AggregateAccumulator,
  record: CostTurnRecord,
): void {
  const activity = accumulator.activity;
  activity.turnCount += 1;
  activity.toolCallCount +=
    record.toolUseCount ?? totalToolCount(record.toolCounts);
  activity.subagentCount +=
    record.subagentCount ?? record.subagents?.length ?? 0;
  activity.plansCreated += record.planEvents?.created ?? 0;
  activity.plansApproved += record.planEvents?.approved ?? 0;

  if (record.toolCounts) {
    for (const tool of TOOL_COUNT_KEYS) {
      const count = record.toolCounts[tool];
      if (!Number.isFinite(count) || count <= 0) continue;
      activity.toolCounts.set(
        tool,
        (activity.toolCounts.get(tool) ?? 0) + count,
      );
    }
  }

  const sortedCompactions = [...(record.compactions ?? [])].sort(
    (left, right) => left.at.localeCompare(right.at),
  );
  for (const compaction of sortedCompactions) {
    accumulator.compactions.total += 1;
    if (compaction.trigger === 'auto') accumulator.compactions.auto += 1;
    if (compaction.trigger === 'manual') accumulator.compactions.manual += 1;
  }

  const context = record.context;
  if (context) {
    const at = record.completedAt ?? record.startedAt;
    if (
      !accumulator.latestContext ||
      at.localeCompare(accumulator.latestContext.at) > 0
    ) {
      accumulator.latestContext = {
        at,
        endTokens: context.endTokens,
        windowTokens: context.windowTokens,
      };
    }
    if (context.categories && context.categories.length > 0) {
      const categories = context.categories
        .map((category) => ({
          name: category.name,
          tokens: category.tokens,
          kind: category.kind,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      if (
        !accumulator.categorySnapshot ||
        at.localeCompare(accumulator.categorySnapshot.at) > 0
      ) {
        accumulator.categorySnapshot = { at, categories };
      }
    }

    const usedTokens = context.peakTokens ?? context.endTokens;
    if (
      !accumulator.peakContext ||
      usedTokens > accumulator.peakContext.usedTokens ||
      (usedTokens === accumulator.peakContext.usedTokens &&
        context.windowTokens > accumulator.peakContext.windowTokens)
    ) {
      accumulator.peakContext = {
        usedTokens,
        windowTokens: context.windowTokens,
      };
    }
  }

  const point: CostTurnPoint = {
    startedAt: record.startedAt,
    ...(record.durationMs === undefined
      ? {}
      : { durationMs: record.durationMs }),
    ...(context
      ? {
          context: {
            endTokens: context.endTokens,
            windowTokens: context.windowTokens,
            ...(context.peakTokens === undefined
              ? {}
              : { peakTokens: context.peakTokens }),
          },
        }
      : {}),
    ...(sortedCompactions.length === 0
      ? {}
      : {
          compaction: sortedCompactions[sortedCompactions.length - 1]?.trigger,
        }),
  };
  accumulator.points.push(point);

  const activityAt = record.completedAt ?? record.startedAt;
  if (
    accumulator.firstActivityAt === undefined ||
    activityAt.localeCompare(accumulator.firstActivityAt) < 0
  ) {
    accumulator.firstActivityAt = activityAt;
  }
  if (
    accumulator.lastActivityAt === undefined ||
    activityAt.localeCompare(accumulator.lastActivityAt) > 0
  ) {
    accumulator.lastActivityAt = activityAt;
  }
}

function totalToolCount(counts: CostTurnRecord['toolCounts']): number {
  if (!counts) return 0;
  let total = 0;
  for (const tool of TOOL_COUNT_KEYS) {
    const count = counts[tool];
    if (Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

function addActivityTime(
  accumulator: AggregateAccumulator,
  record: CostTurnRecord,
): void {
  const activityAt = record.completedAt ?? record.startedAt;
  if (
    accumulator.firstActivityAt === undefined ||
    activityAt.localeCompare(accumulator.firstActivityAt) < 0
  ) {
    accumulator.firstActivityAt = activityAt;
  }
  if (
    accumulator.lastActivityAt === undefined ||
    activityAt.localeCompare(accumulator.lastActivityAt) > 0
  ) {
    accumulator.lastActivityAt = activityAt;
  }
}

function attributionItems(
  items: readonly CostAttributedItem[],
): readonly CostAttributedItem[] {
  interface MutableItem {
    item: CostAttributedItem;
    tokens: MutableTokens;
    totalTokens: number;
    sawTotalTokens: boolean;
    usd: number;
    sawPriced: boolean;
    sawUnpriced: boolean;
    sawEstimated: boolean;
    sawPartial: boolean;
    runCount: number;
  }
  const grouped = new Map<string, MutableItem>();
  for (const item of items) {
    const key = JSON.stringify([
      item.id,
      item.kind,
      item.billingBasis,
      item.inclusion,
    ]);
    const current = grouped.get(key) ?? {
      item,
      tokens: emptyTokens(),
      totalTokens: 0,
      sawTotalTokens: false,
      usd: 0,
      sawPriced: false,
      sawUnpriced: false,
      sawEstimated: false,
      sawPartial: false,
      runCount: 0,
    };
    current.item = item;
    addTokens(current.tokens, item.tokens);
    // A grouped row can combine split and total-only turns. Keep its total
    // complete without manufacturing any missing token-kind split.
    current.totalTokens += item.totalTokens ?? costTokenCount(item.tokens);
    if (item.totalTokens !== undefined) {
      current.sawTotalTokens = true;
    }
    const amount = itemAmount(item);
    if (amount === undefined) current.sawUnpriced = true;
    else {
      current.sawPriced = true;
      current.usd += amount;
    }
    if (item.costStatus === 'estimated') current.sawEstimated = true;
    if (item.costStatus === 'partial') current.sawPartial = true;
    current.runCount += item.runCount ?? 1;
    grouped.set(key, current);
  }

  return Array.from(grouped.values())
    .map(
      ({
        item,
        tokens,
        totalTokens,
        sawTotalTokens,
        usd,
        sawPriced,
        sawUnpriced,
        sawEstimated,
        sawPartial,
        runCount,
      }) => {
        const costStatus: CostStatus = !sawPriced
          ? 'not_priced'
          : sawPartial || sawUnpriced
            ? 'partial'
            : sawEstimated
              ? 'estimated'
              : 'reported';
        return {
          ...item,
          tokens,
          ...(sawTotalTokens ? { totalTokens } : {}),
          ...(sawPriced ? { usd: roundUsd(usd) } : { usd: undefined }),
          costStatus,
          ...(item.kind === 'delegation' ? { runCount } : {}),
        };
      },
    )
    .sort(
      (left, right) =>
        (right.usd ?? 0) - (left.usd ?? 0) ||
        left.id.localeCompare(right.id) ||
        left.kind.localeCompare(right.kind),
    );
}

function modelRows(
  values: Map<string, ModelAccumulator>,
): readonly CostModelRow[] {
  return Array.from(values.entries())
    .map(([model, value]) => ({
      model,
      turnCount: value.turnCount,
      usd: roundUsd(value.usd),
      notPricedCount: value.notPricedCount,
      tokens: value.tokens,
    }))
    .sort(
      (left, right) =>
        right.usd - left.usd ||
        right.turnCount - left.turnCount ||
        left.model.localeCompare(right.model),
    );
}

function backgroundRows(
  values: AggregateAccumulator['backgroundRows'],
): readonly CostBackgroundRow[] {
  return Array.from(values.entries())
    .map(([kind, value]) => ({
      kind: isCostHelperKind(kind) ? kind : 'other',
      runCount: value.runCount,
      usd: roundUsd(value.usd),
      notPricedCount: value.notPricedCount,
      tokens: value.tokens,
    }))
    .sort(
      (left, right) =>
        right.usd - left.usd || left.kind.localeCompare(right.kind),
    );
}

function isCostHelperKind(value: string): value is CostBackgroundRow['kind'] {
  return [
    'chat_title',
    'branch_name',
    'handoff_summary',
    'commit_message',
    'entry_summary',
    'pull_request_text',
    'pipeline_advisor',
    'other',
  ].some((kind) => kind === value);
}

function sortPoints(
  points: readonly CostTurnPoint[],
): readonly CostTurnPoint[] {
  return [...points].sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      (left.durationMs ?? -1) - (right.durationMs ?? -1) ||
      (left.context?.endTokens ?? -1) - (right.context?.endTokens ?? -1),
  );
}

function activityFromPoints(
  base: Omit<
    CostActivityStats,
    'totalDurationMs' | 'averageTurnMs' | 'p95TurnMs'
  >,
  points: readonly CostTurnPoint[],
): CostActivityStats {
  const durations = points
    .flatMap((point) =>
      point.durationMs !== undefined &&
      Number.isFinite(point.durationMs) &&
      point.durationMs >= 0
        ? [point.durationMs]
        : [],
    )
    .sort((left, right) => left - right);
  const totalDurationMs = durations.reduce(
    (total, duration) => total + duration,
    0,
  );
  const p95Index = Math.min(
    durations.length - 1,
    Math.max(0, Math.ceil(0.95 * durations.length) - 1),
  );
  return {
    ...base,
    totalDurationMs,
    averageTurnMs:
      durations.length === 0 ? null : totalDurationMs / durations.length,
    p95TurnMs: durations.length === 0 ? null : (durations[p95Index] ?? null),
  };
}

function contextView(accumulator: AggregateAccumulator): CostContextView {
  const sortedPoints = sortPoints(accumulator.points);
  const timeline = sortedPoints.flatMap((point) =>
    point.context
      ? [
          {
            at: point.startedAt,
            endTokens: point.context.endTokens,
            ...(point.compaction ? { compaction: point.compaction } : {}),
          },
        ]
      : [],
  );
  return {
    ...(accumulator.latestContext
      ? {
          latest: {
            usedTokens: accumulator.latestContext.endTokens,
            windowTokens: accumulator.latestContext.windowTokens,
            at: accumulator.latestContext.at,
          },
        }
      : {}),
    categories: accumulator.categorySnapshot?.categories ?? [],
    ...(accumulator.peakContext ? { peak: accumulator.peakContext } : {}),
    timeline,
  };
}

function accumulatorToAggregate(
  accumulator: AggregateAccumulator,
  turnCount: number,
): CostChatAggregate {
  const bySource = {
    chat: {
      usd: roundUsd(accumulator.chatUsd),
      turnCount: accumulator.chatTurnCount,
    },
    subagents: {
      usd: roundUsd(accumulator.bySourceUsd.subagents),
      items: attributionItems(accumulator.subagentItems),
    },
    delegations: {
      usd: roundUsd(accumulator.bySourceUsd.delegations),
      items: attributionItems(accumulator.delegationItems),
    },
    background: {
      usd: roundUsd(accumulator.bySourceUsd.background),
      rows: backgroundRows(accumulator.backgroundRows),
    },
  } satisfies CostSourceBreakdown;
  const bySourceUsd = accumulator.bySourceUsd;
  const roundedBySource = {
    chat: roundUsd(bySourceUsd.chat),
    pipeline: roundUsd(bySourceUsd.pipeline),
    subagents: roundUsd(bySourceUsd.subagents),
    delegations: roundUsd(bySourceUsd.delegations),
    background: roundUsd(bySourceUsd.background),
  };
  const roundedByBilling = {
    subscription: roundUsd(accumulator.byBillingUsd.subscription),
    ai_credits: roundUsd(accumulator.byBillingUsd.ai_credits),
    account_proxy: roundUsd(accumulator.byBillingUsd.account_proxy),
    api_key: roundUsd(accumulator.byBillingUsd.api_key),
    org_gateway: roundUsd(accumulator.byBillingUsd.org_gateway),
    local: roundUsd(accumulator.byBillingUsd.local),
    unknown: roundUsd(accumulator.byBillingUsd.unknown),
  };
  const totalUsd = Object.values(roundedBySource).reduce(
    (total, amount) => total + amount,
    0,
  );
  const sortedPoints = sortPoints(accumulator.points);
  const activityBase = {
    turnCount: accumulator.activity.turnCount,
    toolCallCount: accumulator.activity.toolCallCount,
    subagentCount: accumulator.activity.subagentCount,
    plansCreated: accumulator.activity.plansCreated,
    plansApproved: accumulator.activity.plansApproved,
    topTools: Array.from(accumulator.activity.toolCounts.entries())
      .map(([tool, count]) => ({ tool, count }))
      .sort(
        (left, right) =>
          right.count - left.count || left.tool.localeCompare(right.tool),
      ),
  };
  const byProxyAccount = proxyAccountRows(accumulator.byProxyAccount);
  return {
    totals: {
      usd: roundUsd(totalUsd),
      bySource: roundedBySource,
      byBilling: roundedByBilling,
      tokens: accumulator.tokens,
      notPricedCount: accumulator.notPricedCount,
      ...notPricedByBillingField(accumulator.notPricedByBilling),
      hasEstimate: accumulator.hasEstimate,
    },
    turnCount,
    ...(accumulator.firstActivityAt
      ? { firstActivityAt: accumulator.firstActivityAt }
      : {}),
    ...(accumulator.lastActivityAt
      ? { lastActivityAt: accumulator.lastActivityAt }
      : {}),
    hasCodexEstimate: accumulator.hasCodexEstimate,
    bySource,
    chatTurnsByModel: modelRows(accumulator.chatTurnsByModel),
    byModel: modelRows(accumulator.byModel),
    ...(byProxyAccount.length > 0 ? { byProxyAccount } : {}),
    context: contextView(accumulator),
    ...(accumulator.categorySnapshot
      ? { contextCategoriesAt: accumulator.categorySnapshot.at }
      : {}),
    compactions: accumulator.compactions,
    activity: activityFromPoints(activityBase, sortedPoints),
    points: sortedPoints,
  };
}

function mergeModelRows(
  left: readonly CostModelRow[],
  right: readonly CostModelRow[],
): readonly CostModelRow[] {
  const values = new Map<string, ModelAccumulator>();
  for (const row of left.concat(right)) {
    const value = values.get(row.model) ?? {
      turnCount: 0,
      usd: 0,
      notPricedCount: 0,
      tokens: emptyTokens(),
    };
    value.turnCount += row.turnCount;
    value.usd += row.usd;
    value.notPricedCount += row.notPricedCount;
    addTokens(value.tokens, row.tokens);
    values.set(row.model, value);
  }
  return modelRows(values);
}

function mergeCostTotals(left: CostTotals, right: CostTotals): CostTotals {
  const bySource = {
    chat: roundUsd(left.bySource.chat + right.bySource.chat),
    pipeline: roundUsd(left.bySource.pipeline + right.bySource.pipeline),
    subagents: roundUsd(left.bySource.subagents + right.bySource.subagents),
    delegations: roundUsd(
      left.bySource.delegations + right.bySource.delegations,
    ),
    background: roundUsd(left.bySource.background + right.bySource.background),
  };
  const byBilling = {
    subscription: roundUsd(
      left.byBilling.subscription + right.byBilling.subscription,
    ),
    ai_credits: roundUsd(
      left.byBilling.ai_credits + right.byBilling.ai_credits,
    ),
    account_proxy: roundUsd(
      left.byBilling.account_proxy + right.byBilling.account_proxy,
    ),
    api_key: roundUsd(left.byBilling.api_key + right.byBilling.api_key),
    org_gateway: roundUsd(
      left.byBilling.org_gateway + right.byBilling.org_gateway,
    ),
    local: roundUsd(left.byBilling.local + right.byBilling.local),
    unknown: roundUsd(left.byBilling.unknown + right.byBilling.unknown),
  };
  return {
    usd: roundUsd(
      Object.values(bySource).reduce((total, amount) => total + amount, 0),
    ),
    bySource: bySource,
    byBilling,
    tokens: sumTokens(left.tokens, right.tokens),
    notPricedCount: left.notPricedCount + right.notPricedCount,
    ...notPricedByBillingField(
      left.notPricedByBilling,
      right.notPricedByBilling,
    ),
    hasEstimate: left.hasEstimate || right.hasEstimate,
  };
}

function mergeBackgroundRows(
  left: readonly CostBackgroundRow[],
  right: readonly CostBackgroundRow[],
): readonly CostBackgroundRow[] {
  const values = new Map<
    string,
    {
      runCount: number;
      usd: number;
      notPricedCount: number;
      tokens: MutableTokens;
    }
  >();
  for (const row of left.concat(right)) {
    const current = values.get(row.kind) ?? {
      runCount: 0,
      usd: 0,
      notPricedCount: 0,
      tokens: emptyTokens(),
    };
    current.runCount += row.runCount;
    current.usd += row.usd;
    current.notPricedCount += row.notPricedCount;
    addTokens(current.tokens, row.tokens);
    values.set(row.kind, current);
  }
  return backgroundRows(values);
}

function mergeSourceBreakdown(
  left: CostSourceBreakdown,
  right: CostSourceBreakdown,
): CostSourceBreakdown {
  return {
    chat: {
      usd: roundUsd(left.chat.usd + right.chat.usd),
      turnCount: left.chat.turnCount + right.chat.turnCount,
    },
    subagents: {
      usd: roundUsd(left.subagents.usd + right.subagents.usd),
      items: attributionItems([
        ...left.subagents.items,
        ...right.subagents.items,
      ]),
    },
    delegations: {
      usd: roundUsd(left.delegations.usd + right.delegations.usd),
      items: attributionItems([
        ...left.delegations.items,
        ...right.delegations.items,
      ]),
    },
    background: {
      usd: roundUsd(left.background.usd + right.background.usd),
      rows: mergeBackgroundRows(left.background.rows, right.background.rows),
    },
  };
}

function mergeContexts(
  left: CostContextView,
  right: CostContextView,
  leftCategoriesAt: string | undefined,
  rightCategoriesAt: string | undefined,
): { context: CostContextView; categoriesAt?: string } {
  const latest =
    left.latest && right.latest
      ? left.latest.at.localeCompare(right.latest.at) >= 0
        ? left.latest
        : right.latest
      : (left.latest ?? right.latest);
  const effectiveLeftCategoriesAt =
    leftCategoriesAt ??
    (left.categories.length > 0 ? left.latest?.at : undefined);
  const useRightCategories =
    right.categories.length > 0 &&
    (left.categories.length === 0 ||
      effectiveLeftCategoriesAt === undefined ||
      (rightCategoriesAt ?? '').localeCompare(effectiveLeftCategoriesAt) >= 0);
  const categorySource = useRightCategories
    ? right
    : left.categories.length > 0
      ? left
      : right;
  const categoriesAt = useRightCategories
    ? rightCategoriesAt
    : left.categories.length > 0
      ? effectiveLeftCategoriesAt
      : rightCategoriesAt;
  const peak =
    left.peak && right.peak
      ? left.peak.usedTokens > right.peak.usedTokens ||
        (left.peak.usedTokens === right.peak.usedTokens &&
          left.peak.windowTokens >= right.peak.windowTokens)
        ? left.peak
        : right.peak
      : (left.peak ?? right.peak);
  return {
    context: {
      ...(latest ? { latest } : {}),
      categories: categorySource.categories,
      ...(peak ? { peak } : {}),
      timeline: [...left.timeline, ...right.timeline].sort(
        (a, b) => a.at.localeCompare(b.at) || a.endTokens - b.endTokens,
      ),
    },
    ...(categoriesAt ? { categoriesAt } : {}),
  };
}

function mergeChatAggregates(
  left: CostChatAggregate,
  right: CostChatAggregate,
): CostChatAggregate {
  const points = sortPoints([...left.points, ...right.points]);
  const topTools = [
    ...left.activity.topTools,
    ...right.activity.topTools,
  ].reduce((tools, item) => {
    tools.set(item.tool, (tools.get(item.tool) ?? 0) + item.count);
    return tools;
  }, new Map<string, number>());
  const activityBase = {
    turnCount: left.activity.turnCount + right.activity.turnCount,
    toolCallCount: left.activity.toolCallCount + right.activity.toolCallCount,
    subagentCount: left.activity.subagentCount + right.activity.subagentCount,
    plansCreated: left.activity.plansCreated + right.activity.plansCreated,
    plansApproved: left.activity.plansApproved + right.activity.plansApproved,
    topTools,
  };
  const activity = activityFromPoints(
    {
      turnCount: activityBase.turnCount,
      toolCallCount: activityBase.toolCallCount,
      subagentCount: activityBase.subagentCount,
      plansCreated: activityBase.plansCreated,
      plansApproved: activityBase.plansApproved,
      topTools: Array.from(activityBase.topTools.entries())
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
    },
    points,
  );
  const mergedContext = mergeContexts(
    left.context,
    right.context,
    left.contextCategoriesAt,
    right.contextCategoriesAt,
  );
  const byProxyAccount = mergeProxyAccountRows(
    left.byProxyAccount,
    right.byProxyAccount,
  );
  return {
    totals: mergeCostTotals(left.totals, right.totals),
    turnCount: left.turnCount + right.turnCount,
    ...(minTimestamp(left.firstActivityAt, right.firstActivityAt)
      ? {
          firstActivityAt: minTimestamp(
            left.firstActivityAt,
            right.firstActivityAt,
          ),
        }
      : {}),
    ...(maxTimestamp(left.lastActivityAt, right.lastActivityAt)
      ? {
          lastActivityAt: maxTimestamp(
            left.lastActivityAt,
            right.lastActivityAt,
          ),
        }
      : {}),
    hasCodexEstimate: left.hasCodexEstimate || right.hasCodexEstimate,
    bySource: mergeSourceBreakdown(left.bySource, right.bySource),
    chatTurnsByModel: mergeModelRows(
      left.chatTurnsByModel,
      right.chatTurnsByModel,
    ),
    byModel: mergeModelRows(left.byModel, right.byModel),
    ...(byProxyAccount.length > 0 ? { byProxyAccount } : {}),
    context: mergedContext.context,
    ...(mergedContext.categoriesAt
      ? { contextCategoriesAt: mergedContext.categoriesAt }
      : {}),
    compactions: {
      total: left.compactions.total + right.compactions.total,
      auto: left.compactions.auto + right.compactions.auto,
      manual: left.compactions.manual + right.compactions.manual,
    },
    activity,
    points,
  };
}

function minTimestamp(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.localeCompare(right) <= 0 ? left : right;
}

function maxTimestamp(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

/** Empty aggregate used before any audit records have been indexed. */
export function emptyChatAggregate(): CostChatAggregate {
  return {
    totals: createEmptyCostTotals(),
    turnCount: 0,
    hasCodexEstimate: false,
    bySource: {
      chat: { usd: 0, turnCount: 0 },
      subagents: { usd: 0, items: [] },
      delegations: { usd: 0, items: [] },
      background: { usd: 0, rows: [] },
    },
    chatTurnsByModel: [],
    byModel: [],
    context: { categories: [], timeline: [] },
    compactions: { total: 0, auto: 0, manual: 0 },
    activity: {
      turnCount: 0,
      totalDurationMs: 0,
      averageTurnMs: null,
      p95TurnMs: null,
      toolCallCount: 0,
      subagentCount: 0,
      plansCreated: 0,
      plansApproved: 0,
      topTools: [],
    },
    points: [],
  };
}

/** Aggregate current records on top of an already sealed aggregate. */
export function aggregateRecords(
  records: readonly CostTurnRecord[],
  sealed?: CostChatAggregate,
): CostChatAggregate {
  const accumulator = emptyAccumulator();
  let turnCount = 0;

  for (const record of [...records].sort(recordSort)) {
    const mainAmount = recordAmount(record);
    const subagents = [...(record.subagents ?? [])].sort(
      (left, right) =>
        left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind),
    );
    let includedTokens: CostTokenTotals = {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    };
    let includedUsd = 0;
    for (const item of subagents) {
      if (item.inclusion !== 'included') continue;
      includedTokens = sumTokens(includedTokens, item.tokens);
      includedUsd += itemAmount(item) ?? 0;
    }
    const mainTokens = subtractTokens(record.tokens, includedTokens);
    const mainUsd =
      mainAmount === undefined
        ? undefined
        : Math.max(0, mainAmount - includedUsd);
    const mainStatus = statusForAmount(mainUsd, record.costStatus);
    const source = recordSource(record);
    addWorkContribution(accumulator, {
      source,
      billingBasis: record.billingBasis,
      tokens: mainTokens,
      ...(mainUsd === undefined ? {} : { usd: mainUsd }),
      costStatus: mainStatus,
      model: record.model,
      isCodex: record.provider === 'codex',
      countNotPriced: true,
    });
    addActivityTime(accumulator, record);
    addProxyAccountContribution(accumulator.byProxyAccount, record, mainAmount);

    if (record.source === 'chat') {
      turnCount += 1;
      accumulator.chatTurnCount += 1;
      accumulator.chatUsd += mainUsd ?? 0;
      addModelContribution(
        accumulator.chatTurnsByModel,
        record.model,
        mainTokens,
        mainUsd,
        mainUsd === undefined && hasTokens(mainTokens),
      );
      addChatActivity(accumulator, record);
    }

    if (record.source === 'background') {
      addBackgroundRecord(accumulator, record, mainAmount);
    }

    for (const item of subagents) {
      const amount = itemAmount(item);
      const isIncluded = item.inclusion === 'included';
      const itemStatus = statusForAmount(amount, item.costStatus);
      accumulator.subagentItems.push(item);
      addWorkContribution(accumulator, {
        source: 'subagents',
        billingBasis: item.billingBasis,
        tokens: item.tokens,
        ...(amount === undefined ? {} : { usd: amount }),
        costStatus: itemStatus,
        model: item.model ?? record.model,
        isCodex: record.provider === 'codex' || item.kind === 'codex_agent',
        countNotPriced: !isIncluded || mainAmount === undefined,
      });
    }

    if (record.source === 'delegation') {
      const item = record.delegation;
      if (item) accumulator.delegationItems.push(item);
    }
  }

  const delta = accumulatorToAggregate(accumulator, turnCount);
  if (!sealed) return delta;
  return mergeChatAggregates(sealed, delta);
}

function rowActivity(row: CostSummaryChat): string {
  return row.lastActivityAt;
}

function summaryChatHasFacts(chat: CostChatAggregate): boolean {
  return (
    chat.turnCount > 0 ||
    chat.totals.usd > 0 ||
    chat.totals.notPricedCount > 0 ||
    hasTokens(chat.totals.tokens) ||
    chat.bySource.background.rows.length > 0 ||
    chat.bySource.delegations.items.length > 0 ||
    chat.bySource.subagents.items.length > 0
  );
}

function modelUsageOrder(left: CostModelRow, right: CostModelRow): number {
  return (
    right.turnCount - left.turnCount ||
    right.usd - left.usd ||
    left.model.localeCompare(right.model)
  );
}

function buildSummaryChat(file: CostChatFile): {
  row: CostSummaryChat;
  aggregate: CostChatAggregate;
} | null {
  const aggregate = aggregateRecords(Object.values(file.records), file.sealed);
  if (!summaryChatHasFacts(aggregate)) return null;
  const lastActivityAt =
    aggregate.lastActivityAt ??
    aggregate.firstActivityAt ??
    '1970-01-01T00:00:00.000Z';
  return {
    aggregate,
    row: {
      chatId: file.chatId,
      totals: aggregate.totals,
      turnCount: aggregate.turnCount,
      ...(aggregate.firstActivityAt
        ? { firstActivityAt: aggregate.firstActivityAt }
        : {}),
      lastActivityAt,
      models: [...aggregate.chatTurnsByModel]
        .sort(modelUsageOrder)
        .map((model) => model.model),
      // Running and visible labels are canonical chat-store facts and are
      // projected at read time, not baked into the cost summary.
      running: false,
      hasCodexEstimate: aggregate.hasCodexEstimate,
      ...(aggregate.byProxyAccount
        ? { proxyAccounts: aggregate.byProxyAccount }
        : {}),
    },
  };
}

function sortedPipelineRows(
  runs: readonly PipelineRunCostView[],
): readonly CostPipelineRunRow[] {
  return [...runs]
    .map((view) => view.run)
    .sort(
      (left, right) =>
        right.totals.usd - left.totals.usd ||
        right.startedAt.localeCompare(left.startedAt) ||
        left.executionId.localeCompare(right.executionId),
    );
}

function isUnattachedBackground(record: CostTurnRecord): boolean {
  return (
    record.source === 'background' &&
    record.chatId === undefined &&
    record.pipeline === undefined
  );
}

/** Build the one-read summary, including every cached chat row fact. */
export function buildSummary(
  location: CostScopeLocation,
  chats: readonly CostChatFile[],
  unattached: CostUnattachedFile,
  metadata: {
    updatedAt: string | null;
    coverageStart?: string;
    retentionDays: number;
    revision: number;
    sealedAt?: string;
  },
): CostSummaryFile {
  const chatRows = chats
    .flatMap((file) => {
      const result = buildSummaryChat(file);
      return result ? [result] : [];
    })
    .sort(
      (left, right) =>
        right.row.totals.usd - left.row.totals.usd ||
        rowActivity(right.row).localeCompare(rowActivity(left.row)) ||
        left.row.chatId.localeCompare(right.row.chatId),
    );

  const unattachedRecords = Object.values(unattached.records);
  const runRecords = unattachedRecords.filter(
    (record) => record.pipeline !== undefined,
  );
  const pipelineViews = buildPipelineRunViews(
    runRecords,
    unattached.sealedRuns,
  );
  const unattachedRecordsOnly = unattachedRecords.filter(
    isUnattachedBackground,
  );
  const unattachedAggregate =
    unattachedRecordsOnly.length > 0 || unattached.sealedUnattached
      ? aggregateRecords(unattachedRecordsOnly, unattached.sealedUnattached)
      : undefined;
  const hasUnattached =
    unattachedRecordsOnly.length > 0 ||
    (unattachedAggregate !== undefined &&
      summaryChatHasFacts(unattachedAggregate));

  let totals = createEmptyCostTotals();
  for (const row of chatRows) totals = mergeCostTotals(totals, row.row.totals);
  for (const run of pipelineViews)
    totals = mergeCostTotals(totals, run.run.totals);
  if (unattachedAggregate && hasUnattached) {
    totals = mergeCostTotals(totals, unattachedAggregate.totals);
  }

  const hasCodexEstimate =
    chatRows.some((chat) => chat.aggregate.hasCodexEstimate) ||
    pipelineViews.some(
      (view) =>
        view.steps.some(
          (step) => step.harness === 'codex' && step.totals.hasEstimate,
        ) ||
        view.subagents.some(
          (item) =>
            item.kind === 'codex_agent' && item.costStatus === 'estimated',
        ) ||
        view.delegations.some(
          (item) => item.harness === 'codex' && item.costStatus === 'estimated',
        ),
    ) ||
    unattachedAggregate?.hasCodexEstimate === true;
  const scopeId =
    location.scope.kind === 'entry'
      ? location.scope.worktreeId
      : location.scope.containerId;

  return {
    version: 1,
    projectId: location.scope.projectId,
    scopeId,
    incarnation: location.incarnation,
    updatedAt: metadata.updatedAt,
    ...(metadata.sealedAt ? { sealedAt: metadata.sealedAt } : {}),
    ...(metadata.coverageStart
      ? { coverageStart: metadata.coverageStart }
      : {}),
    retentionDays: clampRetentionDays(metadata.retentionDays),
    revision: finiteInteger(metadata.revision, 0),
    totals,
    chats: chatRows.map((chat) => chat.row),
    pipelineRuns: sortedPipelineRows(pipelineViews),
    ...(hasUnattached && unattachedAggregate
      ? { unattached: unattachedAggregate.totals }
      : {}),
    hasCodexEstimate,
  };
}

function finiteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function clampRetentionDays(value: number): number {
  return Math.min(90, Math.max(1, finiteInteger(value, 7)));
}

function isOlderThanCoverage(
  createdAt: string | undefined,
  coverageStart: string | undefined,
): boolean {
  if (!createdAt || !coverageStart) return false;
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return false;
  return (
    new Date(timestamp).toISOString().slice(0, 10) < coverageStart.slice(0, 10)
  );
}

function chatRowFromSummary(
  summaryChat: CostSummaryChat,
  identity: CostChatIdentity,
  scope: CostScopeRef,
  summary: CostSummaryFile,
): CostChatRow {
  const retained = scope.kind === 'retained';
  return {
    chatId: summaryChat.chatId,
    label: identity.label,
    state: retained ? 'archived' : identity.state,
    totals: summaryChat.totals,
    turnCount: summaryChat.turnCount,
    lastActivityAt: summaryChat.lastActivityAt,
    running: retained ? false : identity.running === true,
    models: summaryChat.models,
    ...(isOlderThanCoverage(identity.createdAt, summary.coverageStart)
      ? { coverageStart: summary.coverageStart }
      : {}),
    ...(summaryChat.proxyAccounts?.length
      ? { proxyAccounts: summaryChat.proxyAccounts }
      : {}),
  };
}

/** Whether a scope with no summary is still in its first build. */
export interface CostEmptyScopeState {
  readonly building: boolean;
  readonly updatedAt: string | null;
}

function emptyScopeView(
  scope: CostScopeRef,
  retentionDays: number,
  state: CostEmptyScopeState = { building: true, updatedAt: null },
): CostScopeView {
  return {
    scope,
    updatedAt: state.updatedAt,
    building: state.building,
    retentionDays: clampRetentionDays(retentionDays),
    totals: createEmptyCostTotals(),
    chats: [],
    pipelineRuns: [],
    hasCodexEstimate: false,
  };
}

/** Join cached row facts with chat identity only when a scope is read. */
export function projectScopeView(
  summary: CostSummaryFile | null,
  scope: CostScopeRef,
  identities: readonly CostChatIdentity[],
  retentionDays: number,
  options: {
    /** How to read a scope with no activity: still building, or built and empty. */
    readonly emptyState?: CostEmptyScopeState;
    /** Root run state from the host; the audit only knows each agent step. */
    readonly runStates?: ReadonlyMap<
      string,
      {
        readonly status: CostPipelineRunRow['status'];
        readonly pipelineName?: string;
      }
    >;
  } = {},
): CostScopeView {
  const { emptyState, runStates } = options;
  if (!summary) return emptyScopeView(scope, retentionDays, emptyState);
  const identityById = new Map<string, CostChatIdentity>();
  for (const identity of identities) {
    if (!identityById.has(identity.chatId))
      identityById.set(identity.chatId, identity);
  }
  const chats = summary.chats.flatMap((chat) => {
    const identity = identityById.get(chat.chatId);
    return identity ? [chatRowFromSummary(chat, identity, scope, summary)] : [];
  });
  chats.sort(
    (left, right) =>
      right.totals.usd - left.totals.usd ||
      right.lastActivityAt.localeCompare(left.lastActivityAt) ||
      left.chatId.localeCompare(right.chatId),
  );
  const pipelineRuns = summary.pipelineRuns
    .map((run): CostPipelineRunRow => {
      const state = runStates?.get(run.executionId);
      if (state === undefined) return run;
      return {
        ...run,
        status: state.status,
        ...(state.pipelineName?.trim()
          ? { pipelineName: state.pipelineName.trim() }
          : {}),
      };
    })
    .sort(
      (left, right) =>
        right.totals.usd - left.totals.usd ||
        right.startedAt.localeCompare(left.startedAt) ||
        left.executionId.localeCompare(right.executionId),
    );
  const sealed = summary.sealedAt !== undefined;
  const result: CostScopeView = {
    scope,
    updatedAt:
      summary.updatedAt ?? (sealed ? null : (emptyState?.updatedAt ?? null)),
    // A sealed summary is final. A live one with no activity is building only
    // until a full scan has found nothing for it.
    building:
      !sealed && summary.updatedAt === null && (emptyState?.building ?? true),
    ...(scope.kind === 'retained' && summary.sealedAt
      ? { sealedAt: summary.sealedAt }
      : {}),
    ...(summary.coverageStart ? { coverageStart: summary.coverageStart } : {}),
    retentionDays: clampRetentionDays(summary.retentionDays ?? retentionDays),
    totals: summary.totals,
    chats,
    pipelineRuns,
    ...(summary.unattached ? { unattached: summary.unattached } : {}),
    hasCodexEstimate: summary.hasCodexEstimate,
  };
  return result;
}

function chatRowFromAggregate(
  chatId: string,
  aggregate: CostChatAggregate,
  summary: CostSummaryFile | null,
  scope: CostScopeRef,
  identity: CostChatIdentity | undefined,
): CostChatRow {
  const summaryChat = summary?.chats.find((chat) => chat.chatId === chatId);
  const createdAt = identity?.createdAt;
  const retained = scope.kind === 'retained';
  const proxyAccounts = summaryChat
    ? summaryChat.proxyAccounts
    : aggregate.byProxyAccount;
  return {
    chatId,
    label: identity?.label?.trim() || 'Chat',
    state: retained ? 'archived' : (identity?.state ?? 'open'),
    totals: summaryChat?.totals ?? aggregate.totals,
    turnCount: summaryChat?.turnCount ?? aggregate.turnCount,
    lastActivityAt:
      summaryChat?.lastActivityAt ??
      aggregate.lastActivityAt ??
      aggregate.firstActivityAt ??
      '1970-01-01T00:00:00.000Z',
    running: retained ? false : identity?.running === true,
    models:
      summaryChat?.models ??
      [...aggregate.chatTurnsByModel]
        .sort(modelUsageOrder)
        .map((model) => model.model),
    ...(isOlderThanCoverage(createdAt, summary?.coverageStart)
      ? { coverageStart: summary?.coverageStart }
      : {}),
    ...(proxyAccounts?.length ? { proxyAccounts } : {}),
  };
}

/**
 * Project a stored chat file into the summary, full, or attribution DTO.
 * Null when the requested subagent or delegation has no row in the chat.
 */
export function projectChatView(
  file: CostChatFile,
  summary: CostSummaryFile | null,
  scope: CostScopeRef,
  identity: CostChatIdentity | undefined,
  request: CostChatRequest,
):
  | { readonly kind: 'summary'; readonly chat: CostChatRow }
  | { readonly kind: 'full'; readonly breakdown: SessionBreakdownView }
  | {
      readonly kind: 'subagent';
      readonly chat: CostChatRow;
      readonly item: CostAttributedItem;
    }
  | null {
  const aggregate = aggregateRecords(Object.values(file.records), file.sealed);
  const chat = chatRowFromAggregate(
    file.chatId,
    aggregate,
    summary,
    scope,
    identity,
  );

  if (request.subagentId !== undefined) {
    const item = [
      ...aggregate.bySource.subagents.items,
      ...aggregate.bySource.delegations.items,
    ].find((candidate) => candidate.id === request.subagentId);
    // The chat never started it, or its cost is not recorded yet.
    if (!item) return null;
    return { kind: 'subagent', chat, item };
  }
  if (request.detail === 'summary') return { kind: 'summary', chat };

  return {
    kind: 'full',
    breakdown: {
      chat,
      updatedAt: summary?.updatedAt ?? null,
      ...(scope.kind === 'retained' && summary?.sealedAt
        ? { sealedAt: summary.sealedAt }
        : {}),
      bySource: aggregate.bySource,
      chatTurnsByModel: aggregate.chatTurnsByModel,
      byModel: aggregate.byModel,
      context: aggregate.context,
      compactions: aggregate.compactions,
      activity: aggregate.activity,
    },
  };
}

function pipelineExecution(record: CostTurnRecord): string | undefined {
  return record.pipeline?.executionId;
}

function pipelineRoot(record: CostTurnRecord): string | undefined {
  return record.pipeline?.rootExecutionId;
}

function stepKey(record: CostTurnRecord): string | undefined {
  const pipeline = record.pipeline;
  if (!pipeline?.jobId || !pipeline.stepId) return undefined;
  return JSON.stringify([
    pipeline.executionId,
    pipeline.jobId,
    pipeline.stepId,
  ]);
}

function stepAttemptCount(records: readonly CostTurnRecord[]): number {
  // A resumed attempt of a paused step is an attempt of its own (CAN-7305).
  const attempts = new Set<string>();
  for (const record of records) {
    const attempt = record.pipeline?.attempt;
    attempts.add(
      attempt === undefined
        ? `entry:${record.entryId}`
        : `attempt:${String(attempt)}/r${String(record.pipeline?.recovery ?? 0)}`,
    );
  }
  return attempts.size;
}

function latestRecord(
  records: readonly CostTurnRecord[],
): CostTurnRecord | undefined {
  return [...records].sort(
    (left, right) =>
      right.startedAt.localeCompare(left.startedAt) ||
      (right.pipeline?.attempt ?? -1) - (left.pipeline?.attempt ?? -1) ||
      right.entryId.localeCompare(left.entryId),
  )[0];
}

function pipelineStatus(
  record: CostTurnRecord | undefined,
): CostPipelineRunRow['status'] {
  if (!record || record.status === 'running') return 'running';
  if (record.status === 'success') return 'succeeded';
  if (record.status === 'cancelled' || record.status === 'interrupted') {
    return 'cancelled';
  }
  return 'failed';
}

function pipelineStepRows(
  records: readonly CostTurnRecord[],
): readonly PipelineRunStepCost[] {
  const grouped = new Map<string, CostTurnRecord[]>();
  for (const record of records) {
    if (record.source !== 'pipeline') continue;
    const key = stepKey(record);
    if (!key) continue;
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }

  return Array.from(grouped.values())
    .map((stepRecords) => {
      const sorted = [...stepRecords].sort(recordSort);
      const last = latestRecord(sorted);
      const first = sorted[0];
      const pipeline = first?.pipeline;
      if (!first || !pipeline?.jobId || !pipeline.stepId) return null;
      const aggregate = aggregateRecords(sorted);
      return {
        jobId: pipeline.jobId,
        stepId: pipeline.stepId,
        label: pipeline.stepId,
        attemptCount: stepAttemptCount(sorted),
        ...(last?.model ? { model: last.model } : {}),
        ...(last?.harness ? { harness: last.harness } : {}),
        totals: aggregate.totals,
        executionId: pipeline.executionId,
        ...(aggregate.byProxyAccount
          ? { proxyAccounts: aggregate.byProxyAccount }
          : {}),
      } satisfies PipelineRunStepCost;
    })
    .flatMap((row) => (row ? [row] : []))
    .sort(
      (left, right) =>
        right.totals.usd - left.totals.usd ||
        left.executionId.localeCompare(right.executionId) ||
        left.jobId.localeCompare(right.jobId) ||
        left.stepId.localeCompare(right.stepId),
    );
}

function stepCount(steps: readonly PipelineRunStepCost[]): number {
  return new Set(
    steps.map((step) =>
      JSON.stringify([step.executionId, step.jobId, step.stepId]),
    ),
  ).size;
}

function advisorSummary(
  records: readonly CostTurnRecord[],
): PipelineRunCostView['advisor'] {
  const advisors = records.filter(
    (record) =>
      record.source === 'background' &&
      record.helperKind === 'pipeline_advisor',
  );
  if (advisors.length === 0) return undefined;
  let usd = 0;
  let notPricedCount = 0;
  for (const record of advisors) {
    const amount = recordAmount(record);
    usd += amount ?? 0;
    if (amount === undefined && hasTokens(record.tokens)) notPricedCount += 1;
  }
  return { reportCount: advisors.length, usd: roundUsd(usd), notPricedCount };
}

function childRunRows(
  rootExecutionId: string,
  records: readonly CostTurnRecord[],
  steps: readonly PipelineRunStepCost[],
): readonly PipelineRunChildCost[] {
  const grouped = new Map<string, CostTurnRecord[]>();
  for (const record of records) {
    const executionId = pipelineExecution(record);
    if (!executionId || executionId === rootExecutionId) continue;
    const group = grouped.get(executionId) ?? [];
    group.push(record);
    grouped.set(executionId, group);
  }
  return Array.from(grouped.entries())
    .map(([executionId, childRecords]) => {
      const name = childRecords
        .map((record) => record.pipeline?.pipelineName)
        .find((value) => value !== undefined && value.trim().length > 0);
      const childSteps = steps.filter(
        (step) => step.executionId === executionId,
      );
      const aggregate = aggregateRecords(childRecords);
      return {
        executionId,
        pipelineName: name?.trim() ?? 'Pipeline',
        usd: aggregate.totals.usd,
        agentStepCount: stepCount(childSteps),
        ...(aggregate.totals.notPricedCount > 0
          ? { notPricedCount: aggregate.totals.notPricedCount }
          : {}),
      };
    })
    .sort(
      (left, right) =>
        right.usd - left.usd ||
        left.executionId.localeCompare(right.executionId),
    );
}

function createPipelineRunView(
  rootExecutionId: string,
  records: readonly CostTurnRecord[],
): PipelineRunCostView {
  const aggregate = aggregateRecords(records);
  const steps = pipelineStepRows(records);
  const pipelineRecords = records.filter(
    (record) => record.source === 'pipeline',
  );
  const latest = latestRecord(pipelineRecords);
  const startedAt =
    records
      .map((record) => record.startedAt)
      .sort((left, right) => left.localeCompare(right))[0] ??
    latest?.startedAt ??
    '1970-01-01T00:00:00.000Z';
  const pipelineName =
    records
      .filter((record) => record.pipeline?.executionId === rootExecutionId)
      .map((record) => record.pipeline?.pipelineName)
      .find((name) => name !== undefined && name.trim().length > 0) ??
    records
      .map((record) => record.pipeline?.pipelineName)
      .find((name) => name !== undefined && name.trim().length > 0) ??
    'Pipeline';
  const run: CostPipelineRunRow = {
    executionId: rootExecutionId,
    pipelineName: pipelineName.trim(),
    startedAt,
    status: pipelineStatus(latest),
    totals: aggregate.totals,
    agentStepCount: stepCount(steps),
  };
  return {
    run,
    updatedAt: null,
    steps,
    ...(advisorSummary(records) ? { advisor: advisorSummary(records) } : {}),
    subagents: aggregate.bySource.subagents.items,
    delegations: aggregate.bySource.delegations.items,
    childRuns: childRunRows(rootExecutionId, records, steps),
    byModel: aggregate.byModel,
    ...(aggregate.byProxyAccount
      ? { byProxyAccount: aggregate.byProxyAccount }
      : {}),
  };
}

function mergeTotalsForViews(left: CostTotals, right: CostTotals): CostTotals {
  return mergeCostTotals(left, right);
}

function mergeSteps(
  left: readonly PipelineRunStepCost[],
  right: readonly PipelineRunStepCost[],
): readonly PipelineRunStepCost[] {
  const groups = new Map<string, PipelineRunStepCost>();
  for (const step of [...left, ...right]) {
    const key = JSON.stringify([step.executionId, step.jobId, step.stepId]);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, step);
      continue;
    }
    const proxyAccounts = mergeProxyAccountRows(
      current.proxyAccounts,
      step.proxyAccounts,
    );
    groups.set(key, {
      ...current,
      label: step.label || current.label,
      attemptCount: current.attemptCount + step.attemptCount,
      ...(step.model ? { model: step.model } : {}),
      ...(step.harness ? { harness: step.harness } : {}),
      totals: mergeTotalsForViews(current.totals, step.totals),
      ...(proxyAccounts.length > 0 ? { proxyAccounts } : {}),
    });
  }
  return Array.from(groups.values()).sort(
    (a, b) =>
      b.totals.usd - a.totals.usd ||
      a.executionId.localeCompare(b.executionId) ||
      a.jobId.localeCompare(b.jobId) ||
      a.stepId.localeCompare(b.stepId),
  );
}

function mergeAdvisor(
  left: PipelineRunCostView['advisor'],
  right: PipelineRunCostView['advisor'],
): PipelineRunCostView['advisor'] {
  if (!left) return right;
  if (!right) return left;
  return {
    reportCount: left.reportCount + right.reportCount,
    usd: roundUsd(left.usd + right.usd),
    notPricedCount: left.notPricedCount + right.notPricedCount,
  };
}

function mergeChildRuns(
  left: readonly PipelineRunChildCost[],
  right: readonly PipelineRunChildCost[],
  steps: readonly PipelineRunStepCost[],
): readonly PipelineRunChildCost[] {
  const groups = new Map<string, PipelineRunChildCost>();
  for (const child of [...left, ...right]) {
    const current = groups.get(child.executionId);
    const notPricedCount =
      (current?.notPricedCount ?? 0) + (child.notPricedCount ?? 0);
    groups.set(child.executionId, {
      executionId: child.executionId,
      pipelineName: child.pipelineName || current?.pipelineName || 'Pipeline',
      usd: roundUsd((current?.usd ?? 0) + child.usd),
      agentStepCount: 0,
      ...(notPricedCount > 0 ? { notPricedCount } : {}),
    });
  }
  return Array.from(groups.values())
    .map((child) => ({
      ...child,
      agentStepCount: stepCount(
        steps.filter((step) => step.executionId === child.executionId),
      ),
    }))
    .sort(
      (a, b) => b.usd - a.usd || a.executionId.localeCompare(b.executionId),
    );
}

function mergePipelineViews(
  sealed: PipelineRunCostView,
  current: PipelineRunCostView,
  hasCurrentPipelineStep: boolean,
): PipelineRunCostView {
  const steps = mergeSteps(sealed.steps, current.steps);
  const run: CostPipelineRunRow = {
    executionId: sealed.run.executionId,
    pipelineName:
      current.run.pipelineName !== 'Pipeline'
        ? current.run.pipelineName
        : sealed.run.pipelineName,
    startedAt:
      minTimestamp(sealed.run.startedAt, current.run.startedAt) ??
      sealed.run.startedAt,
    status: hasCurrentPipelineStep ? current.run.status : sealed.run.status,
    totals: mergeTotalsForViews(sealed.run.totals, current.run.totals),
    agentStepCount: stepCount(steps),
  };
  const childRuns = mergeChildRuns(sealed.childRuns, current.childRuns, steps);
  const byProxyAccount = mergeProxyAccountRows(
    sealed.byProxyAccount,
    current.byProxyAccount,
  );
  return {
    run,
    updatedAt: current.updatedAt ?? sealed.updatedAt,
    ...(sealed.sealedAt ? { sealedAt: sealed.sealedAt } : {}),
    ...(sealed.nonAgentStepCount === undefined
      ? {}
      : { nonAgentStepCount: sealed.nonAgentStepCount }),
    steps,
    ...(mergeAdvisor(sealed.advisor, current.advisor)
      ? { advisor: mergeAdvisor(sealed.advisor, current.advisor) }
      : {}),
    subagents: attributionItems([...sealed.subagents, ...current.subagents]),
    delegations: attributionItems([
      ...sealed.delegations,
      ...current.delegations,
    ]),
    childRuns,
    byModel: mergeModelRows(sealed.byModel, current.byModel),
    ...(byProxyAccount.length > 0 ? { byProxyAccount } : {}),
  };
}

function hasPipelineStep(records: readonly CostTurnRecord[]): boolean {
  return records.some((record) => record.source === 'pipeline');
}

/** Build root-run details. Nested executions contribute to their root row. */
export function buildPipelineRunViews(
  records: readonly CostTurnRecord[],
  sealedRuns: Readonly<Record<string, PipelineRunCostView>> = {},
): readonly PipelineRunCostView[] {
  const grouped = new Map<string, CostTurnRecord[]>();
  for (const record of records) {
    const root = pipelineRoot(record);
    if (!root) continue;
    const group = grouped.get(root) ?? [];
    group.push(record);
    grouped.set(root, group);
  }

  const roots = new Set<string>([
    ...Object.keys(sealedRuns),
    ...Array.from(grouped.keys()),
  ]);
  const views: PipelineRunCostView[] = [];
  for (const root of Array.from(roots).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const currentRecords = grouped.get(root) ?? [];
    const sealed = sealedRuns[root];
    const current = createPipelineRunView(root, currentRecords);
    let view = current;
    if (sealed) {
      // An empty current view carries placeholder facts, such as an epoch
      // start, that must not be merged into a sealed run.
      view =
        currentRecords.length === 0
          ? sealed
          : mergePipelineViews(
              sealed,
              current,
              hasPipelineStep(currentRecords),
            );
    }
    if (view.run.agentStepCount > 0) views.push(view);
  }
  return views.sort(
    (left, right) =>
      right.run.totals.usd - left.run.totals.usd ||
      right.run.startedAt.localeCompare(left.run.startedAt) ||
      left.run.executionId.localeCompare(right.run.executionId),
  );
}

/** Project the cached cost run and attach execution-state facts read on demand. */
export function projectPipelineRunView(
  unattached: CostUnattachedFile,
  summary: CostSummaryFile | null,
  scope: CostScopeRef,
  executionId: string,
  state: {
    nonAgentStepCount?: number;
    status?: CostPipelineRunRow['status'];
    pipelineName?: string;
    stepNames?: Readonly<Record<string, string>>;
  } | null,
): PipelineRunCostView | null {
  const records = Object.values(unattached.records).filter(
    (record) => record.pipeline !== undefined,
  );
  const views = buildPipelineRunViews(records, unattached.sealedRuns);
  const view = views.find(
    (candidate) =>
      candidate.run.executionId === executionId ||
      candidate.childRuns.some((child) => child.executionId === executionId),
  );
  if (!view) return null;

  const summaryRun =
    summary?.pipelineRuns.find(
      (run) => run.executionId === view.run.executionId,
    ) ?? (summary === null ? view.run : undefined);
  if (!summaryRun) return null;

  const isRootRequest = executionId === view.run.executionId;
  const mayUseLiveState = isRootRequest && scope.kind === 'entry';
  const run = {
    ...summaryRun,
    ...(mayUseLiveState && state?.status ? { status: state.status } : {}),
    ...(mayUseLiveState && state?.pipelineName?.trim()
      ? { pipelineName: state.pipelineName.trim() }
      : {}),
  };
  // Names come from the run's definitions at read time; the store keeps ids.
  const stepNames = state?.stepNames;
  const steps =
    stepNames === undefined
      ? view.steps
      : view.steps.map((step) => {
          const name =
            stepNames[`${step.executionId}/${step.jobId}/${step.stepId}`];
          return name ? { ...step, label: name } : step;
        });
  // The execution is the source while it can be read. A sealed run keeps the
  // count it was sealed with.
  const nonAgentStepCount =
    mayUseLiveState && state?.nonAgentStepCount !== undefined
      ? Math.max(0, Math.floor(state.nonAgentStepCount))
      : view.nonAgentStepCount;
  const projection: PipelineRunCostView = {
    run,
    updatedAt: summary?.updatedAt ?? null,
    steps,
    ...(view.advisor ? { advisor: view.advisor } : {}),
    subagents: view.subagents,
    delegations: view.delegations,
    childRuns: view.childRuns,
    byModel: view.byModel,
    ...(view.byProxyAccount ? { byProxyAccount: view.byProxyAccount } : {}),
    ...(nonAgentStepCount === undefined ? {} : { nonAgentStepCount }),
  };
  if (scope.kind === 'retained' && summary?.sealedAt) {
    return { ...projection, sealedAt: summary.sealedAt };
  }
  return projection;
}

// Kept here to make the billing tuple part of the read model's compile-time
// contract and guard the map values against accidental basis omissions.
const _BILLING_BASES: readonly CostBillingBasis[] = COST_BILLING_BASES;
void _BILLING_BASES;
