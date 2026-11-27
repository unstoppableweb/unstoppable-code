'use client';

import { useId, useRef, useState, type JSX } from 'react';
import type { LedgerPublicEntryType } from '@canopy/protocol/canopy-core';
import {
  LEDGER_ENTRY_TYPE_LABELS,
  LEDGER_FORM_TYPE_OPTIONS,
} from '../../lib/ledger-display';
import { Picker } from '../../primitives/Picker';
import {
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionLabel,
  PickerOptionLeading,
  PickerTrigger,
  PickerTriggerChevron,
} from '../../primitives/PickerParts';
import { LedgerEntryTypeIcon } from '../../icons/LedgerEntryTypeIcon';

export interface LedgerEntryTypePickerProps {
  value: LedgerPublicEntryType;
  onChange: (type: LedgerPublicEntryType) => void;
  disabled?: boolean;
  /** The trigger's ID, which the form's visible label activates. */
  id?: string;
  /** The visible label; the trigger reads as that label, then the value. */
  labelId: string;
}

/**
 * Chooses a new entry's type inside the entry form. A picker rather than a
 * native select so each type keeps its glyph, in the field and in the menu.
 */
export function LedgerEntryTypePicker({
  value,
  onChange,
  disabled = false,
  id,
  labelId,
}: LedgerEntryTypePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const valueId = useId();
  return (
    <div className="relative min-w-0">
      <PickerTrigger
        ref={triggerRef}
        id={id}
        variant="field"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        data-testid="ledger-entry-form-type"
        data-type={value}
        coarsePointerTarget
        className="w-full justify-between"
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <LedgerEntryTypeIcon type={value} />
          <span id={valueId} className="truncate">
            {LEDGER_ENTRY_TYPE_LABELS[value]}
          </span>
        </span>
        <PickerTriggerChevron open={open} variant="field" />
      </PickerTrigger>
      <Picker
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        interaction="menu"
        data-testid="ledger-entry-form-type-menu"
      >
        {LEDGER_FORM_TYPE_OPTIONS.map((type) => {
          const selected = type === value;
          return (
            <PickerOption
              key={type}
              role="menuitemradio"
              aria-checked={selected}
              selected={selected}
              data-testid={`ledger-entry-form-type-option-${type.toLowerCase()}`}
              onClick={() => {
                if (!selected) onChange(type);
              }}
            >
              <PickerOptionLeading tone="secondary">
                <LedgerEntryTypeIcon type={type} />
              </PickerOptionLeading>
              <PickerOptionContent>
                <PickerOptionLabel>
                  {LEDGER_ENTRY_TYPE_LABELS[type]}
                </PickerOptionLabel>
              </PickerOptionContent>
              <PickerOptionCheck selected={selected} />
            </PickerOption>
          );
        })}
      </Picker>
    </div>
  );
}
