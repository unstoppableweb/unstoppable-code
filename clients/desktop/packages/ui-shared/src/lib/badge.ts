/**
 * One vocabulary for small markers: a Badge (a state or label word), a Count
 * (a number), and a Dot (a meaning with no text).
 *
 * - Badge: an 18px capsule, 11px label at 450, on the one neutral fill. The
 *   tone is a 6px dot before the word (or the badge's icon, in the tone's
 *   ink); the word stays in the text ink. Six tones. Never a tinted fill,
 *   never bordered, never the accent, never uppercase or semibold.
 * - Count: plain `fg-quaternary` text next to a label, with proportional
 *   figures (DESIGN.md Typography: counts in a row are not tabular); a 16px
 *   tabular capsule on an icon, neutral, blue for unread, or orange for
 *   waiting on you. On an icon it caps at 99+.
 * - Badge `compact`: a 16px square tag at 10px for dense views only
 *   (diagrams, code views, schema tags such as PK or added). Too small for
 *   a dot, so the word itself takes the tone's ink, on the same neutral fill.
 * - Dot: 6px (8px `large` in a leading icon slot), with six meanings only:
 *   unread (blue), waiting on you (orange), filter on (grey), working (green,
 *   something is running), connected (green, a live connection), and offline
 *   or failed (red).
 *
 * Every marker composes these builders so the app cannot drift back into a
 * mix of heights, radii, rings and weights.
 */

export type BadgeTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'special';

export type BadgeSize = 'regular' | 'compact';

/** 18px capsule, 11px label at 450, 12px icons. */
export const BADGE_BASE_CLASS =
  'inline-flex h-4.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.75 text-2xs font-medium leading-none';

/**
 * 16px square tag, 10px label at 450, 10px icons. Dense views only:
 * diagrams, code views and schema tags (PK, FK, added, changed).
 */
export const BADGE_COMPACT_BASE_CLASS =
  'inline-flex h-4 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-sm px-1 text-3xs font-medium leading-none';

export const BADGE_BASE_CLASS_BY_SIZE: Readonly<Record<BadgeSize, string>> = {
  regular: BADGE_BASE_CLASS,
  compact: BADGE_COMPACT_BASE_CLASS,
};

/**
 * The tone's 6px dot, drawn before the word by the capsule itself, so every
 * badge built from these classes carries it without a child element.
 */
const BADGE_DOT_CLASS =
  "before:size-1.5 before:shrink-0 before:rounded-full before:content-['']";

/** The dot's color per tone: the same inks the `Dot` marker uses. */
const BADGE_DOT_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: '',
  info: `${BADGE_DOT_CLASS} before:bg-fg-info`,
  success: `${BADGE_DOT_CLASS} before:bg-fg-success-strong`,
  warning: `${BADGE_DOT_CLASS} before:bg-fg-warning`,
  danger: `${BADGE_DOT_CLASS} before:bg-fg-destructive-strong`,
  special: `${BADGE_DOT_CLASS} before:bg-fg-special-strong`,
};

/**
 * Fill and ink per tone: one neutral fill, the word in the text ink, and the
 * tone as a dot. A tinted fill under same-colored text made a row of badges
 * read as six colors of candy; the dot keeps the meaning and the row calm.
 * `neutral` (roles, plans, kinds) has no dot and the quieter ink.
 */
export const BADGE_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-muted fg-secondary',
  info: `bg-muted fg-primary ${BADGE_DOT_TONE_CLASS.info}`,
  success: `bg-muted fg-primary ${BADGE_DOT_TONE_CLASS.success}`,
  warning: `bg-muted fg-primary ${BADGE_DOT_TONE_CLASS.warning}`,
  danger: `bg-muted fg-primary ${BADGE_DOT_TONE_CLASS.danger}`,
  special: `bg-muted fg-primary ${BADGE_DOT_TONE_CLASS.special}`,
};

/**
 * Quieter fill and ink for a badge on a completed or de-emphasised row; the
 * dot fades with it. Geometry is unchanged.
 */
export const BADGE_MUTED_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-subtle fg-tertiary',
  info: `bg-subtle fg-tertiary ${BADGE_DOT_TONE_CLASS.info} before:opacity-60`,
  success: `bg-subtle fg-tertiary ${BADGE_DOT_TONE_CLASS.success} before:opacity-60`,
  warning: `bg-subtle fg-tertiary ${BADGE_DOT_TONE_CLASS.warning} before:opacity-60`,
  danger: `bg-subtle fg-tertiary ${BADGE_DOT_TONE_CLASS.danger} before:opacity-60`,
  special: `bg-subtle fg-tertiary ${BADGE_DOT_TONE_CLASS.special} before:opacity-60`,
};

/**
 * A badge with a leading icon: no dot, since the icon carries the tone (see
 * {@link BADGE_ICON_TONE_CLASS}).
 */
const BADGE_WITH_ICON_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-muted fg-secondary',
  info: 'bg-muted fg-primary',
  success: 'bg-muted fg-primary',
  warning: 'bg-muted fg-primary',
  danger: 'bg-muted fg-primary',
  special: 'bg-muted fg-primary',
};

/** The tone's ink for a regular badge's leading icon. */
export const BADGE_ICON_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: '',
  info: 'fg-info',
  success: 'fg-success-strong',
  warning: 'fg-warning',
  danger: 'fg-destructive-strong',
  special: 'fg-special-strong',
};

/**
 * The 16px tag has no room for a dot: the word takes the tone's ink on the
 * neutral fill.
 */
const BADGE_COMPACT_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-muted fg-secondary',
  info: 'bg-muted fg-info',
  success: 'bg-muted fg-success-strong',
  warning: 'bg-muted fg-warning-strong',
  danger: 'bg-muted fg-destructive-strong',
  special: 'bg-muted fg-special-strong',
};

const BADGE_COMPACT_MUTED_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-subtle fg-tertiary',
  info: 'bg-subtle fg-info/70',
  success: 'bg-subtle fg-success-strong/70',
  warning: 'bg-subtle fg-warning-strong/70',
  danger: 'bg-subtle fg-destructive-strong/70',
  special: 'bg-subtle fg-special-strong/70',
};

/** 12px leading glyph inside a badge. */
export const BADGE_ICON_CLASS = 'size-3 shrink-0';

/** Leading glyph class and drawn size per badge size. */
export const BADGE_ICON_BY_SIZE: Readonly<
  Record<BadgeSize, { readonly className: string; readonly px: number }>
> = {
  regular: { className: BADGE_ICON_CLASS, px: 12 },
  compact: { className: 'size-2.5 shrink-0', px: 10 },
};

/**
 * Solid label: a 20px block with a 10px label on the tone's full fill. Kept
 * for the one environment marker (the sidebar's DEV label), which reads as a
 * stamp, not a state. Its corner nests in the sidebar's `rounded-row`
 * banner: max(6px, row radius - 4px inset).
 */
export const BADGE_SOLID_BASE_CLASS =
  'inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-[max(6px,calc(var(--radius-row)-4px))] px-1.5 text-3xs font-medium leading-none';

/** Full fill and emphasis ink per tone for the solid variant. */
export const BADGE_SOLID_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-muted fg-primary',
  info: 'bg-info fg-emphasis',
  success: 'bg-success fg-emphasis',
  warning: 'bg-warning fg-emphasis',
  danger: 'bg-destructive fg-emphasis',
  special: 'bg-special fg-emphasis',
};

export type BadgeVariant = 'tint' | 'solid';

export interface BadgeClassNameOptions {
  readonly muted?: boolean;
  /** Defaults to `regular`, the 18px capsule. Ignored by `solid`. */
  readonly size?: BadgeSize;
  /** `tint` (default) is the capsule; `solid` the environment label. */
  readonly variant?: BadgeVariant;
  /**
   * The badge leads with an icon, which carries the tone
   * ({@link BADGE_ICON_TONE_CLASS}), so the capsule draws no dot.
   */
  readonly withIcon?: boolean;
}

/** Full class string for a badge: shared geometry plus the tone's fill and ink. */
export function badgeClassName(
  tone: BadgeTone,
  options: BadgeClassNameOptions = {},
): string {
  if (options.variant === 'solid') {
    return `${BADGE_SOLID_BASE_CLASS} ${BADGE_SOLID_TONE_CLASS[tone]}`;
  }
  const size = options.size ?? 'regular';
  const muted = options.muted === true;
  const toneClass =
    size === 'compact'
      ? (muted ? BADGE_COMPACT_MUTED_TONE_CLASS : BADGE_COMPACT_TONE_CLASS)[
          tone
        ]
      : muted
        ? options.withIcon === true
          ? 'bg-subtle fg-tertiary'
          : BADGE_MUTED_TONE_CLASS[tone]
        : (options.withIcon === true
            ? BADGE_WITH_ICON_TONE_CLASS
            : BADGE_TONE_CLASS)[tone];
  return `${BADGE_BASE_CLASS_BY_SIZE[size]} ${toneClass}`;
}

/** Largest number a count on an icon shows before it reads `99+`. */
export const BADGE_COUNT_CAP = 99;

/**
 * Text for a count on an icon: the number, or `99+` above the cap. Negative
 * and non-finite values read as 0; fractions round down.
 */
export function formatBadgeCount(
  value: number,
  cap: number = BADGE_COUNT_CAP,
): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  const whole = Math.floor(value);
  return whole > cap ? `${cap}+` : String(whole);
}

export type CountTone = 'neutral' | 'unread' | 'attention';

/** A count next to a label: plain quaternary ink at the label's size. */
export const LABEL_COUNT_CLASS = 'tabular-nums fg-quaternary';

/**
 * A count on an icon: 16px capsule, 10px label at 450. Tabular, because the
 * number changes in place.
 */
export const ICON_COUNT_BASE_CLASS =
  'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-3xs font-medium leading-none tabular-nums';

export const ICON_COUNT_TONE_CLASS: Readonly<Record<CountTone, string>> = {
  neutral: 'bg-quaternary fg-primary shadow-xs',
  unread: 'bg-fg-info fg-emphasis',
  attention: 'bg-fg-warning fg-emphasis',
};

export function iconCountClassName(tone: CountTone): string {
  return `${ICON_COUNT_BASE_CLASS} ${ICON_COUNT_TONE_CLASS[tone]}`;
}

/**
 * `working` is something running (a terminal, a script, an agent), `success`
 * a live connection, `danger` offline or failed. `working` and `success` share
 * the green status role but stay separate tones so a run never borrows the
 * connection meaning. All take the solid status roles, never a raw hue.
 */
export type DotTone =
  | 'unread'
  | 'attention'
  | 'filter'
  | 'working'
  | 'success'
  | 'danger'
  | 'pending';

export const DOT_BASE_CLASS = 'inline-block size-1.5 shrink-0 rounded-full';

/**
 * `regular` is the 6px dot. `large` is 8px, only where the dot stands in for
 * a row's leading icon (a permission's state, a chat with no provider icon).
 */
export type DotSize = 'regular' | 'large';

export const DOT_LARGE_BASE_CLASS = 'inline-block size-2 shrink-0 rounded-full';

const DOT_BASE_CLASS_BY_SIZE: Readonly<Record<DotSize, string>> = {
  regular: DOT_BASE_CLASS,
  large: DOT_LARGE_BASE_CLASS,
};

export const DOT_TONE_CLASS: Readonly<Record<DotTone, string>> = {
  unread: 'bg-fg-info',
  attention: 'bg-fg-warning',
  filter: 'bg-fg-quaternary',
  working: 'bg-fg-success-strong',
  success: 'bg-fg-success-strong',
  danger: 'bg-fg-destructive-strong',
  pending: 'bg-fg-quaternary/50',
};

export function dotClassName(tone: DotTone, size: DotSize = 'regular'): string {
  return `${DOT_BASE_CLASS_BY_SIZE[size]} ${DOT_TONE_CLASS[tone]}`;
}
