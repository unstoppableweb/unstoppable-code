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
// ---------------------------------------------------------------------------

import {
  ORG_PROHIBITABLE_USAGE_DATA_KEYS,
  USAGE_DATA_KEYS,
  type OrgProhibitableUsageDataKey,
  type UsageDataPolicySnapshot,
  type UsageDataPreferences,
} from '@canopy/desktop-shared/types';
import type { OrgUsageDataProhibition } from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';

export type UsageDataProhibitionState =
  | ReadonlyMap<string, OrgUsageDataProhibition>
  | 'unreadable';

/**
 * The member's stored choices, or `'unreadable'` when they can't be read, so
 * their own opt-out is unknown: every org-prohibitable key stays off, with
 * `preferencesUnreadable` attribution, until real preferences replace it.
 */
export type UsageDataPreferencesState = UsageDataPreferences | 'unreadable';

export interface UsageDataPolicy {
  getEffectiveUsageDataPolicy(): UsageDataPreferences;
  getUsageDataPolicySnapshot(): UsageDataPolicySnapshot;
  /** True once the selected Personal or organization context is known. */
  hasWorkspaceContext(): boolean;
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
  /** Replace the stored preferences with the full normalized object. */
  setPreferences(preferences: UsageDataPreferencesState): void;
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

/** Every flow on: the default preferences and the fallback before init. */
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

function buildSnapshot(
  preferences: UsageDataPreferencesState,
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
  return { preferences: { ...stored }, effective, prohibitedBy };
}

function sameSnapshotPolicy(
  left: UsageDataPolicySnapshot,
  right: UsageDataPolicySnapshot,
): boolean {
  return (
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
  prohibitions?: UsageDataProhibitionState;
  settleTimeoutMs?: number;
}): UsageDataPolicy {
  let preferences: UsageDataPreferencesState =
    options?.preferences ?? defaultUsageDataPreferences();
  let prohibitions: UsageDataProhibitionState =
    options?.prohibitions ?? new Map();
  let context: WorkspaceContext | null = null;
  let snapshot = buildSnapshot(preferences, prohibitions, context);
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

  const recompute = (): boolean => {
    const next = buildSnapshot(preferences, prohibitions, context);
    const changed = !sameSnapshotPolicy(snapshot, next);
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
 * Seed the process-wide policy at startup. Reads that fail before this runs
 * see every flow on, which only `getUsageDataPolicy()` callers created before
 * startup could observe; startup initializes it before any gated flow starts.
 */
export function initializeUsageDataPolicy(
  preferences: UsageDataPreferencesState,
  prohibitions: UsageDataProhibitionState,
): UsageDataPolicy {
  if (singleton) {
    singleton.setPreferences(preferences);
    singleton.setProhibitionsByOrganization(prohibitions);
    return singleton;
  }
  singleton = createUsageDataPolicy({ preferences, prohibitions });
  return singleton;
}

export function getUsageDataPolicy(): UsageDataPolicy {
  singleton ??= createUsageDataPolicy();
  return singleton;
}

export function getEffectiveUsageDataPolicy(): UsageDataPreferences {
  return getUsageDataPolicy().getEffectiveUsageDataPolicy();
}

export function __resetUsageDataPolicyForTests(): void {
  singleton = null;
}
