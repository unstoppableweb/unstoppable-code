'use client';

import type { JSX } from 'react';
import {
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
} from '../primitives/PickerMenu';

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
    <PickerMenuOption
      role="option"
      aria-selected={selected}
      selected={selected}
      data-testid={testId}
      onMouseDown={(event): void => event.preventDefault()}
      onClick={onSelect}
    >
      <PickerMenuOptionCheck selected={selected} reserveSpace />
      <PickerMenuOptionContent>
        <PickerMenuOptionLabel tone="quiet">{name}</PickerMenuOptionLabel>
      </PickerMenuOptionContent>
    </PickerMenuOption>
  );
}
