/**
 * The two egress-guarded desktop build profiles (docs/local-only-build.md):
 * local-only and self-host. They are mutually exclusive at build time (the
 * shared parser rejects both) and at run time (`isSelfHostBuild()` is false
 * whenever `isLocalOnlyBuild()` is true).
 *
 * A local-only build (`CANOPY_LOCAL_ONLY=true` at build time) turns every
 * hosted service and every automatic third-party call off at the source.
 * This is the lowest layer that needs the answer (`getEnhancedEnv` lives in
 * this package), so every Node-side reader goes through it; desktop main
 * re-exports it from `main/local-only/profile.ts`.
 *
 * Two inputs, following the `e2e-mock-env.ts` seam pattern:
 *
 * - the build-time `__CANOPY_LOCAL_ONLY__` constant, read with a `typeof`
 *   guard so plain-Node contexts and bundlers that never define it (tests,
 *   lab bundles, dev CLI via tsx) see `false`;
 * - the UI-automation seam `CANOPY_E2E_LOCAL_ONLY=1`, honored only when the
 *   build-time `__CANOPY_E2E__` gate is true. Production bundles fold that
 *   branch away, so the environment variable can never turn the profile on
 *   (or off) in a shipped app.
 *
 * Do not call this from feature code. Chokepoints and the automatic-call
 * policy table in `apps/desktop-app/src/main/local-only/policy.ts` are the
 * only readers; `check:local-only-egress` enforces that.
 */
export function isLocalOnlyBuild(): boolean {
  // One expression, so esbuild folds it to a literal even in the unminified
  // builtin-action bundles and the seam string never reaches a production
  // bundle (check:no-e2e-seams).
  return (
    (typeof __CANOPY_LOCAL_ONLY__ === 'boolean' && __CANOPY_LOCAL_ONLY__) ||
    (typeof __CANOPY_E2E__ !== 'undefined' &&
      __CANOPY_E2E__ &&
      process.env.CANOPY_E2E_LOCAL_ONLY === '1')
  );
}

/**
 * The self-host desktop build profile (`CANOPY_SELF_HOST=true` at build
 * time): the cloud stays on, pointed at the self-hosted server baked into
 * `__CANOPY_CLOUD_BASE_URL__`, while every third-party hosted service and
 * automatic third-party call is off and the egress guard is installed.
 *
 * Same inputs as `isLocalOnlyBuild()`: the build-time `__CANOPY_SELF_HOST__`
 * constant (with a `typeof` guard) and the UI-automation seam
 * `CANOPY_E2E_SELF_HOST=1`, honored only in an E2E build. False whenever the
 * local-only profile is on, so no site ever runs as both.
 *
 * Chokepoints only, like `isLocalOnlyBuild()`.
 */
export function isSelfHostBuild(): boolean {
  // One expression, so esbuild folds it to `false` in a normal build and the
  // seam string never reaches a production bundle (check:no-e2e-seams).
  return (
    !isLocalOnlyBuild() &&
    ((typeof __CANOPY_SELF_HOST__ === 'boolean' && __CANOPY_SELF_HOST__) ||
      (typeof __CANOPY_E2E__ !== 'undefined' &&
        __CANOPY_E2E__ &&
        process.env.CANOPY_E2E_SELF_HOST === '1'))
  );
}

/**
 * True in either egress-guarded profile. The egress guard, its host sources,
 * the MCP host notes, the blocked-host check and the child-process opt-outs
 * key off this; cloud-off behavior keys off `isLocalOnlyBuild()` alone.
 */
export function isEgressGuardedBuild(): boolean {
  return isLocalOnlyBuild() || isSelfHostBuild();
}

/**
 * Environment keys that switch off a Claude CLI child's nonessential
 * traffic (telemetry, error reporting, update checks). Shared by
 * `buildDelegationClaudeEnvironment`, which always sets the first two, and by
 * `getEnhancedEnv`, which sets all of them in a local-only build.
 */
export const CLAUDE_NONESSENTIAL_TRAFFIC_OPT_OUT_ENV = Object.freeze({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
});

/**
 * Generic telemetry opt-outs honored by the Claude CLI and other Node-based
 * tools a provider may launch.
 */
export const GENERIC_TELEMETRY_OPT_OUT_ENV = Object.freeze({
  DISABLE_TELEMETRY: '1',
  DO_NOT_TRACK: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_BUG_COMMAND: '1',
});

/**
 * Every child-process opt-out a local-only or self-host build applies. Each
 * key is a third-party switch; none turns the cloud off, so self-host
 * applies the same map. Codex has no
 * confirmed environment opt-out yet (plan spike 3b), so none is listed and
 * docs/local-only-build.md records Codex under "Known limits"; the smoke test
 * covers Claude only.
 */
export const LOCAL_ONLY_CHILD_ENV: Readonly<Record<string, string>> =
  Object.freeze({
    ...CLAUDE_NONESSENTIAL_TRAFFIC_OPT_OUT_ENV,
    ...GENERIC_TELEMETRY_OPT_OUT_ENV,
  });

/**
 * Applies the child-process opt-outs to `env` in place when either
 * egress-guarded profile is on, and returns it. A no-op in every other build.
 */
export function applyLocalOnlyChildEnv<
  T extends Record<string, string | undefined>,
>(env: T): T {
  if (!isEgressGuardedBuild()) {
    return env;
  }
  return Object.assign(env, LOCAL_ONLY_CHILD_ENV);
}
