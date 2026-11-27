'use client';
import { DetailEntityType } from '@canopy/ui-shared/components';

import { useState, type JSX, type ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  curatedMcpProviderOnly,
  type CuratedMcpConnectorProvider,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import {
  Badge,
  CapabilityDetailLayout,
  ComponentSection,
  DetailFact,
  DetailFactError,
  DetailWebsiteFact,
  useItemStateMarks,
  DataTable,
  ErrorBanner,
  Button,
  DelayedLoadingPlaceholder,
  McpServerLogo,
  Notice,
  PluginConfigurationButton,
  PluginConnectionRouteSection,
  Heading,
  Skeleton,
  TextLink,
} from '@canopy/ui-shared/components';
import { McpPlacementSlotProvider } from './McpServerManagement';
import {
  curatedMcpPublishedContents,
  type PublishedMcpContent,
} from './curatedMcpPublishedContents';
import {
  MCP_PROVIDER_CONNECTOR_LABELS,
  mcpProviderOnlyGuidance,
} from './mcpConnectionCopy';

/**
 * How a provider-only service connects, for a detail with no provider route
 * on screen to do it from (REG-3034). Hosts that render their own route area
 * place it there; `CuratedMcpDetail` shows it when no route is passed.
 */
export function McpProviderOnlyGuidance({
  entry,
}: {
  entry: Pick<McpDetailEntry, 'name' | 'providerConnector'>;
}): JSX.Element {
  return (
    <div data-testid="mcp-browse-detail-provider-guidance">
      <Notice intent="neutral">
        {mcpProviderOnlyGuidance(
          entry.name,
          (entry.providerConnector?.providers ?? []).map(
            (provider: CuratedMcpConnectorProvider): string =>
              MCP_PROVIDER_CONNECTOR_LABELS[provider],
          ),
        )}
      </Notice>
    </div>
  );
}

/** Display-only metadata; local servers need no fabricated catalog entry. */
export type McpDetailEntry = Pick<
  CuratedMcpServerEntry,
  'name' | 'shortDescription'
> &
  Partial<
    Pick<
      CuratedMcpServerEntry,
      | 'key'
      | 'url'
      | 'longDescription'
      | 'logoUrl'
      | 'authorName'
      | 'authorUrl'
      | 'docsUrl'
      | 'supportUrl'
      | 'privacyPolicyUrl'
      | 'categories'
      | 'providerConnector'
      | 'oauthHints'
      | 'requiredConfigFields'
    >
  >;

/**
 * The routes a service offers when this entry is not the only one, such as a
 * provider connector folded into an integration card (REG-3033).
 */
export interface CuratedMcpDetailRoutes {
  /** Names the app connection when one exists; omitted for provider-only entries. */
  own?: { title: string; description: string };
  /** The other routes, each its own section, after this entry's tools. */
  others: ReactNode;
}

export interface CuratedMcpDetailProps<
  T extends McpDetailEntry = CuratedMcpServerEntry,
> {
  entry: T;
  installedServerId: string | null;
  toolNames: string[] | null;
  toolsLoading: boolean;
  toolsError: string;
  onAdd?: (entry: T) => void;
  onConfigure?: () => void;
  renderLogo?: (entry: T) => ReactNode;
  actions?: ReactNode;
  connectionContent?: ReactNode;
  /**
   * The person's accounts of this connector (CAN-6226), under the name,
   * description and categories, so the header reads before them. It is given
   * the facts that describe one account (Health and Placement from
   * `renderManagement`, then `connectionContent`) to draw inside the account
   * the detail shows; the page then leaves them out. Pass it only when the
   * person holds an account, so the facts never go missing.
   */
  renderAccounts?: (accountDetails: ReactNode) => ReactNode;
  /**
   * Where the server is installed (the Works with list). It describes the
   * server, not an account, so it stays on the page after the facts.
   */
  availability?: ReactNode;
  /**
   * Set when the service can also be reached another way. This entry's
   * connection and tools then read as one titled route, followed by the
   * others, so nothing on the page reads as belonging to both.
   */
  routes?: CuratedMcpDetailRoutes;
  /** The installed item's Status, under the name and description. */
  statusContent?: ReactNode;
  /** The installed server's Health and Placement facts, above Connection. */
  renderManagement?: () => ReactNode;
  /** On a page that sets its own width, so it lines up with the page actions. */
  flush?: boolean;
  /** New Customize: the tile's 40px logo. */
  logo?: ReactNode;
  /** New Customize: the tile's publisher line. */
  publisher?: ReactNode;
  /** New Customize: when the installed server last changed, formatted. */
  updated?: string;
  otherVersions?: ReactNode;
  /** New Customize: the collapsed Configuration section. */
  configuration?: ReactNode;
  /** New Customize: the Works with table, as the tile's chips read it. */
  worksWith?: ReactNode;
  /** New Customize: the Related section. */
  related?: ReactNode;
}

export function CuratedMcpDetail<T extends McpDetailEntry>({
  entry,
  installedServerId,
  toolNames,
  toolsLoading,
  toolsError,
  onAdd,
  onConfigure,
  renderLogo,
  actions,
  connectionContent,
  renderAccounts,
  availability,
  routes,
  statusContent,
  renderManagement,
  flush = false,
  logo,
  publisher,
  updated,
  otherVersions,
  configuration,
  worksWith,
  related,
}: CuratedMcpDetailProps<T>): JSX.Element {
  // New Customize draws the page through the shared detail layout.
  const layout = useItemStateMarks();
  const providerOnly = curatedMcpProviderOnly(entry);
  // With no provider route on screen (the MCP tab's Browse dialog), say how
  // this service connects rather than ending on its description.
  const showProviderGuidance = providerOnly && !routes?.others;
  const links: Array<{ href: string; label: string }> = [];
  if (entry.docsUrl)
    links.push({ href: entry.docsUrl, label: 'Documentation' });
  if (entry.supportUrl)
    links.push({ href: entry.supportUrl, label: 'Support' });
  if (entry.privacyPolicyUrl)
    links.push({ href: entry.privacyPolicyUrl, label: 'Privacy policy' });

  const toolsBody = (
    <McpToolsBody
      inlineError={layout}
      published={curatedMcpPublishedContents(entry.url)}
      installed={installedServerId !== null}
      toolNames={toolNames}
      toolsLoading={toolsLoading}
      toolsError={toolsError}
    />
  );
  const tools = (
    <div data-testid="mcp-browse-tools">
      <ComponentSection title="Tools">{toolsBody}</ComponentSection>
    </div>
  );
  const management = renderManagement?.();
  // With an accounts list, the facts about one account move into its row.
  const accounts =
    renderAccounts?.(
      providerOnly ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          {management}
          {connectionContent}
        </div>
      ),
    ) ?? null;
  const accountFactsMoved = renderAccounts !== undefined;
  const pageManagement = accountFactsMoved ? null : management;
  const pageConnectionContent = accountFactsMoved ? null : connectionContent;

  if (layout) {
    return (
      <McpLayoutDetail
        entry={entry}
        renderLogo={renderLogo}
        logo={logo}
        publisher={publisher}
        actions={actions}
        onAdd={onAdd}
        onConfigure={onConfigure}
        installedServerId={installedServerId}
        providerOnly={providerOnly}
        showProviderGuidance={showProviderGuidance}
        links={links}
        statusContent={statusContent}
        management={pageManagement}
        connectionContent={pageConnectionContent}
        accounts={accounts}
        availability={availability}
        routes={routes}
        tools={tools}
        updated={updated}
        otherVersions={otherVersions}
        worksWith={worksWith}
        configuration={configuration}
        related={related}
        flush={flush}
      />
    );
  }
  return (
    <div
      className={`flex flex-1 min-h-0 flex-col gap-6 pb-5 overflow-y-auto${flush ? '' : ' px-5'}`}
      data-testid="mcp-browse-detail"
    >
      <div className="flex items-start gap-3">
        {renderLogo?.(entry) ?? (
          <McpServerLogo
            curatedKey={entry.key}
            logoUrl={entry.logoUrl}
            name={entry.name}
            size={40}
            fallback="monogram"
            imgTestId="mcp-curated-logo"
            fallbackTestId="mcp-curated-logo-fallback"
          />
        )}
        <div className="min-w-0 flex-1">
          <Heading level={3} variant="section">
            <span className="inline-flex flex-wrap items-baseline gap-x-2">
              {entry.name}
              <DetailEntityType />
            </span>
          </Heading>
          {entry.authorName && (
            <p className="mt-0.5 text-xs fg-secondary">
              By{' '}
              {entry.authorUrl ? (
                <TextLink
                  href={entry.authorUrl}
                  size="xs"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {entry.authorName}
                </TextLink>
              ) : (
                <span>{entry.authorName}</span>
              )}
            </p>
          )}
        </div>
        {actions ??
          (providerOnly ? null : installedServerId !== null && onConfigure ? (
            <PluginConfigurationButton onConfigure={onConfigure} />
          ) : onAdd ? (
            <Button
              type="button"
              variant="primary"
              size="compact"
              onClick={() => onAdd(entry)}
              data-testid="mcp-browse-detail-add"
            >
              Add
            </Button>
          ) : null)}
      </div>

      <p className="text-s fg-secondary">
        {entry.longDescription ?? entry.shortDescription}
      </p>
      {links.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {links.map((link) => (
            <TextLink
              key={link.label}
              href={link.href}
              size="xs"
              target="_blank"
              rel="noopener noreferrer"
            >
              {link.label}
            </TextLink>
          ))}
        </div>
      )}
      {Boolean(entry.categories?.length) && (
        <div className="flex flex-wrap gap-1.5">
          {entry.categories?.map((category) => (
            <Badge key={category}>{category}</Badge>
          ))}
        </div>
      )}
      {accounts}

      {showProviderGuidance && <McpProviderOnlyGuidance entry={entry} />}
      {routes ? (
        <>
          {statusContent}
          {!providerOnly && routes.own && (
            <PluginConnectionRouteSection
              title={routes.own.title}
              description={routes.own.description}
              dataTestId="mcp-browse-detail-app-route"
            >
              <div className="flex flex-col gap-1 empty:hidden">
                {pageManagement}
                {pageConnectionContent}
                {availability}
              </div>
              {tools}
            </PluginConnectionRouteSection>
          )}
          {routes.others}
        </>
      ) : (
        <>
          {/* Facts stay one list: Status, Health, Placement, Connection. */}
          <div className="flex flex-col gap-1 empty:hidden">
            {statusContent}
            {!providerOnly && pageManagement}
            {!providerOnly && pageConnectionContent}
            {!providerOnly && availability}
          </div>
          {!providerOnly && tools}
        </>
      )}
    </div>
  );
}

/** New Customize's MCP page on the shared layout (`CuratedMcpDetail`). */
function McpLayoutDetail<T extends McpDetailEntry>({
  entry,
  renderLogo,
  logo,
  publisher,
  actions,
  onAdd,
  onConfigure,
  installedServerId,
  providerOnly,
  showProviderGuidance,
  links,
  statusContent,
  management,
  connectionContent,
  accounts,
  availability,
  routes,
  tools,
  updated,
  otherVersions,
  worksWith,
  configuration,
  related,
  flush,
}: Pick<
  CuratedMcpDetailProps<T>,
  | 'entry'
  | 'renderLogo'
  | 'logo'
  | 'publisher'
  | 'actions'
  | 'onAdd'
  | 'onConfigure'
  | 'installedServerId'
  | 'statusContent'
  | 'connectionContent'
  | 'availability'
  | 'routes'
  | 'updated'
  | 'otherVersions'
  | 'worksWith'
  | 'configuration'
  | 'related'
  | 'flush'
> & {
  providerOnly: boolean;
  showProviderGuidance: boolean;
  links: readonly { href: string; label: string }[];
  management: ReactNode;
  /** The accounts list, holding the facts about the account it shows. */
  accounts: ReactNode;
  tools: ReactNode;
}): JSX.Element {
  // The management card's Placement row lands here, after Connection.
  const [placementSlot, setPlacementSlot] = useState<HTMLElement | null>(null);
  const defaultAction = providerOnly ? null : installedServerId !== null &&
    onConfigure ? (
    <PluginConfigurationButton onConfigure={onConfigure} />
  ) : onAdd ? (
    <Button
      type="button"
      variant="primary"
      size="compact"
      onClick={() => onAdd(entry)}
      data-testid="mcp-browse-detail-add"
    >
      Add
    </Button>
  ) : null;
  const website = entry.authorUrl ?? entry.docsUrl;
  const otherLinks = links.filter((link) => link.href !== website);
  return (
    <McpPlacementSlotProvider value={placementSlot}>
      <div
        className={`flex flex-1 min-h-0 flex-col gap-6 pb-5 overflow-y-auto${flush ? '' : ' px-5'}`}
        data-testid="mcp-browse-detail"
      >
        <CapabilityDetailLayout
          dataTestId="mcp-detail"
          logo={
            logo ??
            renderLogo?.(entry) ?? (
              <McpServerLogo
                curatedKey={entry.key}
                logoUrl={entry.logoUrl}
                name={entry.name}
                size={40}
                fallback="monogram"
                shape="tile"
                plate
                imgTestId="mcp-curated-logo"
                fallbackTestId="mcp-curated-logo-fallback"
              />
            )
          }
          title={entry.name}
          titleId="plugin-detail-title"
          publisher={publisher ?? entry.authorName}
          actions={actions ?? defaultAction}
          description={entry.longDescription ?? entry.shortDescription}
          facts={{
            status: statusContent,
            // Health, then Placement, from the shared management card. The
            // fact list is a two-column grid and this is not a DetailFact, so
            // the grid item spans both columns here: a host's own wrapper or
            // the card inside it would not be the grid item.
            health:
              !providerOnly && management ? (
                <div className="col-span-2">{management}</div>
              ) : undefined,
            website: website ? (
              <DetailWebsiteFact href={website} testId="mcp-detail-website" />
            ) : undefined,
            otherVersions,
            updated: updated ? (
              <DetailFact label="Updated" testId="mcp-detail-updated">
                {updated}
              </DetailFact>
            ) : undefined,
            entity:
              otherLinks.length > 0 ? (
                <DetailFact label="Links" testId="mcp-detail-links">
                  <span className="inline-flex flex-wrap items-center gap-x-3">
                    {otherLinks.map((link) => (
                      <TextLink
                        key={link.label}
                        href={link.href}
                        size="xs"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {link.label}
                      </TextLink>
                    ))}
                  </span>
                </DetailFact>
              ) : undefined,
          }}
          factsFooter={
            accounts !== null ? (
              <>
                {accounts}
                {!providerOnly && availability}
              </>
            ) : !providerOnly ? (
              <>
                {connectionContent}
                {availability}
                <div
                  ref={setPlacementSlot}
                  className="flex flex-col empty:hidden"
                />
              </>
            ) : undefined
          }
          contents={
            showProviderGuidance || routes || !providerOnly ? (
              <>
                {showProviderGuidance && (
                  <McpProviderOnlyGuidance entry={entry} />
                )}
                {/* This server's tools, then any other way to reach the
                    service (a provider connector), each its own section. */}
                {!providerOnly && tools}
                {routes?.others}
              </>
            ) : undefined
          }
          worksWith={worksWith}
          settings={configuration}
          related={related}
        />
      </div>
    </McpPlacementSlotProvider>
  );
}

/** The tool names the loading skeleton measures. */
function ToolChips({
  toolNames,
}: {
  toolNames: readonly string[];
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1">
      {toolNames.map((tool) => (
        <Badge key={tool} data-testid="mcp-browse-tool-chip">
          {tool}
        </Badge>
      ))}
    </div>
  );
}

/** Plain tool names the loading skeleton measures. */
const SAMPLE_TOOL_NAMES: readonly string[] = [
  'search_issues',
  'create_issue',
  'list_projects',
  'add_comment',
];

/** What the installed server's tools show, in a section or a card's row. */
function McpToolsBody({
  installed,
  toolNames,
  toolsLoading,
  toolsError,
  inlineError = false,
  published,
}: {
  /** New Customize: a failure as a line, not a banner; names replay-blocked. */
  inlineError?: boolean;
  published?: PublishedMcpContent;
  installed: boolean;
  toolNames: string[] | null;
  toolsLoading: boolean;
  toolsError: string;
}): JSX.Element {
  if (!installed && published)
    return (
      <div
        className="flex min-w-0 flex-col gap-3"
        data-testid="mcp-published-contents"
      >
        <p className="text-xs fg-secondary">
          Published by {published.publisher}. Workspace permissions determine
          which tools your account can use.
        </p>
        <DataTable
          caption="Published tools and capabilities"
          rows={[...published.tools]}
          rowKey={(tool): string => tool.name}
          columns={[
            {
              key: 'name',
              header: 'Capability',
              overflow: 'wrap',
              render: (tool): JSX.Element => (
                <span className="text-xs font-medium">{tool.name}</span>
              ),
            },
            {
              key: 'description',
              header: 'Description',
              overflow: 'wrap',
              render: (tool): JSX.Element => (
                <span className="text-xs fg-secondary">{tool.description}</span>
              ),
            },
          ]}
        />
        <TextLink
          href={published.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          size="xs"
        >
          Read the publisher’s full documentation
        </TextLink>
      </div>
    );
  if (!installed)
    return (
      <p className="text-xs fg-secondary">
        The publisher hasn’t provided a tool inventory for this server.
      </p>
    );
  if (toolsLoading)
    return (
      <DelayedLoadingPlaceholder slowNote="Still loading tools…">
        <Skeleton
          loading
          label="Loading tools"
          testId="mcp-browse-tools-loading"
        >
          <ToolChips toolNames={SAMPLE_TOOL_NAMES} />
        </Skeleton>
      </DelayedLoadingPlaceholder>
    );
  if (toolsError && inlineError)
    return (
      <DetailFactError error={toolsError} testId="mcp-browse-tools-error" />
    );
  if (toolsError)
    return (
      <ErrorBanner
        errorSource="mcp-browse-tools-error"
        className=""
        error={toolsError}
        testId="mcp-browse-tools-error"
      />
    );
  return (
    <DataTable
      caption="Tools"
      rows={toolNames ?? []}
      rowKey={(tool: string): string => tool}
      emptyLabel="No tools discovered yet"
      columns={[
        {
          key: 'name',
          header: 'Name',
          overflow: 'wrap',
          render: (tool: string): JSX.Element => (
            <span
              data-testid="mcp-browse-tool-chip"
              // A server's tool names can carry private organization names:
              // session replay keeps a placeholder for them.
              className={`font-mono text-xs${inlineError ? ` ${REPLAY_BLOCK_CLASS}` : ''}`}
            >
              {tool}
            </span>
          ),
        },
      ]}
    />
  );
}
