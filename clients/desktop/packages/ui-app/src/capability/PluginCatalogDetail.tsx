import { useCustomizeDiscoveryEnabled } from './CustomizeDiscoveryProvider';
import {
  type ComponentType,
  type JSX,
  type ReactNode,
  useRef,
  useState,
} from 'react';
import type { PluginInfo } from '@canopy/protocol/plugins';
import type { PortalPluginCatalogMemberSummary } from '@canopy/protocol/portal';
import {
  McpServerLogo,
  type McpServerLogoProps,
  type UnifiedEntryAlternative,
  type UnifiedPluginEntry,
} from '@canopy/ui-shared';
import { customizeRowAction } from './customizeRowAction';
import {
  Badge,
  Button,
  CapabilityDetailLayout,
  ComponentSection,
  DataTable,
  DropdownMenuItem,
  FloatingMenu,
  type CustomizeRowMenuItem,
  DetailFact,
  DetailEntityType,
  DetailWebsiteFact,
  ExecutionActionButton,
  Heading,
  TextLink,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  PluginAlternatives,
  PluginVariantDifferences,
} from './PluginAlternatives';
import { Divider } from '@canopy/ui-shared/components';

export interface PluginCatalogDetailModel {
  name: PluginInfo['name'];
  author?: PluginInfo['author'];
  description?: PluginInfo['description'];
  homepage?: PluginInfo['homepage'];
  logoUrl?: PluginInfo['logoUrl'];
  bundledLogo?: string;
  brandMark?: boolean;
  categories: readonly string[];
  components: Pick<
    PortalPluginCatalogMemberSummary,
    'skills' | 'mcpServers' | 'commands' | 'agents'
  >;
  /** New Customize: the tile's publisher line, in place of "By author". */
  publisher?: ReactNode;
  /** New Customize: the marketplace it is listed in, for the Marketplace row. */
  marketplace?: { name: string; onOpen?: () => void };
}

export interface PluginCatalogDetailProps {
  entry: PluginCatalogDetailModel;
  /** The same app from other catalogs, linked under the description. */
  alternatives?: readonly UnifiedEntryAlternative[];
  onOpenEntryId?: (entryId: string) => void;
  McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
  /** New Customize: the tile's logo, so page and tile wear the same mark. */
  logo?: ReactNode;
  /**
   * New Customize's shared layout, for a Customize plugin not added yet whose
   * host supplies the tile's identity and Add. Other consumers (installed
   * summaries, cloud catalog pages) keep the base layout.
   */
  layout?: boolean;
  /**
   * New Customize: the Status row (a partial removal's notice, say), first
   * among the facts.
   */
  status?: ReactNode;
}

/**
 * The summary's primary action. Hosts place it last in the page's
 * `DetailActionBar`, after Share, at the top right of the Back row.
 */
export function PluginCatalogAddButton({
  onAdd,
  busy = false,
  unavailableReason,
}: {
  onAdd: () => void;
  /** An Add in progress: "Adding…", disabled. */
  busy?: boolean;
  /** Why it can't be added (the tile's reason); disabled with a tooltip. */
  unavailableReason?: string;
}): JSX.Element {
  if (unavailableReason !== undefined)
    return (
      <Tooltip label={unavailableReason}>
        <span tabIndex={0} className="inline-flex">
          <ExecutionActionButton
            label="Add"
            ariaLabel={`Add: ${unavailableReason}`}
            variant="primary"
            placement="detail"
            onClick={onAdd}
            disabled
            dataTestId="plugin-catalog-detail-add"
            stopKeyDownPropagation={false}
          />
        </span>
      </Tooltip>
    );
  return (
    <ExecutionActionButton
      label={busy ? 'Adding…' : 'Add'}
      ariaLabel="Add"
      variant="primary"
      placement="detail"
      onClick={onAdd}
      disabled={busy}
      dataTestId="plugin-catalog-detail-add"
      // The detail closes on a document-level Escape; a focused Add must let
      // that key through.
      stopKeyDownPropagation={false}
    />
  );
}

/**
 * New Customize's catalog primary: the tile's own Add, built from its row
 * action. A grouped row offers one Add per marketplace with an installable
 * listing, as its tile does; otherwise it's the single Add, disabled with
 * the tile's reason when nothing can be added.
 */
export function PluginCatalogAddAction({
  entry,
  onAdd,
  busy = false,
}: {
  entry: UnifiedPluginEntry;
  /** Adds the chosen listing (the row itself, or one provider's copy). */
  onAdd: (listing: UnifiedPluginEntry) => void;
  busy?: boolean;
}): JSX.Element {
  const action = customizeRowAction({
    entry,
    installed: false,
    add: onAdd,
    statuses: [],
    pendingKeys: new Set(),
  });
  const choices = action.leadingItems ?? [];
  if (choices.length > 0)
    return (
      <PluginCatalogAddChoices
        name={entry.name}
        choices={choices}
        busy={busy}
      />
    );
  return (
    <PluginCatalogAddButton
      onAdd={() => action.onPrimary?.()}
      busy={busy}
      {...(action.reason !== undefined
        ? { unavailableReason: action.reason }
        : {})}
    />
  );
}

/**
 * A grouped row's Add on a detail page: the primary Add, opening the tile's
 * "Add from …" choices.
 */
function PluginCatalogAddChoices({
  name,
  choices,
  busy,
}: {
  name: string;
  choices: readonly CustomizeRowMenuItem[];
  busy: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  return (
    <span ref={anchorRef} className="inline-flex">
      <ExecutionActionButton
        label={busy ? 'Adding…' : 'Add'}
        ariaLabel={`Add ${name}`}
        aria-haspopup="menu"
        variant="primary"
        placement="detail"
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        dataTestId="plugin-catalog-detail-add"
        stopKeyDownPropagation={false}
      />
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        aria-label={`Add ${name} from`}
        data-testid="plugin-catalog-detail-add-menu"
        className="min-w-40"
      >
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.id}
            disabled={choice.disabled}
            onClick={() => {
              setOpen(false);
              choice.onSelect();
            }}
          >
            {choice.label}
          </DropdownMenuItem>
        ))}
      </FloatingMenu>
    </span>
  );
}

/** The kinds a listing counts, in the Contents table's order. */
const CONTENT_KINDS: readonly {
  readonly key: keyof PluginCatalogDetailModel['components'];
  readonly label: string;
}[] = [
  { key: 'skills', label: 'Skills' },
  { key: 'agents', label: 'Agents' },
  { key: 'commands', label: 'Commands' },
  { key: 'mcpServers', label: 'MCP servers' },
];

/** Pure marketplace plugin summary body; its actions are host chrome. */
export function PluginCatalogDetail({
  entry,
  alternatives,
  onOpenEntryId,
  McpServerLogoComponent = McpServerLogo,
  logo,
  layout = false,
  status,
}: PluginCatalogDetailProps): JSX.Element {
  // Customize's light logo plate, only while New Customize is on.
  const logoPlate = useCustomizeDiscoveryEnabled();
  const componentCount = Object.values(entry.components).reduce(
    (total, count) => total + count,
    0,
  );
  const includedNote =
    componentCount > 0
      ? `${componentCount} plugin component${componentCount === 1 ? '' : 's'} available after adding.`
      : 'Plugin capabilities become available after adding.';
  const logoMark = logo ?? (
    <McpServerLogoComponent
      logoUrl={entry.logoUrl}
      bundledLogo={entry.bundledLogo}
      brandMark={entry.brandMark}
      size={40}
      fallback="monogram"
      name={entry.name}
      shape={logoPlate ? 'tile' : 'circle'}
      fit="contain"
      plate={logoPlate}
    />
  );
  if (layout) {
    // New Customize: the shared page; the category no longer shows in the
    // header, and the shell's Add joins the title row.
    const otherVersions = alternatives?.filter(
      (alternative) => !alternative.marketplaceVariant,
    );
    return (
      <div data-testid="plugin-catalog-detail">
        <CapabilityDetailLayout
          dataTestId="plugin-catalog-detail-layout"
          logo={logoMark}
          title={entry.name}
          titleId="plugin-detail-title"
          publisher={entry.publisher ?? entry.author}
          description={entry.description}
          facts={{
            status,
            source: entry.marketplace ? (
              <DetailFact label="Marketplace" testId="plugin-detail-provider">
                {entry.marketplace.onOpen ? (
                  <Button
                    variant="link"
                    onClick={entry.marketplace.onOpen}
                    data-testid="plugin-detail-source-link"
                  >
                    {entry.marketplace.name}
                  </Button>
                ) : (
                  entry.marketplace.name
                )}
              </DetailFact>
            ) : undefined,
            website: entry.homepage ? (
              <DetailWebsiteFact
                href={entry.homepage}
                testId="plugin-detail-links"
              />
            ) : undefined,
            otherVersions:
              (otherVersions?.length ?? 0) > 0 ||
              (alternatives?.length ?? 0) > 0 ? (
                <>
                  {(otherVersions?.length ?? 0) > 0 && (
                    <DetailFact label="Other versions">
                      <PluginAlternatives
                        alternatives={otherVersions}
                        onOpenEntryId={onOpenEntryId}
                        testIdPrefix="plugin-catalog-detail-also-available"
                        linksOnly
                      />
                    </DetailFact>
                  )}
                  <PluginVariantDifferences
                    alternatives={alternatives}
                    onOpenEntryId={onOpenEntryId}
                  />
                </>
              ) : undefined,
          }}
          contents={
            <ComponentSection title="Contents">
              {/* The listing counts each kind; names and files arrive
                  with the plugin when it is added. */}
              <DataTable
                caption="Contents"
                testId="plugin-catalog-detail-contents"
                rows={CONTENT_KINDS.filter(
                  ({ key }) => entry.components[key] > 0,
                )}
                rowKey={({ key }) => key}
                emptyLabel={includedNote}
                columns={[
                  {
                    key: 'kind',
                    header: 'Kind',
                    render: ({ label }) => label,
                  },
                  {
                    key: 'count',
                    header: 'Count',
                    align: 'right',
                    render: ({ key }) => entry.components[key],
                  },
                ]}
              />
              {componentCount > 0 && (
                <p className="text-xs fg-tertiary">{includedNote}</p>
              )}
            </ComponentSection>
          }
        />
      </div>
    );
  }

  return (
    // Not a scroller of its own: the page root and the dialog body already
    // scroll, and a nested scroll box here clipped the hairline ring and
    // shadow of the header controls sitting flush against its top edge.
    <div
      className="flex min-h-0 flex-1 flex-col gap-4"
      data-testid="plugin-catalog-detail"
    >
      <div className="flex items-start gap-3">
        {logoMark}
        <div className="min-w-0 flex-1">
          <Heading level={3} variant="section">
            <span className="inline-flex flex-wrap items-baseline gap-x-2">
              {entry.name}
              <DetailEntityType />
            </span>
          </Heading>
          {entry.author && (
            <p className="mt-0.5 text-xs fg-secondary">By {entry.author}</p>
          )}
        </div>
      </div>

      {(entry.description || (alternatives?.length ?? 0) > 0) && (
        <div>
          {entry.description && (
            <p className="text-s fg-secondary">{entry.description}</p>
          )}
          <PluginAlternatives
            alternatives={alternatives?.filter(
              (alternative) => !alternative.marketplaceVariant,
            )}
            onOpenEntryId={onOpenEntryId}
            testIdPrefix="plugin-catalog-detail-also-available"
          />
          <PluginVariantDifferences
            alternatives={alternatives}
            onOpenEntryId={onOpenEntryId}
          />
        </div>
      )}
      {entry.homepage && (
        <p className="text-xs">
          <TextLink href={entry.homepage} target="_blank" rel="noreferrer">
            Website
          </TextLink>
        </p>
      )}
      {entry.categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {entry.categories.map((category) => (
            <Badge key={category}>{category}</Badge>
          ))}
        </div>
      )}
      <div>
        <Divider />
        <div className="pt-4 flex flex-col gap-1">
          <Heading level={4} variant="title">
            Included
          </Heading>
          <p className="text-xs fg-secondary">{includedNote}</p>
        </div>
      </div>
    </div>
  );
}
