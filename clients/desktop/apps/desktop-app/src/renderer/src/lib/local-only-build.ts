/**
 * The renderer's view of the local-only and self-host build profiles
 * (docs/local-only-build.md). The renderer cannot read `process.env`, so it
 * cannot evaluate the E2E seams itself: preload evaluates each profile once
 * and exposes it as the static `window.api.localOnlyBuild` and
 * `window.api.selfHostBuild` constants. Absent (a remote window, tests, an
 * older preload) means a normal build.
 *
 * Read them only from the desktop capability adapter and the few surfaces
 * `check:local-only-egress` allows; shared components take capabilities
 * instead.
 */
export function isLocalOnlyBuild(): boolean {
  if (typeof window === 'undefined') return false;
  return window.api?.localOnlyBuild === true;
}

/**
 * True in a self-host build. Preload already reports false whenever the
 * local-only profile is on; the extra check keeps the two exclusive even if
 * an older preload exposed both.
 */
export function isSelfHostBuild(): boolean {
  if (typeof window === 'undefined') return false;
  return !isLocalOnlyBuild() && window.api?.selfHostBuild === true;
}

/** True in either profile, the builds that run the egress guard. */
export function isEgressGuardedBuild(): boolean {
  return isLocalOnlyBuild() || isSelfHostBuild();
}
