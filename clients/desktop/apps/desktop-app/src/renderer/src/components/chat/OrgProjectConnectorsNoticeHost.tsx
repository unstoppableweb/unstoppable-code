import { useCallback, useMemo, type JSX } from 'react';
import {
  accountMcpAccountName,
  type McpServerRef,
} from '@canopy/protocol/mcp-servers';
import { flattenMcpServerRows } from '@canopy/desktop-shared/lib/mcp-server-rows';
import {
  OrgProjectConnectorsNotice,
  type OrgProjectConnector,
} from '@canopy/ui-app/capability';
import { useMcpServerList } from '@/hooks/useMcpServerList';
import { addMcpServerToWorkspaceDefaults } from '@/lib/workspaceDefaultMcp';

/** The key a left-out connector is added back by. */
function refKey(ref: McpServerRef): string {
  return JSON.stringify([ref.serverId, ref.configId]);
}

/**
 * The desktop's `OrgProjectConnectorsNotice` (CAN-6230): names each global
 * connector an organization project leaves out from the MCP index, and adds
 * one to the project's own defaults through the shared workspace-defaults
 * add.
 * Mounted only when something was left out, so other chats read nothing.
 */
export function OrgProjectConnectorsNoticeHost({
  workspaceId,
  refs,
}: {
  /** The workspace whose defaults "Add" writes to. */
  workspaceId: string;
  /** The global connectors this workspace leaves out. */
  refs: readonly McpServerRef[];
}): JSX.Element {
  const { servers } = useMcpServerList();
  const connectors = useMemo((): OrgProjectConnector[] => {
    const rows = flattenMcpServerRows(servers);
    const accounts = rows.flatMap((row) =>
      row.scope === 'account' && row.accountConnection
        ? [row.accountConnection]
        : [],
    );
    return refs.map((ref): OrgProjectConnector => {
      const account = accounts.find(
        (connection) =>
          connection.serverKey === ref.serverId &&
          connection.configId === ref.configId,
      );
      if (account) {
        const several =
          accounts.filter((row) => row.serverKey === account.serverKey).length >
          1;
        return {
          key: refKey(ref),
          connector: account.displayName,
          ...(several ? { account: accountMcpAccountName(account) } : {}),
        };
      }
      const device = rows.find(
        (row) => row.scope !== 'account' && row.id === ref.serverId,
      );
      return { key: refKey(ref), connector: device?.name ?? ref.serverId };
    });
  }, [refs, servers]);
  // The shared workspace-defaults add: it adds the ref once, serializes
  // default updates, and refreshes the Cowork defaults mirror chats read.
  const onAdd = useCallback(
    async (key: string): Promise<void> => {
      const ref = refs.find((candidate) => refKey(candidate) === key);
      if (ref) await addMcpServerToWorkspaceDefaults(workspaceId, ref);
    },
    [refs, workspaceId],
  );
  return <OrgProjectConnectorsNotice connectors={connectors} onAdd={onAdd} />;
}
