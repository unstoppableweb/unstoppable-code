'use client';

import { ControlButton } from '@canopy/ui-shared/components';
import { type JSX, type ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  mcpAuthConnectLabel,
  mcpAuthStatusBadgeClass,
  mcpRequirementUnknown,
  mcpRowSecondaryText,
  mcpRowSecondaryTextNamesAccount,
  mcpSignInStatusLabel,
  type McpCardAuthStatus,
  type McpCardDisplayServer,
} from '@canopy/ui-shared/lib';
import {
  Tooltip,
  Button,
  DelayedLoadingPlaceholder,
  EmptyStateText,
  MCP_SIGN_IN_WAITING_LABEL,
  McpServerCardRow,
  McpRowSettings,
  type McpRowDestination,
  McpSignInPendingActions,
  McpSignInPendingStatus,
  useActivityItemDensity,
  Skeleton,
  StatusLabel,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

export interface McpServersSectionItem extends McpCardDisplayServer {
  readonly key: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly authStatus: McpCardAuthStatus;
  readonly canRefresh?: boolean;
  readonly authStatusLabel: string;
  readonly canConnect: boolean;
  /** Keep the Connect action visible but inert, e.g. while a token is missing. */
  readonly connectDisabled?: boolean;
  /**
   * This row's own connection attempt is in flight. Hosts that can connect
   * several rows at once set it per row; `connectingKey` still marks a single
   * row for hosts that connect one at a time.
   */
  readonly connecting?: boolean;
  readonly waitingForSignIn?: boolean;
  readonly canCancelSignIn?: boolean;
  /** This row's own disconnect is in flight; `disconnectingKey` still marks a single row. */
  readonly disconnecting?: boolean;
  readonly connectLabel?: string;
  /**
   * Replaces the row's Sign in or Reconnect label, e.g. **Enable** for an
   * account server that needs no sign-in (web). It never adds an action to
   * a row that has none.
   */
  readonly connectActionLabel?: string;
  readonly canDisconnect?: boolean;
  readonly lastError?: string;
  readonly canToggleCanopyProxy?: boolean;
  readonly canopyProxyEnabled?: boolean;
  /**
   * The sign-in page of a sign-in that waits in another tab. The row reads
   * **Waiting…** and offers **Reopen** and a cancel control in place of its
   * Sign in or Reconnect.
   */
  readonly signInUrl?: string;
}

export interface McpServersSectionBodyProps {
  readonly servers: readonly McpServersSectionItem[];
  readonly warnings: readonly string[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly connectingKey: string | null;
  readonly disconnectingKey?: string | null;
  readonly proxyUpdatingKey?: string | null;
  readonly showProxyToggle?: boolean;
  readonly brandAppName: string;
  readonly proxyLogo: ReactNode;
  readonly onConnect?: (server: McpServersSectionItem) => void;
  readonly onDisconnect?: (server: McpServersSectionItem) => void;
  /** Stops waiting on a row's {@link McpServersSectionItem.signInUrl}. */
  readonly onCancelSignIn?: (server: McpServersSectionItem) => void;
  /** Host-owned content rendered under a row (token prompts, inline errors). */
  readonly renderRowExtra?: (server: McpServersSectionItem) => ReactNode;
  /** Opt into the row-owned 6px footer gap; the callback then supplies no outer margin. */
  readonly rowExtraLayout?: 'footer';
  readonly onSetCanopyProxyEnabled?: (
    server: McpServersSectionItem,
    enabled: boolean,
  ) => void;
  readonly onOpenDetails?: (server: McpServersSectionItem) => void;
  readonly getRowNavigation?: (
    server: McpServersSectionItem,
  ) => McpRowDestination | undefined;
  readonly getRowSettings?: (
    server: McpServersSectionItem,
  ) => McpRowDestination | undefined;
  readonly emptyLabel?: string;
}

/** Plain servers the loading skeleton measures. */
const SAMPLE_SERVERS: readonly McpServersSectionItem[] = [
  {
    key: 'mcp-sample-1',
    displayName: 'Issue tracker',
    source: 'standalone',
    configName: 'Default',
    enabled: true,
    authStatus: 'connected',
    authStatusLabel: 'Connected',
    canConnect: false,
  },
  {
    key: 'mcp-sample-2',
    displayName: 'Docs search',
    source: 'standalone',
    configName: 'Default',
    enabled: true,
    authStatus: 'connected',
    authStatusLabel: 'Connected',
    canConnect: false,
  },
];

export function McpServersSectionBody({
  servers,
  warnings,
  loading,
  error,
  connectingKey,
  disconnectingKey = null,
  proxyUpdatingKey = null,
  showProxyToggle = true,
  brandAppName,
  proxyLogo,
  onConnect,
  onDisconnect,
  onCancelSignIn,
  renderRowExtra,
  rowExtraLayout,
  onSetCanopyProxyEnabled,
  onOpenDetails,
  emptyLabel,
  getRowNavigation,
  getRowSettings,
}: McpServersSectionBodyProps): JSX.Element | null {
  const compact = useActivityItemDensity() === 'compact';
  const body =
    loading && servers.length === 0 ? (
      <DelayedLoadingPlaceholder slowNote="Still checking MCP servers…">
        <Skeleton
          loading
          label="Checking MCP servers"
          testId="mcp-servers-card-loading"
        >
          <McpServersSectionBody
            servers={SAMPLE_SERVERS}
            warnings={[]}
            loading={false}
            error={null}
            connectingKey={null}
            showProxyToggle={false}
            brandAppName={brandAppName}
            proxyLogo={null}
          />
        </Skeleton>
      </DelayedLoadingPlaceholder>
    ) : error !== null ? (
      <ErrorBanner
        errorSource="mcp-servers-card-error-section-body"
        className=""
        error={error}
        testId="mcp-servers-card-error"
      />
    ) : servers.length === 0 ? (
      emptyLabel === undefined ? null : (
        <p className="text-xs" data-testid="mcp-servers-card-empty">
          <EmptyStateText title={emptyLabel} tone="secondary" />
        </p>
      )
    ) : (
      <BoxUnlessCompact compact={compact}>
        <ul
          className={compact ? 'flex flex-col' : 'divide-y'}
          data-testid="mcp-servers-card-list"
        >
          {servers.map((server) => {
            // A shared connection is managed in its project's settings, not
            // on this computer, so its row opens nothing here. It has no
            // action either, so even a compact row keeps its source and state.
            const shared = server.source === 'shared';
            const compactRow = compact && !shared;
            const authConnectLabel = mcpAuthConnectLabel(
              server.authStatus,
              server.canRefresh,
            );
            const requirementUnknown = mcpRequirementUnknown(server);
            const connectLabel =
              authConnectLabel !== undefined
                ? (server.connectActionLabel ??
                  (server.authStatus === 'error'
                    ? authConnectLabel
                    : 'Sign in'))
                : requirementUnknown
                  ? (server.connectLabel ?? 'Connect')
                  : undefined;
            const isConnecting =
              server.connecting === true || connectingKey === server.key;
            const isDisconnecting =
              server.disconnecting === true || disconnectingKey === server.key;
            const buttonDisabled =
              !server.canConnect ||
              isDisconnecting ||
              server.connectDisabled === true;
            const showToggle =
              showProxyToggle &&
              server.canToggleCanopyProxy === true &&
              onSetCanopyProxyEnabled !== undefined;
            const signInUrl = server.signInUrl;
            const proxyActive = server.canopyProxyEnabled === true;
            const proxyUpdating = proxyUpdatingKey === server.key;
            // In the card, a status earns space only when it needs the user.
            const compactStatusInk =
              server.authStatus === 'error'
                ? 'fg-destructive'
                : server.authStatus === 'not_connected' ||
                    (server.authStatus === 'expired' && !server.canRefresh)
                  ? 'fg-warning'
                  : null;
            const toggleHeading = proxyActive
              ? `${brandAppName} proxy: on`
              : `${brandAppName} proxy: off`;
            const toggleAction = proxyActive
              ? 'Turn it off to use agent provider auth.'
              : `Turn it on to route this server through the ${brandAppName} proxy.`;
            return (
              <McpServerCardRow
                key={server.key}
                name={server.displayName}
                maskName={shared}
                footer={
                  rowExtraLayout === 'footer'
                    ? renderRowExtra?.(server)
                    : undefined
                }
                enabled={server.enabled}
                compact={compact}
                destination={
                  shared
                    ? undefined
                    : (getRowNavigation?.(server) ??
                      (onOpenDetails === undefined
                        ? undefined
                        : {
                            kind: 'button',
                            onActivate: (): void => onOpenDetails(server),
                          }))
                }
                status={
                  <>
                    {compactRow &&
                    signInUrl === undefined &&
                    !server.waitingForSignIn ? (
                      compactStatusInk === null ? null : (
                        <span
                          role="status"
                          className={`max-w-full break-words ${compactStatusInk}`}
                          data-testid="mcp-servers-card-badge"
                        >
                          {server.authStatus === 'connected'
                            ? server.authStatusLabel
                            : mcpSignInStatusLabel(server)}
                        </span>
                      )
                    ) : signInUrl === undefined && !server.waitingForSignIn ? (
                      <span
                        role="status"
                        className={`max-w-full ${mcpAuthStatusBadgeClass(server.authStatus, server.canRefresh)}`}
                        data-testid="mcp-servers-card-badge"
                      >
                        <span
                          className="min-w-0 truncate"
                          title={
                            server.authStatus === 'connected'
                              ? server.authStatusLabel
                              : mcpSignInStatusLabel(server)
                          }
                        >
                          {server.authStatus === 'connected'
                            ? server.authStatusLabel
                            : mcpSignInStatusLabel(server)}
                        </span>
                      </span>
                    ) : (
                      <McpSignInPendingStatus
                        serviceName={server.displayName}
                        variant="pill"
                        dataTestId="mcp-servers-card-badge"
                      />
                    )}
                  </>
                }
                actions={
                  <>
                    {showToggle && (
                      <ProxyToggle
                        active={proxyActive}
                        updating={proxyUpdating}
                        ariaLabel={`Use ${brandAppName} proxy for ${server.displayName}`}
                        bordered={!compact}
                        heading={toggleHeading}
                        action={toggleAction}
                        logo={proxyLogo}
                        onToggle={(): void =>
                          onSetCanopyProxyEnabled(server, !proxyActive)
                        }
                      />
                    )}
                    {signInUrl !== undefined && (
                      <McpSignInPendingActions
                        serviceName={server.displayName}
                        variant="compact"
                        authorizationUrl={signInUrl}
                        onCancel={
                          onCancelSignIn === undefined
                            ? undefined
                            : (): void => onCancelSignIn(server)
                        }
                        dataTestId="mcp-servers-card-sign-in"
                      />
                    )}
                    {signInUrl === undefined &&
                      server.canCancelSignIn === true &&
                      isConnecting &&
                      onCancelSignIn !== undefined && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="compact"
                          aria-label={`Cancel ${server.displayName} sign-in`}
                          data-testid="mcp-servers-card-sign-in-cancel"
                          onClick={(): void => onCancelSignIn(server)}
                        >
                          Cancel
                        </Button>
                      )}
                    {signInUrl === undefined &&
                      server.canConnect &&
                      connectLabel &&
                      onConnect !== undefined && (
                        <Button
                          type="button"
                          variant="primary"
                          size="compact"
                          onClick={(): void => onConnect(server)}
                          disabled={buttonDisabled}
                          loading={isConnecting}
                          loadingLabel={
                            requirementUnknown
                              ? 'Connecting…'
                              : 'Opening sign-in…'
                          }
                          // A static name would hide the busy label from screen readers.
                          aria-label={
                            connectLabel === 'Sign in' &&
                            !isConnecting &&
                            server.waitingForSignIn !== true
                              ? `Sign in to ${server.displayName}`
                              : undefined
                          }
                          data-testid="mcp-servers-card-connect"
                        >
                          {server.waitingForSignIn
                            ? MCP_SIGN_IN_WAITING_LABEL
                            : connectLabel}
                        </Button>
                      )}
                    {server.canDisconnect === true &&
                      onDisconnect !== undefined && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="compact"
                          onClick={(): void => onDisconnect(server)}
                          loading={isDisconnecting}
                          loadingLabel="Disconnecting…"
                          disabled={isConnecting}
                          data-testid="mcp-servers-card-disconnect"
                        >
                          Disconnect
                        </Button>
                      )}
                  </>
                }
              >
                {compactRow ? null : <McpRowSecondaryLine server={server} />}
                {server.authStatus === 'error' && server.lastError && (
                  <p className="pt-1">
                    <StatusLabel size="2xs">{server.lastError}</StatusLabel>
                  </p>
                )}
                <McpRowSettings
                  destination={shared ? undefined : getRowSettings?.(server)}
                  name={server.displayName}
                />
                {rowExtraLayout === 'footer' ? null : renderRowExtra?.(server)}
              </McpServerCardRow>
            );
          })}
        </ul>
      </BoxUnlessCompact>
    );

  if (body === null && warnings.length === 0) {
    return null;
  }

  return (
    <>
      {body}
      {warnings.length > 0 && (
        <p
          className={`text-2xs fg-warning${body === null ? '' : ' pt-2'}`}
          data-testid="mcp-servers-card-warnings"
        >
          Some MCP servers could not be loaded.
        </p>
      )}
    </>
  );
}

/** The row's "source · context" line under its name. */
function McpRowSecondaryLine({
  server,
}: {
  readonly server: McpServersSectionItem;
}): JSX.Element {
  const text = mcpRowSecondaryText(server);
  if (!mcpRowSecondaryTextNamesAccount(server)) {
    return (
      <p className="truncate text-2xs fg-secondary" title={text}>
        {text}
      </p>
    );
  }
  // A name the person gave the account or configuration, often an email.
  return (
    <p className="truncate text-2xs fg-secondary">
      <span className={REPLAY_BLOCK_CLASS} title={text}>
        {text}
      </span>
    </p>
  );
}

interface ProxyToggleProps {
  readonly active: boolean;
  readonly updating: boolean;
  readonly ariaLabel: string;
  /** Draws the outline; the card's compact rows go without. */
  readonly bordered: boolean;
  readonly heading: string;
  readonly action: string;
  readonly logo: ReactNode;
  readonly onToggle: () => void;
}

function ProxyToggle({
  active,
  updating,
  ariaLabel,
  bordered,
  heading,
  action,
  logo,
  onToggle,
}: ProxyToggleProps): JSX.Element {
  return (
    <Tooltip label={heading} description={action}>
      <ControlButton
        onClick={onToggle}
        disabled={updating}
        aria-label={ariaLabel}
        aria-pressed={active}
        data-testid="mcp-servers-card-proxy-toggle"
        presentation={
          bordered
            ? active
              ? 'proxy-toggle-panel-on'
              : 'proxy-toggle-panel-off'
            : active
              ? 'proxy-toggle-card-on'
              : 'proxy-toggle-card-off'
        }
      >
        {logo}
      </ControlButton>
    </Tooltip>
  );
}

/** The grouped box a row sits in, except in the compact list, which has none. */
function BoxUnlessCompact({
  compact,
  children,
}: {
  readonly compact: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return compact ? (
    <>{children}</>
  ) : (
    <Surface variant="group" size="small" className="overflow-hidden">
      {children}
    </Surface>
  );
}
