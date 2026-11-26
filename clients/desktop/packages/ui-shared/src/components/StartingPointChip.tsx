import type { JSX } from 'react';
import { Chip } from '../primitives/Chip';
import { Tooltip } from '../primitives/Tooltip';

export interface StartingPointChipProps {
  /** The starting point's name, the chip's label. */
  name: string;
  /** What it sets up, shown in the tooltip; empty shows none. */
  description: string;
  selected: boolean;
  disabled?: boolean;
  /** Pressing the chip selects it; pressing the selected chip clears it. */
  onToggle: () => void;
  /** Test id for the chip's toggle button. */
  'data-testid'?: string;
}

/** A starting point's description wraps in its tooltip. */
const TOOLTIP_CLASS = 'max-w-64 whitespace-normal';

/**
 * One starting point (a Blueprint or a shared template) when creating a
 * project, on desktop and web: a selectable `Chip` with its description in
 * the tooltip. A toggle rather than a radio: the choice is optional and
 * pressing the selected chip clears it, which a radio group cannot express.
 */
export function StartingPointChip({
  name,
  description,
  selected,
  disabled = false,
  onToggle,
  'data-testid': testId,
}: StartingPointChipProps): JSX.Element {
  return (
    // The wrapper may shrink to the row so a long name truncates inside
    // the chip instead of pushing it past the dialog edge.
    <Tooltip
      label={description}
      disabled={description === ''}
      delay="long"
      allowShrink
      className="max-w-full"
      contentClassName={TOOLTIP_CLASS}
    >
      <Chip
        onClick={onToggle}
        selected={selected}
        disabled={disabled}
        actionTestId={testId}
      >
        {name}
      </Chip>
    </Tooltip>
  );
}
