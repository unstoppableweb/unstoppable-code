// ---------------------------------------------------------------------------
// Main-owned effective usage-data policy: the single answer to "may this flow
// send?" for PostHog events and errors, session replay, the active-use turn
// signal, LaunchDarkly identity, and the skill safety check.
//
//   effective[key] = preferences[key] && !prohibited[key]
//
// `prohibited` comes from the selected workspace context's organization
// `usage-data` policy. Personal context prohibits nothing, and an organization
// missing from the resolved map prohibits nothing until the next probe. An
// unreadable stored account fails closed: every org-prohibitable key stays
// off until a successful policy check replaces the state.
//
// Before the selected context is known (startup), the org component is
// conservative: a key is prohibited when any organization in the stored
// account prohibits it. `whenSettled()` resolves on the first context-based
// recompute, when context initialization fails, or after a bounded timeout,
// so PostHog startup can never hang on it.
//
// An organization prohibition never rewrites the member's stored preference.
//
// Nothing sends before the first-run legal consent: while it is pending and
// the stored preferences are readable, every key is off (`consentPending`),
// with no `prohibitedBy` attribution. Consent and preferences change together
// through `setStored`, so accepting with a flow off never starts it on the
// stale defaults first.
// ---------------------------------------------------------------------------

import {
  ORG_PROHIBITABLE_USAGE_DATA_KEYS,
  USAGE_DATA_KEYS,
  type OrgProhibitableUsageDataKey,
  type PreferencesData,
  type UsageDataPolicySnapshot,
  type UsageDataPreferences,
} from '@canopy/desktop-shared/types';
import { hasAcceptedLegalConsent } from '@canopy/desktop-shared/lib/legal-consent';
import type { OrgUsageDataProhibition } from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { allowsAutomaticCall } from '../local-only/policy';

export type UsageDataProhibitionState =
  | ReadonlyMap<string, OrgUsageDataProhibition>
  | 'unreadable';

/**
 * The member's stored choices, or `'unreadable'` when they can't be read, so
 * their own opt-out is unknown: every org-prohibitable key stays off, with
 * `preferencesUnreadable` attribution, until real preferences replace it.
 */
export type UsageDataPreferencesState = UsageDataPreferences | 'unreadable';

/**
 * The first-run consent facts the policy needs, kept beside (not inside) the
 * usage-data preferences so the journal deny path can rebuild preferences
 * from the snapshot unchanged.
 */
export interface UsageDataConsentState {
  /** `legalConsentAcceptedAt` is recorded. */
  readonly accepted: boolean;
  /** Main-derived `usageAnalyticsDeclinedAtOnboarding`. */
  readonly analyticsDeclinedAtOnboarding: boolean;
}

/** Nothing accepted yet: the default until stored preferences are read. */
export const PENDING_USAGE_DATA_CONSENT: UsageDataConsentState = {
  accepted: false,
  analyticsDeclinedAtOnboarding: false,
};

/** Consent derived from the same committed object `usageData` comes from. */
export function usageDataConsentStateOf(
  preferences: Pick<
    PreferencesData,
    'legalConsentAcceptedAt' | 'usageAnalyticsDeclinedAtOnboarding'
  >,
): UsageDataConsentState {
  return {
    accepted: hasAcceptedLegalConsent(preferences),
    analyticsDeclinedAtOnboarding:
      preferences.usageAnalyticsDeclinedAtOnboarding === true,
  };
}

export interface UsageDataPolicy {
  getEffectiveUsageDataPolicy(): UsageDataPreferences;
  getUsageDataPolicySnapshot(): UsageDataPolicySnapshot;
  /** True once the selected Personal or organization context is known. */
  hasWorkspaceContext(): boolean;
  /**
   * True while the stored account's organization policy can't be read, so the
   * org-prohibitable keys are off with no organization to attribute. An
   * organization prohibition that is known never reports here.
   */
  isOrganizationPolicyUnreadable(): boolean;
  /**
   * True while legal consent is not recorded and the stored preferences are
   * readable, so every flow is off. Unreadable preferences never report here.
   */
  isConsentPending(): boolean;
  /** True when the member declined Usage analytics on the Welcome gate. */
  wasAnalyticsDeclinedAtOnboarding(): boolean;
  /**
   * The effective value of `key`, also narrowed by the prohibition of the
   * organization that owns the work, when one is known. For per-item reports
   * that carry their owner: the selected context alone would let work owned
   * by a prohibiting organization report while Personal is selected.
   */
  allowsForOrganization(
    key: OrgProhibitableUsageDataKey,
    ownerOrganizationId: string | undefined,
  ): boolean;
  /** Fires on effective policy changes and optionally on stored Error reports changes. */
  subscribe(
    listener: (snapshot: UsageDataPolicySnapshot) => void,
    options?: { includeErrorReportsPreference?: boolean },
  ): () => void;
  /**
   * Replace the stored preferences with the full normalized object, keeping
   * the consent state. For the journal deny path only; committed saves use
   * `setStored`.
   */
  setPreferences(preferences: UsageDataPreferencesState): void;
  /**
   * Replace the stored preferences and the consent state in one recompute.
   * Never set them in two calls: a consent flip seen before the choices would
   * start flows on stale values.
   */
  setStored(
    preferences: UsageDataPreferencesState,
    consent: UsageDataConsentState,
  ): void;
  /**
   * Replace the per-organization prohibitions. A successful probe always
   * replaces `'unreadable'`, even with an empty map. Returns whether the
   * effective policy or its attribution changed.
   */
  setProhibitionsByOrganization(state: UsageDataProhibitionState): boolean;
  /** Resolve by the selected workspace context from now on. */
  setWorkspaceContext(context: WorkspaceContext): void;
  /**
   * Settle without a context (initialization failed). The conservative value
   * stays in place until a context arrives.
   */
  settleWithoutContext(): void;
  whenSettled(): Promise<void>;
}

export const USAGE_DATA_POLICY_SETTLE_TIMEOUT_MS = 10_000;

/** Every flow on: the default stored preferences (pre-checked, inactive until consent). */
export function defaultUsageDataPreferences(): UsageDataPreferences {
  return {
    productAnalytics: true,
    sessionReplay: true,
    errorReports: true,
    activeUseSignal: true,
    featureFlagIdentity: true,
    skillSafetyCheck: true,
  };
}

function resolveProhibitedBy(
  preferences: UsageDataPreferencesState,
  prohibitions: UsageDataProhibitionState,
  context: WorkspaceContext | null,
): UsageDataPolicySnapshot['prohibitedBy'] {
  const prohibitedBy: UsageDataPolicySnapshot['prohibitedBy'] = {};
  // Unreadable preferences take precedence: every prohibitable key is off
  // either way, and this state outlasts an account or organization one. Skill
  // safety check stays on: it protects the member, like the updater fallback.
  if (preferences === 'unreadable') {
    for (const key of ORG_PROHIBITABLE_USAGE_DATA_KEYS) {
      prohibitedBy[key] = {
        organizationName: null,
        preferencesUnreadable: true,
      };
    }
    return prohibitedBy;
  }
  if (prohibitions === 'unreadable') {
    for (const key of ORG_PROHIBITABLE_USAGE_DATA_KEYS) {
      prohibitedBy[key] = { organizationName: null };
    }
    return prohibitedBy;
  }
  if (context === null) {
    // Conservative startup: any organization's prohibition applies.
    for (const entry of prohibitions.values()) {
      for (const key of ORG_PROHIBITABLE_USAGE_DATA_KEYS) {
        if (entry.prohibited[key] && !prohibitedBy[key]) {
          prohibitedBy[key] = { organizationName: entry.organizationName };
        }
      }
    }
    return prohibitedBy;
  }
  if (context.kind === 'personal') return prohibitedBy;
  const organizationId = normalizeUuid(context.organizationId);
  const entry = organizationId ? prohibitions.get(organizationId) : undefined;
  if (!entry) return prohibitedBy;
  for (const key of ORG_PROHIBITABLE_USAGE_DATA_KEYS) {
    if (entry.prohibited[key]) {
      prohibitedBy[key] = { organizationName: entry.organizationName };
    }
  }
  return prohibitedBy;
}

function isPending(
  preferences: UsageDataPreferencesState,
  consent: UsageDataConsentState,
): boolean {
  // Unreadable preferences keep today's fail-closed shape exactly (Skill
  // safety check on); treating them as pending would turn it off for
  // existing members in a latched recovery.
  return preferences !== 'unreadable' && !consent.accepted;
}

function buildSnapshot(
  preferences: UsageDataPreferencesState,
  consent: UsageDataConsentState,
  prohibitions: UsageDataProhibitionState,
  context: WorkspaceContext | null,
): UsageDataPolicySnapshot {
  const prohibitedBy = resolveProhibitedBy(preferences, prohibitions, context);
  const stored =
    preferences === 'unreadable' ? defaultUsageDataPreferences() : preferences;
  const effective = { ...stored };
  for (const key of ORG_PROHIBITABLE_USAGE_DATA_KEYS) {
    if (prohibitedBy[key]) effective[key] = false;
  }
  // A local-only build never sends the active-use signal.
  if (!allowsAutomaticCall('telemetry.active-use-signal')) {
    effective.activeUseSignal = false;
  }
  const consentPending = isPending(preferences, consent);
  // Nothing sends before consent, Skill safety check included. No
  // `prohibitedBy` entry: no organization or unreadable file did this.
  if (consentPending) {
    for (const key of USAGE_DATA_KEYS) effective[key] = false;
  }
  return {
    preferences: { ...stored },
    effective,
    prohibitedBy,
    ...(consentPending ? { consentPending: true as const } : {}),
  };
}

function sameSnapshotPolicy(
  left: UsageDataPolicySnapshot,
  right: UsageDataPolicySnapshot,
): boolean {
  return (
    left.consentPending === right.consentPending &&
    USAGE_DATA_KEYS.every(
      (key) => left.effective[key] === right.effective[key],
    ) &&
    ORG_PROHIBITABLE_USAGE_DATA_KEYS.every((key) => {
      const a = left.prohibitedBy[key];
      const b = right.prohibitedBy[key];
      return a === undefined
        ? b === undefined
        : b !== undefined &&
            a.organizationName === b.organizationName &&
            a.preferencesUnreadable === b.preferencesUnreadable;
    })
  );
}

export function createUsageDataPolicy(options?: {
  preferences?: UsageDataPreferencesState;
  /** Defaults to consent pending: nothing sends until consent is recorded. */
  consent?: UsageDataConsentState;
  prohibitions?: UsageDataProhibitionState;
  settleTimeoutMs?: number;
}): UsageDataPolicy {
  let preferences: UsageDataPreferencesState =
    options?.preferences ?? defaultUsageDataPreferences();
  let consent: UsageDataConsentState =
    options?.consent ?? PENDING_USAGE_DATA_CONSENT;
  let prohibitions: UsageDataProhibitionState =
    options?.prohibitions ?? new Map();
  let context: WorkspaceContext | null = null;
  let snapshot = buildSnapshot(preferences, consent, prohibitions, context);
  const listeners = new Map<
    (snapshot: UsageDataPolicySnapshot) => void,
    boolean
  >();

  let resolveSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const settleTimer = setTimeout(
    () => resolveSettled(),
    options?.settleTimeoutMs ?? USAGE_DATA_POLICY_SETTLE_TIMEOUT_MS,
  );
  settleTimer.unref?.();
  const settle = (): void => {
    clearTimeout(settleTimer);
    resolveSettled();
  };

  // The declined flag lives outside the snapshot; a change must still wake
  // subscribers (the opt-out ping) like an effective change does.
  let lastDeclined = consent.analyticsDeclinedAtOnboarding;
  const recompute = (): boolean => {
    const next = buildSnapshot(preferences, consent, prohibitions, context);
    const declinedChanged =
      lastDeclined !== consent.analyticsDeclinedAtOnboarding;
    lastDeclined = consent.analyticsDeclinedAtOnboarding;
    const changed = !sameSnapshotPolicy(snapshot, next) || declinedChanged;
    const errorReportsPreferenceChanged =
      snapshot.preferences.errorReports !== next.preferences.errorReports;
    snapshot = next;
    if (!changed && !errorReportsPreferenceChanged) return false;
    for (const [listener, includeErrorReportsPreference] of Array.from(
      listeners,
    )) {
      if (!changed && !includeErrorReportsPreference) continue;
      try {
        listener(next);
      } catch {
        // A failing consumer cannot block the others.
      }
    }
    return changed;
  };

  return {
    getEffectiveUsageDataPolicy: () => ({ ...snapshot.effective }),
    hasWorkspaceContext: () => context !== null,
    isOrganizationPolicyUnreadable: () => prohibitions === 'unreadable',
    isConsentPending: () => snapshot.consentPending === true,
    wasAnalyticsDeclinedAtOnboarding: () =>
      consent.analyticsDeclinedAtOnboarding,
    allowsForOrganization(key, ownerOrganizationId): boolean {
      if (!snapshot.effective[key]) return false;
      if (prohibitions === 'unreadable') return false;
      const owner =
        ownerOrganizationId === undefined
          ? null
          : normalizeUuid(ownerOrganizationId);
      return !(owner && prohibitions.get(owner)?.prohibited[key] === true);
    },
    getUsageDataPolicySnapshot: () => ({
      preferences: { ...snapshot.preferences },
      effective: { ...snapshot.effective },
      prohibitedBy: { ...snapshot.prohibitedBy },
      ...(snapshot.consentPending ? { consentPending: true as const } : {}),
    }),
    subscribe(listener, options): () => void {
      listeners.set(listener, options?.includeErrorReportsPreference === true);
      return (): void => {
        listeners.delete(listener);
      };
    },
    setPreferences(next): void {
      preferences = next === 'unreadable' ? next : { ...next };
      recompute();
    },
    setStored(nextPreferences, nextConsent): void {
      preferences =
        nextPreferences === 'unreadable'
          ? nextPreferences
          : { ...nextPreferences };
      consent = { ...nextConsent };
      recompute();
    },
    setProhibitionsByOrganization(next): boolean {
      prohibitions = next;
      return recompute();
    },
    setWorkspaceContext(next): void {
      context = next;
      recompute();
      settle();
    },
    settleWithoutContext(): void {
      settle();
    },
    whenSettled: () => settled,
  };
}

let singleton: UsageDataPolicy | null = null;

/**
 * Seed the process-wide policy at startup. Reads before this runs see every
 * flow off (consent pending), which only `getUsageDataPolicy()` callers
 * created before startup could observe; startup initializes it before any
 * gated flow starts.
 */
export function initializeUsageDataPolicy(
  preferences: UsageDataPreferencesState,
  consent: UsageDataConsentState,
  prohibitions: UsageDataProhibitionState,
): UsageDataPolicy {
  if (singleton) {
    // Prohibitions first: a pre-init singleton is consent pending (all off),
    // so applying them first keeps every flow off until the stored choices
    // land, instead of briefly enabling organization-prohibited flows.
    singleton.setProhibitionsByOrganization(prohibitions);
    singleton.setStored(preferences, consent);
    return singleton;
  }
  singleton = createUsageDataPolicy({ preferences, consent, prohibitions });
  return singleton;
}

export function getUsageDataPolicy(): UsageDataPolicy {
  singleton ??= createUsageDataPolicy();
  return singleton;
}

export function getEffectiveUsageDataPolicy(): UsageDataPreferences {
  return getUsageDataPolicy().getEffectiveUsageDataPolicy();
}

/**
 * Clear the singleton. With `seed`, replace it with a policy built from those
 * options (pass `consent` to model a profile that accepted legal consent).
 */
export function __resetUsageDataPolicyForTests(
  seed?: Parameters<typeof createUsageDataPolicy>[0],
): void {
  singleton = seed ? createUsageDataPolicy(seed) : null;
}
