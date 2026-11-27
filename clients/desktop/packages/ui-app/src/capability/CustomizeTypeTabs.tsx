'use client';

import type { JSX } from 'react';
import {
  Divider,
  MarketplaceTypeTabs,
  type MarketplaceTypeTabsProps,
} from '@canopy/ui-shared/components';
import { marketplaceTypeTabs } from '@canopy/ui-shared/lib';
import { WorkflowsIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Button } from '@canopy/ui-shared/primitives/Button';
import { useCustomizeDiscoveryEnabled } from './CustomizeDiscoveryProvider';

/**
 * Customize's type tabs, shared by desktop and web. Shared with me is a
 * filter pill beside the search (`CustomizeFilterPills`), so the tabs are
 * only the item types.
 *
 * New Customize keeps Workflows out of the item types (CAN-7691): a smaller
 * link at the row's end opens the same Workflows view, so plugins, MCP
 * servers and skills read as one group.
 */
export function CustomizeTypeTabs(
  props: MarketplaceTypeTabsProps,
): JSX.Element {
  const discoveryEnabled = useCustomizeDiscoveryEnabled();
  const tabs = props.tabs ?? marketplaceTypeTabs();
  const workflowTab = tabs.find((tab) => tab.id === 'workflow');
  if (!discoveryEnabled || !workflowTab) {
    return <MarketplaceTypeTabs {...props} />;
  }
  const current = props.value === 'workflow';
  return (
    <div className="flex min-w-0 items-stretch">
      <MarketplaceTypeTabs
        {...props}
        tabs={tabs.filter((tab) => tab.id !== 'workflow')}
        className={
          props.className
            ? `min-w-0 flex-1 ${props.className}`
            : 'min-w-0 flex-1'
        }
      />
      {/* The tab list draws its divider under its own width; this column
      continues it under the link. */}
      <div className="flex shrink-0 flex-col">
        <div className="flex-1 pl-6 pt-1">
          <Button
            variant="ghost"
            size="compact"
            leadingIcon
            data-testid="plugins-type-link-workflow"
            pressedHover
            aria-pressed={current}
            // Pressed again, it returns to All, as a toggle does.
            onClick={(): void => props.onChange(current ? 'all' : 'workflow')}
          >
            <WorkflowsIcon size="sm" />
            {workflowTab.label}
          </Button>
        </div>
        <Divider aria-hidden />
      </div>
    </div>
  );
}
