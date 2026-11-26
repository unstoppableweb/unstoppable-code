import type { McpServersSectionItem } from '@canopy/ui-app';
import type { OrganizationLayerView } from '@canopy/desktop-shared/lib/organization-capabilities';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';

type ConnectionStatus = Extract<
  OrganizationLayerView['items'][number]['ref'],
  { kind: 'connector' }
>['status'];

/**
 * A shared connection's state in the words the Connectors page and project
 * setup use. A project admin signs it in, so no state asks the person to.
 */
const STATUS: Record<
  ConnectionStatus,
  Pick<McpServersSectionItem, 'authStatus' | 'authStatusLabel'>
> = {
  connected: { authStatus: 'connected', authStatusLabel: 'Connected' },
  needsSignIn: {
    authStatus: 'not_connected',
    authStatusLabel: 'Needs sign-in',
  },
  pending: { authStatus: 'not_connected', authStatusLabel: 'Not signed in' },
  disconnected: {
    authStatus: 'not_configured',
    authStatusLabel: 'Disconnected',
  },
};

/**
 * The MCP servers card rows for the project's shared connections (CAN-6246)
 * a chat loads: each organization-owned connector ref of its effective
 * selections, named and stated by the workspace's organization layer.
 * Display only: the hosted proxy serves them, so a row has no action.
 */
export function sharedConnectionRows(
  selections: ChatTabPluginSelections | null | undefined,
  view: OrganizationLayerView | null | undefined,
): McpServersSectionItem[] {
  if (!selections || !view) return [];
  return (selections.mcpServerRefs ?? []).flatMap(
    (ref): McpServersSectionItem[] => {
      if (ref.owner?.type !== 'organization') return [];
      const item = view.items.find(
        (candidate) =>
          candidate.ref.kind === 'connector' &&
          candidate.ref.serverId === ref.serverId &&
          candidate.ref.configId === ref.configId,
      );
      if (item === undefined || item.ref.kind !== 'connector') return [];
      return [
        {
          key: `shared:${ref.serverId}:${ref.configId}`,
          source: 'shared',
          sharedBy: item.source,
          displayName: item.name,
          enabled: true,
          ...STATUS[item.ref.status],
          canConnect: false,
        },
      ];
    },
  );
}
