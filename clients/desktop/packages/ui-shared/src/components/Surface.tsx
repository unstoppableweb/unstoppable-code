import type { HTMLAttributes, JSX, ReactNode, Ref } from 'react';
import { createElement } from 'react';
import { HAIRLINE_INSET_RING_CLASS } from '../lib/row-chips';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import {
  SPACE_ROLE_GAP_CLASS,
  type LayoutElement,
  type SpaceRole,
} from './Stack';

/**
 * The one way to draw a box. `docs/design/surfaces.md` keeps raw elements
 * plain layout; a surface's radius, fill, edge and shadow come from here,
 * named by what the box is rather than by its classes, so a surface type has
 * one look everywhere.
 *
 * - `outline`: a hairline box with no fill, on whatever is behind it (a
 *   bordered list, a preview frame, a group of fields).
 * - `group`: the secondary fill with a hairline edge, the grouped box of
 *   Settings and of any list of rows.
 * - `card`: the card fill with a hairline edge, a standalone item that sits
 *   on the page (a stat, a summary, a result).
 * - `raised`: the card fill lifted by the small shadow instead of an edge,
 *   for a card that floats over a busy or tinted background.
 * - `inset`: the page fill with a hairline edge, a well inside a group or
 *   card (a code sample, a nested preview).
 * - `dashed`: a dashed line with no fill, for a drop zone or an empty
 *   placeholder that is waiting for something.
 * - `pane`: a full-bleed page region, without rounded corners.
 * - `panel`: a full-bleed card-fill work panel.
 * - `rail`: a full-bleed navigation region on the sidebar fill.
 * - `well`: a full-bleed secondary region for a media preview.
 * - `section`: an unfilled region attached to a pane. `boundary` supplies
 *   the shared edge of headers, footers, toolbars and status regions.
 */
export type SurfaceVariant =
  | 'outline'
  | 'group'
  | 'card'
  | 'raised'
  | 'inset'
  | 'dashed'
  | 'pane'
  | 'panel'
  | 'rail'
  | 'well'
  | 'section';

/** Attached boundaries between regions of a pane, without a rounded box. */
export type SurfaceBoundary =
  | 'none'
  | 'top'
  | 'bottom'
  | 'start'
  | 'left'
  | 'end'
  | 'right'
  | 'block'
  | 'frame';

const SURFACE_BOUNDARY_CLASS: Readonly<Record<SurfaceBoundary, string>> = {
  none: '',
  top: 'border-t',
  bottom: 'border-b',
  start: 'border-s',
  left: 'border-l',
  end: 'border-e',
  right: 'border-r',
  block: 'border-y',
  frame: `${HAIRLINE_INSET_RING_CLASS} ring-line-base`,
};

/**
 * The corner size. `small` gives every variant 8px corners, for a compact box
 * such as one row of a file list; `drawer` gives the composer drawer's corner
 * (`--radius-drawer`), for a box that holds drawer rows over a 4px inset, so
 * its corners nest around theirs; `default` is the variant's own corner.
 * Flat pane regions always retain square corners.
 */
export type SurfaceSize = 'default' | 'small' | 'drawer';

/** A pane's height comes from its parent or the viewport, never a caller override. */
export type SurfaceExtent = 'content' | 'parent' | 'viewport';

const SURFACE_EXTENT_CLASS: Readonly<Record<SurfaceExtent, string>> = {
  content: '',
  parent: 'h-full',
  viewport: 'h-screen',
};

/**
 * The inner padding, by role. `none` lets the content lay itself out (a
 * list of rows, a full-bleed image).
 */
export type SurfacePadding = 'none' | 'tight' | 'compact' | 'default' | 'roomy';

/**
 * Fill, edge and shadow per variant: the one place a surface's look changes.
 * Corners are {@link SURFACE_RADIUS_CLASS}.
 */
export const SURFACE_VARIANT_CLASS: Readonly<Record<SurfaceVariant, string>> = {
  outline: `${HAIRLINE_INSET_RING_CLASS} ring-line-base`,
  group: `bg-secondary ${HAIRLINE_INSET_RING_CLASS} ring-line-base`,
  card: `bg-card ${HAIRLINE_INSET_RING_CLASS} ring-line-base`,
  raised: 'bg-card shadow-sm',
  inset: `bg-base ${HAIRLINE_INSET_RING_CLASS} ring-line-base`,
  dashed: 'border border-dashed border-line-secondary',
  pane: 'bg-base',
  panel: 'bg-card',
  rail: 'bg-sidebar',
  well: 'bg-secondary',
  section: '',
};

/**
 * The selected state: the accent's subtle fill and edge, for a box the user
 * picked (a plan, a project, a template). It replaces the variant's own fill
 * and edge and keeps its radius.
 */
export const SURFACE_SELECTED_CLASS = `bg-accent-subtle ${HAIRLINE_INSET_RING_CLASS} ring-line-accent`;

/**
 * Corners per variant. Radius nests: `inset` sits inside a `group` or `card`
 * with the smaller corner.
 */
export const SURFACE_RADIUS_CLASS: Readonly<Record<SurfaceVariant, string>> = {
  outline: 'rounded-lg',
  group: 'rounded-lg',
  card: 'rounded-xl',
  raised: 'rounded-xl',
  inset: 'rounded-md',
  dashed: 'rounded-lg',
  pane: '',
  panel: '',
  rail: '',
  well: '',
  section: '',
};

/** The corners of a {@link SurfaceSize} `small` box. */
export const SURFACE_SMALL_RADIUS_CLASS = 'rounded-md';

/** The corners of a {@link SurfaceSize} `drawer` box. */
export const SURFACE_DRAWER_RADIUS_CLASS = 'rounded-drawer';

/** The hover of a clickable box: the fill darkens, as a list row's does. */
export const SURFACE_INTERACTIVE_CLASS = 'hover:bg-subtle';

export const SURFACE_PADDING_CLASS: Readonly<Record<SurfacePadding, string>> = {
  none: '',
  tight: 'p-2',
  compact: 'p-3',
  default: 'p-4',
  roomy: 'p-6',
};

type SurfaceAttributes = Omit<
  HTMLAttributes<HTMLElement>,
  'className' | 'style' | 'children'
>;

export interface SurfaceProps extends SurfaceAttributes {
  /** What the box is; see {@link SurfaceVariant}. */
  readonly variant: SurfaceVariant;
  /** The element to render; `div` by default. */
  readonly as?: LayoutElement;
  readonly ref?: Ref<HTMLElement>;
  /** Keep private content protected when its raw wrapper becomes a Surface. */
  readonly replay?: 'block' | 'mask';
  /** An attached pane boundary. Box variants already own their full edge. */
  readonly boundary?: SurfaceBoundary;
  /** Corner size; see {@link SurfaceSize}. */
  readonly size?: SurfaceSize;
  /** Fill the parent's height or the viewport; intrinsic content by default. */
  readonly extent?: SurfaceExtent;
  /** Inner padding by role; `none` by default. */
  readonly padding?: SurfacePadding;
  /**
   * Lay the children out as a vertical stack with this gap, so the box and
   * its column are one element. Leave it out to lay the children out with
   * a `Stack` or `Inline` inside.
   */
  readonly gap?: SpaceRole;
  /** The picked state; see {@link SURFACE_SELECTED_CLASS}. */
  readonly selected?: boolean;
  /** A clickable box; see {@link SURFACE_INTERACTIVE_CLASS}. */
  readonly interactive?: boolean;
  /**
   * Placement only (width, flex participation, position, overflow); never
   * the surface's radius, fill, edge, shadow or padding.
   */
  readonly className?: string;
  readonly children?: ReactNode;
}

/** The class list a {@link Surface} renders, for tests and lab sheets. */
export function surfaceClassName({
  variant,
  size = 'default',
  extent = 'content',
  padding = 'none',
  gap,
  selected = false,
  interactive = false,
  boundary = 'none',
  replay,
  className,
}: Pick<
  SurfaceProps,
  | 'variant'
  | 'size'
  | 'extent'
  | 'padding'
  | 'gap'
  | 'selected'
  | 'interactive'
  | 'boundary'
  | 'replay'
  | 'className'
>): string {
  return [
    gap ? `flex flex-col ${SPACE_ROLE_GAP_CLASS[gap]}` : '',
    size === 'small' && SURFACE_RADIUS_CLASS[variant]
      ? SURFACE_SMALL_RADIUS_CLASS
      : size === 'drawer' && SURFACE_RADIUS_CLASS[variant]
        ? SURFACE_DRAWER_RADIUS_CLASS
        : SURFACE_RADIUS_CLASS[variant],
    selected ? SURFACE_SELECTED_CLASS : SURFACE_VARIANT_CLASS[variant],
    (variant === 'pane' ||
      variant === 'panel' ||
      variant === 'rail' ||
      variant === 'well' ||
      variant === 'section') &&
    !(boundary === 'frame' && selected)
      ? SURFACE_BOUNDARY_CLASS[boundary]
      : '',
    interactive ? SURFACE_INTERACTIVE_CLASS : '',
    SURFACE_PADDING_CLASS[padding],
    SURFACE_EXTENT_CLASS[extent],
    replay === 'block'
      ? REPLAY_BLOCK_CLASS
      : replay === 'mask'
        ? REPLAY_MASK_CLASS
        : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * A box drawn by role. Children never set the box's look, and the caller's
 * `className` never does either: a box that needs another look is a new
 * variant here, with its lab sheet.
 */
export function Surface({
  as: Tag = 'div',
  variant,
  size,
  extent,
  padding,
  gap,
  selected,
  interactive,
  boundary,
  replay,
  className,
  children,
  ...rest
}: SurfaceProps): JSX.Element {
  return createElement(
    Tag,
    {
      ...rest,
      'data-surface': variant,
      'data-selected': selected ? '' : undefined,
      className: surfaceClassName({
        variant,
        size,
        extent,
        padding,
        gap,
        selected,
        interactive,
        boundary,
        replay,
        className,
      }),
    },
    children,
  );
}

export type DividerOrientation = 'horizontal' | 'vertical';

export interface DividerProps {
  /** `horizontal` (a full-width line) by default. */
  readonly orientation?: DividerOrientation;
  /**
   * Placement only: inset (`mx-4`), flex participation. The line's weight
   * and color are the divider's own.
   */
  readonly className?: string;
  readonly 'data-testid'?: string;
  /**
   * Hide a decorative line (between two labelled steps, beside "Or") from
   * assistive technology.
   */
  readonly 'aria-hidden'?: boolean;
}

/**
 * The shared hairline divider: the light boundary `docs/design/layout.md`
 * reaches for before a card. One physical pixel in the base line color. A
 * horizontal divider fills a block or column parent's width (give it
 * `flex-1` or a width in a row); a vertical one stretches to its row's
 * height.
 */
export function Divider({
  orientation = 'horizontal',
  className,
  ...rest
}: DividerProps): JSX.Element {
  const line =
    orientation === 'horizontal'
      ? 'h-0 shrink-0 border-t'
      : 'w-0 shrink-0 self-stretch border-l';
  return (
    <div
      {...rest}
      role="separator"
      aria-orientation={orientation}
      className={className ? `${line} ${className}` : line}
    />
  );
}
