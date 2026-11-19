/**
 * The renderer's view of the local-only build profile
 * (docs/local-only-build.md). The renderer cannot read `process.env`, so it
 * cannot evaluate the E2E seam itself: preload evaluates the profile once and
 * exposes it as the static `window.api.localOnlyBuild` constant. Absent (a
 * remote window, tests, an older preload) means a normal build.
 *
 * Read it only from the desktop capability adapter and the few surfaces
 * `check:local-only-egress` allows; shared components take capabilities
 * instead.
 */
export function isLocalOnlyBuild(): boolean {
  if (typeof window === 'undefined') return false;
  return window.api?.localOnlyBuild === true;
}
