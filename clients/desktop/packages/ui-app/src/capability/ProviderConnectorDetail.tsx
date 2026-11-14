'use client';

import { type ComponentType, type JSX, useState } from 'react';
import type {
  ProviderConnectorListResult,
  ProviderConnectorProvider,
  ProviderConnectorRow,
} from '@canopy/protocol/mcp-servers';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import { McpServerLogo, type McpServerLogoProps } from '@canopy/ui-shared';
import {
  Button,
  PluginConnectionRouteSection,
  RefreshSpinner,
  EmptyStateRow,
  Heading,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  MCP_PROVIDER_CONNECTOR_LABELS,
  MCP_PROVIDER_ROUTES_TITLE,
  mcpProviderAccountPhrase,
  mcpProviderRoutesDescription,
} from './mcpConnectionCopy';
import { buildProviderConnectorRows } from './providerConnectorRows';
import {
  ArrowUpRightIcon,
  CheckIcon as AppCatalogCheckIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { ClaudeLogo, CodexLogo } from '@canopy/ui-shared/icons';
import {
  ComponentSection,
  DetailEntityType,
  DetailFact,
  DetailFactList,
  ExternalTextLink,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
} from '@canopy/ui-shared/components';

const PROVIDER_LABEL: Record<ProviderConnectorProvider, string> =
  MCP_PROVIDER_CONNECTOR_LABELS;

export interface ProviderConnectorOpenSettingsRequest {
  provider: ProviderConnectorProvider;
  installUrl?: string;
}

export interface ProviderConnectorDetailProps {
  /**
   * `page` is the connector's own detail. `section` is the connector folded
   * into an integration card's detail (REG-3033): the host owns the header,
   * and this renders as the "Provider connections" route beside the app's
   * own MCP server.
   */
  variant?: 'page' | 'section';
  displayName: string;
  results: ProviderConnectorListResult[];
  curatedMcpServers: CuratedMcpServerEntry[];
  /** True while a connector read is in flight. */
  loading: boolean;
  onConnected: () => void;
  /** Product name shown in the credentials explanation. */
  appName: string;
  /** Host-owned navigation to the provider's connector settings. */
  onOpenProviderSettings: (
    request: ProviderConnectorOpenSettingsRequest,
  ) => Promise<void>;
  /**
   * Host logo adapter. The browser-safe default renders only a bundled mark;
   * a host that can resolve remote catalog artwork injects its own, so a
   * connector without a bundled mark shows the same logo its card does.
   */
  McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
}

/**
 * Connect a capability through an agent provider's own account.
 *
 * Canopy holds none of these credentials, which is the point: Gmail and Drive
 * are Google *restricted* scopes and Slack gates distribution on marketplace
 * review, so a first-party integration would mean carrying those approvals.
 * The provider already carries them, so the user links it there and the tools
 * appear in any Canopy chat on that provider.
 */
export function ProviderConnectorDetail({
  variant = 'page',
  displayName,
  results,
  curatedMcpServers,
  loading,
  onConnected,
  appName,
  onOpenProviderSettings,
  McpServerLogoComponent = McpServerLogo,
}: ProviderConnectorDetailProps): JSX.Element {
  const [busy, setBusy] = useState<ProviderConnectorProvider | null>(null);
  const row = buildProviderConnectorRows(results, curatedMcpServers).find(
    (candidate) => candidate.displayName === displayName,
  );
  const providers = row?.providers ?? [];
  // A connector the catalog offers through one provider is described as that
  // provider's alone, never as "Claude or Codex".
  const providerLabels = providers.map(
    (entry) => PROVIDER_LABEL[entry.provider],
  );
  // Resolved by key where there is one, exactly as the list entry resolves it;
  // two catalog entries can share a display name.
  const catalogEntry = curatedMcpServers.find((entry) =>
    row?.curatedKey ? entry.key === row.curatedKey : entry.name === displayName,
  );

  const handleConnect = async (
    provider: ProviderConnectorProvider,
    installUrl?: string,
  ): Promise<void> => {
    setBusy(provider);
    try {
      await onOpenProviderSettings({
        provider,
        ...(installUrl ? { installUrl } : {}),
      });
    } finally {
      setBusy(null);
      // The link completes in a browser, so the read this triggers is usually
      // still stale; the focus re-read and the Refresh below are what catch it.
      onConnected();
    }
  };

  const providerRows =
    providers.length === 0 ? (
      <EmptyStateRow title="No provider offers this connector yet" />
    ) : (
      <ComponentSection title="Works with">
        <DataTableFrame caption="Works with" layout="fixed">
          <DataTableHead>
            <DataTableHeaderCell width="50%">Harness</DataTableHeaderCell>
            <DataTableHeaderCell align="right">Status</DataTableHeaderCell>
          </DataTableHead>
          <DataTableBody>
            {providers.map((entry) => (
              <ProviderRow
                key={entry.provider}
                entry={entry}
                busy={busy !== null}
                onConnect={handleConnect}
              />
            ))}
          </DataTableBody>
        </DataTableFrame>
      </ComponentSection>
    );

  // Trails the list: the user reads what to do, acts on it, and only then
  // needs a way to re-check. Leading with the control put the button before
  // the sentence explaining why it exists. Inside a route the section divider
  // already ends the group, so only the standalone page draws its own.
  const recheck = (
    <div
      className={
        variant === 'section'
          ? 'flex items-center justify-end gap-3'
          : 'mt-4 flex items-center justify-end gap-3 border-t pt-3'
      }
    >
      <span className="text-xs fg-secondary">
        {loading
          ? 'Checking with your providers…'
          : 'Just linked one? Re-check to pick it up.'}
      </span>
      <Button
        type="button"
        size="compact"
        data-testid="provider-connector-detail-refresh"
        disabled={loading}
        onClick={onConnected}
      >
        <RefreshSpinner spinning={loading} />
        {loading ? 'Checking…' : 'Re-check'}
      </Button>
    </div>
  );

  if (variant === 'section') {
    // The host detail already shows the mark, name, and vendor; a second
    // header made the page read as two pages. The section says how this
    // route differs from the app's own MCP server instead.
    return (
      <PluginConnectionRouteSection
        title={MCP_PROVIDER_ROUTES_TITLE}
        description={mcpProviderRoutesDescription(appName, providerLabels)}
        dataTestId="provider-connector-detail"
      >
        {providerRows}
        {recheck}
      </PluginConnectionRouteSection>
    );
  }

  return (
    // No top padding: the shell's Back row owns the gap above. Keeping `p-4`
    // here stacked on top of it and pushed this panel 40px down.
    <div className="px-4 pb-4" data-testid="provider-connector-detail">
      {/* A connector stands in for the catalog entry it replaces, so it is
          identified the same way that entry and every other capability detail
          is. Without this the panel opened on a bare text title, dropping the
          mark and vendor the card beside it had already resolved. */}
      <div
        className="mb-4 flex items-start gap-3"
        data-testid="provider-connector-detail-header"
      >
        <McpServerLogoComponent
          curatedKey={row?.curatedKey}
          logoUrl={catalogEntry?.logoUrl}
          name={displayName}
          size={40}
          fallback="monogram"
          fit="contain"
          imgTestId="provider-connector-detail-logo"
          fallbackTestId="provider-connector-detail-logo-fallback"
        />
        <div className="min-w-0 flex-1">
          <Heading level={3} variant="section">
            <span className="inline-flex flex-wrap items-baseline gap-x-2">
              {displayName}
              <DetailEntityType />
            </span>
          </Heading>
          {catalogEntry?.authorName && (
            <p className="mt-0.5 text-xs fg-secondary">
              By {catalogEntry.authorName}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {(catalogEntry?.longDescription || catalogEntry?.shortDescription) && (
          <p className="max-w-2xl text-s leading-relaxed fg-secondary">
            {catalogEntry.longDescription || catalogEntry.shortDescription}
          </p>
        )}
        <p className="text-s leading-relaxed fg-secondary">
          Connect {displayName} with {mcpProviderAccountPhrase(providerLabels)}.{' '}
          {appName} never sees these credentials, and the tools become available
          in any chat on that provider.
        </p>
      </div>

      {(catalogEntry?.authorUrl || catalogEntry?.docsUrl) && (
        <DetailFactList placement="mt-4">
          {catalogEntry.authorUrl && (
            <DetailFact label="Website">
              <ExternalTextLink
                href={catalogEntry.authorUrl}
                label={catalogEntry.authorUrl
                  .replace(/^https?:\/\/(www\.)?/, '')
                  .replace(/\/$/, '')}
              />
            </DetailFact>
          )}
          {catalogEntry.docsUrl && (
            <DetailFact label="Docs">
              <ExternalTextLink href={catalogEntry.docsUrl} label="Open docs" />
            </DetailFact>
          )}
        </DetailFactList>
      )}

      <div className="mt-6">{providerRows}</div>
      {recheck}
    </div>
  );
}

function ProviderRow({
  entry,
  busy,
  onConnect,
}: {
  entry: ProviderConnectorRow['providers'][number];
  busy: boolean;
  onConnect: (
    provider: ProviderConnectorProvider,
    installUrl?: string,
  ) => Promise<void>;
}): JSX.Element {
  const label = PROVIDER_LABEL[entry.provider];
  const Logo = entry.provider === 'claude' ? ClaudeLogo : CodexLogo;
  const testId = `provider-connector-detail-connect-${entry.provider}`;

  return (
    <DataTableRow>
      <DataTableCell tone="primary" rowHeader>
        <span className="inline-flex items-center gap-2">
          <Logo
            width={14}
            height={14}
            aria-hidden="true"
            className="shrink-0 fg-secondary"
          />
          {label}
        </span>
      </DataTableCell>
      <DataTableCell align="right" overflow="wrap">
        <span className="inline-flex items-center justify-end gap-2">
          {entry.unavailable ? (
            // A provider Canopy could not read cannot honestly be offered as a
            // route — clicking through would send the user to link something that
            // still would not appear. The reason is on the tooltip.
            <Tooltip label={entry.unavailable} clamp={false} replayBlock>
              <span
                data-testid={`${testId.replace('-connect-', '-unavailable-')}`}
                className="text-xs fg-secondary"
              >
                Unavailable
              </span>
            </Tooltip>
          ) : entry.alternateRoute ? (
            // Already served by another route — a plugin-provided server, say. A
            // bare Connect here tells a user whose Slack works that they need to
            // connect Slack: true about the connector, wrong about the capability.
            <span className="flex items-center gap-2">
              <Tooltip
                label={`Served by ${entry.alternateRoute}`}
                clamp={false}
              >
                <span
                  data-testid={`provider-connector-detail-alternate-${entry.provider}`}
                  className="inline-flex items-center gap-1.5 text-xs fg-success"
                >
                  <AppCatalogCheckIcon size="sm" aria-hidden="true" />
                  Already available
                </span>
              </Tooltip>
              <Button
                type="button"
                variant="ghost"
                size="compact"
                data-testid={testId}
                disabled={busy}
                onClick={() => void onConnect(entry.provider, entry.installUrl)}
              >
                Connect anyway
              </Button>
            </span>
          ) : entry.pending ? (
            // The read has not answered. Rendering a Connect button here would
            // invite the user to link something that may already be linked.
            <span
              data-testid={`provider-connector-detail-pending-${entry.provider}`}
              className="text-xs fg-secondary"
            >
              Checking…
            </span>
          ) : entry.connected ? (
            <span className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs fg-success">
                <AppCatalogCheckIcon size="sm" aria-hidden="true" />
                Connected
              </span>
              <Button
                type="button"
                variant="ghost"
                size="compact"
                data-testid={testId}
                disabled={busy}
                onClick={() => void onConnect(entry.provider, entry.installUrl)}
              >
                <span className="inline-flex items-center gap-1">
                  Manage
                  <ArrowUpRightIcon size="xs" aria-hidden="true" />
                </span>
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              {entry.staleSince ? (
                // Codex reports from a cache only Codex writes, and nothing Canopy
                // can invoke refreshes it. Saying "not connected" would be a claim
                // Canopy cannot support — and reads as broken to someone who just
                // linked it.
                <Tooltip
                  clamp={false}
                  label={`${label} last refreshed its app list on ${new Date(
                    entry.staleSince,
                  ).toLocaleString()}. A link made since then shows up after ${label} next refreshes.`}
                >
                  <span
                    data-testid={`provider-connector-detail-stale-${entry.provider}`}
                    className="text-xs fg-secondary"
                  >
                    Status may be out of date
                  </span>
                </Tooltip>
              ) : null}
              <Button
                type="button"
                size="compact"
                data-testid={testId}
                disabled={busy}
                onClick={() => void onConnect(entry.provider, entry.installUrl)}
              >
                Connect with {label}
              </Button>
            </span>
          )}
        </span>
      </DataTableCell>
    </DataTableRow>
  );
}
