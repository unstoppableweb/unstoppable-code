import { createHash } from 'node:crypto';
export type ManagedMcpServerKind = 'dynamic' | 'proxy' | 'plugin';

export const MANAGED_MCP_SERVER_NAME_MAX_LENGTH = 48;
export const MANAGED_MCP_SERVER_DIGEST_LENGTH = 16;
export const MANAGED_MCP_SERVER_DIGEST_SEPARATOR = '--';

const PREFIXES = {
  dynamic: 'appdyn',
  proxy: 'appproxy',
  plugin: 'appplugin',
} as const satisfies Record<ManagedMcpServerKind, string>;

export function normalizeManagedMcpServerLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * The identity half of a managed MCP server name.
 *
 * Digested over `kind` + `identityParts` ONLY — `friendlyParts` deliberately do
 * not participate, so two registrations that differ purely in display label
 * still collide here, and a caller can recompute the digest from identity alone
 * without knowing what the label was at registration time. Extracted so
 * {@link buildManagedMcpServerName} and {@link readManagedMcpServerNameDigest}
 * can never drift apart.
 */
export function buildManagedMcpServerIdentityDigest(args: {
  kind: ManagedMcpServerKind;
  identityParts: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'managed-mcp-server-name-v1',
        args.kind,
        ...args.identityParts,
      ]),
    )
    .digest('hex')
    .slice(0, MANAGED_MCP_SERVER_DIGEST_LENGTH);
}

export function buildManagedMcpServerName(args: {
  kind: ManagedMcpServerKind;
  friendlyParts: readonly string[];
  identityParts: readonly string[];
}): string {
  const prefix = PREFIXES[args.kind];
  const normalizedFriendlyLabel =
    args.friendlyParts
      .map(normalizeManagedMcpServerLabel)
      .filter(Boolean)
      .join('-') || 'server';
  const friendlyBudget =
    MANAGED_MCP_SERVER_NAME_MAX_LENGTH -
    prefix.length -
    1 /* "-" */ -
    2 /* "--" */ -
    MANAGED_MCP_SERVER_DIGEST_LENGTH;
  const friendlyLabel = normalizedFriendlyLabel
    .slice(0, friendlyBudget)
    .replace(/-+$/g, '');
  const digest = buildManagedMcpServerIdentityDigest({
    kind: args.kind,
    identityParts: args.identityParts,
  });

  return `${prefix}-${friendlyLabel}${MANAGED_MCP_SERVER_DIGEST_SEPARATOR}${digest}`;
}

/**
 * The friendly part of a name {@link buildManagedMcpServerName} produced,
 * without its kind prefix or identity digest, for copy that addresses the
 * user ("unreachable" for `appdyn-unreachable--0123456789abcdef`). Undefined
 * for a name this module did not build.
 */
export function managedMcpServerFriendlyLabel(
  name: string,
): string | undefined {
  const separator = name.lastIndexOf(MANAGED_MCP_SERVER_DIGEST_SEPARATOR);
  if (separator < 0) return undefined;
  const digest = name.slice(
    separator + MANAGED_MCP_SERVER_DIGEST_SEPARATOR.length,
  );
  if (
    !/^[0-9a-f]+$/.test(digest) ||
    digest.length !== MANAGED_MCP_SERVER_DIGEST_LENGTH
  )
    return undefined;
  const labelled = name.slice(0, separator);
  for (const prefix of Object.values(PREFIXES)) {
    if (
      labelled.startsWith(`${prefix}-`) &&
      labelled.length > prefix.length + 1
    )
      return labelled.slice(prefix.length + 1);
  }
  return undefined;
}

/**
 * The name of a server bound to an account connection. Identity is the
 * connection's server key and config, never the selection that asked for it,
 * so a standalone ref and a curated plugin member that resolve one connection
 * share one `mcpServers` entry (REG-3033). Delegation and auth-failure
 * attribution recompute the same digest from `proxy` + [serverKey, configId].
 */
export function buildAccountMcpServerName(
  connection: {
    serverKey: string;
    configId: string;
    displayName: string;
  },
  /**
   * The account's name, when the person holds several accounts of this
   * connector and this is an added one (CAN-6228), so the agent tells the
   * tools apart. It never enters the digest.
   */
  account?: string,
): string {
  return buildManagedMcpServerName({
    kind: 'proxy',
    friendlyParts:
      account === undefined
        ? [connection.displayName]
        : [connection.displayName, account],
    identityParts: [connection.serverKey, connection.configId],
  });
}

/**
 * Read back the identity digest a managed server name ends with, or `null`.
 *
 * Pairs with {@link buildManagedMcpServerIdentityDigest} so a caller holding
 * only the name a provider echoed back — `mcp__<serverName>__<tool>` — can
 * compare it against a known identity. The friendly label is not consulted,
 * because it does not participate in the digest.
 */
export function readManagedMcpServerNameDigest(
  serverName: string,
): string | null {
  const index = serverName.lastIndexOf(MANAGED_MCP_SERVER_DIGEST_SEPARATOR);
  if (index < 0) return null;
  const digest = serverName.slice(
    index + MANAGED_MCP_SERVER_DIGEST_SEPARATOR.length,
  );
  return digest.length === MANAGED_MCP_SERVER_DIGEST_LENGTH &&
    /^[0-9a-f]+$/.test(digest)
    ? digest
    : null;
}
