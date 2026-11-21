import type { CSSProperties, HTMLAttributes, JSX, ReactNode, Ref } from 'react';
import { createElement } from 'react';
import type { CompositeListRow } from './ListRow';
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
 * - `page`: the full-height page column, with base fill and primary ink.
 * - `pane`: a full-bleed page region, without rounded corners.
 * - `panel`: a full-bleed card-fill work panel.
 * - `rail`: a full-bleed navigation region on the sidebar fill.
 * - `well`: a full-bleed secondary region for a media preview.
 * - `section`: an unfilled region attached to a pane. `boundary` supplies
 *   the shared edge of headers, footers, toolbars and status regions.
 * - `popover-footer`: an action band at the foot of a popover, on the card
 *   fill (`--bg-primary`). It meets the popover's edges (the host bleeds it through
 *   the surface inset), takes its top edge from `boundary`, and repeats the
 *   popover's inset edge over its fill (`.canopy-popover-footer`).
 */
export type SurfaceVariant =
  | 'outline'
  | 'group'
  | 'card'
  | 'raised'
  | 'product-preview'
  | 'product-preview-window'
  | 'inset'
  | 'dashed'
  | 'page'
  | 'centered-page'
  | 'share-recipient-highlight'
  | 'share-recipient'
  | 'branch-control'
  | 'mcp-manage-row'
  | 'advisor-window-clear'
  | 'gallery-banner'
  | 'attached-action-card'
  | 'guest-nudge'
  | 'pane'
  | 'app-pane'
  | 'startup-pane'
  | 'panel'
  | 'tinted-panel'
  | 'review-card'
  | 'review-composer'
  | 'selection-comment-popover'
  | 'mode-picker'
  | 'advisor-shadow'
  | 'mobile-promo-panel'
  | 'sign-in-card'
  | 'share-status-list'
  | 'guidance-step'
  | 'pairing-code'
  | 'notice-strip'
  | 'diagram-toolbar'
  | 'annotation-header'
  | 'date-chip'
  | 'worktree-panel-group'
  | 'workflow-icon'
  | 'workflow-nav-current'
  | 'workflow-nav-job'
  | 'workflow-toolbar'
  | 'transfer-row'
  | 'metadata-row'
  | 'quiet-panel'
  | 'workspace-panel'
  | 'rail'
  | 'well'
  | 'transcript-well'
  | 'transcript-nested-well'
  | 'popover-footer'
  | 'section';

/** Attached boundaries between regions of a pane, without a rounded box. */
export type SurfaceBoundary =
  | 'none'
  | 'top'
  | 'bottom'
  | 'muted-bottom'
  | 'bottom-right'
  | 'between-rows'
  | 'start'
  | 'active-rail'
  | 'left'
  | 'end'
  | 'right'
  | 'wide-right'
  | 'block'
  | 'frame';

const SURFACE_BOUNDARY_CLASS: Readonly<Record<SurfaceBoundary, string>> = {
  none: '',
  top: 'border-t',
  bottom: 'border-b',
  'muted-bottom': 'border-b border-line-tertiary',
  'bottom-right': 'border-b border-r',
  'between-rows': 'border-b last:border-b-0',
  start: 'border-s',
  left: 'border-l',
  'active-rail': 'border-l-2 border-line-accent',
  end: 'border-e',
  right: 'border-r',
  'wide-right': 'md:border-r',
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
export type SurfaceExtent =
  | 'content'
  | 'parent'
  | 'viewport'
  | 'dynamic-viewport'
  | 'window-toolbar'
  | 'window'
  | 'wide-parent'
  | 'worktree-split'
  | 'workflow-navigation'
  | 'picker-scroll'
  | 'advisor-overlay'
  | 'advisor-toolbar'
  | 'cowork-toolbar'
  | 'portal-toolbar'
  | 'aux-toolbar'
  | 'breadcrumb-toolbar'
  | 'mobile-toolbar'
  | 'portal-touch-toolbar'
  | 'workspace-toolbar'
  | 'subagents-toolbar';

const SURFACE_EXTENT_CLASS: Readonly<Record<SurfaceExtent, string>> = {
  content: '',
  parent: 'h-full',
  viewport: 'h-screen',
  'dynamic-viewport': 'h-dvh',
  'window-toolbar': 'max-h-10.75',
  window: 'min-h-dvh',
  'wide-parent': 'lg:h-full',
  'worktree-split': 'h-[52vh] min-h-105 lg:h-full',
  'workflow-navigation': 'max-h-60',
  'picker-scroll': 'max-h-48',
  'advisor-overlay': 'max-h-[calc(100vh-32px)]',
  'advisor-toolbar': 'min-h-10.75',
  'cowork-toolbar': 'min-h-11.5',
  'portal-toolbar': 'h-10',
  'aux-toolbar': 'h-9.5',
  'breadcrumb-toolbar': 'h-11.5',
  'mobile-toolbar': 'h-11',
  'portal-touch-toolbar': 'h-12',
  'workspace-toolbar': 'h-10.75',
  'subagents-toolbar': 'min-h-12',
};

/**
 * The inner padding, by role. `none` lets the content lay itself out (a
 * list of rows, a full-bleed image).
 */
export type SurfacePadding =
  | 'none'
  | 'tight'
  | 'compact'
  | 'default'
  | 'roomy'
  | 'window-toolbar'
  | 'diff-controls'
  | 'toolbar-trigger'
  | 'file-overlap'
  | 'section-compact'
  | 'section-default'
  | 'dialog-footer'
  | 'dialog-footer-medium'
  | 'section-top'
  | 'section-top-tight'
  | 'titlebar-trailing'
  | 'menu-inset'
  | 'picker-section'
  | 'compact-toolbar'
  | 'diagram-toolbar'
  | 'board-header'
  | 'workflow-nav-leading'
  | 'navigation-inset'
  | 'nested-tight'
  | 'nested-compact'
  | 'nested'
  | 'underline-tight'
  | 'panel-actions'
  | 'dialog-header'
  | 'form-footer'
  | 'row-block'
  | 'panel-heading'
  | 'toolbar-tight'
  | 'toolbar-compact'
  | 'page-inline'
  | 'safe-area-top'
  | 'wide-trailing';

/**
 * Fill, edge and shadow per variant: the one place a surface's look changes.
 * Corners are {@link SURFACE_RADIUS_CLASS}.
 */
export const SURFACE_VARIANT_CLASS: Readonly<Record<SurfaceVariant, string>> = {
  outline: `${HAIRLINE_INSET_RING_CLASS} ring-line-base`,
  group: `bg-secondary ${HAIRLINE_INSET_RING_CLASS} ring-line-base`,
  card: `bg-card ${HAIRLINE_INSET_RING_CLASS} ring-line-base`,
  raised: 'bg-card shadow-sm',
  'product-preview': 'bg-card shadow-lg',
  'product-preview-window': 'bg-card text-xs shadow-lg',
  inset: `bg-base ${HAIRLINE_INSET_RING_CLASS} ring-line-base`,
  dashed: 'border border-dashed border-line-secondary',
  page: 'flex min-h-screen flex-col bg-base fg-primary',
  'centered-page': 'flex min-h-screen items-center justify-center bg-base',
  'share-recipient-highlight':
    'flex min-w-0 items-center gap-2 bg-success-subtle px-2 py-1 transition-colors duration-200',
  'share-recipient':
    'flex min-w-0 items-center gap-2 px-2 py-1 transition-colors duration-200',
  'branch-control': 'transition-colors hover:bg-subtle',
  'mcp-manage-row':
    'flex items-center gap-3 px-2.5 py-2 hover:bg-fg-primary/[0.04]',
  'advisor-window-clear': 'bg-transparent fg-primary',
  'gallery-banner': 'bg-depth',
  'popover-footer': 'canopy-popover-footer bg-card',
  'attached-action-card': 'overflow-hidden bg-tertiary shadow-sm',
  'guest-nudge': 'animate-slide-up bg-card fg-primary shadow-lg',
  pane: 'bg-base',
  'app-pane': 'bg-base fg-primary',
  'startup-pane': 'bg-base fg-primary animate-fade-in',
  panel: 'bg-card',
  'tinted-panel': 'bg-card/50',
  'quiet-panel': 'bg-fg-primary/[0.02]',
  'review-card': 'flex flex-col gap-2 border bg-popover p-3',
  'review-composer': 'flex flex-col gap-1.5 border bg-popover p-2',
  'selection-comment-popover': 'flex flex-col gap-1.5 bg-popover p-2 shadow-xl',
  'metadata-row': 'gap-x-3 gap-y-0.5 text-s border-b last:border-b-0',
  'advisor-shadow': 'shadow-xl',
  'mobile-promo-panel': 'bg-card shadow-xl pb-[env(safe-area-inset-bottom)]',
  'sign-in-card': 'border bg-card/60 p-6',
  'share-status-list':
    'flex list-disc flex-col gap-1 border border-line-attention/30 bg-warning-subtle px-7 py-2 text-xs fg-secondary',
  'guidance-step':
    'mt-px flex h-5 w-5 shrink-0 items-center justify-center bg-secondary text-xs font-semibold fg-primary',
  'pairing-code': 'bg-white p-2',
  'notice-strip': 'border-b bg-subtle px-3 py-1.5',
  'diagram-toolbar': 'flex items-center gap-1.5 border-b px-2.5 py-1.5',
  'annotation-header':
    'border-b bg-quaternary px-3 py-1.5 text-2xs font-medium fg-secondary',
  'date-chip': 'border bg-card px-3 py-1 text-xs fg-secondary',
  'worktree-panel-group': 'canopy-panel-group',
  'workflow-icon':
    'flex h-9 w-9 shrink-0 items-center justify-center bg-accent-subtle text-m',
  'workflow-nav-current':
    'flex items-center bg-fg-primary/[0.04] font-semibold transition-colors',
  'workflow-nav-job':
    'flex items-center transition-colors hover:bg-fg-primary/[0.04]',
  'workflow-toolbar':
    'flex shrink-0 items-center gap-3 border-b bg-card px-4 py-3',
  'transfer-row': 'flex flex-col gap-1.5 border-b px-2 py-2',
  'mode-picker': 'ml-auto inline-flex items-center gap-1 border bg-base p-1',
  'workspace-panel': 'min-h-55 bg-card/50',
  rail: 'bg-sidebar',
  well: 'bg-secondary',
  'transcript-well': 'bg-fg-primary/[0.06]',
  'transcript-nested-well': 'bg-fg-primary/[0.06]',
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
  'product-preview': 'rounded-xl',
  'product-preview-window': 'rounded-xl',
  inset: 'rounded-md',
  dashed: 'rounded-lg',
  page: '',
  'centered-page': '',
  'share-recipient-highlight': 'rounded-lg',
  'share-recipient': 'rounded-lg',
  'branch-control': 'rounded-md',
  'mcp-manage-row': 'rounded-md',
  'advisor-window-clear': '',
  'gallery-banner': 'rounded-lg',
  'popover-footer': '',
  'attached-action-card': 'rounded-lg',
  'guest-nudge': 'rounded-xl',
  pane: '',
  'app-pane': '',
  'startup-pane': '',
  panel: '',
  'tinted-panel': '',
  'quiet-panel': '',
  'review-card': 'rounded-lg',
  'review-composer': 'rounded-lg',
  'selection-comment-popover': 'rounded-lg',
  'mode-picker': 'rounded-full',
  'advisor-shadow': 'rounded-2xl',
  'mobile-promo-panel': '',
  'sign-in-card': 'rounded-2xl',
  'share-status-list': 'rounded-lg',
  'guidance-step': 'rounded-full',
  'pairing-code': 'rounded-lg',
  'notice-strip': '',
  'diagram-toolbar': '',
  'annotation-header': '',
  'date-chip': 'rounded-full',
  'worktree-panel-group': '',
  'workflow-icon': 'rounded-lg',
  'workflow-nav-current': '',
  'workflow-nav-job': '',
  'workflow-toolbar': '',
  'transfer-row': '',
  'metadata-row': '',
  'workspace-panel': '',
  rail: '',
  well: '',
  'transcript-well': 'rounded-xl',
  'transcript-nested-well': 'rounded-lg',
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
  'window-toolbar': 'px-5 py-2',
  'diff-controls': 'px-1 pt-1',
  'toolbar-trigger': 'py-1.5 pl-3 pr-1',
  'file-overlap': 'px-3 pt-1 pb-3',
  'section-compact': 'px-3 py-2',
  'section-default': 'px-4 py-2',
  'dialog-footer': 'px-6 py-3',
  'dialog-footer-medium': 'px-5 py-3',
  'section-top': 'pt-4',
  'section-top-tight': 'pt-2',
  'titlebar-trailing': 'pr-2',
  'menu-inset': 'p-1',
  'picker-section': 'px-2 py-1.5',
  'compact-toolbar': 'px-3 py-1.5',
  'diagram-toolbar': 'px-2.5 py-1.5',
  'board-header': 'px-2.5 py-2',
  'workflow-nav-leading': 'pl-1.5',
  'navigation-inset': 'pl-1',
  'nested-tight': 'pl-2',
  'nested-compact': 'pl-3',
  nested: 'pl-4',
  'underline-tight': 'pb-1',
  'panel-actions': 'pt-3 px-4',
  'dialog-header': 'px-6 py-2',
  'form-footer': 'px-6 py-4',
  'row-block': 'py-3',
  'panel-heading': 'px-4 py-3',
  'toolbar-tight': 'px-2',
  'toolbar-compact': 'px-3',
  'page-inline': 'px-4',
  'safe-area-top': 'pt-[env(safe-area-inset-top)]',
  'wide-trailing': 'md:pr-3',
};

type SurfaceAttributes = Omit<
  HTMLAttributes<HTMLElement>,
  'className' | 'style' | 'children'
>;

export interface SurfaceProps extends SurfaceAttributes {
  /** What the box is; see {@link SurfaceVariant}. */
  readonly variant: SurfaceVariant;
  /** The element to render. Compound interactive rows use CompositeListRow. */
  readonly as?: LayoutElement | typeof CompositeListRow;
  /** Width supplied by a resizable split-pane host. */
  readonly paneWidth?: CSSProperties['width'];
  /** Height measured by a native window host. */
  readonly paneHeight?: CSSProperties['height'];
  /** Basis of a resizable tray in a flex column. */
  readonly paneBasis?: CSSProperties['flexBasis'];
  /** Native titlebar clearance supplied by the window host. */
  readonly nativeLeadingInset?: CSSProperties['paddingLeft'];
  /** Desktop window-chrome hit testing. */
  readonly dragRegion?: boolean;
  /** Draw the shared keyboard-focus outline on a focusable surface. */
  readonly focusRing?: boolean;
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
  /** Direction of the layout when gap is set. */
  readonly direction?: 'column' | 'row';
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
  direction,

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
  | 'direction'
  | 'selected'
  | 'interactive'
  | 'boundary'
  | 'replay'
  | 'className'
>): string {
  return [
    gap
      ? `flex${direction === 'row' ? '' : ' flex-col'} ${SPACE_ROLE_GAP_CLASS[gap]}`
      : '',
    size === 'small' && SURFACE_RADIUS_CLASS[variant]
      ? SURFACE_SMALL_RADIUS_CLASS
      : size === 'drawer' && SURFACE_RADIUS_CLASS[variant]
        ? SURFACE_DRAWER_RADIUS_CLASS
        : SURFACE_RADIUS_CLASS[variant],
    selected ? SURFACE_SELECTED_CLASS : SURFACE_VARIANT_CLASS[variant],
    (variant === 'pane' ||
      variant === 'panel' ||
      variant === 'tinted-panel' ||
      variant === 'quiet-panel' ||
      variant === 'workspace-panel' ||
      variant === 'rail' ||
      variant === 'well' ||
      variant === 'popover-footer' ||
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
  paneWidth,
  paneHeight,
  paneBasis,
  nativeLeadingInset,
  dragRegion,
  focusRing,
  size,
  extent,
  padding,
  gap,
  direction,
  selected,
  interactive,
  boundary,
  replay,
  className,
  children,
  ...rest
}: SurfaceProps): JSX.Element {
  const props = {
    ...rest,
    'data-surface': variant,
    style:
      paneWidth === undefined &&
      paneHeight === undefined &&
      paneBasis === undefined &&
      nativeLeadingInset === undefined
        ? undefined
        : {
            width: paneWidth,
            height: paneHeight,
            flexBasis: paneBasis,
            paddingLeft: nativeLeadingInset,
          },
    'data-selected': selected ? '' : undefined,
    className: surfaceClassName({
      variant,
      size,
      extent,
      padding,
      gap,
      direction,
      selected,
      interactive,
      boundary,
      replay,
      className: [
        dragRegion === undefined
          ? ''
          : dragRegion
            ? 'electron-drag'
            : 'electron-no-drag',
        focusRing ? 'focus-ring' : '',
        className,
      ]
        .filter(Boolean)
        .join(' '),
    }),
  };
  if (typeof Tag === 'string') return createElement(Tag, props, children);

  const { ref, ...rowProps } = props;
  return createElement(
    Tag,
    {
      ...rowProps,
      presentation: 'surface',
      ref:
        typeof ref === 'function'
          ? ref
          : ref
            ? (element): void => {
                ref.current = element;
              }
            : undefined,
    },
    children,
  );
}

export type DividerOrientation = 'horizontal' | 'vertical';

const STATUS_ILLUSTRATION_CLASS = {
  confirmation: 'h-16 w-16',
  profile: 'h-12 w-12 fg-accent-strong',
  workers: 'mx-auto h-10 w-10 fg-secondary',
  member: 'h-8 w-8 fg-secondary',
  'section-heading': 'mt-0.5 h-9 w-9 shrink-0 fg-accent-strong',
} as const;

const STATUS_ILLUSTRATION_TONE = {
  success: 'bg-success-subtle',
  warning: 'bg-warning-subtle',
  subtle: 'bg-subtle',
  accent: 'bg-accent-subtle',
  neutral: 'bg-secondary',
} as const;

/** A centered icon for a confirmation, empty state, or identity row. */
export function StatusIllustration({
  tone,
  variant = 'confirmation',
  children,
}: {
  readonly tone: keyof typeof STATUS_ILLUSTRATION_TONE;
  readonly variant?: keyof typeof STATUS_ILLUSTRATION_CLASS;
  readonly children: ReactNode;
}): JSX.Element {
  const Tag =
    variant === 'confirmation' || variant === 'workers' ? 'div' : 'span';
  return (
    <Tag
      className={`flex items-center justify-center rounded-full ${STATUS_ILLUSTRATION_CLASS[variant]} ${STATUS_ILLUSTRATION_TONE[tone]}`}
    >
      {children}
    </Tag>
  );
}

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

/** Desktop page chrome whose pinned edge fades without changing row geometry. */
export function PageTitlebarSurface({
  pinned,
  scrolled,
  divider,
  height,
  dragRegion,
  className,
  children,
  testId,
}: {
  readonly pinned: boolean;
  readonly scrolled: boolean;
  readonly divider: boolean;
  readonly height: 'bar' | 'breadcrumb' | 'content';
  readonly dragRegion: boolean;
  readonly className?: string;
  readonly children: ReactNode;
  readonly testId?: string;
}): JSX.Element {
  const placement = [
    'flex shrink-0 items-stretch',
    dragRegion ? 'electron-drag' : '',
    pinned
      ? "sticky top-0 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-[var(--border-hairline)] after:bg-[var(--line-base)] after:transition-opacity after:duration-150 after:content-['']"
      : '',
    pinned ? (scrolled ? 'after:opacity-100' : 'after:opacity-0') : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      data-testid={testId}
      className={surfaceClassName({
        variant: pinned ? 'pane' : 'section',
        boundary: divider ? 'bottom' : undefined,
        extent:
          height === 'bar'
            ? 'portal-toolbar'
            : height === 'breadcrumb'
              ? 'breadcrumb-toolbar'
              : undefined,
        className: placement,
      })}
    >
      {children}
    </div>
  );
}
