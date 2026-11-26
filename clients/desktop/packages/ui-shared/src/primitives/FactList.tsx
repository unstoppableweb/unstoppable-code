'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';

/**
 * The compact fact list: a label column and a value column, for the small
 * lists of facts in panels, dialogs, cards and popovers (a subagent's setup,
 * a cost row's details, a clone's source and destination). Detail pages use
 * the Settings row kit instead (docs/design/pages.md).
 *
 * The `stacked` layout puts each label above its value instead, in one or
 * more columns: for long values such as paths and ids, and, with large
 * values, for a row of stat tiles (design calls 2A and 3A, 2026-10-31).
 *
 * The `spread` layout puts each value on the trailing edge of its own row,
 * for facts on a tooltip. The `inline` layout runs the facts along one
 * wrapping line, for a chart legend.
 *
 * The list owns the grid, the type size, the spacing and the label ink; each
 * `Fact` is one label and its value. Every option is spelled out so Tailwind
 * emits it; there is no class passthrough beyond placement.
 */

/** Width of the label column: `auto` sizes it to the longest label. */
export type FactListLabelWidth =
  | 'auto'
  | '3.5rem'
  | '5rem'
  | '6rem'
  | '6.5rem'
  | '7rem'
  | '9rem';
export type FactListSize = '2xs' | 'xs' | 's' | 'inherit';
export type FactListRowGap = '0.5' | '1' | '1.5' | '2' | '3';
export type FactListColumnGap = '2' | '3' | '4';
/** `inherit`: the surface's own ink, dimmed, for a list on a tooltip. */
export type FactLabelTone = 'secondary' | 'tertiary' | 'inherit';

const LABEL_WIDTH_CLASS: Record<FactListLabelWidth, string> = {
  auto: 'grid-cols-[auto_minmax(0,1fr)]',
  '3.5rem': 'grid-cols-[3.5rem_minmax(0,1fr)]',
  '5rem': 'grid-cols-[5rem_minmax(0,1fr)]',
  '6rem': 'grid-cols-[6rem_minmax(0,1fr)]',
  '6.5rem': 'grid-cols-[6.5rem_minmax(0,1fr)]',
  '7rem': 'grid-cols-[7rem_minmax(0,1fr)]',
  '9rem': 'grid-cols-[9rem_minmax(0,1fr)]',
};

const SIZE_CLASS: Record<FactListSize, string> = {
  '2xs': ' text-2xs leading-snug',
  xs: ' text-xs',
  s: ' text-s',
  inherit: '',
};

const ROW_GAP_CLASS: Record<FactListRowGap, string> = {
  '0.5': ' gap-y-0.5',
  '1': ' gap-y-1',
  '1.5': ' gap-y-1.5',
  '2': ' gap-y-2',
  '3': ' gap-y-3',
};

const COLUMN_GAP_CLASS: Record<FactListColumnGap, string> = {
  '2': ' gap-x-2',
  '3': ' gap-x-3',
  '4': ' gap-x-4',
};

const LABEL_TONE_CLASS: Record<FactLabelTone, string> = {
  secondary: 'fg-secondary',
  tertiary: 'fg-tertiary',
  inherit: 'opacity-70',
};

/** `control`: every row at least a control's height, its cells centered. */
export type FactListRowHeight = 'auto' | 'control';

const ROW_HEIGHT_CLASS: Record<FactListRowHeight, string> = {
  auto: '',
  control: ' auto-rows-[minmax(1.75rem,auto)] items-center',
};

/**
 * `columns`: a label column beside a value column. `stacked`: each label above
 * its value, the facts laid out in `columns` columns. `spread`: one row per
 * fact, the value on the trailing edge. `inline`: the facts on one wrapping
 * line.
 */
export type FactListLayout = 'columns' | 'stacked' | 'spread' | 'inline';

/** Columns of a stacked list; `4` is two columns on a phone-width screen. */
export type FactListColumns = 1 | 2 | 4;

const STACKED_COLUMNS_CLASS: Record<FactListColumns, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  4: 'grid-cols-2 sm:grid-cols-4',
};

/** A stacked list's value size: `large` for stat tiles. */
export type FactValueSize = 'default' | 'large';

/** `inherit`: the surface's own ink, for a list on a tooltip. */
export type FactValueTone = 'primary' | 'secondary' | 'destructive' | 'inherit';

const VALUE_TONE_CLASS: Record<FactValueTone, string> = {
  primary: 'fg-primary',
  secondary: 'fg-secondary',
  destructive: 'fg-destructive',
  inherit: 'opacity-90',
};

interface FactListContextValue {
  readonly labelTone: FactLabelTone;
  readonly labelMono: boolean;
  readonly valueTone: FactValueTone;
  readonly layout: FactListLayout;
  readonly valueSize: FactValueSize;
}

const FactListContext = createContext<FactListContextValue>({
  labelTone: 'tertiary',
  labelMono: false,
  valueTone: 'primary',
  layout: 'columns',
  valueSize: 'default',
});

export interface FactListProps {
  readonly layout?: FactListLayout;
  /** Columns of a `stacked` list; ignored by `columns`. */
  readonly columns?: FactListColumns;
  /** Value size of a `stacked` list; ignored by `columns`. */
  readonly valueSize?: FactValueSize;
  /** Width of the label column of a `columns` list; ignored by `stacked`. */
  readonly labelWidth?: FactListLabelWidth;
  readonly size?: FactListSize;
  readonly rowGap?: FactListRowGap;
  readonly rowHeight?: FactListRowHeight;
  readonly columnGap?: FactListColumnGap;
  readonly labelTone?: FactLabelTone;
  /** Monospaced labels, for literal keys such as a file's frontmatter. */
  readonly labelMono?: boolean;
  /** Every value's ink, unless a `Fact` sets its own; primary by default. */
  readonly valueTone?: FactValueTone;
  /** A rule above the list, for a list that follows other content in a card. */
  readonly divided?: boolean;
  readonly dataTestId?: string;
  readonly children?: ReactNode;
}

export function FactList({
  layout = 'columns',
  columns = 1,
  valueSize = 'default',
  labelWidth = 'auto',
  size = 'xs',
  rowGap = '1.5',
  rowHeight = 'auto',
  columnGap = '4',
  labelTone = 'tertiary',
  labelMono = false,
  valueTone = 'primary',
  divided = false,
  dataTestId,
  children,
}: FactListProps): JSX.Element {
  const layoutClass: Record<FactListLayout, string> = {
    columns: `grid ${LABEL_WIDTH_CLASS[labelWidth]}`,
    stacked: `grid ${STACKED_COLUMNS_CLASS[columns]}`,
    spread: 'flex flex-col',
    inline: 'flex flex-wrap',
  };
  const className = `${layoutClass[layout]}${COLUMN_GAP_CLASS[columnGap]}${ROW_GAP_CLASS[rowGap]}${ROW_HEIGHT_CLASS[rowHeight]}${SIZE_CLASS[size]}${divided ? ' border-t pt-1.5' : ''}`;
  return (
    <dl className={className} data-testid={dataTestId}>
      <FactListContext.Provider
        value={{ labelTone, labelMono, valueTone, layout, valueSize }}
      >
        {children}
      </FactListContext.Provider>
    </dl>
  );
}

/**
 * How a value meets the edge of its column: `wrap` breaks long words,
 * `truncate` keeps one line with an ellipsis, `break-all` breaks anywhere (a
 * path or URL), `inline` lays out chips or icons beside the text,
 * `inline-spaced` does so with a detail page's wider gap, and `row`
 * keeps one line with a trailing control (a Copy button) right after the
 * text, the text truncating first.
 */
export type FactValueFit =
  | 'wrap'
  | 'truncate'
  | 'break-all'
  | 'inline'
  | 'inline-spaced'
  | 'row';

const VALUE_FIT_CLASS: Record<FactValueFit, string> = {
  wrap: ' break-words',
  truncate: ' truncate',
  'break-all': ' break-all',
  inline: ' flex flex-wrap items-center gap-1 break-words',
  'inline-spaced': ' flex flex-wrap items-center gap-x-2 gap-y-1 break-words',
  row: ' flex items-center gap-1',
};

export interface FactProps {
  readonly label: ReactNode;
  readonly children?: ReactNode;
  readonly fit?: FactValueFit;
  /** Tabular figures for counts, amounts and times. */
  readonly numeric?: boolean;
  /** A monospaced value (an id, a hash, a path). */
  readonly mono?: boolean;
  /** Full value on hover, for a truncated value. */
  readonly title?: string;
  /** Value ink: the list's (primary by default); secondary for a quieter value. */
  readonly valueTone?: FactValueTone;
  /** A color swatch before the label, in an `inline` list (a chart series). */
  readonly swatch?: string;
  /** A second, quieter value after the first, in an `inline` list. */
  readonly detail?: ReactNode;
  /** Test id on the value. */
  readonly dataTestId?: string;
  /** Test id on the label. */
  readonly labelTestId?: string;
  /** Test id on the fact as a whole (its label and value). */
  readonly testId?: string;
}

const FACT_CLASS: Record<FactListLayout, string> = {
  columns: 'contents',
  stacked: 'flex min-w-0 flex-col gap-0.5',
  spread: 'flex items-center justify-between gap-6',
  inline: 'flex items-center gap-1.5',
};

const VALUE_SIZE_CLASS: Record<FactValueSize, string> = {
  default: '',
  large: ' text-lg font-semibold',
};

/**
 * One fact: its label in the list's label ink, its value in the primary ink.
 * In a `stacked` list the label sits above the value.
 */
export function Fact({
  label,
  children,
  fit = 'wrap',
  numeric = false,
  mono = false,
  title,
  valueTone,
  swatch,
  detail,
  dataTestId,
  labelTestId,
  testId,
}: FactProps): JSX.Element {
  const list = useContext(FactListContext);
  const { labelTone, labelMono, layout, valueSize } = list;
  const tone = valueTone ?? list.valueTone;
  const stacked = layout === 'stacked';
  const spread = layout === 'spread';
  const inline = layout === 'inline';
  return (
    <div className={FACT_CLASS[layout]} data-testid={testId}>
      <dt
        className={`${LABEL_TONE_CLASS[labelTone]}${labelMono ? ' font-mono' : ''}${spread ? ' shrink-0' : ''}${inline ? ' inline-flex items-center gap-1.5' : ''}`}
        data-testid={labelTestId}
      >
        {inline && swatch !== undefined ? (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-xs"
            style={{ backgroundColor: swatch }}
          />
        ) : null}
        {label}
      </dt>
      <dd
        className={`${inline ? '' : 'min-w-0 '}${VALUE_TONE_CLASS[tone]}${inline ? '' : VALUE_FIT_CLASS[fit]}${spread ? ' justify-end text-right' : ''}${stacked ? VALUE_SIZE_CLASS[valueSize] : ''}${numeric ? ' tabular-nums' : ''}${mono ? ' font-mono' : ''}`}
        title={title}
        data-testid={dataTestId}
      >
        {children}
      </dd>
      {inline && detail !== undefined ? (
        <dd className="tabular-nums fg-tertiary">{detail}</dd>
      ) : null}
    </div>
  );
}
