'use client';

import { Button } from './Button';
import { useId, useRef, useState, type JSX } from 'react';
import type {
  InstalledItemStatus,
  InstalledItemTarget,
} from '@canopy/protocol/installed-items';
import { CheckIcon, ChevronDownIcon } from '../icons/AppIcons';
import {
  INSTALLED_ITEM_STATUS_COPY,
  INSTALLED_ITEM_STATUS_ORDER,
  installedItemStatusDescription,
} from '../lib/installed-item-status';
import { DropdownMenuItem, DropdownMenuItemIcon } from './DropdownMenu';
import { FloatingMenu } from './FloatingMenu';
import { LoadingSpinner } from './LoadingSpinner';
import { Tooltip } from './Tooltip';

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

function StatusGlyph({
  status,
}: {
  readonly status: InstalledItemStatusGlyph;
}): JSX.Element {
  if (status === 'active' || status === 'available')
    return <circle cx="4" cy="4" r="4" fill="currentColor" />;
  return (
    <>
      <circle
        cx="4"
        cy="4"
        r="3.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {status === 'unavailable' && (
        <path
          data-status-slash
          d="M1.7 6.3 6.3 1.7"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
    </>
  );
}

export function InstalledItemStatusIcon({
  status,
  size = 14,
}: {
  readonly status: InstalledItemStatusGlyph;
  readonly size?: number;
}): JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        data-status-dot={status}
        width="8"
        height="8"
        viewBox="0 0 8 8"
        className={`shrink-0 ${STATUS_INK[status]}`}
      >
        <StatusGlyph status={status} />
      </svg>
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
    <Tooltip label={reason}>
      <Button
        variant="ghost-overlay"
        size="compact"
        touchArea="contained"
        readOnlyAppearance
        data-testid={testId}
        data-status={status}
        aria-label={ariaLabel}
        aria-disabled="true"
        aria-describedby={reasonId}
      >
        <InstalledItemStatusIcon status={icon} />
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
        variant="ghost-overlay"
        size="compact"
        touchArea="contained"
        data-testid={testId}
        data-status={status}
        aria-label={label}
        aria-disabled="true"
      >
        <InstalledItemStatusIcon status={status} />
        {copy.label}
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="ghost-overlay"
        size="compact"
        touchArea="contained"
        ref={triggerRef}
        data-testid={testId}
        data-status={status}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={(): void => setOpen((value) => !value)}
      >
        {busy ? (
          <LoadingSpinner sizePx={14} decorative />
        ) : (
          <InstalledItemStatusIcon status={status} />
        )}
        {copy.label}
        <ChevronDownIcon size="sm" aria-hidden className="fg-tertiary" />
      </Button>
      <FloatingMenu
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
            <DropdownMenuItem
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
              <DropdownMenuItemIcon>
                <InstalledItemStatusIcon status={option} />
              </DropdownMenuItemIcon>
              <span className="min-w-0 flex-1">
                <span className="block font-medium fg-primary">
                  {optionCopy.label}
                </span>
                <span className="block text-xs fg-tertiary">
                  {installedItemStatusDescription(option, targetKind)}
                </span>
              </span>
              <DropdownMenuItemIcon>
                {selected && <CheckIcon size="sm" aria-hidden />}
              </DropdownMenuItemIcon>
            </DropdownMenuItem>
          );
        })}
      </FloatingMenu>
    </>
  );
}
