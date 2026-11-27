import { readFile } from 'node:fs/promises';
import {
  accountMcpConnectionForRef,
  isCustomAccountMcpServerKey,
  legacyAccountMcpConnectionId,
  matchAccountMcpConnection,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  isMcpServersIndexFile,
  normalizeMcpServerFile,
  type AccountMcpConnection,
  type McpServerConfigData,
  type McpServerFile,
} from '@canopy/execution-engine/types/mcp-servers';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/execution-engine/types/plugins';
import {
  accountMcpCatalogKeyForUrl,
  isAccountMcpCatalogEndpoint,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import {
  pluginAccountMcpConfigId,
  type AccountMcpRefResolution,
  type McpServerRef,
} from '@canopy/protocol/mcp-servers';
import { safeReadJson } from '../lib/fs-utils';
import { declaresPluginMcpHeaders } from '../plugins/plugin-mcp-auth';
import { accountMcpConnectionUnusableReason } from '../canopy-cloud/mcp-connection-usable';
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

/**
 * The tool policy fields a plugin MCP declaration can set (the ones
 * `buildCodexMcpToolPolicy` in plugin-resolver.ts reads). A shared account
 * route loads under one server name, so a member with its own policy keeps
 * its own path rather than give the account another member's policy.
 */
const PLUGIN_MCP_TOOL_POLICY_FIELDS = [
  'enabled_tools',
  'disabled_tools',
  'default_tools_approval_mode',
  'tools',
] as const;

/** A third-party plugin member at a catalog connector's endpoint. */
export interface ConnectorPluginMcpMember {
  kind: 'member';
  /** The catalog key of the connector its URL names. */
  connectorKey: string;
  /** The URL the plugin declares. */
  url: string;
}

/**
 * A third-party plugin member that could be a connector member, but the
 * cached catalog can't be read to tell which connector, if any, it reaches.
 */
export interface UncheckedConnectorPluginMcpMember {
  kind: 'catalog-unavailable';
}

/** Why a member that may be picked is left out with no catalog to check. */
export const CONNECTOR_PLUGIN_MCP_CATALOG_UNAVAILABLE =
  "the connector catalog can't be read to check the picked account.";

/**
 * A third-party plugin's HTTP member that reaches a catalog connector by its
 * URL: the connector whose endpoint is exactly the one the plugin declares
 * ({@link accountMcpCatalogKeyForUrl}). Such a member may use the account of
 * that connector the selection picks, because the account's requests still
 * go only to the catalog's endpoint. A declaration with headers or a tool
 * policy of its own keeps its own path, as do a curated member (it names its
 * key) and a turned-off one. `catalog` is null when the cached catalog can't
 * be read; an otherwise qualifying member is then `catalog-unavailable`.
 */
export function connectorPluginMcpMember(
  marketplaceId: string,
  rawValue: Record<string, unknown>,
  catalog: readonly CuratedMcpServerEntry[] | null,
): ConnectorPluginMcpMember | UncheckedConnectorPluginMcpMember | undefined {
  if (marketplaceId === CURATED_PLUGIN_MARKETPLACE_ID) return undefined;
  const { url } = rawValue;
  if (
    // A command wins over a URL in the resolver: the server runs as stdio.
    typeof rawValue.command === 'string' ||
    typeof url !== 'string' ||
    (rawValue.type !== undefined && rawValue.type !== 'http') ||
    rawValue.enabled === false ||
    declaresPluginMcpHeaders(rawValue) ||
    PLUGIN_MCP_TOOL_POLICY_FIELDS.some(
      (field): boolean => rawValue[field] !== undefined,
    ) ||
    pluginMcpCuratedKey(rawValue) !== undefined ||
    // Only a credential-free https URL can ever match a catalog endpoint.
    !isAccountMcpCatalogEndpoint(url)
  )
    return undefined;
  if (catalog === null) return { kind: 'catalog-unavailable' };
  const connectorKey = accountMcpCatalogKeyForUrl(catalog, url);
  return connectorKey === undefined
    ? undefined
    : { kind: 'member', connectorKey, url };
}

/**
 * Whether the selection may pick an account of `connectorKey`: a direct ref
 * to it, or a legacy `account:<connectionId>` ref, which names its connector
 * only through the account list. With neither, the member keeps its own
 * sign-in and the list need not be read.
 */
export function connectorPluginMcpMayBePicked(
  directRefs: readonly McpServerRef[],
  connectorKey: string,
): boolean {
  return directRefs.some(
    (ref): boolean =>
      ref.serverId === connectorKey ||
      legacyAccountMcpConnectionId(ref.serverId) !== undefined,
  );
}

/**
 * Whether a ref names a device server on this computer as the standalone
 * pass reads it (`readStandaloneMcpServerFile` in plugin-resolver.ts): a
 * readable, well-formed server file with the ref's id. Legacy and custom
 * account refs never name one.
 */
async function namesDeviceMcpServer(ref: McpServerRef): Promise<boolean> {
  if (
    legacyAccountMcpConnectionId(ref.serverId) !== undefined ||
    isCustomAccountMcpServerKey(ref.serverId)
  )
    return false;
  try {
    const raw = await readFile(getMcpServerFilePath(ref.serverId), 'utf-8');
    normalizeMcpServerFile(JSON.parse(raw), ref.serverId);
    return true;
  } catch {
    return false;
  }
}

/**
 * The selection's refs that may pick a cloud account. A ref that names a
 * device server file takes precedence over a connector key in the standalone
 * pass, so it picks no account; leaving it out keeps the plugin's answer the
 * selection's own.
 */
export async function cloudAccountMcpRefs(
  refs: readonly McpServerRef[],
  /**
   * What the standalone pass already found for a ref, by server id: a launch
   * reads each ref's answer once, so it can't change between the two passes.
   */
  known?: ReadonlyMap<string, boolean>,
): Promise<McpServerRef[]> {
  const device = await Promise.all(
    refs.map(
      (ref): Promise<boolean> =>
        known?.has(ref.serverId) === true
          ? Promise.resolve(known.get(ref.serverId) === true)
          : namesDeviceMcpServer(ref),
    ),
  );
  return refs.filter((_, index): boolean => device[index] !== true);
}

/** Why a legacy ref whose connection is gone leaves the member out. */
const CONNECTOR_PLUGIN_MCP_LEGACY_REF_GONE =
  "a picked account can't be found, so the plugin's account can't be checked.";

function urlHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * How a {@link ConnectorPluginMcpMember} resolves, decided once for the
 * resolver and the MCP servers card alike. A third-party plugin brings its
 * own sign-in, so an account of the connector is used only where the person
 * picks one: the selection's direct ref to that connector (a project's or a
 * chat's account choice, or an automation's Send as).
 *
 * - `own`: the selection picks no account of the connector. The member keeps
 *   its own sign-in, whatever accounts the person holds, so adding, removing
 *   or switching an account never changes which identity it runs as.
 * - `bind`: the picked account, resolved against every account of the
 *   connector as a direct ref is, when it is usable and the cloud reports its
 *   upstream host as the declared one (the host is all it reports).
 * - `skip`: a pick exists but can't be honored: the list can't be read,
 *   several accounts are picked, the pick is gone, off, needs sign-in or is
 *   at another host. The member is left out with `reason` rather than run as
 *   anyone else.
 */
export type ConnectorPluginMcpAccountChoice =
  | { kind: 'own' }
  | { kind: 'bind'; connection: AccountMcpConnection }
  | {
      kind: 'skip';
      reason: string;
      /** The picked account when it resolved but can't be used. */
      connection?: AccountMcpConnection;
    };

/** Why a picked account at another upstream host binds nothing. */
export const CONNECTOR_PLUGIN_MCP_OTHER_HOST =
  "the picked account's server isn't the one the plugin declares.";

export function connectorPluginMcpAccountChoice(
  connections: readonly AccountMcpConnection[] | null,
  member: ConnectorPluginMcpMember,
  directRefs: readonly McpServerRef[],
  resolution: AccountMcpRefResolution = 'attended',
): ConnectorPluginMcpAccountChoice {
  if (!connectorPluginMcpMayBePicked(directRefs, member.connectorKey))
    return { kind: 'own' };
  if (connections === null)
    return { kind: 'skip', reason: CURATED_PLUGIN_MCP_LIST_UNAVAILABLE };
  // Every ref that may pick this connector resolves as the standalone pass
  // resolves it (`accountMcpConnectionForRef` under the run's policy), so the
  // plugin reaches what the selection's own refs reach. A legacy
  // `account:<id>` ref picks the connector of the connection it names
  // exactly (id and config); one that names none can't be told apart from a
  // pick of this connector.
  const picked = new Map<string, AccountMcpConnection>();
  for (const ref of directRefs) {
    const legacy = legacyAccountMcpConnectionId(ref.serverId) !== undefined;
    if (!legacy && ref.serverId !== member.connectorKey) continue;
    const resolved = accountMcpConnectionForRef(ref, connections, resolution);
    if (resolved === undefined)
      return {
        kind: 'skip',
        reason: legacy
          ? CONNECTOR_PLUGIN_MCP_LEGACY_REF_GONE
          : CURATED_PLUGIN_MCP_AMBIGUOUS,
      };
    if (
      resolved.kind === 'CURATED' &&
      resolved.serverKey === member.connectorKey
    )
      picked.set(resolved.id, resolved);
  }
  if (picked.size === 0) return { kind: 'own' };
  const [connection] = picked.values();
  if (picked.size > 1 || connection === undefined)
    return { kind: 'skip', reason: CURATED_PLUGIN_MCP_AMBIGUOUS };
  const unusable = accountMcpConnectionUnusableReason(connection);
  if (unusable !== null) return { kind: 'skip', reason: unusable, connection };
  const declaredHost = urlHostname(member.url);
  return declaredHost !== undefined &&
    connection.upstreamHost?.toLowerCase() === declaredHost
    ? { kind: 'bind', connection }
    : { kind: 'skip', reason: CONNECTOR_PLUGIN_MCP_OTHER_HOST, connection };
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
