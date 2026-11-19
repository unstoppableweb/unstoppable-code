import {
  accountMcpAccountName,
  isAccountMcpInstanceConfigId,
  pluginAccountMcpConfigId,
  resolvePluginAccountMcpServer,
  type AccountMcpConnection,
  type McpServerRef,
} from '@canopy/protocol/mcp-servers';
import {
  accountMcpConnectionForRef,
  isCustomAccountMcpServerKey,
  legacyAccountMcpConnectionId,
} from './effective-plugin-selections';

/**
 * Why a scheduled run cannot act as an account of a connector (CAN-6233):
 * - `choose`: the person holds several accounts and the automation names none
 *   ("Send as" is unset), so an unattended run will not pick one;
 * - `gone`: the account the automation names no longer exists;
 * - `disconnected`: the account exists but is not connected or is turned off.
 */
export type AutomationAccountProblemReason = 'choose' | 'gone' | 'disconnected';

export interface AutomationAccountProblem {
  readonly reason: AutomationAccountProblemReason;
  /** The connector's key (`slack`, `custom:<uuid>`). */
  readonly serverKey: string;
  /** The connector's name, or its key when the person holds no account of it. */
  readonly connector: string;
  /** The account's name, when one is known. */
  readonly account?: string;
}

export interface AutomationAccountCheckInput {
  /** The person's account connections. */
  readonly connections: readonly AccountMcpConnection[];
  /** The MCP refs the run selects directly, inherited ones included. */
  readonly directRefs: readonly McpServerRef[];
  /** Curated keys of the servers the run's selected curated plugins bring. */
  readonly pluginCuratedKeys: readonly string[];
  /** Servers a device file serves; a device file wins over an account. */
  readonly isDeviceServer: (serverId: string) => boolean;
  /** Curated keys served on the device only; they never use an account. */
  readonly desktopOnlyKeys?: ReadonlySet<string>;
  /**
   * The curated catalog's connectors by key, with their names. A direct ref
   * with no account of its connector is checked only when its key is one of
   * them, so a device server that was removed never reads as an account.
   */
  readonly curatedConnectors?: ReadonlyMap<string, string>;
}

function usable(connection: AccountMcpConnection): boolean {
  return connection.status === 'CONNECTED' && connection.enabled !== false;
}

function connectorName(
  rows: readonly AccountMcpConnection[],
  serverKey: string,
  curatedConnectors?: ReadonlyMap<string, string>,
): string {
  return (
    rows.find((row) => row.serverKey === serverKey)?.displayName ??
    curatedConnectors?.get(serverKey) ??
    serverKey
  );
}

function disconnected(
  connection: AccountMcpConnection,
): AutomationAccountProblem {
  return {
    reason: 'disconnected',
    serverKey: connection.serverKey,
    connector: connection.displayName,
    account: accountMcpAccountName(connection),
  };
}

/**
 * The accounts a run nobody watches could not act as (CAN-6233), by the
 * unattended rule: a ref reaches its exact account, or, when it names no
 * added account, the person's only account of the connector; a server a
 * plugin brings reaches the account the run picks for its connector, else the
 * only one. It never reaches the default of several; a ref that names none of
 * several accounts, beside one that names an account, loads nothing and is
 * not counted. Every account it does
 * reach must be connected. Connectors with no account (a device server, or
 * one served on the device only) are not checked here.
 */
export function automationAccountProblems(
  input: AutomationAccountCheckInput,
): AutomationAccountProblem[] {
  const problems = new Map<string, AutomationAccountProblem>();
  const add = (problem: AutomationAccountProblem): void => {
    const key = JSON.stringify([
      problem.serverKey,
      problem.reason,
      problem.account ?? '',
    ]);
    if (!problems.has(key)) problems.set(key, problem);
  };
  const curated = input.connections.filter((row) => row.kind === 'CURATED');

  for (const ref of input.directRefs) {
    const legacy = legacyAccountMcpConnectionId(ref.serverId) !== undefined;
    const custom = isCustomAccountMcpServerKey(ref.serverId);
    if (!legacy && !custom) {
      if (input.isDeviceServer(ref.serverId)) continue;
      if (input.desktopOnlyKeys?.has(ref.serverId)) continue;
    }
    const connection = accountMcpConnectionForRef(
      ref,
      input.connections,
      'unattended',
    );
    if (connection) {
      if (!usable(connection)) add(disconnected(connection));
      continue;
    }
    const rows =
      legacy || custom
        ? []
        : curated.filter((row) => row.serverKey === ref.serverId);
    if (
      !legacy &&
      !custom &&
      rows.length === 0 &&
      !isAccountMcpInstanceConfigId(ref.configId) &&
      !input.curatedConnectors?.has(ref.serverId)
    )
      continue;
    // A ref that names none of several accounts loads nothing in an
    // unattended run, so beside a ref that names one of them (the "Send as"
    // choice) it changes nothing: the run acts as the named account. Only
    // when nothing names one does the run stop to ask.
    const named = (): boolean =>
      input.directRefs.some(
        (other) =>
          other.serverId === ref.serverId &&
          rows.some((row) => row.configId === other.configId),
      );
    if (
      rows.length > 1 &&
      !isAccountMcpInstanceConfigId(ref.configId) &&
      named()
    )
      continue;
    add({
      // Several accounts and a ref that names none of them: "Send as".
      reason:
        rows.length > 1 && !isAccountMcpInstanceConfigId(ref.configId)
          ? 'choose'
          : 'gone',
      serverKey: ref.serverId,
      connector: connectorName(
        input.connections,
        ref.serverId,
        input.curatedConnectors,
      ),
    });
  }

  for (const key of new Set(input.pluginCuratedKeys)) {
    if (input.desktopOnlyKeys?.has(key)) continue;
    const rows = curated.filter((row) => row.serverKey === key);
    // No account: the plugin's server binds a device server or nothing,
    // as it does in a chat.
    if (rows.length === 0) continue;
    const connection = resolvePluginAccountMcpServer(
      rows,
      key,
      input.directRefs,
      'unattended',
    );
    if (connection) {
      if (!usable(connection)) add(disconnected(connection));
      continue;
    }
    add({
      reason:
        pluginAccountMcpConfigId(input.directRefs, key, rows) === undefined
          ? 'choose'
          : 'gone',
      serverKey: key,
      connector: connectorName(rows, key),
    });
  }
  return Array.from(problems.values());
}

/**
 * Whether the person chose a sign-in other than the account for a server a
 * plugin brings (on the server, or for the run), so the run never acts as an
 * account for it. The global default alone is not a choice: an unbound row
 * keeps it while it still needs an account.
 */
export function choseOtherSignIn(server: {
  readonly authHandler?: string;
  readonly httpAuthHandlerSource?: 'default' | 'server' | 'override';
}): boolean {
  return (
    server.authHandler !== 'account' &&
    (server.httpAuthHandlerSource === 'server' ||
      server.httpAuthHandlerSource === 'override')
  );
}

/** One problem in words, for a run's failure reason and the owner's notice. */
export function automationAccountProblemText(
  problem: AutomationAccountProblem,
): string {
  switch (problem.reason) {
    case 'choose':
      return `You have several ${problem.connector} accounts. Choose which one this automation sends as.`;
    case 'gone':
      // A legacy ref names a connection, not a connector, so a deleted one
      // has no connector name to show.
      return problem.connector === problem.serverKey &&
        problem.serverKey.startsWith('account:')
        ? 'An account this automation sends as is gone. Choose another account.'
        : `The ${problem.connector} account this automation sends as is gone. Choose another account.`;
    case 'disconnected':
      return `Reconnect ${problem.connector} (${problem.account ?? problem.connector}) to run this automation.`;
  }
}
