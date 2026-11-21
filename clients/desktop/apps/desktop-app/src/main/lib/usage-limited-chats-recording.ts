import type {
  AccountChangeResumeReason,
  AgentProviderType,
  UsageLimitedChatEntry,
  WorkspaceType,
} from '@canopy/desktop-shared/types';
import {
  classifyAgentFailure,
  type AgentFailureAccountScope,
} from '@canopy/execution-engine/agent-failures';
import { normalizeEpochMs } from '@canopy/desktop-shared/ai-credits-routing-state';

export interface BuildUsageLimitedEntryInput {
  projectId: string;
  worktreeId: string;
  chatId: string;
  provider: AgentProviderType;
  detectedAt: number;
  interruptedUserMessageId?: string;
  usageResumeAccountEmail?: string;
  resetsAt?: number;
  accountProxyConnectionId?: string;
  resumeReason?: AccountChangeResumeReason;
  workspaceName?: string;
  chatTitle?: string;
  workspaceType?: WorkspaceType;
}

/**
 * Thin, pure snapshot builder for a usage-limited-chats registry entry.
 * Kept separate from the registry's read/write persistence (Task 3) so the
 * detection-site call sites and this shaping logic can be unit-tested
 * without touching the filesystem.
 */
export function buildUsageLimitedEntry(
  input: BuildUsageLimitedEntryInput,
): UsageLimitedChatEntry {
  return {
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    chatId: input.chatId,
    provider: input.provider,
    ...(input.accountProxyConnectionId
      ? { accountProxyConnectionId: input.accountProxyConnectionId }
      : {}),
    detectedAt: input.detectedAt,
    ...(input.usageResumeAccountEmail
      ? { usageResumeAccountEmail: input.usageResumeAccountEmail }
      : {}),
    ...(input.interruptedUserMessageId
      ? { interruptedUserMessageId: input.interruptedUserMessageId }
      : {}),
    ...(typeof input.resetsAt === 'number' ? { resetsAt: input.resetsAt } : {}),
    ...(input.resumeReason ? { resumeReason: input.resumeReason } : {}),
    workspaceName: input.workspaceName ?? '',
    chatTitle: input.chatTitle ?? '',
    ...(input.workspaceType ? { workspaceType: input.workspaceType } : {}),
  };
}

/**
 * Classify a raw provider event for inclusion in account-change resume, with
 * the classifier's usage-limit reset time (ms since epoch) when it has one.
 */
export function classifyAccountChangeResume(
  provider: AgentProviderType,
  event: unknown,
  accountScope: AgentFailureAccountScope,
): { reason: AccountChangeResumeReason; resetsAt?: number } | null {
  if (accountScope !== 'native') {
    return null;
  }
  const classification = classifyAgentFailure({
    provider,
    accountScope,
    events: [event],
    error: event,
  });
  if (classification?.kind === 'provider_authentication_required') {
    return { reason: 'authentication' };
  }
  if (classification?.kind === 'provider_usage_limit') {
    const parsed = classification.resets_at
      ? Date.parse(classification.resets_at)
      : NaN;
    const resetsAt = normalizeEpochMs(parsed);
    return {
      reason: 'usage_limit',
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
  }
  return null;
}

/** Classify a raw provider event for inclusion in account-change resume. */
export function classifyAccountChangeResumeReason(
  provider: AgentProviderType,
  event: unknown,
  accountScope: AgentFailureAccountScope,
): AccountChangeResumeReason | null {
  return (
    classifyAccountChangeResume(provider, event, accountScope)?.reason ?? null
  );
}

/** Proxy limits have their own recovery scope and never change native quota. */
export function buildAccountProxyUsageLimitedEntry(
  input: BuildUsageLimitedEntryInput,
  event: unknown,
): UsageLimitedChatEntry | null {
  if (!input.accountProxyConnectionId) return null;
  const failure = classifyAgentFailure({
    provider: input.provider,
    accountScope: 'native',
    events: [event],
    error: event,
  });
  if (failure?.kind !== 'provider_usage_limit') return null;
  const resetsAt = failure.resets_at ? Date.parse(failure.resets_at) : NaN;
  return buildUsageLimitedEntry({
    ...input,
    resumeReason: 'usage_limit',
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
  });
}
