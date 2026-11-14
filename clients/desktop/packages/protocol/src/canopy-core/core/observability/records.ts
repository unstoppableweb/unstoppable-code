import { z } from 'zod';

/*
 * Wire schemas for the audit and usage records `core.observability.*` serves
 * (CAN-4137). They mirror the record contracts in `@canopy/protocol/
 * observability`, which the ingest stores; the protocol contract test keeps
 * each schema's output equal to its record type. Requests are closed. Results
 * strip unknown keys, so the wire carries exactly the declared record.
 */

const AUDIT_PROVIDERS = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
  'copilot',
  'antigravity',
] as const;

const AUDIT_EVENT_TYPES = [
  'worktree_chat',
  'standalone_chat',
  'app_advisor',
  'pipeline_editor',
  'pipeline_agent_turn',
  'pipeline_advisor',
  'pr_generation',
  'pr_split_planning',
  'commit_message_generation',
  'branch_naming',
  'cron_generation',
  'automation_if_command_generation',
  'worktree_summary',
  'chat_summary',
  'chat_handoff_summary',
  'archive_summary',
  'worktree_plan_chat',
  'worktree_plan_diagram',
  'code_review_annotations',
  'code_review_diagram',
  'local_memory_consolidation',
  'local_memory_chat_profile',
  'skill_suggestion_scan',
  'managed_delegation',
] as const;

const AUDIT_STATUSES = [
  'running',
  'success',
  'failure',
  'cancelled',
  'interrupted',
] as const;

const OBSERVED_COST_REASONS = [
  'priced',
  'model_not_priced',
  'billable_tool_pricing_unavailable',
  'pricing_unavailable',
  'model_missing',
  'unsupported_fast_pricing',
  'unsupported_service_tier',
  'unsupported_usage_shape',
  'invalid_pricing_payload',
] as const;

/** Keys of `AgentAuditToolCounts`, in declaration order. */
export const OBSERVABILITY_TOOL_COUNT_KEYS = [
  'thinking',
  'bash',
  'read',
  'readLines',
  'writeEdit',
  'plan',
  'fileEdit',
  'fileAdd',
  'fileDelete',
  'search',
  'grep',
  'web',
  'agent',
  'workflow',
  'tasks',
  'taskStop',
  'skills',
  'monitor',
  'claude',
  'scheduleWakeup',
  'askUser',
  'scriptOutput',
  'watcher',
  'canopy',
  'graph',
  'appAdvisor',
  'pipelineEditor',
  'mcp',
  'other',
] as const;

const USAGE_TAB_IDS = [
  'tokens',
  'cost',
  'worktrees',
  'chats',
  'plans',
  'tools',
  'pipelines',
] as const;

const USAGE_INITIATION_SOURCES = [
  'user',
  'hook',
  'automation',
  'app_advisor',
  'portal',
  'unknown',
] as const;

const count = z.number();
const optionalCount = z.number().optional();

export const ObservabilityAuditProviderSchema = z.enum(AUDIT_PROVIDERS);
export const ObservabilityAuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export const ObservabilityAuditStatusSchema = z.enum(AUDIT_STATUSES);

const ObservedCostReasonSchema = z.enum(OBSERVED_COST_REASONS);

export const ObservabilityAuditHistoryRequestSchema = z.strictObject({
  cursor: z.string().optional(),
  limit: optionalCount,
  search: z.string().optional(),
  eventType: z
    .union([ObservabilityAuditEventTypeSchema, z.literal('all')])
    .optional(),
  provider: z
    .union([ObservabilityAuditProviderSchema, z.literal('all')])
    .optional(),
  status: z
    .union([ObservabilityAuditStatusSchema, z.literal('all')])
    .optional(),
  projectId: z.string().optional(),
  worktreeId: z.string().optional(),
  pipelineExecutionId: z.string().optional(),
  activeOnly: z.boolean().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const ObservabilityAuditTranscriptRequestSchema = z.strictObject({
  id: z.string(),
  eventType: ObservabilityAuditEventTypeSchema,
  startedAt: z.string(),
});

export const ObservabilityUsageTabIdSchema = z.enum(USAGE_TAB_IDS);

const TokenMetricIdSchema = z.enum([
  'token_total',
  'token_input',
  'token_output',
  'token_cache_read',
  'token_cache_creation',
  'token_provider_claude',
  'token_provider_codex',
  'token_provider_ollama',
]);
const CostMetricIdSchema = z.union([
  z.enum([
    'cost_total_usd',
    'cost_provider_claude_usd',
    'cost_provider_codex_usd',
  ]),
  z.templateLiteral(['cost_model:', z.string()]),
]);
const WorktreeMetricIdSchema = z.enum([
  'created',
  'merged',
  'deleted_with_changes',
  'deleted_without_changes',
  'age_at_deletion_ms',
]);
const ChatMetricIdSchema = z.enum([
  'chat_turns',
  'tool_calls',
  'turn_duration_ms',
  'tool_calls_per_turn',
]);
const PlanMetricIdSchema = z.enum([
  'plan_created',
  'plan_updated',
  'plan_approved',
]);
const ToolMetricIdSchema = z.union([
  z.literal('tool_calls'),
  z.templateLiteral(['tool_', z.enum(OBSERVABILITY_TOOL_COUNT_KEYS)]),
]);
const PipelineMetricIdSchema = z.enum([
  'pipeline_runs_started',
  'pipeline_runs_completed',
  'pipeline_runs_succeeded',
  'pipeline_runs_failed',
  'pipeline_runs_cancelled',
  'pipeline_duration_ms',
  'pipeline_steps_per_run',
  'pipeline_agent_steps_per_run',
  'pipeline_retries_per_run',
]);

export const ObservabilityUsageMetricIdSchema = z.union([
  TokenMetricIdSchema,
  CostMetricIdSchema,
  WorktreeMetricIdSchema,
  ChatMetricIdSchema,
  PlanMetricIdSchema,
  ToolMetricIdSchema,
  PipelineMetricIdSchema,
]);

const isoDate = z.string();

export const ObservabilityUsageTimeseriesRequestSchema = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
  bucket: z.enum(['hour', 'day', 'week']),
  dataset: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('tokens') }),
      z.strictObject({
        kind: z.literal('tab-counts'),
        tab: ObservabilityUsageTabIdSchema,
        series: z.array(ObservabilityUsageMetricIdSchema),
      }),
      z.strictObject({
        kind: z.literal('tab-distribution'),
        tab: ObservabilityUsageTabIdSchema,
        metric: ObservabilityUsageMetricIdSchema,
      }),
    ])
    .optional(),
});

const UsageMetricProviderSchema = z.union([
  ObservabilityAuditProviderSchema,
  z.literal('pipeline'),
]);
const UsageInitiationSourceSchema = z.enum(USAGE_INITIATION_SOURCES);

export const ObservabilityUsageMetricsRequestSchema = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
  workspaceId: z.string().optional(),
  repoId: z.string().optional(),
  provider: z.union([UsageMetricProviderSchema, z.literal('all')]).optional(),
  initiationSource: z
    .union([UsageInitiationSourceSchema, z.literal('all')])
    .optional(),
});

const UsageGroupByIdSchema = z.enum([
  'workspace',
  'workspace_then_repo',
  'repo',
  'day_of_week',
  'worktree',
  'chat',
  'provider',
  'initiation_source',
  'model',
  'category',
  'pipeline',
  'status',
  'event_name',
  'trigger_source',
]);

export const ObservabilityUsageMetricsViewRequestSchema = z.strictObject({
  tab: ObservabilityUsageTabIdSchema,
  metric: ObservabilityUsageMetricIdSchema,
  groupBy: UsageGroupByIdSchema,
  window: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('last7d') }),
    z.strictObject({ kind: z.literal('prior7d') }),
    z.strictObject({ kind: z.literal('allTime') }),
    z.strictObject({
      kind: z.literal('custom'),
      start: isoDate,
      end: isoDate,
    }),
  ]),
});

export const ObservabilityUsageTabSummaryRequestSchema = z.strictObject({
  tab: ObservabilityUsageTabIdSchema,
});

/*
 * The result schemas are large and every process that loads the protocol
 * registry evaluates this module, so they are built on first use instead of
 * at import.
 */
function memoized<Value>(build: () => Value): () => Value {
  let value: { readonly built: Value } | undefined;
  return (): Value => {
    value ??= { built: build() };
    return value.built;
  };
}

const results = memoized(() => {
  const ObservabilityAuditTokenTotalsSchema = z.object({
    input: count,
    output: count,
    cacheReadInputTokens: count,
    cacheCreationInputTokens: count,
    reasoningOutputTokens: optionalCount,
  });

  const ObservabilityAuditToolCountsSchema = z.object({
    thinking: count,
    bash: count,
    read: count,
    readLines: count,
    writeEdit: count,
    plan: count,
    fileEdit: count,
    fileAdd: count,
    fileDelete: count,
    search: count,
    grep: count,
    web: count,
    agent: count,
    workflow: count,
    tasks: count,
    taskStop: count,
    skills: count,
    monitor: count,
    claude: count,
    scheduleWakeup: count,
    askUser: count,
    scriptOutput: count,
    watcher: count,
    canopy: count,
    graph: count,
    appAdvisor: count,
    pipelineEditor: count,
    mcp: count,
    other: count,
  });

  const ObservedCostComponentSchema = z.object({
    kind: z.enum([
      'tokens',
      'web_search_call',
      'unpriced_tokens',
      'unpriced_tool',
    ]),
    label: z.string(),
    quantity: optionalCount,
    unit: z.enum(['tokens', 'calls']).optional(),
    usd: optionalCount,
    reason: ObservedCostReasonSchema.optional(),
  });

  const ObservedCostSchema = z.object({
    status: z.enum(['priced', 'partially_priced', 'unpriced']),
    reason: ObservedCostReasonSchema,
    currency: z.literal('usd'),
    totalUsd: optionalCount,
    tokenUsd: optionalCount,
    nonTokenUsd: optionalCount,
    pricingSource: z
      .object({
        type: z.literal('canopy_openai_pricing'),
        fetchedAt: z.string().optional(),
        pricingUrl: z.string().optional(),
        codexPricingUrl: z.string().optional(),
        codexSpeedUrl: z.string().optional(),
      })
      .optional(),
    pricingBasis: z
      .enum([
        'openai_api_standard',
        'codex_credit_adjusted_standard_equivalent',
      ])
      .optional(),
    model: z.string().optional(),
    serviceTier: z.string().optional(),
    canonicalServiceTier: z.enum(['standard', 'fast']).optional(),
    contextTier: z.enum(['standard', 'long', 'unknown']).optional(),
    contextTierSource: z
      .enum(['pricing_payload_threshold', 'not_applicable', 'unknown'])
      .optional(),
    longContextApplied: z.boolean().optional(),
    fastModeMultiplierApplied: optionalCount,
    components: z.array(ObservedCostComponentSchema),
  });

  const ModelRoutingAttributionSchema = z.object({
    schemaVersion: z.literal(1),
    selectionMode: z.literal('auto'),
    outcome: z.enum(['selected', 'fallback']),
    executionLane: z.enum(['provider_subscription', 'ai_credits']),
    benchmarkModelId: z.string().optional(),
    selectedModelId: z.string(),
    routingCostUsd: optionalCount,
    routingCredits: optionalCount,
    cacheMissContextTokens: optionalCount,
    savings: z
      .object({
        status: z.enum([
          'computed',
          'default_unavailable',
          'unpriced_model',
          'incomplete_usage',
          'incomparable_basis',
          'unresolved_routing_cost',
        ]),
        pricingRevision: z.string().optional(),
        selectedCostBasis: z
          .enum(['gateway_actual', 'api_equivalent'])
          .optional(),
        benchmarkEstimatedExecutionCostUsd: optionalCount,
        selectedExecutionCostUsd: optionalCount,
        actualWithAutoCostUsd: optionalCount,
        netEstimatedSavingsUsd: optionalCount,
      })
      .optional(),
  });

  const LinkTargetSchema = z.object({
    page: z.enum(['main', 'chat', 'pipelines', 'audit', 'usage']),
    kind: z.enum([
      'worktree-chat',
      'app-advisor',
      'pipeline-editor',
      'standalone-chat',
      'pipeline-execution',
    ]),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    planId: z.string().optional(),
    chatId: z.string().optional(),
    pipelineExecutionId: z.string().optional(),
  });

  const SubagentUsageSchema = z.object({
    id: z.string(),
    kind: z.enum(['claude_task', 'codex_agent']),
    label: z.string().optional(),
    model: z.string().optional(),
    tokens: ObservabilityAuditTokenTotalsSchema,
    totalTokens: optionalCount,
    costUsd: optionalCount,
    inclusion: z.enum(['included', 'additional']),
  });

  const ModelUsageSchema = z.object({
    model: z.string(),
    inputTokens: count,
    outputTokens: count,
    cacheReadInputTokens: count,
    cacheCreationInputTokens: count,
    webSearchRequests: optionalCount,
    costUsd: count,
    costBasis: z.enum(['list', 'managed', 'unknown']).optional(),
  });

  const ObservabilityAuditEntrySchema = z.object({
    id: z.string(),
    eventType: ObservabilityAuditEventTypeSchema,
    status: ObservabilityAuditStatusSchema,
    provider: ObservabilityAuditProviderSchema,
    modelSource: z
      .enum([
        'claude-managed',
        'codex-managed',
        'cursor-managed',
        'copilot-managed',
        'antigravity-managed',
        'opencode-managed',
        'ai-gateway',
        'ollama',
      ])
      .optional(),
    executionHarness: z
      .enum(['claude', 'codex', 'cursor', 'opencode', 'copilot', 'antigravity'])
      .optional(),
    label: z.string(),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    durationMs: optionalCount,
    model: z.string().optional(),
    requestedModel: z.string().optional(),
    agentId: z.string().optional(),
    totalCostUsd: optionalCount,
    observedCost: ObservedCostSchema.optional(),
    modelRouting: ModelRoutingAttributionSchema.optional(),
    serviceTier: z.string().optional(),
    billableToolCounts: z
      .object({ openAiWebSearchCalls: optionalCount })
      .optional(),
    tokens: ObservabilityAuditTokenTotalsSchema,
    messageCount: count,
    assistantMessageCount: count,
    toolUseCount: count,
    subAgentCount: count,
    toolCounts: ObservabilityAuditToolCountsSchema,
    error: z.string().optional(),
    projectId: z.string().optional(),
    worktreeId: z.string().optional(),
    contextWorkspaceId: z.string().optional(),
    repoId: z.string().optional(),
    repoLabel: z.string().optional(),
    chatId: z.string().optional(),
    userMessageId: z.string().optional(),
    sdkSessionId: z.string().optional(),
    pipelineId: z.string().optional(),
    pipelineName: z.string().optional(),
    pipelineExecutionId: z.string().optional(),
    jobId: z.string().optional(),
    stepId: z.string().optional(),
    attempt: optionalCount,
    chatMode: z.enum(['canopy', 'terminal']).optional(),
    hasTranscript: z.boolean(),
    linkTarget: LinkTargetSchema.optional(),
    aiCreditsRouted: z.boolean().optional(),
    modelGatewayRouted: z.boolean().optional(),
    providerAccountKey: z.string().optional(),
    providerAccountEmail: z.string().optional(),
    providerPlanType: z.string().optional(),
    autonomous: z.literal(true).optional(),
    billingBasis: z
      .enum([
        'subscription',
        'api_key',
        'ai_credits',
        'account_proxy',
        'org_gateway',
        'local',
        'unknown',
      ])
      .optional(),
    accountProxy: z
      .object({
        connectionId: z.string(),
        accounts: z.array(
          z.object({
            authIndex: z.string(),
            label: z.string().optional(),
            provider: z.string().optional(),
            requests: count,
          }),
        ),
      })
      .optional(),
    context: z
      .object({
        endTokens: count,
        windowTokens: count,
        peakTokens: optionalCount,
        categories: z
          .array(
            z.object({
              name: z.string(),
              tokens: count,
              kind: z.enum(['used', 'free', 'buffer', 'deferred']),
            }),
          )
          .optional(),
      })
      .optional(),
    compactions: z
      .array(
        z.object({
          at: z.string(),
          trigger: z.enum(['auto', 'manual', 'unknown']),
          preTokens: optionalCount,
        }),
      )
      .optional(),
    subagents: z.array(SubagentUsageSchema).optional(),
    interfaceToolCalls: z
      .array(
        z.object({
          callId: z.string(),
          toolName: z.string(),
          leaseId: z.string(),
          surface: z.string(),
          interfaceKind: z.string(),
          audience: z.string().optional(),
          outcome: z.string(),
          deliveredAt: z.string(),
          settledAt: z.string(),
        }),
      )
      .optional(),
    delegation: z
      .object({
        delegationId: z.string(),
        runGeneration: count,
        parentChatId: z.string().optional(),
        parentUserMessageId: z.string().optional(),
        parentDelegationId: z.string().optional(),
        parentPipelineExecutionId: z.string().optional(),
        harness: z.string().optional(),
        label: z.string().optional(),
      })
      .optional(),
    planEvents: z
      .object({
        created: count,
        approved: count,
        eventIds: z.array(z.string()).optional(),
      })
      .optional(),
    rootPipelineExecutionId: z.string().optional(),
    sdkCumulativeCostUsd: optionalCount,
    costDerivation: z.enum(['exact', 'estimated_unknown_baseline']).optional(),
    modelUsage: z.array(ModelUsageSchema).optional(),
    costRepair: z
      .object({ version: count, previousTotalCostUsd: optionalCount })
      .optional(),
  });

  const ObservabilityAuditHistoryResponseSchema = z.object({
    entries: z.array(ObservabilityAuditEntrySchema),
    nextCursor: z.string().optional(),
  });

  const DeferredResourceSchema = z.object({
    ref: z.string(),
    kind: z.enum(['skill', 'plugin', 'mcp']),
    name: z.string(),
    sourceLabel: z.string().optional(),
  });

  const TranscriptInjectedPromptSchema = z.object({
    kind: z.enum([
      'system_prompt_append',
      'plan_mode_developer_instructions',
      'org_memory',
    ]),
    provider: ObservabilityAuditProviderSchema,
    applicationCondition: z.enum([
      'claude_system_prompt_append_each_turn',
      'codex_first_turn_without_session_id',
      'helper_task_system_prompt',
      'pipeline_step_system_prompt',
      'plan_mode_enabled',
      'deferred_tools_reload_continuation',
      'org_memory_enabled_for_turn',
    ]),
    text: z.string(),
    deferredToolsReload: z
      .object({ enabledResources: z.array(DeferredResourceSchema) })
      .optional(),
  });

  const ObservabilityAuditTranscriptResponseSchema = z.discriminatedUnion(
    'type',
    [
      z.object({
        type: z.literal('success'),
        // Recorded boundary exception: stored lines are served as written, and
        // provider payloads in them name files by host path. Only this host's
        // own user reads them, on this host or by remote control of it.
        // CAN-5092 projects the paths before any other client reads
        // transcripts (CAN-5096 N1).
        lines: z.array(z.string()),
        providerHint: ObservabilityAuditProviderSchema.optional(),
        truncation: z.object({
          truncated: z.boolean(),
          maxBytes: count,
          storedBytes: count,
        }),
        injectedPrompts: z.array(TranscriptInjectedPromptSchema),
      }),
      z.object({ type: z.literal('not_available') }),
    ],
  );

  const providerTokens = z.object({ in: count, out: count });

  const ObservabilityUsageTimeseriesResponseSchema = z.discriminatedUnion(
    'kind',
    [
      z.object({
        kind: z.literal('tokens'),
        buckets: z.array(
          z.object({
            bucketStart: z.string(),
            providers: z.object({
              claude: providerTokens,
              codex: providerTokens,
              ollama: providerTokens,
              cursor: providerTokens,
              opencode: providerTokens,
              copilot: providerTokens,
              antigravity: providerTokens.default({ in: 0, out: 0 }),
            }),
          }),
        ),
      }),
      z.object({
        kind: z.literal('tab-counts'),
        buckets: z.array(
          z.object({
            bucketStart: z.string(),
            series: z.partialRecord(ObservabilityUsageMetricIdSchema, count),
          }),
        ),
      }),
      z.object({
        kind: z.literal('tab-distribution'),
        buckets: z.array(
          z.object({
            bucketStart: z.string(),
            p50: count,
            p95: count,
            p99: count,
            sampleCount: count,
          }),
        ),
      }),
    ],
  );

  const UsageStatsSchema = z.object({
    total: count,
    min: count,
    max: count,
    avg: count,
    p50: count,
    p95: count,
    p99: count,
  });

  const UsageBreakdownRowSchema = z.object({
    key: z.string(),
    label: z.string(),
    workspaceId: z.string().optional(),
    workspaceLabel: z.string().optional(),
    worktreeId: z.string().optional(),
    repoId: z.string().optional(),
    provider: UsageMetricProviderSchema.optional(),
    initiationSource: UsageInitiationSourceSchema.optional(),
    count,
    stats: UsageStatsSchema.optional(),
  });

  const UsageBreakdownRowsSchema = z.object({
    total: count,
    stats: UsageStatsSchema.optional(),
    rows: z.array(UsageBreakdownRowSchema),
  });

  const ObservabilityUsageMetricsResponseSchema = z.object({
    updatedAt: z.string(),
    retentionDays: count,
    worktrees: z.object({
      created: UsageBreakdownRowsSchema,
      merged: UsageBreakdownRowsSchema,
      deletedWithChanges: UsageBreakdownRowsSchema,
      deletedWithoutChanges: UsageBreakdownRowsSchema,
      deletionAgeMs: UsageBreakdownRowsSchema,
    }),
    chats: z.object({
      turnCountsPerChat: UsageBreakdownRowsSchema,
      turnCountsPerWorktree: UsageBreakdownRowsSchema,
      turnCountsByInitiationSource: UsageBreakdownRowsSchema.optional(),
      turnCountsByProvider: UsageBreakdownRowsSchema.optional(),
      turnDurationMs: UsageBreakdownRowsSchema,
      toolCallsPerTurn: UsageBreakdownRowsSchema,
      toolCallsPerChat: UsageBreakdownRowsSchema,
      toolCallsPerWorktree: UsageBreakdownRowsSchema,
      statusCounts: z.array(
        z.object({ status: ObservabilityAuditStatusSchema, count }),
      ),
    }),
    plans: z.object({
      created: UsageBreakdownRowsSchema,
      updated: UsageBreakdownRowsSchema,
      approved: UsageBreakdownRowsSchema,
      createdPerWorktree: UsageBreakdownRowsSchema,
      updatedPerWorktree: UsageBreakdownRowsSchema,
      approvedPerWorktree: UsageBreakdownRowsSchema,
    }),
    tools: z.object({
      byCategory: z.array(
        z.object({
          category: z.enum(OBSERVABILITY_TOOL_COUNT_KEYS),
          count,
        }),
      ),
      byProvider: UsageBreakdownRowsSchema,
      byInitiationSource: UsageBreakdownRowsSchema,
    }),
  });

  const resolvedWindow = z.object({ start: z.string(), end: z.string() });

  const ObservabilityUsageMetricsViewResponseSchema = z.object({
    rows: z.array(UsageBreakdownRowSchema),
    stats: UsageStatsSchema.optional(),
    resolvedWindow,
    earliestEventAt: z.string(),
  });

  const cardValue = z.union([count, UsageStatsSchema]).optional();

  const ObservabilityUsageTabSummaryResponseSchema = z.object({
    tab: ObservabilityUsageTabIdSchema,
    cards: z.array(
      z.object({
        key: z.string(),
        last7d: cardValue,
        prior7d: cardValue,
        allTime: cardValue,
      }),
    ),
    earliestEventAt: z.string(),
    resolvedWindows: z.object({
      last7d: resolvedWindow,
      prior7d: resolvedWindow,
      allTime: resolvedWindow,
    }),
  });

  return {
    ObservabilityAuditTokenTotalsSchema,
    ObservabilityAuditToolCountsSchema,
    ObservabilityAuditEntrySchema,
    ObservabilityAuditHistoryResponseSchema,
    ObservabilityAuditTranscriptResponseSchema,
    ObservabilityUsageTimeseriesResponseSchema,
    ObservabilityUsageMetricsResponseSchema,
    ObservabilityUsageMetricsViewResponseSchema,
    ObservabilityUsageTabSummaryResponseSchema,
  };
});

export const ObservabilityAuditTokenTotalsSchema = z.lazy(
  () => results().ObservabilityAuditTokenTotalsSchema,
);
export const ObservabilityAuditToolCountsSchema = z.lazy(
  () => results().ObservabilityAuditToolCountsSchema,
);
export const ObservabilityAuditEntrySchema = z.lazy(
  () => results().ObservabilityAuditEntrySchema,
);
export const ObservabilityAuditHistoryResponseSchema = z.lazy(
  () => results().ObservabilityAuditHistoryResponseSchema,
);
export const ObservabilityAuditTranscriptResponseSchema = z.lazy(
  () => results().ObservabilityAuditTranscriptResponseSchema,
);
export const ObservabilityUsageTimeseriesResponseSchema = z.lazy(
  () => results().ObservabilityUsageTimeseriesResponseSchema,
);
export const ObservabilityUsageMetricsResponseSchema = z.lazy(
  () => results().ObservabilityUsageMetricsResponseSchema,
);
export const ObservabilityUsageMetricsViewResponseSchema = z.lazy(
  () => results().ObservabilityUsageMetricsViewResponseSchema,
);
export const ObservabilityUsageTabSummaryResponseSchema = z.lazy(
  () => results().ObservabilityUsageTabSummaryResponseSchema,
);
