'use client';

import type { JSX } from 'react';
import {
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionLabel,
} from '../primitives/PickerParts';

export interface DirectoryPickerOptionRowProps {
  readonly name: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly 'data-testid'?: string;
}

/** The same working-directory option on desktop and the Portal. */
export function DirectoryPickerOptionRow({
  name,
  selected,
  onSelect,
  'data-testid': testId,
}: DirectoryPickerOptionRowProps): JSX.Element {
  return (
    <PickerOption
      role="option"
      aria-selected={selected}
      selected={selected}
      data-testid={testId}
      onMouseDown={(event): void => event.preventDefault()}
      onClick={onSelect}
    >
      <PickerOptionCheck selected={selected} reserveSpace />
      <PickerOptionContent>
        <PickerOptionLabel tone="quiet">{name}</PickerOptionLabel>
      </PickerOptionContent>
    </PickerOption>
  );
}
