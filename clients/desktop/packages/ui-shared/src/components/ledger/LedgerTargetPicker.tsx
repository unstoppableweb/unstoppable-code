'use client';

import { useId, useRef, useState, type JSX } from 'react';
import {
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuOptionTrailing,
  PickerTrigger,
  PickerTriggerChevron,
} from '../PickerMenu';
import { Tooltip } from '../Tooltip';

export interface LedgerTargetOption {
  readonly id: string;
  readonly label: string;
  /** Why it can't be chosen now, such as "Has a draft", shown at its end. */
  readonly unavailable?: string;
}

export interface LedgerTargetPickerProps {
  /** The trigger's ID, which the field's visible label activates. */
  readonly id: string;
  /** The visible label; the trigger reads as that label, then its value. */
  readonly labelId: string;
  readonly options: readonly LedgerTargetOption[];
  /** The chosen option's ID; null shows the placeholder. */
  readonly value: string | null;
  readonly placeholder: string;
  readonly disabled?: boolean;
  /** Why the field can't change now, as its tooltip. */
  readonly disabledReason?: string;
  readonly onSelect: (id: string) => void;
  /** The trigger's; the menu and its rows take `-menu` and `-option`. */
  readonly 'data-testid': string;
}

/**
 * One level of where a new entry goes, such as its project or task, as a
 * form field. Every row stays listed: one that can't be chosen says why.
 */
export function LedgerTargetPicker({
  id,
  labelId,
  options,
  value,
  placeholder,
  disabled = false,
  disabledReason,
  onSelect,
  'data-testid': testId,
}: LedgerTargetPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const valueId = useId();
  const chosen = options.find((option) => option.id === value);
  const trigger = (
    <PickerTrigger
      ref={triggerRef}
      id={id}
      variant="field"
      // With a reason, it stays focusable (aria-disabled, not disabled),
      // so keyboard and hover both reach the reason's tooltip.
      disabled={disabled && disabledReason === undefined}
      unavailable={disabled}
      coarsePointerTarget
      aria-haspopup="menu"
      aria-expanded={open}
      aria-labelledby={`${labelId} ${valueId}`}
      data-testid={testId}
      data-placeholder={chosen === undefined ? 'true' : undefined}
      className="w-full justify-between"
      onClick={() => {
        if (!disabled) setOpen((previous) => !previous);
      }}
    >
      <span
        id={valueId}
        className={`truncate ${chosen === undefined ? 'fg-tertiary' : ''}`}
      >
        {chosen?.label ?? placeholder}
      </span>
      <PickerTriggerChevron open={open} variant="field" />
    </PickerTrigger>
  );
  return (
    <div className="relative min-w-0">
      {disabled && disabledReason !== undefined ? (
        <Tooltip label={disabledReason} allowShrink className="w-full">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <FloatingPickerMenu
        open={open}
        openOnArrowKeys={!disabled}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        heightLimit={360}
        interaction="menu"
        data-testid={`${testId}-menu`}
      >
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <PickerMenuOption
              key={option.id}
              role="menuitemradio"
              aria-checked={selected}
              selected={selected}
              disabled={option.unavailable !== undefined}
              title={option.label}
              data-testid={`${testId}-option`}
              data-option-id={option.id}
              onClick={() => {
                if (!selected) onSelect(option.id);
              }}
            >
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>{option.label}</PickerMenuOptionLabel>
              </PickerMenuOptionContent>
              {option.unavailable !== undefined && (
                <PickerMenuOptionTrailing tone="tertiary">
                  {option.unavailable}
                </PickerMenuOptionTrailing>
              )}
              <PickerMenuOptionCheck selected={selected} />
            </PickerMenuOption>
          );
        })}
      </FloatingPickerMenu>
    </div>
  );
}
