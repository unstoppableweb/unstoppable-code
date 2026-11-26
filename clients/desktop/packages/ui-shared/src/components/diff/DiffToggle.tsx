import type { JSX } from 'react';
import { SegmentedControl } from '../../primitives/SegmentedControl';

/**
 * The shared segmented picker for independent diff comparison and layout
 * choices: a group of pressed segments sized to their labels.
 */
export interface DiffToggleProps<Value extends string> {
  value: Value;
  onChange: (next: Value) => void;
  options: ReadonlyArray<{ value: Value; label: string }>;
  /** Accessible name for the group. */
  label: string;
  dataTestId?: string;
}

export function DiffToggle<Value extends string>({
  value,
  onChange,
  options,
  label,
  dataTestId,
}: DiffToggleProps<Value>): JSX.Element {
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      label={label}
      width="content"
      dataTestId={dataTestId}
      options={options.map((option) => ({
        value: option.value,
        label: option.label,
        ...(dataTestId ? { dataTestId: `${dataTestId}-${option.value}` } : {}),
      }))}
    />
  );
}
