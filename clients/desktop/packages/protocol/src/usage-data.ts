/**
 * The usage-data switches under Settings → Privacy → Usage data. Every flow
 * defaults on; turning one off stops that flow. The main-process usage-data
 * policy combines these with the selected organization's prohibitions.
 */
export const USAGE_DATA_KEYS = [
  'productAnalytics',
  'sessionReplay',
  'errorReports',
  'activeUseSignal',
  'featureFlagIdentity',
  'skillSafetyCheck',
] as const;

/** One usage-data switch. */
export type UsageDataKey = (typeof USAGE_DATA_KEYS)[number];

/**
 * The usage-data switches an organization admin can turn off for members.
 * Prohibitions only narrow; they never turn a flow on. The skill safety check
 * is the member's choice alone.
 */
export const ORG_PROHIBITABLE_USAGE_DATA_KEYS = [
  'productAnalytics',
  'sessionReplay',
  'errorReports',
  'activeUseSignal',
  'featureFlagIdentity',
] as const satisfies readonly UsageDataKey[];

/** One usage-data switch an organization can prohibit. */
export type OrgProhibitableUsageDataKey =
  (typeof ORG_PROHIBITABLE_USAGE_DATA_KEYS)[number];

/** The member's stored usage-data choices. `true` means the flow may send. */
export type UsageDataPreferences = Record<UsageDataKey, boolean>;

/** Why a usage-data flow is turned off by policy rather than by the member. */
export interface UsageDataProhibitionSource {
  /**
   * The organization that turned it off, or `null` while main fails closed:
   * the stored account can't be read (until the next successful policy
   * check), or, with `preferencesUnreadable`, the stored preferences can't.
   */
  organizationName: string | null;
  /**
   * Set while the member's stored preferences can't be read, so their own
   * opt-out is unknown. Lasts until a preferences save or restart.
   */
  preferencesUnreadable?: true;
}

/**
 * Main's effective usage-data policy, as delivered to renderers. `effective`
 * is `preferences` narrowed by `prohibitedBy`, resolved for the selected
 * workspace context.
 */
export interface UsageDataPolicySnapshot {
  /**
   * The stored choices. While they can't be read this holds the defaults;
   * `prohibitedBy` (with `preferencesUnreadable`) and `effective` say so.
   */
  preferences: UsageDataPreferences;
  effective: UsageDataPreferences;
  prohibitedBy: Partial<
    Record<OrgProhibitableUsageDataKey, UsageDataProhibitionSource>
  >;
  /**
   * Set while the first-run legal consent is not recorded and the stored
   * preferences are readable: every `effective` key is off, with no
   * `prohibitedBy` attribution, until "Agree & continue" commits. Never set
   * alongside `preferencesUnreadable`.
   */
  consentPending?: true;
}
