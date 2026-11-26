// ---------------------------------------------------------------------------
// Startup and lifecycle wiring for the main-owned usage-data policy
// (`./usage-data-policy`). Kept apart from the policy so the policy itself
// stays free of the account store, the workspace-context service, and the
// flag service.
// ---------------------------------------------------------------------------

import type { UsageDataPreferences } from '@canopy/desktop-shared/types';
import {
  arePreferencesUnconfirmed,
  readPreferencesFile,
} from './preferences-store';
import {
  loadStoredUsageDataProhibitionByOrganization,
  recordTelemetryEnforcementReadFailure,
} from './telemetry-enforcement-state';
import {
  getUsageDataPolicy,
  initializeUsageDataPolicy,
  PENDING_USAGE_DATA_CONSENT,
  usageDataConsentStateOf,
  type UsageDataConsentState,
  type UsageDataPolicy,
  type UsageDataPreferencesState,
  type UsageDataProhibitionState,
} from './usage-data-policy';
import type { WorkspaceContextService } from './workspace-context-service';

/** Delay before retrying a startup preferences read that rejected outright. */
export const USAGE_DATA_PREFERENCES_RETRY_MS = 5_000;

/** The stored choices with the consent read from the same document. */
type StoredUsageDataState =
  | {
      readonly usageData: UsageDataPreferences;
      readonly consent: UsageDataConsentState;
    }
  | 'unreadable';

/**
 * Read the member's stored choices and consent for the policy. A latched
 * failed recovery serves defaults or a last-good copy that may predate the
 * latest save, so it is `'unreadable'` too; the latch refuses saves until
 * restart.
 */
async function readUsageDataPreferencesState(): Promise<StoredUsageDataState> {
  const stored = await readPreferencesFile();
  return arePreferencesUnconfirmed()
    ? 'unreadable'
    : { usageData: stored.usageData, consent: usageDataConsentStateOf(stored) };
}

function preferencesOf(state: StoredUsageDataState): UsageDataPreferencesState {
  return state === 'unreadable' ? 'unreadable' : state.usageData;
}

function consentOf(state: StoredUsageDataState): UsageDataConsentState {
  return state === 'unreadable' ? PENDING_USAGE_DATA_CONSENT : state.consent;
}

/**
 * A read that rejected outright (say, a transient I/O error) gets one retry,
 * since the locked Usage data rows can't save to end it. The retry applies
 * only while the policy still holds the fail-closed state, so a committed
 * save in the meantime always wins.
 */
function retryRejectedPreferencesRead(): void {
  const timer = setTimeout((): void => {
    void readUsageDataPreferencesState().then(
      (state): void => {
        const policy = getUsageDataPolicy();
        const stillUnreadable =
          policy.getUsageDataPolicySnapshot().prohibitedBy.productAnalytics
            ?.preferencesUnreadable === true;
        if (stillUnreadable && state !== 'unreadable') {
          policy.setStored(state.usageData, state.consent);
        }
      },
      (): void => undefined,
    );
  }, USAGE_DATA_PREFERENCES_RETRY_MS);
  timer.unref?.();
}

/**
 * Seed the policy before any gated flow starts: the stored preferences and
 * the stored account's per-organization prohibitions. An unreadable account
 * fails closed (`'unreadable'`) until the first successful policy check, and
 * unreadable preferences keep the prohibitable flows off.
 */
export async function initializeStartupUsageDataPolicy(): Promise<void> {
  // Independent reads on the startup path: run them together.
  const [preferences, prohibitions] = await Promise.all([
    // The member's own opt-out may be what we failed to read: keep the
    // prohibitable flows off until real preferences replace this.
    readUsageDataPreferencesState().catch((): StoredUsageDataState => {
      retryRejectedPreferencesRead();
      return 'unreadable';
    }),
    loadStoredUsageDataProhibitionByOrganization().catch(
      (error: unknown): UsageDataProhibitionState => {
        recordTelemetryEnforcementReadFailure(
          'usage-data-policy-startup',
          error,
        );
        return 'unreadable';
      },
    ),
  ]);
  initializeUsageDataPolicy(
    preferencesOf(preferences),
    consentOf(preferences),
    prohibitions,
  );
}

/**
 * Resolve by the selected workspace context once it is known, and on every
 * later switch. Shares the service's memoized initialization; a failed
 * initialization settles the policy with the conservative startup value so
 * nothing waits on it.
 */
export function attachUsageDataPolicyToWorkspaceContext(
  service: Pick<
    WorkspaceContextService,
    'initialize' | 'getState' | 'subscribe'
  >,
): void {
  const policy = getUsageDataPolicy();
  void service.initialize().then(
    (): void => {
      service.subscribe((state): void => {
        policy.setWorkspaceContext(state.context);
      });
      policy.setWorkspaceContext(service.getState().context);
    },
    (): void => {
      policy.settleWithoutContext();
    },
  );
}

/**
 * Keep the main PostHog client in step with the effective usage-data policy:
 * no client (and no `posthog-context.json`) while both Usage analytics and
 * Error reports are off, a client while either is on. Waits for the policy to
 * settle on the selected context so a conservative startup value never sends
 * `desktop:app_start` for a member whose context allows it, or the reverse.
 * `suspend` serializes with initialization inside the instrumentation package.
 */
export function installPostHogMainLifecycle(
  policy: Pick<
    UsageDataPolicy,
    'whenSettled' | 'getEffectiveUsageDataPolicy' | 'subscribe'
  >,
  suspend: () => Promise<void>,
  start: () => void,
): void {
  let active = false;
  const sync = (effective: UsageDataPreferences): void => {
    const wanted = effective.productAnalytics || effective.errorReports;
    if (wanted === active) return;
    active = wanted;
    if (wanted) start();
    else void suspend();
  };
  void policy.whenSettled().then((): void => {
    sync(policy.getEffectiveUsageDataPolicy());
    policy.subscribe((snapshot): void => sync(snapshot.effective));
  });
}

/**
 * Re-identify LaunchDarkly whenever the effective Personalized feature
 * rollouts choice flips, so the context switches between full and anonymous.
 * `getBuiltIdentity` reports the choice the latest context was built with
 * (null before any build). Refreshes repeat until it matches the effective
 * choice, because `refreshContext` joins a refresh already in flight, whose
 * context may predate the flip.
 */
export function installUsageDataPolicyFeatureFlagRefresh(
  refreshContext: () => Promise<unknown>,
  getBuiltIdentity: () => boolean | null,
): () => void {
  const policy = getUsageDataPolicy();
  const stale = (): boolean => {
    const built = getBuiltIdentity();
    return (
      built !== null &&
      built !== policy.getEffectiveUsageDataPolicy().featureFlagIdentity
    );
  };
  let reconciling = false;
  const reconcile = async (): Promise<void> => {
    if (reconciling) return;
    reconciling = true;
    try {
      for (let attempt = 0; attempt < 3 && stale(); attempt++) {
        await refreshContext().catch(() => undefined);
      }
    } finally {
      reconciling = false;
    }
  };
  const unsubscribe = policy.subscribe((): void => void reconcile());
  void reconcile();
  return unsubscribe;
}
