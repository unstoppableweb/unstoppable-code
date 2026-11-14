/**
 * The chart kit's shared look, as plain recharts props. Kept free of recharts
 * so a shell can import it eagerly. Axis lines, grid direction and palettes
 * still differ between the usage page and team statistics.
 */

/** The dash of every chart's grid. */
export const CHART_GRID_DASH = '3 3';

/** Grid and axis line color. */
export const CHART_LINE = 'var(--line-base)';

/** Axis tick ink. */
export const CHART_TICK_INK = 'var(--fg-secondary)';

/** Axis tick size, in px. */
export const CHART_TICK_FONT_SIZE = 11;

/** `tick` for an axis that draws its own text. */
export const CHART_TICK = {
  fontSize: CHART_TICK_FONT_SIZE,
  fill: CHART_TICK_INK,
} as const;

/** The band behind a hovered bar group. */
export const CHART_BAR_CURSOR = {
  fill: 'var(--bg-accent-subtle)',
  opacity: 0.3,
} as const;
