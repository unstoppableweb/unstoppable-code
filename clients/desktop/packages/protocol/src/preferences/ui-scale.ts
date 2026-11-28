/**
 * The interface-scale range and its stepping, shared by everything that can
 * change the scale.
 *
 * `PreferencesData.uiScale` (a percentage) is the single source of truth for
 * the desktop app's uniform page zoom. Three surfaces move it and they must
 * agree on the same range and the same grid, or the dropdown and the shortcuts
 * would offer different scales and normalization would silently rewrite one
 * of them:
 *
 * - the Display settings dropdown (`settings/DisplayTab.tsx`);
 * - the View menu's Zoom In / Zoom Out / Actual Size items (`main/menu.ts`);
 * - `normalizePreferences`, which clamps and snaps on every read and write.
 *
 * Browser-safe and dependency-free so the renderer, Electron main and the
 * preference store can all import it.
 */

/** Smallest supported interface scale, in percent. */
export const UI_SCALE_MIN = 50;

/** Largest supported interface scale, in percent. */
export const UI_SCALE_MAX = 200;

/** The unzoomed scale: 100% maps to a zoom factor of 1. */
export const UI_SCALE_DEFAULT = 100;

/** Grid the scale snaps to, in percentage points. */
export const UI_SCALE_STEP = 5;

/** What a scale command asks for, relative to the current scale. */
export type UiScaleAdjustment = 'in' | 'out' | 'actual-size';

function readScale(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : UI_SCALE_DEFAULT;
}

/**
 * The supported scale nearest `value`: snapped to {@link UI_SCALE_STEP} and
 * clamped into {@link UI_SCALE_MIN}–{@link UI_SCALE_MAX}. Anything that is
 * not a finite number falls back to {@link UI_SCALE_DEFAULT}.
 */
export function clampUiScale(value: number | undefined): number {
  const snapped = Math.round(readScale(value) / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, snapped));
}

/**
 * The scale one command moves `current` to.
 *
 * Stepping walks the grid rather than adding to `current`, so a scale that
 * was hand-edited off the grid lands on the next grid stop in the requested
 * direction instead of carrying its offset forever. Both ends stop rather
 * than wrap: holding the shortcut down at 200% is a no-op, not a jump back
 * to 50%.
 */
export function adjustUiScale(
  current: number | undefined,
  adjustment: UiScaleAdjustment,
): number {
  if (adjustment === 'actual-size') return UI_SCALE_DEFAULT;
  const scale = readScale(current);
  const next =
    adjustment === 'in'
      ? Math.floor(scale / UI_SCALE_STEP) * UI_SCALE_STEP + UI_SCALE_STEP
      : Math.ceil(scale / UI_SCALE_STEP) * UI_SCALE_STEP - UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, next));
}
