import { badgeClassName, type BadgeTone } from './badge';

export type McpCardAuthStatus =
  | 'unsupported'
  | 'not_configured'
  | 'not_connected'
  | 'connected'
  | 'expired'
  | 'error';

export type McpCardConnectionStatus =
  | 'connected'
  | 'auth_required'
  | 'unreachable'
  | 'unknown';

export interface McpCardDisplayServer {
  readonly source:
    | 'standalone'
    | 'collection'
    | 'bundle'
    | 'plugin'
    | 'account';
  readonly configName?: string;
  readonly collectionId?: string;
  readonly bundleId?: string;
  readonly pluginName?: string;
  /**
   * The plugin that brought an account server into the chat, when it was
   * not selected directly (web, REG-3030).
   */
  readonly viaPluginName?: string;
}

/**
 * Maps an MCP auth status to its visible badge label.
 *
 * Server-side responses can include detailed auth labels, but the compact
 * panel badge uses the plan-defined labels for each coarse status.
 */
export function mcpAuthStatusLabel(
  status: McpCardAuthStatus,
  canRefresh = false,
): string {
  if (status === 'expired' && canRefresh) return 'Renews automatically';
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'not_connected':
      return 'Needs auth';
    case 'expired':
      return 'Expired';
    case 'error':
      return 'Error';
    case 'not_configured':
      return 'No auth';
    case 'unsupported':
      return 'Unsupported';
  }
}

/** Only surface interactive authorization when silent renewal cannot help. */
export function mcpAuthConnectLabel(
  status: McpCardAuthStatus,
  canRefresh = false,
): 'Connect' | 'Reconnect' | undefined {
  if (status === 'not_connected') return 'Connect';
  if (status === 'error' || (status === 'expired' && !canRefresh))
    return 'Reconnect';
  return undefined;
}

/** Unknown auth requirement, rather than missing credentials or connection health. */
export function mcpRequirementUnknown(server: {
  readonly authStatus: McpCardAuthStatus;
  readonly canConnect: boolean;
}): boolean {
  return server.authStatus === 'not_configured' && server.canConnect === true;
}

/**
 * The size and shape every action on a server row shares (Sign in,
 * Disconnect, Reopen), so the actions read as one set whatever the row's
 * state. Callers add the surface and ink.
 */
export const MCP_ROW_ACTION_CLASS_NAME =
  "focus-ring relative inline-flex items-center rounded-md px-2 py-1 text-2xs font-medium transition-colors disabled:opacity-60 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:content-['']";

/**
 * The shared badge tone for an auth status. An expired sign-in that refreshes
 * on its own is neutral; one that needs the person is warning.
 */
export function mcpAuthStatusBadgeTone(
  status: McpCardAuthStatus,
  canRefresh = false,
): BadgeTone {
  if (status === 'expired' && canRefresh) return 'neutral';
  switch (status) {
    case 'connected':
      return 'success';
    case 'not_connected':
    case 'expired':
      return 'warning';
    case 'error':
      return 'danger';
    case 'not_configured':
    case 'unsupported':
      return 'neutral';
  }
}

/** Full shared-badge class string for the auth-status badge. */
export function mcpAuthStatusBadgeClass(
  status: McpCardAuthStatus,
  canRefresh = false,
): string {
  return badgeClassName(mcpAuthStatusBadgeTone(status, canRefresh));
}

/**
 * Maps an MCP connection status to its visible badge label.
 *
 * This is a DISTINCT axis from {@link mcpAuthStatusLabel} — it reflects
 * reachability combined with auth, not OAuth-token state alone. Kept separate
 * (not overloaded onto the auth helpers) so the Status column in the MCP
 * Servers tab and the auth-only badge never drift.
 */
export function mcpConnectionStatusLabel(
  status: McpCardConnectionStatus,
): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'auth_required':
      return 'Auth required';
    case 'unreachable':
      return 'Unreachable';
    case 'unknown':
      return 'Not checked';
  }
}

/** The shared badge tone for a connection status. */
export function mcpConnectionStatusBadgeTone(
  status: McpCardConnectionStatus,
): BadgeTone {
  switch (status) {
    case 'connected':
      return 'success';
    case 'auth_required':
      return 'warning';
    case 'unreachable':
      return 'danger';
    case 'unknown':
      return 'neutral';
  }
}

/** Full shared-badge class string for the connection-status badge. */
export function mcpConnectionStatusBadgeClass(
  status: McpCardConnectionStatus,
): string {
  return badgeClassName(mcpConnectionStatusBadgeTone(status));
}

/** Builds the secondary "source · context" line for a row. */
export function mcpRowSecondaryText(server: McpCardDisplayServer): string {
  switch (server.source) {
    case 'standalone':
      return `Standalone · ${server.configName ?? ''}`;
    case 'collection':
      return `Collection · ${server.collectionId ?? server.bundleId ?? ''}`;
    case 'bundle':
      return `Collection · ${server.bundleId ?? ''}`;
    case 'plugin':
      return `Plugin · ${server.pluginName ?? ''}`;
    case 'account':
      if (server.viaPluginName)
        return `From the ${server.viaPluginName} plugin`;
      return server.configName
        ? `Account connection · ${server.configName}`
        : 'Account connection';
  }
}

interface PanelCardSubtitleArgs {
  loading: boolean;
  serverCount: number;
}

/**
 * Computes the panel-card subtitle that appears under the "MCP Servers"
 * heading. Empty/loading/non-empty are differentiated so the subtitle stays
 * readable while data is in flight.
 */
export function mcpPanelCardSubtitle({
  loading,
  serverCount,
}: PanelCardSubtitleArgs): string {
  if (loading) return 'Checking servers';
  if (serverCount === 0) return 'No servers';
  return `${serverCount} server${serverCount === 1 ? '' : 's'}`;
}

/** Minimal cached status shape shared by desktop status entries and the Portal projection. */
export interface McpConnectionStatusSource {
  readonly connectionStatus: string;
  readonly reachability: string;
  readonly handler?: string;
  readonly lastCheckedAt?: string;
  readonly configs?: ReadonlyArray<{ readonly authStatus: string }>;
}

export interface McpConnectionBadge {
  readonly status: McpCardConnectionStatus;
  /** The provider, not Canopy, manages this connection. */
  readonly isProvider: boolean;
}

function knownConnectionStatus(value: string): McpCardConnectionStatus {
  return value === 'connected' ||
    value === 'auth_required' ||
    value === 'unreachable'
    ? value
    : 'unknown';
}

/**
 * One derivation for the legacy table, Installed entries and the detail
 * health section. A provider-managed server reports reachability only.
 * Unknown values degrade to Not checked rather than implying health.
 */
export function deriveMcpConnectionBadge(
  entry: McpConnectionStatusSource | undefined,
): McpConnectionBadge {
  if (!entry) return { status: 'unknown', isProvider: false };
  if (entry.handler === 'provider') {
    return {
      status:
        entry.reachability === 'reachable'
          ? 'connected'
          : entry.reachability === 'unreachable'
            ? 'unreachable'
            : 'unknown',
      isProvider: true,
    };
  }
  // Account inventory synthesizes auth_required even while a connection is
  // pending or disconnected. Without a recorded probe, use its auth mapping
  // rather than presenting that inventory marker as cached connection health.
  if (
    entry.handler === 'account' &&
    entry.lastCheckedAt === undefined &&
    entry.reachability === 'unknown' &&
    entry.configs &&
    entry.configs.length > 0
  ) {
    return {
      status: entry.configs.some(
        (config) =>
          config.authStatus === 'error' || config.authStatus === 'expired',
      )
        ? 'auth_required'
        : entry.configs.every((config) => config.authStatus === 'connected')
          ? 'connected'
          : 'unknown',
      isProvider: false,
    };
  }
  return {
    status: knownConnectionStatus(entry.connectionStatus),
    isProvider: false,
  };
}

/**
 * Cached status for the exact server wins; an account-only row without one
 * falls back to its cloud connection state; anything else is Not checked.
 * Missing status is never proof of a healthy connection.
 */
export function resolveMcpConnectionBadge(
  status: McpConnectionStatusSource | undefined,
  accountConnectionStatus?: string,
): McpConnectionBadge {
  if (status) return deriveMcpConnectionBadge(status);
  switch (accountConnectionStatus) {
    case 'CONNECTED':
      return { status: 'connected', isProvider: false };
    case 'REAUTH_REQUIRED':
      return { status: 'auth_required', isProvider: false };
    default:
      return { status: 'unknown', isProvider: false };
  }
}

/** Where an MCP server runs, as the detail page names it. */
export type McpServerPlacement = 'device' | 'cloud' | 'provider';

export function mcpPlacementLabel(placement: McpServerPlacement): string {
  switch (placement) {
    case 'device':
      return 'This device';
    case 'cloud':
      return 'Cloud account';
    case 'provider':
      return 'Agent provider';
  }
}

/** Impact copy retained by the legacy editor and shared detail confirmation. */
export function mcpDeleteImpact(
  scope: 'cloud' | 'device-and-cloud' | 'device-retaining-cloud',
): string {
  switch (scope) {
    case 'device-and-cloud':
      return 'Deletes it from your cloud account and this device. Cloud chats and your other desktops lose it.';
    case 'cloud':
      return 'Deletes it from your cloud account. Cloud chats and every signed-in desktop lose it.';
    case 'device-retaining-cloud':
      return 'Deletes the copy on this device. It stays in your cloud account.';
  }
}

/** Names what a confirmed deletion removes, so the dialog states its scope. */
export function mcpDeleteScopeDescription(
  serverName: string,
  placement: McpServerPlacement | 'device-and-cloud' | 'device-retaining-cloud',
): string {
  switch (placement) {
    case 'device-retaining-cloud':
      return `${serverName}: ${mcpDeleteImpact('device-retaining-cloud')}`;
    case 'device-and-cloud':
      return `${serverName}: ${mcpDeleteImpact('device-and-cloud')}`;
    case 'device':
      return `This deletes ${serverName} and its configurations from this device. Chats that use it lose access.`;
    case 'cloud':
      return `${serverName}: ${mcpDeleteImpact('cloud')}`;
    case 'provider':
      return `${serverName} is managed by the agent provider and is removed there.`;
  }
}

/** Shared generic unavailable reasons; hosts choose the applicable gate. */
export const MCP_MANAGEMENT_REASONS = {
  disconnected: 'Reconnect your desktop to manage this server.',
  noMutations: 'This session cannot change MCP servers.',
  olderDesktop: 'Update the desktop app to manage MCP servers here.',
  desktopOnly: 'Available in the desktop app.',
  noTarget: 'This server can only be tested from the desktop app.',
  provider: 'This connection is managed by the agent provider.',
  cloudTest: 'This cloud connection cannot be tested from this device.',
} as const;
