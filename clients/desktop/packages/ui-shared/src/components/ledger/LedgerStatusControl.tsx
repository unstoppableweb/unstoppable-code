'use client';

import { ControlButton } from '../Button';
import { useId, useRef, useState, type JSX, type MouseEvent } from 'react';
import type { LedgerStatus } from '@canopy/protocol/canopy-core';
import {
  LEDGER_CLOSING_STATUS_OPTIONS,
  LEDGER_OPEN_STATUS_OPTIONS,
  LEDGER_STATUS_LABELS,
} from '../../lib/ledger-display';
import {
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuSection,
  PickerMenuSectionLabel,
  PickerTrigger,
  PickerTriggerChevron,
  type PickerTriggerVariant,
} from '../PickerMenu';
import { ChevronDownIcon } from '../../icons/AppIcons';
import { LedgerStatusLabel } from './LedgerStatusLabel';
import { LedgerStatusGlyph } from './LedgerStatusPill';

export interface LedgerStatusControlProps {
  status: LedgerStatus;
  /** A change is being saved; the control waits for it. */
  saving?: boolean;
  onChange: (status: LedgerStatus) => void;
  /**
   * `capsule` beside an entry's details, `inline` in place of a row's status
   * pill, or `field` inside a form, named by `labelId`.
   */
  variant?: PickerTriggerVariant | 'inline';
  /** In a form: the trigger's ID, which the visible label activates. */
  id?: string;
  /** In a form: the visible label; the trigger reads as it, then the value. */
  labelId?: string;
  'data-testid'?: string;
}

/**
 * An open entry's status, changeable in place, or a new entry's in its form.
 * The statuses that close an entry are listed apart: once one is chosen, the
 * entry's status and owner never change again.
 */
export function LedgerStatusControl({
  status,
  saving = false,
  onChange,
  variant = 'capsule',
  id,
  labelId,
  'data-testid': testId = 'ledger-status-control',
}: LedgerStatusControlProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const valueId = useId();
  const field = variant === 'field';
  const ariaLabel = `Change status, now ${LEDGER_STATUS_LABELS[status]}`;
  const ariaLabelProps =
    variant === 'field' && labelId !== undefined
      ? { 'aria-labelledby': `${labelId} ${valueId}` }
      : { 'aria-label': ariaLabel };
  // While saving it stays focusable (aria-disabled, not disabled): focus
  // returns here after a pick, and disabling it would drop focus.
  const onTriggerClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (saving) return;
    setOpen((previous) => !previous);
  };
  const option = (value: LedgerStatus): JSX.Element => {
    const selected = value === status;
    return (
      <PickerMenuOption
        key={value}
        role="menuitemradio"
        aria-checked={selected}
        selected={selected}
        data-testid={`ledger-status-option-${value.toLowerCase()}`}
        onClick={() => {
          if (!selected) onChange(value);
        }}
      >
        <PickerMenuOptionContent>
          <PickerMenuOptionLabel>
            {LEDGER_STATUS_LABELS[value]}
          </PickerMenuOptionLabel>
        </PickerMenuOptionContent>
        <PickerMenuOptionCheck selected={selected} />
      </PickerMenuOption>
    );
  };
  return (
    <div
      className={
        field
          ? 'relative min-w-0'
          : variant === 'inline'
            ? // A flex box, so the pill sets the height and no line box does.
              'relative flex shrink-0'
            : 'relative shrink-0'
      }
    >
      {variant === 'inline' ? (
        // The row's status pill, as the control that changes it.
        <ControlButton
          ref={triggerRef}
          type="button"
          id={id}
          aria-disabled={saving || undefined}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={ariaLabel}
          data-testid={testId}
          data-status={status}
          onClick={onTriggerClick}
          presentation="ledger-status-trigger"
          appearance={{ status }}
        >
          <LedgerStatusGlyph status={status} />
          {LEDGER_STATUS_LABELS[status]}
          <ChevronDownIcon size="sm" aria-hidden="true" className="shrink-0" />
        </ControlButton>
      ) : (
        <PickerTrigger
          ref={triggerRef}
          id={id}
          variant={variant}
          unavailable={saving}
          coarsePointerTarget
          aria-haspopup="menu"
          aria-expanded={open}
          {...ariaLabelProps}
          data-testid={testId}
          data-status={status}
          className={field ? 'w-full justify-between' : '-mx-2.5'}
          onClick={onTriggerClick}
        >
          {field ? (
            <span id={valueId} className="truncate">
              {LEDGER_STATUS_LABELS[status]}
            </span>
          ) : (
            <LedgerStatusLabel status={status} />
          )}
          <PickerTriggerChevron open={open} variant={variant} />
        </PickerTrigger>
      )}
      <FloatingPickerMenu
        open={open}
        openOnArrowKeys={!saving}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        interaction="menu"
        data-testid="ledger-status-menu"
      >
        {LEDGER_OPEN_STATUS_OPTIONS.map(option)}
        <PickerMenuSection>
          <PickerMenuSectionLabel>Closes the entry</PickerMenuSectionLabel>
          {LEDGER_CLOSING_STATUS_OPTIONS.map(option)}
        </PickerMenuSection>
      </FloatingPickerMenu>
    </div>
  );
}
