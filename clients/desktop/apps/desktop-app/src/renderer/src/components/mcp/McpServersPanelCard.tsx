/* eslint-disable react-refresh/only-export-components */
import { useState, type JSX } from 'react';
import type { DetectedMcpServerInfo } from '@canopy/execution-engine/types/mcp-servers';
import {
  McpServersSectionBody,
  type McpServersSectionBodyProps,
  type McpServersSectionItem,
} from '@canopy/ui-app';
import {
  PanelSection,
  type CollapsedIconColor,
  useActivitySectionChrome,
} from '@/components/shared/panel-section';
import { BrandLogo } from '@/components/BrandLogo';
import { McpServerDialog } from '@/components/pages/McpServersTab';
import { brandText } from '@/lib/brand';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { McpServerDetailsModal } from './McpServerDetailsModal';
import { mcpPanelCardSubtitle } from './mcp-card-helpers';
import { McpServerIcon } from '@canopy/ui-shared/icons';
import { RefreshButton } from '@canopy/ui-shared/components';

export function getMcpProxyToggleActiveTitle(): string {
  return `${brandText.appName} proxy enabled. Click to use agent provider auth.`;
}

export function getMcpProxyToggleInactiveTitle(): string {
  return `Using agent provider auth. Click to use ${brandText.appName} proxy.`;
}

interface McpServersPanelCardProps {
  servers: DetectedMcpServerInfo[];
  /** The project's shared connections the chat loads, listed after `servers`. */
  sharedConnections?: readonly McpServersSectionItem[];
  getRowNavigation?: McpServersSectionBodyProps['getRowNavigation'];
  getRowSettings?: McpServersSectionBodyProps['getRowSettings'];
  renderRowExtra?: McpServersSectionBodyProps['renderRowExtra'];
  rowExtraLayout?: McpServersSectionBodyProps['rowExtraLayout'];
  onCancelSignIn?: (server: McpServersSectionItem) => void;
  warnings: string[];
  loading: boolean;
  error: string | null;
  connectingKey: string | null;
  proxyUpdatingKey?: string | null;
  showProxyToggle?: boolean;
  onConnect: (server: DetectedMcpServerInfo) => void;
  onRefresh: () => void;
  onSetCanopyProxyEnabled?: (
    server: DetectedMcpServerInfo,
    enabled: boolean,
  ) => void;
}

export function useMcpServersHeaderChrome({
  servers,
  sharedConnections = [],
  loading,
}: Pick<
  McpServersPanelCardProps,
  'servers' | 'sharedConnections' | 'loading'
>): {
  subtitle: string;
  collapsedIconColor: CollapsedIconColor;
} {
  const serverCount = servers.length + sharedConnections.length;
  return {
    subtitle: mcpPanelCardSubtitle({
      loading: loading && serverCount === 0,
      serverCount,
    }),
    collapsedIconColor: serverCount > 0 ? 'blue' : 'muted',
  };
}

export function McpServersPanelCard({
  servers,
  sharedConnections = [],
  warnings,
  loading,
  error,
  connectingKey,
  proxyUpdatingKey = null,
  showProxyToggle = true,
  onConnect,
  onRefresh,
  onSetCanopyProxyEnabled,
  getRowNavigation,
  getRowSettings,
  renderRowExtra,
  rowExtraLayout,
  onCancelSignIn,
}: McpServersPanelCardProps): JSX.Element {
  const chrome = useActivitySectionChrome();
  const sectionTitle = useEarlyAccessTitle('MCP Servers');
  const [viewingServerKey, setViewingServerKey] = useState<string | null>(null);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [detailsRefreshKey, setDetailsRefreshKey] = useState(0);

  const headerChrome = useMcpServersHeaderChrome({
    servers,
    sharedConnections,
    loading,
  });
  const rows: readonly McpServersSectionItem[] = [
    ...servers,
    ...sharedConnections,
  ];

  const headerAction = (
    <RefreshButton
      onClick={onRefresh}
      busy={loading}
      ariaLabel="Refresh MCP servers"
      dataTestId="mcp-servers-card-refresh"
    />
  );

  const viewingServer =
    viewingServerKey !== null
      ? (servers.find((s) => s.key === viewingServerKey) ?? null)
      : null;

  const detailsModalOpen = viewingServer !== null && editingServerId === null;
  const editDialogOpen = editingServerId !== null;

  return (
    <>
      <PanelSection
        icon={<McpServerIcon size="sm" />}
        title={sectionTitle}
        hasExpandableContent={
          rows.length > 0 || error !== null || warnings.length > 0
        }
        subtitle={headerChrome.subtitle}
        headerAction={chrome === 'body-only' ? undefined : headerAction}
        collapsedIconColor={headerChrome.collapsedIconColor}
      >
        <McpServersSectionBody
          servers={rows}
          getRowNavigation={getRowNavigation}
          getRowSettings={getRowSettings}
          renderRowExtra={renderRowExtra}
          rowExtraLayout={rowExtraLayout}
          onCancelSignIn={onCancelSignIn}
          warnings={warnings}
          loading={loading}
          error={error}
          connectingKey={connectingKey}
          proxyUpdatingKey={proxyUpdatingKey}
          showProxyToggle={showProxyToggle}
          brandAppName={brandText.appName}
          proxyLogo={<BrandLogo width={14} height={14} />}
          // The body narrows callbacks to its structural item type, so the
          // wrapper re-looks-up the full DetectedMcpServerInfo by key. A miss
          // can only happen if the list re-rendered between click and
          // dispatch; dropping the action then is correct (the row is gone).
          onConnect={(server): void => {
            const detectedServer = servers.find(
              (candidate) => candidate.key === server.key,
            );
            if (detectedServer) {
              onConnect(detectedServer);
            }
          }}
          onSetCanopyProxyEnabled={
            onSetCanopyProxyEnabled
              ? (server, enabled): void => {
                  const detectedServer = servers.find(
                    (candidate) => candidate.key === server.key,
                  );
                  if (detectedServer) {
                    onSetCanopyProxyEnabled(detectedServer, enabled);
                  }
                }
              : undefined
          }
          onOpenDetails={(server): void => setViewingServerKey(server.key)}
        />
      </PanelSection>

      {viewingServer && (
        <div
          aria-hidden={!detailsModalOpen}
          style={{
            visibility: detailsModalOpen ? 'visible' : 'hidden',
            pointerEvents: detailsModalOpen ? undefined : 'none',
          }}
        >
          <McpServerDetailsModal
            server={viewingServer}
            refreshKey={detailsRefreshKey}
            onClose={(): void => setViewingServerKey(null)}
            onEdit={(serverId): void => setEditingServerId(serverId)}
          />
        </div>
      )}

      {editDialogOpen && (
        <McpServerDialog
          serverId={editingServerId}
          noEnterAnimation
          onClose={(): void => setEditingServerId(null)}
          onSaved={(): Promise<void> => {
            onRefresh();
            setDetailsRefreshKey((k) => k + 1);
            return Promise.resolve();
          }}
        />
      )}
    </>
  );
}
