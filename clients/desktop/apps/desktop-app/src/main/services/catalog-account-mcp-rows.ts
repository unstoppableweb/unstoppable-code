import {
  accountMcpAccountName,
  type AccountMcpConnection,
} from '@canopy/protocol/mcp-servers';
import type { PortalPluginCatalogMcpServer } from '@canopy/protocol/portal';

type AccountFields = Pick<
  PortalPluginCatalogMcpServer,
  | 'configName'
  | 'connectionId'
  | 'connectionState'
  | 'connectionEnabled'
  | 'accountIsDefault'
  | 'connectionKind'
>;

function accountFields(connection: AccountMcpConnection): AccountFields {
  return {
    configName: accountMcpAccountName(connection),
    connectionId: connection.id,
    connectionKind: 'CURATED',
    connectionState:
      connection.status === 'CONNECTED'
        ? 'connected'
        : connection.status === 'REAUTH_REQUIRED'
          ? 'reauth_required'
          : 'not_connected',
    ...(connection.enabled === undefined
      ? {}
      : { connectionEnabled: connection.enabled }),
    ...(connection.isDefault === undefined
      ? {}
      : { accountIsDefault: connection.isDefault }),
  };
}

/**
 * The desktop catalog's MCP rows with one row per account of each curated
 * connector the person holds several accounts of (CAN-6227), so the Portal's
 * pickers and composer tell them apart and name the account a chat acts as.
 * A connector the device lists itself (`deviceServerIds`, enabled or not) is
 * left as it is: the desktop runs its
 * device configs and never reaches a hosted account for it, so naming one
 * would show an account that never acts. A connector with one account
 * changes nothing.
 */
export function mergeCatalogAccountMcpServers(
  deviceRows: readonly PortalPluginCatalogMcpServer[],
  deviceServerIds: readonly string[],
  connections: readonly AccountMcpConnection[],
): PortalPluginCatalogMcpServer[] {
  const deviceServers = new Set(deviceServerIds);
  const curated = connections.filter(
    (connection) =>
      connection.kind === 'CURATED' && !deviceServers.has(connection.serverKey),
  );
  const accountRows = curated
    .filter(
      (connection) =>
        curated.filter((row) => row.serverKey === connection.serverKey)
          .length >= 2,
    )
    .map(
      (connection): PortalPluginCatalogMcpServer => ({
        serverId: connection.serverKey,
        configId: connection.configId,
        serverName: connection.displayName,
        description: '',
        transport: 'http',
        ...accountFields(connection),
      }),
    );
  return [...deviceRows, ...accountRows];
}
