import { observedModelIdentity } from './audit-records';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import type {
  AgentAuditAccountProxyAccount,
  AgentAuditAccountProxyUsage,
  AgentAuditCompaction,
  AgentAuditContextCategory,
  AgentAuditContextUsage,
  AgentAuditDelegationLineage,
  AgentAuditEntry,
  AgentAuditModelUsage,
  AgentAuditStatus,
  AgentAuditInterfaceToolCall,
  AgentAuditSubagentUsage,
  AgentAuditTokenTotals,
  AgentAuditToolCounts,
  AgentObservedCost,
  AgentObservedCostComponent,
} from '@canopy/protocol/observability';
import {
  parseAgentAuditBillingBasis,
  parseAgentAuditEventType,
} from '@canopy/protocol/observability';

type AgentObservedCostReason = AgentObservedCost['reason'];

/**
 * Every observed-cost reason, mapped to itself. The exhaustive `Record` makes a
 * new reason a compile error here instead of a persisted cost that silently
 * disappears on reload.
 */
const OBSERVED_COST_REASON_VALUES: Record<
  AgentObservedCostReason,
  AgentObservedCostReason
> = {
  priced: 'priced',
  model_not_priced: 'model_not_priced',
  billable_tool_pricing_unavailable: 'billable_tool_pricing_unavailable',
  pricing_unavailable: 'pricing_unavailable',
  model_missing: 'model_missing',
  unsupported_fast_pricing: 'unsupported_fast_pricing',
  unsupported_service_tier: 'unsupported_service_tier',
  unsupported_usage_shape: 'unsupported_usage_shape',
  invalid_pricing_payload: 'invalid_pricing_payload',
};

/** A `Map` so inherited `Object.prototype` keys never parse as reasons. */
const OBSERVED_COST_REASON_LOOKUP: ReadonlyMap<
  string,
  AgentObservedCostReason
> = new Map(
  Object.values(OBSERVED_COST_REASON_VALUES).map((reason) => [reason, reason]),
);

function parseObservedCostReason(
  value: string | undefined,
): AgentObservedCostReason | undefined {
  return value === undefined
    ? undefined
    : OBSERVED_COST_REASON_LOOKUP.get(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function parseAuditStatus(value: string): AgentAuditStatus | null {
  switch (value) {
    case 'running':
    case 'success':
    case 'failure':
    case 'cancelled':
    case 'interrupted':
      return value;
    default:
      return null;
  }
}

function createParsedToolCounts(
  record: Record<string, unknown>,
): AgentAuditToolCounts {
  return {
    thinking: readNumber(record, 'thinking') ?? 0,
    bash: readNumber(record, 'bash') ?? 0,
    read: readNumber(record, 'read') ?? 0,
    readLines: readNumber(record, 'readLines') ?? 0,
    writeEdit: readNumber(record, 'writeEdit') ?? 0,
    plan: readNumber(record, 'plan') ?? 0,
    fileEdit: readNumber(record, 'fileEdit') ?? 0,
    fileAdd: readNumber(record, 'fileAdd') ?? 0,
    fileDelete: readNumber(record, 'fileDelete') ?? 0,
    search: readNumber(record, 'search') ?? 0,
    grep: readNumber(record, 'grep') ?? 0,
    web: readNumber(record, 'web') ?? 0,
    agent: readNumber(record, 'agent') ?? 0,
    workflow: readNumber(record, 'workflow') ?? 0,
    tasks: readNumber(record, 'tasks') ?? 0,
    taskStop: readNumber(record, 'taskStop') ?? 0,
    skills: readNumber(record, 'skills') ?? 0,
    monitor: readNumber(record, 'monitor') ?? 0,
    claude: readNumber(record, 'claude') ?? 0,
    scheduleWakeup: readNumber(record, 'scheduleWakeup') ?? 0,
    askUser: readNumber(record, 'askUser') ?? 0,
    scriptOutput: readNumber(record, 'scriptOutput') ?? 0,
    watcher: readNumber(record, 'watcher') ?? 0,
    canopy: readNumber(record, 'canopy') ?? 0,
    graph: readNumber(record, 'graph') ?? 0,
    appAdvisor: readNumber(record, 'appAdvisor') ?? 0,
    pipelineEditor: readNumber(record, 'pipelineEditor') ?? 0,
    mcp: readNumber(record, 'mcp') ?? 0,
    other: readNumber(record, 'other') ?? 0,
  };
}

function readOptionalStringField(
  value: Record<string, unknown>,
  key: string,
  apply: (text: string) => void,
): void {
  const text = readString(value, key);
  if (text) {
    apply(text);
  }
}

function readOptionalNumberField(
  value: Record<string, unknown>,
  key: string,
  apply: (numberValue: number) => void,
): void {
  const numberValue = readNumber(value, key);
  if (typeof numberValue === 'number') {
    apply(numberValue);
  }
}

function parseObservedCostComponent(
  value: unknown,
): AgentObservedCostComponent | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = readString(value, 'kind');
  const label = readString(value, 'label');
  if (
    !label ||
    (kind !== 'tokens' &&
      kind !== 'web_search_call' &&
      kind !== 'unpriced_tokens' &&
      kind !== 'unpriced_tool')
  ) {
    return null;
  }
  const component: AgentObservedCostComponent = { kind, label };
  const quantity = readNumber(value, 'quantity');
  if (typeof quantity === 'number') {
    component.quantity = quantity;
  }
  const unit = readString(value, 'unit');
  if (unit === 'tokens' || unit === 'calls') {
    component.unit = unit;
  }
  const usd = readNumber(value, 'usd');
  if (typeof usd === 'number') {
    component.usd = usd;
  }
  const reason = parseObservedCostReason(readString(value, 'reason'));
  if (reason !== undefined) {
    component.reason = reason;
  }
  return component;
}

export function parseObservedCost(
  value: unknown,
): AgentObservedCost | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const status = readString(value, 'status');
  const reason = parseObservedCostReason(readString(value, 'reason'));
  if (
    (status !== 'priced' &&
      status !== 'partially_priced' &&
      status !== 'unpriced') ||
    reason === undefined
  ) {
    return undefined;
  }
  const observedCost: AgentObservedCost = {
    status,
    reason,
    currency: 'usd',
    components: Array.isArray(value.components)
      ? value.components
          .map(parseObservedCostComponent)
          .filter(
            (component): component is AgentObservedCostComponent =>
              component !== null,
          )
      : [],
  };
  readOptionalNumberField(value, 'totalUsd', (totalUsd) => {
    observedCost.totalUsd = totalUsd;
  });
  readOptionalNumberField(value, 'tokenUsd', (tokenUsd) => {
    observedCost.tokenUsd = tokenUsd;
  });
  readOptionalNumberField(value, 'nonTokenUsd', (nonTokenUsd) => {
    observedCost.nonTokenUsd = nonTokenUsd;
  });
  readOptionalStringField(value, 'model', (model) => {
    observedCost.model = model;
  });
  readOptionalStringField(value, 'serviceTier', (serviceTier) => {
    observedCost.serviceTier = serviceTier;
  });
  const canonicalServiceTier = readString(value, 'canonicalServiceTier');
  if (canonicalServiceTier === 'standard' || canonicalServiceTier === 'fast') {
    observedCost.canonicalServiceTier = canonicalServiceTier;
  }
  const contextTier = readString(value, 'contextTier');
  if (
    contextTier === 'standard' ||
    contextTier === 'long' ||
    contextTier === 'unknown'
  ) {
    observedCost.contextTier = contextTier;
  }
  const contextTierSource = readString(value, 'contextTierSource');
  if (
    contextTierSource === 'pricing_payload_threshold' ||
    contextTierSource === 'not_applicable' ||
    contextTierSource === 'unknown'
  ) {
    observedCost.contextTierSource = contextTierSource;
  }
  const pricingBasis = readString(value, 'pricingBasis');
  if (
    pricingBasis === 'openai_api_standard' ||
    pricingBasis === 'codex_credit_adjusted_standard_equivalent'
  ) {
    observedCost.pricingBasis = pricingBasis;
  }
  const longContextApplied = readBoolean(value, 'longContextApplied');
  if (typeof longContextApplied === 'boolean') {
    observedCost.longContextApplied = longContextApplied;
  }
  readOptionalNumberField(
    value,
    'fastModeMultiplierApplied',
    (fastModeMultiplierApplied) => {
      observedCost.fastModeMultiplierApplied = fastModeMultiplierApplied;
    },
  );
  if (isRecord(value.pricingSource)) {
    const sourceType = readString(value.pricingSource, 'type');
    if (sourceType === 'canopy_openai_pricing') {
      observedCost.pricingSource = { type: sourceType };
      readOptionalStringField(value.pricingSource, 'fetchedAt', (fetchedAt) => {
        observedCost.pricingSource = {
          ...observedCost.pricingSource,
          type: sourceType,
          fetchedAt,
        };
      });
      readOptionalStringField(
        value.pricingSource,
        'pricingUrl',
        (pricingUrl) => {
          observedCost.pricingSource = {
            ...observedCost.pricingSource,
            type: sourceType,
            pricingUrl,
          };
        },
      );
      readOptionalStringField(
        value.pricingSource,
        'codexPricingUrl',
        (codexPricingUrl) => {
          observedCost.pricingSource = {
            ...observedCost.pricingSource,
            type: sourceType,
            codexPricingUrl,
          };
        },
      );
      readOptionalStringField(
        value.pricingSource,
        'codexSpeedUrl',
        (codexSpeedUrl) => {
          observedCost.pricingSource = {
            ...observedCost.pricingSource,
            type: sourceType,
            codexSpeedUrl,
          };
        },
      );
    }
  }
  return observedCost;
}

function normalizeAuditLinkTarget(
  value: Record<string, unknown>,
): AgentAuditEntry['linkTarget'] {
  if (!isRecord(value.linkTarget)) {
    return undefined;
  }

  const linkKind = readString(value.linkTarget, 'kind');
  const linkPage = readString(value.linkTarget, 'page');
  const validKind =
    linkKind === 'worktree-chat' ||
    linkKind === 'app-advisor' ||
    linkKind === 'standalone-chat' ||
    linkKind === 'pipeline-editor' ||
    linkKind === 'pipeline-execution';
  const validPage =
    linkPage === 'main' ||
    linkPage === 'chat' ||
    linkPage === 'pipelines' ||
    linkPage === 'audit' ||
    linkPage === 'usage';
  if (!validKind || !validPage || !linkKind || !linkPage) {
    return undefined;
  }

  const linkTarget: AgentAuditEntry['linkTarget'] = {
    kind: linkKind,
    page: linkPage,
  };
  readOptionalStringField(value.linkTarget, 'projectId', (projectId) => {
    linkTarget.projectId = projectId;
  });
  readOptionalStringField(value.linkTarget, 'worktreeId', (worktreeId) => {
    linkTarget.worktreeId = worktreeId;
  });
  readOptionalStringField(value.linkTarget, 'planId', (planId) => {
    linkTarget.planId = planId;
  });
  readOptionalStringField(value.linkTarget, 'chatId', (chatId) => {
    linkTarget.chatId = chatId;
  });
  readOptionalStringField(
    value.linkTarget,
    'pipelineExecutionId',
    (pipelineExecutionId) => {
      linkTarget.pipelineExecutionId = pipelineExecutionId;
    },
  );

  return linkTarget;
}

function parseTokenTotals(
  record: Record<string, unknown>,
): AgentAuditTokenTotals {
  return {
    input: readNumber(record, 'input') ?? 0,
    output: readNumber(record, 'output') ?? 0,
    cacheReadInputTokens: readNumber(record, 'cacheReadInputTokens') ?? 0,
    cacheCreationInputTokens:
      readNumber(record, 'cacheCreationInputTokens') ?? 0,
    reasoningOutputTokens: readNumber(record, 'reasoningOutputTokens') ?? 0,
  };
}

/** Longer breakdowns are cut here; providers report about a dozen. */
const MAX_CONTEXT_CATEGORIES = 24;

function parseContextCategories(value: unknown): AgentAuditContextCategory[] {
  if (!Array.isArray(value)) return [];
  const categories: AgentAuditContextCategory[] = [];
  for (const item of value) {
    if (categories.length >= MAX_CONTEXT_CATEGORIES) break;
    if (!isRecord(item)) continue;
    const name = readString(item, 'name');
    const tokens = readNumber(item, 'tokens');
    const kind = readString(item, 'kind');
    if (name === undefined || tokens === undefined) continue;
    if (
      kind !== 'used' &&
      kind !== 'free' &&
      kind !== 'buffer' &&
      kind !== 'deferred'
    ) {
      continue;
    }
    categories.push({ name, tokens, kind });
  }
  return categories;
}

function parseContextUsage(value: unknown): AgentAuditContextUsage | undefined {
  if (!isRecord(value)) return undefined;
  const endTokens = readNumber(value, 'endTokens');
  const windowTokens = readNumber(value, 'windowTokens');
  if (endTokens === undefined || windowTokens === undefined) return undefined;
  const peakTokens = readNumber(value, 'peakTokens');
  const categories = parseContextCategories(value.categories);
  return {
    endTokens,
    windowTokens,
    ...(peakTokens !== undefined ? { peakTokens } : {}),
    ...(categories.length > 0 ? { categories } : {}),
  };
}

function parseCompactions(value: unknown): AgentAuditCompaction[] {
  if (!Array.isArray(value)) return [];
  const compactions: AgentAuditCompaction[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const at = readString(item, 'at');
    if (at === undefined) continue;
    const trigger = readString(item, 'trigger');
    const preTokens = readNumber(item, 'preTokens');
    compactions.push({
      at,
      trigger: trigger === 'auto' || trigger === 'manual' ? trigger : 'unknown',
      ...(preTokens !== undefined ? { preTokens } : {}),
    });
  }
  return compactions;
}

function parseInterfaceToolCalls(
  value: unknown,
): AgentAuditInterfaceToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: AgentAuditInterfaceToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const callId = readString(item, 'callId');
    const toolName = readString(item, 'toolName');
    const leaseId = readString(item, 'leaseId');
    const surface = readString(item, 'surface');
    const interfaceKind = readString(item, 'interfaceKind');
    const outcome = readString(item, 'outcome');
    const deliveredAt = readString(item, 'deliveredAt');
    const settledAt = readString(item, 'settledAt');
    if (
      callId === undefined ||
      toolName === undefined ||
      leaseId === undefined ||
      surface === undefined ||
      interfaceKind === undefined ||
      outcome === undefined ||
      deliveredAt === undefined ||
      settledAt === undefined
    )
      continue;
    const audience = readString(item, 'audience');
    calls.push({
      callId,
      toolName,
      leaseId,
      surface,
      interfaceKind,
      ...(audience !== undefined ? { audience } : {}),
      outcome,
      deliveredAt,
      settledAt,
    });
  }
  return calls;
}

function parseSubagents(value: unknown): AgentAuditSubagentUsage[] {
  if (!Array.isArray(value)) return [];
  const subagents: AgentAuditSubagentUsage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = readString(item, 'id');
    const kind = readString(item, 'kind');
    const inclusion = readString(item, 'inclusion');
    if (id === undefined) continue;
    if (kind !== 'claude_task' && kind !== 'codex_agent') continue;
    if (inclusion !== 'included' && inclusion !== 'additional') continue;
    const label = readString(item, 'label');
    const model = readString(item, 'model');
    const costUsd = readNumber(item, 'costUsd');
    const totalTokens = readNumber(item, 'totalTokens');
    subagents.push({
      id,
      kind,
      ...(label !== undefined ? { label } : {}),
      ...(model !== undefined ? { model } : {}),
      tokens: parseTokenTotals(isRecord(item.tokens) ? item.tokens : {}),
      ...(totalTokens !== undefined && totalTokens >= 0 ? { totalTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      inclusion,
    });
  }
  return subagents;
}

function parseModelUsage(value: unknown): AgentAuditModelUsage[] {
  if (!Array.isArray(value)) return [];
  const rows: AgentAuditModelUsage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const model = readString(item, 'model');
    const costUsd = readNumber(item, 'costUsd');
    if (model === undefined || costUsd === undefined || costUsd < 0) continue;
    const count = (key: string): number =>
      Math.max(0, readNumber(item, key) ?? 0);
    const webSearchRequests = readNumber(item, 'webSearchRequests');
    const costBasis = readString(item, 'costBasis');
    rows.push({
      model,
      inputTokens: count('inputTokens'),
      outputTokens: count('outputTokens'),
      cacheReadInputTokens: count('cacheReadInputTokens'),
      cacheCreationInputTokens: count('cacheCreationInputTokens'),
      ...(webSearchRequests !== undefined && webSearchRequests >= 0
        ? { webSearchRequests }
        : {}),
      costUsd,
      ...(costBasis === 'list' ||
      costBasis === 'managed' ||
      costBasis === 'unknown'
        ? { costBasis }
        : {}),
    });
  }
  return rows;
}

/** At most this many accounts per entry; see `account-proxy-usage.ts`. */
const MAX_PARSED_ACCOUNT_PROXY_ACCOUNTS = 16;

function parseAccountProxyUsage(
  value: unknown,
): AgentAuditAccountProxyUsage | undefined {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return undefined;
  const connectionId = readString(value, 'connectionId');
  if (connectionId === undefined || connectionId.length === 0) return undefined;
  const accounts: AgentAuditAccountProxyAccount[] = [];
  const seen = new Set<string>();
  for (const item of value.accounts) {
    if (accounts.length >= MAX_PARSED_ACCOUNT_PROXY_ACCOUNTS) break;
    if (!isRecord(item)) continue;
    const authIndex = readString(item, 'authIndex');
    const requests = readNumber(item, 'requests');
    if (authIndex === undefined || authIndex.length === 0) continue;
    if (seen.has(authIndex)) continue;
    if (requests === undefined || !Number.isInteger(requests) || requests < 1)
      continue;
    seen.add(authIndex);
    const label = readString(item, 'label');
    const provider = readString(item, 'provider');
    accounts.push({
      authIndex,
      ...(label !== undefined ? { label } : {}),
      ...(provider !== undefined ? { provider } : {}),
      requests,
    });
  }
  return accounts.length > 0 ? { connectionId, accounts } : undefined;
}

function parseDelegationLineage(
  value: unknown,
): AgentAuditDelegationLineage | undefined {
  if (!isRecord(value)) return undefined;
  const delegationId = readString(value, 'delegationId');
  const runGeneration = readNumber(value, 'runGeneration');
  if (delegationId === undefined || runGeneration === undefined) {
    return undefined;
  }
  const lineage: AgentAuditDelegationLineage = { delegationId, runGeneration };
  readOptionalStringField(value, 'parentChatId', (parentChatId) => {
    lineage.parentChatId = parentChatId;
  });
  readOptionalStringField(
    value,
    'parentUserMessageId',
    (parentUserMessageId) => {
      lineage.parentUserMessageId = parentUserMessageId;
    },
  );
  readOptionalStringField(value, 'parentDelegationId', (parentDelegationId) => {
    lineage.parentDelegationId = parentDelegationId;
  });
  readOptionalStringField(
    value,
    'parentPipelineExecutionId',
    (parentPipelineExecutionId) => {
      lineage.parentPipelineExecutionId = parentPipelineExecutionId;
    },
  );
  readOptionalStringField(value, 'harness', (harness) => {
    lineage.harness = harness;
  });
  readOptionalStringField(value, 'label', (label) => {
    lineage.label = label;
  });
  return lineage;
}

export function normalizeAuditEntry(value: unknown): AgentAuditEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value, 'id');
  const eventTypeRaw = readString(value, 'eventType');
  const statusRaw = readString(value, 'status');
  const provider = readString(value, 'provider');
  const label = readString(value, 'label');
  const startedAt = readString(value, 'startedAt');
  const tokensRecord = isRecord(value.tokens) ? value.tokens : null;
  const toolCountsRecord = isRecord(value.toolCounts) ? value.toolCounts : null;
  const eventType = eventTypeRaw
    ? parseAgentAuditEventType(eventTypeRaw)
    : null;
  const status = statusRaw ? parseAuditStatus(statusRaw) : null;

  if (
    !id ||
    eventType === null ||
    status === null ||
    !provider ||
    !label ||
    !startedAt ||
    !tokensRecord ||
    !toolCountsRecord
  ) {
    return null;
  }

  if (
    provider !== 'claude' &&
    provider !== 'codex' &&
    provider !== 'ollama' &&
    provider !== 'cursor' &&
    provider !== 'antigravity' &&
    provider !== 'opencode'
  ) {
    return null;
  }

  const entry: AgentAuditEntry = {
    id,
    eventType,
    status,
    provider,
    label,
    startedAt,
    tokens: {
      input: readNumber(tokensRecord, 'input') ?? 0,
      output: readNumber(tokensRecord, 'output') ?? 0,
      cacheReadInputTokens:
        readNumber(tokensRecord, 'cacheReadInputTokens') ?? 0,
      cacheCreationInputTokens:
        readNumber(tokensRecord, 'cacheCreationInputTokens') ?? 0,
      reasoningOutputTokens:
        readNumber(tokensRecord, 'reasoningOutputTokens') ?? 0,
    },
    messageCount: readNumber(value, 'messageCount') ?? 0,
    assistantMessageCount: readNumber(value, 'assistantMessageCount') ?? 0,
    toolUseCount: readNumber(value, 'toolUseCount') ?? 0,
    subAgentCount: readNumber(value, 'subAgentCount') ?? 0,
    hasTranscript: readBoolean(value, 'hasTranscript') ?? false,
    toolCounts: createParsedToolCounts(toolCountsRecord),
  };

  readOptionalStringField(value, 'completedAt', (completedAt) => {
    entry.completedAt = completedAt;
  });
  readOptionalStringField(value, 'model', (model) => {
    entry.model = model;
  });
  readOptionalStringField(value, 'requestedModel', (requestedModel) => {
    entry.requestedModel = requestedModel;
  });
  if (
    entry.requestedModel === undefined &&
    entry.model &&
    parseAgentRouteModelId(entry.model)
  ) {
    entry.requestedModel = entry.model;
  }
  Object.assign(
    entry,
    observedModelIdentity({
      model: entry.model,
      requestedModel: entry.requestedModel,
      agentId: readString(value, 'agentId'),
    }),
  );
  readOptionalStringField(value, 'serviceTier', (serviceTier) => {
    entry.serviceTier = serviceTier;
  });
  readOptionalStringField(value, 'error', (error) => {
    entry.error = error;
  });
  readOptionalStringField(value, 'projectId', (projectId) => {
    entry.projectId = projectId;
  });
  readOptionalStringField(value, 'worktreeId', (worktreeId) => {
    entry.worktreeId = worktreeId;
  });
  readOptionalStringField(value, 'repoId', (repoId) => {
    entry.repoId = repoId;
  });
  readOptionalStringField(value, 'repoLabel', (repoLabel) => {
    entry.repoLabel = repoLabel;
  });
  readOptionalStringField(value, 'chatId', (chatId) => {
    entry.chatId = chatId;
  });
  readOptionalStringField(value, 'userMessageId', (userMessageId) => {
    entry.userMessageId = userMessageId;
  });
  readOptionalStringField(value, 'sdkSessionId', (sdkSessionId) => {
    entry.sdkSessionId = sdkSessionId;
  });
  readOptionalStringField(value, 'pipelineId', (pipelineId) => {
    entry.pipelineId = pipelineId;
  });
  readOptionalStringField(value, 'pipelineName', (pipelineName) => {
    entry.pipelineName = pipelineName;
  });
  readOptionalStringField(
    value,
    'pipelineExecutionId',
    (pipelineExecutionId) => {
      entry.pipelineExecutionId = pipelineExecutionId;
    },
  );
  readOptionalStringField(value, 'jobId', (jobId) => {
    entry.jobId = jobId;
  });
  readOptionalStringField(value, 'stepId', (stepId) => {
    entry.stepId = stepId;
  });

  readOptionalNumberField(value, 'durationMs', (durationMs) => {
    entry.durationMs = durationMs;
  });
  readOptionalNumberField(value, 'totalCostUsd', (totalCostUsd) => {
    entry.totalCostUsd = totalCostUsd;
  });
  readOptionalNumberField(value, 'attempt', (attempt) => {
    entry.attempt = attempt;
  });

  const observedCost = parseObservedCost(value.observedCost);
  if (observedCost) {
    entry.observedCost = observedCost;
  }
  if (isRecord(value.billableToolCounts)) {
    const openAiWebSearchCalls = readNumber(
      value.billableToolCounts,
      'openAiWebSearchCalls',
    );
    if (typeof openAiWebSearchCalls === 'number') {
      entry.billableToolCounts = { openAiWebSearchCalls };
    }
  }

  if (readBoolean(value, 'aiCreditsRouted') === true) {
    entry.aiCreditsRouted = true;
  }
  if (readBoolean(value, 'modelGatewayRouted') === true) {
    entry.modelGatewayRouted = true;
  }
  readOptionalStringField(value, 'providerAccountKey', (providerAccountKey) => {
    entry.providerAccountKey = providerAccountKey;
  });
  readOptionalStringField(
    value,
    'providerAccountEmail',
    (providerAccountEmail) => {
      entry.providerAccountEmail = providerAccountEmail;
    },
  );
  readOptionalStringField(value, 'providerPlanType', (providerPlanType) => {
    entry.providerPlanType = providerPlanType;
  });

  const billingBasis = readString(value, 'billingBasis');
  const parsedBillingBasis =
    billingBasis === undefined
      ? null
      : parseAgentAuditBillingBasis(billingBasis);
  if (parsedBillingBasis !== null) {
    entry.billingBasis = parsedBillingBasis;
  }
  const accountProxy = parseAccountProxyUsage(value.accountProxy);
  if (accountProxy) {
    entry.accountProxy = accountProxy;
  }
  const context = parseContextUsage(value.context);
  if (context) {
    entry.context = context;
  }
  const compactions = parseCompactions(value.compactions);
  if (compactions.length > 0) {
    entry.compactions = compactions;
  }
  const subagents = parseSubagents(value.subagents);
  if (subagents.length > 0) {
    entry.subagents = subagents;
  }
  const interfaceToolCalls = parseInterfaceToolCalls(value.interfaceToolCalls);
  if (interfaceToolCalls.length > 0) {
    entry.interfaceToolCalls = interfaceToolCalls;
  }
  const delegation = parseDelegationLineage(value.delegation);
  if (delegation) {
    entry.delegation = delegation;
  }
  if (isRecord(value.planEvents)) {
    const created = readNumber(value.planEvents, 'created') ?? 0;
    const approved = readNumber(value.planEvents, 'approved') ?? 0;
    const rawEventIds = value.planEvents.eventIds;
    const eventIds = Array.isArray(rawEventIds)
      ? rawEventIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : [];
    if (created > 0 || approved > 0) {
      entry.planEvents = {
        created,
        approved,
        ...(eventIds.length > 0 ? { eventIds } : {}),
      };
    }
  }
  readOptionalStringField(
    value,
    'rootPipelineExecutionId',
    (rootPipelineExecutionId) => {
      entry.rootPipelineExecutionId = rootPipelineExecutionId;
    },
  );

  const sdkCumulativeCostUsd = readNumber(value, 'sdkCumulativeCostUsd');
  if (sdkCumulativeCostUsd !== undefined && sdkCumulativeCostUsd >= 0) {
    entry.sdkCumulativeCostUsd = sdkCumulativeCostUsd;
  }
  const costDerivation = readString(value, 'costDerivation');
  if (
    costDerivation === 'exact' ||
    costDerivation === 'estimated_unknown_baseline'
  ) {
    entry.costDerivation = costDerivation;
  }
  const modelUsage = parseModelUsage(value.modelUsage);
  // An empty array is authoritative zero usage; a list of only invalid rows is not.
  if (
    modelUsage.length > 0 ||
    (Array.isArray(value.modelUsage) && value.modelUsage.length === 0)
  ) {
    entry.modelUsage = modelUsage;
  }
  if (isRecord(value.costRepair)) {
    const version = readNumber(value.costRepair, 'version');
    const previousTotalCostUsd = readNumber(
      value.costRepair,
      'previousTotalCostUsd',
    );
    if (version !== undefined && Number.isSafeInteger(version) && version > 0) {
      entry.costRepair = {
        version,
        ...(previousTotalCostUsd !== undefined ? { previousTotalCostUsd } : {}),
      };
    }
  }

  const linkTarget = normalizeAuditLinkTarget(value);
  if (linkTarget) {
    entry.linkTarget = linkTarget;
  }

  return entry;
}
