import { flattenMcpServerRows } from '@canopy/desktop-shared/lib/mcp-server-rows';
import { useMemo, useRef, type ReactNode } from 'react';
import { parseGitHubRepo } from '@/lib/format';
import { useSkillList } from './useSkillList';
import { useMarketplaceList } from './useMarketplaceList';
import { useCollectionList } from './useCollectionList';
import { useMcpServerList } from './useMcpServerList';
import { useCuratedMcpServers } from './useCuratedMcpServers';
import { useProviderConnectors } from './useProviderConnectors';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { OrganizationLayerItem } from '@canopy/desktop-shared/lib/organization-capabilities';

/** The source column of an organization's skill (CAN-6237). */
const ORGANIZATION_SKILL_SOURCE_LABEL = 'Organization';
import type {
  PluginInfo,
  PluginProviderSupport,
} from '@canopy/execution-engine/types/plugins';
import { isCuratedPluginMarketplaceId } from '@canopy/protocol/plugins';
import type { CollectionIndexEntry } from '@canopy/desktop-shared/types/collections';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import type {
  ProviderConnectorListResult,
  ProviderConnectorRow,
} from '@canopy/execution-engine/types/mcp-servers';
import { buildProviderConnectorRows } from '../components/mcp/providerConnectorRows';
import {
  advertisesProviderConnector,
  capabilityReach,
  collapseByCoverage,
  OVERLAPPING_MARKETPLACE_IDS,
  supersededByConnector,
  type ConnectorOwnership,
} from '../lib/unifiedPluginEntries';
import type { McpServerIndexEntry } from '@canopy/execution-engine/types/mcp-servers';
import {
  computePluginShareableRef,
  normalizeGitHubRepoRef,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import { brandText } from '@/lib/brand';
import type { InstalledItemRef } from '@canopy/protocol/installed-items';
import { installedSelectionIsDisabled } from '@canopy/ui-shared';
import { INSTALLED_ITEM_STATUS_COPY } from '@canopy/ui-shared/lib';
import { useDesktopInstalledItemStatuses } from './useDesktopInstalledItemStatuses';

// The rule lives with the shared plugin-ref helpers so the main process can
// apply it for the portal; the renderer keeps this import path.
export { computePluginShareableRef };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Icon hint for the `Source` column.
 *
 * - `repo`: skill rows whose origin is a git/HTTP repository.
 * - `marketplace`: plugin marketplace rows.
 * - `claude`: Claude-only artifact (single-facet plugin row, Claude-only marketplace).
 * - `codex`: Codex-only artifact (single-facet plugin row, Codex-only marketplace).
 * - `mixed`: row that combines Claude and Codex — both logos render side by side.
 * - `app`: built-in app items.
 * - `none`: no source icon.
 */
export type SourceIconKind =
  | 'repo'
  | 'marketplace'
  | 'claude'
  | 'codex'
  | 'mixed'
  | 'app'
  | 'none';

export type UnifiedTableRowOrigin =
  | 'catalog'
  | 'pipeline-derived'
  | 'unavailable';

export type UnifiedTableBadgeTone = 'neutral' | 'info' | 'warning' | 'danger';

export interface UnifiedTableBadge {
  label: string;
  tone: UnifiedTableBadgeTone;
}

/**
 * Toggle UX modes for a row in `UnifiedTable`.
 *
 * - `normal`: standard interactive checkbox.
 * - `locked`: forced-on; checkbox renders checked and cannot be toggled.
 * - `disabled`: not toggleable in either direction (used for non-toggleable
 *   rows like pipeline-derived synthetic rows).
 * - `unsupported`: row is incompatible with the active provider scope. If
 *   currently selected (per `selectedKeys`) the checkbox remains interactive
 *   so the user can uncheck it, but it cannot be re-checked while the
 *   unsupported state is active. If not currently selected, the checkbox is
 *   disabled.
 */
export type UnifiedTableToggleMode =
  | 'normal'
  | 'locked'
  | 'disabled'
  | 'unsupported';

export interface UnifiedTableRowBase {
  installedItemRef?: InstalledItemRef;
  installedItemDisabled?: boolean;
  kind: 'skill' | 'plugin' | 'collection' | 'mcp';
  /** Unique key for selection — sourceId/name, marketplaceId/name, or collectionId */
  key: string;
  name: string;
  description: string;
  /**
   * Optional logo URL for the row's kind icon. Populated for curated MCP rows
   * (mirrored from the server's catalog metadata); the picker renders it as an
   * `<img>` with an icon fallback. `undefined` for all other rows.
   */
  logoUrl?: string;
  /**
   * Curated catalog key for MCP rows linked to a curated entry, so the kind
   * icon can prefer the bundled brand mark over the remote `logoUrl`.
   * `undefined` for uncurated servers and all other rows.
   */
  curatedKey?: string;
  /** Repo-like identifier (sourceId for skills, marketplace sourceUrl for plugins, '' for Collections) */
  source: string;
  /**
   * Stable id the source filter matches on, when the visible `source` label is
   * not itself a usable key. `UnifiedTable` filters on `sourceId ?? source`.
   */
  sourceId?: string;
  /**
   * Keep the row out of the "N selected" summary while still rendering it
   * checked. See `UnifiedTableRow` in `@canopy/ui-shared`.
   */
  excludeFromSelectionCount?: boolean;
  /**
   * Marketplace this plugin row came from.
   *
   * Carried explicitly because `source` is a display label —
   * `github:anthropics:claude-plugins-official` for a GitHub marketplace — so
   * matching an id against it silently never fires.
   */
  marketplaceId?: string;
  /** Marketplace name subtitle for plugins, '' otherwise */
  sourceSubtitle: string;
  sourceIcon: SourceIconKind;
  /** ISO date string */
  lastUpdated: string;
  /**
   * Inline badges shown next to the row name. Used by the pipeline collection
   * editor (`Pipeline`, `Required`, `Missing`) and any other consumer that
   * wants annotated rows.
   */
  badges?: UnifiedTableBadge[];
  members?: { name: string; description: string; kind: string }[];
  /**
   * Toggle UX hint:
   * - `normal` (default) — checkbox is interactive
   * - `locked` — checkbox renders checked and disabled (e.g. required pipeline default)
   * - `disabled` — checkbox is rendered disabled (used for non-toggleable rows)
   */
  toggleMode?: UnifiedTableToggleMode;
  /** Optional explanation for why the toggle is locked / disabled. */
  toggleReason?: string;
  /** Trailing host action, such as Remove on an unavailable selection. */
  rowAction?: ReactNode;
  /**
   * Portable ref for this row. Populated only for `skill` and `plugin` rows
   * whose local item is portable (built-in or GitHub-backed). Collections and MCP
   * rows never carry a `shareableRef`. Synthetic pipeline-derived rows always
   * carry one because they are themselves portable refs.
   */
  shareableRef?: ShareablePluginRef;
  /**
   * Per-provider support for plugin rows. Populated by the plugin row builder
   * and used by provider-scoped selectors to determine whether a row should
   * be enabled and which provider icons to render alongside the row.
   *
   * `undefined` for non-plugin rows (skills, Collections, MCP).
   */
  providerSupport?: PluginProviderSupport;
  /**
   * Per-plugin flag (derived by the main-process overlay) indicating the user
   * has disabled Claude→Codex compatibility for this plugin. `undefined` for
   * non-plugin rows.
   */
  codexCompatDisabled?: boolean;
}

export interface UnifiedTableCatalogRow extends UnifiedTableRowBase {
  rowOrigin: 'catalog';
  /** Original data for View callbacks. Required on catalog rows. */
  original:
    | InstalledSkillInfo
    | PluginInfo
    | CollectionIndexEntry
    | McpServerIndexEntry
    // Provider-connector rows carry their catalog entry; there is no local
    // item, because the connection lives on the provider's account.
    | CuratedMcpServerEntry;
  /**
   * Catalog rows are viewable unless there is nothing local to open.
   *
   * Provider-connector rows are the exception: they carry a catalog entry but
   * no installed server, because the connection lives on the provider's
   * account. `openUnifiedTableRowDetails` would parse their key as a local
   * server id and surface a validation error.
   */
  viewDisabled?: boolean;
}

export interface UnifiedTablePipelineDerivedRow extends UnifiedTableRowBase {
  rowOrigin: 'pipeline-derived';
  /** Pipeline-derived rows have no local item, so `original` is omitted. */
  original?: never;
  /** Pipeline-derived rows are always view-disabled. */
  viewDisabled: true;
}

/** A selected capability the inventory no longer lists. */
export interface UnifiedTableUnavailableRow extends UnifiedTableRowBase {
  rowOrigin: 'unavailable';
  original?: never;
  viewDisabled: true;
}

export type UnifiedTableRow =
  | UnifiedTableCatalogRow
  | UnifiedTablePipelineDerivedRow
  | UnifiedTableUnavailableRow;

export interface SourceOption {
  value: string;
  label: string;
  subtitle?: string;
  icon: 'repo' | 'marketplace' | 'claude' | 'codex' | 'mixed' | 'app';
}

export interface UseUnifiedTableDataOptions {
  /** Read-only management details may still resolve Disabled members. */
  includeDisabled?: boolean;
  retainedDisabledKeys?: ReadonlySet<string>;
  includeCollections: boolean;
  includeMcp: boolean;
  /**
   * Show capabilities linked on the user's provider account.
   *
   * Separate from `includeMcp` because "checked" does not mean the same thing
   * on every surface. In a chat or workspace picker it means "active in this
   * session", which a linked connector genuinely is. In the Collection editor
   * it means "member of this collection" — and a connector is never written to
   * a collection, carries nothing when one is shared, and cannot be unticked.
   * A ticked row there asserts a membership that does not exist.
   */
  includeProviderConnectors?: boolean;
  /**
   * Collapse the duplicate copies of a capability that the overlapping
   * marketplaces both publish, the way the Plugins page does. Off by default:
   * a caller with saved selections that is not passing `selectedKeys` would
   * otherwise find a selected row hidden and unremovable.
   */
  collapseDuplicates?: boolean;
  /**
   * Keys the caller already has selected.
   *
   * Only used to break duplicate-collapse ties, so a row the user's saved
   * configuration refers to is never the one hidden.
   */
  selectedKeys?: ReadonlySet<string>;
  /**
   * The organization's shared skills for the chat's workspace (CAN-6237).
   * Their copies are not in the skill inventory, so each gets a row here,
   * named as the organization names it.
   */
  organizationItems?: readonly OrganizationLayerItem[];
}

export interface UseUnifiedTableDataReturn {
  rows: UnifiedTableRow[];
  sourceOptions: SourceOption[];
  loading: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a portable `ShareablePluginRef` for a skill row, when possible.
 * Returns `undefined` when the skill's source is not portable (e.g. local dir
 * install).
 */
function computeSkillShareableRef(
  skill: InstalledSkillInfo,
): ShareablePluginRef | undefined {
  const source = skill.shareableSource;
  if (!source) {
    return undefined;
  }

  const trimmedName = skill.name.trim();
  if (trimmedName.length === 0) {
    return undefined;
  }

  if (source.type === 'builtin') {
    return {
      type: 'skill',
      source: { type: 'builtin', id: 'app' },
      skill_name: trimmedName,
    };
  }

  // github
  try {
    const repo = normalizeGitHubRepoRef(source.repo);
    return {
      type: 'skill',
      source: { type: 'github', repo },
      skill_name: trimmedName,
    };
  } catch {
    return undefined;
  }
}

/**
 * Pick the source-column icon for a plugin row from its per-provider facets.
 * `mixed` requires both Claude and Codex to be renderable (native or compat).
 */
export function computePluginSourceIcon(
  support: PluginProviderSupport,
): SourceIconKind {
  const hasClaude = support.claude === 'native';
  const hasCodex = support.codex === 'native' || support.codex === 'compat';
  if (hasClaude && hasCodex) return 'mixed';
  if (hasClaude) return 'claude';
  if (hasCodex) return 'codex';
  return 'none';
}

/**
 * Format a marketplace `sourceUrl` for display. GitHub-backed marketplaces
 * render as `github:<owner>:<repo>` so the picker matches the skill source
 * format. Non-GitHub sources fall back to the raw URL.
 */
export function formatMarketplaceSourceLabel(
  sourceType: string,
  sourceUrl: string,
): string {
  if (sourceType === 'builtin') {
    return `${brandText.appName} (built-in)`;
  }
  if (sourceType === 'github') {
    const repo = parseGitHubRepo(sourceUrl);
    if (repo) {
      const [owner, name] = repo.split('/');
      return `github:${owner}:${name}`;
    }
  }
  if (sourceType === 'codex') {
    return sourceUrl || 'Codex';
  }
  return sourceUrl;
}

/**
 * Build a portable `ShareablePluginRef` for a marketplace plugin row, when
 * its marketplace is GitHub-backed. Returns `undefined` for non-GitHub
 * marketplaces or malformed repo strings.
 *
 * Note: the persisted wire-type discriminator is still `'claude_plugin'` for
 * backward compatibility with existing canopy.json files (see
 * `ShareableClaudePluginRef`). The ref itself is provider-neutral and resolves
 * against whichever providers are valid for the marketplace at runtime.
 *
 * Built-in marketplace plugins emit a `{ type: 'builtin', id: 'app' }`
 * marketplace ref so they round-trip into `canopy.json` and resolve against the
 * bundled catalog rather than a GitHub repo.
 */

/** Source id shared by every provider-connector row, so the filter can match. */
export const PROVIDER_CONNECTOR_SOURCE_ID = 'provider-account';
/**
 * Collapse the same plugin published by overlapping marketplaces.
 *
 * The Plugins page has done this since the capability list was first
 * consolidated; the picker had not, so the two surfaces reported different
 * counts for the same capability — which is the disagreement this whole change
 * is named for. Shares the marketplace set with the Plugins page rather than
 * keeping a second copy, because a second hand-kept list is how this feature's
 * earlier drift bug started.
 *
 * A row the user has already selected always wins, so collapsing can never
 * hide something their saved configuration refers to.
 */
export function collapseDuplicatePluginRows(
  rows: readonly UnifiedTableRow[],
  selectedKeys: ReadonlySet<string> = new Set(),
): UnifiedTableRow[] {
  return collapseByCoverage(rows, {
    // A row whose provider support is missing — an older on-disk marketplace
    // cache — opts out of collapsing entirely. Treating it as reaching
    // everything was meant to keep it safe, but "reaches everything" is
    // precisely what makes it *cover*, and therefore evict, every Claude-only
    // and Codex-only sibling. Not grouping it means an undescribed row is
    // neither collapsed nor the reason something else is.
    groupKey: (row) =>
      row.kind === 'plugin' &&
      row.marketplaceId !== undefined &&
      row.providerSupport !== undefined &&
      OVERLAPPING_MARKETPLACE_IDS.has(row.marketplaceId)
        ? row.name.toLowerCase()
        : null,
    // Unreachable by construction: `groupKey` returns null for a row with no
    // declared support, so nothing ungrouped ever reaches this. The value is
    // deliberately not `{ claude: true, codex: true }` anyway — "reaches
    // everything" is what makes a row *cover*, and an undescribed row that
    // covers would evict every single-provider sibling. Neither value is
    // safe on its own, which is why the opt-out lives in `groupKey`.
    reach: (row) =>
      row.providerSupport
        ? capabilityReach(row.providerSupport)
        : { claude: false, codex: false },
    // A row the user has already selected is never dropped, so collapsing
    // cannot hide something their saved configuration refers to. It displaces
    // another copy only when it covers it — pinning a Codex-only copy must not
    // take the Claude-capable one away from Claude users.
    pinned: (row) => selectedKeys.has(row.key),
  });
}

/**
 * The source-filter option connector rows match on.
 *
 * Extracted so it is testable and so it cannot drift from the `sourceId` the
 * rows carry — the two were written apart once and only the row half landed,
 * which left the filter as an allowlist with no way to select these rows:
 * checking any other source hid every connector.
 */
export function buildProviderConnectorSourceOptions(
  curatedMcpServers: readonly CuratedMcpServerEntry[],
): SourceOption[] {
  const advertised = curatedMcpServers.some(advertisesProviderConnector);
  return advertised
    ? [
        {
          value: PROVIDER_CONNECTOR_SOURCE_ID,
          label: 'Provider account',
          icon: 'app',
        },
      ]
    : [];
}

/**
 * How a connector row should describe itself, given what the reads returned.
 *
 * Extracted so the row builder stays under the complexity threshold, and so
 * the three-way state — linked, not linked, still reading — is decided in one
 * place. Conflating "still reading" with "not linked" is the defect this whole
 * surface keeps reproducing.
 */
function describeConnectorState(row: ProviderConnectorRow): {
  providers: string;
  connectedProviders: readonly string[];
  linked: boolean;
  subtitle: string;
} {
  const linked = row.providers.some((provider) => provider.connected);
  // Once linked, name only the accounts it is actually linked on. Naming every
  // provider the catalog advertises turns a Gmail linked on Claude alone into a
  // checked row reading "Claude or Codex account · Linked" — in a Codex-scoped
  // workspace that asserts a capability the user does not have, which is the
  // false claim this surface exists to stop making.
  const named = linked
    ? row.providers.filter((provider) => provider.connected)
    : row.providers;
  const providers = named
    .map((provider) => (provider.provider === 'claude' ? 'Claude' : 'Codex'))
    .join(' or ');
  // Any provider still being read leaves the answer incomplete. Requiring
  // every one to be pending meant that once Claude had answered, the row said
  // "Link it there to use it here" about a Codex read still outstanding.
  const pending = !linked && row.providers.some((provider) => provider.pending);
  // A provider Canopy could not read at all — the Claude CLI missing, the read
  // failing — is not a provider the user has not linked. Saying so asserts a
  // negative this surface cannot support, which is the claim it exists to stop
  // making.
  const unreadable =
    !linked &&
    !pending &&
    row.providers.some((provider) => provider.unavailable !== undefined);
  const subtitle = pending
    ? 'Checking…'
    : unreadable
      ? 'Couldn’t check your account'
      : linked
        ? 'Linked'
        : 'Link it there to use it here';
  return {
    providers,
    connectedProviders: row.providers
      .filter((provider) => provider.connected)
      .map((provider) => provider.provider),
    linked,
    subtitle,
  };
}

/**
 * Rows for capabilities the user links on their provider account.
 *
 * Never selectable, but the affordance depends on whether it is actually
 * linked, because `UnifiedTable` renders `checked={locked || checked}`. Using
 * `locked` unconditionally would show a checked row for an account nobody has
 * connected — the same false claim this surface was fixed to stop making
 * elsewhere. So: linked is `locked` (checked, unchangeable, and true), while
 * unlinked or still-being-read is `disabled` (unchecked, unchangeable, and
 * also true).
 *
 * It is never `normal`. A connector authenticates on the user's Claude or
 * Codex account and both CLIs merge account connectors into every session, so
 * Canopy never passes them and cannot scope them per workspace. A live
 * checkbox would be inert in both directions.
 *
 * @param results Per-provider reads. `undefined` means none have been
 *   attempted yet, which is distinct from an empty array — that is an answer.
 */
export function buildProviderConnectorRowsForPicker(
  curatedMcpServers: readonly CuratedMcpServerEntry[],
  results: readonly ProviderConnectorListResult[] | undefined,
): UnifiedTableCatalogRow[] {
  // The same join the Plugins list and the detail panel use. Computing linked
  // state here independently is what made those two disagree once already —
  // this is the third surface, and a third copy would drift the same way. It
  // also routes through `resolveProviderConnectorCatalog`, so catalog quirks
  // like `providers: []` are handled in one place.
  const rows = buildProviderConnectorRows(results ?? [], [
    ...curatedMcpServers,
  ]);
  const picked: UnifiedTableCatalogRow[] = [];
  for (const row of rows) {
    // Catalog-derived rows always carry `curatedKey`; a row without one was
    // appended by `buildProviderConnectorRows` precisely because the catalog
    // never described it, so it has no entry to own and no place in a picker.
    const entry = row.curatedKey
      ? curatedMcpServers.find((candidate) => candidate.key === row.curatedKey)
      : undefined;
    // Only advertised catalog entries belong in a picker; a connector the
    // provider reports but the catalog never described has no row to own.
    if (!entry || !advertisesProviderConnector(entry)) continue;
    if (row.providers.length === 0) continue;
    const state = describeConnectorState(row);
    const { providers, linked } = state;
    picked.push({
      kind: 'mcp',
      key: `provider-connector:${entry.key}`,
      name: entry.name,
      description: entry.shortDescription,
      ...(entry.logoUrl ? { logoUrl: entry.logoUrl } : {}),
      curatedKey: entry.key,
      // The Source cell is gated on `source`, so the explanation has to live
      // there to render at all.
      source: `${providers} account`,
      // `UnifiedTable` filters on `sourceId ?? source`, so without an id these
      // rows vanish the moment any source filter is applied.
      sourceId: PROVIDER_CONNECTOR_SOURCE_ID,
      sourceSubtitle: state.subtitle,
      sourceIcon: 'none',
      lastUpdated: entry.updatedAt,
      // `UnifiedTable` renders `checked={locked || checked}`, so the mode is
      // the claim: `locked` asserts the capability is active. Only true once
      // linked; otherwise `disabled` — unchecked, unchangeable, and honest.
      toggleMode: linked ? 'locked' : 'disabled',
      // Which providers this is actually live on, so a provider-scoped picker
      // can tell that a Gmail linked on Claude alone is not active in a
      // Codex-only workspace. Without it the row stayed checked there, and
      // checked means "active in this session".
      providerSupport: {
        claude: state.connectedProviders.includes('claude') ? 'native' : 'none',
        codex: state.connectedProviders.includes('codex') ? 'native' : 'none',
      },
      // Checked to state a fact, not to record a choice — the picker puts
      // linked connectors in `selectedKeys` so the box renders ticked and the
      // Selected filter finds them, but they are account-level and never
      // saved, so "1 MCP server selected" would be a claim the user never made.
      excludeFromSelectionCount: true,
      toggleReason: linked
        ? `Managed on your ${providers} account, so it is available in every chat on that provider and cannot be selected per project.`
        : `Managed on your ${providers} account. Link it there and it becomes available in every chat on that provider.`,
      rowOrigin: 'catalog',
      // There is no local server to open. `openUnifiedTableRowDetails` parses
      // every `kind: 'mcp'` key as `serverId/configId` and slices at the first
      // `/`; this key has none, so the slice truncates a character and the id
      // fails the main process's validation, surfacing a raw error.
      viewDisabled: true,
      original: entry,
    });
  }
  return picked;
}

/**
 * Build the picker rows for MCP servers — one per ENABLED config.
 *
 * Config-name rule: a single enabled config drops the config name (the server
 * name alone identifies the row); multiple enabled configs keep the
 * `${server} — ${config}` disambiguator. Curated servers carry a `logoUrl` so
 * the picker can render the server's logo instead of the generic MCP icon.
 */
export function buildMcpRows(
  mcpServers: McpServerIndexEntry[],
): UnifiedTableCatalogRow[] {
  const rows: UnifiedTableCatalogRow[] = [];
  const flattened = flattenMcpServerRows(mcpServers);
  // Several accounts of one connector (CAN-6226) are one row each, named by
  // the account, so two Slack accounts never read as two "Slack" rows.
  const accountsPerKey = new Map<string, number>();
  for (const s of flattened)
    if (s.scope === 'account')
      accountsPerKey.set(s.id, (accountsPerKey.get(s.id) ?? 0) + 1);
  // Account rows nest the device servers they shadow; pickers must still
  // offer those device copies so a broken account route never strands them.
  for (const s of flattened) {
    const enabledConfigs = s.configs.filter((c) => c.enabled);
    const singleConfig = enabledConfigs.length <= 1;
    const namesAccount =
      s.scope === 'account' && (accountsPerKey.get(s.id) ?? 0) > 1;
    for (const c of enabledConfigs) {
      rows.push({
        rowOrigin: 'catalog',
        kind: 'mcp',
        key: `${s.id}/${c.id}`,
        installedItemRef: {
          kind: 'mcp-config',
          serverId: s.id,
          configId: c.id,
        },
        name: singleConfig && !namesAccount ? s.name : `${s.name} — ${c.name}`,
        description: s.description,
        source: s.type === 'command' ? 'CLI' : 'HTTP',
        sourceSubtitle: '',
        sourceIcon: 'none',
        logoUrl: s.logoUrl,
        curatedKey: s.curatedKey,
        lastUpdated: s.updatedAt,
        original: s,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useUnifiedTableData(
  options: UseUnifiedTableDataOptions,
): UseUnifiedTableDataReturn {
  const installedStatus = useDesktopInstalledItemStatuses(
    !options.includeDisabled,
  );
  const { skills, loading: skillsLoading } = useSkillList();
  const { cache, loading: marketplaceLoading } = useMarketplaceList();
  const { collections, loading: collectionsLoading } = useCollectionList();
  const { servers: mcpServers, loading: mcpLoading } = useMcpServerList();
  const wantsConnectors = options.includeProviderConnectors === true;
  // Gated on `wantsConnectors`, not `includeMcp`: these entries are read only
  // inside the connector blocks, so a caller that shows no connector rows —
  // the Collection editor — was paying an IPC, and a live cloud fetch on a
  // stale cache, for a result it discards.
  const { entries: curatedMcpServers, loading: curatedLoading } =
    useCuratedMcpServers({ enabled: wantsConnectors });
  // No advertised connector means no connector row can result, so the read —
  // which spawns the Claude CLI and parses the Codex caches — would be paid for
  // a result that is discarded. The catalog answers this cheaply and first.
  const advertisesConnector =
    wantsConnectors && curatedMcpServers.some(advertisesProviderConnector);
  // `undefined` until the first read settles, so a row can say "checking"
  // rather than asserting a connector is unlinked before anyone asked.
  // Only the surfaces that render connector rows pay the CLI spawn this read
  // costs; the Collection editor and every `includeMcp: false` caller do not.
  const { results: connectorResults, loading: connectorsLoading } =
    useProviderConnectors({ enabled: advertisesConnector });

  const builtRows = useMemo(() => {
    const result: UnifiedTableRow[] = [];

    // Skills
    for (const s of skills) {
      const sourceLabel = s.builtIn
        ? `${brandText.appName} (built-in)`
        : s.custom
          ? `${brandText.appName} (custom)`
          : s.sourceId;
      const sourceIcon = s.builtIn || s.custom ? 'app' : 'repo';
      result.push({
        rowOrigin: 'catalog',
        kind: 'skill',
        installedItemRef: {
          kind: 'skill',
          sourceId: s.sourceId,
          skillName: s.name,
        },
        key: `${s.sourceId}/${s.name}`,
        name: s.name,
        description: s.description,
        source: sourceLabel,
        sourceSubtitle: '',
        sourceIcon,
        lastUpdated: s.updatedAt,
        original: s,
        shareableRef: computeSkillShareableRef(s),
      });
    }

    // The organization's skills, which the inventory does not list.
    const listedSkillKeys = new Set(
      result.flatMap((row) => (row.kind === 'skill' ? [row.key] : [])),
    );
    for (const item of options.organizationItems ?? []) {
      if (item.ref.kind !== 'skill') continue;
      const key = `${item.ref.sourceId}/${item.ref.skillName}`;
      if (listedSkillKeys.has(key)) continue;
      listedSkillKeys.add(key);
      const skill: InstalledSkillInfo = {
        name: item.ref.skillName,
        sourceId: item.ref.sourceId,
        description: '',
        source: ORGANIZATION_SKILL_SOURCE_LABEL,
        installedAt: '',
        updatedAt: '',
        updateAvailable: false,
      };
      result.push({
        rowOrigin: 'catalog',
        kind: 'skill',
        installedItemRef: {
          kind: 'skill',
          sourceId: item.ref.sourceId,
          skillName: item.ref.skillName,
        },
        key,
        name: item.name,
        description: '',
        source: ORGANIZATION_SKILL_SOURCE_LABEL,
        sourceSubtitle: '',
        sourceIcon: 'none',
        lastUpdated: '',
        // Its details live with the organization, not in this inventory.
        viewDisabled: true,
        original: skill,
      });
    }

    // Plugins
    if (cache?.marketplaces) {
      for (const m of cache.marketplaces) {
        const sourceLabel = formatMarketplaceSourceLabel(
          m.sourceType,
          m.sourceUrl,
        );
        for (const p of m.plugins) {
          const providerSupport = p.providerSupport;
          result.push({
            rowOrigin: 'catalog',
            kind: 'plugin',
            installedItemRef: {
              kind: 'plugin',
              marketplaceId: m.id,
              pluginName: p.name,
            },
            key: `${p.marketplaceId}/${p.name}`,
            name: p.name,
            description: p.description ?? '',
            marketplaceId: p.marketplaceId,
            source: sourceLabel,
            sourceSubtitle: m.name,
            sourceIcon:
              m.builtIn || m.sourceType === 'codex' ? 'app' : 'marketplace',
            lastUpdated: p.cachedAt ?? m.lastUpdated ?? '',
            original: p,
            shareableRef: computePluginShareableRef(p, m),
            providerSupport,
            codexCompatDisabled: p.codexCompatDisabled,
          });
        }
      }
    }

    // Collections (workspace context only).
    if (options.includeCollections) {
      for (const c of collections) {
        result.push({
          rowOrigin: 'catalog',
          kind: 'collection',
          installedItemRef: { kind: 'collection', collectionId: c.id },
          key: c.id,
          name: c.name,
          description: c.description,
          source: '',
          sourceSubtitle: '',
          sourceIcon: 'none',
          lastUpdated: c.updatedAt,
          original: c,
        });
      }
    }

    // MCP server configs (one row per enabled config); see buildMcpRows.
    if (options.includeMcp) {
      result.push(...buildMcpRows(mcpServers));
      // Locked rows for capabilities linked on the provider's account. Grouped
      // with MCP because that is what they are to the user, even though Canopy
      // does not own the connection.
      if (options.includeProviderConnectors === true) {
        // Passed straight through: the hook already distinguishes "not read
        // yet" from "read, nothing linked", so there is nothing to
        // reconstruct — and reconstructing it is what got this wrong before.
        const connectorRows = buildProviderConnectorRowsForPicker(
          curatedMcpServers,
          connectorResults,
        );
        result.push(...connectorRows);
      }
    }

    return result;
  }, [
    skills,
    options.organizationItems,
    cache,
    collections,
    options.includeCollections,
    options.includeProviderConnectors,
    mcpServers,
    curatedMcpServers,
    connectorResults,
    options.includeMcp,
  ]);

  // Deliberately a second memo. Collapsing depends on the selection, and
  // folding it into the builder above rebuilt every row object on every
  // checkbox toggle — which defeats `React.memo` on the rows, re-runs the
  // whole-catalog `localeCompare` sort, and re-derives the selection summary.
  // `docs`/CLAUDE.md pin that as an invariant ("a selection toggle re-renders
  // one row rather than the whole body") and `perf:desktop` measures it at
  // 850–1,700 plugins.
  //
  // Opt-in, not automatic. Collapsing hides a row, and a caller that never
  // asked for it — the share modals, the collection editors — can hold a saved
  // selection pointing at the hidden copy, which then reads as unselected and
  // cannot be removed. Only the picker, which passes its selection set, takes
  // this.
  const previousCollapsed = useRef<UnifiedTableRow[] | null>(null);
  /** Preserve array identity when a toggle changed nothing that is displayed. */
  const sameRowsOrPrevious = (next: UnifiedTableRow[]): UnifiedTableRow[] => {
    const previous = previousCollapsed.current;
    if (
      previous &&
      previous.length === next.length &&
      previous.every((row, index) => row === next[index])
    ) {
      return previous;
    }
    previousCollapsed.current = next;
    return next;
  };
  const rows = useMemo(() => {
    // The provider also publishes a marketplace wrapper for the capabilities it
    // exposes as connectors, so listing both showed two Gmails — the duplicate
    // this change exists to remove, on the surface it just fixed. The wrapper
    // is the dead end (Canopy does not implement its ON_INSTALL auth) and the
    // only one of the two the user can tick, so it is the copy to drop. Never
    // drop something the user's saved configuration already refers to, which is
    // this surface's analogue of the Plugins page's "nothing the user already
    // has is ever suppressed".
    const connectorRows = builtRows.filter(
      (row) => row.sourceId === PROVIDER_CONNECTOR_SOURCE_ID,
    );
    const deduped =
      connectorRows.length === 0
        ? builtRows
        : ((): UnifiedTableRow[] => {
            const ownership: ConnectorOwnership = {
              names: new Set(
                connectorRows.map((row) => row.name.toLowerCase()),
              ),
              keys: new Set(
                connectorRows.flatMap((row) =>
                  row.curatedKey !== undefined ? [row.curatedKey] : [],
                ),
              ),
            };
            return builtRows.filter(
              (row) =>
                // Only a catalog row — something the user could install but
                // has not — is ever suppressed. This mirrors the Plugins
                // page's rule that nothing the user already has is hidden;
                // there it reads `state !== 'available'`, and here every
                // *other* `kind: 'mcp'` row is a server the user configured
                // and enabled, so it is already the "installed" case. The
                // connector rows are `kind: 'mcp'` too and must never suppress
                // themselves — their own `curatedKey` is in `ownership.keys`.
                // Suppressing
                // those replaced a working, selectable server with a
                // `disabled` row reading "Link it there to use it here" —
                // even with nothing linked — and `selectedKeys` could not
                // save it, because the picker passes plugin keys only and
                // MCP selections live in a set this hook never sees.
                row.kind !== 'plugin' ||
                options.selectedKeys?.has(row.key) === true ||
                // The name rule is for a provider marketplace's wrapper of
                // the connector. A curated plugin is not one: a multi-key
                // plugin named like a connector keeps its row, as it keeps
                // its card on the Plugins page (REG-3033).
                (row.marketplaceId !== undefined &&
                  isCuratedPluginMarketplaceId(row.marketplaceId)) ||
                !supersededByConnector(row, ownership),
            );
          })();
    const statusState = installedStatus.state;
    const eligible =
      options.includeDisabled || statusState.kind === 'unsupported'
        ? deduped
        : statusState.kind === 'loading'
          ? []
          : statusState.kind === 'error'
            ? // A failed read keeps rows selectable: the resolver and session
              // loading re-read the policy and still exclude Disabled items.
              deduped.map(
                (row): UnifiedTableRow => ({
                  ...row,
                  badges: [
                    ...(row.badges ?? []),
                    { label: 'Status unavailable', tone: 'warning' },
                  ],
                }),
              )
            : deduped.flatMap((row): UnifiedTableRow[] => {
                if (
                  !row.installedItemRef ||
                  !installedSelectionIsDisabled(
                    statusState.snapshot,
                    row.installedItemRef,
                  )
                )
                  return [row];
                return options.retainedDisabledKeys?.has(
                  `${row.kind}:${row.key}`,
                )
                  ? [
                      {
                        ...row,
                        installedItemDisabled: true,
                        toggleMode: 'unsupported',
                        toggleReason:
                          INSTALLED_ITEM_STATUS_COPY.disabled.description,
                        badges: [
                          ...(row.badges ?? []),
                          {
                            label: INSTALLED_ITEM_STATUS_COPY.disabled.label,
                            tone: 'neutral',
                          },
                        ],
                      },
                    ]
                  : [];
              });
    if (!options.collapseDuplicates) return sameRowsOrPrevious(eligible);
    const collapsed = collapseDuplicatePluginRows(
      eligible,
      options.selectedKeys,
    );
    // A toggle that changes nothing about which copies survive must not change
    // the array identity either, or the split above buys nothing.
    return sameRowsOrPrevious(collapsed);
  }, [
    builtRows,
    options.collapseDuplicates,
    options.selectedKeys,
    options.includeDisabled,
    options.retainedDisabledKeys,
    installedStatus.state,
  ]);

  const sourceOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: SourceOption[] = [];

    if (wantsConnectors) {
      for (const option of buildProviderConnectorSourceOptions(
        curatedMcpServers,
      )) {
        seen.add(option.value);
        opts.push(option);
      }
    }

    // Skill sources (repos, built-in, and custom)
    for (const s of skills) {
      const sourceValue = s.builtIn
        ? `${brandText.appName} (built-in)`
        : s.custom
          ? `${brandText.appName} (custom)`
          : s.sourceId;
      if (!seen.has(sourceValue)) {
        seen.add(sourceValue);
        opts.push({
          value: sourceValue,
          label: sourceValue,
          icon: s.builtIn || s.custom ? 'app' : 'repo',
        });
      }
    }

    // Marketplace sources — render with the marketplace (storefront) icon to
    // distinguish them from skill repo sources, and format GitHub URLs as
    // `github:<owner>:<repo>` so the label matches the skill format.
    if (cache?.marketplaces) {
      for (const m of cache.marketplaces) {
        const sourceLabel = formatMarketplaceSourceLabel(
          m.sourceType,
          m.sourceUrl,
        );
        if (!seen.has(sourceLabel)) {
          seen.add(sourceLabel);
          opts.push({
            value: sourceLabel,
            label: sourceLabel,
            subtitle: m.name,
            icon: m.builtIn || m.sourceType === 'codex' ? 'app' : 'marketplace',
          });
        }
      }
    }

    opts.sort((a, b) => a.label.localeCompare(b.label));
    return opts;
  }, [skills, cache, wantsConnectors, curatedMcpServers]);

  const loading =
    (!options.includeDisabled && installedStatus.state.kind === 'loading') ||
    skillsLoading ||
    marketplaceLoading ||
    (options.includeMcp && mcpLoading) ||
    // Otherwise the table reports settled while connector rows are still
    // absent, and then grows — the late-arrival class this PR is fixing.
    (wantsConnectors && (curatedLoading || connectorsLoading)) ||
    (options.includeCollections && collectionsLoading);

  return { rows, sourceOptions, loading };
}
