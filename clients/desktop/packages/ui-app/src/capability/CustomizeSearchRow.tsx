import type { JSX } from 'react';
import {
  InstalledStatusFilterDropdown,
  MarketplaceSearchField,
  PageSearchControls,
  PageSearchRow,
  type MarketplaceSearchFieldProps,
} from '@canopy/ui-shared/components';
import type {
  InstalledStatusFilterValue,
  MarketplaceTypeTabId,
} from '@canopy/ui-shared/lib';
import { customizeTabHasInstalledStatuses } from './customizeSections';

export interface CustomizeSearchRowProps {
  readonly tab: MarketplaceTypeTabId;
  /** The row owns the field's placement. */
  readonly search: Omit<MarketplaceSearchFieldProps, 'className'>;
  /** `null` or omitted is Any status. */
  readonly installedStatusFilter?: InstalledStatusFilterValue | null;
  /** Omit to render the search alone. */
  readonly onInstalledStatusFilterChange?: (
    value: InstalledStatusFilterValue | null,
  ) => void;
  /**
   * The tab offers Update available (`customizeTabOffersUpdateFilter`,
   * CAN-5309). Pass the effective filter, so a stored value this tab cannot
   * apply reads as Any.
   */
  readonly updateFilterAvailable?: boolean;
  readonly className?: string;
}

/**
 * The Customize search with its Installed status filter beside it, shared by
 * desktop and web (CAN-4838). The filter shows only on tabs whose Installed
 * rows carry a status.
 */
export function CustomizeSearchRow({
  tab,
  search,
  installedStatusFilter,
  onInstalledStatusFilterChange,
  updateFilterAvailable = false,
  className,
}: CustomizeSearchRowProps): JSX.Element {
  return (
    <PageSearchRow testId="customize-search-row" className={className}>
      {/* The search takes the row; the status filter follows it. */}
      <MarketplaceSearchField {...search} />
      {customizeTabHasInstalledStatuses(tab) &&
        onInstalledStatusFilterChange !== undefined && (
          <PageSearchControls>
            <InstalledStatusFilterDropdown
              value={installedStatusFilter ?? null}
              onChange={onInstalledStatusFilterChange}
              includeUpdateAvailable={updateFilterAvailable}
            />
          </PageSearchControls>
        )}
    </PageSearchRow>
  );
}
