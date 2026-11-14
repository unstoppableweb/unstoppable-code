import type { JSX } from 'react';
import { Tooltip } from './Tooltip';

export interface AutoRoutedModelPillProps {
  /** Display name of the model routing picked for the turn. */
  label: string;
}

/**
 * Per-turn attribution for model routing: the model picked for the turn, shown
 * in the turn's timer row so each answer keeps a record of which model wrote
 * it. Shared by the desktop transcript and the web cloud / Remote Control
 * transcripts so every surface renders the same chip.
 */
export function AutoRoutedModelPill({
  label,
}: AutoRoutedModelPillProps): JSX.Element {
  // The clean chat look names the model in the footer's own text, after the
  // action icons, instead of a chip.

  return (
    <Tooltip label="Picked by model routing">
      <span data-testid="turn-auto-model" className="ml-1 text-s fg-secondary">
        {label}
      </span>
    </Tooltip>
  );
}
