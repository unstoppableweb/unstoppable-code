import type { AgentUsageOverview } from '@canopy/desktop-shared/types';
import { selectProviderUsageLimitResumeAt } from '@canopy/desktop-shared/lib/usage-limit-resume-outlook';
import type { PipelineStatusReason } from '@canopy/execution-engine/types/pipeline';

export { selectProviderUsageLimitResumeAt };

function parseFutureResetMs(value: unknown, nowMs: number): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const resetMs = new Date(value).getTime();
  return Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : null;
}

export function selectClaudeUsageLimitResumeAt(
  usage: AgentUsageOverview,
  now: Date = new Date(),
): string | null {
  return selectProviderUsageLimitResumeAt(usage, 'claude', now);
}

/**
 * Select a safe one-time resume timestamp for a group of pipeline usage-limit
 * reasons. Every reason must have a future reset. Native-provider reasons may
 * use the provider usage snapshot as a fallback; AI Credits and local-account
 * reasons must carry their own reset so they are never scheduled against an
 * unrelated native account window.
 */
export function selectPipelineUsageLimitResumeAt(
  reasons: readonly PipelineStatusReason[],
  nativeProviderFallback: string | null,
  now: Date = new Date(),
): string | null {
  if (reasons.length === 0) {
    return null;
  }

  const nowMs = now.getTime();
  const fallbackMs = parseFutureResetMs(nativeProviderFallback, nowMs);
  let latestResetMs = -Infinity;

  for (const reason of reasons) {
    if (reason.kind !== 'provider_usage_limit') {
      return null;
    }
    const explicitResetMs = parseFutureResetMs(reason.resets_at, nowMs);
    const resetMs =
      explicitResetMs ??
      (reason.account_scope === 'native' ? fallbackMs : null);
    if (resetMs === null) {
      return null;
    }
    latestResetMs = Math.max(latestResetMs, resetMs);
  }

  return new Date(latestResetMs).toISOString();
}
