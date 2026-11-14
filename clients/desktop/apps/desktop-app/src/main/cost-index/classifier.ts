import { accountProxyAccountKey } from '@canopy/desktop-shared/lib/account-proxy';
import { isCostWorkScope } from '@canopy/desktop-shared/lib/cost-scope';
import type {
  AgentAuditBillingBasis,
  AgentAuditEntry,
  AgentAuditEventType,
  AgentAuditModelUsage,
  AgentAuditSubagentUsage,
} from '@canopy/desktop-shared/types';
import {
  COST_BILLING_BASES,
  type CostAttributedItem,
  type CostBillingBasis,
  type CostHelperKind,
  type CostProxyAccountRef,
  type CostStatus,
  type CostTokenTotals,
} from '@canopy/protocol/cost-view';
import type { CostTurnRecord } from './types';
import { observedModelIdentity } from '@canopy/core-runtime/observability';

const HELPER_KIND_BY_EVENT: Readonly<
  Partial<Record<AgentAuditEventType, CostHelperKind>>
> = {
  chat_summary: 'chat_title',
  branch_naming: 'branch_name',
  chat_handoff_summary: 'handoff_summary',
  commit_message_generation: 'commit_message',
  worktree_summary: 'entry_summary',
  pr_generation: 'pull_request_text',
  pr_split_planning: 'pull_request_text',
  pipeline_advisor: 'pipeline_advisor',
  cron_generation: 'other',
  automation_if_command_generation: 'other',
  archive_summary: 'other',
  worktree_plan_diagram: 'other',
  code_review_annotations: 'other',
  code_review_diagram: 'other',
  local_memory_consolidation: 'other',
  local_memory_chat_profile: 'other',
  skill_suggestion_scan: 'other',
};

const EMPTY_TOKENS: CostTokenTotals = {
  input: 0,
  output: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
};

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function tokenTotals(
  value: AgentAuditEntry['tokens'],
  codexInputNormalization = false,
): CostTokenTotals {
  const input = finiteNonNegative(value.input) ?? 0;
  const cacheReadInputTokens =
    finiteNonNegative(value.cacheReadInputTokens) ?? 0;
  const cacheCreationInputTokens =
    finiteNonNegative(value.cacheCreationInputTokens) ?? 0;
  return {
    input: codexInputNormalization
      ? Math.max(0, input - cacheReadInputTokens - cacheCreationInputTokens)
      : input,
    output: finiteNonNegative(value.output) ?? 0,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens: finiteNonNegative(value.reasoningOutputTokens) ?? 0,
  };
}

function isCodexHarness(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'codex';
}

function isCodexEntry(entry: AgentAuditEntry): boolean {
  return (
    entry.provider === 'codex' ||
    isCodexHarness(entry.executionHarness) ||
    isCodexHarness(entry.delegation?.harness)
  );
}

function isCodexSubagent(subagent: AgentAuditSubagentUsage): boolean {
  return subagent.kind === 'codex_agent';
}

function normalizedTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function isScopeId(value: string | undefined): value is string {
  if (value === undefined) return false;
  const normalized = value.trim();
  // Match the canonical path helper's ID grammar before asking the host to
  // resolve a line; one malformed audit scope must not block an entire day.
  return /^[a-z0-9][a-z0-9-]*$/.test(normalized);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** The id shape the store keeps for subagents and delegations; IPC accepts the same. */
export function safeOpaqueId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    hasControlCharacters(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

const MAX_AUDIT_ENTRY_ID_LENGTH = 512;

/**
 * An audit entry's own id. The observability service writes ids such as
 * `chat:<project>/<worktree>/<chat>:<startedAt>` and
 * `pipeline:<run>/<job>/<step>/<attempt>:<startedAt>`, so `/` is expected. The
 * id is only ever a record key, never part of a file path; anything shaped
 * like a path is still refused.
 */
function safeAuditEntryId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > MAX_AUDIT_ENTRY_ID_LENGTH ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    hasControlCharacters(normalized) ||
    normalized.split('/').some((part) => part === '.' || part === '..')
  ) {
    return undefined;
  }
  return normalized;
}

function hasRealScope(entry: AgentAuditEntry): boolean {
  const projectId = entry.projectId?.trim();
  const worktreeId = entry.worktreeId?.trim();
  if (!isScopeId(projectId) || !isScopeId(worktreeId)) return false;
  return isCostWorkScope(projectId, worktreeId);
}

function billingBasis(entry: AgentAuditEntry): CostBillingBasis {
  const explicit: AgentAuditBillingBasis | undefined = entry.billingBasis;
  if (
    explicit !== undefined &&
    COST_BILLING_BASES.some((basis) => basis === explicit)
  ) {
    return explicit;
  }

  // Keep this order in sync with the capture contract for older audit lines:
  // organization gateway, AI Credits, local Ollama, native account, unknown.
  if (entry.modelGatewayRouted === true) return 'org_gateway';
  if (entry.aiCreditsRouted === true) return 'ai_credits';
  if (entry.provider === 'ollama') return 'local';
  if (entry.providerAccountKey?.trim()) return 'subscription';
  return 'unknown';
}

function isNeverPriced(basis: CostBillingBasis): boolean {
  return basis === 'org_gateway' || basis === 'local';
}

function observedCost(
  entry: AgentAuditEntry,
  basis: CostBillingBasis,
  codexEstimate: boolean,
): {
  costUsd?: number;
  costStatus: CostStatus;
} {
  if (isNeverPriced(basis) || entry.observedCost?.status === 'unpriced') {
    return { costStatus: 'not_priced' };
  }

  const rawCost =
    entry.provider === 'claude' && entry.modelUsage !== undefined
      ? (entry.modelUsage?.reduce(
          (sum, usage) => sum + (finiteNonNegative(usage.costUsd) ?? 0),
          0,
        ) ?? 0)
      : (entry.observedCost?.totalUsd ?? entry.totalCostUsd);
  const costUsd = finiteNonNegative(rawCost);
  if (costUsd === undefined) return { costStatus: 'not_priced' };
  if (entry.observedCost?.status === 'partially_priced') {
    return { costUsd, costStatus: 'partial' };
  }
  if (codexEstimate || entry.costDerivation === 'estimated_unknown_baseline') {
    return { costUsd, costStatus: 'estimated' };
  }
  return { costUsd, costStatus: 'reported' };
}

function isEmptySuccessfulBackground(
  entry: AgentAuditEntry,
  source: CostTurnRecord['source'],
): boolean {
  if (
    source !== 'background' ||
    entry.status !== 'success' ||
    entry.messageCount !== 0 ||
    entry.assistantMessageCount !== 0 ||
    finiteNonNegative(entry.observedCost?.totalUsd ?? entry.totalCostUsd) !==
      undefined
  ) {
    return false;
  }

  const tokens = tokenTotals(entry.tokens);
  return (
    tokens.input === 0 &&
    tokens.output === 0 &&
    tokens.cacheReadInputTokens === 0 &&
    tokens.cacheCreationInputTokens === 0
  );
}

function safeLabel(label: string | undefined, fallback: string): string {
  const normalized = label
    ?.trim()
    .split('')
    .filter((character) => !hasControlCharacters(character))
    .join('');
  return normalized && !normalized.includes('/') && !normalized.includes('\\')
    ? normalized.slice(0, 120)
    : fallback;
}

/** The account-proxy accounts kept on a record; see the audit capture. */
const MAX_RECORD_PROXY_ACCOUNTS = 16;

/**
 * The accounts that served an entry the proxy paid for. Any other basis
 * keeps none: the entry fell back to another route after the proxy served
 * part of it, and its cost is not the proxy's. Labels, often emails, are
 * not kept; a view joins them from the account list when it is read, like
 * chat names.
 */
function sanitizedAccountProxy(
  entry: AgentAuditEntry,
  basis: CostBillingBasis,
): CostTurnRecord['accountProxy'] {
  const usage = entry.accountProxy;
  if (basis !== 'account_proxy' || !usage) return undefined;
  const connectionId = safeOpaqueId(usage.connectionId);
  if (!connectionId) return undefined;
  const seen = new Set<string>();
  const accounts = usage.accounts.flatMap((account) => {
    const authIndex = safeOpaqueId(account.authIndex);
    if (!authIndex || seen.has(authIndex)) return [];
    if (!Number.isInteger(account.requests) || account.requests < 1) return [];
    seen.add(authIndex);
    const provider = safeOpaqueId(account.provider)?.slice(0, 40);
    return [
      {
        authIndex,
        ...(provider ? { provider } : {}),
        requests: account.requests,
      },
    ];
  });
  if (accounts.length === 0) return undefined;
  return {
    connectionId,
    accounts: accounts
      .sort(
        (left, right) =>
          right.requests - left.requests ||
          left.authIndex.localeCompare(right.authIndex),
      )
      .slice(0, MAX_RECORD_PROXY_ACCOUNTS),
  };
}

/** The accounts a subagent or delegation of the record is shown with. */
function proxyAccountRefs(
  accountProxy: CostTurnRecord['accountProxy'],
): readonly CostProxyAccountRef[] | undefined {
  if (!accountProxy) return undefined;
  return accountProxy.accounts.map((account) => ({
    accountKey: accountProxyAccountKey(
      accountProxy.connectionId,
      account.authIndex,
    ),
    label: '',
    ...(account.provider ? { provider: account.provider } : {}),
  }));
}

function safeModel(model: string | undefined): string | undefined {
  const normalized = model?.trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

/**
 * What a token of each kind costs relative to an input token. The ratios are
 * the same across the model families whose subagents report no cost of their
 * own, so they order usage by price without a price list.
 */
const TOKEN_PRICE_WEIGHT = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheCreation: 1.25,
} as const;

/** Relative list price of a model family, for a turn that mixed families. */
const MODEL_FAMILY_PRICE_TIERS: ReadonlyArray<readonly [string, number]> = [
  ['haiku', 1],
  ['sonnet', 3],
  ['opus', 5],
];

function modelPriceTier(model: string | undefined): number | undefined {
  const normalized = model?.toLowerCase();
  if (!normalized) return undefined;
  return MODEL_FAMILY_PRICE_TIERS.find(([family]) =>
    normalized.includes(family),
  )?.[1];
}

function priceWeightedTokens(tokens: CostTokenTotals): number {
  return (
    tokens.input * TOKEN_PRICE_WEIGHT.input +
    tokens.output * TOKEN_PRICE_WEIGHT.output +
    tokens.cacheReadInputTokens * TOKEN_PRICE_WEIGHT.cacheRead +
    tokens.cacheCreationInputTokens * TOKEN_PRICE_WEIGHT.cacheCreation
  );
}

interface ModelUsageRow {
  readonly model: string;
  readonly identity: string;
  readonly tokens: CostTokenTotals;
  readonly costUsd: number;
}

function modelIdentity(model: string): string {
  return model.trim().toLowerCase();
}

function modelContextBase(model: string): string {
  return modelIdentity(model).replace(/\s*\[[^\[\]]+\]\s*$/, '');
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

function modelUsageTokenTotals(row: AgentAuditModelUsage): CostTokenTotals {
  return {
    input: finiteNonNegative(row.inputTokens) ?? 0,
    output: finiteNonNegative(row.outputTokens) ?? 0,
    cacheReadInputTokens: finiteNonNegative(row.cacheReadInputTokens) ?? 0,
    cacheCreationInputTokens:
      finiteNonNegative(row.cacheCreationInputTokens) ?? 0,
    reasoningOutputTokens: 0,
  };
}

function modelUsageRows(
  rows: AgentAuditEntry['modelUsage'],
): readonly ModelUsageRow[] {
  if (!rows || rows.length === 0) return [];
  const byIdentity = new Map<string, ModelUsageRow>();
  for (const row of rows) {
    const model = safeModel(row.model);
    if (!model) continue;
    const identity = modelIdentity(model);
    if (!identity) continue;
    const existing = byIdentity.get(identity);
    byIdentity.set(identity, {
      model: existing?.model ?? model,
      identity,
      tokens: sumTokens(
        existing?.tokens ?? EMPTY_TOKENS,
        modelUsageTokenTotals(row),
      ),
      costUsd: (existing?.costUsd ?? 0) + (finiteNonNegative(row.costUsd) ?? 0),
    });
  }
  return Array.from(byIdentity.values()).sort((left, right) =>
    left.identity.localeCompare(right.identity),
  );
}

function aggregateModelUsageTokens(
  rows: readonly ModelUsageRow[],
): CostTokenTotals {
  return rows.reduce(
    (totals, row) => sumTokens(totals, row.tokens),
    EMPTY_TOKENS,
  );
}

function modelUsageRowForModel(
  rows: readonly ModelUsageRow[],
  model: string | undefined,
): ModelUsageRow | undefined {
  const normalizedModel = model ? modelIdentity(model) : '';
  if (!normalizedModel) return undefined;
  const exact = rows.find((row) => row.identity === normalizedModel);
  if (exact) return exact;
  const contextBase = modelContextBase(normalizedModel);
  if (contextBase !== normalizedModel) {
    const unsuffixed = rows.find((row) => row.identity === contextBase);
    if (unsuffixed) return unsuffixed;
  }
  const contextMatches = rows.filter(
    (row) => modelContextBase(row.identity) === contextBase,
  );
  if (contextMatches.length === 1) return contextMatches[0];
  const tier = modelPriceTier(model);
  if (tier === undefined) return undefined;
  const familyMatches = rows.filter(
    (row) => modelPriceTier(row.model) === tier,
  );
  return familyMatches.length === 1 ? familyMatches[0] : undefined;
}

function taskTokenWeight(item: CostAttributedItem): number {
  const reportedTotal = finiteNonNegative(item.totalTokens);
  if (reportedTotal !== undefined) return reportedTotal;
  return (
    item.tokens.input +
    item.tokens.output +
    item.tokens.cacheReadInputTokens +
    item.tokens.cacheCreationInputTokens
  );
}

function wholeMicroDollars(value: number): number {
  const amount = finiteNonNegative(value);
  if (amount === undefined) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(amount * MICRO_USD));
}

function withModelUsageIncludedShares(
  items: readonly CostAttributedItem[],
  entry: AgentAuditEntry,
  turn: {
    readonly costUsd: number | undefined;
    readonly status: CostStatus;
  },
  rows: readonly ModelUsageRow[],
): readonly CostAttributedItem[] {
  const tasks = items.filter(
    (item) => item.kind === 'claude_task' && item.inclusion === 'included',
  );
  if (turn.costUsd === undefined || tasks.length === 0) return items;

  const mainRow = modelUsageRowForModel(rows, entry.model);
  const mainRowWeight = mainRow ? priceWeightedTokens(mainRow.tokens) : 0;
  const mainLoopWeight = priceWeightedTokens(tokenTotals(entry.tokens));
  const mainLoopCost =
    mainRow !== undefined && mainRowWeight > 0
      ? mainRow.costUsd * Math.min(1, mainLoopWeight / mainRowWeight)
      : 0;
  const turnMicros = wholeMicroDollars(turn.costUsd);
  const mainUsd = Math.min(turn.costUsd, mainLoopCost);
  const alreadyAttributedUsd = items.reduce(
    (sum, item) =>
      item.inclusion === 'included' && item.kind !== 'claude_task'
        ? sum + (finiteNonNegative(item.usd) ?? 0)
        : sum,
    0,
  );
  let remainingMicros = Math.min(
    turnMicros,
    wholeMicroDollars(
      Math.max(0, turn.costUsd - mainUsd - alreadyAttributedUsd),
    ),
  );
  // Per-model deltas are authoritative here, even if an older task item
  // carried a reported share. Every included Claude task gets a new estimate.
  const tasksToAllocate = tasks;
  if (remainingMicros === 0) {
    return items.map((item) =>
      tasksToAllocate.includes(item)
        ? {
            ...item,
            usd: 0,
            costStatus: turn.status === 'partial' ? 'partial' : 'estimated',
          }
        : item,
    );
  }

  const allocations = new Map<CostAttributedItem, number>();
  if (tasksToAllocate.length === 1) {
    const onlyTask = tasksToAllocate[0];
    if (onlyTask) allocations.set(onlyTask, remainingMicros);
    remainingMicros = 0;
  } else {
    const rootIdentity = entry.model ? modelIdentity(entry.model) : '';
    const taskRows = tasksToAllocate.flatMap((item) => {
      if (!item.model || !rootIdentity) return [];
      const identity = modelIdentity(item.model);
      if (!identity || identity === rootIdentity) return [];
      const row = modelUsageRowForModel(rows, item.model);
      return row && row !== mainRow ? [{ item, identity, row }] : [];
    });
    const reservedItems = new Set<CostAttributedItem>();
    const onlyUniqueDifferingModelTask =
      taskRows.length === 1 ? taskRows[0] : undefined;
    if (onlyUniqueDifferingModelTask) {
      const candidate = onlyUniqueDifferingModelTask;
      const amountMicros = Math.min(
        remainingMicros,
        wholeMicroDollars(candidate.row.costUsd),
      );
      allocations.set(candidate.item, amountMicros);
      reservedItems.add(candidate.item);
      remainingMicros -= amountMicros;
    }

    const remainderTasks = tasksToAllocate.filter(
      (item) => !reservedItems.has(item),
    );
    if (remainderTasks.length === 1) {
      const onlyRemainderTask = remainderTasks[0];
      if (onlyRemainderTask) {
        allocations.set(
          onlyRemainderTask,
          (allocations.get(onlyRemainderTask) ?? 0) + remainingMicros,
        );
      }
      remainingMicros = 0;
    } else if (remainderTasks.length > 1) {
      const weightedTasks = remainderTasks
        .map((item) => ({ item, weight: taskTokenWeight(item) }))
        .filter(({ weight }) => Number.isFinite(weight) && weight > 0);
      const totalWeight = weightedTasks.reduce(
        (sum, candidate) => sum + candidate.weight,
        0,
      );
      if (totalWeight > 0 && Number.isFinite(totalWeight)) {
        const remainderPoolMicros = remainingMicros;
        weightedTasks.forEach((candidate, index) => {
          const shareMicros =
            index === weightedTasks.length - 1
              ? remainingMicros
              : Math.min(
                  remainingMicros,
                  Math.round(
                    (remainderPoolMicros * candidate.weight) / totalWeight,
                  ),
                );
          const existing = allocations.get(candidate.item) ?? 0;
          allocations.set(candidate.item, existing + shareMicros);
          remainingMicros -= shareMicros;
        });
      }
    }
  }

  return items.map((item) => {
    const amountMicros = allocations.get(item);
    if (amountMicros === undefined) return item;
    return {
      ...item,
      usd: amountMicros / MICRO_USD,
      costStatus: turn.status === 'partial' ? 'partial' : 'estimated',
    };
  });
}

function tokensLeftAfter(
  total: CostTokenTotals,
  used: CostTokenTotals,
): CostTokenTotals {
  return {
    input: Math.max(0, total.input - used.input),
    output: Math.max(0, total.output - used.output),
    cacheReadInputTokens: Math.max(
      0,
      total.cacheReadInputTokens - used.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: Math.max(
      0,
      total.cacheCreationInputTokens - used.cacheCreationInputTokens,
    ),
    reasoningOutputTokens: 0,
  };
}

const MICRO_USD = 1e6;

/**
 * Give each included subagent that reported no cost of its own an estimated
 * share of its turn's cost. A provider reports one cost for the turn and
 * tokens per subagent, so the turn is split by price-weighted tokens between
 * the turn's own work and those subagents; the shares never exceed the turn.
 * A turn with no price, and a subagent whose cost comes on top of its turn,
 * are left as they are.
 */
function withEstimatedIncludedShares(
  items: readonly CostAttributedItem[],
  turn: {
    readonly costUsd: number | undefined;
    readonly tokens: CostTokenTotals;
    readonly model: string | undefined;
  },
): readonly CostAttributedItem[] {
  const included = items.filter((item) => item.inclusion === 'included');
  const unpriced = included.filter((item) => item.usd === undefined);
  if (turn.costUsd === undefined || unpriced.length === 0) return items;

  const reportedUsd = included.reduce((sum, item) => sum + (item.usd ?? 0), 0);
  const pool = Math.max(0, turn.costUsd - reportedUsd);
  // The turn's own tokens are what its included subagents did not use.
  const ownTokens = included.reduce(
    (left, item) => tokensLeftAfter(left, item.tokens),
    turn.tokens,
  );
  // Families are compared only when the turn's own model is a known one.
  const turnTier = modelPriceTier(turn.model);
  const weightOf = (
    tokens: CostTokenTotals,
    model: string | undefined,
  ): number =>
    priceWeightedTokens(tokens) *
    (turnTier === undefined ? 1 : (modelPriceTier(model) ?? turnTier));
  const ownWeight = weightOf(ownTokens, turn.model);
  const weights = new Map(
    unpriced.map((item) => [item.id, weightOf(item.tokens, item.model)]),
  );
  const totalWeight =
    ownWeight +
    unpriced.reduce((sum, item) => sum + (weights.get(item.id) ?? 0), 0);
  if (pool === 0 || totalWeight === 0) return items;

  // Shares are whole micro-dollars drawn from the pool, so rounding can never
  // make them add up to more than the turn.
  let remainingMicros = Math.floor(pool * MICRO_USD + 1e-6);
  return items.map((item) => {
    const weight = weights.get(item.id);
    if (item.inclusion !== 'included' || item.usd !== undefined) return item;
    if (weight === undefined) return item;
    const shareMicros = Math.min(
      Math.round((pool * weight * MICRO_USD) / totalWeight),
      remainingMicros,
    );
    remainingMicros -= shareMicros;
    return {
      ...item,
      usd: shareMicros / MICRO_USD,
      costStatus: 'estimated',
    };
  });
}

function subagentItems(
  entry: AgentAuditEntry,
  basis: CostBillingBasis,
  price: ReturnType<typeof observedCost>,
  usageRows: readonly ModelUsageRow[],
  proxyAccounts: readonly CostProxyAccountRef[] | undefined,
): readonly CostAttributedItem[] | undefined {
  if (!entry.subagents || entry.subagents.length === 0) return undefined;

  const items = entry.subagents
    .flatMap((subagent) => {
      const id = safeOpaqueId(subagent.id);
      return id ? [{ subagent, id }] : [];
    })
    .map(({ subagent, id }): CostAttributedItem => {
      const costUsd = isNeverPriced(basis)
        ? undefined
        : finiteNonNegative(subagent.costUsd);
      const codexEstimate = isCodexSubagent(subagent);
      const tokens = tokenTotals(subagent.tokens, codexEstimate);
      const totalTokens =
        subagent.kind === 'claude_task' &&
        tokens.input === 0 &&
        tokens.output === 0 &&
        tokens.cacheReadInputTokens === 0 &&
        tokens.cacheCreationInputTokens === 0
          ? finiteNonNegative(subagent.totalTokens)
          : undefined;
      const costStatus: CostStatus =
        costUsd === undefined
          ? 'not_priced'
          : entry.observedCost?.status === 'partially_priced'
            ? 'partial'
            : codexEstimate
              ? 'estimated'
              : 'reported';

      return {
        id,
        kind: subagent.kind,
        label: safeLabel(
          subagent.label,
          subagent.kind === 'claude_task' ? 'Claude task' : 'Codex agent',
        ),
        ...(safeModel(subagent.model)
          ? { model: safeModel(subagent.model) }
          : {}),
        billingBasis: basis,
        tokens,
        ...(totalTokens === undefined ? {} : { totalTokens }),
        ...(costUsd === undefined ? {} : { usd: costUsd }),
        costStatus,
        inclusion: subagent.inclusion,
        // The turn's cost arrives when it ends; until then a subagent has no
        // share to show, which is different from never being priced.
        ...(entry.status === 'running' ? { status: 'running' as const } : {}),
        // A subagent in the turn's process sends its requests on the turn's
        // route, so it was served by the turn's accounts.
        ...(proxyAccounts ? { proxyAccounts } : {}),
      };
    })
    .sort(
      (left, right) =>
        left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind),
    );

  if (items.length === 0) return undefined;
  if (entry.provider === 'claude' && entry.modelUsage !== undefined) {
    return withModelUsageIncludedShares(
      items,
      entry,
      { costUsd: price.costUsd, status: price.costStatus },
      usageRows,
    );
  }
  return withEstimatedIncludedShares(items, {
    costUsd: price.costUsd,
    tokens: tokenTotals(entry.tokens ?? EMPTY_TOKENS, isCodexEntry(entry)),
    model: safeModel(entry.model),
  });
}

function sanitizedContext(
  context: AgentAuditEntry['context'],
): AgentAuditEntry['context'] {
  if (!context) return undefined;
  const endTokens = finiteNonNegative(context.endTokens);
  const windowTokens = finiteNonNegative(context.windowTokens);
  if (
    endTokens === undefined ||
    windowTokens === undefined ||
    windowTokens <= 0
  ) {
    return undefined;
  }
  const peakTokens = finiteNonNegative(context.peakTokens);
  const categories = context.categories?.filter(
    (category) =>
      category.name.trim().length > 0 &&
      !category.name.includes('/') &&
      !category.name.includes('\\') &&
      !hasControlCharacters(category.name) &&
      finiteNonNegative(category.tokens) !== undefined &&
      ['used', 'free', 'buffer', 'deferred'].some(
        (kind) => kind === category.kind,
      ),
  );
  return {
    endTokens,
    windowTokens,
    ...(peakTokens === undefined ? {} : { peakTokens }),
    ...(categories && categories.length > 0
      ? {
          categories: categories.map((category) => ({
            name: category.name.slice(0, 80),
            tokens: finiteNonNegative(category.tokens) ?? 0,
            kind: category.kind,
          })),
        }
      : {}),
  };
}

function sanitizedCompactions(
  compactions: AgentAuditEntry['compactions'],
): AgentAuditEntry['compactions'] {
  if (!compactions || compactions.length === 0) return undefined;
  const result = compactions.flatMap((compaction) => {
    const at = normalizedTimestamp(compaction.at);
    if (!at) return [];
    const trigger = ['auto', 'manual', 'unknown'].some(
      (candidate) => candidate === compaction.trigger,
    )
      ? compaction.trigger
      : 'unknown';
    return [
      {
        at,
        trigger,
        ...(finiteNonNegative(compaction.preTokens) === undefined
          ? {}
          : { preTokens: finiteNonNegative(compaction.preTokens) }),
      },
    ];
  });
  return result.length > 0 ? result : undefined;
}

function pipelineRecord(
  entry: AgentAuditEntry,
): CostTurnRecord['pipeline'] | undefined {
  const executionId = safeOpaqueId(
    entry.delegation?.parentPipelineExecutionId ?? entry.pipelineExecutionId,
  );
  if (!executionId) return undefined;
  const rootExecutionId =
    safeOpaqueId(entry.rootPipelineExecutionId) ?? executionId;
  return {
    rootExecutionId,
    executionId,
    ...(entry.pipelineName?.trim()
      ? { pipelineName: safeLabel(entry.pipelineName, 'Pipeline') }
      : {}),
    ...(safeOpaqueId(entry.jobId) ? { jobId: safeOpaqueId(entry.jobId) } : {}),
    ...(safeOpaqueId(entry.stepId)
      ? { stepId: safeOpaqueId(entry.stepId) }
      : {}),
    ...(finiteNonNegative(entry.attempt) === undefined
      ? {}
      : { attempt: finiteNonNegative(entry.attempt) }),
  };
}

function delegationItem(
  entry: AgentAuditEntry,
  basis: CostBillingBasis,
  price: ReturnType<typeof observedCost>,
  entryId: string,
  proxyAccounts: readonly CostProxyAccountRef[] | undefined,
): CostAttributedItem {
  const delegation = entry.delegation;
  const status = price.costUsd === undefined ? 'not_priced' : price.costStatus;
  return {
    id: safeOpaqueId(delegation?.delegationId) ?? entryId,
    kind: 'delegation',
    label: safeLabel(delegation?.label, 'Delegation'),
    ...(safeModel(entry.model) ? { model: safeModel(entry.model) } : {}),
    ...(delegation?.harness?.trim()
      ? { harness: delegation.harness.trim().slice(0, 80) }
      : {}),
    billingBasis: basis,
    tokens: tokenTotals(entry.tokens, isCodexEntry(entry)),
    ...(price.costUsd === undefined ? {} : { usd: price.costUsd }),
    costStatus: status,
    inclusion: 'additional',
    runCount: 1,
    status:
      entry.status === 'running'
        ? 'running'
        : entry.status === 'success'
          ? 'completed'
          : entry.status === 'cancelled'
            ? 'cancelled'
            : 'failed',
    ...(proxyAccounts ? { proxyAccounts } : {}),
  };
}

function sourceForEvent(
  eventType: AgentAuditEventType,
): CostTurnRecord['source'] | null {
  switch (eventType) {
    case 'worktree_chat':
    case 'standalone_chat':
    case 'app_advisor':
    case 'worktree_plan_chat':
      return 'chat';
    case 'pipeline_agent_turn':
      return 'pipeline';
    case 'managed_delegation':
      return 'delegation';
    default:
      return HELPER_KIND_BY_EVENT[eventType] ? 'background' : null;
  }
}

/**
 * Project one audit line into the content-free cost-index shape. Synthetic
 * chat/runtime scopes are deliberately ignored; only navigable worktree and
 * Work Entry identities (plus App Advisor Work Entries) are admitted.
 */
export function classifyAuditEntry(
  auditEntry: AgentAuditEntry,
): CostTurnRecord | null {
  const entryId = safeAuditEntryId(auditEntry.id);
  if (!hasRealScope(auditEntry) || !entryId) return null;

  const identity = observedModelIdentity(auditEntry);
  const entry =
    identity.model === auditEntry.model
      ? auditEntry
      : { ...auditEntry, model: identity.model };
  const agentId = safeOpaqueId(identity.agentId);

  const startedAt = normalizedTimestamp(entry.startedAt);
  if (!startedAt) return null;
  const source = sourceForEvent(entry.eventType);
  if (!source) return null;

  const timestamp = Date.parse(startedAt);
  const day = new Date(timestamp).toISOString().slice(0, 10);
  const basis = billingBasis(entry);
  const price = observedCost(entry, basis, isCodexEntry(entry));
  if (isEmptySuccessfulBackground(entry, source)) return null;
  const pipeline = pipelineRecord(entry);

  const chatId = safeOpaqueId(
    source === 'delegation'
      ? (entry.delegation?.parentChatId ?? entry.chatId)
      : entry.chatId,
  );
  if (source === 'chat' && !chatId) return null;
  if (source === 'pipeline' && !pipeline) return null;
  if (entry.eventType === 'pipeline_advisor' && !pipeline) {
    return null;
  }

  const helperKind = HELPER_KIND_BY_EVENT[entry.eventType];
  const accountProxy = sanitizedAccountProxy(entry, basis);
  const proxyAccounts = proxyAccountRefs(accountProxy);
  const hasModelUsage =
    entry.provider === 'claude' && entry.modelUsage !== undefined;
  const usageRows = hasModelUsage ? modelUsageRows(entry.modelUsage) : [];
  const subagents = subagentItems(
    entry,
    basis,
    price,
    usageRows,
    proxyAccounts,
  );
  const compactions = sanitizedCompactions(entry.compactions);
  const context = sanitizedContext(entry.context);
  const planEvents = entry.planEvents
    ? {
        created: finiteNonNegative(entry.planEvents.created) ?? 0,
        approved: finiteNonNegative(entry.planEvents.approved) ?? 0,
      }
    : undefined;
  const safeToolUseCount = finiteNonNegative(entry.toolUseCount);
  const safeSubagentCount = finiteNonNegative(entry.subAgentCount);
  const durationMs = finiteNonNegative(entry.durationMs);
  const delegation =
    source === 'delegation'
      ? delegationItem(entry, basis, price, entryId, proxyAccounts)
      : undefined;

  return {
    entryId,
    day,
    startedAt,
    ...(normalizedTimestamp(entry.completedAt)
      ? { completedAt: normalizedTimestamp(entry.completedAt) }
      : {}),
    status: entry.status,
    source,
    ...(chatId ? { chatId } : {}),
    ...(helperKind ? { helperKind } : {}),
    ...(pipeline ? { pipeline } : {}),
    provider: entry.provider,
    ...(agentId ? { agentId } : {}),
    ...(safeModel(entry.model) ? { model: safeModel(entry.model) } : {}),
    ...(entry.executionHarness ? { harness: entry.executionHarness } : {}),
    billingBasis: basis,
    tokens: hasModelUsage
      ? aggregateModelUsageTokens(usageRows)
      : tokenTotals(entry.tokens ?? EMPTY_TOKENS, isCodexEntry(entry)),
    ...(price.costUsd === undefined ? {} : { costUsd: price.costUsd }),
    costStatus: price.costStatus,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(entry.toolCounts ? { toolCounts: { ...entry.toolCounts } } : {}),
    ...(safeSubagentCount === undefined
      ? {}
      : { subagentCount: safeSubagentCount }),
    ...(safeToolUseCount === undefined
      ? {}
      : { toolUseCount: safeToolUseCount }),
    ...(subagents ? { subagents } : {}),
    ...(delegation ? { delegation } : {}),
    ...(context ? { context } : {}),
    ...(compactions ? { compactions } : {}),
    ...(planEvents ? { planEvents } : {}),
    ...(accountProxy ? { accountProxy } : {}),
  };
}
