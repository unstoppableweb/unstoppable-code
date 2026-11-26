import { BUBBLE_BADGE_CHROME } from '../primitives/desktop-control-recipes';
export { BUBBLE_BADGE_CHROME } from '../primitives/desktop-control-recipes';
/**
 * A bubble's edge: exactly one device pixel in both color modes.
 * `shadow-bubble` owns the recipe, since the two modes need different ones. On
 * a light page it is an outer `line-base` hairline with no blur, because the
 * `shadow-sm` stack would add a half-pixel ring and soft layers beside it. In
 * dark mode the bubble sits a couple of ramp steps above a near-black
 * `bg-base`, where the black `shadow-sm` vanishes, so an inset `line-secondary`
 * hairline separates it: an outer ring composites the 12.8% white over the base
 * and lands within a few levels of the bubble's own surface, while an inset
 * ring composites over the bubble and reads as a crisp lighter edge against
 * both.
 */
const BUBBLE_SURFACE_HAIRLINE = 'shadow-bubble';

/**
 * The neutral surface shared by the sent user bubble and the queued bubble it
 * will become: `bg-quaternary` (same white as `bg-tertiary` in light, one
 * ramp step brighter in dark) inside the bubble hairline, with the one inset
 * every variant shares (`px-3 py-2`) so sent, watcher-fired, and queued
 * bubbles keep identical top and bottom padding. Consumers add only text
 * roles.
 */
export const BUBBLE_SURFACE_CLASS = `rounded-xl bg-quaternary px-3 py-2 ${BUBBLE_SURFACE_HAIRLINE}`;

/**
 * Flat variant of {@link BUBBLE_SURFACE_CLASS}: the muted fill, with no
 * elevation or hairline, for a chat that sits on a raised surface of its own
 * (the App Advisor panel). The inset stays the same.
 */
export const BUBBLE_MUTED_SURFACE_CLASS = 'rounded-xl bg-muted px-3 py-2';

/**
 * Info-tinted variant of {@link BUBBLE_SURFACE_CLASS} for Canopy-generated
 * (watcher-fired) messages. Only the tint changes; the hairline stays.
 */
export const BUBBLE_INFO_SURFACE_CLASS = `rounded-xl bg-info-subtle px-3 py-2 ${BUBBLE_SURFACE_HAIRLINE}`;

/** Compact badge for the passive leading indicator (10px glyph). */
export const BUBBLE_INDICATOR_BADGE_CLASS = `${BUBBLE_BADGE_CHROME} h-5 w-5`;

/** Interactive corner action, sized for the standard 14px glyph. */
export const BUBBLE_ACTION_BADGE_CLASS = `${BUBBLE_BADGE_CHROME} h-7 w-7 transition-colors hover:fg-primary`;

/** Glyph size for the passive leading indicator. */
export const BUBBLE_INDICATOR_GLYPH_PX = 10;

/** Glyph size for the interactive corner actions. */
export const BUBBLE_ACTION_GLYPH_PX = 14;
