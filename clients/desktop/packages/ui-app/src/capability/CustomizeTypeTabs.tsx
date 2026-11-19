'use client';

import type { JSX } from 'react';
import {
  MarketplaceTypeTabs,
  type MarketplaceTypeTabsProps,
} from '@canopy/ui-shared/components';

/**
 * Customize's type tabs, shared by desktop and web. Shared with me is a
 * filter pill beside the search (`CustomizeFilterPills`), so the tabs are
 * only the item types.
 */
export function CustomizeTypeTabs(
  props: MarketplaceTypeTabsProps,
): JSX.Element {
  return <MarketplaceTypeTabs {...props} />;
}
