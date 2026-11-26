import type { JSX } from 'react';
import { ProgressBar, type ProgressTone } from '../primitives/Progress';

/**
 * Meter tone: the accent for the used share, turning to warning and then
 * destructive as it nears the limit.
 */
function getMeterTone(percentage: number): ProgressTone {
  if (percentage >= 90) return 'destructive';
  if (percentage >= 70) return 'warning';
  return 'accent';
}

/** 44px tap floor on touch hardware (DESIGN.md), untouched on a mouse. */
export { USAGE_TOUCH_FLOOR_CLASS } from '../primitives/control-button-shared';

/** Whole percents read at a glance; a nonzero sliver never rounds to 0%. */
export function formatUsagePercent(percentage: number): string {
  if (percentage > 0 && percentage < 1) return '<1%';
  return `${Math.round(percentage)}%`;
}

export function UsageMeter({
  percentage,
  label,
}: {
  percentage: number;
  label: string;
}): JSX.Element {
  return (
    // The row above the meter names it and shows its percent.
    <ProgressBar
      value={percentage}
      tone={getMeterTone(percentage)}
      label={label}
      hideLabel
    />
  );
}
