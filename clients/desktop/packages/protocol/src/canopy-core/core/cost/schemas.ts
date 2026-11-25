import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';

const COST_BILLING_BASES = [
  'subscription',
  'ai_credits',
  'account_proxy',
  'api_key',
  'org_gateway',
  'local',
  'unknown',
] as const;
const COST_STATUSES = [
  'reported',
  'estimated',
  'partial',
  'not_priced',
] as const;
const COST_HELPER_KINDS = [
  'chat_title',
  'branch_name',
  'handoff_summary',
  'commit_message',
  'entry_summary',
  'pull_request_text',
  'pipeline_advisor',
  'other',
] as const;
const COST_VIEW_UNAVAILABLE_REASONS = [
  'no_scope',
  'runtime_unavailable',
] as const;
const COST_ERROR_REASONS = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'SCOPE_SEALED',
  'UNKNOWN',
] as const;

const id = z.string().min(1).max(512);
const label = z.string().max(16_384);
const model = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
const coverageDay = z.iso.date();
const amount = z.number().finite().min(0);
const count = z.number().int().min(0);
const positiveCount = z.number().int().min(1);

export const CostScopeRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('entry'),
    projectId: id,
    worktreeId: id,
  }),
  z.strictObject({
    kind: z.literal('retained'),
    projectId: id,
    containerId: id,
  }),
]);

export const CostTokenTotalsSchema = z.strictObject({
  input: count,
  output: count,
  cacheReadInputTokens: count,
  cacheCreationInputTokens: count,
  reasoningOutputTokens: count,
});

export const CostTotalsSchema = z.strictObject({
  usd: amount,
  bySource: z.strictObject({
    chat: amount,
    pipeline: amount,
    subagents: amount,
    delegations: amount,
    background: amount,
  }),
  byBilling: z.strictObject({
    subscription: amount,
    ai_credits: amount,
    account_proxy: amount,
    api_key: amount,
    org_gateway: amount,
    local: amount,
    unknown: amount,
  }),
  tokens: CostTokenTotalsSchema,
  notPricedCount: count,
  /** Sparse per-basis split of `notPricedCount` (CAN-7305). */
  notPricedByBilling: z
    .strictObject({
      subscription: positiveCount.optional(),
      ai_credits: positiveCount.optional(),
      account_proxy: positiveCount.optional(),
      api_key: positiveCount.optional(),
      org_gateway: positiveCount.optional(),
      local: positiveCount.optional(),
      unknown: positiveCount.optional(),
    })
    .optional(),
  hasEstimate: z.boolean(),
});

export const CostProxyAccountRefSchema = z.strictObject({
  accountKey: id,
  label,
  provider: id.optional(),
});

export const CostProxyAccountRowSchema = z.strictObject({
  accountKey: id,
  label,
  provider: id.optional(),
  turnShare: amount,
  requestCount: count,
  usd: amount,
  notPricedCount: count,
});

export const CostChatRowSchema = z.strictObject({
  chatId: id,
  label,
  state: z.enum(['open', 'archived']),
  totals: CostTotalsSchema,
  turnCount: count,
  lastActivityAt: timestamp,
  running: z.boolean(),
  models: z.array(model).readonly(),
  coverageStart: coverageDay.optional(),
  proxyAccounts: z.array(CostProxyAccountRowSchema).readonly().optional(),
});

export const CostPipelineRunRowSchema = z.strictObject({
  executionId: id,
  pipelineName: label,
  startedAt: timestamp,
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  totals: CostTotalsSchema,
  agentStepCount: count,
});

export const CostScopeViewSchema = z.strictObject({
  scope: CostScopeRefSchema,
  updatedAt: timestamp.nullable(),
  building: z.boolean(),
  sealedAt: timestamp.optional(),
  coverageStart: coverageDay.optional(),
  retentionDays: z.number().int().min(1).max(90),
  totals: CostTotalsSchema,
  chats: z.array(CostChatRowSchema).readonly(),
  pipelineRuns: z.array(CostPipelineRunRowSchema).readonly(),
  unattached: CostTotalsSchema.optional(),
  hasCodexEstimate: z.boolean(),
});

export const CostAttributedItemSchema = z.strictObject({
  id,
  kind: z.enum(['claude_task', 'codex_agent', 'delegation']),
  label,
  model: model.optional(),
  harness: id.optional(),
  billingBasis: z.enum(COST_BILLING_BASES),
  tokens: CostTokenTotalsSchema,
  totalTokens: count.optional(),
  usd: amount.optional(),
  costStatus: z.enum(COST_STATUSES),
  inclusion: z.enum(['included', 'additional']),
  runCount: count.optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']).optional(),
  proxyAccounts: z.array(CostProxyAccountRefSchema).readonly().optional(),
});

export const CostBackgroundRowSchema = z.strictObject({
  kind: z.enum(COST_HELPER_KINDS),
  runCount: count,
  usd: amount,
  notPricedCount: count,
  tokens: CostTokenTotalsSchema,
});

export const CostModelRowSchema = z.strictObject({
  model,
  turnCount: count,
  usd: amount,
  notPricedCount: count,
  tokens: CostTokenTotalsSchema,
});

export const CostSourceBreakdownSchema = z.strictObject({
  chat: z.strictObject({ usd: amount, turnCount: count }),
  subagents: z.strictObject({
    usd: amount,
    items: z.array(CostAttributedItemSchema).readonly(),
  }),
  delegations: z.strictObject({
    usd: amount,
    items: z.array(CostAttributedItemSchema).readonly(),
  }),
  background: z.strictObject({
    usd: amount,
    rows: z.array(CostBackgroundRowSchema).readonly(),
  }),
});

export const CostContextCategorySchema = z.strictObject({
  name: label,
  tokens: count,
  kind: z.enum(['used', 'free', 'buffer', 'deferred']),
});

export const CostContextPointSchema = z.strictObject({
  at: timestamp,
  endTokens: count,
  compaction: z.enum(['auto', 'manual', 'unknown']).optional(),
});

export const CostContextViewSchema = z.strictObject({
  latest: z
    .strictObject({
      usedTokens: count,
      windowTokens: positiveCount,
      at: timestamp,
    })
    .optional(),
  categories: z.array(CostContextCategorySchema).readonly(),
  peak: z
    .strictObject({ usedTokens: count, windowTokens: positiveCount })
    .optional(),
  timeline: z.array(CostContextPointSchema).readonly(),
});

export const CostToolCountSchema = z.strictObject({
  tool: id,
  count,
});

export const CostActivityStatsSchema = z.strictObject({
  turnCount: count,
  totalDurationMs: amount,
  averageTurnMs: amount.nullable(),
  p95TurnMs: amount.nullable(),
  toolCallCount: count,
  subagentCount: count,
  plansCreated: count,
  plansApproved: count,
  topTools: z.array(CostToolCountSchema).readonly(),
});

export const SessionBreakdownViewSchema = z.strictObject({
  chat: CostChatRowSchema,
  updatedAt: timestamp.nullable(),
  sealedAt: timestamp.optional(),
  bySource: CostSourceBreakdownSchema,
  chatTurnsByModel: z.array(CostModelRowSchema).readonly(),
  byModel: z.array(CostModelRowSchema).readonly(),
  context: CostContextViewSchema,
  compactions: z.strictObject({ total: count, auto: count, manual: count }),
  activity: CostActivityStatsSchema,
});

export const PipelineRunStepCostSchema = z.strictObject({
  jobId: id,
  stepId: id,
  label,
  attemptCount: positiveCount,
  model: model.optional(),
  harness: id.optional(),
  totals: CostTotalsSchema,
  executionId: id,
  proxyAccounts: z.array(CostProxyAccountRowSchema).readonly().optional(),
});

export const PipelineRunChildCostSchema = z.strictObject({
  executionId: id,
  pipelineName: label,
  usd: amount,
  agentStepCount: count,
  notPricedCount: count.optional(),
});

export const PipelineRunCostViewSchema = z.strictObject({
  run: CostPipelineRunRowSchema,
  updatedAt: timestamp.nullable(),
  sealedAt: timestamp.optional(),
  steps: z.array(PipelineRunStepCostSchema).readonly(),
  nonAgentStepCount: count.optional(),
  advisor: z
    .strictObject({ reportCount: count, usd: amount, notPricedCount: count })
    .optional(),
  subagents: z.array(CostAttributedItemSchema).readonly(),
  delegations: z.array(CostAttributedItemSchema).readonly(),
  childRuns: z.array(PipelineRunChildCostSchema).readonly(),
  byModel: z.array(CostModelRowSchema).readonly(),
  byProxyAccount: z.array(CostProxyAccountRowSchema).readonly().optional(),
});

export const CostScopeRequestSchema = z.strictObject({
  scope: CostScopeRefSchema,
});

export const CostChatRequestSchema = z.strictObject({
  scope: CostScopeRefSchema,
  chatId: id,
  detail: z.enum(['summary', 'full']).optional(),
  subagentId: id.optional(),
});

export const CostPipelineRunRequestSchema = z.strictObject({
  scope: CostScopeRefSchema,
  executionId: id,
});

const costRefreshRequestObjectSchema = z.strictObject({
  scope: CostScopeRefSchema,
  trigger: z.enum(['manual', 'open', 'turn']),
});

export const CostRefreshRequestSchema = costRefreshRequestObjectSchema;

/** Keyed refresh instruction metadata follows the shared Canopy wire shape. */
export const CostKeyedRequestMetadataSchema =
  CanopyRequestMetadataSchema.required({ idempotencyKey: true });

export const CostIndexRefreshParamsSchema =
  costRefreshRequestObjectSchema.extend({
    _meta: CostKeyedRequestMetadataSchema,
  });

export const CostChatViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('summary'), chat: CostChatRowSchema }),
  z.strictObject({
    kind: z.literal('full'),
    breakdown: SessionBreakdownViewSchema,
  }),
  z.strictObject({
    kind: z.literal('subagent'),
    chat: CostChatRowSchema,
    item: CostAttributedItemSchema,
  }),
]);

export const CostRefreshReceiptSchema = z.strictObject({
  ran: z.boolean(),
  updatedAt: timestamp.nullable(),
  revision: count,
});

export const CostViewUnavailableReasonSchema = z.enum(
  COST_VIEW_UNAVAILABLE_REASONS,
);
export const CostErrorReasonSchema = z.enum(COST_ERROR_REASONS);
export const CostScopeGetResultSchema = CostScopeViewSchema;
export const CostChatGetResultSchema = CostChatViewSchema;
export const CostPipelineRunGetResultSchema = PipelineRunCostViewSchema;
export const CostIndexRefreshResultSchema = CostRefreshReceiptSchema;

export const CostUpdatedEventSchema = z.strictObject({
  scopes: z.array(CostScopeRefSchema).readonly(),
  revision: count,
});
