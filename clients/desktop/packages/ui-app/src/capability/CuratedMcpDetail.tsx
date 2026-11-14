'use client';
import { DetailEntityType } from '@canopy/ui-shared/components';

import type { JSX, ReactNode } from 'react';
import {
  curatedMcpProviderOnly,
  type CuratedMcpConnectorProvider,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import {
  Badge,
  ComponentSection,
  DataTable,
  ErrorBanner,
  Button,
  ExternalTextLink,
  DelayedLoadingPlaceholder,
  McpServerLogo,
  Notice,
  PluginConfigurationButton,
  PluginConnectionRouteSection,
  Heading,
  Skeleton,
} from '@canopy/ui-shared/components';
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
  routes,
  statusContent,
  renderManagement,
  flush = false,
}: CuratedMcpDetailProps<T>): JSX.Element {
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
                <ExternalTextLink
                  href={entry.authorUrl}
                  label={entry.authorName}
                />
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
            <ExternalTextLink key={link.label} {...link} />
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
              <div className="flex flex-col gap-1">
                {management}
                {connectionContent}
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
            {!providerOnly && management}
            {!providerOnly && connectionContent}
          </div>
          {!providerOnly && tools}
        </>
      )}
    </div>
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
}: {
  installed: boolean;
  toolNames: string[] | null;
  toolsLoading: boolean;
  toolsError: string;
}): JSX.Element {
  if (!installed)
    return (
      <p className="text-xs fg-secondary">
        Tools appear after you add this server.
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
              className="font-mono text-xs"
            >
              {tool}
            </span>
          ),
        },
      ]}
    />
  );
}
