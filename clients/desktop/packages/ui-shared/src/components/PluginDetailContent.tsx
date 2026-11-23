import { Badge } from './Badge';
import { Stack } from './Stack';
import { pluginDisplayName } from '../lib/plugin-display-name';
import { pluginDisplayAuthor } from '../lib/official-marketplace-products';
import {
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
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
import {
  CapabilityDetailLayout,
  DetailHostRelated,
  DetailWebsiteFact,
  detailWebsiteHost,
  type CapabilityDetailFacts,
} from './CapabilityDetailLayout';
import { DetailEntityType, MarketplaceTypeLabel } from './MarketplaceTypeLabel';
import { ExternalTextLink } from './ExternalTextLink';
import { Markdown, type MarkdownProps } from './Markdown';
import { MarkdownFrontmatterContent } from './MarkdownFrontmatterContent';
import { PluginDetailSectionHeading } from './PluginDetailSectionHeading';
import { PluginModNotice, pluginModRows } from './PluginModMembers';
import { EmptyStateText, ErrorBanner } from './StatusBlocks';
import { CenteredLoadingSpinner } from './CenteredLoadingSpinner';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { TabBar } from './TabBar';
import { Tooltip } from './Tooltip';
import { McpServerLogo } from './McpServerLogo';
import { StatusToneText, useItemStateMarks } from './ItemStateMark';
import {
  HarnessLogoList,
  PluginHarnessConnections,
  PluginWorksWith,
  type PluginMcpServerVia,
  PluginHarnessVia,
  type PluginWorksWithRow,
} from './PluginHarnessConnections';
import {
  ChevronLeftMediumIcon,
  CommandIcon,
  HookIcon,
} from '../icons/AppIcons';
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
  harnessRows?: readonly PluginWorksWithRow[];
  /**
   * Harnesses whose MCP server comes from another copy of this plugin (New
   * Customize), one line each in the MCP servers table.
   */
  mcpServerVia?: readonly PluginMcpServerVia[];
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
   * New Customize: the tile's line 2 under the title, so the page and the
   * tile it opened from name the same publisher.
   */
  publisher?: ReactNode;
  /**
   * New Customize: host fact rows in the shared order. Website comes from
   * the plugin; `metadataFacts` and `updateNotice` are not shown.
   */
  facts?: Omit<CapabilityDetailFacts, 'status' | 'website'>;
  /**
   * New Customize: an Add or harness install failure, said under Works with
   * (the harnesses it is about) instead of in a page banner.
   */
  worksWithNotice?: ReactNode;
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
      className="pt-3 text-xs fg-secondary"
      data-testid="plugin-detail-truncated-notice"
      role="note"
    >
      Content was truncated.
    </p>
  );
}

export function ComponentContentView({
  markdownOptions,
  catalogPreview = false,
  privateTitle = catalogPreview,
  titleAs = 'h2',
  name,
  componentType,
  componentFile,
  activeFacet,
  readKey,
  onReadComponent,
}: {
  markdownOptions?: MarkdownProps['options'];
  catalogPreview?: boolean;
  /** The name is the publisher's: private in session replay. */
  privateTitle?: boolean;
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
  const [errorDetails, setErrorDetails] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // The opener unmounts, so focus moves to what it opened.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setErrorDetails('');
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
        // Fixed copy on screen; the raw message is only in Copy details.
        setError('Failed to load component content.');
        setErrorDetails(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return (): void => {
      cancelled = true;
    };
    // `activeFacet` is deliberately keyed by value via `readKey` (see prop
    // doc); the latest facet object is still read at call time.
  }, [componentType, componentFile, readKey, onReadComponent, retryKey]);

  // The component file is file content, so session replay keeps a
  // placeholder for it. MarkdownFrontmatterContent renders a fragment, so an
  // unstyled block-level wrapper carries the block; the name heading and the
  // Back chrome stay recorded.
  return (
    <Stack gap="group" className="min-w-0">
      <Title
        ref={titleRef}
        id="plugin-detail-title"
        tabIndex={-1}
        className={`break-words text-lg font-semibold fg-primary outline-none${privateTitle ? ` ${REPLAY_BLOCK_CLASS}` : ''}`}
      >
        {name}
      </Title>

      <div className={REPLAY_BLOCK_CLASS}>
        <MarkdownFrontmatterContent
          markdownOptions={
            catalogPreview ? PREVIEW_ONLY_MARKDOWN_OPTIONS : markdownOptions
          }
          loading={loading}
          error={error}
          errorDetails={errorDetails}
          content={content}
          emptyText="This component has no content."
          onRetry={() => {
            // The banner and its button unmount while the content reloads.
            titleRef.current?.focus();
            setRetryKey((key) => key + 1);
          }}
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
  bare = false,
}: {
  markdownOptions?: MarkdownProps['options'];
  activeFacet: PluginDetailFacetSlot | undefined;
  onReadComponent: PluginDetailReadComponent;
  /** Already-fetched README body; skips the lazy read entirely. */
  preloaded?: { body: string; truncated?: boolean };
  defaultExpanded?: boolean;
  /** The body alone, for a tab panel that already names it. */
  bare?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [content, setContent] = useState<string | null>(
    preloaded ? preloaded.body : null,
  );
  const [truncated, setTruncated] = useState(preloaded?.truncated === true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  const loadContent = async (): Promise<void> => {
    setLoading(true);
    setError('');
    setErrorDetails('');
    try {
      const result = await onReadComponent('readme', 'README.md', activeFacet);
      if (result) {
        setContent(result.body);
        setTruncated(result.truncated === true);
      } else {
        setError('Failed to load README.');
      }
    } catch (err) {
      setError('Failed to load README.');
      setErrorDetails(errorMessage(err));
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
    if (content !== null || loading) return;
    await loadContent();
  };

  const body = (
    // Takes focus when a retry unmounts the error banner.
    <div ref={bodyRef} tabIndex={-1} role="group" aria-label="README">
      {loading && (
        // A spinner, not a measured skeleton: the README's shape is unknown until it loads.
        <DelayedLoadingPlaceholder slowNote="Still loading README…">
          <CenteredLoadingSpinner spacing="section" />
        </DelayedLoadingPlaceholder>
      )}
      <ErrorBanner
        errorSource="readme-section"
        className=""
        error={error}
        {...(errorDetails ? { details: errorDetails } : {})}
        onRetry={() => {
          // The banner and its button unmount while the README reloads.
          bodyRef.current?.focus();
          void loadContent();
        }}
      />
      {content !== null && !loading && (
        <div
          className={`${REPLAY_BLOCK_CLASS} canopy-readme-prose prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none text-s fg-primary prose-code:before:content-none prose-code:after:content-none [&_a]:fg-accent [&_a:hover]:underline [&_:not(pre)>code]:bg-secondary [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded prose-pre:fg-primary/80 [&_pre]:bg-secondary [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_h1]:text-m [&_h1]:font-semibold [&_h2]:text-s [&_h2]:font-semibold [&_h3]:text-s [&_h3]:font-medium [&_li]:my-0.5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:fg-secondary [&_img]:max-w-full [&_img]:rounded [&_img]:outline-1 [&_img]:-outline-offset-1 [&_img]:outline-line-base [&_table]:w-full [&_th]:text-left [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1`}
        >
          <Markdown options={markdownOptions}>{content}</Markdown>
        </div>
      )}
      {content !== null && !loading && truncated && <TruncatedNotice />}
    </div>
  );
  if (bare) {
    return (
      <div data-testid="plugin-detail-readme" className="min-w-0">
        {body}
      </div>
    );
  }
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
      {body}
    </Disclosure>
  );
}

/**
 * A README image as its alt text, never its source. A not-added plugin's
 * README comes from its publisher, so opening the preview must not request
 * images from hosts the publisher controls (a tracking pixel).
 */
function ReadmeImageAltText({
  alt,
}: ComponentPropsWithoutRef<'img'>): JSX.Element | null {
  const text = alt?.trim();
  return text ? <span className="fg-secondary">{text}</span> : null;
}

const PREVIEW_ONLY_MARKDOWN_OPTIONS: MarkdownProps['options'] = {
  disableParsingRawHTML: true,
  overrides: { img: ReadmeImageAltText },
};

/**
 * A README already read (a not-added plugin's preview). Its images show as
 * their alt text and are never loaded.
 */
export function PluginPreloadedReadme({
  body,
  truncated,
  bare = true,
}: {
  body: string;
  truncated?: boolean;
  bare?: boolean;
}): JSX.Element {
  return (
    <ReadmeSection
      bare={bare}
      defaultExpanded
      markdownOptions={PREVIEW_ONLY_MARKDOWN_OPTIONS}
      activeFacet={undefined}
      onReadComponent={() => Promise.resolve(null)}
      preloaded={{ body, ...(truncated ? { truncated } : {}) }}
    />
  );
}

type PluginDetailTab = 'contents' | 'readme';

/**
 * New Customize: Contents and README as two tabs, for a plugin that has both.
 * The README mounts the first time its tab opens (a lazy read starts there)
 * and stays mounted, so switching back and forth doesn't read it again.
 */
export function PluginDetailTabs({
  contents,
  renderReadme,
  selection,
}: {
  contents: ReactNode;
  renderReadme: () => ReactNode;
  selection?: {
    value: PluginDetailTab;
    onChange: (tab: PluginDetailTab) => void;
  };
}): JSX.Element {
  const [localTab, setLocalTab] = useState<PluginDetailTab>('contents');
  const tab = selection?.value ?? localTab;
  const [readmeOpened, setReadmeOpened] = useState(tab === 'readme');
  const idPrefix = useId();
  const panelId = `${idPrefix}-panel`;
  const tabId = (id: PluginDetailTab): string => `${idPrefix}-tab-${id}`;
  return (
    <div data-testid="plugin-detail-tabs-section">
      <TabBar
        items={[
          {
            id: 'contents',
            label: 'Contents',
            dataTestId: 'plugin-detail-tab-contents',
            tabId: tabId('contents'),
            panelId,
          },
          {
            id: 'readme',
            label: 'README',
            dataTestId: 'plugin-detail-tab-readme',
            tabId: tabId('readme'),
            panelId,
          },
        ]}
        value={tab}
        onChange={(id) => {
          if (selection) selection.onChange(id);
          else setLocalTab(id);
          if (id === 'readme') setReadmeOpened(true);
        }}
        label="Plugin details"
        panelId={panelId}
        dataTestId="plugin-detail-tabs"
      />
      <div
        id={panelId}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={tabId(tab)}
        data-testid="plugin-detail-panel"
        className="pt-4"
      >
        <div hidden={tab !== 'contents'}>{contents}</div>
        {readmeOpened && <div hidden={tab !== 'readme'}>{renderReadme()}</div>}
      </div>
    </div>
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
  /** Unique among one kind's rows; stable while the member stays. */
  readonly key: string;
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
  /**
   * New Customize: each member's file, so members are told apart by file
   * rather than by name (`byFileMergeKeys`).
   */
  fileOf?: (item: T) => string,
): ListedComponent<T>[] {
  if (!slots.some((slot) => slot.facet.details)) {
    const items = fallback ? (read(fallback) ?? []) : [];
    if (fileOf) {
      return byFileMergeKeys([items], keyOf, fileOf)[0].map(
        ({ key, item }) => ({ key, item, harnesses: [], slotKinds: [] }),
      );
    }
    return items.map((item) => ({
      key: keyOf(item),
      item,
      harnesses: [],
      slotKinds: [],
    }));
  }
  const withDetails = slots.flatMap((slot, index) =>
    slot.facet.details ? [{ slot, index, details: slot.facet.details }] : [],
  );
  const keyed = fileOf
    ? byFileMergeKeys(
        withDetails.map(({ details }) => read(details) ?? []),
        keyOf,
        fileOf,
      )
    : withDetails.map(({ details }) =>
        (read(details) ?? []).map((item) => ({ key: keyOf(item), item })),
      );
  const merged = new Map<string, ListedComponent<T>>();
  withDetails.forEach(({ slot, index }, version) => {
    const harnesses = slotHarnesses(slot, index, isSupported, cursorKind);
    for (const { key, item } of keyed[version] ?? []) {
      const existing = merged.get(key);
      if (existing) {
        existing.harnesses.push(...harnesses);
        merged.set(key, {
          ...existing,
          slotKinds: [...existing.slotKinds, slot.kind],
        });
      } else {
        merged.set(key, {
          key,
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

/**
 * New Customize: each version's members keyed so that a key is one row.
 * A file listed twice in one version (a manifest naming `commands/` and
 * `commands/build.md`) is one member. Versions share a row by name only when
 * no version lists that name twice; otherwise only the same file under the
 * same name is shared, and each other file is its own row. Each key is a
 * tagged tuple, so no name can spell another member's key.
 */
function byFileMergeKeys<T>(
  versions: readonly (readonly T[])[],
  nameOf: (item: T) => string,
  fileOf: (item: T) => string,
): { readonly key: string; readonly item: T }[][] {
  const members = versions.map((items) => {
    const files = new Set<string>();
    return items.filter((item) => {
      const file = fileOf(item);
      if (file === '') return true;
      if (files.has(file)) return false;
      files.add(file);
      return true;
    });
  });
  const sharedByName = new Map<string, boolean>();
  for (const items of members) {
    const counts = new Map<string, number>();
    for (const item of items)
      counts.set(nameOf(item), (counts.get(nameOf(item)) ?? 0) + 1);
    for (const [name, count] of counts)
      sharedByName.set(name, (sharedByName.get(name) ?? true) && count === 1);
  }
  return members.map((items, version) =>
    items.map((item, index) => {
      const name = nameOf(item);
      const file = fileOf(item);
      const key =
        sharedByName.get(name) === true
          ? ['name', name]
          : file !== ''
            ? ['file', name, file]
            : ['item', version, index];
      return { key: JSON.stringify(key), item };
    }),
  );
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
  publisher,
  facts,
  worksWithNotice,
  bundledServerRows,
  onOpenEntryId,
  mcpTarget,
  renderMcpServerStatus,
  mcpServerVia,
}: PluginDetailContentProps): JSX.Element {
  const Title = titleAs;
  const [viewingComponent, setViewingComponent] = useState<ComponentRef | null>(
    null,
  );
  // The row that opened the component view, so Back can focus it again: a
  // table's opener value, or New Customize's Contents row key, kept here
  // because the list's opener ids are places that can move meanwhile.
  const openerKey = useRef<{
    readonly kind: 'opener' | 'row';
    readonly key: string;
    /** The plugin a Contents row belongs to; another's same key is not it. */
    readonly owner?: string;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const openComponent = (component: ComponentRef, rowKey?: string): void => {
    if (rowKey !== undefined) {
      openerKey.current = {
        kind: 'row',
        key: rowKey,
        owner: `${plugin.marketplaceId}/${plugin.name}`,
      };
    } else {
      const opener =
        document.activeElement
          ?.closest('[data-component-opener]')
          ?.getAttribute('data-component-opener') ?? null;
      openerKey.current =
        opener === null ? null : { kind: 'opener', key: opener };
    }
    setViewingComponent(component);
  };

  const slots = useMemo(() => collectFacets(plugin), [plugin]);

  const tabOwner = `${plugin.marketplaceId}/${plugin.name}`;
  const [readmeTabOwner, setReadmeTabOwner] = useState<string | null>(null);
  const detailTab = readmeTabOwner === tabOwner ? 'readme' : 'contents';

  // Close an open component when the plugin identity changes (e.g. the user
  // re-opens a different plugin).
  useEffect(() => {
    setViewingComponent(null);
    setReadmeTabOwner(null);
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

  const mcpRows = useRef(new Map<string, HTMLElement>());
  const consumedMcpTarget = useRef<string | null>(null);
  const [mcpTargetError, setMcpTargetError] = useState(false);
  // New Customize: status text stays plain; only its icon is colored.
  const neutralStatusText = useItemStateMarks();
  // New Customize draws the header and facts through the shared layout, and
  // orders the sections Works with, Contents, Settings, Docs, Related.
  const layout = neutralStatusText;
  useEffect(() => {
    if (!mcpTarget) {
      setMcpTargetError(false);
      return;
    }
    const request = `${plugin.marketplaceId}/${plugin.name}/${mcpTarget.requestId}`;
    if (consumedMcpTarget.current === request) return;
    // Reveal the row before focusing it; hidden tab panels cannot take focus.
    if (layout && detailTab !== 'contents') {
      setReadmeTabOwner(null);
      return;
    }
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
    layout,
    detailTab,
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
    /** New Customize's Contents tells files that share a name apart. */
    fileOf?: (item: T) => string,
  ): ListedComponent<T>[] =>
    mergeFacetComponents(
      listedSlots,
      displayDetails,
      read,
      keyOf,
      isHarnessSupported,
      cursorKind,
      layout ? fileOf : undefined,
    );
  const fileOfMember = (member: { filePath: string }): string =>
    member.filePath;
  const listedSkills = listComponents(
    (d) => d.skills,
    (c) => c.name,
    'skills',
    (c) => c.path,
  );
  const listedAgents = listComponents(
    (d) => d.agents,
    (c) => c.name,
    undefined,
    fileOfMember,
  );
  const listedCommands = listComponents(
    (d) => d.commands,
    (c) => c.name,
    'commands',
    fileOfMember,
  );
  const listedApps = listComponents(
    (d) => d.apps,
    (c) => c.name,
    undefined,
    fileOfMember,
  );
  const listedHooks = listComponents(
    (d) => d.hooks,
    // New Customize's Contents lists hooks that differ only in `async` apart.
    (h) =>
      JSON.stringify([
        h.event,
        h.matcher ?? '',
        h.hookType,
        h.command ?? '',
        layout && h.async === true,
      ]),
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
  // New Customize: a harness whose MCP server another copy brings, unless
  // this copy lists a server for that harness itself.
  const companionMcpVia = mcpServerVia?.filter(
    (entry) =>
      !listedMcpServers.some((server) =>
        server.harnesses.includes(entry.harness),
      ),
  );
  const showMcpServers =
    !hideComponents &&
    (listedMcpServers.length > 0 || (companionMcpVia?.length ?? 0) > 0);

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

  // New Customize's Contents rows. Names, endpoints and command lines come
  // from the plugin's files, so each name is private in session replay.
  const contentsRows: PluginContentsRow[] = [
    ...listedSkills.map(({ key: member, item: s, harnesses, slot }) => {
      const key = `skill:${member}`;
      return {
        key,
        type: 'Skill',
        name: s.name,
        replayBlockName: true,
        command: s.userInvocable === false ? undefined : s.name,
        description: s.description,
        harnesses,
        onOpen: (): void =>
          openComponent(
            {
              name: s.name,
              componentType: 'skill',
              file: `${s.path}/SKILL.md`,
              slot,
            },
            key,
          ),
      };
    }),
    ...(
      [
        ['Agent', 'agent', listedAgents],
        ['Command', 'command', listedCommands],
        ['App', 'app', listedApps],
      ] as const
    ).flatMap(([type, componentType, listed]) =>
      listed.map(({ key: member, item, harnesses, slot }) => {
        const key = `${componentType}:${member}`;
        return {
          key,
          type,
          name: item.name,
          replayBlockName: true,
          ...(componentType === 'command' ? { command: item.name } : {}),
          description: item.description,
          harnesses,
          onOpen: item.filePath
            ? (): void =>
                openComponent(
                  {
                    name: item.name,
                    componentType,
                    file: item.filePath,
                    slot,
                  },
                  key,
                )
            : undefined,
        };
      }),
    ),
    ...listedHooks.map(({ item: h, harnesses }, index) => ({
      key: `hook:${h.event}:${String(index)}`,
      type: 'Hook',
      name: h.event,
      replayBlockName: true,
      description: [
        h.matcher,
        h.hookType,
        // Only New Customize lists the async twin as its own row.
        layout && h.async === true ? 'async' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      harnesses,
    })),
    ...pluginModRows(listedMods.map(({ item }) => item)).map((mod) => ({
      key: `mod:${mod.key}`,
      type: 'Mod',
      name: mod.module,
      replayBlockName: true,
      description: mod.hooksFile,
      harnesses: [],
    })),
    ...listedLspServers.map(({ item: server, harnesses }) => ({
      key: `lsp:${lspDefinitionKey(server)}`,
      type: 'LSP server',
      replayBlock: true,
      name: server.name,
      replayBlockName: true,
      description: [
        `${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}`,
        server.languages?.join(', '),
      ]
        .filter(Boolean)
        .join(' · '),
      harnesses,
    })),
  ];
  const currentContentsRows = useRef<{
    readonly owner: string;
    readonly rows: readonly PluginContentsRow[];
  }>({ owner: tabOwner, rows: [] });
  useEffect(() => {
    currentContentsRows.current = { owner: tabOwner, rows: contentsRows };
  });
  // Back from a component: focus the row that opened it, if it is still
  // there. New Customize finds the row by its key among the current rows of
  // the same plugin; another plugin's page focuses its Contents tab or list.
  useEffect(() => {
    const opened = openerKey.current;
    if (viewingComponent !== null || opened === null) return;
    openerKey.current = null;
    if (opened.kind === 'row') {
      const { owner, rows } = currentContentsRows.current;
      focusPluginContentsOpener(
        rootRef.current,
        opened.owner === owner ? rows : [],
        opened.key,
      );
      return;
    }
    Array.from(
      rootRef.current?.querySelectorAll('[data-component-opener]') ?? [],
    )
      .find(
        (opener) => opener.getAttribute('data-component-opener') === opened.key,
      )
      ?.querySelector<HTMLElement>('button')
      ?.focus();
  }, [viewingComponent]);

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

      {headerActions && !layout && (
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
          // New Customize: a member's name is private in session replay.
          privateTitle={layout}
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

  const mcpTargetNotice =
    layout && mcpTargetError ? (
      <p role="status" data-testid="plugin-mcp-target-unavailable">
        <StatusToneText tone="warning" size="s">
          This MCP server is no longer available
        </StatusToneText>
      </p>
    ) : undefined;
  const mcpServersBlock = showMcpServers && (
    <McpServersSection
      notice={mcpTargetNotice}
      servers={listedMcpServers}
      bundledServerRows={bundledServerRows}
      onOpenEntryId={onOpenEntryId}
      renderStatus={renderMcpServerStatus}
      rowRefs={mcpRows}
      via={companionMcpVia}
    />
  );
  const readmeBlock = displayDetails?.hasReadme && (
    <ReadmeSection
      markdownOptions={markdownOptions}
      key={contentRootsKey}
      activeFacet={activeSlot}
      onReadComponent={onReadComponent}
      preloaded={readme}
      defaultExpanded={!hasComponents}
    />
  );
  const contentsVisible =
    !!layout &&
    ((showComponentsSection && !!displayDetails) ||
      showMcpServers ||
      !!mcpTargetNotice);
  const tabbed = contentsVisible && !!displayDetails?.hasReadme;
  const contentsInner = (
    <>
      {/* A target that is gone is said above the table. */}
      {mcpTargetNotice}
      {listedMods.length > 0 && (
        <>
          <PluginModNotice />
          {modsControl}
        </>
      )}
      {hasNonMcpComponents || showMcpServers ? (
        <PluginContentsTable
          commandHint={commandHint}
          {...(showMcpServers
            ? {
                mcp: {
                  servers: listedMcpServers,
                  via: companionMcpVia ?? [],
                  bundledServerRows,
                  onOpenEntryId,
                  renderStatus: renderMcpServerStatus,
                  rowRefs: mcpRows,
                },
              }
            : {})}
          rows={contentsRows}
        />
      ) : displayDetails && !displayDetails.hasReadme ? (
        <p className="text-s">
          <EmptyStateText title="No components found." tone="secondary" />
        </p>
      ) : null}
    </>
  );

  return (
    <div ref={rootRef} className="flex min-w-0 flex-col gap-6">
      {(!layout || showBack) && chrome}

      {/* Plugin metadata */}
      {layout ? (
        <CapabilityDetailLayout
          dataTestId="plugin-detail"
          includeHostRelated={false}
          logo={
            headerIcon ?? (
              <McpServerLogo
                name={displayName}
                size={40}
                fallback="monogram"
                fit="contain"
                shape="tile"
                plate
              />
            )
          }
          title={displayName}
          titleId="plugin-detail-title"
          publisher={publisher ?? displayAuthor ?? undefined}
          actions={headerActions}
          description={displayDescription}
          facts={{
            ...facts,
            status: statusContent,
            website: displayHomepage ? (
              <DetailWebsiteFact
                href={displayHomepage}
                testId="plugin-detail-links"
              />
            ) : undefined,
          }}
          factsFooter={metadataFooter}
        />
      ) : (
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
                        <DetailFact
                          label="Website"
                          testId="plugin-detail-links"
                        >
                          <ExternalTextLink
                            href={displayHomepage}
                            label={detailWebsiteHost(displayHomepage)}
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
          {mcpTargetError &&
            (neutralStatusText ? (
              <p role="status" data-testid="plugin-mcp-target-unavailable">
                <StatusToneText tone="warning" size="s">
                  This MCP server is no longer available
                </StatusToneText>
              </p>
            ) : (
              <p
                role="status"
                className="text-s fg-warning"
                data-testid="plugin-mcp-target-unavailable"
              >
                This MCP server is no longer available
              </p>
            ))}
          {metadataFooter}
        </section>
      )}

      {/* Host slots render bare, so an empty slot leaves no wrapper. */}
      {!layout && updateNotice}
      {!layout && harnessRows && <PluginWorksWith rows={harnessRows} />}
      {/* New Customize: an Add failure sits in the Works with section, with
          or without the table. */}
      {layout &&
        ((harnessRows?.length ?? 0) > 0 || worksWithNotice ? (
          <ComponentSection title="Works with">
            {harnessRows && harnessRows.length > 0 && (
              <PluginHarnessConnections rows={harnessRows} />
            )}
            {worksWithNotice}
          </ComponentSection>
        ) : null)}

      {/* Host-owned install/action area (desktop install panels; empty on web) */}
      {installActions && (
        <div className="flex flex-col gap-6 empty:hidden">{installActions}</div>
      )}

      {!layout && mcpServersBlock}
      {!layout && sharedContent}
      {!layout && readmeBlock}

      {/* Components */}
      {!layout && showComponentsSection && displayDetails && (
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
                        openComponent({
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
                              openComponent({
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
                              openComponent({
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
                              openComponent({
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
              <p className="text-s">
                <EmptyStateText title="No components found." tone="secondary" />
              </p>
            </div>
          ) : null}
        </div>
      )}

      {contentsVisible &&
        (tabbed ? (
          <PluginDetailTabs
            key={tabOwner}
            contents={contentsInner}
            selection={{
              value: detailTab,
              onChange: (tab) =>
                setReadmeTabOwner(tab === 'readme' ? tabOwner : null),
            }}
            renderReadme={() => (
              <ReadmeSection
                bare
                markdownOptions={markdownOptions}
                key={contentRootsKey}
                activeFacet={activeSlot}
                onReadComponent={onReadComponent}
                preloaded={readme}
                defaultExpanded
              />
            )}
          />
        ) : (
          <ComponentSection title="Contents">{contentsInner}</ComponentSection>
        ))}
      {layout && sharedContent}
      {layout && !tabbed && readmeBlock}

      {relatedContent}
      <DetailHostRelated />
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
              <span data-component-opener={item.key}>
                <ClickableName
                  name={item.command ?? item.name}
                  mono={item.command !== undefined}
                  onClick={item.onOpen}
                />
              </span>
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

/** One row of New Customize's grouped Contents list. */
export interface PluginContentsRow extends NameDescriptionItem {
  /** The kind it is, which groups the rows: Skill, Agent, Command… */
  readonly type: string;
  /** A command line: session replay keeps a placeholder for it. */
  readonly replayBlock?: boolean;
  /** Names copied from installed files are private in session replay. */
  readonly replayBlockName?: boolean;
  /** An MCP server's URL or command line, shown as installed rows show it. */
  readonly endpoint?: PluginContentsEndpoint;
  /**
   * The file a host can open for this row, before the plugin is added; the
   * host that reads it makes the row's `onOpen`.
   */
  readonly component?: {
    readonly componentType: PluginDetailComponentType;
    readonly file: string;
    /** The version whose files list it, which the host reads it from. */
    readonly facet?: PluginDetailFacetSlot;
  };
}

/** An MCP server's endpoint: its URL, or its command and args. */
export interface PluginContentsEndpoint {
  readonly type: 'http' | 'command';
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
}

/**
 * An MCP server's URL or command line, in mono, wrapping anywhere. Both are
 * private in session replay: a hosted server's URL path can carry a per-user
 * credential, and replay redacts only query values.
 */
function McpEndpointText({
  server,
}: {
  server: PluginContentsEndpoint;
}): JSX.Element {
  const args = server.args?.map((arg) => (arg === '' ? '""' : arg)).join(' ');
  return (
    <span
      className={`${REPLAY_BLOCK_CLASS} block min-w-0 break-all font-mono text-xs`}
    >
      {/* The Portal drops a URL it can't parse. */}
      {(server.type === 'http'
        ? server.url
        : `${server.command ?? ''}${args ? ` ${args}` : ''}`) || '—'}
    </span>
  );
}

const CONTENTS_TYPE_ORDER = [
  'Skill',
  'Agent',
  'Command',
  'App',
  'MCP server',
  'Hook',
  'Mod',
  'LSP server',
];

const contentsOrder = (type: string): number =>
  CONTENTS_TYPE_ORDER.indexOf(type);

/** The Contents list's rows in display order: by kind, then by name. */
function sortContentsRows(
  rows: readonly PluginContentsRow[],
): PluginContentsRow[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        contentsOrder(a.type) - contentsOrder(b.type) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * Each row's `data-component-opener` value, by row key: its place in the
 * list. A key carries publisher names and paths, which must not reach the
 * DOM. A place moves when the rows change, so a host remembers the key it
 * opened and finds its opener again with `focusPluginContentsOpener`.
 */
function pluginContentsOpenerIds(
  rows: readonly PluginContentsRow[],
): ReadonlyMap<string, string> {
  return new Map(
    sortContentsRows(rows).map((row, index) => [row.key, String(index)]),
  );
}

/**
 * Back from a Contents row's file: focus that row's opener, found by its key
 * among the rows as they are now (a refresh may have moved it). When the row
 * or its opener is gone, focus goes to the Contents tab, else the list.
 */
export function focusPluginContentsOpener(
  root: HTMLElement | null,
  rows: readonly PluginContentsRow[],
  key: string,
): void {
  if (!root) return;
  const id = pluginContentsOpenerIds(rows).get(key);
  const opener =
    id === undefined
      ? undefined
      : Array.from(root.querySelectorAll('[data-component-opener]'))
          .find(
            (element) => element.getAttribute('data-component-opener') === id,
          )
          ?.querySelector<HTMLElement>('button');
  (
    opener ??
    root.querySelector<HTMLElement>(
      '[data-testid="plugin-detail-tab-contents"]',
    ) ??
    root.querySelector<HTMLElement>('[data-testid="plugin-detail-contents"] ul')
  )?.focus();
}

/** The plugin's MCP servers, as rows of the Contents list. */
interface PluginContentsMcp {
  readonly servers: readonly ListedComponent<PluginMcpServerInfo>[];
  readonly via: readonly PluginMcpServerVia[];
  readonly bundledServerRows?: readonly UnifiedEntryBundledServerRow[];
  readonly onOpenEntryId?: (entryId: string) => void;
  readonly renderStatus?: (
    server: PluginMcpServerInfo,
  ) => ReactNode | undefined;
  readonly rowRefs: RefObject<Map<string, HTMLElement>>;
}

/**
 * New Customize's Contents list groups each kind in a fixed order, then by
 * name. MCP server rows keep their endpoint, health and connection action.
 */
export function PluginContentsTable({
  rows,
  mcp,
  commandHint,
}: {
  rows: readonly PluginContentsRow[];
  mcp?: PluginContentsMcp;
  commandHint?: string;
}): JSX.Element {
  const hasCommands = rows.some((row) => row.command);
  const mcpServers = mcp
    ? mcp.servers.slice().sort((a, b) => a.item.name.localeCompare(b.item.name))
    : [];
  const via = mcp?.via ?? [];
  const showHarness =
    via.length > 0 ||
    rows.some((row) => row.harnesses?.length) ||
    mcpServers.some((server) => server.harnesses.length > 0);
  const sorted = sortContentsRows(rows);
  const openers = pluginContentsOpenerIds(rows);
  const mcpOrder = contentsOrder('MCP server');
  const before = sorted.filter((row) => contentsOrder(row.type) <= mcpOrder);
  const after = sorted.filter((row) => contentsOrder(row.type) > mcpOrder);
  const componentRow = (row: PluginContentsRow): JSX.Element => (
    <ContentsListRow
      key={row.key}
      type={row.type}
      name={
        row.onOpen ? (
          <span data-component-opener={openers.get(row.key)}>
            <ClickableName
              name={row.command ?? row.name}
              mono={row.command !== undefined || row.type === 'Command'}
              privateName={row.replayBlockName === true}
              onClick={row.onOpen}
            />
          </span>
        ) : (
          <span
            className={`${
              row.command || row.type === 'Command'
                ? 'font-mono text-xs font-medium'
                : 'font-medium'
            }${row.replayBlockName ? ` ${REPLAY_BLOCK_CLASS}` : ''}`}
          >
            {row.command ?? row.name}
          </span>
        )
      }
      harnesses={
        showHarness ? <HarnessLogoList harnesses={row.harnesses ?? []} /> : null
      }
      detail={
        row.endpoint || row.description ? (
          <>
            {row.endpoint && <McpEndpointText server={row.endpoint} />}
            {row.description && (
              /* Read from the plugin's own files: replay keeps a placeholder. */
              <div className={REPLAY_BLOCK_CLASS}>
                <ComponentDescription
                  name={row.name}
                  description={row.description}
                />
              </div>
            )}
          </>
        ) : null
      }
    />
  );
  return (
    <Stack gap="inline" className="min-w-0">
      {hasCommands && commandHint && (
        <p
          data-testid="plugin-detail-contents-hint-name"
          className="text-xs fg-tertiary"
        >
          {commandHint}.
        </p>
      )}
      <div
        data-testid="plugin-detail-contents"
        className="min-w-0 overflow-hidden rounded-xl border border-line-base bg-base bg-clip-padding"
      >
        {/* Focusable for Back when the row that opened a file is gone. */}
        <ul
          aria-label="Contents"
          tabIndex={-1}
          className="m-0 list-none p-0 focus-visible:outline-none"
        >
          {before.map(componentRow)}
          {mcp &&
            mcpServers.map(({ item: s, harnesses, slotKinds }) => {
              const settings = mcp.onOpenEntryId
                ? mcp.bundledServerRows?.find(
                    (candidate) =>
                      candidate.serverName === s.name &&
                      candidate.endpoint === mcpEndpointKey(s),
                  )
                : undefined;
              const status = mcp.renderStatus?.(s);
              const open = mcp.onOpenEntryId;
              return (
                <ContentsListRow
                  key={`mcp:${mcpDefinitionKey(s)}`}
                  type="MCP server"
                  focusable
                  // Navigation finds the row through `rowRefs`, never by
                  // name: a server's name is the plugin config's, and no
                  // attribute here is private in session replay.
                  rowRef={(node): void => {
                    for (const key of [
                      s.name,
                      ...slotKinds.map((kind) => mcpRowKey(kind, s.name)),
                    ]) {
                      if (node) mcp.rowRefs.current.set(key, node);
                      else mcp.rowRefs.current.delete(key);
                    }
                  }}
                  name={
                    // The server's name comes from the plugin's config.
                    <span className="font-medium">
                      {settings && open ? (
                        <span data-testid="plugin-detail-mcp-server-settings">
                          <ClickableName
                            name={s.name}
                            description="Open server settings"
                            privateName
                            onClick={() => open(settings.entryId)}
                          />
                        </span>
                      ) : (
                        <span className={REPLAY_BLOCK_CLASS}>{s.name}</span>
                      )}
                    </span>
                  }
                  harnesses={
                    showHarness ? (
                      <HarnessLogoList harnesses={harnesses} />
                    ) : null
                  }
                  detail={<McpEndpointText server={s} />}
                  trailing={
                    status ?? (
                      <span
                        data-testid="plugin-detail-mcp-status-unavailable"
                        className="text-xs fg-tertiary"
                      >
                        {PLUGIN_DETAIL_MCP_NOT_CONFIGURED}
                      </span>
                    )
                  }
                />
              );
            })}
          {/* A harness served by another copy's server: one line naming it. */}
          {via.map((entry) => (
            <ContentsListRow
              key={`mcp-via-${entry.harness}`}
              type="MCP server"
              testId={`plugin-detail-mcp-via-${entry.harness}`}
              name={<span className="fg-tertiary">Another copy</span>}
              harnesses={
                showHarness ? (
                  <HarnessLogoList harnesses={[entry.harness]} />
                ) : null
              }
              detail={
                <span className="flex min-w-0">
                  <PluginHarnessVia
                    via={entry.via}
                    testId={`plugin-detail-mcp-via-${entry.harness}-copy`}
                  />
                </span>
              }
              trailing={
                <span className="text-xs fg-tertiary">
                  {entry.installed ? 'Installed' : 'Not installed'}
                </span>
              }
            />
          ))}
          {after.map(componentRow)}
        </ul>
      </div>
    </Stack>
  );
}

/** The kind of a Contents item, marked as the Customize tiles mark it. */
function ContentsTypeLabel({ type }: { type: string }): JSX.Element {
  switch (type) {
    case 'Skill':
      return <MarketplaceTypeLabel kind="skill" label={type} />;
    case 'Agent':
      return <MarketplaceTypeLabel kind="agent" label={type} />;
    case 'MCP server':
      return <MarketplaceTypeLabel kind="app" label={type} />;
    case 'Command':
      return (
        <MarketplaceTypeLabel
          glyph={<CommandIcon size="xs" ariaHidden />}
          label={type}
        />
      );
    case 'Hook':
      return (
        <MarketplaceTypeLabel
          glyph={<HookIcon size="xs" ariaHidden />}
          label={type}
        />
      );
    default:
      return <MarketplaceTypeLabel label={type} />;
  }
}

/**
 * One item of New Customize's Contents list. The name, kind and harnesses lead
 * the first line; what it is (a description, a URL or a command) takes the
 * full width of the second; its status and action sit at the row's end.
 * Every part wraps rather than clips, so a long command or a long error stays
 * readable.
 */
function ContentsListRow({
  type,
  name,
  harnesses,
  detail,
  trailing,
  focusable = false,
  rowRef,
  testId,
}: {
  type: string;
  name: ReactNode;
  harnesses?: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  focusable?: boolean;
  rowRef?: (node: HTMLLIElement | null) => void;
  testId?: string;
}): JSX.Element {
  return (
    <li
      ref={rowRef}
      tabIndex={focusable ? -1 : undefined}
      data-testid={testId}
      className={`grid items-start gap-x-4 gap-y-1 border-t border-line-base px-4 py-3 first:border-t-0 focus-visible:outline-none ${
        trailing ? 'grid-cols-[minmax(0,1fr)_fit-content(50%)]' : 'grid-cols-1'
      }`}
    >
      <div className="col-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {name}
        <ContentsTypeLabel type={type} />
        {harnesses}
      </div>
      {trailing && (
        <div className="col-start-2 row-span-2 row-start-1 flex min-w-0 max-w-sm items-center justify-end self-center text-right wrap-anywhere">
          {trailing}
        </div>
      )}
      {detail && (
        <div className="col-start-1 min-w-0 text-s fg-secondary">{detail}</div>
      )}
    </li>
  );
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
  via = [],
  notice,
}: {
  /** Section feedback under the heading, such as a target that is gone. */
  notice?: ReactNode;
  servers: readonly ListedComponent<PluginMcpServerInfo>[];
  via?: readonly PluginMcpServerVia[];
  bundledServerRows?: readonly UnifiedEntryBundledServerRow[];
  onOpenEntryId?: (entryId: string) => void;
  renderStatus?: (server: PluginMcpServerInfo) => ReactNode | undefined;
  rowRefs: RefObject<Map<string, HTMLElement>>;
}): JSX.Element {
  const showHarness =
    via.length > 0 || servers.some((server) => server.harnesses.length > 0);
  return (
    <ComponentSection title="MCP servers">
      {notice}
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
          {/* A harness served by another copy's server: one line naming it. */}
          {via.map((entry) => (
            <DataTableRow
              key={`via-${entry.harness}`}
              data-testid={`plugin-detail-mcp-via-${entry.harness}`}
            >
              <DataTableCell colSpan={1} overflow="truncate">
                <span className="fg-tertiary">Another copy</span>
              </DataTableCell>
              <DataTableCell>
                <HarnessLogoList harnesses={[entry.harness]} />
              </DataTableCell>
              <DataTableCell overflow="truncate">
                <span className="flex min-w-0">
                  <PluginHarnessVia
                    via={entry.via}
                    testId={`plugin-detail-mcp-via-${entry.harness}-copy`}
                  />
                </span>
              </DataTableCell>
              <DataTableCell colSpan={2} align="right">
                <span className="text-xs fg-tertiary">
                  {entry.installed ? 'Installed' : 'Not installed'}
                </span>
              </DataTableCell>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTableFrame>
    </ComponentSection>
  );
}
