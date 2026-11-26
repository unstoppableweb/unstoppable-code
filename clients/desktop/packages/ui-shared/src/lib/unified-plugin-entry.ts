import type {
  UnifiedEntryKind,
  UnifiedEntryOrigin,
  UnifiedEntryRef,
  UnifiedEntryState,
} from '@canopy/protocol/unified-entry';
import type {
  PipelineExecutionScope,
  PipelineTriggerType,
} from '@canopy/protocol/pipelines';
import {
  ITEM_INSTALL_HARNESSES,
  type HarnessCompatibility,
  type HarnessCompatibilityHarness,
  type HarnessInstallItemRef,
  type PluginStandInCandidate,
} from '@canopy/protocol/plugins';
import type { PipelineSourceBadgeKey } from './pipeline-source-badges';
import type { WorkflowLastRun } from './workflow-last-run';

export type UnifiedEntrySurface = 'cloud' | 'desktop';

export const UNIFIED_ENTRY_SURFACE_LABELS: Record<UnifiedEntrySurface, string> =
  {
    cloud: 'Cloud + desktop',
    desktop: 'Desktop only',
  };

/** One plain line under the surface label, in the row's surface tooltip. */
export const UNIFIED_ENTRY_SURFACE_HINTS: Record<UnifiedEntrySurface, string> =
  {
    cloud: 'Works in cloud chats and on your desktop',
    desktop: "It runs on your desktop, so cloud chats can't use it",
  };

/** What the Marketplace Pipelines tab filters on; set on every pipeline entry. */
export interface UnifiedPipelineFacets {
  source: PipelineSourceBadgeKey;
  scopes: readonly PipelineExecutionScope[];
  triggerTypes: readonly PipelineTriggerType[];
}

/** How one connection on an integration card is bound. */
export type UnifiedEntryBinding = 'account' | 'device' | 'provider';

/** One connection an integration card lists, named as the user sees it. */
export interface UnifiedEntryConnection {
  /** Picker `serverId`: the connection's server key for account rows. */
  readonly serverId: string;
  readonly configId?: string;
  readonly name: string;
  readonly binding: UnifiedEntryBinding;
  readonly state: UnifiedEntryState;
  readonly accountConnectionId?: string;
}

/** The curated plugin folded into its integration card (REG-3033). */
export interface UnifiedEntryFoldedPlugin {
  /** Curated plugin key; the host installs it from here. */
  readonly key: string;
  readonly name: string;
  readonly skills: number;
  readonly installed: boolean;
  /** Its one Add for every harness result, joined into the card (CAN-6817). */
  readonly harnessInstalls?: UnifiedEntryHarnessInstalls;
}

/** A provider-account connector folded into its integration card. */
export interface UnifiedEntryFoldedConnector {
  readonly displayName: string;
  readonly connected: boolean;
}

/**
 * Everything one curated integration card stands for: its connections, the
 * plugin that ships its skills, and a provider connector that can bind it
 * through a Claude or Codex account instead (REG-3033).
 */
export interface UnifiedEntryIntegration {
  readonly curatedKey: string;
  readonly plugin?: UnifiedEntryFoldedPlugin;
  /** MCP harness results before a folded plugin contributes its own results. */
  readonly mcpHarnessInstalls?: UnifiedEntryHarnessInstalls;
  readonly connector?: UnifiedEntryFoldedConnector;
  readonly connections: readonly UnifiedEntryConnection[];
}

/**
 * The publisher's MCP server for a plugin's ChatGPT app (CAN-6818): the
 * candidate every Add hands to main, and the harnesses where it is known to
 * stand in. `harnesses` may be empty (not confirmed yet); only it is ever
 * shown.
 */
export interface UnifiedEntryStandIn extends PluginStandInCandidate {
  /** Harnesses where it stands in, in the Works with filter's order. */
  readonly harnesses: readonly HarnessCompatibilityHarness[];
}

/** The candidate an install request carries, without the display harnesses. */
export function pluginStandInCandidate(
  standIn: UnifiedEntryStandIn,
): PluginStandInCandidate {
  return {
    endpoint: standIn.endpoint,
    name: standIn.name,
    ...(standIn.curatedKey !== undefined
      ? { curatedKey: standIn.curatedKey }
      : {}),
  };
}

/** An integration a multi-connection plugin needs, linking to its card. */
export interface UnifiedEntryRequirement {
  readonly key: string;
  readonly name: string;
  readonly entryId: string;
}

/**
 * The team or organization a shared entry is shared with. Personal and public
 * shares carry none: nothing narrower than "everyone" or "only you" to name.
 */
export interface UnifiedEntrySharedWith {
  audience: 'team' | 'organization';
  organizationId?: string;
  personal?: boolean;
  /** The team's or organization's name, when the server reports one. */
  name?: string;
}

/** Present while a public link exists, including when it serves an older copy. */
export interface UnifiedEntryPublicShare {
  /** ISO date the public link was created. */
  readonly since?: string;
  /** `false` when the link still serves an older copy of the item. */
  readonly upToDate?: boolean;
}

/** The shared status badge's input, derived once for list and detail. */
export interface UnifiedEntryConnectionStatus {
  status: 'connected' | 'auth_required' | 'unreachable' | 'unknown';
  provider?: boolean;
  /** When this health was last checked, as the status cache reports it. */
  lastCheckedAt?: string;
  /** What sign-in would do here; absent when there is nothing to sign in to. */
  signIn?: 'connect' | 'reconnect';
  /** Nothing has established whether this server asks for sign-in. */
  requirementUnknown?: boolean;
  /** Every binding behind this health is turned off. */
  disabled?: boolean;
}

/** Where an MCP entry's connections are bound, as actual bindings show. */
export type UnifiedEntryPlacement = 'account' | 'desktop' | 'both';

/** A plugin another entry points at, by entry id and display name. */
export interface UnifiedEntryPluginLink {
  readonly entryId: string;
  readonly name: string;
}

/** An installed MCP row hidden behind the plugin that bundles its server. */
export interface UnifiedEntryBundledServerRow {
  /** The bundled server's name in the plugin manifest. */
  readonly serverName: string;
  /**
   * The bundled server's endpoint (`mcpEndpointKey`), so a page showing one
   * provider's member links only the member that points at this row.
   */
  readonly endpoint: string;
  /** The installed row's entry id, which opens its own settings. */
  readonly entryId: string;
  /** The installed row's MCP server id. */
  readonly serverId: string;
}

/** An MCP server a plugin bundles, listed or not. Never rendered as an endpoint. */
export interface UnifiedEntryBundledServer {
  /** The server's key inside its plugin: its manifest name or catalog key. */
  readonly key: string;
  /** The display name: the catalog's for a curated server. */
  readonly name: string;
  /** The server's `mcpEndpointKey`, a host at most; absent when unknown. */
  readonly endpoint?: string;
  /** The row or catalog card that already represents this server. */
  readonly entryId?: string;
}

/** The same app published by another catalog, linked from a plugin page. */
/** One harness's row for a catalog plugin (`pluginHarnessRows`). */
export interface UnifiedEntryHarnessRow {
  readonly id: string;
  readonly name: string;
  readonly installation:
    | 'Installed'
    | 'Not installed'
    | 'Not supported'
    | 'Unknown until added'
    /** Unknown, while a light preview of the plugin's files is read. */
    | 'Checking…';
  readonly note?: string;
}

export interface UnifiedEntryAlternative {
  readonly entryId: string;
  /** The other copy's source, worded to follow "Also available from". */
  readonly label: string;
  readonly ref: UnifiedEntryRef;
  readonly marketplaceVariant?: {
    readonly provider: 'Claude' | 'Codex';
    readonly currentVersion?: string;
    readonly version?: string;
  };
  /**
   * The copy's own name with its publisher, "Slack (slackapi)", for a page
   * row naming the copy that serves a harness (New Customize only).
   */
  readonly copyName?: string;
  /** Where the copy itself is installed, when its provider status is known. */
  readonly installedHarnesses?: { claude?: boolean; codex?: boolean };
  /** Whether the copy bundles MCP servers. */
  readonly hasMcpServers?: boolean;
  /** The copy's name and publisher apart: "Slack" from "slackapi". */
  readonly copyBase?: { readonly name: string; readonly publisher?: string };
  /** The copy's marketplace by its display name, not its repository id. */
  readonly marketplaceSourceName?: string;
  /**
   * The copy's own catalog state, as its own row has it: whether it has an
   * install of its own, rather than a listing that only resolves.
   */
  readonly state?: UnifiedEntryState;
  /** The copy's own harness rows, when its host computed them. */
  readonly harnessRows?: readonly UnifiedEntryHarnessRow[];
  /** Names of the harnesses this copy is installed for; see the entry's field. */
  readonly installedHarnessNames?: readonly string[];
  /**
   * Whether the item's one Add brings this copy along (New Customize): the
   * copy is a provider's official listing, or both name the same author.
   * The desktop installs only such copies, so only they are offered.
   */
  readonly addedWithItem?: boolean;
}

/** Only first-party marketplace listings participate in cross-provider grouping. */
/**
 * Whether an entry ships with the app (Sergii's Customize QA): a built-in
 * skill, plugin, workflow, collection or automation template. Every such
 * entry wears the product mark through this one rule; items people make keep
 * their letter avatar.
 */
export function entryIsBuiltIn(
  entry: Pick<UnifiedPluginEntry, 'builtIn' | 'origin' | 'kind' | 'authorName'>,
): boolean {
  if (entry.builtIn === true || entry.origin === 'built-in') return true;
  // A curated workflow or automation template with no other author is the
  // app's own; curated plugins and apps carry their publishers' marks.
  return (
    entry.origin === 'curated' &&
    (entry.kind === 'pipeline' || entry.kind === 'automation') &&
    !entry.authorName?.trim()
  );
}

export function officialMarketplaceProvider(
  marketplaceId: string,
): 'Claude' | 'Codex' | undefined {
  if (marketplaceId === 'claude-plugins-official') return 'Claude';
  if (
    marketplaceId === 'openai-curated' ||
    marketplaceId === 'openai-curated-remote'
  )
    return 'Codex';
  return undefined;
}

export function marketplacePackageGroup(
  manifestName: string,
  sourceUrl: string | undefined,
): string | undefined {
  let source: string | undefined;
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        // Public catalogs link to GitHub trees pinned to an ingested commit.
        // Compare the package path across revisions, keeping its subdirectory.
        const path =
          url.hostname === 'github.com'
            ? url.pathname.replace(
                /^(\/[^/]+\/[^/]+?)(?:\.git)?(?:\/tree\/[a-f0-9]{40})?(?=\/|$)/i,
                (repository: string, path: string) => path.toLowerCase(),
              )
            : url.pathname;
        source = `${url.origin.toLowerCase()}${path}`
          .replace(/\/+$/, '')
          .replace(/\.git$/, '');
      }
    } catch {
      // Some manifests refer to a local package and publish no source URL.
    }
  }
  return source === undefined
    ? undefined
    : JSON.stringify([manifestName.toLowerCase(), source]);
}

export function describeMarketplaceVariant(
  provider: 'Claude' | 'Codex',
  currentVersion: string | null | undefined,
  version: string | null | undefined,
): NonNullable<UnifiedEntryAlternative['marketplaceVariant']> {
  return {
    provider,
    currentVersion: currentVersion || undefined,
    version: version || undefined,
  };
}

/** The share a local collection was added from, as last seen by the viewer. */
export interface UnifiedEntrySharedSource {
  remoteId: string;
  /** The share's content hash when this copy was added or last updated. */
  installedContentHash?: string;
  /** Absent when the share is no longer visible to the viewer. */
  latestContentHash?: string;
  /** Who shared it: the creator's name, else the owning team or organization. */
  sharedBy?: string;
  /** ISO date the share last changed. */
  updatedAt?: string;
  latestItemCounts?: { skills: number; plugins: number };
}

/**
 * What a Customize Workflows row shows and can do (CAN-4845). Built from host
 * data; a row without it falls back to the entry's description.
 */
export interface UnifiedWorkflowFacets {
  /** Legacy plain trigger text for hosts that have not projected rich facets. */
  readonly triggerText?: string;
  /** One item per pipeline trigger, in the order it should be shown. */
  readonly triggers?: readonly UnifiedWorkflowTrigger[];
  /** An automation's compact row label and full tooltip description. */
  readonly schedule?: UnifiedWorkflowSchedule;
  /** What an automation does; omitted when unknown. */
  readonly summary?: string;
  /** Pipeline step count, shown only in trigger tooltips. */
  readonly stepCount?: number;
  /** `Shared by Platform`; omitted otherwise. */
  readonly sourceText?: string;
  /** `sourceText` names a person, so session replay masks it. */
  readonly sourceIsPerson?: boolean;
  /** `null` means it never ran; `undefined` means unknown, so it is hidden. */
  readonly lastRun?: WorkflowLastRun | null;
  /** Automations only: draws the on/off switch. */
  readonly enabled?: boolean;
  /** Pipelines only: Run is enabled. */
  readonly runnable?: boolean;
  /** The source definition cannot be deleted from the user store. */
  readonly readonly?: boolean;
  /** Why Run is disabled when the pipeline cannot be started by hand. */
  readonly runUnavailableLabel?: string;
}

export type UnifiedWorkflowTriggerKind =
  | 'schedule'
  | 'once'
  | 'manual'
  | 'plan-approved'
  | 'task-ready'
  | 'workflow';

export interface UnifiedWorkflowTrigger {
  readonly kind: UnifiedWorkflowTriggerKind;
  /** Short row label: `Manual`, `Plan approval`, `Task ready`. */
  readonly label: string;
  /** Plain one-line sentence following `Trigger: `. */
  readonly explainer: string;
}

export interface UnifiedWorkflowSchedule {
  /** Compact row label, for example `Weekdays · 09:00`. */
  readonly label: string;
  /** Full schedule shown in the tooltip. */
  readonly tooltip: string;
}

/** Trimmed receipt names; a blank name is omitted. */
export interface UnifiedEntryInstalledFrom {
  readonly sharedByName?: string;
  /** Source owner's display name; display evidence, not an ownership grant. */
  readonly ownerName?: string;
  readonly teamName?: string;
}

/**
 * New Customize (CAN-6811): the copies one integration row stands for. Set
 * only on a row that stands for two or more copies; display only.
 */
export interface UnifiedEntryIntegrationCopies {
  /** Every copy's entry id, the row's own first. */
  readonly memberIds: readonly string[];
  /**
   * Set when the row's copy is installed: the harness its line names, when
   * it names one, and how many other installed copies the row stands for.
   */
  readonly installed?: {
    readonly harness?: HarnessCompatibilityHarness;
    readonly moreCount: number;
  };
  /**
   * A hidden installed copy that needs a sign-in or has a failing
   * connection while the row's own copy does not. The row carries its
   * recovery state, and Connect signs in to this copy.
   */
  readonly attentionCopyId?: string;
}

/**
 * One Add's per-harness result for an MCP server (CAN-6815) or a plugin
 * (CAN-6816).
 */
export interface UnifiedEntryHarnessInstalls {
  readonly installed: readonly HarnessCompatibilityHarness[];
  readonly failed: readonly UnifiedEntryHarnessInstallFailure[];
  /**
   * Each record behind the row, with every harness it has a result for
   * (installed, skipped or failed), so a harness set up later can be added
   * to it (CAN-6817). Absent on rows built before it existed.
   */
  readonly records?: readonly UnifiedEntryHarnessRecord[];
}

/** One install record behind a row, and what adds a harness to it. */
export type UnifiedEntryHarnessRecord = {
  readonly harnesses: readonly HarnessCompatibilityHarness[];
} & (
  | {
      readonly serverId: string;
      readonly configId: string;
      readonly item?: undefined;
    }
  | {
      readonly serverId?: undefined;
      readonly configId?: undefined;
      readonly item: HarnessInstallItemRef;
    }
);

/** One harness that refused an item, and what Try again checks again. */
export type UnifiedEntryHarnessInstallFailure = {
  readonly harness: HarnessCompatibilityHarness;
  readonly reason: string;
  /**
   * The copy this harness reads was changed or removed outside the app
   * (CAN-6817); Try again repairs it.
   */
  readonly outsideChange?: 'changed' | 'removed';
} & (
  | {
      /** The saved server Retry stages again. */
      readonly serverId: string;
      readonly item?: undefined;
    }
  | {
      readonly serverId?: undefined;
      /** The installed plugin Retry checks again (CAN-6816). */
      readonly item: HarnessInstallItemRef;
    }
);

/** Display projection shared by catalog surfaces; contains no host behavior. */
export interface UnifiedPluginEntry {
  id: string;
  kind: UnifiedEntryKind;
  origin: UnifiedEntryOrigin;
  name: string;
  description: string;
  logoUrl?: string;
  bundledLogo?: string;
  brandMark?: boolean;
  categories: string[];
  authorName?: string;
  /** Human-readable result metadata used by cross-capability search. */
  typeLabel?: string;
  sourceLabel?: string;
  /**
   * The display name of the marketplace source a plugin (or a skill inside
   * one) is listed in: the name the Marketplaces page shows (CAN-6814), so
   * New Customize's Source filter lists the same sources.
   */
  marketplaceSourceName?: string;
  /** The provider a shared plugin was shared from, for its small logo. */
  sharedSourceProvider?: 'Claude' | 'Codex';
  ownershipLabel?: string;
  /** Set on every entry shared with a team or organization. */
  sharedWith?: UnifiedEntrySharedWith;
  availabilityLabel?: string;
  components: {
    skills: number;
    mcpServers: number;
    commands: number;
    agents: number;
    /** Set on collection entries; other kinds never count plugins. */
    plugins?: number;
  };
  providerSupport: { claude: boolean; codex: boolean };
  /**
   * Validated, revision-bound harness compatibility from catalog ingestion or
   * refresh. Absence means unknown: it never narrows `providerSupport` and
   * display builders never derive it.
   */
  harnessCompatibility?: HarnessCompatibility;
  /** Display grouping for official marketplace listings of the same package. */
  marketplaceGroup?: string;
  marketplaceProvider?: 'Claude' | 'Codex';
  marketplaceProviders?: readonly ('Claude' | 'Codex')[];
  /** Original listings behind a grouped display row, including its representative. */
  marketplaceListings?: readonly UnifiedPluginEntry[];
  marketplaceVersion?: string;
  /** False when the host cannot install this listing from Browse. */
  browseInstallAvailable?: boolean;
  state: UnifiedEntryState;
  /**
   * The source this installed entry came from has changed since it was
   * installed. Cards badge it; the detail surface offers the update.
   */
  updateAvailable?: boolean;
  /** Installed version only; omitted when its provenance is unknown. */
  version?: string;
  latestVersion?: string;
  /** ISO date the share was created; set only on `origin: 'shared'` rows. */
  sharedSince?: string;
  /** Set on a local collection added from a share; drives rows, menus and Updates. */
  sharedSource?: UnifiedEntrySharedSource;
  /** Conservative ownership when provenance exists but cannot be projected. */
  collectionProvenanceUnknown?: boolean;
  /** Local snapshot stamp for summary invalidation, including membership edits. */
  collectionRevision?: string;
  /**
   * Set only on an `origin: 'shared'` entry whose current share summary has a
   * public link. Blueprint summaries report none, so blueprints never carry it.
   */
  publicShare?: UnifiedEntryPublicShare;
  /** Configurations or bundled servers still waiting for sign-in; absent when none. */
  pendingSignIns?: number;
  /** Actual installations, independent of provider support. Cursor is unavailable. */
  installedHarnesses?: { claude?: boolean; codex?: boolean };
  /**
   * New Customize (CAN-6815): set on an MCP server one Add installed for
   * every set-up harness. The harnesses it is installed for, and the ones
   * that refused it with why, in the Works with filter's order.
   */
  harnessInstalls?: UnifiedEntryHarnessInstalls;
  /**
   * New Customize: a catalog plugin's rows per offered harness, computed by
   * the host from the plugin's facets the way its page's Works with table
   * is. `customizeHarnessRows` turns them into chips and table rows alike.
   */
  harnessRows?: readonly UnifiedEntryHarnessRow[];
  /**
   * A curated plugin's installed copy: the names of the harnesses it is
   * installed for, from its marketplace row (CAN-7547), so the uninstall
   * confirmation can name a harness no provider flag covers. Display only for
   * that list; Works with never reads it (it reads `harnessRows` or the
   * catalog's harness compatibility).
   */
  installedHarnessNames?: readonly string[];
  builtIn?: boolean;
  custom?: boolean;
  /**
   * Names from the install receipt of a copy installed from a share. Empty
   * when the receipt names nobody. Display evidence only, never authorization.
   */
  installedFrom?: UnifiedEntryInstalledFrom;
  /**
   * Set on a local copy of a share someone else published when the share row
   * is folded into this row (CAN-6810): the folded row's entry id and share
   * date, so Shared with me lists the copy and counts the share once. Not
   * displayed.
   */
  copyOfSharedWithViewer?: {
    readonly shareEntryId: string;
    readonly sharedSince: string;
  };
  /**
   * A receipted shared copy whose source hash differs from the installed
   * receipt (CAN-5309); separate from the GitHub `updateAvailable`.
   */
  shareUpdateAvailable?: boolean;
  /** When the viewer last edited a custom item (ISO); drives "Created by you · Edited {date}". */
  editedAt?: string;
  /** Explicit creator identity match, never inferred from organization ownership. */
  ownedByViewer?: boolean;
  /** Explicit publication state; a private cloud record alone is not a share. */
  isShared?: boolean;
  /** Catalog representation of this canonical local install, when distinct. */
  installedEntryId?: string;
  /** Where an MCP entry runs: cloud sessions and desktop, or desktop only. */
  surface?: UnifiedEntrySurface;
  /** Cached connection health of an installed MCP entry; absent elsewhere. */
  connection?: UnifiedEntryConnectionStatus;
  /** A card with several connections: their worst health, for its row only. */
  aggregateConnection?: UnifiedEntryConnectionStatus;
  /** Absent for a provider-managed entry, which runs in neither place. */
  placement?: UnifiedEntryPlacement;
  /** Number of concrete configuration/binding targets behind an MCP row. */
  mcpTargetCount?: number;
  /** A curated MCP server with a connection supported by the account proxy. */
  accountProxyMcp?: true;
  recommended: boolean;
  /** Stable catalog order used only as a browse-ranking fallback. */
  catalogSortOrder?: number;
  pipeline?: UnifiedPipelineFacets;
  /** Set on a pipeline or automation row the Customize Workflows tab draws. */
  workflow?: UnifiedWorkflowFacets;
  /** Set on a curated integration card; see {@link UnifiedEntryIntegration}. */
  integration?: UnifiedEntryIntegration;
  /** Set on a plugin that needs several integrations, one chip per key. */
  requirements?: readonly UnifiedEntryRequirement[];
  /** Set on an installed MCP row that an installed plugin bundles. */
  bundledBy?: UnifiedEntryPluginLink;
  /** Set on a catalog MCP card whose endpoint an installed plugin provides. */
  installedVia?: UnifiedEntryPluginLink;
  /** Set on a plugin the same app's plugins from other catalogs link to. */
  alsoAvailableFrom?: readonly UnifiedEntryAlternative[];
  /** Set on an installed plugin: the installed MCP rows hidden behind it. */
  bundledServerRows?: readonly UnifiedEntryBundledServerRow[];
  /** Set on a plugin, installed or not: every MCP server it bundles. */
  bundledServers?: readonly UnifiedEntryBundledServer[];
  /**
   * Set on a plugin, installed or not, or on the integration card a plugin
   * folded into, when its source lists them: the names of the skills it
   * bundles, so New Customize can find the plugin through a skill and show
   * them in its row (CAN-6812).
   */
  bundledSkillNames?: readonly string[];
  /**
   * Set on an MCP search result that stands for a bundled server no row or
   * card represents. `bundledBy` names its plugin; it has no installation,
   * health, sharing or install action of its own.
   */
  pluginServerResult?: true;
  /**
   * Catalog entries that are the same integration share this key (CAN-6808):
   * a Claude and a Codex plugin, the MCP catalog card and a connector for one
   * product. Additive and optional: an entry without it is its own
   * integration, and ids never change.
   */
  integrationKey?: string;
  /**
   * `authorName` was not declared by the listing: it came from the
   * marketplace owner or the repository owner. A merged row prefers a copy's
   * declared publisher over a derived one. Set only by New Customize.
   */
  publisherDerived?: true;
  /**
   * A publisher for a listing that declares none (the marketplace owner, the
   * repository or server host owner). Only New Customize shows it.
   */
  derivedPublisher?: string;
  /** A guessed logo (a repository owner's avatar); only New Customize uses it. */
  derivedLogoUrl?: string;
  /** The item's homepage or server address, for New Customize's site icon. */
  siteUrl?: string;
  /**
   * `logoUrl` is a guess (a repository owner's avatar or a site favicon),
   * not the listing's own art. Bundled marks and declared logos win over it.
   */
  logoDerived?: true;
  /** The integration's preferred MCP endpoint, the same on every copy. */
  integrationEndpoint?: string;
  /**
   * A plugin whose ChatGPT app doesn't run on some harnesses, in an
   * integration with an MCP endpoint (CAN-6818): the publisher's MCP server
   * Add hands to main, and the harnesses where it is known to stand in.
   */
  chatGptAppStandIn?: UnifiedEntryStandIn;
  /**
   * New Customize (CAN-6811): set on the row that stands for several copies
   * of one integration. The other copies stay installed and keep their ids;
   * they are only not listed.
   */
  integrationCopies?: UnifiedEntryIntegrationCopies;
  /**
   * When an installed plugin's cache was last written (ISO): its install or
   * latest update. Breaks ties between installed copies; absent when unknown.
   */
  installedAt?: string;
  ref: UnifiedEntryRef;
}

/**
 * A source label `pluginSourceLabel` built for a provider: `Claude · slackapi`
 * or `Codex official`. A marketplace merely named `claude-tools` isn't one.
 */
export function parseProviderSourceLabel(
  label: string | undefined,
): { provider: 'Claude' | 'Codex'; rest: string } | undefined {
  const match = /^(claude|codex)(?:\s*·\s*(.+)|\s+official)$/i.exec(
    label?.trim() ?? '',
  );
  if (!match) return undefined;
  return {
    provider: match[1].toLowerCase() === 'claude' ? 'Claude' : 'Codex',
    rest: match[2]?.trim() ?? '',
  };
}

/** The provider a marketplace source label names, if it names one. */
export function sourceLabelProvider(
  label: string | undefined,
): 'Claude' | 'Codex' | undefined {
  return parseProviderSourceLabel(label)?.provider;
}

/**
 * Several copies' per-harness results as one row's (CAN-6815, CAN-6817): a
 * harness is installed when any copy is. A copy changed or removed outside
 * the app is still the one that harness's sessions load, so it warns
 * whatever the other copies say (the first such copy per harness wins);
 * otherwise a harness that refused a copy reads failed only while no copy is
 * installed for it. Every copy's record stays addressable, so a harness set
 * up later is added to each one. `undefined` when no copy has a result.
 */
export function mergeEntryHarnessInstalls(
  results: readonly UnifiedEntryHarnessInstalls[],
): UnifiedEntryHarnessInstalls | undefined {
  if (results.length === 0) return undefined;
  const installed = new Set(results.flatMap((result) => result.installed));
  const failed = new Map<
    HarnessCompatibilityHarness,
    UnifiedEntryHarnessInstallFailure
  >();
  const failures = results.flatMap((result) => result.failed);
  for (const failure of failures)
    if (failure.outsideChange !== undefined && !failed.has(failure.harness))
      failed.set(failure.harness, failure);
  for (const failure of failures)
    if (!installed.has(failure.harness) && !failed.has(failure.harness))
      failed.set(failure.harness, failure);
  const records = results.flatMap((result) => result.records ?? []);
  return {
    installed: ITEM_INSTALL_HARNESSES.filter((harness) =>
      installed.has(harness),
    ),
    failed: ITEM_INSTALL_HARNESSES.flatMap(
      (harness) => failed.get(harness) ?? [],
    ),
    ...(records.length > 0 ? { records } : {}),
  };
}
