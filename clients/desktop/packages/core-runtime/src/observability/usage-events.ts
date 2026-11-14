// Sanitizes stored usage metric events: anything that is not a well-formed
// event of a known type is dropped rather than repaired.
import {
  isUsageInitiationSource,
  type AgentAuditStatus,
  type ChatTurnUsageEvent,
  type PipelineRunUsageEvent,
  type PipelineUsageIdentity,
  type PipelineUsageIdentitySource,
  type PlanUsageEvent,
  type UsageInitiationSource,
  type UsageMetricEvent,
  type UsageMetricEventBase,
  type UsageMetricProvider,
  type UsageRepoScope,
  type UsageWorktreeEventType,
  type WorktreeCreatedUsageEvent,
  type WorktreeDeletedUsageEvent,
  type WorktreePrMergedUsageEvent,
} from '@canopy/protocol/observability';
import { parseObservedCost } from './audit-entry-parser';
import {
  defaultToolCounts,
  observedModelIdentity,
  normalizeOptionalAuditTokens,
} from './audit-records';
import {
  isRecord,
  readBoolean,
  readNumber,
  readString,
} from './record-readers';

export function parseUsageEventType(
  value: unknown,
): UsageWorktreeEventType | null {
  switch (value) {
    case 'worktree_created':
    case 'worktree_pr_merged':
    case 'worktree_deleted':
    case 'chat_turn_started':
    case 'chat_turn_completed':
    case 'plan_created':
    case 'plan_updated':
    case 'plan_approved':
    case 'pipeline_run_started':
    case 'pipeline_run_completed':
      return value;
    default:
      return null;
  }
}

export function parseUsageInitiationSource(
  value: unknown,
): UsageInitiationSource | undefined {
  return isUsageInitiationSource(value) ? value : undefined;
}

export function parseUsageMetricProvider(
  value: unknown,
): UsageMetricProvider | undefined {
  switch (value) {
    case 'claude':
    case 'codex':
    case 'ollama':
    case 'cursor':
    case 'opencode':
    case 'pipeline':
      return value;
    default:
      return undefined;
  }
}

export function parsePipelineUsageIdentitySource(
  value: unknown,
): PipelineUsageIdentitySource {
  switch (value) {
    case 'bundled':
    case 'user':
    case 'project':
    case 'shared':
    case 'inline':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

export function parsePipelineRunStatus(
  value: unknown,
): PipelineRunUsageEvent['status'] | undefined {
  switch (value) {
    case 'running':
    case 'success':
    case 'failure':
    case 'cancelled':
      return value;
    default:
      return undefined;
  }
}

export function parseAgentAuditStatus(
  value: unknown,
): AgentAuditStatus | undefined {
  switch (value) {
    case 'running':
    case 'success':
    case 'failure':
    case 'cancelled':
    case 'interrupted':
      return value;
    default:
      return undefined;
  }
}

export function isValidIsoTimestamp(
  value: string | undefined,
): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function normalizeUsageRepoScope(value: unknown): UsageRepoScope | null {
  if (!isRecord(value)) {
    return null;
  }
  const workspaceId = readString(value, 'workspaceId');
  const repoId = readString(value, 'repoId');
  const repoLabel = readString(value, 'repoLabel');
  if (!workspaceId || !repoId || !repoLabel) {
    return null;
  }
  return {
    workspaceId,
    workspaceLabel: readString(value, 'workspaceLabel'),
    worktreeId: readString(value, 'worktreeId'),
    repoId,
    repoLabel,
    repoPath: readString(value, 'repoPath'),
  };
}

export function normalizeDeletedRepoScope(
  value: unknown,
): WorktreeDeletedUsageEvent['repos'][number] | null {
  const scope = normalizeUsageRepoScope(value);
  if (!scope || !isRecord(value)) {
    return null;
  }
  return {
    ...scope,
    hadChanges: readBoolean(value, 'hadChanges') ?? false,
    insertions: readNumber(value, 'insertions') ?? 0,
    deletions: readNumber(value, 'deletions') ?? 0,
    hasUncommittedChanges: readBoolean(value, 'hasUncommittedChanges') ?? false,
    hasCommitsAhead: readBoolean(value, 'hasCommitsAhead') ?? false,
  };
}

export function normalizePipelineUsageIdentity(
  value: unknown,
): PipelineUsageIdentity | null {
  if (!isRecord(value)) {
    return null;
  }

  const key = readString(value, 'key');
  const id = readString(value, 'id');
  const name = readString(value, 'name');
  if (!key || !id || !name) {
    return null;
  }

  return {
    key,
    id,
    name,
    source: parsePipelineUsageIdentitySource(value.source),
  };
}

export function normalizeUsageMetricEvent(
  value: unknown,
): UsageMetricEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value, 'id');
  const type = parseUsageEventType(value.type);
  const timestamp = readString(value, 'timestamp');
  const workspaceId = readString(value, 'workspaceId');
  if (
    value.version !== 1 ||
    !id ||
    !type ||
    !isValidIsoTimestamp(timestamp) ||
    !workspaceId
  ) {
    return null;
  }

  const base: UsageMetricEventBase = {
    version: 1,
    id,
    type,
    timestamp,
    workspaceId,
    workspaceLabel: readString(value, 'workspaceLabel'),
    worktreeId: readString(value, 'worktreeId'),
    repoId: readString(value, 'repoId'),
    repoLabel: readString(value, 'repoLabel'),
    provider: parseUsageMetricProvider(value.provider),
    initiationSource: parseUsageInitiationSource(value.initiationSource),
  };

  if (type === 'worktree_created') {
    const repos = Array.isArray(value.repos)
      ? value.repos
          .map((entry) => normalizeUsageRepoScope(entry))
          .filter((entry): entry is UsageRepoScope => entry !== null)
      : [];
    const worktreeCreatedAt =
      readString(value, 'worktreeCreatedAt') ?? timestamp;
    return {
      ...base,
      type,
      worktreeCreatedAt,
      repos,
    } satisfies WorktreeCreatedUsageEvent;
  }

  if (type === 'worktree_pr_merged') {
    const repos = Array.isArray(value.repos)
      ? value.repos
          .map((entry) => normalizeUsageRepoScope(entry))
          .filter((entry): entry is UsageRepoScope => entry !== null)
      : [];
    return {
      ...base,
      type,
      prNumber: readNumber(value, 'prNumber'),
      prUrl: readString(value, 'prUrl'),
      mergedAt: readString(value, 'mergedAt'),
      repos,
    } satisfies WorktreePrMergedUsageEvent;
  }

  if (type === 'worktree_deleted') {
    const repos = Array.isArray(value.repos)
      ? value.repos
          .map((entry) => normalizeDeletedRepoScope(entry))
          .filter(
            (entry): entry is WorktreeDeletedUsageEvent['repos'][number] =>
              entry !== null,
          )
      : [];
    return {
      ...base,
      type,
      deletedWithChanges: readBoolean(value, 'deletedWithChanges') ?? false,
      worktreeAgeMs: readNumber(value, 'worktreeAgeMs'),
      repos,
    } satisfies WorktreeDeletedUsageEvent;
  }

  if (type === 'pipeline_run_started' || type === 'pipeline_run_completed') {
    const pipelineExecutionId = readString(value, 'pipelineExecutionId');
    const pipelineId = readString(value, 'pipelineId');
    const pipelineName = readString(value, 'pipelineName');
    const pipelineIdentityKey = readString(value, 'pipelineIdentityKey');
    const pipeline = normalizePipelineUsageIdentity(value.pipeline);
    const runStartedAt = readString(value, 'runStartedAt');
    const runCompletedAtRaw = readString(value, 'runCompletedAt');

    if (
      !pipelineExecutionId ||
      !pipelineId ||
      !pipelineName ||
      !pipelineIdentityKey ||
      !pipeline ||
      !isValidIsoTimestamp(runStartedAt)
    ) {
      return null;
    }

    return {
      ...base,
      type,
      pipelineExecutionId,
      pipeline,
      pipelineId,
      pipelineName,
      pipelineIdentityKey,
      eventName: readString(value, 'eventName'),
      triggerSource: readString(value, 'triggerSource'),
      runStartedAt,
      runCompletedAt: isValidIsoTimestamp(runCompletedAtRaw)
        ? runCompletedAtRaw
        : undefined,
      runDurationMs: readNumber(value, 'runDurationMs'),
      status: parsePipelineRunStatus(value.status),
      jobCount: readNumber(value, 'jobCount'),
      stepCount: readNumber(value, 'stepCount'),
      agentStepCount: readNumber(value, 'agentStepCount'),
      retryCount: readNumber(value, 'retryCount'),
      parentExecutionId: readString(value, 'parentExecutionId'),
      rerunSourceId: readString(value, 'rerunSourceId'),
      hidden: readBoolean(value, 'hidden'),
    } satisfies PipelineRunUsageEvent;
  }

  if (type === 'chat_turn_started' || type === 'chat_turn_completed') {
    const chatId = readString(value, 'chatId');
    const turnStartedAt = readString(value, 'turnStartedAt');
    if (!chatId || !isValidIsoTimestamp(turnStartedAt)) {
      return null;
    }
    const rawToolCounts = value.toolCounts;
    const toolCounts = isRecord(rawToolCounts)
      ? {
          ...defaultToolCounts(),
          ...Object.fromEntries(
            Object.entries(defaultToolCounts()).map(([key]) => [
              key,
              readNumber(rawToolCounts, key) ?? 0,
            ]),
          ),
        }
      : undefined;
    return {
      ...base,
      type,
      chatId,
      auditEntryId: readString(value, 'auditEntryId'),
      ...observedModelIdentity({
        model: readString(value, 'model'),
        agentId: readString(value, 'agentId'),
      }),
      turnStartedAt,
      turnCompletedAt: readString(value, 'turnCompletedAt'),
      turnDurationMs: readNumber(value, 'turnDurationMs'),
      turnIndexInChat: readNumber(value, 'turnIndexInChat'),
      turnIndexInWorktree: readNumber(value, 'turnIndexInWorktree'),
      tokens: normalizeOptionalAuditTokens(value.tokens),
      totalCostUsd: readNumber(value, 'totalCostUsd'),
      observedCost: parseObservedCost(value.observedCost),
      toolUseCount: readNumber(value, 'toolUseCount'),
      toolCounts,
      status: parseAgentAuditStatus(value.status),
      error: readString(value, 'error'),
    } satisfies ChatTurnUsageEvent;
  }

  const planId = readString(value, 'planId');
  if (!planId) {
    return null;
  }
  return {
    ...base,
    type,
    chatId: readString(value, 'chatId'),
    auditEntryId: readString(value, 'auditEntryId'),
    planId,
    planVersion: readNumber(value, 'planVersion'),
    planTextBytes: readNumber(value, 'planTextBytes'),
    planLineCount: readNumber(value, 'planLineCount'),
  } satisfies PlanUsageEvent;
}
