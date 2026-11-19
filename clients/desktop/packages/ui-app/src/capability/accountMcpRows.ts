import {
  accountMcpAccountName,
  isDefaultAccountMcpConnection,
  type AccountMcpConnection,
  type McpServerIndexEntry,
} from '@canopy/protocol/mcp-servers';
import { WORKSPACE_LABEL, WORKSPACE_LABEL_PLURAL } from '@canopy/protocol';
import type { UnifiedEntrySurface } from '@canopy/ui-shared';

// The account naming rules are shared with the cloud catalog (CAN-6226).
export {
  accountMcpAccountName,
  accountMcpConfigName,
  isDefaultAccountMcpConnection,
} from '@canopy/protocol/mcp-servers';

/**
 * An account row's id is the connection's server key (curated key or
 * `custom:<uuid>`), so a picker selection `{ serverId: row.id, configId }` is
 * the same ref cloud sessions and workspace templates use. The connection id
 * stays on `accountConnectionId`.
 */
export function accountMcpIndexEntry(
  connection: AccountMcpConnection,
): McpServerIndexEntry {
  return {
    id: connection.serverKey,
    scope: 'account',
    authHandler: 'account',
    accountConnectionId: connection.id,
    accountConnection: connection,
    ...(connection.kind === 'CURATED'
      ? { curatedKey: connection.serverKey }
      : {}),
    name: connection.displayName,
    description: '',
    type: 'http',
    updatedAt: '',
    configs: [
      {
        id: connection.configId,
        name: accountMcpAccountName(connection),
        enabled: true,
      },
    ],
  };
}

/**
 * One row per connection id, grouped by server key for display with the
 * default configuration first. Device copies fold under the connection they
 * are bound to, else under the key's default row; every other device row
 * stays its own entry.
 *
 * Earlier the merge kept one row per server key and preferred the default
 * configuration, so a second configuration of the same provider (a Work
 * Linear beside a Personal one) vanished from every list (REG-3033).
 */
export function mergeAccountMcpInventory(
  deviceRows: McpServerIndexEntry[],
  connections: AccountMcpConnection[],
): McpServerIndexEntry[] {
  const groups = new Map<string, McpServerIndexEntry[]>();
  const byConnectionId = new Map<string, McpServerIndexEntry>();
  // Curated rows only: a custom connection never owns a curated key, even
  // when its server key happens to read the same.
  const byCuratedKey = new Map<string, McpServerIndexEntry>();
  for (const connection of connections
    .slice()
    .sort(
      (a, b): number =>
        Number(isDefaultAccountMcpConnection(b)) -
          Number(isDefaultAccountMcpConnection(a)) || a.id.localeCompare(b.id),
    )) {
    // The same connection listed twice is still one connection.
    if (byConnectionId.has(connection.id)) continue;
    const row = accountMcpIndexEntry(connection);
    byConnectionId.set(connection.id, row);
    const group = groups.get(row.id);
    if (group) group.push(row);
    else groups.set(row.id, [row]);
    if (row.curatedKey && !byCuratedKey.has(row.curatedKey))
      byCuratedKey.set(row.curatedKey, row);
  }
  const rows: McpServerIndexEntry[] = Array.from(groups.values()).flat();
  for (const device of deviceRows) {
    const account =
      byConnectionId.get(device.accountConnectionId ?? '') ??
      byCuratedKey.get(device.curatedKey ?? '');
    if (account) {
      account.deviceCopies = [...(account.deviceCopies ?? []), device];
      account.logoUrl ??= device.logoUrl;
      account.description ||= device.description;
    } else rows.push(device);
  }
  return rows;
}

/**
 * The synthesized account row with this id; device rows never match. Without
 * a `configId` the first row for the key wins, which the merge keeps as the
 * default configuration.
 */
export function findAccountMcpRow(
  rows: readonly McpServerIndexEntry[],
  serverId: string,
  configId?: string,
): McpServerIndexEntry | undefined {
  return rows.find(
    (row): boolean =>
      row.id === serverId &&
      row.accountConnection !== undefined &&
      (configId === undefined || row.accountConnection.configId === configId),
  );
}

/**
 * Flattens account rows for catalog-style pickers. Device copies that share
 * the parent's curated key or bound connection would render the same card
 * twice, so only unrelated copies are surfaced alongside it.
 */
export function pickerMcpServers(
  servers: readonly McpServerIndexEntry[],
): McpServerIndexEntry[] {
  return servers.flatMap((row): McpServerIndexEntry[] => [
    row,
    ...(row.deviceCopies ?? []).filter(
      (copy): boolean =>
        (copy.curatedKey === undefined || copy.curatedKey !== row.curatedKey) &&
        (copy.accountConnectionId === undefined ||
          copy.accountConnectionId !== row.accountConnectionId),
    ),
  ]);
}

/**
 * Hosts the cloud can never reach: `localhost` and its subdomains, the IPv4
 * loopback block, IPv6 loopback, and the unspecified address. Accepts a bare
 * hostname or a bracketed IPv6 literal as returned by `URL#hostname`.
 */
export function isLoopbackMcpHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost'))
    return true;
  if (normalized === '::1' || normalized === '0.0.0.0') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return (
    octets !== null &&
    octets.slice(1).every((octet): boolean => Number(octet) <= 255)
  );
}

/**
 * A device-only custom HTTPS row that can become an account connection. The
 * caller still re-reads the definition before promoting it: headers and a
 * provider-managed handler live there, not in the index, and the URL may have
 * changed since the row was indexed.
 */
export function customAccountMcpPromotable(row: McpServerIndexEntry): boolean {
  return (
    row.type === 'http' &&
    row.scope !== 'account' &&
    !row.accountConnectionId &&
    !row.accountConnection &&
    !row.curatedKey &&
    row.authHandler !== 'provider' &&
    row.urlScheme === 'https' &&
    row.urlHost !== undefined &&
    row.urlHost.length > 0 &&
    !isLoopbackMcpHost(row.urlHost)
  );
}

/**
 * Where an MCP index row runs. Account rows, and device rows bound to an
 * account connection, reach cloud sessions as well as the desktop.
 */
export function mcpServerRowSurface(
  row: McpServerIndexEntry,
): UnifiedEntrySurface {
  return row.scope === 'account' ||
    row.authHandler === 'account' ||
    row.accountConnectionId !== undefined ||
    row.accountConnection !== undefined
    ? 'cloud'
    : 'desktop';
}

export interface McpServerSelectionRef {
  readonly serverId: string;
  readonly configId: string;
}

function sameMcpServerRef(
  left: McpServerSelectionRef,
  right: McpServerSelectionRef,
): boolean {
  return left.serverId === right.serverId && left.configId === right.configId;
}

/** Whether a selection set already includes this MCP server. */
export function hasMcpServerRef(
  selections:
    | { mcpServerRefs?: readonly McpServerSelectionRef[] }
    | null
    | undefined,
  ref: McpServerSelectionRef,
): boolean {
  return (selections?.mcpServerRefs ?? []).some((existing): boolean =>
    sameMcpServerRef(existing, ref),
  );
}

/**
 * Adds one MCP server to a selection set. The same object comes back when the
 * server is already selected, so callers can skip a redundant save.
 */
export function withMcpServerRef<
  T extends { mcpServerRefs?: readonly McpServerSelectionRef[] },
>(selections: T, ref: McpServerSelectionRef): T {
  if (hasMcpServerRef(selections, ref)) return selections;
  return {
    ...selections,
    mcpServerRefs: [
      ...(selections.mcpServerRefs ?? []),
      { serverId: ref.serverId, configId: ref.configId },
    ],
  };
}

/**
 * Removes one MCP server from a selection set. The same object comes back
 * when the server is not selected, so callers can skip a redundant save.
 */
export function withoutMcpServerRef<
  T extends { mcpServerRefs?: readonly McpServerSelectionRef[] },
>(selections: T, ref: McpServerSelectionRef): T {
  if (!hasMcpServerRef(selections, ref)) return selections;
  return {
    ...selections,
    mcpServerRefs: (selections.mcpServerRefs ?? []).filter(
      (existing): boolean => !sameMcpServerRef(existing, ref),
    ),
  };
}

/**
 * Adds one account of a connector to a selection set and drops the
 * connector's other accounts (CAN-6229): a project or chat that picks an
 * account uses that one, not two at once. `otherAccountConfigIds` are the
 * configurations of the person's other accounts of `ref.serverId`; a
 * connector held once passes none and this is {@link withMcpServerRef}. A
 * stored `default` ref of the connector goes too, since it reaches the
 * default account. The same object comes back when nothing changes.
 */
export function withMcpServerAccount<
  T extends { mcpServerRefs?: readonly McpServerSelectionRef[] },
>(
  selections: T,
  ref: McpServerSelectionRef,
  otherAccountConfigIds: readonly string[],
): T {
  const others = new Set(
    otherAccountConfigIds.filter((configId) => configId !== ref.configId),
  );
  // A connector held more than once also drops a stored `default` ref: with
  // no account under that config it stands for the default account, another
  // account than the one picked.
  if (others.size > 0 && ref.configId !== 'default') others.add('default');
  const refs = selections.mcpServerRefs ?? [];
  const kept = refs.filter(
    (existing): boolean =>
      existing.serverId !== ref.serverId || !others.has(existing.configId),
  );
  if (kept.length === refs.length) return withMcpServerRef(selections, ref);
  return withMcpServerRef({ ...selections, mcpServerRefs: kept }, ref);
}

/**
 * Saves a scheduled run's "Send as" choice (CAN-6233): the account becomes
 * the selection's only ref of the connector, replacing its other accounts
 * and any ref that names no current account, so an unattended run acts as
 * this account alone. `accountConfigIds` are every account the person holds
 * of `serverKey`.
 */
export function withAutomationSendAs<
  T extends { mcpServerRefs?: readonly McpServerSelectionRef[] },
>(
  selections: T,
  serverKey: string,
  configId: string,
  accountConfigIds: readonly string[],
): T {
  return withMcpServerAccount(selections, { serverId: serverKey, configId }, [
    ...accountConfigIds,
    ...(selections.mcpServerRefs ?? [])
      .filter((ref): boolean => ref.serverId === serverKey)
      .map((ref): string => ref.configId),
  ]);
}

/**
 * The selection keys a picker keeps when one is chosen (CAN-6229): choosing
 * an account of a connector unchecks its other accounts, so a chat acts as
 * the one picked. `siblingKeys` are the keys of every account of that
 * connector, the chosen one included; unchecking or a connector held once
 * just toggles.
 */
export function toggledAccountSelection(
  selected: ReadonlySet<string>,
  key: string,
  siblingKeys: readonly string[] = [],
): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) {
    next.delete(key);
    return next;
  }
  for (const sibling of siblingKeys) next.delete(sibling);
  next.add(key);
  return next;
}

const PROJECT_NOUN = WORKSPACE_LABEL.toLowerCase();

/**
 * The action that adds a signed-in MCP server to a project's default plugins.
 * Every chat in that project uses it from its next message.
 */
export function workspaceDefaultMcpLabel(workspaceName?: string): string {
  const name = workspaceName?.trim();
  return name ? `Add to ${name}` : `Add to this ${PROJECT_NOUN}`;
}

/** Where a signed-in MCP server is on by default, named project by project. */
export function mcpWorkspaceDefaultsStatus(
  workspaceNames: readonly string[],
): string {
  const names = workspaceNames.map((name): string => name.trim());
  if (names.length === 0) return `Not in any ${PROJECT_NOUN} yet.`;
  if (names.length === 1) return `Enabled in ${names[0]}.`;
  if (names.length === 2) return `Enabled in ${names[0]} and ${names[1]}.`;
  if (names.length === 3)
    return `Enabled in ${names[0]}, ${names[1]}, and ${names[2]}.`;
  return `Enabled in ${names[0]}, ${names[1]}, and ${String(names.length - 2)} more ${WORKSPACE_LABEL_PLURAL.toLowerCase()}.`;
}

/** Why a signed-in server that is in no project is not used yet. */
export const MCP_WORKSPACE_DEFAULTS_HINT = `Chats use it once you add it to a ${PROJECT_NOUN} or turn it on in a chat.`;

/** The same explanation when no project can be named, pointing at settings. */
export const MCP_WORKSPACE_SETTINGS_HINT = `Chats use it once you add it in ${PROJECT_NOUN} settings or turn it on in a chat.`;
