'use client';

import { useEffect, type JSX } from 'react';
import {
  FilterDropdown,
  InstalledItemStatusIcon,
  PageToggleFilter,
  type FilterOption,
} from '@canopy/ui-shared/components';
import {
  CheckIcon,
  CircleDashedIcon,
  PlusIcon,
  UserGroupIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type { InstalledItemStatus } from '@canopy/protocol/installed-items';
import {
  INSTALLED_ITEM_STATUS_COPY,
  INSTALLED_ITEM_STATUS_ORDER,
  type InstalledStatusFilterValue,
  type MarketplaceTypeTabId,
} from '@canopy/ui-shared/lib';
import { customizeTabHasInstalledStatuses } from './customizeSections';
import {
  useCustomizeDiscoveryFilters,
  useCustomizeSharedWithMe,
} from './CustomizeDiscoveryProvider';

/**
 * Every status an item can have: the three an added item can be in, and Not
 * installed for what can still be added. Tabs whose rows carry no status
 * offer Installed instead of the three.
 */
type StatusChoice = InstalledItemStatus | 'installed' | 'not-installed';

const ITEM_STATUS_OPTIONS: readonly FilterOption<StatusChoice>[] = [
  ...INSTALLED_ITEM_STATUS_ORDER.map((status) => ({
    value: status,
    label: INSTALLED_ITEM_STATUS_COPY[status].label,
  })),
  { value: 'not-installed', label: 'Not installed' },
];
const PLAIN_STATUS_OPTIONS: readonly FilterOption<StatusChoice>[] = [
  { value: 'installed', label: 'Installed' },
  { value: 'not-installed', label: 'Not installed' },
];

function isItemStatus(value: StatusChoice): value is InstalledItemStatus {
  return INSTALLED_ITEM_STATUS_ORDER.some((status) => status === value);
}

function statusGlyph(choice: StatusChoice | null): JSX.Element {
  if (choice === null) return <CircleDashedIcon size="sm" />;
  if (choice === 'installed') return <CheckIcon size="sm" />;
  if (choice === 'not-installed') return <PlusIcon size="sm" />;
  return <InstalledItemStatusIcon status={choice} />;
}

export interface CustomizeFilterPillsProps {
  readonly tab: MarketplaceTypeTabId;
  /** The host's applied Active / Available / Disabled filter; `null` is none. */
  readonly installedStatusFilter?: InstalledStatusFilterValue | null;
  /** Omitted where the host cannot filter by item status. */
  readonly onInstalledStatusFilterChange?: (
    value: InstalledStatusFilterValue | null,
  ) => void;
}

/**
 * New Customize's everyday filters, as pills between the search and the
 * funnel: Status (a dropdown of every status) and Shared (an on/off toggle).
 * The funnel keeps the rarely used ones. Shared by desktop and Portal; the
 * provider owns the Shared and Installed state, the host the item status.
 */
export function CustomizeFilterPills({
  tab,
  installedStatusFilter,
  onInstalledStatusFilterChange,
}: CustomizeFilterPillsProps): JSX.Element {
  const { filters, setFilters } = useCustomizeDiscoveryFilters();
  const shared = useCustomizeSharedWithMe();
  const byItemStatus =
    onInstalledStatusFilterChange !== undefined &&
    customizeTabHasInstalledStatuses(tab);
  const options = byItemStatus ? ITEM_STATUS_OPTIONS : PLAIN_STATUS_OPTIONS;
  const itemStatus =
    byItemStatus &&
    installedStatusFilter !== null &&
    installedStatusFilter !== undefined &&
    installedStatusFilter !== 'update-available'
      ? installedStatusFilter
      : null;
  // Installed is only offered where rows carry no status. The filters outlive
  // a tab change, so one picked on Workflows or Agents would stay applied on
  // a status tab with no menu row to show or clear it: reset it there, so the
  // trigger, the checked row and the applied filter always agree.
  const staleInstalled = byItemStatus && filters.status === 'installed';
  useEffect(() => {
    if (staleInstalled)
      setFilters((current) =>
        current.status === 'installed'
          ? { ...current, status: 'any' }
          : current,
      );
  }, [staleInstalled, setFilters]);
  const choice: StatusChoice | null =
    itemStatus ??
    (filters.status === 'installed' && !byItemStatus
      ? 'installed'
      : filters.status === 'available'
        ? 'not-installed'
        : null);
  const picked = options.find((option) => option.value === choice);
  const pick = (next: StatusChoice | null): void => {
    onInstalledStatusFilterChange?.(
      next !== null && isItemStatus(next) ? next : null,
    );
    setFilters({
      ...filters,
      status:
        next === 'installed'
          ? 'installed'
          : next === 'not-installed'
            ? 'available'
            : 'any',
    });
  };
  return (
    <>
      <FilterDropdown<StatusChoice>
        title="Status"
        label={picked?.label ?? 'Status'}
        anyLabel="Any status"
        options={options}
        selected={choice === null ? [] : [choice]}
        onToggle={(value): void => pick(value === choice ? null : value)}
        onClear={(): void => pick(null)}
        icon={statusGlyph(choice)}
        pill
        testId="customize-status-filter"
      />
      <PageToggleFilter
        label="Shared"
        icon={<UserGroupIcon size="sm" />}
        pressed={shared.active}
        onPressedChange={shared.setActive}
        count={shared.newCount}
        testId="customize-shared-with-me"
        countTestId="customize-shared-with-me-count"
      />
    </>
  );
}
