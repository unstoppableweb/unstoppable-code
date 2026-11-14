import {
  createContext,
  forwardRef,
  useContext,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

/**
 * The row's ink and hover surface. The `status-*` tones are the operational
 * inks for a row whose label reports its subject's own state: the sidebar's
 * More menu inks the Remote Control row `status-success` while connected,
 * `status-active` while reconnecting, and `status-failed` once disconnected.
 * They bind to the hue-stable `fg-status-*` roles rather than the theme
 * intents, matching the app's other operational indicators, and keep the
 * default hover surface.
 */
export type DropdownMenuItemTone =
  | 'default'
  /** Supporting ink, for disclosure rows such as a picker's Legacy models. */
  | 'tertiary'
  | 'accent'
  | 'info'
  | 'destructive'
  | 'status-success'
  | 'status-active'
  | 'status-failed';

/**
 * Operational tint for a row whose subject is currently running (`active`) or
 * has something new to look at (`unread`): the sidebar's More menu paints the
 * App Advisor and Claude Workers rows this way. The row keeps its default ink
 * and hover surface; only the resting background is tinted.
 */
export type DropdownMenuItemStatus = 'active' | 'unread';

/**
 * Attention ink for a row whose subject needs the user: the account menu's
 * Usage row turns amber (`warning`) as a quota nears its limit and red
 * (`critical`) once it is reached. Only the ink changes; the hover surface,
 * and the muted surface when `selected`, stay the row's own. The alert
 * replaces the default ink rather than riding beside it: `fg-destructive`
 * sorts before `fg-primary` in the stylesheet, so an appended class never
 * painted.
 */
export type DropdownMenuItemAlert = 'warning' | 'critical';

/**
 * Inset between the surface edge and its contents. `menu` is the 4px row
 * inset that keeps the 12px surface and 8px row corners concentric. `controls`
 * (8px) suits a grouped control such as a segmented toggle, `readout`
 * (12px) a read-only popover whose text sits where a menu's row text does
 * (4px surface plus 8px row), `content` (16px) a dialog-style popover
 * with copy, switches, and fields, and `none` a popover body that lays out
 * its own sections to the surface's edges (a sticky header, a rule).
 */
export type DropdownMenuSurfacePadding =
  | 'menu'
  | 'controls'
  | 'readout'
  | 'content'
  | 'none';

/**
 * `picker` is the flagship picker anatomy (`.canopy-picker-menu`): the
 * surface's width follows its longest option between the shared 160px/trigger
 * minimum and the 320px/viewport cap, it lays out as a clipping flex column, and its
 * vertical inset moves to the list content. `FloatingPickerMenu` sets it.
 */
export type DropdownMenuSurfaceShell =
  | 'menu'
  | 'content-menu'
  | 'picker'
  /** The harness model picker's framed 23rem shell. */
  | 'model-picker'
  /** `model-picker` with the tinted selected row. */
  | 'model-picker-highlight'
  /** The older fixed-height harness browser. */
  | 'model-browser'
  /**
   * No surface of its own, for floating content that draws its own (a pill,
   * a hover card): the floating layer only places it. Padding still applies,
   * as the pointer bridge between a hover card and its trigger.
   */
  | 'bare';

const SURFACE_SHELL_CLASS_NAMES: Record<DropdownMenuSurfaceShell, string> = {
  menu: '',
  'content-menu': ' canopy-floating-menu-content',
  picker: ' canopy-picker-menu',
  'model-picker':
    ' canopy-picker-menu canopy-model-picker-shell relative flex flex-col w-92',
  'model-picker-highlight':
    ' canopy-picker-menu canopy-model-picker-shell canopy-model-picker-highlight-selection relative flex flex-col w-92',
  'model-browser': ' h-76 max-h-[calc(100vh-16px)] w-92',
  bare: '',
};

export interface DropdownMenuSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  padding?: DropdownMenuSurfacePadding;
  shell?: DropdownMenuSurfaceShell;
}

export interface DropdownMenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: DropdownMenuItemTone;
  selected?: boolean;
  /** The row's submenu is open; it keeps a hover surface while it is. */
  expanded?: boolean;
  /**
   * A two-line row: a label with a subtitle beneath it. The fixed 32px height
   * gives way to 6px of vertical padding, and the icon rail sits 12px from the
   * text (the shared 8px plus 4) so a column of icons reads beside the copy.
   */
  multiline?: boolean;
  /**
   * Raises the row to the 44px touch-target floor. For menus opened from a
   * coarse-pointer surface; the default 32px row is sized for a mouse. A
   * minimum, so the fixed height and centered content are otherwise unchanged.
   */
  touchTarget?: boolean;
  status?: DropdownMenuItemStatus;
  alert?: DropdownMenuItemAlert;
}

const ITEM_TONE_CLASS_NAMES: Record<DropdownMenuItemTone, string> = {
  default: 'fg-primary enabled:hover:bg-subtle',
  tertiary: 'fg-tertiary enabled:hover:bg-subtle',
  accent:
    'bg-accent fg-emphasis enabled:hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
  info: 'fg-blue enabled:hover:bg-subtle',
  destructive: 'fg-destructive enabled:hover:bg-destructive-subtle',
  'status-success': `${OPERATIONAL_STATUS_COLORS.success.foreground} enabled:hover:bg-subtle`,
  'status-active': `${OPERATIONAL_STATUS_COLORS.active.foreground} enabled:hover:bg-subtle`,
  'status-failed': `${OPERATIONAL_STATUS_COLORS.failed.foreground} enabled:hover:bg-subtle`,
};

const ITEM_STATUS_CLASS_NAMES: Record<DropdownMenuItemStatus, string> = {
  active: OPERATIONAL_STATUS_COLORS.active.backgroundSubtle,
  unread: OPERATIONAL_STATUS_COLORS.unread.backgroundSubtle,
};

const ITEM_ALERT_INK_CLASS_NAMES: Record<DropdownMenuItemAlert, string> = {
  warning: 'fg-warning',
  critical: 'fg-destructive',
};

const SURFACE_PADDING_CLASS_NAMES: Record<DropdownMenuSurfacePadding, string> =
  {
    menu: 'p-1',
    controls: 'p-2',
    readout: 'p-3',
    content: 'p-4',
    none: 'p-0',
  };

/**
 * Canonical dropdown surface shared by desktop and web.
 *
 * The 12px outer radius, 4px inset, and 8px item radius form concentric
 * corners. Callers may set positioning, width, and max-height; visual surface
 * geometry belongs here so every menu responds to design-system changes.
 */
export const DropdownMenuSurface = forwardRef<
  HTMLDivElement,
  DropdownMenuSurfaceProps
>(function DropdownMenuSurface(
  { className = '', padding = 'menu', shell = 'menu', role = 'menu', ...props },
  ref,
): JSX.Element {
  return (
    <div
      ref={ref}
      role={role}
      // A surface can hold focus itself (menus and dialogs fall back to it);
      // as a container it draws no outline, which would otherwise be the
      // browser's default ring in the system accent colour. Its rows and
      // controls keep their own focus rings.
      className={`${shell === 'bare' ? '' : 'rounded-lg bg-quaternary shadow-xl '}outline-none ${SURFACE_PADDING_CLASS_NAMES[padding]}${SURFACE_SHELL_CLASS_NAMES[shell]} ${className}`}
      {...props}
    />
  );
});

DropdownMenuSurface.displayName = 'DropdownMenuSurface';

/**
 * How a menu draws its rows, set once by the menu. `body` text with icons in
 * the row's ink is the default. A quieter menu (the sidebar's row menus)
 * takes `small` text, one step down the type scale, and `tertiary` icons, so
 * the labels lead and the glyphs recede. A row whose ink carries meaning
 * (destructive, an alert) or that is disabled keeps its own icon ink.
 */
export interface DropdownMenuRowStyle {
  readonly textStyle: 'body' | 'small';
  readonly iconTone: 'inherit' | 'tertiary';
  /**
   * The rows' corner radius: the menu's own (`menu`, the default), or the
   * sidebar rows' `--radius-row` (`row`) for a list of rows that sits beside
   * the sidebar, such as the Activity card.
   */
  readonly corners?: 'menu' | 'row';
}

export const DEFAULT_MENU_ROW_STYLE: DropdownMenuRowStyle = {
  textStyle: 'body',
  iconTone: 'inherit',
};

/** Small text and tertiary icons: the sidebar's row menus (early access). */
export const QUIET_MENU_ROW_STYLE: DropdownMenuRowStyle = {
  textStyle: 'small',
  iconTone: 'tertiary',
};

const DropdownMenuRowStyleContext = createContext<DropdownMenuRowStyle>(
  DEFAULT_MENU_ROW_STYLE,
);

/** The row style of the nearest menu; a menu's plain labels follow it. */
export function useDropdownMenuRowStyle(): DropdownMenuRowStyle {
  return useContext(DropdownMenuRowStyleContext);
}

/** True inside a plain row, whose icon may take the menu's quieter tone. */
const PlainRowContext = createContext(false);

export function DropdownMenuRowStyleProvider({
  value,
  children,
}: {
  readonly value: DropdownMenuRowStyle;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <DropdownMenuRowStyleContext.Provider value={value}>
      {children}
    </DropdownMenuRowStyleContext.Provider>
  );
}

/** Canonical action row for a dropdown menu. */
export const DropdownMenuItem = forwardRef<
  HTMLButtonElement,
  DropdownMenuItemProps
>(function DropdownMenuItem(
  {
    className = '',
    tone = 'default',
    selected = false,
    expanded = false,
    multiline = false,
    touchTarget = false,
    status,
    alert,
    type = 'button',
    role = 'menuitem',
    children,
    ...props
  },
  ref,
): JSX.Element {
  const rowStyle = useContext(DropdownMenuRowStyleContext);
  const plainRow =
    alert === undefined &&
    !selected &&
    props.disabled !== true &&
    (tone === 'default' || tone === 'tertiary');
  const textClassName = rowStyle.textStyle === 'small' ? 'text-xs' : 'text-s';
  const cornersClassName =
    rowStyle.corners === 'row' ? 'rounded-row' : 'rounded-md';
  const geometryClassName = multiline
    ? // Two-line rows get 8px above and below, like the menu's 32px rows
      // give a single line (8px over a 16px icon).
      `flex w-full items-center gap-2 ${cornersClassName} px-2 py-2`
    : `flex h-8 w-full items-center gap-2 ${cornersClassName} px-2`;
  // Selected outranks the tone; an alert keeps the selected surface but takes
  // over the ink.
  const surfaceClassName = alert
    ? `${ITEM_ALERT_INK_CLASS_NAMES[alert]} ${
        selected ? 'bg-muted enabled:hover:bg-muted' : 'enabled:hover:bg-subtle'
      }`
    : selected
      ? 'bg-muted fg-primary enabled:hover:bg-muted'
      : `${ITEM_TONE_CLASS_NAMES[tone]}${expanded ? ' bg-subtle' : ''}`;
  return (
    <button
      ref={ref}
      type={type}
      role={role}
      // Keyboard focus paints the row like hover (`focus-visible:bg-subtle`)
      // rather than drawing the accent ring around it.
      className={`canopy-dropdown-menu-item outline-none ${geometryClassName} text-left ${textClassName} font-normal transition-colors focus-visible:bg-subtle disabled:cursor-not-allowed disabled:fg-disabled disabled:opacity-100 disabled:hover:bg-transparent ${surfaceClassName} ${status ? ITEM_STATUS_CLASS_NAMES[status] : ''} ${touchTarget ? 'min-h-11' : ''} ${className}`}
      {...props}
    >
      <PlainRowContext.Provider value={plainRow}>
        {children}
      </PlainRowContext.Provider>
    </button>
  );
});

DropdownMenuItem.displayName = 'DropdownMenuItem';

export interface DropdownMenuLinkItemProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly href: string;
}

/**
 * A menu row that navigates: a real anchor, so opening it in a new tab and
 * copying its address work, in the action row's geometry, ink and icon column.
 */
export const DropdownMenuLinkItem = forwardRef<
  HTMLAnchorElement,
  DropdownMenuLinkItemProps
>(function DropdownMenuLinkItem(
  { className = '', role = 'menuitem', children, ...props },
  ref,
): JSX.Element {
  const rowStyle = useContext(DropdownMenuRowStyleContext);
  const textClassName = rowStyle.textStyle === 'small' ? 'text-xs' : 'text-s';
  const cornersClassName =
    rowStyle.corners === 'row' ? 'rounded-row' : 'rounded-md';
  return (
    <a
      ref={ref}
      role={role}
      className={`canopy-dropdown-menu-item outline-none flex h-8 w-full items-center gap-2 ${cornersClassName} px-2 text-left ${textClassName} font-normal fg-primary transition-colors hover:bg-subtle focus-visible:bg-subtle ${className}`}
      {...props}
    >
      <PlainRowContext.Provider value={true}>
        {children}
      </PlainRowContext.Provider>
    </a>
  );
});

DropdownMenuLinkItem.displayName = 'DropdownMenuLinkItem';

/**
 * A row that reports a state instead of acting: the account menu's
 * `Sync paused` (desktop early access). It takes an action row's height,
 * inset, type, ink, and icon column so it lines up with the rows around it,
 * but it is not a menu item: the arrow keys pass over it, and it has no hover
 * surface or focus ring. A trailing status dot goes in the same 16px frame
 * the Usage row's alert dot uses.
 */
export const DropdownMenuStatusRow = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function DropdownMenuStatusRow(
  { className = '', role = 'status', children, ...props },
  ref,
): JSX.Element {
  const rowStyle = useContext(DropdownMenuRowStyleContext);
  const textClassName = rowStyle.textStyle === 'small' ? 'text-xs' : 'text-s';
  return (
    <div
      ref={ref}
      role={role}
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left ${textClassName} font-normal fg-primary ${className}`}
      {...props}
    >
      <PlainRowContext.Provider value={true}>
        {children}
      </PlainRowContext.Provider>
    </div>
  );
});

DropdownMenuStatusRow.displayName = 'DropdownMenuStatusRow';

/**
 * `inherit` takes the row's ink; `secondary` quiets a catalog glyph (the
 * add-tab menu's panel icons); `accent` marks the row that holds the current
 * selection. A glyph that carries a meaning of its own beside the row's label
 * takes an intent: the approval picker's shields step from `success` through
 * `info` to `destructive` as a mode's reach grows.
 */
export type DropdownMenuItemIconTone =
  | 'inherit'
  | 'secondary'
  | 'tertiary'
  | 'accent'
  | 'success'
  | 'info'
  | 'destructive';

const ITEM_ICON_TONE_CLASS_NAMES: Record<DropdownMenuItemIconTone, string> = {
  inherit: '',
  secondary: 'fg-secondary',
  tertiary: 'fg-tertiary',
  accent: 'fg-accent',
  success: 'fg-success',
  info: 'fg-blue',
  destructive: 'fg-destructive',
};

export interface DropdownMenuItemIconProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: DropdownMenuItemIconTone;
}

/**
 * Fixed-width leading slot that keeps labels aligned across menu rows. Catalog
 * glyphs in it always draw at the compact 14px size (app-icons.css), so every
 * menu's icons share one optical size and stroke, whatever size a caller asks
 * for.
 */
export function DropdownMenuItemIcon({
  className = '',
  tone: toneProp,
  ...props
}: DropdownMenuItemIconProps): JSX.Element {
  const rowStyle = useContext(DropdownMenuRowStyleContext);
  const plainRow = useContext(PlainRowContext);
  // An explicit tone wins; otherwise a plain row takes the menu's icon tone.
  const tone: DropdownMenuItemIconTone =
    toneProp ??
    (plainRow && rowStyle.iconTone === 'tertiary' ? 'tertiary' : 'inherit');
  return (
    <span
      aria-hidden="true"
      className={`canopy-dropdown-menu-icon inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:!h-4 [&>svg]:!w-4${tone === 'inherit' ? '' : ` ${ITEM_ICON_TONE_CLASS_NAMES[tone]}`} ${className}`}
      {...props}
    />
  );
}

export type DropdownMenuItemTrailingTone = 'tertiary' | 'destructive';

const ITEM_TRAILING_TONE_CLASS_NAMES: Record<
  DropdownMenuItemTrailingTone,
  string
> = {
  tertiary: 'fg-tertiary',
  destructive: 'fg-destructive',
};

export interface DropdownMenuItemTrailingProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: DropdownMenuItemTrailingTone;
}

/**
 * Trailing text on a menu row (a count, a status, a shortcut). It sets no
 * size of its own, so it always reads at the row label's size; only its ink
 * is quieter, or carries an alert.
 */
export function DropdownMenuItemTrailing({
  className = '',
  tone = 'tertiary',
  ...props
}: DropdownMenuItemTrailingProps): JSX.Element {
  return (
    <span
      className={`ml-auto shrink-0 tabular-nums ${ITEM_TRAILING_TONE_CLASS_NAMES[tone]} ${className}`}
      {...props}
    />
  );
}

export interface DropdownMenuLabelProps extends HTMLAttributes<HTMLDivElement> {
  /** Set a command, path, or other code-like value in the mono face. */
  mono?: boolean;
  /**
   * `relaxed` doubles the vertical inset to 8px for an identity block (name,
   * email, plan) rather than a one-line section label.
   */
  spacing?: 'default' | 'relaxed';
}

export function DropdownMenuLabel({
  className = '',
  mono = false,
  spacing = 'default',
  ...props
}: DropdownMenuLabelProps): JSX.Element {
  const rowStyle = useContext(DropdownMenuRowStyleContext);
  // A quiet menu's section labels step back with its icons; an identity
  // block (`relaxed`) keeps its ink.
  const inkClassName =
    rowStyle.iconTone === 'tertiary' && spacing === 'default'
      ? 'fg-tertiary'
      : 'fg-secondary';
  return (
    <div
      className={`truncate px-2 ${spacing === 'relaxed' ? 'py-2' : 'py-1'} text-xs font-normal ${inkClassName}${mono ? ' font-mono' : ''} ${className}`}
      {...props}
    />
  );
}

/**
 * A group divider, inset to the rows' 8px padding so it starts at the icon
 * column and ends at the row's trailing edge (a submenu chevron).
 */
export function DropdownMenuDivider({
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      role="separator"
      className={`mx-2 my-1 border-t ${className}`}
      {...props}
    />
  );
}
