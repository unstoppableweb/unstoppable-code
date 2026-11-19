import {
  CAPABILITY_SETUP_DISMISSED_RECOMMENDATION_LIMIT,
  CapabilitySetupShareablePluginRefSchema,
  capabilitySetupItemKey,
  type CapabilitySetupItem,
  type CapabilitySetupItemRef,
  type CatalogProjectSetupGetResult,
} from '@canopy/protocol/canopy-core';

/**
 * The sections of an organization project's shared setup (CAN-6239) that come
 * from the organization, in the order the panel shows them. Each kind is one
 * section of rows with a source; connectors (Release 3) join as a kind of
 * their own. Scripts and hooks, which come from the project's checkout, are
 * the `PROJECT_LOCAL_SECTION_KINDS` that follow them (phase 08). Agents
 * (phase 10a) and pipelines (phase 10b) are kinds of their own while
 * organization projects are on; off, every write keeps theirs as stored.
 */
export const PROJECT_SETUP_SECTION_KINDS = [
  'skill',
  'plugin',
  'agent',
  'pipeline',
] as const;

export type ProjectSetupSectionKind =
  (typeof PROJECT_SETUP_SECTION_KINDS)[number];

/** Where a row comes from: the organization's defaults, or this project. */
export type ProjectSetupRowSource = 'organization' | 'project';

/** One row of a section. */
export interface ProjectSetupRow {
  readonly key: string;
  /** Stable and DOM-safe, for test ids. */
  readonly testKey: string;
  readonly ref: CapabilitySetupItemRef;
  readonly name: string;
  readonly description: string | null;
  /** False when the item was deleted or is no longer the organization's. */
  readonly available: boolean;
  readonly source: ProjectSetupRowSource;
  /**
   * For an organization default, whether this project keeps it on; a project
   * addition is always on.
   */
  readonly on: boolean;
}

/** What the panel holds from a read or a save. */
export type ProjectSetupState = Pick<
  CatalogProjectSetupGetResult,
  | 'projectId'
  | 'organizationId'
  | 'revision'
  | 'organizationDefaults'
  | 'added'
  | 'removed'
  | 'dismissedRecommendations'
  | 'canEdit'
>;

/** The project's own part of its setup, as a save sends it. */
export interface ProjectSetupWrite {
  readonly added: CapabilitySetupItemRef[];
  readonly removed: CapabilitySetupItemRef[];
  readonly dismissedRecommendations: string[];
}

/** The section a ref belongs to, or null for a kind the panel does not list. */
export function projectSetupSectionOf(
  ref: CapabilitySetupItemRef,
): ProjectSetupSectionKind | null {
  switch (ref.kind) {
    case 'skill':
      return 'skill';
    case 'plugin':
    case 'marketplacePlugin':
      return 'plugin';
    case 'agent':
      return 'agent';
    case 'pipeline':
      return 'pipeline';
  }
}

function testKeyOf(ref: CapabilitySetupItemRef): string {
  if (ref.kind !== 'marketplacePlugin') return `${ref.kind}-${ref.id}`;
  const name =
    ref.ref.type === 'skill' ? ref.ref.skill_name : ref.ref.plugin_name;
  return `marketplace-${name.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function row(
  item: CapabilitySetupItem,
  source: ProjectSetupRowSource,
  on: boolean,
): ProjectSetupRow {
  return {
    key: capabilitySetupItemKey(item.ref),
    testKey: testKeyOf(item.ref),
    ref: item.ref,
    name: capabilitySetupItemName(item),
    description: item.description,
    available: item.available,
    source,
    on,
  };
}

/**
 * One section's rows: the organization's defaults in their order, each on
 * unless the project switched it off, then the project's own additions. An
 * item the project added is the project's even while it is also a default.
 */
export function projectSetupRows(
  state: ProjectSetupState,
  kind: ProjectSetupSectionKind,
): ProjectSetupRow[] {
  const ofKind = (item: CapabilitySetupItem): boolean =>
    projectSetupSectionOf(item.ref) === kind;
  const added = new Set(
    state.added.map((item) => capabilitySetupItemKey(item.ref)),
  );
  const removed = new Set(state.removed.map(capabilitySetupItemKey));
  const seen = new Set<string>();
  const rows: ProjectSetupRow[] = [];
  for (const item of state.organizationDefaults.filter(ofKind)) {
    const key = capabilitySetupItemKey(item.ref);
    if (added.has(key) || seen.has(key)) continue;
    seen.add(key);
    rows.push(row(item, 'organization', !removed.has(key)));
  }
  for (const item of state.added.filter(ofKind)) {
    const key = capabilitySetupItemKey(item.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row(item, 'project', true));
  }
  return rows;
}

/**
 * The organization's items an editor can add to this project in one
 * section: available, and neither a default nor already added.
 */
export function projectSetupCandidates(
  state: ProjectSetupState,
  candidates: readonly CapabilitySetupItem[],
  kind: ProjectSetupSectionKind,
): CapabilitySetupItem[] {
  const taken = new Set(
    [...state.organizationDefaults, ...state.added].map((item) =>
      capabilitySetupItemKey(item.ref),
    ),
  );
  return candidates.filter(
    (item) =>
      item.available &&
      projectSetupSectionOf(item.ref) === kind &&
      !taken.has(capabilitySetupItemKey(item.ref)),
  );
}

/**
 * The project's own part as it stands, ready to save: the additions that
 * are still available (the service refuses one that is gone, so resending it
 * would block every save), every switched-off default, and the dismissed
 * repository recommendations untouched.
 */
function currentWrite(state: ProjectSetupState): ProjectSetupWrite {
  return {
    added: state.added.filter((item) => item.available).map((item) => item.ref),
    removed: [...state.removed],
    dismissedRecommendations: [...state.dismissedRecommendations],
  };
}

function without(
  refs: readonly CapabilitySetupItemRef[],
  ref: CapabilitySetupItemRef,
): CapabilitySetupItemRef[] {
  const key = capabilitySetupItemKey(ref);
  return refs.filter((candidate) => capabilitySetupItemKey(candidate) !== key);
}

/** Keeps an organization default on in this project, or switches it off. */
export function withDefaultSwitched(
  state: ProjectSetupState,
  ref: CapabilitySetupItemRef,
  on: boolean,
): ProjectSetupWrite {
  const write = currentWrite(state);
  const removed = without(write.removed, ref);
  return { ...write, removed: on ? removed : [...removed, ref] };
}

/** Adds an organization item to this project. */
export function withItemAdded(
  state: ProjectSetupState,
  ref: CapabilitySetupItemRef,
): ProjectSetupWrite {
  const write = currentWrite(state);
  return { ...write, added: [...without(write.added, ref), ref] };
}

/** Takes a project addition out of this project. */
export function withItemRemoved(
  state: ProjectSetupState,
  ref: CapabilitySetupItemRef,
): ProjectSetupWrite {
  const write = currentWrite(state);
  return { ...write, added: without(write.added, ref) };
}

/**
 * The name a capability setup row shows. An item that left the organization
 * (deleted, or no longer shared with it) comes back from the service with no
 * name of its own, only its id, which means nothing to a person, so it reads
 * as a removed skill or plugin instead.
 */
export function capabilitySetupItemName(item: CapabilitySetupItem): string {
  const id = 'id' in item.ref ? item.ref.id : undefined;
  if (item.available || (item.name !== '' && item.name !== id))
    return item.name;
  if (item.ref.kind === 'skill') return 'Removed skill';
  if (item.ref.kind === 'plugin' || item.ref.kind === 'marketplacePlugin')
    return 'Removed plugin';
  return item.name === '' ? (id ?? '') : item.name;
}

// --- Repository recommendations (CAN-6241, phase 09) ------------------------

type MarketplaceRef = Extract<
  CapabilitySetupItemRef,
  { kind: 'marketplacePlugin' }
>;

/**
 * A repository recommendation (a `canopy.json` `plugins` entry) as a project
 * setup item, or null when the setup can't hold it.
 */
export function recommendationSetupRef(ref: unknown): MarketplaceRef | null {
  const parsed = CapabilitySetupShareablePluginRefSchema.safeParse(ref);
  return parsed.success
    ? { kind: 'marketplacePlugin', ref: parsed.data }
    : null;
}

/**
 * Whether everyone in the project can get a recommendation once it is added:
 * the installer brings plugins in through their marketplace; skills and
 * Codex plugins from a repository have no shared install yet.
 */
export function recommendationInstallsForEveryone(
  ref: MarketplaceRef,
): boolean {
  return ref.ref.type === 'plugin' || ref.ref.type === 'claude_plugin';
}

/**
 * Whether the project's setup still waits on a decision about a
 * recommendation: it is neither one of the project's additions nor
 * dismissed. Matched by the setup's item key, which is the protocol's
 * shareable plugin key.
 */
export function recommendationIsOpen(
  state: Pick<ProjectSetupState, 'added' | 'dismissedRecommendations'>,
  ref: MarketplaceRef,
): boolean {
  const key = capabilitySetupItemKey(ref);
  return (
    !state.dismissedRecommendations.includes(key) &&
    !state.added.some((item) => capabilitySetupItemKey(item.ref) === key)
  );
}

/**
 * Records a recommendation as dismissed for everyone, keeping the rest of
 * the project's setup (without additions the service would refuse). The
 * oldest dismissals give way at the protocol's limit.
 */
export function withRecommendationDismissed(
  state: ProjectSetupState,
  ref: MarketplaceRef,
): ProjectSetupWrite {
  const write = currentWrite(state);
  const key = capabilitySetupItemKey(ref);
  const dismissed = [
    ...write.dismissedRecommendations.filter((entry) => entry !== key),
    key,
  ];
  return {
    ...write,
    dismissedRecommendations: dismissed.slice(
      Math.max(
        0,
        dismissed.length - CAPABILITY_SETUP_DISMISSED_RECOMMENDATION_LIMIT,
      ),
    ),
  };
}

/**
 * The sections a panel shows: Agents (10a) and pipelines (10b) only while
 * they can be shared.
 */
export function projectSetupSectionKinds(
  agentsAndPipelinesEnabled: boolean,
): readonly ProjectSetupSectionKind[] {
  return PROJECT_SETUP_SECTION_KINDS.filter(
    (kind) =>
      (kind !== 'agent' && kind !== 'pipeline') || agentsAndPipelinesEnabled,
  );
}
