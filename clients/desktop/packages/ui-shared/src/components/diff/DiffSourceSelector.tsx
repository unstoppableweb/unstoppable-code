import type { JSX } from 'react';
import { SegmentedControl } from '../../primitives/SegmentedControl';

/**
 * Diff source selection — which set of changes the diff viewer is currently
 * rendering. Mirrors the desktop `FileDiffSource` union but kept portable so
 * both apps can drive it from the same component.
 */
export type DiffSource = 'uncommitted' | 'committed' | 'combined';

export interface DiffSourceSelectorOption {
  value: DiffSource;
  label: string;
}

export interface DiffSourceSelectorProps {
  /** Currently selected source. */
  value: DiffSource;
  /** Callback fired when the user picks a different source. */
  onChange: (next: DiffSource) => void;
  /** Optional override of the available options. Defaults to all three. */
  options?: DiffSourceSelectorOption[];
  /** Test ID hook for automation. */
  dataTestId?: string;
}

const DEFAULT_OPTIONS: DiffSourceSelectorOption[] = [
  { value: 'uncommitted', label: 'Uncommitted' },
  { value: 'committed', label: 'Committed' },
  { value: 'combined', label: 'Combined' },
];

/**
 * Segmented control for choosing which diff source the viewer should render.
 * Pure display; caller owns dispatch and option list.
 */
export function DiffSourceSelector({
  value,
  onChange,
  options,
  dataTestId,
}: DiffSourceSelectorProps): JSX.Element {
  const resolved = options ?? DEFAULT_OPTIONS;
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      label="Diff source"
      width="content"
      dataTestId={dataTestId}
      options={resolved.map((opt) => ({
        value: opt.value,
        label: opt.label,
        ...(dataTestId ? { dataTestId: `${dataTestId}-${opt.value}` } : {}),
      }))}
    />
  );
}
