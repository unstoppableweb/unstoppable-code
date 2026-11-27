import type { CuratedMcpConnectorProvider } from '@canopy/protocol/mcp-catalog';

/**
 * Where an MCP server's sign-in lives (REG-3052). Statuses name the service
 * and its scope, so they never read like the app's own sign-in.
 */
export type McpConnectionCopyState =
  | 'account-connected'
  | 'account-reauth'
  | 'account-not-connected'
  /** Signed in on this desktop; the account could hold it as well. */
  | 'device-connected-only'
  /** Signed in on this desktop, which is the only place it connects. */
  | 'device-connected'
  | 'device-not-connected';

const UNNAMED_SERVER = 'This server';

function serviceName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : UNNAMED_SERVER;
}

/** The status line for one MCP server connection. */
export function mcpConnectionStatusLabel(
  name: string,
  state: McpConnectionCopyState,
  added?: boolean,
): string {
  const service = serviceName(name);
  switch (state) {
    case 'account-connected':
      return `${service} is connected to your account`;
    case 'account-reauth':
      return `${service} needs reconnecting`;
    case 'account-not-connected':
      return added === undefined
        ? `${service} isn't connected to your account`
        : added
          ? 'Sign in required'
          : 'Not connected — add first';
    case 'device-connected-only':
      return `${service} is connected on this desktop only`;
    case 'device-connected':
      return `${service} is connected on this desktop`;
    case 'device-not-connected':
      return added === undefined
        ? `${service} isn't connected on this desktop`
        : added
          ? 'Sign in required'
          : 'Not connected — add first';
  }
}

/** Whether the status describes a working connection. */
export function mcpConnectionStatusConnected(
  state: McpConnectionCopyState,
): boolean {
  return (
    state === 'account-connected' ||
    state === 'device-connected-only' ||
    state === 'device-connected'
  );
}

/** The primary action that signs a server in, or signs it in again. */
export function mcpConnectActionLabel(name: string, reconnect = false): string {
  return `${reconnect ? 'Reconnect' : 'Connect'} ${serviceName(name)}`;
}

/** The one-time action that moves a desktop-only sign-in to the account. */
export function mcpConnectToAccountActionLabel(name: string): string {
  return `Connect ${serviceName(name)} to your account`;
}

/** Why a customized device server is never moved to the account. */
export function mcpCustomSetupStaysDescription(name: string): string {
  const service = serviceName(name);
  return `${service} has a custom setup on this desktop, so it stays here. Connect ${service} on the web to use it in cloud chats too.`;
}

/** The same move when the account already holds a connection. */
export function mcpUseAccountConnectionActionLabel(name: string): string {
  return `Use ${serviceName(name)} from your account`;
}

export function mcpConnectToAccountDescription(
  name: string,
  accountAlreadyConnected: boolean,
): string {
  const service = serviceName(name);
  return accountAlreadyConnected
    ? `${service} is connected to your account. Use that connection on this desktop too, so it matches the web and cloud chats.`
    : `Connect it to your account to use ${service} on the web and in cloud chats. You'll sign in to ${service} once more.`;
}

/** A desktop row reports an install, not a sign-in, so this never claims one. */
export function mcpDesktopInstallNote(
  name: string,
  desktopName: string | null,
  accountConnected: boolean,
): string {
  const desktop = desktopName?.trim() || 'your desktop';
  return accountConnected
    ? `Also installed on ${desktop}`
    : `Installed on ${desktop} only. Connect ${serviceName(name)} to use it here and in cloud chats.`;
}

/** A connected server's card: one connection serves every harness. */
export const MCP_SHARED_ACROSS_HARNESSES =
  'Shared across your supported harnesses.';

/** Add on an integration card also installs the plugin folded into it. */
export function mcpFoldedPluginSkillsNote(pluginName: string): string {
  return `Add also installs the ${pluginName} skills.`;
}

/**
 * Titles and descriptions for the routes an integration card offers
 * (REG-3033): the app's own MCP server, and the provider connectors linked in
 * a Claude or Codex account. Each says who holds the connection and where its
 * tools appear, so the two never read as one list.
 */
export function mcpAppRouteTitle(appName: string): string {
  return `${appName} MCP server`;
}

export function mcpAppRouteDescription(appName: string): string {
  return `Connects through ${appName}. Works with every supported harness.`;
}

export const MCP_PROVIDER_ROUTES_TITLE = 'Provider connections';

/**
 * The accounts a provider connector links through, naming only the providers
 * that offer it: "your Claude account", "your Claude or Codex account".
 */
export function mcpProviderAccountPhrase(providers: readonly string[]): string {
  const names = joinProviderNames(providers);
  return names === undefined
    ? 'your provider account'
    : `your ${names} account`;
}

/** Display names for the providers a connector can link through. */
export const MCP_PROVIDER_CONNECTOR_LABELS: Record<
  CuratedMcpConnectorProvider,
  string
> = {
  claude: 'Claude',
  codex: 'Codex',
};

/** "Claude", "Claude or Codex", "Claude, Codex, or Cursor". */
function joinProviderNames(providers: readonly string[]): string | undefined {
  const names = [...providers];
  const last = names.pop();
  if (last === undefined) return undefined;
  if (names.length === 0) return last;
  const serialComma = names.length > 1 ? ',' : '';
  return `${names.join(', ')}${serialComma} or ${last}`;
}

/**
 * How a provider-only service connects, where no provider route is shown to
 * do it from (the MCP tab, the server editor): link it in the provider's own
 * account (REG-3034).
 */
export function mcpProviderOnlyGuidance(
  name: string,
  providers: readonly string[],
): string {
  const names = joinProviderNames(providers);
  if (names === undefined) return "This server can't be connected from here.";
  const service = serviceName(name);
  return `${service} connects through your ${names} account. Connect ${names} first, then link ${service} there.`;
}

export function mcpProviderRoutesDescription(
  appName: string,
  providers: readonly string[],
): string {
  return `Connects through ${mcpProviderAccountPhrase(providers)}. ${appName} never sees these credentials.`;
}
