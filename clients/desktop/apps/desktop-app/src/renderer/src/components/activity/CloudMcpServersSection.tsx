import type { JSX } from 'react';
import { accountMcpSettingsPath } from '@canopy/protocol/marketplace';
import { McpServersSectionBody } from '@canopy/ui-app';
import { RefreshButton } from '@canopy/ui-shared/components';
import { McpServerIcon } from '@canopy/ui-shared/icons';
import {
  PanelSection,
  useActivitySectionChrome,
} from '@/components/shared/panel-section';
import { BrandLogo } from '@/components/BrandLogo';
import { brandText } from '@/lib/brand';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { openAuthenticatedCloudPage } from '@/lib/openAuthenticatedCloudPage';
import {
  useCloudMcpServersHeaderChrome,
  type CloudMcpServersModel,
} from './cloud-mcp-servers-model';

/**
 * The rail's MCP Servers section for a cloud task: the shared rows, read
 * only. A server that needs connecting or signing in opens its page on the
 * web, signed in, since the web core serves no connect here yet.
 */
export function CloudMcpServersSectionBody({
  model,
}: {
  readonly model: CloudMcpServersModel;
}): JSX.Element {
  const title = useEarlyAccessTitle('MCP Servers');
  const chrome = useCloudMcpServersHeaderChrome(model);
  // The combined rail draws its own refresh; the card on its own needs one,
  // and it retries a read that failed.
  const sectionChrome = useActivitySectionChrome();
  return (
    <PanelSection
      icon={<McpServerIcon size="sm" />}
      title={title}
      hasExpandableContent={model.servers.length > 0 || model.error !== null}
      subtitle={chrome.subtitle}
      headerAction={
        sectionChrome === 'body-only' ? undefined : (
          <RefreshButton
            onClick={(): void => {
              void model.refresh();
            }}
            busy={model.loading}
            ariaLabel="Refresh MCP servers"
            dataTestId="mcp-servers-card-refresh"
          />
        )
      }
      collapsedIconColor={chrome.collapsedIconColor}
    >
      <McpServersSectionBody
        servers={model.servers}
        warnings={[]}
        loading={model.loading}
        error={model.error}
        connectingKey={null}
        showProxyToggle={false}
        brandAppName={brandText.appName}
        proxyLogo={<BrandLogo width={14} height={14} />}
        onConnect={(server): void => {
          const item = model.servers.find(
            (candidate) => candidate.key === server.key,
          );
          if (item)
            openAuthenticatedCloudPage(
              accountMcpSettingsPath(item.serverId, item.configId),
            );
        }}
      />
    </PanelSection>
  );
}
