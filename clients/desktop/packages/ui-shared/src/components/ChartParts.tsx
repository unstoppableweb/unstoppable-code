import type { JSX } from 'react';
import { richHoverTooltipSurfaceClassName } from './RichHoverTooltip';
import { Surface } from './Surface';

/** How a tooltip row marks its series: a bar's square, a line's dash, or nothing. */
export type ChartTooltipMarker = 'swatch' | 'line' | 'none';

/** One row of a {@link ChartTooltip}, as the chart library hands it over. */
export interface ChartTooltipEntry {
  readonly name: string;
  readonly value: number;
  /** The series key the row belongs to. */
  readonly dataKey: unknown;
  /** The chart row the value came from. */
  readonly row: unknown;
}

export interface ChartTooltipProps {
  readonly active?: boolean;
  /** Whether the chart enables keyboard accessibility announcements. */
  readonly accessibilityLayer?: boolean;
  /** The hovered bucket or category. */
  readonly label?: unknown;
  /** One entry per series. */
  readonly payload?: readonly unknown[];
  readonly marker?: ChartTooltipMarker;
  readonly formatValue: (value: number, entry: ChartTooltipEntry) => string;
  readonly formatLabel?: (label: string) => string;
}

function field(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null
    ? Reflect.get(source, key)
    : undefined;
}

function markerColor(entry: unknown, marker: ChartTooltipMarker): unknown {
  if (marker === 'none') return undefined;
  return field(entry, marker === 'line' ? 'stroke' : 'color');
}

function labelText(label: unknown): string {
  if (typeof label === 'string') return label;
  return typeof label === 'number' ? String(label) : '';
}

/**
 * What a chart shows on hover: the bucket's name over one row per series. The
 * chart library positions it; it draws on the tooltip surface.
 */
export function ChartTooltip({
  active,
  accessibilityLayer,
  label,
  payload,
  marker = 'swatch',
  formatValue,
  formatLabel,
}: ChartTooltipProps): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  const title = labelText(label);
  return (
    <div
      className={richHoverTooltipSurfaceClassName({})}
      role={accessibilityLayer ? 'status' : undefined}
      aria-live={accessibilityLayer ? 'assertive' : undefined}
    >
      <div className="flex flex-col gap-1">
        {title ? (
          <div className="font-semibold">
            {formatLabel ? formatLabel(title) : title}
          </div>
        ) : null}
        {payload.map((entry, index) => {
          const name = field(entry, 'name');
          const value = Number(field(entry, 'value'));
          const color = markerColor(entry, marker);
          const row: ChartTooltipEntry = {
            name: typeof name === 'string' ? name : '',
            value: Number.isFinite(value) ? value : 0,
            dataKey: field(entry, 'dataKey'),
            row: field(entry, 'payload'),
          };
          return (
            <div
              key={index}
              className="flex items-center gap-2 whitespace-nowrap"
            >
              {typeof color === 'string' ? (
                <span
                  aria-hidden="true"
                  className={
                    marker === 'line'
                      ? 'inline-block h-0.5 w-3'
                      : 'inline-block h-2 w-2 rounded-sm'
                  }
                  style={{ backgroundColor: color }}
                />
              ) : null}
              <span className="fg-secondary">{row.name}</span>
              <span className="ml-auto pl-2 tabular-nums">
                {formatValue(row.value, row)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface ChartEmptyProps {
  /** One short sentence: `No data for this range`. */
  readonly label: string;
  /** The height the chart would take, so nothing moves when data arrives. */
  readonly heightPx: number;
  /**
   * `small` is the compact box of a chart inside a dense page section (the
   * usage page): smaller corners and extra-small type.
   */
  readonly size?: 'default' | 'small';
}

/** A chart with nothing to plot: a dashed box in the chart's own place. */
export function ChartEmpty({
  label,
  heightPx,
  size = 'default',
}: ChartEmptyProps): JSX.Element {
  return (
    <div
      className="flex w-full"
      style={{ height: heightPx }}
      data-testid="chart-empty"
    >
      <Surface variant="dashed" size={size} className="w-full">
        <div
          className={`flex h-full items-center justify-center px-4 fg-secondary ${size === 'small' ? 'text-xs' : 'text-s'}`}
        >
          {label}
        </div>
      </Surface>
    </div>
  );
}
