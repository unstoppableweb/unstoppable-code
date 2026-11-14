'use client';

import type { JSX } from 'react';
import { Checkbox } from '@canopy/ui-shared/components';
import type { SelectAllState } from './review-model';

export interface SelectionCheckboxProps {
  readonly state: SelectAllState;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onToggle: () => void;
  readonly testId?: string;
}

/** The shared `Checkbox`, mixed while some rows are selected. */
export function SelectionCheckbox({
  state,
  label,
  disabled = false,
  onToggle,
  testId,
}: SelectionCheckboxProps): JSX.Element {
  return (
    <Checkbox
      checked={state === 'all'}
      indeterminate={state === 'some'}
      disabled={disabled}
      aria-label={label}
      onChange={onToggle}
      data-testid={testId}
    />
  );
}
