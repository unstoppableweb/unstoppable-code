import {
  accountMcpAccountName,
  type AccountMcpConnection,
} from '@canopy/protocol/mcp-servers';

/** The connector and account a bound server name acts as. */
export interface AccountMcpServerAccount {
  /** The connector's name, such as `Slack`. */
  readonly connector: string;
  /** The account's name, such as `acme`. */
  readonly account: string;
}

/**
 * Which account each bound account MCP server name acts as, for connectors
 * the person holds several accounts of (CAN-6228), so an approval names the
 * account it will act as. Written at each bind, and cleared whenever the
 * signed-in account or its connections change, so an entry never outlives
 * the binding it describes.
 */
const accounts = new Map<string, AccountMcpServerAccount>();

/**
 * The account a server bound to `connection` acts as, when the person holds
 * several accounts of its connector; undefined when it is their only one, so
 * a chat with one account reads as it did.
 */
export function accountMcpServerAccount(
  connection: Pick<
    AccountMcpConnection,
    'id' | 'kind' | 'serverKey' | 'configId' | 'displayName' | 'label'
  >,
  connections: readonly Pick<
    AccountMcpConnection,
    'id' | 'kind' | 'serverKey'
  >[],
): AccountMcpServerAccount | undefined {
  if (connection.kind !== 'CURATED') return undefined;
  const siblings = connections.filter(
    (row) => row.kind === 'CURATED' && row.serverKey === connection.serverKey,
  );
  if (siblings.length < 2) return undefined;
  return {
    connector: connection.displayName,
    account: accountMcpAccountName(connection),
  };
}

/** Remembers the account a bound server name acts as. */
export function recordAccountMcpServerAccount(
  serverName: string,
  account: AccountMcpServerAccount,
): void {
  accounts.set(serverName, account);
}

/** The account a bound server name acts as, if it is one of several. */
export function lookupAccountMcpServerAccount(
  serverName: string,
): AccountMcpServerAccount | undefined {
  return accounts.get(serverName);
}

/** Forgets a server name once it is no longer one of several accounts. */
export function forgetAccountMcpServerAccount(serverName: string): void {
  accounts.delete(serverName);
}

/**
 * Forgets every recorded server name, when the signed-in account or its
 * account connections change.
 */
export function forgetAccountMcpServerAccounts(): void {
  accounts.clear();
}
