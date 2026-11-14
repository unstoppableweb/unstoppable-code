import {
  type ComponentType,
  type JSX,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  useCallback,
} from 'react';
import { Button } from './Button';
import { TableActionButton } from './TableActions';
import { DownloadIcon } from '../icons';
import { ChevronRightMediumIcon } from '../icons/AppIcons';
import {
  collapsedSectionCount,
  visibleSectionEntries,
  type PluginsDiscoverySection,
} from '../lib/plugins-discovery-sections';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import { CUSTOMIZE_ROW_GRID_CLASS } from '../lib/customize-grid';
import type { MarketplaceEntryShareStates } from '../lib/marketplace-share';
import type { InstalledEntryStatusStates } from '../lib/installed-item-status';
import {
  InstalledItemStatusControl,
  type InstalledItemSetStatus,
  type InstalledItemUninstall,
} from './InstalledItemStatusRow';
import { McpServerLogo, type McpServerLogoProps } from './McpServerLogo';
import { CustomizeInstalledRow } from './CustomizeInstalledRow';
import { MarketplaceInstallButton } from './MarketplaceInstallButton';
import {
  marketplaceShareMenuItems,
  type CustomizeRowMenuItem,
} from './CustomizeRowMenu';
import { Heading } from './Heading';

/**
 * Sectioned discovery grid for the capability marketplace.
 *
 * Rows use CustomizeInstalledRow, including expanded category results.
 * The section contract and
 * its collapsing helpers live in `./pluginsDiscoverySections`.
 */
export type {
  PluginsDiscoverySection,
  PluginsDiscoverySectionId,
} from '../lib/plugins-discovery-sections';

export interface PluginsDiscoveryListProps {
  sections: PluginsDiscoverySection[];
  /** Category groups nested beneath an existing Browse section heading. */
  nested?: boolean;
  /** Customize supplies its bound row actions while retaining discovery grouping. */
  renderEntry?: (entry: UnifiedPluginEntry) => ReactNode;
  /** Entry whose detail surface is currently open, if any. */
  selectedEntryId: string | null;
  onSelectEntry: (entry: UnifiedPluginEntry) => void;
  /**
   * Starts the entry's add flow without opening its detail surface first.
   * Omitted by hosts that have no add flow of their own (the public web
   * Marketplace, where installing happens on the share page), in which case
   * `available` cards render no Add button rather than one that merely
   * navigates.
   */
  onAddEntry?: (entry: UnifiedPluginEntry) => void;
  /**
   * Share state per entry id, supplied by a host with sharing capability.
   * An entry with a state shows Share: enabled, or disabled with its reason.
   * An entry without one shows no Share. Omit the map (or `onShareEntry`)
   * on hosts that cannot share.
   */
  entryShareStates?: MarketplaceEntryShareStates;
  /** Opens the share flow for an entry whose state is `shareable`. */
  onShareEntry?: (entry: UnifiedPluginEntry) => void;
  /**
   * Handles the card menu's "Connect" item, offered only for `needs-auth`
   * entries. Omitted by hosts that have no auth flow to route into.
   */
  onConnectEntry?: (entry: UnifiedPluginEntry) => void;
  /**
   * Opens another entry's detail by id, for the requirement chips a plugin
   * that needs several integrations carries (REG-3033). Omitted by hosts
   * without in-place navigation, in which case the chips are plain labels.
   */
  onOpenEntryId?: (entryId: string) => void;
  /** Rendered when every section is empty. */
  emptyMessage: string;
  /** Host-specific logo adapter; defaults to the browser-safe shared renderer. */
  McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
  hrefForEntry?: (entry: UnifiedPluginEntry) => string | undefined;
  /**
   * Installed status per entry (CAN-4255). Installed cards with a state show
   * the status picker; rows without one show none. Memoize it: the grid
   * re-renders on every keystroke.
   */
  entryStatus?: PluginsEntryStatusBinding;
}

export interface PluginsEntryStatusBinding {
  readonly states: InstalledEntryStatusStates;
  readonly pendingKeys: ReadonlySet<string>;
  /** Omit to show each status read-only. */
  readonly onSetStatus?: InstalledItemSetStatus;
  readonly onError?: (message: string) => void;
  /** Omit to leave the Customize row menu without a removal item. */
  readonly onUninstall?: InstalledItemUninstall;
  /** Called after a confirmed removal so the host can refresh its inventory. */
  readonly onUninstalled?: (entry: UnifiedPluginEntry) => void;
  /**
   * Identifies the machine and project removal acts on. A pending row
   * confirmation closes when it changes, so it never confirms a target
   * against another desktop. Omit when the scope cannot change.
   */
  readonly removalScope?: string;
}

interface PluginsEntryCardProps {
  entry: UnifiedPluginEntry;
  selected: boolean;
  onSelect: (entry: UnifiedPluginEntry) => void;
  onAdd?: (entry: UnifiedPluginEntry) => void;
  entryShareStates?: MarketplaceEntryShareStates;
  onShare?: (entry: UnifiedPluginEntry) => void;
  onConnect?: (entry: UnifiedPluginEntry) => void;
  onOpenEntryId?: (entryId: string) => void;
  McpServerLogoComponent: ComponentType<McpServerLogoProps>;
  showEntryType: boolean;
  hrefForEntry?: (entry: UnifiedPluginEntry) => string | undefined;
  entryStatus?: PluginsEntryStatusBinding;
}

/**
 * One discovery card. Memoized because the grid re-renders on every keystroke;
 * with a stable `onSelect` identity only the cards whose own props changed
 * re-render.
 */
const PluginsEntryCard = memo(function PluginsEntryCard({
  entry,
  selected,
  onSelect,
  onAdd,
  entryShareStates,
  onShare,
  onConnect,
  onOpenEntryId,
  McpServerLogoComponent,
  showEntryType,
  hrefForEntry,
  entryStatus,
}: PluginsEntryCardProps): JSX.Element {
  const statusState = entryStatus?.states[entry.installedEntryId ?? entry.id];
  const installed =
    entry.state !== 'available' ||
    entry.installedEntryId !== undefined ||
    statusState?.kind === 'ready' ||
    statusState?.kind === 'fixed' ||
    entry.installedVia !== undefined ||
    entry.bundledBy !== undefined;
  const menuItems: CustomizeRowMenuItem[] = [
    { id: 'view', label: 'Open details', onSelect: () => onSelect(entry) },
  ];
  if (entry.state === 'needs-auth' && onConnect)
    menuItems.push({
      id: 'connect',
      label: 'Connect',
      onSelect: () => onConnect(entry),
    });
  menuItems.push(
    ...marketplaceShareMenuItems(entry, entryShareStates, onShare),
  );
  for (const requirement of onOpenEntryId ? (entry.requirements ?? []) : []) {
    menuItems.push({
      id: `requirement-${requirement.key}`,
      label: `Open ${requirement.name}`,
      disabled: onOpenEntryId === undefined,
      onSelect: () => onOpenEntryId?.(requirement.entryId),
    });
  }
  return (
    <CustomizeInstalledRow
      entry={entry}
      sectionId="discovery"
      primaryTestId={`plugins-entry-${entry.id}`}
      menuTestId={`plugins-entry-menu-${entry.id}`}
      actions={
        installed && entry.updateAvailable ? (
          <TableActionButton
            label="Update available · Click to view update"
            testId={`plugins-update-available-${entry.id}`}
            onClick={() => onSelect(entry)}
          >
            <DownloadIcon size="sm" aria-hidden="true" />
          </TableActionButton>
        ) : undefined
      }
      selected={selected}
      showEntryType={showEntryType}
      onSelect={onSelect}
      href={hrefForEntry?.(entry)}
      McpServerLogoComponent={McpServerLogoComponent}
      menuItems={menuItems}
      onConnect={onConnect}
      status={
        <span className="flex w-36 shrink-0 justify-end">
          {installed ? (
            entryStatus && statusState !== undefined ? (
              <InstalledItemStatusControl
                itemName={entry.name}
                state={statusState}
                pendingKeys={entryStatus.pendingKeys}
                onSetStatus={entryStatus.onSetStatus}
                onError={entryStatus.onError}
                testId={`plugins-entry-status-${entry.id}`}
              />
            ) : null
          ) : onAdd ? (
            <MarketplaceInstallButton entry={entry} onAdd={onAdd} />
          ) : null}
        </span>
      }
    />
  );
});

// A stable bound renderer keeps menus and callbacks intact while search changes
// group membership, without rebuilding the surviving rows.
const BoundEntry = memo(function BoundEntry({
  entry,
  renderEntry,
}: {
  entry: UnifiedPluginEntry;
  renderEntry: (entry: UnifiedPluginEntry) => ReactNode;
}): ReactNode {
  return renderEntry(entry);
});

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

interface PluginsDiscoverySectionViewProps {
  nested: boolean;
  renderEntry?: (entry: UnifiedPluginEntry) => ReactNode;
  section: PluginsDiscoverySection;
  selectedEntryId: string | null;
  onSelectEntry: (entry: UnifiedPluginEntry) => void;
  onAddEntry?: (entry: UnifiedPluginEntry) => void;
  entryShareStates?: MarketplaceEntryShareStates;
  onShareEntry?: (entry: UnifiedPluginEntry) => void;
  onConnectEntry?: (entry: UnifiedPluginEntry) => void;
  onOpenEntryId?: (entryId: string) => void;
  McpServerLogoComponent: ComponentType<McpServerLogoProps>;
  hrefForEntry?: (entry: UnifiedPluginEntry) => string | undefined;
  entryStatus?: PluginsEntryStatusBinding;
}

function PluginsDiscoverySectionView({
  nested,
  renderEntry,
  section,
  selectedEntryId,
  onSelectEntry,
  onAddEntry,
  entryShareStates,
  onShareEntry,
  onConnectEntry,
  onOpenEntryId,
  McpServerLogoComponent,
  hrefForEntry,
  entryStatus,
}: PluginsDiscoverySectionViewProps): JSX.Element {
  const collapsedCount = collapsedSectionCount(section);
  const entries = visibleSectionEntries(section);
  const headingContent = section.onExpand ? (
    <Button
      size="compact"
      type="button"
      data-testid={`plugins-section-heading-${section.id}`}
      aria-label={`Browse ${section.title}`}
      onClick={section.onExpand}
      variant="ghost"
      className="group -ml-1 text-left"
    >
      <span
        data-testid="plugins-section-heading-title"
        className={
          nested
            ? 'fg-secondary transition-colors group-hover:fg-primary'
            : 'fg-primary transition-colors group-hover:fg-secondary'
        }
      >
        {section.title}
      </span>
      <ChevronRightMediumIcon
        size={16}
        aria-hidden
        data-testid="plugins-section-heading-chevron"
        className="fg-tertiary transition-transform duration-200 ease-out group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
      />
    </Button>
  ) : (
    <span
      className={`${nested ? 'fg-secondary' : 'fg-primary'} inline-flex h-7 items-center`}
    >
      {section.title}
    </span>
  );

  return (
    <section
      data-testid={`plugins-section-${section.id}`}
      // Cards this section currently contributes.
      data-row-count={entries.length}
      data-collapsed-count={collapsedCount}
      data-virtualized="false"
    >
      {/* Heading + hairline, per the reference: the rule spans the column and
          separates bands without boxing them, so the cards read as content on
          the page rather than rows in a table. */}
      {section.title !== '' &&
        (nested ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <Heading level={3} variant="title">
              {headingContent}
            </Heading>
            {section.headerActions}
          </div>
        ) : section.headerActions ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-2">
            <Heading level={2} variant="section">
              {headingContent}
            </Heading>
            {section.headerActions}
          </div>
        ) : (
          <div className="border-b pb-2">
            <Heading level={2} variant="section">
              {headingContent}
            </Heading>
          </div>
        ))}
      {entries.length === 0 && section.emptyMessage !== undefined && (
        <p
          data-testid={`plugins-section-empty-${section.id}`}
          className="py-10 text-center text-s fg-secondary"
        >
          {section.emptyMessage}
        </p>
      )}
      <ul
        data-testid={`plugins-section-body-${section.id}`}
        className={`${nested ? 'mt-1' : 'mt-3'} ${CUSTOMIZE_ROW_GRID_CLASS}`}
      >
        {entries.map((entry) =>
          renderEntry ? (
            <BoundEntry
              key={entry.id}
              entry={entry}
              renderEntry={renderEntry}
            />
          ) : (
            <PluginsEntryCard
              key={entry.id}
              entry={entry}
              selected={entry.id === selectedEntryId}
              onSelect={onSelectEntry}
              onAdd={onAddEntry}
              entryShareStates={entryShareStates}
              onShare={onShareEntry}
              onConnect={onConnectEntry}
              onOpenEntryId={onOpenEntryId}
              McpServerLogoComponent={McpServerLogoComponent}
              showEntryType={section.showEntryTypes === true}
              hrefForEntry={hrefForEntry}
              entryStatus={entryStatus}
            />
          ),
        )}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function PluginsDiscoveryList({
  nested = false,
  renderEntry,
  sections,
  selectedEntryId,
  onSelectEntry,
  onAddEntry,
  entryShareStates,
  onShareEntry,
  onConnectEntry,
  onOpenEntryId,
  emptyMessage,
  McpServerLogoComponent = McpServerLogo,
  hrefForEntry,
  entryStatus,
}: PluginsDiscoveryListProps): JSX.Element {
  const populated = sections.filter(
    (section) =>
      section.entries.length > 0 || section.headerActions !== undefined,
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const entries = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          '[data-marketplace-entry="true"]',
        ),
      );
      const index = entries.findIndex(
        (entry) => entry === document.activeElement,
      );
      if (index === -1) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = entries[index + delta];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView?.({ block: 'nearest' });
    },
    [],
  );

  if (populated.length === 0) {
    return (
      <p className="py-10 text-center text-s fg-secondary">{emptyMessage}</p>
    );
  }

  return (
    <div
      className={nested ? 'flex flex-col gap-4' : 'flex flex-col gap-10'}
      data-testid="plugins-discovery-list"
      onKeyDown={handleKeyDown}
    >
      {populated.map((section) => (
        <PluginsDiscoverySectionView
          key={section.id}
          section={section}
          nested={nested}
          renderEntry={renderEntry}
          selectedEntryId={selectedEntryId}
          onSelectEntry={onSelectEntry}
          onAddEntry={onAddEntry}
          entryShareStates={entryShareStates}
          onShareEntry={onShareEntry}
          onConnectEntry={onConnectEntry}
          onOpenEntryId={onOpenEntryId}
          McpServerLogoComponent={McpServerLogoComponent}
          hrefForEntry={hrefForEntry}
          entryStatus={entryStatus}
        />
      ))}
    </div>
  );
}
