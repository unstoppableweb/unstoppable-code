import {
  resolveSelectedMcpServers,
  selectedMcpServerKey,
  type PortalChatTabPluginSelections,
  type PortalPluginCatalog,
  type PortalPluginCatalogMcpServer,
} from '@canopy/protocol/portal';
import type { McpServersSectionItem } from '@canopy/ui-app';

/** A cloud chat's MCP server row, with the catalog ids its link opens. */
export interface CloudMcpServerItem extends McpServersSectionItem {
  readonly serverId: string;
  readonly configId: string;
}

function status(
  server: PortalPluginCatalogMcpServer,
): Pick<
  CloudMcpServerItem,
  'authStatus' | 'authStatusLabel' | 'canConnect' | 'connectActionLabel'
> {
  if (server.connectionEnabled === false)
    return {
      authStatus: 'not_configured',
      authStatusLabel: 'Turned off',
      canConnect: false,
    };
  switch (server.connectionState) {
    case 'connected':
      return {
        authStatus: 'connected',
        authStatusLabel: 'Connected',
        canConnect: false,
      };
    case 'desktop_only':
      return {
        authStatus: 'connected',
        authStatusLabel: 'On this desktop',
        canConnect: false,
      };
    case 'reauth_required':
      return {
        authStatus: 'expired',
        authStatusLabel: 'Needs sign-in',
        canConnect: true,
        connectActionLabel: 'Sign in on the web',
      };
    case 'not_connected':
      return {
        authStatus: 'not_connected',
        authStatusLabel: 'Not connected',
        canConnect: true,
        connectActionLabel: 'Connect on the web',
      };
    default:
      return {
        authStatus: 'unsupported',
        authStatusLabel: 'Status unavailable',
        canConnect: false,
      };
  }
}

/**
 * The MCP servers a cloud chat uses, as the Activity rail shows them: the
 * servers it selects, available or not, and those its selected plugins bring
 * ({@link resolveSelectedMcpServers}, the rule every surface reads), from the
 * chat's web core catalog. Only the catalog's own state is shown; nothing on
 * this computer is asked about a cloud server.
 */
export function cloudChatMcpServerItems(
  catalog: PortalPluginCatalog | null,
  selections: PortalChatTabPluginSelections,
  unavailable: readonly PortalPluginCatalogMcpServer[] = [],
): CloudMcpServerItem[] {
  if (catalog === null) return [];
  // The picker offers only servers the web core runs now; the rail shows
  // every selected one, with its state.
  const plugins: PortalPluginCatalog = {
    ...catalog,
    mcpServers: [...catalog.mcpServers, ...unavailable],
  };
  const byKey = new Map(
    plugins.mcpServers.map((server) => [selectedMcpServerKey(server), server]),
  );
  const items: CloudMcpServerItem[] = [];
  for (const selected of resolveSelectedMcpServers(selections, plugins)) {
    const server = byKey.get(selectedMcpServerKey(selected));
    if (server === undefined) continue;
    items.push({
      key: selectedMcpServerKey(server),
      serverId: server.serverId,
      configId: server.configId,
      source: 'account',
      displayName: server.serverName,
      ...(server.configName !== server.serverName
        ? { configName: server.configName }
        : {}),
      ...(selected.via.kind === 'plugin'
        ? { viaPluginName: selected.via.pluginDisplayName }
        : {}),
      enabled: true,
      canRefresh: false,
      ...status(server),
    });
  }
  return items.sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}
