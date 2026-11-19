import { readFile } from 'node:fs/promises';
import { matchAccountMcpConnection } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  isMcpServersIndexFile,
  normalizeMcpServerFile,
  type AccountMcpConnection,
  type McpServerConfigData,
  type McpServerFile,
} from '@canopy/execution-engine/types/mcp-servers';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/execution-engine/types/plugins';
import {
  pluginAccountMcpConfigId,
  type AccountMcpRefResolution,
  type McpServerRef,
} from '@canopy/protocol/mcp-servers';
import { safeReadJson } from '../lib/fs-utils';
import { getMcpServerFilePath, getMcpServersIndexFilePath } from '../lib/paths';
import { pluginMcpCuratedKey } from './account-routing';

/**
 * Binding a curated plugin's HTTP member to an existing connection
 * (REG-3033). A member declared by the curated marketplace carries the
 * catalog key of the server it reaches. That key is trusted catalog identity,
 * so the member can share the account connection or the device server file
 * that holds the same key instead of starting a second sign-in for the same
 * upstream. Third-party plugins declare no key and keep their own path.
 */

/** The config the standalone pass would load for a device server. */
export const CURATED_PLUGIN_DEFAULT_CONFIG_ID = 'default';

/**
 * The curated key of a plugin MCP member that may bind to a connection: the
 * plugin comes from the curated marketplace and the declaration names a key.
 * Everything else resolves exactly as before.
 */
export function curatedPluginMcpMemberKey(
  marketplaceId: string,
  rawValue: Record<string, unknown>,
): string | undefined {
  if (marketplaceId !== CURATED_PLUGIN_MARKETPLACE_ID) return undefined;
  return pluginMcpCuratedKey(rawValue);
}

/** The outcome of looking a curated key up in the account connection list. */
export type CuratedAccountMcpLookup =
  | { kind: 'connection'; connection: AccountMcpConnection }
  /** No account connection carries the key; a device file may bind instead. */
  | { kind: 'none' }
  /**
   * Several accounts carry the key and none is the default (an older cloud
   * that sends no default flag), or an unattended run finds more than one;
   * never guess.
   */
  | { kind: 'ambiguous' };

/** How a curated member's account is chosen besides its key. */
export interface CuratedAccountMcpLookupOptions {
  /** `attended` when omitted. */
  resolution?: AccountMcpRefResolution;
  /**
   * The selection's direct MCP refs. A connector the selection picks one
   * account of directly sends its plugins' servers to that account too.
   */
  directRefs?: readonly McpServerRef[];
}

/**
 * The account connection a curated member binds to, with the connection's
 * live status so a caller can fail closed on one that is not connected. A
 * server a plugin brings reaches the account the same selection picks for
 * that connector directly (CAN-6232, `pluginAccountMcpConfigId`), else the
 * person's default account (CAN-6226): the one the cloud flags, else the
 * `default` config, else the only one. Several without a default never bind
 * (`matchAccountMcpConnection`) and are reported as ambiguous so the caller
 * does not fall through to a device file; so is a picked added account that
 * is gone. An unattended run (a pipeline prompt or an automation's turn)
 * never picks the default: with no pick only the connector's sole account
 * binds, and several are ambiguous.
 */
export function findCuratedAccountMcpConnection(
  connections: readonly AccountMcpConnection[],
  curatedKey: string,
  options: CuratedAccountMcpLookupOptions = {},
): CuratedAccountMcpLookup {
  const configId = pluginAccountMcpConfigId(
    options.directRefs ?? [],
    curatedKey,
    connections.filter((row): boolean => row.kind === 'CURATED'),
  );
  const connection = matchAccountMcpConnection(connections, {
    curatedKey,
    ...(configId === undefined ? {} : { configId }),
    resolution: options.resolution ?? 'attended',
  });
  if (connection) return { kind: 'connection', connection };
  return connections.some(
    (row): boolean => row.kind === 'CURATED' && row.serverKey === curatedKey,
  )
    ? { kind: 'ambiguous' }
    : { kind: 'none' };
}

/** Skip reasons shared by the resolver and the inventory for curated members. */
export const CURATED_PLUGIN_MCP_LIST_UNAVAILABLE =
  'the account connection list could not be read.';
export const CURATED_PLUGIN_MCP_AMBIGUOUS =
  'Account MCP connection missing or ambiguous.';

export interface CuratedDeviceMcpServer {
  serverFile: McpServerFile;
  config: McpServerConfigData;
}

async function readCuratedDeviceServerIds(
  curatedKey: string,
): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(
      await readFile(getMcpServersIndexFilePath(), 'utf8'),
    );
    if (!isMcpServersIndexFile(value)) return [];
    return value.servers
      .filter((entry): boolean => entry.curatedKey === curatedKey)
      .map((entry): string => entry.id);
  } catch {
    return [];
  }
}

/**
 * The device server file carrying `curatedKey`, with the config a standalone
 * ref to it would load: the enabled default config, else the first enabled
 * one. Reads the same index and server files as the standalone pass, and
 * re-checks the key on the definition so a stale index row never binds.
 */
export async function findCuratedDeviceMcpServer(
  curatedKey: string,
): Promise<CuratedDeviceMcpServer | undefined> {
  for (const serverId of await readCuratedDeviceServerIds(curatedKey)) {
    let serverFile: McpServerFile;
    try {
      serverFile = normalizeMcpServerFile(
        safeReadJson<unknown>(getMcpServerFilePath(serverId)),
        serverId,
      );
    } catch {
      continue;
    }
    const definition = serverFile.server.definition;
    if (definition.type !== 'http' || definition.curated?.key !== curatedKey)
      continue;
    const enabled = serverFile.server.configs.filter(
      (config): boolean => config.enabled,
    );
    const config =
      enabled.find(
        (candidate): boolean =>
          candidate.id === CURATED_PLUGIN_DEFAULT_CONFIG_ID,
      ) ?? enabled[0];
    if (config) return { serverFile, config };
  }
  return undefined;
}
