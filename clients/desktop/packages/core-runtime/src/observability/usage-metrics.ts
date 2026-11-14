// Usage metrics and audit history filters over stored records. Pure: callers
// pass the events, the request and the retention setting.
import type {
  AgentAuditEntry,
  AgentAuditHistoryRequest,
  AgentAuditStatus,
  AgentAuditToolCounts,
  ChatTurnUsageEvent,
  UsageBreakdownRow,
  UsageBreakdownRows,
  UsageMetricEvent,
  UsageMetricsRequest,
  UsageMetricsResponse,
  UsageRepoScope,
  UsageStats,
  WorktreeCreatedUsageEvent,
  WorktreePrMergedUsageEvent,
} from '@canopy/protocol/observability';
import { isStartedAtInsideRange } from './audit-days';
import { renamedLabelsForEventType } from './audit-labels';
import { AGENT_AUDIT_TOOL_COUNT_KEYS } from './audit-records';

/** Usage events older than this are dropped on load and pruned from disk. */
export const USAGE_EVENT_RETENTION_DAYS = 365;

export function matchesHistoryRequest(
  entry: AgentAuditEntry,
  request: AgentAuditHistoryRequest,
): boolean {
  if (
    (request.startDate || request.endDate) &&
    !isStartedAtInsideRange(entry.startedAt, request.startDate, request.endDate)
  ) {
    return false;
  }
  if (request.eventType && request.eventType !== 'all') {
    if (entry.eventType !== request.eventType) {
      return false;
    }
  }
  if (request.provider && request.provider !== 'all') {
    if (entry.provider !== request.provider) {
      return false;
    }
  }
  if (request.status && request.status !== 'all') {
    if (entry.status !== request.status) {
      return false;
    }
  }
  if (request.projectId && entry.projectId !== request.projectId) {
    return false;
  }
  if (request.worktreeId && entry.worktreeId !== request.worktreeId) {
    return false;
  }
  if (
    request.pipelineExecutionId &&
    entry.pipelineExecutionId !== request.pipelineExecutionId
  ) {
    return false;
  }
  if (request.activeOnly && entry.status !== 'running') {
    return false;
  }
  if (request.search) {
    const needle = request.search.toLowerCase();
    const haystack = [
      entry.label,
      ...renamedLabelsForEventType(entry.eventType),
      entry.model,
      entry.agentId,
      entry.requestedModel,
      entry.projectId,
      entry.worktreeId,
      entry.chatId,
      entry.repoId,
      entry.repoLabel,
      entry.sdkSessionId,
      entry.pipelineExecutionId,
      entry.jobId,
      entry.stepId,
      entry.error,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) {
      return false;
    }
  }
  return true;
}

export function entryMatchesWorktree(
  entry: Pick<AgentAuditEntry, 'projectId' | 'worktreeId'>,
  projectId: string,
  worktreeId: string,
): boolean {
  return entry.projectId === projectId && entry.worktreeId === worktreeId;
}

export function isUsageEventWithinRetention(event: UsageMetricEvent): boolean {
  const cutoff = Date.now() - USAGE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return new Date(event.timestamp).getTime() >= cutoff;
}

export function isUsageEventInsideRange(
  event: UsageMetricEvent,
  startDate: string,
  endDate: string,
): boolean {
  const timestamp = Date.parse(event.timestamp);
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  return (
    Number.isFinite(timestamp) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    timestamp >= start &&
    timestamp < end
  );
}

function eventRepoScopes(event: UsageMetricEvent): UsageRepoScope[] {
  if ('repos' in event) {
    return event.repos;
  }
  if (event.repoId && event.repoLabel) {
    return [
      {
        workspaceId: event.workspaceId,
        workspaceLabel: event.workspaceLabel,
        worktreeId: event.worktreeId,
        repoId: event.repoId,
        repoLabel: event.repoLabel,
      },
    ];
  }
  return [];
}

export function matchesUsageMetricsRequest(
  event: UsageMetricEvent,
  request: UsageMetricsRequest,
): boolean {
  if (request.workspaceId && event.workspaceId !== request.workspaceId) {
    return false;
  }
  if (
    request.provider &&
    request.provider !== 'all' &&
    event.provider !== request.provider
  ) {
    return false;
  }
  if (
    request.initiationSource &&
    request.initiationSource !== 'all' &&
    event.initiationSource !== request.initiationSource
  ) {
    return false;
  }
  if (request.repoId) {
    const repoMatches =
      event.repoId === request.repoId ||
      eventRepoScopes(event).some((repo) => repo.repoId === request.repoId);
    if (!repoMatches) {
      return false;
    }
  }
  return true;
}

function computeUsageStats(values: number[]): UsageStats | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  // Nearest-rank percentile over the sorted sample set.
  const percentile = (p: number): number =>
    sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    total,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    avg: total / sorted.length,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
  };
}

function buildUsageBreakdown(
  rowsByKey: Map<string, UsageBreakdownRow & { values?: number[] }>,
): UsageBreakdownRows {
  const aggregateStats = computeUsageStats(
    Array.from(rowsByKey.values()).flatMap((row) => row.values ?? [row.count]),
  );
  const rows = Array.from(rowsByKey.values())
    .map((row) => {
      const { values, ...publicRow } = row;
      const stats = computeUsageStats(values ?? [row.count]);
      return {
        ...publicRow,
        ...(stats ? { stats } : {}),
      };
    })
    .sort((left, right) => {
      const countDiff = right.count - left.count;
      return countDiff !== 0
        ? countDiff
        : left.label.localeCompare(right.label);
    });
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    ...(aggregateStats ? { stats: aggregateStats } : {}),
    rows,
  };
}

function incrementUsageRow(
  rows: Map<string, UsageBreakdownRow & { values?: number[] }>,
  row: Omit<UsageBreakdownRow, 'count'>,
  amount = 1,
  sample?: number,
): void {
  const existing = rows.get(row.key);
  if (existing) {
    existing.count += amount;
    if (typeof sample === 'number') {
      existing.values = [...(existing.values ?? []), sample];
    }
    return;
  }
  rows.set(row.key, {
    ...row,
    count: amount,
    ...(typeof sample === 'number' ? { values: [sample] } : {}),
  });
}

function repoRowBase(
  event: UsageMetricEvent,
  repo: UsageRepoScope,
): Omit<UsageBreakdownRow, 'count'> {
  const workspaceLabel = repo.workspaceLabel ?? event.workspaceLabel;
  return {
    key: `${repo.workspaceId}:${repo.repoId}`,
    label: `${workspaceLabel ?? repo.workspaceId} / ${repo.repoLabel}`,
    workspaceId: repo.workspaceId,
    repoId: repo.repoId,
  };
}

function usageRepoMatchesRequest(
  repo: UsageRepoScope,
  request: UsageMetricsRequest,
): boolean {
  return !request.repoId || repo.repoId === request.repoId;
}

function chatDimensionRow(
  event: ChatTurnUsageEvent,
): Omit<UsageBreakdownRow, 'count'> {
  const source = event.initiationSource ?? 'unknown';
  const provider = event.provider;
  const repoKey = event.repoId ?? 'all-repos';
  return {
    key: `${event.workspaceId}:${repoKey}:${provider ?? 'unknown'}:${source}`,
    label: [
      event.workspaceLabel ?? event.workspaceId,
      event.repoLabel,
      provider,
      source,
    ]
      .filter((value): value is string => Boolean(value))
      .join(' / '),
    workspaceId: event.workspaceId,
    repoId: event.repoId,
    provider,
    initiationSource: source,
  };
}

function chatSourceRow(
  event: ChatTurnUsageEvent,
): Omit<UsageBreakdownRow, 'count'> {
  const source = event.initiationSource ?? 'unknown';
  const repoKey = event.repoId ?? 'all-repos';
  return {
    key: `${event.workspaceId}:${repoKey}:${source}`,
    label: [event.workspaceLabel ?? event.workspaceId, event.repoLabel, source]
      .filter((value): value is string => Boolean(value))
      .join(' / '),
    workspaceId: event.workspaceId,
    repoId: event.repoId,
    provider: event.provider,
    initiationSource: source,
  };
}

function chatProviderRow(
  event: ChatTurnUsageEvent,
): Omit<UsageBreakdownRow, 'count'> {
  const provider = event.provider;
  const repoKey = event.repoId ?? 'all-repos';
  return {
    key: `${event.workspaceId}:${repoKey}:${provider ?? 'unknown'}`,
    label: [
      event.workspaceLabel ?? event.workspaceId,
      event.repoLabel,
      provider ?? 'unknown',
    ]
      .filter((value): value is string => Boolean(value))
      .join(' / '),
    workspaceId: event.workspaceId,
    repoId: event.repoId,
    provider,
    initiationSource: event.initiationSource,
  };
}

export function buildUsageMetricsResponse(
  events: UsageMetricEvent[],
  request: UsageMetricsRequest,
  retentionDays: number,
): UsageMetricsResponse {
  const worktreeCreated = new Map<string, UsageBreakdownRow>();
  const worktreeMerged = new Map<string, UsageBreakdownRow>();
  const deletedWithChanges = new Map<string, UsageBreakdownRow>();
  const deletedWithoutChanges = new Map<string, UsageBreakdownRow>();
  const deletionAge = new Map<
    string,
    UsageBreakdownRow & { values?: number[] }
  >();

  const turnCountsPerChat = new Map<string, UsageBreakdownRow>();
  const turnCountsPerWorktree = new Map<string, UsageBreakdownRow>();
  const turnCountsBySource = new Map<string, UsageBreakdownRow>();
  const turnCountsByProvider = new Map<string, UsageBreakdownRow>();
  const turnDuration = new Map<
    string,
    UsageBreakdownRow & { values?: number[] }
  >();
  const toolCallsPerTurn = new Map<
    string,
    UsageBreakdownRow & { values?: number[] }
  >();
  const toolCallsByChat = new Map<
    string,
    { row: Omit<UsageBreakdownRow, 'count'>; count: number }
  >();
  const toolCallsByWorktree = new Map<
    string,
    { row: Omit<UsageBreakdownRow, 'count'>; count: number }
  >();
  const statusCounts = new Map<AgentAuditStatus, number>();
  const toolCategoryCounts = new Map<keyof AgentAuditToolCounts, number>();
  const toolsByProvider = new Map<string, UsageBreakdownRow>();
  const toolsBySource = new Map<string, UsageBreakdownRow>();

  const plansCreated = new Map<string, UsageBreakdownRow>();
  const plansUpdated = new Map<string, UsageBreakdownRow>();
  const plansApproved = new Map<string, UsageBreakdownRow>();
  const createdPerWorktree = new Map<
    string,
    UsageBreakdownRow & { values?: number[] }
  >();
  const updatedPerWorktree = new Map<
    string,
    UsageBreakdownRow & { values?: number[] }
  >();
  const approvedPerWorktree = new Map<
    string,
    UsageBreakdownRow & { values?: number[] }
  >();

  const incrementWorktreeRepos = (
    target: Map<string, UsageBreakdownRow>,
    event: WorktreeCreatedUsageEvent | WorktreePrMergedUsageEvent,
  ): void => {
    for (const repo of event.repos) {
      if (!usageRepoMatchesRequest(repo, request)) {
        continue;
      }
      incrementUsageRow(target, repoRowBase(event, repo));
    }
  };
  const incrementToolAggregate = (
    target: Map<
      string,
      { row: Omit<UsageBreakdownRow, 'count'>; count: number }
    >,
    row: Omit<UsageBreakdownRow, 'count'>,
    amount: number,
  ): void => {
    const existing = target.get(row.key);
    if (existing) {
      existing.count += amount;
      return;
    }
    target.set(row.key, { row, count: amount });
  };

  for (const event of events) {
    if (event.type === 'worktree_created') {
      incrementWorktreeRepos(worktreeCreated, event);
      continue;
    }
    if (event.type === 'worktree_pr_merged') {
      incrementWorktreeRepos(worktreeMerged, event);
      continue;
    }
    if (event.type === 'worktree_deleted') {
      for (const repo of event.repos) {
        if (!usageRepoMatchesRequest(repo, request)) {
          continue;
        }
        const target = repo.hadChanges
          ? deletedWithChanges
          : deletedWithoutChanges;
        incrementUsageRow(target, repoRowBase(event, repo));
        if (typeof event.worktreeAgeMs === 'number') {
          incrementUsageRow(
            deletionAge,
            repoRowBase(event, repo),
            1,
            event.worktreeAgeMs,
          );
        }
      }
      continue;
    }
    if (event.type === 'chat_turn_completed') {
      const source = event.initiationSource ?? 'unknown';
      const provider = event.provider ?? 'unknown';
      const repoKey = event.repoId ?? 'all-repos';
      const chatKey = [
        event.workspaceId,
        event.worktreeId ?? 'no-worktree',
        repoKey,
        provider,
        source,
        event.chatId,
      ].join(':');
      incrementUsageRow(turnCountsPerChat, {
        key: chatKey,
        label: [
          event.workspaceLabel ?? event.workspaceId,
          event.repoLabel,
          event.chatId,
          event.provider,
          event.initiationSource,
        ]
          .filter((value): value is string => Boolean(value))
          .join(' / '),
        workspaceId: event.workspaceId,
        repoId: event.repoId,
        provider: event.provider,
        initiationSource: event.initiationSource,
      });
      if (event.worktreeId) {
        incrementUsageRow(turnCountsPerWorktree, {
          key: [
            event.workspaceId,
            event.worktreeId,
            repoKey,
            provider,
            source,
          ].join(':'),
          label: [
            event.workspaceLabel ?? event.workspaceId,
            event.repoLabel,
            event.worktreeId,
            event.provider,
            event.initiationSource,
          ]
            .filter((value): value is string => Boolean(value))
            .join(' / '),
          workspaceId: event.workspaceId,
          repoId: event.repoId,
          provider: event.provider,
          initiationSource: event.initiationSource,
        });
      }
      incrementUsageRow(turnCountsBySource, chatSourceRow(event));
      incrementUsageRow(turnCountsByProvider, chatProviderRow(event));
      if (typeof event.turnDurationMs === 'number') {
        incrementUsageRow(
          turnDuration,
          chatDimensionRow(event),
          1,
          event.turnDurationMs,
        );
      }
      const toolUseCount = event.toolUseCount ?? 0;
      incrementUsageRow(
        toolCallsPerTurn,
        chatDimensionRow(event),
        1,
        toolUseCount,
      );
      incrementToolAggregate(
        toolCallsByChat,
        {
          key: chatKey,
          label: [
            event.workspaceLabel ?? event.workspaceId,
            event.repoLabel,
            event.chatId,
            event.provider,
            event.initiationSource,
          ]
            .filter((value): value is string => Boolean(value))
            .join(' / '),
          workspaceId: event.workspaceId,
          repoId: event.repoId,
          provider: event.provider,
          initiationSource: event.initiationSource,
        },
        toolUseCount,
      );
      if (event.worktreeId) {
        incrementToolAggregate(
          toolCallsByWorktree,
          {
            key: [
              event.workspaceId,
              event.worktreeId,
              repoKey,
              provider,
              source,
            ].join(':'),
            label: [
              event.workspaceLabel ?? event.workspaceId,
              event.repoLabel,
              event.worktreeId,
              event.provider,
              event.initiationSource,
            ]
              .filter((value): value is string => Boolean(value))
              .join(' / '),
            workspaceId: event.workspaceId,
            repoId: event.repoId,
            provider: event.provider,
            initiationSource: event.initiationSource,
          },
          toolUseCount,
        );
      }
      if (event.status) {
        statusCounts.set(
          event.status,
          (statusCounts.get(event.status) ?? 0) + 1,
        );
      }
      if (event.toolCounts) {
        for (const category of AGENT_AUDIT_TOOL_COUNT_KEYS) {
          // Persisted usage events from before a category was added lack that
          // key, so guard against a non-numeric read to avoid NaN totals.
          const count = event.toolCounts[category];
          if (typeof count !== 'number' || count <= 0) {
            continue;
          }
          toolCategoryCounts.set(
            category,
            (toolCategoryCounts.get(category) ?? 0) + count,
          );
        }
      }
      if (event.provider && toolUseCount > 0) {
        incrementUsageRow(
          toolsByProvider,
          {
            key: event.provider,
            label: event.provider,
            provider: event.provider,
          },
          toolUseCount,
        );
      }
      if (toolUseCount > 0) {
        const toolSource = event.initiationSource ?? 'unknown';
        incrementUsageRow(
          toolsBySource,
          {
            key: toolSource,
            label: toolSource,
            initiationSource: toolSource,
          },
          toolUseCount,
        );
      }
      continue;
    }
    if (
      event.type === 'plan_created' ||
      event.type === 'plan_updated' ||
      event.type === 'plan_approved'
    ) {
      const lifecycleTarget =
        event.type === 'plan_created'
          ? plansCreated
          : event.type === 'plan_updated'
            ? plansUpdated
            : plansApproved;
      const worktreeTarget =
        event.type === 'plan_created'
          ? createdPerWorktree
          : event.type === 'plan_updated'
            ? updatedPerWorktree
            : approvedPerWorktree;
      const source = event.initiationSource ?? 'unknown';
      const provider = event.provider ?? 'unknown';
      incrementUsageRow(lifecycleTarget, {
        key: `${event.workspaceId}:${provider}:${source}`,
        label: `${event.workspaceLabel ?? event.workspaceId} / ${provider} / ${source}`,
        workspaceId: event.workspaceId,
        provider: event.provider,
        initiationSource: source,
      });
      if (event.worktreeId) {
        incrementUsageRow(
          worktreeTarget,
          {
            key: `${event.workspaceId}:${event.worktreeId}:${provider}:${source}`,
            label: `${event.worktreeId} / ${provider} / ${source}`,
            workspaceId: event.workspaceId,
            provider: event.provider,
            initiationSource: source,
          },
          1,
          1,
        );
      }
    }
  }

  const toolCallsPerChat = new Map<
    string,
    UsageBreakdownRow & { values?: number[] }
  >();
  for (const { row, count } of Array.from(toolCallsByChat.values())) {
    incrementUsageRow(toolCallsPerChat, row, count, count);
  }
  const toolCallsPerWorktree = new Map<
    string,
    UsageBreakdownRow & { values?: number[] }
  >();
  for (const { row, count } of Array.from(toolCallsByWorktree.values())) {
    incrementUsageRow(toolCallsPerWorktree, row, count, count);
  }

  return {
    updatedAt: new Date().toISOString(),
    retentionDays,
    worktrees: {
      created: buildUsageBreakdown(worktreeCreated),
      merged: buildUsageBreakdown(worktreeMerged),
      deletedWithChanges: buildUsageBreakdown(deletedWithChanges),
      deletedWithoutChanges: buildUsageBreakdown(deletedWithoutChanges),
      deletionAgeMs: buildUsageBreakdown(deletionAge),
    },
    chats: {
      turnCountsPerChat: buildUsageBreakdown(turnCountsPerChat),
      turnCountsPerWorktree: buildUsageBreakdown(turnCountsPerWorktree),
      turnCountsByInitiationSource: buildUsageBreakdown(turnCountsBySource),
      turnCountsByProvider: buildUsageBreakdown(turnCountsByProvider),
      turnDurationMs: buildUsageBreakdown(turnDuration),
      toolCallsPerTurn: buildUsageBreakdown(toolCallsPerTurn),
      toolCallsPerChat: buildUsageBreakdown(toolCallsPerChat),
      toolCallsPerWorktree: buildUsageBreakdown(toolCallsPerWorktree),
      statusCounts: Array.from(statusCounts.entries()).map(
        ([status, count]) => ({ status, count }),
      ),
    },
    plans: {
      created: buildUsageBreakdown(plansCreated),
      updated: buildUsageBreakdown(plansUpdated),
      approved: buildUsageBreakdown(plansApproved),
      createdPerWorktree: buildUsageBreakdown(createdPerWorktree),
      updatedPerWorktree: buildUsageBreakdown(updatedPerWorktree),
      approvedPerWorktree: buildUsageBreakdown(approvedPerWorktree),
    },
    tools: {
      byCategory: Array.from(toolCategoryCounts.entries()).map(
        ([category, count]) => ({ category, count }),
      ),
      byProvider: buildUsageBreakdown(toolsByProvider),
      byInitiationSource: buildUsageBreakdown(toolsBySource),
    },
  };
}
