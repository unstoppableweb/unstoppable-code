'use client';

import {
  ControlButton,
  CustomizeEntryLogo,
  DetailFact,
} from '@canopy/ui-shared/components';
import { customizeDiscoveryNeedsAttention } from '@canopy/ui-shared/lib';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { MCP_MANAGEMENT_REASONS } from '@canopy/ui-shared/lib/mcp-card-display';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import type { JSX, ReactNode } from 'react';
import { customizeDiscoveryIdentity } from './customizeCopyIdentity';
import { customizeMcpVersionCopies } from './customizeIntegrationRows';
import { marketplaceEntryIsInstalled } from './marketplaceBrowse';

function versionStatus(entry: UnifiedPluginEntry): string {
  if (customizeDiscoveryNeedsAttention(entry)) return 'Needs attention';
  return marketplaceEntryIsInstalled(entry) ? 'Installed' : 'Available';
}

export function CustomizeMcpVersions({
  entry,
  entries,
  onOpenEntryId,
  canOpenEntry,
  renderFact,
}: {
  entry: UnifiedPluginEntry;
  entries: readonly UnifiedPluginEntry[];
  onOpenEntryId: (id: string) => void;
  canOpenEntry?: (copy: UnifiedPluginEntry) => boolean;
  renderFact?: (children: ReactNode) => JSX.Element;
}): JSX.Element | null {
  const copies = customizeMcpVersionCopies(entry, entries);
  if (copies.length === 0) return null;
  const rows = (
    <div className="flex flex-col gap-1" data-testid="customize-mcp-versions">
      {copies.map((copy) => {
        const canOpen = canOpenEntry?.(copy) ?? true;
        return (
          <ControlButton
            key={copy.id}
            type="button"
            disabled={!canOpen}
            onClick={() => onOpenEntryId(copy.id)}
            data-testid={`customize-mcp-versions-item-${copy.id}`}
            presentation="customize-related-item"
            appearance={{ list: true }}
          >
            <CustomizeEntryLogo
              entry={customizeDiscoveryIdentity(copy)}
              size={28}
            />
            <span
              className={
                copy.ref.type === 'local-mcp' ? REPLAY_MASK_CLASS : undefined
              }
            >
              {copy.name}
            </span>
            <span className="fg-secondary">{versionStatus(copy)}</span>
            {!canOpen && <span>{MCP_MANAGEMENT_REASONS.desktopOnly}</span>}
          </ControlButton>
        );
      })}
    </div>
  );
  return renderFact ? (
    renderFact(rows)
  ) : (
    <DetailFact label="Other versions">{rows}</DetailFact>
  );
}
