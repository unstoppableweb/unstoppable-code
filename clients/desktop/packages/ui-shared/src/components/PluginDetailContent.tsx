import { Badge } from './Badge';
import { Stack } from './Stack';
import { pluginDisplayName } from '../lib/plugin-display-name';
import { pluginDisplayAuthor } from '../lib/official-marketplace-products';
import {
  type JSX,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from './Button';
import { ClickableName } from './ClickableName';
import { ComponentSection } from './ComponentSection';
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  type DataTableColumn,
} from './DataTable';
import { Disclosure } from './Disclosure';
import { DetailFact, DetailFactList } from './DetailFact';
import { DetailEntityType } from './MarketplaceTypeLabel';
import { ExternalTextLink } from './ExternalTextLink';
import { Markdown, type MarkdownProps } from './Markdown';
import { MarkdownFrontmatterContent } from './MarkdownFrontmatterContent';
import { PluginDetailSectionHeading } from './PluginDetailSectionHeading';
import { PluginModNotice, pluginModRows } from './PluginModMembers';
import { ErrorBanner } from './StatusBlocks';
import { Tooltip } from './Tooltip';
import { McpServerLogo } from './McpServerLogo';
import {
  HarnessLogoList,
  PluginWorksWith,
  type PluginHarnessConnectionRow,
} from './PluginHarnessConnections';
import { ChevronLeftMediumIcon } from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { mcpEndpointKey } from '../lib/mcp-endpoint-key';
import type { UnifiedEntryBundledServerRow } from '../lib/unified-plugin-entry';
import { PLUGIN_DETAIL_MCP_NOT_CONFIGURED } from '../lib/plugin-detail-mcp';

import type {
  PluginDetails,
  PluginLspServerInfo,
  PluginMcpServerInfo,
  PluginProviderFacet,
  PluginProviderSupport,
} from '@canopy/protocol/plugins';

// ---------------------------------------------------------------------------
// Shared presentational core of the plugin detail surface (PR 5 of
// docs/planning/2026-08-27-portal-plugins-section/design.md).
//
// Extracted from the desktop `PluginDetailView`: header metadata, provider
// facet tabs, README section, and the component tables. Class names, testids,
// and copy match the previous desktop inline implementation exactly so
// desktop tests/selectors and visual diffs are unchanged.
//
// Everything environment-specific is injected:
// - `onReadComponent` performs the actual content read (desktop: IPC against
//   the active facet's install root; web: `portal.plugins.read_component_content`).
// - `metadataFooter` / `installActions` are render slots for host-owned
//   mutation UI (desktop install panels + codex-compat switch); the web
//   detail page leaves them empty in the read-only phase A.
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Provider facet kind vocabulary shared with the desktop cache shapes. */
export type PluginDetailFacetKind = 'claude' | 'codex' | 'codexCompatibility';

/** One renderable facet slot: its kind plus the facet payload. */
export interface PluginMcpNavigationTarget {
  readonly serverName: string;
  readonly provider?: 'claude' | 'codex';
  readonly requestId: string;
}

export interface PluginDetailFacetSlot {
  kind: PluginDetailFacetKind;
  facet: PluginProviderFacet;
}

/** Which kind of component content a read request targets. */
export type PluginDetailComponentType =
  | 'readme'
  | 'skill'
  | 'agent'
  | 'command'
  | 'app';

/**
 * Content returned by `onReadComponent`. `truncated` is set by transports
 * that cap payload sizes (the portal commands); the desktop IPC never sets it.
 */
export interface PluginDetailComponentContent {
  frontmatter: Record<string, unknown>;
  body: string;
  truncated?: boolean;
}

/**
 * Injected content reader. `activeFacet` is the facet the user is currently
 * viewing (undefined when the plugin has none), so hosts that resolve reads
 * against per-facet roots (desktop) can derive the exact paths per call.
 *
 * Contract: resolve with the content, resolve `null` for a generic failure
 * (the section shows its stock error copy), or throw an `Error` whose message
 * is shown verbatim.
 */
export type PluginDetailReadComponent = (
  componentType: PluginDetailComponentType,
  componentFile: string,
  activeFacet: PluginDetailFacetSlot | undefined,
) => Promise<PluginDetailComponentContent | null>;

/**
 * Structural plugin shape the detail content renders. `PluginInfo` (desktop
 * cache row) is assignable as-is; the web detail page assembles one from the
 * portal `get_plugin_detail` result (no facets, merged top-level fields).
 */
export interface PluginDetailContentPlugin {
  name: string;
  /** Human-readable label; `name` remains the stable provider/install key. */
  displayName?: string;
  description?: string;
  version?: string;
  author?: string;
  category?: string;
  homepage?: string;
  marketplaceId: string;
  details?: PluginDetails | null;
  providerSupport: PluginProviderSupport;
  facets?: {
    claude?: PluginProviderFacet;
    codex?: PluginProviderFacet;
    codexCompatibility?: PluginProviderFacet;
  };
  codexCompatDisabled?: boolean;
  /** Local cache directory, when installed (desktop rows only). */
  cachePath?: string;
  /** Marketplace-relative source path (desktop rows only). */
  sourcePath?: string;
}

export interface PluginDetailContentProps {
  plugin: PluginDetailContentPlugin;
  /**
   * Back to where the host opened the detail. Omit where that would only
   * repeat the breadcrumb's parent; Back then shows only to close an open
   * component view.
   */
  onBack?: () => void;
  onReadComponent: PluginDetailReadComponent;
  /**
   * Preloaded README body (web: `get_plugin_detail` ships it). When absent
   * the README section lazy-loads on expand via `onReadComponent`.
   */
  readme?: { body: string; truncated?: boolean };
  markdownOptions?: MarkdownProps['options'];
  /**
   * Host-owned block rendered inside the metadata section, after the
   * homepage link (desktop: compat error + codex-compat mode switch).
   */
  metadataFooter?: ReactNode;
  /** Host `DetailFact` rows, listed after Website. */
  metadataFacts?: ReactNode;
  /** Host-owned notice right under the metadata, such as an available update. */
  updateNotice?: ReactNode;
  /** Host-owned Status row, under the metadata and any update notice. */
  statusContent?: ReactNode;
  /** Where the plugin runs, one row per harness, after the Status row. */
  harnessRows?: readonly (PluginHarnessConnectionRow & {
    readonly alternative?: {
      label: string;
      onOpen: () => void;
      iconOnly?: boolean;
    };
    readonly note?: string;
  })[];
  /**
   * Host-owned block rendered between the metadata section and the README
   * (desktop: built-in install panel, external source box, install prompt,
   * installing spinner). Empty on the read-only web page.
   */
  installActions?: ReactNode;
  /** Host-owned "Shared by you" section, after the install area. */
  sharedContent?: ReactNode;
  /** Host-owned control rendered before the Mods table, when supported. */
  modsControl?: ReactNode;
  /** Hide the component tables (desktop: while uninstalled/installing). */
  hideComponents?: boolean;
  /** Optional related-item sections appended after the components tables. */
  relatedContent?: ReactNode;
  /** Optional host-owned actions placed in the detail header. */
  headerActions?: ReactNode;
  /** Host-resolved marketplace identity mark; falls back to the shared avatar. */
  headerIcon?: ReactNode;
  titleAs?: 'h1' | 'h2';
  /** Authoritative listing author; null explicitly omits unavailable metadata. */
  authorDisplay?: string | null;
  /**
   * Installed MCP rows hidden behind this plugin (CAN-3653). Customize lists
   * them only here, so each bundled server with a row opens that row's own
   * settings through `onOpenEntryId`.
   */
  bundledServerRows?: readonly UnifiedEntryBundledServerRow[];
  onOpenEntryId?: (entryId: string) => void;
  mcpTarget?: PluginMcpNavigationTarget;
  /**
   * A bundled MCP server's Status cell (health and Test connection). Absent,
   * or `undefined` for a server, reads "Not configured yet".
   */
  renderMcpServerStatus?: (
    server: PluginMcpServerInfo,
  ) => ReactNode | undefined;
}

// ---------------------------------------------------------------------------
// Component content view (lazy per-component read)
// ---------------------------------------------------------------------------

function TruncatedNotice(): JSX.Element {
  return (
    <p
      className="mt-3 text-xs fg-secondary"
      data-testid="plugin-detail-truncated-notice"
      role="note"
    >
      Content was truncated.
    </p>
  );
}

function ComponentContentView({
  markdownOptions,
  titleAs = 'h2',
  name,
  componentType,
  componentFile,
  activeFacet,
  readKey,
  onReadComponent,
}: {
  markdownOptions?: MarkdownProps['options'];
  titleAs?: 'h1' | 'h2';
  name: string;
  componentType: PluginDetailComponentType;
  componentFile: string;
  activeFacet: PluginDetailFacetSlot | undefined;
  /**
   * Stable token for the resolved content roots (facet kind + paths). The
   * fetch keys on this VALUE rather than on `activeFacet`'s object identity
   * so a parent re-render with an equivalent facet does not refetch —
   * matching the previous desktop path-based effect dependencies.
   */
  readKey: string;
  onReadComponent: PluginDetailReadComponent;
}): JSX.Element {
  const Title = titleAs;
  const [content, setContent] = useState<PluginDetailComponentContent | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setContent(null);

    void (async (): Promise<void> => {
      try {
        const result = await onReadComponent(
          componentType,
          componentFile,
          activeFacet,
        );
        if (cancelled) return;
        if (result) {
          setContent(result);
        } else {
          setError('Failed to load component content.');
        }
      } catch (err) {
        if (cancelled) return;
        setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return (): void => {
      cancelled = true;
    };
    // `activeFacet` is deliberately keyed by value via `readKey` (see prop
    // doc); the latest facet object is still read at call time.
  }, [componentType, componentFile, readKey, onReadComponent]);

  // The component file is file content, so session replay keeps a
  // placeholder for it. MarkdownFrontmatterContent renders a fragment, so an
  // unstyled block-level wrapper carries the block; the name heading and the
  // Back chrome stay recorded.
  return (
    <Stack gap="group" className="min-w-0">
      <Title
        id="plugin-detail-title"
        className="text-lg font-semibold fg-primary"
      >
        {name}
      </Title>

      <div className={REPLAY_BLOCK_CLASS}>
        <MarkdownFrontmatterContent
          markdownOptions={markdownOptions}
          loading={loading}
          error={error}
          content={content}
          emptyText="This component has no content."
        />
        {content?.truncated === true && <TruncatedNotice />}
      </div>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// README section
// ---------------------------------------------------------------------------

function ReadmeSection({
  markdownOptions,
  activeFacet,
  onReadComponent,
  preloaded,
  defaultExpanded = false,
}: {
  markdownOptions?: MarkdownProps['options'];
  activeFacet: PluginDetailFacetSlot | undefined;
  onReadComponent: PluginDetailReadComponent;
  /** Already-fetched README body; skips the lazy read entirely. */
  preloaded?: { body: string; truncated?: boolean };
  defaultExpanded?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [content, setContent] = useState<string | null>(
    preloaded ? preloaded.body : null,
  );
  const [truncated, setTruncated] = useState(preloaded?.truncated === true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadContent = async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const result = await onReadComponent('readme', 'README.md', activeFacet);
      if (result) {
        setContent(result.body);
        setTruncated(result.truncated === true);
      } else {
        setError('Failed to load README.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (defaultExpanded && !preloaded) {
      void loadContent();
    }
    // The section is remounted (keyed) when the facet or plugin roots change,
    // so this runs once per content identity.
  }, []);

  const handleToggle = async (): Promise<void> => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (content !== null) return;
    await loadContent();
  };

  return (
    <Disclosure
      variant="box"
      label={
        <PluginDetailSectionHeading as="span">
          README
        </PluginDetailSectionHeading>
      }
      open={expanded}
      onOpenChange={() => void handleToggle()}
      dataTestId="plugin-detail-readme"
    >
      {loading && <p className="text-s fg-secondary">Loading README&hellip;</p>}
      <ErrorBanner errorSource="readme-section" className="" error={error} />
      {content !== null && !loading && (
        <div
          className={`${REPLAY_BLOCK_CLASS} prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none text-s fg-primary prose-code:before:content-none prose-code:after:content-none [&_a]:fg-accent [&_a:hover]:underline [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-secondary [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_h1]:text-m [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-s [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h3]:text-s [&_h3]:font-medium [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:fg-secondary [&_img]:max-w-full [&_img]:rounded [&_table]:w-full [&_th]:text-left [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1`}
        >
          <Markdown options={markdownOptions}>{content}</Markdown>
        </div>
      )}
      {content !== null && !loading && truncated && <TruncatedNotice />}
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Facet toggle helpers
// ---------------------------------------------------------------------------

type FacetTab = 'claude' | 'codex';

/** Finds a server's row within one version: names can differ per version. */
function mcpRowKey(
  kind: PluginDetailFacetSlot['kind'],
  serverName: string,
): string {
  return `${kind}/${serverName}`;
}

const CODEX_COMPATIBILITY_DISABLED_TOOLTIP =
  'Codex compatibility is turned off for this plugin';
const CODEX_COMPATIBILITY_BADGE_TOOLTIP =
  "Generated from this plugin's Claude version for Codex compatibility";

function collectFacets(
  plugin: PluginDetailContentPlugin,
): PluginDetailFacetSlot[] {
  const slots: PluginDetailFacetSlot[] = [];
  if (plugin.facets?.claude) {
    slots.push({ kind: 'claude', facet: plugin.facets.claude });
  }
  if (plugin.facets?.codex) {
    slots.push({ kind: 'codex', facet: plugin.facets.codex });
  } else if (plugin.facets?.codexCompatibility) {
    slots.push({
      kind: 'codexCompatibility',
      facet: plugin.facets.codexCompatibility,
    });
  }
  return slots;
}

function slotForTab(
  slots: PluginDetailFacetSlot[],
  tab: FacetTab,
): PluginDetailFacetSlot | undefined {
  if (tab === 'claude') return slots.find((s) => s.kind === 'claude');
  return slots.find(
    (s) => s.kind === 'codex' || s.kind === 'codexCompatibility',
  );
}

/** One row of a component table: the item and every harness that gets it. */
interface ListedComponent<T> {
  readonly item: T;
  readonly harnesses: string[];
  /** The version a row opens: Claude's when both have it. */
  readonly slot?: PluginDetailFacetSlot;
  /** Every version that lists it, so navigation can name one. */
  readonly slotKinds: readonly PluginDetailFacetSlot['kind'][];
}

/** The kinds a Cursor or OpenCode session loads; the rest never load there. */
type CursorLoadedKind = 'skills' | 'commands' | 'mcpServers';

/**
 * Cursor and OpenCode read the first version, Claude's, else native Codex's,
 * and load only some kinds from it: commands from a Claude version alone, as
 * `cursorLoadsPluginMemberKind` says for the sessions themselves.
 */
function slotHarnesses(
  slot: PluginDetailFacetSlot,
  index: number,
  isSupported: (harness: string) => boolean,
  cursorKind: CursorLoadedKind | undefined,
): string[] {
  const own = slot.kind === 'claude' ? 'claude' : 'codex';
  const loaded =
    index === 0 &&
    slot.kind !== 'codexCompatibility' &&
    cursorKind !== undefined &&
    (cursorKind !== 'commands' || slot.kind === 'claude');
  return [own, ...(loaded ? ['cursor', 'opencode'] : [])].filter(isSupported);
}

/**
 * What an MCP server runs, so versions that define it differently stay apart.
 * `mcpEndpointKey` is coarser on purpose: every command server shares one key.
 */
function mcpDefinitionKey(server: PluginMcpServerInfo): string {
  return JSON.stringify(
    server.type === 'http'
      ? [server.name, server.type, server.url]
      : [server.name, server.type, server.command, server.args ?? []],
  );
}

function lspDefinitionKey(server: PluginLspServerInfo): string {
  return JSON.stringify([server.name, server.command, server.args ?? []]);
}

/** One list across the plugin's versions, so no switch is needed to compare. */
function mergeFacetComponents<T>(
  slots: readonly PluginDetailFacetSlot[],
  fallback: PluginDetails | undefined,
  read: (details: PluginDetails) => readonly T[] | undefined,
  keyOf: (item: T) => string,
  isSupported: (harness: string) => boolean,
  cursorKind: CursorLoadedKind | undefined,
): ListedComponent<T>[] {
  if (!slots.some((slot) => slot.facet.details)) {
    return (fallback ? (read(fallback) ?? []) : []).map((item) => ({
      item,
      harnesses: [],
      slotKinds: [],
    }));
  }
  const merged = new Map<string, ListedComponent<T>>();
  slots.forEach((slot, index) => {
    if (!slot.facet.details) return;
    const harnesses = slotHarnesses(slot, index, isSupported, cursorKind);
    for (const item of read(slot.facet.details) ?? []) {
      const key = keyOf(item);
      const existing = merged.get(key);
      if (existing) {
        existing.harnesses.push(...harnesses);
        merged.set(key, {
          ...existing,
          slotKinds: [...existing.slotKinds, slot.kind],
        });
      } else {
        merged.set(key, {
          item,
          harnesses: [...harnesses],
          slot,
          slotKinds: [slot.kind],
        });
      }
    }
  });
  return [...merged.values()];
}

/** Keep publisher instructions available without letting them overwhelm the list. */
function ComponentDescription({
  name,
  description,
}: {
  name: string;
  description?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  if (!description) return <span>—</span>;
  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      label={
        <>
          <span className="sr-only">Description for {name}</span>
          <span aria-hidden="true" className="block truncate">
            {open ? 'Description' : description}
          </span>
        </>
      }
    >
      <p className="whitespace-pre-wrap break-words">{description}</p>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface ComponentRef {
  name: string;
  componentType: PluginDetailComponentType;
  file: string;
  slot?: PluginDetailFacetSlot;
}

export function PluginDetailContent({
  markdownOptions,
  plugin,
  onBack,
  onReadComponent,
  readme,
  metadataFooter,
  metadataFacts,
  updateNotice,
  statusContent,
  harnessRows,
  installActions,
  sharedContent,
  modsControl,
  hideComponents = false,
  relatedContent,
  headerActions,
  headerIcon,
  titleAs = 'h2',
  authorDisplay,
  bundledServerRows,
  onOpenEntryId,
  mcpTarget,
  renderMcpServerStatus,
}: PluginDetailContentProps): JSX.Element {
  const Title = titleAs;
  const [viewingComponent, setViewingComponent] = useState<ComponentRef | null>(
    null,
  );

  const slots = useMemo(() => collectFacets(plugin), [plugin]);

  // Close an open component when the plugin identity changes (e.g. the user
  // re-opens a different plugin).
  useEffect(() => {
    setViewingComponent(null);
  }, [plugin.marketplaceId, plugin.name]);

  // The header and README read the facet matching the plugin's top-level merged
  // view (Claude when both are available). The tables list every version.
  const activeSlot = slots[0];
  const isCompat = activeSlot?.kind === 'codexCompatibility';

  // The compat-disable control applies only to plugins that would otherwise
  // run under Codex via compatibility mode (Claude facet, no native Codex
  // facet).
  const compatCapable = plugin.providerSupport.codex === 'compat';
  const codexCompatDisabled = plugin.codexCompatDisabled === true;
  const commandHint = commandColumnHint(plugin.name, {
    claude: plugin.providerSupport.claude !== 'none',
    codex: plugin.providerSupport.codex !== 'none' && !codexCompatDisabled,
  });

  // ---------------------------------------------------------------------
  // Pick fields from the active facet, falling back to the top-level plugin
  // ---------------------------------------------------------------------
  const facetForDisplay = activeSlot?.facet;
  // Prefer the first non-empty display name: top-level, then active facet.
  // The top-level label stays constant across providers. Only when both labels
  // are blank or absent do we humanize the facet name, then the plugin name.
  // Other metadata below remains facet-first.
  const displayName = pluginDisplayName({
    name: facetForDisplay?.name ?? plugin.name,
    displayName: plugin.displayName?.trim() || facetForDisplay?.displayName,
  });
  const displayVersion = facetForDisplay?.version ?? plugin.version;
  const displayCategory = facetForDisplay?.category ?? plugin.category;
  // Product over publisher: an official listing OpenAI maintains for another
  // vendor is credited to that vendor, matching the mark beside it. Normalize
  // whichever author is shown, not just the top-level fallback: the feed puts
  // `author: 'OpenAI'` on the Codex facet too, and the facet is read first.
  const displayAuthor =
    authorDisplay !== undefined
      ? authorDisplay
      : pluginDisplayAuthor(plugin.marketplaceId, {
          name: plugin.name,
          author: facetForDisplay?.author ?? plugin.author,
        });
  const displayDescription = facetForDisplay?.description ?? plugin.description;
  const displayHomepage = facetForDisplay?.homepage ?? plugin.homepage;
  const displayDetails: PluginDetails | undefined =
    facetForDisplay?.details ?? plugin.details ?? undefined;

  const mcpRows = useRef(new Map<string, HTMLTableRowElement>());
  const consumedMcpTarget = useRef<string | null>(null);
  const [mcpTargetError, setMcpTargetError] = useState(false);
  useEffect(() => {
    if (!mcpTarget) {
      setMcpTargetError(false);
      return;
    }
    const request = `${plugin.marketplaceId}/${plugin.name}/${mcpTarget.requestId}`;
    if (consumedMcpTarget.current === request) return;
    const requestedSlot = mcpTarget.provider
      ? slotForTab(slots, mcpTarget.provider)
      : activeSlot;
    if (
      mcpTarget.provider &&
      (!requestedSlot ||
        (requestedSlot.kind === 'codexCompatibility' &&
          plugin.codexCompatDisabled))
    ) {
      consumedMcpTarget.current = request;
      setMcpTargetError(true);
      return;
    }
    if (!(requestedSlot?.facet.details ?? plugin.details)) return;
    const row =
      (requestedSlot &&
        mcpRows.current.get(
          mcpRowKey(requestedSlot.kind, mcpTarget.serverName),
        )) ??
      mcpRows.current.get(mcpTarget.serverName);
    consumedMcpTarget.current = request;
    setMcpTargetError(!row);
    if (row) {
      row.scrollIntoView?.({ block: 'center' });
      row.focus();
    }
  }, [
    mcpTarget,
    plugin.marketplaceId,
    plugin.name,
    plugin.codexCompatDisabled,
    plugin.details,
    activeSlot,
    slots,
  ]);

  const listedSlots = codexCompatDisabled
    ? slots.filter((slot) => slot.kind !== 'codexCompatibility')
    : slots;
  const isHarnessSupported = (harness: string): boolean =>
    !harnessRows?.length ||
    harnessRows.some(
      (row) => row.id === harness && row.installation !== 'Not supported',
    );
  const listComponents = <T,>(
    read: (details: PluginDetails) => readonly T[] | undefined,
    keyOf: (item: T) => string,
    cursorKind?: CursorLoadedKind,
  ): ListedComponent<T>[] =>
    mergeFacetComponents(
      listedSlots,
      displayDetails,
      read,
      keyOf,
      isHarnessSupported,
      cursorKind,
    );
  const listedSkills = listComponents(
    (d) => d.skills,
    (c) => c.name,
    'skills',
  );
  const listedAgents = listComponents(
    (d) => d.agents,
    (c) => c.name,
  );
  const listedCommands = listComponents(
    (d) => d.commands,
    (c) => c.name,
    'commands',
  );
  const listedApps = listComponents(
    (d) => d.apps,
    (c) => c.name,
  );
  const listedHooks = listComponents(
    (d) => d.hooks,
    (h) =>
      JSON.stringify([h.event, h.matcher ?? '', h.hookType, h.command ?? '']),
  );
  const listedMods = listComponents(
    (d) => d.mods,
    (m) => JSON.stringify([m.hooksFile, m.module]),
  );
  const listedLspServers = listComponents(
    (d) => d.lspServers,
    lspDefinitionKey,
  );
  const listedMcpServers = listComponents(
    (d) => d.mcpServers,
    mcpDefinitionKey,
    'mcpServers',
  );
  const nonMcpCount =
    listedSkills.length +
    listedAgents.length +
    listedCommands.length +
    listedApps.length +
    listedHooks.length +
    listedMods.length +
    listedLspServers.length;
  const hasNonMcpComponents = nonMcpCount > 0;
  const hasComponents = nonMcpCount + listedMcpServers.length > 0;
  const showComponentsSection =
    !hideComponents &&
    !!displayDetails &&
    (hasNonMcpComponents || (!hasComponents && !displayDetails.hasReadme));
  const showMcpServers = !hideComponents && listedMcpServers.length > 0;

  // Stable token for the roots content reads resolve against (facet kind +
  // facet/plugin paths). Keys the README section remount and the component
  // view's refetch, mirroring the previous desktop path-based dependencies.
  const contentRootsKey = [
    activeSlot?.kind ?? 'top',
    facetForDisplay?.cachePath ?? '',
    facetForDisplay?.installLocation ?? '',
    facetForDisplay?.sourcePath ?? '',
    plugin.cachePath ?? '',
    plugin.sourcePath ?? '',
  ].join('|');

  const handleChromeBack = (): void => {
    if (viewingComponent) {
      setViewingComponent(null);
    } else {
      onBack?.();
    }
  };
  const showBack = viewingComponent !== null || onBack !== undefined;

  const chrome = (
    <div
      className="flex min-w-0 items-center justify-between gap-4"
      data-testid="plugin-detail-chrome"
    >
      {showBack ? (
        <Button
          variant="ghost"
          size="compact"
          className="-ml-3"
          onClick={handleChromeBack}
          data-testid="plugin-detail-back"
        >
          <ChevronLeftMediumIcon size={14} aria-hidden="true" />
          Back
        </Button>
      ) : (
        <span />
      )}

      {headerActions && (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {headerActions}
        </div>
      )}
    </div>
  );

  if (viewingComponent) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        {chrome}
        <ComponentContentView
          markdownOptions={markdownOptions}
          titleAs={titleAs}
          name={viewingComponent.name}
          componentType={viewingComponent.componentType}
          componentFile={viewingComponent.file}
          activeFacet={viewingComponent.slot ?? activeSlot}
          readKey={`${contentRootsKey}|${viewingComponent.slot?.kind ?? ''}`}
          onReadComponent={onReadComponent}
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {chrome}

      {/* Plugin metadata */}
      <section className="min-w-0">
        <Stack gap="group">
          <Stack gap="item">
            <div className="flex items-center gap-3">
              {headerIcon ?? (
                <McpServerLogo
                  name={displayName}
                  size={40}
                  fallback="monogram"
                  fit="contain"
                />
              )}
              <div className="flex flex-col min-w-0 flex-1 gap-1">
                <Title
                  id="plugin-detail-title"
                  className="break-words text-lg font-semibold fg-primary"
                >
                  <span className="inline-flex flex-wrap items-baseline gap-x-2">
                    {displayName}
                    <DetailEntityType />
                  </span>
                </Title>
                <div className="flex flex-wrap items-center gap-2">
                  {displayVersion && (
                    <span className="text-xs fg-secondary">
                      v{displayVersion}
                    </span>
                  )}
                  {displayCategory && (
                    <span className="text-xs fg-secondary">
                      {displayCategory}
                    </span>
                  )}
                  {displayAuthor && (
                    <span
                      data-testid="plugin-detail-author"
                      className="text-xs fg-secondary"
                    >
                      by {displayAuthor}
                    </span>
                  )}
                  {isCompat && (
                    <Tooltip label={CODEX_COMPATIBILITY_BADGE_TOOLTIP}>
                      <Badge
                        tone="warning"
                        data-testid="plugin-detail-codex-compat-badge"
                      >
                        Codex compatibility
                      </Badge>
                    </Tooltip>
                  )}
                  {compatCapable && codexCompatDisabled && (
                    <Tooltip label={CODEX_COMPATIBILITY_DISABLED_TOOLTIP}>
                      <Badge data-testid="plugin-detail-codex-compat-disabled-badge">
                        Codex disabled
                      </Badge>
                    </Tooltip>
                  )}
                </div>
              </div>
            </div>
            {displayDescription && (
              <p className="max-w-2xl text-s fg-secondary">
                {displayDescription}
              </p>
            )}
          </Stack>
          {/* Links sit apart from the metadata line, where "Website" read as
            part of the author ("by Microsoft Website"). Status and links
            share one group 4px apart; either alone sits 16px below. */}
          {(statusContent || displayHomepage || metadataFacts) && (
            <Stack gap="tight">
              {statusContent && <div>{statusContent}</div>}
              {(displayHomepage || metadataFacts) && (
                <div className="-mb-1">
                  <DetailFactList>
                    {displayHomepage && (
                      <DetailFact label="Website" testId="plugin-detail-links">
                        <ExternalTextLink
                          href={displayHomepage}
                          label={websiteHost(displayHomepage)}
                        />
                      </DetailFact>
                    )}
                    {metadataFacts}
                  </DetailFactList>
                </div>
              )}
            </Stack>
          )}
        </Stack>
        {mcpTargetError && (
          <p
            role="status"
            className="text-s fg-warning"
            data-testid="plugin-mcp-target-unavailable"
          >
            This MCP server is no longer available
          </p>
        )}
        {metadataFooter}
      </section>

      {/* Host slots render bare, so an empty slot leaves no wrapper. */}
      {updateNotice}
      {harnessRows && <PluginWorksWith rows={harnessRows} />}

      {/* Host-owned install/action area (desktop install panels; empty on web) */}
      {installActions && (
        <div className="flex flex-col gap-6 empty:hidden">{installActions}</div>
      )}

      {showMcpServers && (
        <McpServersSection
          servers={listedMcpServers}
          bundledServerRows={bundledServerRows}
          onOpenEntryId={onOpenEntryId}
          renderStatus={renderMcpServerStatus}
          rowRefs={mcpRows}
        />
      )}

      {sharedContent}

      {/* README */}
      {displayDetails?.hasReadme && (
        <ReadmeSection
          markdownOptions={markdownOptions}
          key={contentRootsKey}
          activeFacet={activeSlot}
          onReadComponent={onReadComponent}
          preloaded={readme}
          defaultExpanded={!hasComponents}
        />
      )}

      {/* Components */}
      {showComponentsSection && displayDetails && (
        <div className="flex flex-col gap-6">
          {hasNonMcpComponents ? (
            <>
              {listedSkills.length > 0 && (
                <ComponentSection title="Skills">
                  <NameDescriptionTable
                    caption="Skills"
                    commandHint={commandHint}
                    items={listedSkills.map(({ item: s, harnesses, slot }) => ({
                      key: s.path,
                      name: s.name,
                      command: s.userInvocable === false ? undefined : s.name,
                      description: s.description,
                      harnesses,
                      onOpen: () =>
                        setViewingComponent({
                          name: s.name,
                          componentType: 'skill',
                          file: `${s.path}/SKILL.md`,
                          slot,
                        }),
                    }))}
                  />
                </ComponentSection>
              )}

              {listedAgents.length > 0 && (
                <ComponentSection title="Agents">
                  <NameDescriptionTable
                    caption="Agents"
                    items={listedAgents.map(
                      ({ item: a, harnesses, slot }, i) => ({
                        key: a.filePath || String(i),
                        name: a.name,
                        description: a.description,
                        harnesses,
                        onOpen: a.filePath
                          ? () =>
                              setViewingComponent({
                                name: a.name,
                                componentType: 'agent',
                                file: a.filePath,
                                slot,
                              })
                          : undefined,
                      }),
                    )}
                  />
                </ComponentSection>
              )}

              {listedCommands.length > 0 && (
                <ComponentSection title="Commands">
                  <NameDescriptionTable
                    caption="Commands"
                    commandHint={commandHint}
                    items={listedCommands.map(
                      ({ item: c, harnesses, slot }, i) => ({
                        key: c.filePath || String(i),
                        name: c.name,
                        command: c.name,
                        description: c.description,
                        harnesses,
                        onOpen: c.filePath
                          ? () =>
                              setViewingComponent({
                                name: c.name,
                                componentType: 'command',
                                file: c.filePath,
                                slot,
                              })
                          : undefined,
                      }),
                    )}
                  />
                </ComponentSection>
              )}

              {listedApps.length > 0 && (
                <ComponentSection title="Apps">
                  <NameDescriptionTable
                    caption="Apps"
                    items={listedApps.map(
                      ({ item: a, harnesses, slot }, i) => ({
                        key: a.filePath || String(i),
                        name: a.name,
                        description: a.description,
                        harnesses,
                        onOpen: a.filePath
                          ? () =>
                              setViewingComponent({
                                name: a.name,
                                componentType: 'app',
                                file: a.filePath,
                                slot,
                              })
                          : undefined,
                      }),
                    )}
                  />
                </ComponentSection>
              )}

              {listedHooks.length > 0 && (
                <ComponentSection title="Hooks">
                  <DataTable
                    caption="Hooks"
                    rows={listedHooks
                      .slice()
                      .sort((a, b) => a.item.event.localeCompare(b.item.event))}
                    rowKey={({ item: h }, i) => `${h.event}-${i}`}
                    columns={[
                      {
                        key: 'event',
                        header: 'Event',
                        render: ({ item: h }) => h.event,
                      },
                      ...harnessColumn(listedHooks),
                      {
                        key: 'matcher',
                        header: 'Matcher',
                        overflow: 'wrap',
                        render: ({ item: h }) => (
                          <span className="font-mono text-xs">
                            {h.matcher || '—'}
                          </span>
                        ),
                      },
                      {
                        key: 'type',
                        header: 'Type',
                        render: ({ item: h }) => h.hookType,
                      },
                    ]}
                  />
                </ComponentSection>
              )}

              {listedMods.length > 0 && (
                <ComponentSection title="Mods">
                  <PluginModNotice />
                  {modsControl}
                  <DataTable
                    caption="Mods"
                    testId="plugin-detail-mods"
                    rows={pluginModRows(listedMods.map(({ item }) => item))}
                    rowKey={(mod) => mod.key}
                    columns={[
                      {
                        key: 'module',
                        header: 'Module',
                        overflow: 'wrap',
                        render: (mod) => (
                          <span className="font-mono text-xs">
                            {mod.module}
                          </span>
                        ),
                      },
                      {
                        key: 'hooksFile',
                        header: 'Hooks file',
                        overflow: 'wrap',
                        render: (mod) => (
                          <span className="font-mono text-xs">
                            {mod.hooksFile}
                          </span>
                        ),
                      },
                    ]}
                  />
                </ComponentSection>
              )}

              {listedLspServers.length > 0 && (
                <ComponentSection title="LSP servers" collapsible>
                  <DataTable
                    caption="LSP servers"
                    rows={listedLspServers
                      .slice()
                      .sort((a, b) => a.item.name.localeCompare(b.item.name))}
                    rowKey={({ item: server }) => lspDefinitionKey(server)}
                    columns={[
                      {
                        key: 'name',
                        header: 'Name',
                        render: ({ item: server }) => server.name,
                      },
                      ...harnessColumn(listedLspServers),
                      {
                        key: 'command',
                        header: 'Command',
                        overflow: 'wrap',
                        replay: 'block',
                        render: ({ item: server }) => (
                          <span className="font-mono text-xs">
                            {server.command}
                            {server.args?.length
                              ? ` ${server.args.join(' ')}`
                              : ''}
                          </span>
                        ),
                      },
                      {
                        key: 'languages',
                        header: 'Languages',
                        overflow: 'wrap',
                        render: ({ item: server }) =>
                          server.languages?.join(', ') || '—',
                      },
                    ]}
                  />
                </ComponentSection>
              )}
            </>
          ) : !displayDetails.hasReadme ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-s fg-secondary">No components found.</p>
            </div>
          ) : null}
        </div>
      )}

      {relatedContent}
    </div>
  );
}

interface NameDescriptionItem {
  readonly key: string;
  readonly name: string;
  /** Its name when people can run it by typing; absent when they can't. */
  readonly command?: string;
  readonly description?: string;
  /** Harnesses that get this item; empty when the host has no version data. */
  readonly harnesses?: readonly string[];
  /** Opens the component's file; without it the name is plain text. */
  readonly onOpen?: () => void;
}

const HARNESS_COLUMN_WIDTH = '7rem';

/** A Harness column, left out when the rows have no version data to show. */
function harnessColumn<Row extends { harnesses?: readonly string[] }>(
  rows: readonly Row[],
): DataTableColumn<Row>[] {
  return rows.some((row) => row.harnesses?.length)
    ? [
        {
          key: 'harness',
          header: 'Harness',
          width: HARNESS_COLUMN_WIDTH,
          render: (row: Row): JSX.Element => (
            <HarnessLogoList harnesses={row.harnesses ?? []} />
          ),
        },
      ]
    : [];
}

/**
 * Every row shares the plugin's prefix, so the hint carries it once. Only
 * Claude and Codex have a typed prefix, `/` and `$`, and only a harness that
 * can run this plugin is named (`pluginMemberInvocation`).
 */
function commandColumnHint(
  prefix: string | undefined,
  harnesses: { claude: boolean; codex: boolean },
): string | undefined {
  const form = prefix ? `${prefix}:<command>` : '<command>';
  const claude = harnesses.claude ? `/${form} in Claude` : undefined;
  const codex = harnesses.codex ? `$${form} in Codex` : undefined;
  if (!claude && !codex) return undefined;
  return `Run it in chat as ${[claude, codex].filter(Boolean).join(' or ')}`;
}

/** A plugin's skills, agents, commands or apps: name and description, A to Z. */
function NameDescriptionTable({
  caption,
  commandHint,
  items,
}: {
  caption: string;
  commandHint?: string;
  items: readonly NameDescriptionItem[];
}): JSX.Element {
  const hasCommands = items.some((item) => item.command);
  return (
    <DataTable
      caption={caption}
      layout="fixed"
      verticalAlign="top"
      rows={items.slice().sort((a, b) => a.name.localeCompare(b.name))}
      rowKey={(item) => item.key}
      columns={[
        {
          key: 'name',
          header: hasCommands ? 'Command' : 'Name',
          headerHint: hasCommands ? commandHint : undefined,
          width: '33%',
          overflow: 'wrap',
          render: (item) =>
            item.onOpen ? (
              <ClickableName
                name={item.command ?? item.name}
                mono={item.command !== undefined}
                onClick={item.onOpen}
              />
            ) : (
              <span
                className={
                  item.command ? 'font-mono text-xs font-medium' : 'font-medium'
                }
              >
                {item.command ?? item.name}
              </span>
            ),
        },
        ...harnessColumn(items),
        {
          key: 'description',
          header: 'Description',
          overflow: 'wrap',
          render: (item) => (
            <ComponentDescription
              name={item.name}
              description={item.description}
            />
          ),
        },
      ]}
    />
  );
}

function websiteHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return 'Website';
  }
}

/**
 * The plugin's MCP servers, always visible: name and endpoint, and the host's
 * health and Test connection per row (CAN-4842).
 */
function McpServersSection({
  servers,
  bundledServerRows,
  onOpenEntryId,
  renderStatus,
  rowRefs,
}: {
  servers: readonly ListedComponent<PluginMcpServerInfo>[];
  bundledServerRows?: readonly UnifiedEntryBundledServerRow[];
  onOpenEntryId?: (entryId: string) => void;
  renderStatus?: (server: PluginMcpServerInfo) => ReactNode | undefined;
  rowRefs: RefObject<Map<string, HTMLTableRowElement>>;
}): JSX.Element {
  const showHarness = servers.some((server) => server.harnesses.length > 0);
  return (
    <ComponentSection title="MCP servers">
      <DataTableFrame caption="MCP servers" layout="fixed">
        <DataTableHead>
          <DataTableHeaderCell width="22%">Name</DataTableHeaderCell>
          {showHarness && (
            <DataTableHeaderCell width={HARNESS_COLUMN_WIDTH}>
              Harness
            </DataTableHeaderCell>
          )}
          <DataTableHeaderCell>Endpoint</DataTableHeaderCell>
          <DataTableHeaderCell width="22%" align="right">
            Status
          </DataTableHeaderCell>
          {/* The status cell spans this column: its controls (Test
              connection) sit at the row's end under an Actions header. */}
          <DataTableHeaderCell width="0" labelHidden>
            Actions
          </DataTableHeaderCell>
        </DataTableHead>
        <DataTableBody>
          {servers
            .slice()
            .sort((a, b) => a.item.name.localeCompare(b.item.name))
            .map(({ item: s, harnesses, slotKinds }) => {
              const row = onOpenEntryId
                ? bundledServerRows?.find(
                    (candidate) =>
                      candidate.serverName === s.name &&
                      candidate.endpoint === mcpEndpointKey(s),
                  )
                : undefined;
              const status = renderStatus?.(s);
              return (
                <DataTableRow
                  key={mcpDefinitionKey(s)}
                  focusable
                  verticalAlign="top"
                  data-mcp-member={s.name}
                  ref={(node): void => {
                    for (const key of [
                      s.name,
                      ...slotKinds.map((kind) => mcpRowKey(kind, s.name)),
                    ]) {
                      if (node) rowRefs.current.set(key, node);
                      else rowRefs.current.delete(key);
                    }
                  }}
                >
                  <DataTableCell tone="primary" overflow="wrap">
                    <div className="font-medium">
                      {row && onOpenEntryId ? (
                        <span
                          data-testid={`plugin-detail-mcp-server-settings-${s.name}`}
                        >
                          <ClickableName
                            name={s.name}
                            description="Open server settings"
                            onClick={() => onOpenEntryId(row.entryId)}
                          />
                        </span>
                      ) : (
                        s.name
                      )}
                    </div>
                  </DataTableCell>
                  {showHarness && (
                    <DataTableCell>
                      <HarnessLogoList harnesses={harnesses} />
                    </DataTableCell>
                  )}
                  <DataTableCell overflow="wrap">
                    <span
                      className={`${s.type === 'http' ? '' : REPLAY_BLOCK_CLASS} min-w-0 break-all font-mono text-xs`}
                    >
                      {/* The Portal drops a URL it can't parse. */}
                      {(s.type === 'http'
                        ? s.url
                        : `${s.command ?? ''}${s.args?.length ? ` ${s.args.join(' ')}` : ''}`) ||
                        '—'}
                    </span>
                  </DataTableCell>
                  <DataTableCell overflow="wrap" colSpan={2} align="right">
                    <div className="flex justify-end">
                      {status ?? (
                        <span
                          data-testid="plugin-detail-mcp-status-unavailable"
                          className="text-xs fg-tertiary"
                        >
                          {PLUGIN_DETAIL_MCP_NOT_CONFIGURED}
                        </span>
                      )}
                    </div>
                  </DataTableCell>
                </DataTableRow>
              );
            })}
        </DataTableBody>
      </DataTableFrame>
    </ComponentSection>
  );
}
