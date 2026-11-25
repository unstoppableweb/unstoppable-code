import { subscriptionUsageLimits } from '@canopy/desktop-shared/lib/subscription-usage';
import type {
  AgentUsageOverview,
  NativeAccountProvider,
} from '@canopy/desktop-shared/types';
import { selectProviderUsageLimitResumeAt } from '@/lib/claudeUsageLimitResume';

/**
 * What the latest usage snapshot says about switching back to the provider
 * subscription (CAN-4759). `unknown` covers a failed or timed-out lookup and an
 * exhausted window with no usable reset time: neither proves availability.
 */
export type ProviderLimitLookup =
  | { kind: 'checking' }
  | { kind: 'limited'; resetAt: number }
  | { kind: 'available' }
  | { kind: 'unknown' };

export type SettledProviderLimit = Exclude<
  ProviderLimitLookup,
  { kind: 'checking' }
>;

function hasParsableReset(value: unknown): boolean {
  if (typeof value === 'string') return Number.isFinite(Date.parse(value));
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const epochMs = value < 1_000_000_000_000 ? value * 1000 : value;
  return Number.isFinite(new Date(epochMs).getTime());
}

/**
 * Classifies a usage snapshot for switching back to `provider`'s subscription.
 * Shared by the routing card's reset line and switch confirmation and by the
 * session routing reset lookup, so the saved end time matches the time the
 * card confirms. Ignores overage (`extra_usage`) windows and, given `model`,
 * windows scoped to another model family.
 */
export function classifyProviderUsageSnapshot(
  snapshot: AgentUsageOverview,
  provider: NativeAccountProvider,
  now: number,
  model?: string,
): SettledProviderLimit {
  const summary = snapshot.providers.find(
    (candidate) => candidate.provider === provider,
  );
  if (!summary) return { kind: 'unknown' };
  const rateLimits = subscriptionUsageLimits({
    provider,
    rateLimits: summary.rateLimits,
    model,
    surface: 'claude-code',
  });
  const subscriptionSnapshot = {
    ...snapshot,
    providers: snapshot.providers.map((entry) =>
      entry === summary ? { ...entry, rateLimits: [...rateLimits] } : entry,
    ),
  };

  // Reject epoch values outside Date's range before the shared selector tries
  // to turn them into ISO timestamps.
  if (
    rateLimits.some((limits) =>
      [limits.primary, limits.secondary].some(
        (window) =>
          typeof window?.usedPercent === 'number' &&
          window.usedPercent >= 100 &&
          typeof window.resetsAt === 'number' &&
          !hasParsableReset(window.resetsAt),
      ),
    )
  )
    return { kind: 'unknown' };
  // The farthest exhausted window decides, as for Schedule Resume.
  const resumeAt = selectProviderUsageLimitResumeAt(
    subscriptionSnapshot,
    provider,
    new Date(now),
  );
  const resetAt = resumeAt ? Date.parse(resumeAt) : Number.NaN;
  if (Number.isFinite(resetAt) && resetAt > now) {
    return { kind: 'limited', resetAt };
  }
  // Usage fetches can succeed at the IPC layer while reporting a provider
  // error with retained windows. Only a future exhausted window above remains
  // trustworthy in that case; old headroom is not proof of availability.
  if (summary.error || summary.errorInfo) return { kind: 'unknown' };
  const hasReadableWindow = rateLimits.some((limits) =>
    [limits.primary, limits.secondary].some((window) =>
      Number.isFinite(window?.usedPercent),
    ),
  );
  if (!hasReadableWindow) return { kind: 'unknown' };
  const exhaustedWithoutReset = rateLimits.some((limits) =>
    [limits.primary, limits.secondary].some(
      (window) =>
        typeof window?.usedPercent === 'number' &&
        window.usedPercent >= 100 &&
        !hasParsableReset(window.resetsAt),
    ),
  );
  return exhaustedWithoutReset ? { kind: 'unknown' } : { kind: 'available' };
}
