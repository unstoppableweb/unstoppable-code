'use client';

import { useRef, useState, type JSX } from 'react';
import { CheckIcon, RefreshIcon } from '../icons/AppIcons';
import {
  INSTALLED_ITEM_STATUS_COPY,
  INSTALLED_ITEM_STATUS_ORDER,
  INSTALLED_STATUS_FILTER_UPDATE_AVAILABLE_DESCRIPTION,
  installedStatusFilterLabel,
  type InstalledStatusFilterValue,
} from '../lib/installed-item-status';
import {
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuRowStyleProvider,
  QUIET_MENU_ROW_STYLE,
} from './DropdownMenu';
import { FloatingMenu } from './FloatingMenu';
import { InstalledItemStatusIcon } from './InstalledItemStatusPicker';
import { PickerTrigger, PickerTriggerChevron } from './PickerMenu';

/**
 * Any status / Active / Available / Disabled filter after the Customize
 * search (CAN-4838): a page search row's quiet dropdown. Pure display: the host owns the applied value. Status
 * rows reuse the item picker's glyphs and descriptions. Update available
 * (CAN-5309) follows them where the host surfaces updates for the tab.
 */
export interface InstalledStatusFilterDropdownProps {
  /** `null` is Any status. */
  readonly value: InstalledStatusFilterValue | null;
  readonly onChange: (value: InstalledStatusFilterValue | null) => void;
  /** Offers Update available after the statuses. */
  readonly includeUpdateAvailable?: boolean;
  readonly testId?: string;
}

const STATUS_OPTIONS: readonly (InstalledStatusFilterValue | null)[] = [
  null,
  ...INSTALLED_ITEM_STATUS_ORDER,
];
const UPDATE_OPTIONS: readonly (InstalledStatusFilterValue | null)[] = [
  ...STATUS_OPTIONS,
  'update-available',
];

/** Updates are not a status, so their glyph is the update marker's. */
function FilterOptionGlyph({
  option,
}: {
  readonly option: InstalledStatusFilterValue;
}): JSX.Element {
  if (option !== 'update-available')
    return <InstalledItemStatusIcon status={option} />;
  return (
    <span
      aria-hidden="true"
      data-filter-glyph={option}
      className="inline-flex size-3.5 shrink-0 items-center justify-center fg-info"
    >
      <RefreshIcon size="xs" aria-hidden="true" />
    </span>
  );
}

function optionDescription(option: InstalledStatusFilterValue): string {
  return option === 'update-available'
    ? INSTALLED_STATUS_FILTER_UPDATE_AVAILABLE_DESCRIPTION
    : INSTALLED_ITEM_STATUS_COPY[option].description;
}

export function InstalledStatusFilterDropdown({
  value,
  onChange,
  includeUpdateAvailable = false,
  testId = 'customize-installed-status-filter',
}: InstalledStatusFilterDropdownProps): JSX.Element {
  const options = includeUpdateAvailable ? UPDATE_OPTIONS : STATUS_OPTIONS;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = installedStatusFilterLabel(value);
  return (
    <>
      <PickerTrigger
        ref={triggerRef}
        variant="capsule"
        size="page"
        labelOnly={value === null}
        className="shrink-0"
        data-testid={testId}
        data-status={value ?? 'any'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Filter installed items by status: ${label}`}
        onClick={(): void => setOpen((current) => !current)}
      >
        {value !== null && <FilterOptionGlyph option={value} />}
        <span className="whitespace-nowrap">{label}</span>
        <PickerTriggerChevron open={open} />
      </PickerTrigger>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        data-testid={`${testId}-menu`}
        aria-label="Filter installed items by status"
        className="w-64"
      >
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          {options.map((option) => {
            const selected = option === value;
            return (
              <DropdownMenuItem
                key={option ?? 'any'}
                role="menuitemradio"
                aria-checked={selected}
                multiline
                data-testid={`${testId}-option-${option ?? 'any'}`}
                onClick={(): void => {
                  setOpen(false);
                  onChange(option);
                }}
              >
                <DropdownMenuItemIcon>
                  {option !== null && <FilterOptionGlyph option={option} />}
                </DropdownMenuItemIcon>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium fg-primary">
                    {installedStatusFilterLabel(option)}
                  </span>
                  {option !== null && (
                    <span className="block text-xs fg-tertiary">
                      {optionDescription(option)}
                    </span>
                  )}
                </span>
                <DropdownMenuItemIcon>
                  {selected && <CheckIcon size="sm" aria-hidden />}
                </DropdownMenuItemIcon>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}
