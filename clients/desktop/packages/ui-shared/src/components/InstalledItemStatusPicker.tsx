'use client';

import { Button } from '../primitives/Button';
import { useId, useRef, useState, type JSX } from 'react';
import type {
  InstalledItemStatus,
  InstalledItemTarget,
} from '@canopy/protocol/installed-items';
import { CheckIcon, ChevronDownIcon } from '../icons/AppIcons';
import { InstalledItemStatusGlyphIcon } from '../icons/InstalledItemStatusGlyphIcon';
import { ItemStateMark, useItemStateMarks } from './ItemStateMark';
import {
  INSTALLED_ITEM_STATUS_COPY,
  INSTALLED_ITEM_STATUS_ORDER,
  installedItemStatusDescription,
} from '../lib/installed-item-status';
import { MenuItem, MenuItemIcon } from '../primitives/MenuItem';
import { Menu } from '../primitives/Menu';
import { LoadingSpinner } from '../primitives/LoadingSpinner';
import { Tooltip } from '../primitives/Tooltip';

/**
 * Active / Available / Disabled picker for one installed item (CAN-4255).
 *
 * Pure display: the host owns the status and the write. Each option pairs its
 * glyph with a label and a one-line description, and the selected option
 * carries a checkmark. A `disabledReason` renders the same trigger shape,
 * disabled and without a menu; it stays focusable, and its reason shows on
 * hover and keyboard focus and is the button's accessible description.
 */

/** A status, or a row whose status cannot be read. */
export type InstalledItemStatusGlyph = InstalledItemStatus | 'unavailable';

/**
 * One glyph per state (CAN-4261, CAN-5309): filled green for Active, filled
 * neutral for Available, an outline for Disabled, and a slashed outline for
 * Unavailable. A dashed circle read as loading. A read-only status keeps its
 * own glyph; the missing chevron and the tooltip say it cannot change.
 */
const STATUS_INK: Record<InstalledItemStatusGlyph, string> = {
  active: 'fg-success',
  available: 'fg-tertiary',
  disabled: 'fg-tertiary',
  unavailable: 'fg-tertiary',
};

/**
 * A state's icon in the picker, its menu and every status surface. New
 * Customize (the `customize-discovery` Labs experiment) draws the shared
 * `ItemStateMark`; with the experiment off the original dots stay.
 */
export function InstalledItemStatusIndicator({
  status,
  size = 14,
}: {
  readonly status: InstalledItemStatusGlyph;
  readonly size?: number;
}): JSX.Element {
  const marks = useItemStateMarks();
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      {marks ? (
        <ItemStateMark tone={status} size={size} />
      ) : (
        <InstalledItemStatusGlyphIcon
          status={status}
          className={STATUS_INK[status]}
        />
      )}
    </span>
  );
}

export interface InstalledItemStatusPickerProps {
  /** Names the item in the trigger's accessible name. */
  readonly itemName: string;
  readonly status: InstalledItemStatus;
  /** Omit to render the current status read-only. */
  readonly onChange?: (status: InstalledItemStatus) => void;
  /** A write for this item is in flight. */
  readonly busy?: boolean;
  readonly retryCurrent?: boolean;
  /** Why the status cannot change here; shown on hover and focus. */
  readonly disabledReason?: string;
  readonly testId?: string;
  /** Where the menu opens; a control leading its row opens to the right. */
  readonly menuPlacement?: 'bottom-right' | 'bottom-left';
  /** The item's kind, when known, for kind-specific status descriptions. */
  readonly targetKind?: InstalledItemTarget['kind'];
}

/**
 * The picker's trigger shape for a status that cannot change here: no menu
 * and no chevron, and the reason on hover and keyboard focus and as the
 * button's accessible description. The label keeps secondary ink, so it
 * reads at AA contrast (CAN-5309); the control stays inert.
 */
function DisabledStatusTrigger({
  label,
  ariaLabel,
  icon,
  reason,
  status,
  testId,
}: {
  readonly label: string;
  readonly ariaLabel: string;
  readonly icon: InstalledItemStatusGlyph;
  readonly reason: string;
  readonly status?: InstalledItemStatus;
  readonly testId: string;
}): JSX.Element {
  const reasonId = useId();
  return (
    <Tooltip label={reason} clamp={false}>
      <Button
        variant="ghost"
        size="compact"
        touchArea="contained"
        readOnlyAppearance
        data-testid={testId}
        data-status={status}
        aria-label={ariaLabel}
        aria-disabled="true"
        aria-describedby={reasonId}
      >
        <InstalledItemStatusIndicator status={icon} />
        <span className="fg-secondary">{label}</span>
        {/* Holds the chevron's place, so labels line up with live pickers. */}
        <span className="w-3 shrink-0" aria-hidden />
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      </Button>
    </Tooltip>
  );
}

/**
 * A row whose status cannot be read: the same control shape as the picker,
 * disabled, with the reason in its tooltip.
 */
export function InstalledItemStatusUnavailable({
  itemName,
  reason,
  testId = 'installed-item-status-unavailable',
}: {
  readonly itemName: string;
  readonly reason: string;
  readonly testId?: string;
}): JSX.Element {
  return (
    <DisabledStatusTrigger
      label="Unavailable"
      ariaLabel={`Status for ${itemName}: Unavailable`}
      icon="unavailable"
      reason={reason}
      testId={testId}
    />
  );
}

export function InstalledItemStatusPicker({
  itemName,
  status,
  onChange,
  busy = false,
  retryCurrent = false,
  disabledReason,
  testId = 'installed-item-status-picker',
  menuPlacement = 'bottom-right',
  targetKind,
}: InstalledItemStatusPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const copy = INSTALLED_ITEM_STATUS_COPY[status];
  const interactive = onChange !== undefined && disabledReason === undefined;
  const label = `Status for ${itemName}: ${copy.label}`;

  if (disabledReason !== undefined)
    return (
      <DisabledStatusTrigger
        label={copy.label}
        ariaLabel={label}
        icon={status}
        status={status}
        reason={disabledReason}
        testId={testId}
      />
    );
  if (!interactive) {
    return (
      <Button
        variant="ghost"
        size="compact"
        touchArea="contained"
        readOnlyAppearance
        data-testid={testId}
        data-status={status}
        aria-label={label}
        aria-disabled="true"
      >
        <InstalledItemStatusIndicator status={status} />
        {copy.label}
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="compact"
        touchArea="contained"
        ref={triggerRef}
        data-testid={testId}
        data-status={status}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy || undefined}
        // `aria-disabled`, not `disabled`: focus returns here after a pick,
        // and a disabled button would drop it to the page.
        aria-disabled={busy || undefined}
        onClick={(): void => setOpen((value) => !value)}
      >
        {busy ? (
          <LoadingSpinner sizePx={14} decorative />
        ) : (
          <InstalledItemStatusIndicator status={status} />
        )}
        {copy.label}
        <ChevronDownIcon size="sm" aria-hidden className="fg-tertiary" />
      </Button>
      <Menu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement={menuPlacement}
        data-testid={`${testId}-menu`}
        aria-label={`Status for ${itemName}`}
        className="w-64"
      >
        {INSTALLED_ITEM_STATUS_ORDER.map((option) => {
          const optionCopy = INSTALLED_ITEM_STATUS_COPY[option];
          const selected = option === status;
          return (
            <MenuItem
              key={option}
              role="menuitemradio"
              aria-checked={selected}
              multiline
              data-testid={`${testId}-option-${option}`}
              onClick={(): void => {
                setOpen(false);
                if (!selected || retryCurrent) onChange(option);
              }}
            >
              <MenuItemIcon>
                <InstalledItemStatusIndicator status={option} />
              </MenuItemIcon>
              <span className="min-w-0 flex-1">
                <span className="block font-medium fg-primary">
                  {optionCopy.label}
                </span>
                <span className="block text-xs fg-tertiary">
                  {installedItemStatusDescription(option, targetKind)}
                </span>
              </span>
              <MenuItemIcon>
                {selected && <CheckIcon size="sm" aria-hidden />}
              </MenuItemIcon>
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}

export { InstalledItemStatusIndicator as InstalledItemStatusIcon };
