import type { JSX } from 'react';
import { TabBar } from '../primitives/TabBar';
import {
  marketplaceTypeTabs,
  type MarketplaceTypeTab,
  type MarketplaceTypeTabId,
} from '../lib/marketplace-type-tabs';

/** The tabs every host shows; Agents and Project templates are opt-in. */
const DEFAULT_TABS = marketplaceTypeTabs();

export interface MarketplaceTypeTabsProps {
  readonly value: MarketplaceTypeTabId;
  readonly onChange: (tab: MarketplaceTypeTabId) => void;
  /**
   * The tabs to show, from `marketplaceTypeTabs`. Defaults to the kinds every
   * host lists; pass the host's own set to add Agents or Project templates.
   */
  readonly tabs?: readonly MarketplaceTypeTab[];
  /** Placement only; the tab list owns its own layout. */
  readonly className?: string;
}

/** The Marketplace's capability type tabs, identical on desktop and web. */
export function MarketplaceTypeTabs({
  value,
  onChange,
  tabs = DEFAULT_TABS,
  className,
}: MarketplaceTypeTabsProps): JSX.Element {
  return (
    <TabBar
      items={tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        dataTestId: `plugins-type-tab-${tab.id}`,
      }))}
      value={value}
      onChange={(next): void => onChange(next)}
      label="Capability type"
      scrollable
      dataTestId="plugins-type-tabs"
      className={className}
    />
  );
}
