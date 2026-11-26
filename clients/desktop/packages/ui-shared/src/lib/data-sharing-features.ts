// Single source of truth for "what does each data-sharing scope actually
// power?", shared by the web org Settings card (admin view) and the desktop
// Privacy tab / Cloud sync modal (member view).
//
// The scope labels (`Usage metadata`, `Plans`, `Session summaries`,
// `Transcripts`) are abstract, and the blast radius is wildly uneven: turning
// off Usage metadata guts most of the product, while turning off Transcripts
// costs two features. Nobody can infer that from the labels, so every scope row
// carries a row of feature pills that state plainly what it powers — and flips
// to a "this is what you lose" treatment when the scope is off.
//
// Pills name FEATURES, not capabilities, and the vocabulary is a closed set
// ({@link DataSharingFeatureId}). A pill is always a product surface the user
// already knows by name; it never describes the mechanism ("Worktree updates in
// Feed", "Summary history", "Memory source transcripts" are all capability
// phrasings and are out). The same feature may appear on several rows — that is
// expected and is itself informative, because it tells the reader a feature
// DEGRADES rather than disappears when one of its inputs is off.

import {
  DATA_SHARING_OPT_IN_FEATURES,
  type DataSharingOptInFeature,
  type TelemetryEnforcedScopeMap,
} from '@canopy/protocol';

/**
 * Canonical scope ordering, least invasive → most invasive, so a reader moves
 * down the list toward increasing exposure of actual conversation content.
 * Every surface iterates this instead of hard-coding a row order, so the admin's
 * view and the member's view stay in lockstep.
 *
 * Note the ordering does not match dependency direction by accident: `metadata`
 * is both the least invasive row and the prerequisite for the other three, so
 * least-invasive-first also puts the prerequisite at the top, where its
 * dependency note reads naturally.
 */
export const DATA_SHARING_SCOPE_ORDER = [
  'metadata',
  'plans',
  'summaries',
  'transcripts',
] as const;

/** One data-sharing scope key. */
export type DataSharingScopeKey = (typeof DATA_SHARING_SCOPE_ORDER)[number];

/**
 * Compile-time guard that this package's scope list stays in lockstep with the
 * wire contract's scope map. Widening `TelemetryEnforcedScopeMap` without
 * widening {@link DATA_SHARING_SCOPE_ORDER} fails here rather than silently
 * dropping a scope from every disclosure surface — the exact "half-migrated
 * scope list" failure mode this feature is most exposed to.
 */
type AssertScopeParity =
  keyof TelemetryEnforcedScopeMap extends DataSharingScopeKey
    ? DataSharingScopeKey extends keyof TelemetryEnforcedScopeMap
      ? true
      : never
    : never;
const _scopeParity: AssertScopeParity = true;
void _scopeParity;

/**
 * The closed vocabulary of features a scope can power. Typed as a union so no
 * call site can invent a capability-phrased label; adding a product surface
 * means adding it here first.
 */
export type DataSharingFeatureId =
  | 'feed-activity'
  | 'feed-search'
  | 'statistics'
  | 'member-profiles'
  | 'leaderboards'
  | 'cost-and-savings'
  | 'push-notifications'
  | 'implemented-plans'
  | 'shared-runs'
  | 'organization-memory';

/** A feature pill: its stable id plus the user-facing label rendered in the pill. */
export interface DataSharingFeature {
  id: DataSharingFeatureId;
  label: string;
  /**
   * True when this feature is only lost under an ORG PROHIBITION, not when a
   * member turns the scope off for themselves. Run sharing is the case that
   * matters: `shareRun` deliberately bypasses the member's ambient sharing
   * gate, so a member's own Transcripts-off does NOT stop them sharing a run —
   * only an org prohibition does. The member-side surface filters these out so
   * it never claims a loss that will not happen.
   */
  enforcementOnly?: boolean;
}

const FEATURE_LABELS: Record<DataSharingFeatureId, string> = {
  'feed-activity': 'Timeline activity',
  'feed-search': 'Timeline search',
  statistics: 'Statistics',
  'member-profiles': 'Member profiles',
  leaderboards: 'Leaderboards',
  'cost-and-savings': 'Cost & savings',
  'push-notifications': 'Push notifications',
  'implemented-plans': 'Implemented plans',
  'shared-runs': 'Shared runs',
  'organization-memory': 'Organization memory',
};

/** A feature's user-facing pill label. */
export function dataSharingFeatureLabel(id: DataSharingFeatureId): string {
  return FEATURE_LABELS[id];
}

/**
 * The features the first-run "Sync activity to your account" choice names,
 * in pill order: what a signed-in member gets by turning sync on.
 */
export const ONBOARDING_SYNC_FEATURE_IDS: readonly DataSharingFeatureId[] = [
  'feed-activity',
  'statistics',
  'cost-and-savings',
  'push-notifications',
  'organization-memory',
];

function feature(
  id: DataSharingFeatureId,
  enforcementOnly?: boolean,
): DataSharingFeature {
  return enforcementOnly
    ? { id, label: FEATURE_LABELS[id], enforcementOnly: true }
    : { id, label: FEATURE_LABELS[id] };
}

/**
 * What each scope powers, traced through the ingest → table → query path.
 *
 * Three findings the copy must not get wrong, because the intuitive guess is
 * backwards:
 *
 * - **Transcripts power nothing on Feed or Statistics.** Both are built
 *   entirely from plaintext columns; the rollup SQL deliberately never names
 *   `encrypted_body`. An org can turn Transcripts off and lose no dashboard or
 *   feed content at all. That is the zero-data-retention headline.
 * - **Run sharing is the real transcript escape hatch**, not a footnote: it
 *   bypasses the ambient gate by design and defaults to organization scope, so
 *   `Shared runs` leads the Transcripts row.
 * - **Usage metadata is a hard prerequisite for Organization memory**, because
 *   memory episodes are only enqueued for organization-owned turn rows. Metadata
 *   off silently kills memory even with Transcripts on.
 */
export const DATA_SHARING_FEATURES: Record<
  DataSharingScopeKey,
  readonly DataSharingFeature[]
> = {
  // Owns the workspace/worktree envelope, every turn rollup row, tool counts,
  // PR status, and pipeline runs. Also the hard prerequisite for `summaries`,
  // `transcripts`, and Organization memory.
  metadata: [
    feature('feed-activity'),
    feature('statistics'),
    feature('member-profiles'),
    feature('leaderboards'),
    feature('cost-and-savings'),
    feature('push-notifications'),
  ],
  // Independent group carrying plan rows + plan text.
  plans: [
    feature('feed-activity'),
    feature('statistics'),
    feature('member-profiles'),
    feature('leaderboards'),
    feature('implemented-plans'),
  ],
  // The `worktree_updated` feed card (the feed's main text-bearing card), its
  // History disclosure, and the summary term in feed free-text search. Nothing
  // in Statistics or Memory reads it.
  summaries: [feature('feed-activity'), feature('feed-search')],
  // Carries the encrypted turn body. `Shared runs` leads because it is the most
  // visible loss and the biggest privacy hole; it is `enforcementOnly` because a
  // member's own Transcripts-off does not stop their own run share.
  transcripts: [feature('shared-runs', true), feature('organization-memory')],
};

/**
 * The scope every other scope depends on. A dependent scope that is on while
 * this one is off is a silent failure — nothing uploads — so both surfaces
 * render an inline dependency note for it.
 */
export const DATA_SHARING_PREREQUISITE_SCOPE: DataSharingScopeKey = 'metadata';

/** User-facing label per scope. Shared so admin and member read the same words. */
export const DATA_SHARING_SCOPE_LABELS: Record<DataSharingScopeKey, string> = {
  metadata: 'Usage metadata',
  plans: 'Plans',
  summaries: 'Session summaries',
  transcripts: 'Transcripts',
};

/**
 * Per-scope descriptions, written to disclose what the scope actually carries.
 *
 * The Usage metadata description is a flat comma list rather than prose: it
 * enumerates six things, and strung together with "and"/"plus" the reader has to
 * parse a sentence to find out what leaves their machine.
 *
 * It names the branch, repo, and PR strings and the provider account on purpose.
 * The older "Token counts, cost, timing, and tool-usage rollups" under-disclosed
 * both, and under a "metadata" label that under-disclosure is material. Keep
 * those four nouns in any rewording; the list can get shorter, but not vaguer.
 *
 * The Session summaries description names its derivation explicitly, because
 * that is the whole reason summaries were split out of metadata: an org blocking
 * transcripts must not still be shipping LLM prose about those same
 * conversations.
 */
export const DATA_SHARING_SCOPE_DESCRIPTIONS: Record<
  DataSharingScopeKey,
  string
> = {
  metadata:
    'Token counts, cost, timing, tool usage, branch/repo/PR names, billed provider account.',
  plans: 'Generated implementation plans.',
  summaries:
    'AI-written recaps of what each agent session did, generated from the conversation.',
  transcripts: 'Full chat and agent conversation text.',
};

/**
 * A scope's description as a settings row hint. Row hints on the member
 * surfaces (Settings → Privacy and the first-run data choices card) are
 * fragments without a closing period, matching the Usage data rows beside
 * them; the org admin card keeps the full sentences.
 */
export function dataSharingScopeRowHint(scope: DataSharingScopeKey): string {
  return DATA_SHARING_SCOPE_DESCRIPTIONS[scope].replace(/\.$/, '');
}

/**
 * Features a scope powers, optionally filtered for the member-side surface.
 *
 * Pass `includeEnforcementOnly: false` from the desktop Privacy tab / Cloud sync
 * modal so a member's own Transcripts-off row does not claim `Shared runs` turns
 * off when it does not.
 */
export function getDataSharingFeatures(
  scope: DataSharingScopeKey,
  options?: { includeEnforcementOnly?: boolean },
): readonly DataSharingFeature[] {
  const includeEnforcementOnly = options?.includeEnforcementOnly ?? true;
  const features = DATA_SHARING_FEATURES[scope];
  return includeEnforcementOnly
    ? features
    : features.filter((entry) => !entry.enforcementOnly);
}

/**
 * Caption preceding the pill row. Off is framed as what sharing would enable,
 * not as a loss, so private-by-default reads as a choice rather than a penalty.
 */
export function dataSharingFeatureCaption(sharing: boolean): string {
  return sharing ? 'Powers' : 'Enables';
}

/**
 * Inline note for a dependent scope that is on while Usage metadata is off.
 * This is a silent failure today and the single highest-value disclosure in the
 * design — anyone configuring for zero data retention hits it immediately.
 */
export function dataSharingDependencyNote(scope: DataSharingScopeKey): string {
  if (scope === 'transcripts') {
    return `${FEATURE_LABELS['organization-memory']} also needs ${DATA_SHARING_SCOPE_LABELS.metadata}, which is off.`;
  }
  return `Also needs ${DATA_SHARING_SCOPE_LABELS.metadata}, which is off.`;
}

/**
 * The scopes whose content an organization's owners can open: they view and
 * download transcripts, and export them with plans and session summaries
 * (docs/organization-transcripts.md). Usage metadata holds no content.
 */
export const DATA_SHARING_OWNER_VISIBLE_SCOPES: readonly DataSharingScopeKey[] =
  ['plans', 'summaries', 'transcripts'];

/**
 * The note under a scope's Off / Just me / Organization choice saying what
 * Organization lets owners do, or `null` for a scope without content. One
 * source for the desktop Privacy rows and the web opt-in.
 */
export function dataSharingOrganizationAccessNote(
  scope: DataSharingScopeKey,
): string | null {
  switch (scope) {
    case 'plans':
      return "With Organization, your organization's owners can view and download these plans.";
    case 'summaries':
      return "With Organization, your organization's owners can view and download these summaries.";
    case 'transcripts':
      return "With Organization, your organization's owners can view and download these transcripts.";
    case 'metadata':
      return null;
  }
}

/** Derived from feature pills, with the metadata delivery prerequisite first. */
function optInScopes(
  feature: Exclude<DataSharingOptInFeature, 'shared-projects'>,
): readonly DataSharingScopeKey[] {
  return [
    'metadata',
    ...DATA_SHARING_SCOPE_ORDER.filter(
      (scope) =>
        scope !== 'metadata' &&
        DATA_SHARING_FEATURES[scope].some(
          (entry) => entry.id === feature && !entry.enforcementOnly,
        ),
    ),
  ];
}
export const DATA_SHARING_OPT_IN_SCOPES: Record<
  DataSharingOptInFeature,
  readonly DataSharingScopeKey[]
> = {
  'feed-activity': optInScopes('feed-activity'),
  statistics: optInScopes('statistics'),
  'member-profiles': optInScopes('member-profiles'),
  leaderboards: optInScopes('leaderboards'),
  'implemented-plans': optInScopes('implemented-plans'),
  'organization-memory': optInScopes('organization-memory'),
  'shared-projects': ['metadata'],
};
type AssertOptInPillParity =
  Exclude<
    DataSharingOptInFeature,
    'shared-projects'
  > extends DataSharingFeatureId
    ? true
    : never;
const _optInPillParity: AssertOptInPillParity = true;
void _optInPillParity;
for (const feature of DATA_SHARING_OPT_IN_FEATURES) {
  const scopes = DATA_SHARING_OPT_IN_SCOPES[feature];
  if (
    scopes.length === 0 ||
    scopes[0] !== 'metadata' ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new Error('Invalid data-sharing consent mapping');
  }
}
