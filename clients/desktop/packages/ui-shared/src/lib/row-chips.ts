import { BADGE_BASE_CLASS, badgeClassName, type BadgeTone } from './badge';
import type { OperationalStatus } from './operational-status-colors';

/**
 * Row chips and the house secondary surface. A pipeline run row (and any
 * other compact activity row) shows a read-only STATUS BADGE beside its
 * actions; the actions are `Button`s (through `ExecutionActionButton`).
 *
 * Status badges are the shared Badge capsule: a `*-subtle` tint and the
 * tone's strong ink, with no ring or border. Secondary controls sit on the
 * shared {@link SECONDARY_SURFACE_CLASS} and differ by ink only. Neither
 * uses a `border-<color>` utility, which the unlayered base border rule
 * paints over (CAN-2734).
 */

/**
 * One physical-pixel inset edge for tinted notices and rows: the width comes
 * from `--border-hairline` (1px, 0.5px on Retina) so it matches the house
 * hairline, and it is a ring rather than a border because `border-<color>`
 * utilities are inert under the unlayered base border rule (CAN-2734).
 * Pair it with a `ring-line-*` or `ring-status-*` colour.
 */
export const HAIRLINE_INSET_RING_CLASS =
  'ring-[length:var(--border-hairline)] ring-inset';

/**
 * Status badges are the shared 18px {@link badgeClassName} capsule: tinted
 * `-subtle` fill and strong ink, no ring and no border.
 */
export const STATUS_BADGE_BASE_CLASS = BADGE_BASE_CLASS;

/**
 * Operational statuses map onto the app-wide status vocabulary; `warning`
 * is the theme attention intent (input required, stale advisor) and
 * `neutral` is the quiet informational chip.
 */
export type StatusBadgeTone = OperationalStatus | 'warning' | 'neutral';

export interface StatusBadgeClassNameOptions {
  /**
   * Reduced-emphasis colour set for a completed row: quiet ink. Geometry is
   * unchanged.
   */
  readonly muted?: boolean;
}

/**
 * Run state to badge tone, following `OPERATIONAL_STATUS_COLORS`: unread and
 * running are info, failed is danger, merged is special, paused is neutral.
 */
const STATUS_BADGE_TONE: Readonly<Record<StatusBadgeTone, BadgeTone>> = {
  unread: 'info',
  active: 'info',
  failed: 'danger',
  success: 'success',
  merged: 'special',
  paused: 'neutral',
  warning: 'warning',
  neutral: 'neutral',
};

/** The badge tone a status badge paints. */
export function statusBadgeTone(tone: StatusBadgeTone): BadgeTone {
  return STATUS_BADGE_TONE[tone];
}

/** Full class string for a status badge: the shared badge in the status's tone. */
export function statusBadgeClassName(
  tone: StatusBadgeTone,
  options: StatusBadgeClassNameOptions = {},
): string {
  return badgeClassName(STATUS_BADGE_TONE[tone], {
    muted: options.muted === true,
  });
}

/**
 * The resting shell of the house secondary control surface: quaternary
 * fill, `shadow-sm` elevation, and a 0.5px `line-secondary` hairline. The
 * hairline is what keeps the shell reading as a raised control in dark mode,
 * where the black shadow vanishes against a near-black base. Only split
 * controls whose segments hover independently (the header `Open in` pill)
 * use this on its own; everything else takes {@link SECONDARY_SURFACE_CLASS}.
 */
export const SECONDARY_SURFACE_SHELL_CLASS =
  'bg-quaternary shadow-sm ring-[length:var(--border-hairline)] ring-line-secondary';

/**
 * The secondary surface's hover: a `--bg-subtle` gradient overlay rather
 * than a background swap, so the quaternary token stays the single source
 * of the base colour.
 */
export const SECONDARY_SURFACE_HOVER_CLASS =
  'hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]';

/**
 * The secondary surface's hover look, held while the control's menu is open
 * (`aria-expanded`), so a dropdown or menu button reads as engaged.
 */
export const SECONDARY_SURFACE_OPEN_CLASS =
  'aria-expanded:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]';

/**
 * The house SECONDARY CONTROL SURFACE: the quaternary shell, `shadow-sm`
 * elevation, and 0.5px `line-secondary` hairline of the worktree header
 * `Open in` pill, with the `--bg-subtle` overlay on hover. Every secondary
 * button, action chip, and split control composes this exact string; it
 * carries no ink, so callers add one `fg-*` role from
 * {@link secondaryToneClassName}.
 */
export const SECONDARY_SURFACE_CLASS = `${SECONDARY_SURFACE_SHELL_CLASS} ${SECONDARY_SURFACE_HOVER_CLASS}`;

/**
 * Ink tones for a control on {@link SECONDARY_SURFACE_CLASS}. The tone never
 * changes the surface: a warning Retry, a destructive Start over, and an
 * accent git action are all the same quaternary shell with different text.
 */
export type SecondaryTone = 'neutral' | 'warning' | 'destructive' | 'accent';

const SECONDARY_TONE_INK: Record<SecondaryTone, string> = {
  neutral: 'fg-primary',
  warning: 'fg-warning',
  destructive: 'fg-destructive',
  accent: 'fg-accent',
};

/** The single `fg-*` role a secondary control paints for `tone`. */
export function secondaryToneClassName(tone: SecondaryTone): string {
  return SECONDARY_TONE_INK[tone];
}
