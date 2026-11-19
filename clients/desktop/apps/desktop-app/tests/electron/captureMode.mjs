/**
 * Seeds the color mode a capture should render in.
 * The canonical runnable consumer is
 * `portal/can-769-first-login.capture-spec.ts`.
 * CAN769_STAGE=after pnpm run test:electron:captures:built portal/can-769-first-login.capture-spec.ts
 *
 * BOTH storage keys are written, deliberately:
 *
 *   - `<brand-id>-theme` -- what the CURRENT web app reads. `next-themes` is
 *     mounted with a brand-scoped `storageKey`, so this is the only key that
 *     controls a present-day capture.
 *   - `theme` -- the legacy key, for BEFORE-STAGE captures. Specs like
 *     `can-2527-digest-anchors-on-demand` (`CAN2527_BEFORE_REPO_ROOT`) and
 *     `can-1939-landing-hero` (`CAN1939_WEB_APP_DIR`) start a PRE-CHANGE web
 *     tree whose layout has no scoped `storageKey` and reads only `theme`.
 *     Seeding just the scoped key would leave those runs on the old hard-coded
 *     `dark` default while the artifact is saved as a light baseline -- a
 *     silently mislabeled before/after pair, which is worse than a failure
 *     because it looks like evidence.
 *
 * Writing both is safe in both directions: a current layout prefers the scoped
 * key and ignores the legacy one, and a pre-change layout does not know the
 * scoped key exists.
 *
 * CAVEAT, stated plainly because it weakens `assertBrandId` below: that guard
 * validates the SHAPE of `brandId`, not its correctness. With the legacy key
 * also seeded, a right-shaped but WRONG `brandId` is rescued at runtime by the
 * production carry-forward shim -- the served brand's key is absent, so the
 * shim copies `theme` into it and the capture renders correctly anyway. The
 * mis-propagation therefore stays invisible until the shim retires, at which
 * point such a capture silently starts rendering the brand default. The shim
 * only fails to fire when `brandId` is already correct, i.e. in the case that
 * did not need protecting. When the shim is retired (see the RETIREMENT note
 * in `apps/web/src/lib/theme-storage.ts`), drop the legacy seed here and
 * re-check every before-stage capture spec.
 *
 * `brandId` is REQUIRED and must be the brand the server under test actually
 * serves. For the Remote Control harness that is
 * `startPortalWebServer(...).brandId` (`remote-control/harness/web-server.mjs`),
 * which the harness also pins into the server's own
 * environment. It is deliberately not defaulted: a missing propagation would
 * otherwise fall back to a plausible brand and produce a screenshot in the
 * wrong color mode, which is far worse than a loud failure.
 */
export const LEGACY_CAPTURE_THEME_STORAGE_KEY = 'theme';
/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ colorScheme?: 'light' | 'dark' }}
 */
export function captureColorSchemeOptions(env = process.env) {
  const colorMode = env.CANOPY_E2E_CAPTURE_COLOR_MODE;
  return colorMode === 'light' || colorMode === 'dark'
    ? { colorScheme: colorMode }
    : {};
}

function assertBrandId(brandId) {
  if (typeof brandId !== 'string' || brandId.length === 0) {
    throw new Error(
      'captureMode: brandId is required and must be the brand the server ' +
        'under test serves (e.g. startPortalWebServer(...).brandId). Seeding ' +
        'a guessed brand writes a storage key the app never reads.',
    );
  }
  return brandId;
}

export function captureThemeInitScript(env = process.env, brandId) {
  const colorMode = env.CANOPY_E2E_CAPTURE_COLOR_MODE;
  if (colorMode !== 'light' && colorMode !== 'dark') return null;
  return {
    storageKey: `${assertBrandId(brandId)}-theme`,
    legacyStorageKey: LEGACY_CAPTURE_THEME_STORAGE_KEY,
    theme: colorMode,
  };
}

export async function seedCaptureTheme(context, env = process.env, brandId) {
  // Validate before the color-mode early-out so a missing propagation fails on
  // every run, not only on the runs that happen to request a color mode.
  assertBrandId(brandId);
  const themeInit = captureThemeInitScript(env, brandId);
  if (!themeInit) return;
  await context.addInitScript(({ storageKey, legacyStorageKey, theme }) => {
    window.localStorage.setItem(storageKey, theme);
    // Also seed the legacy key so a before-stage (pre-change) web tree, which
    // reads only that key, renders the requested mode instead of its old
    // hard-coded default.
    window.localStorage.setItem(legacyStorageKey, theme);
  }, themeInit);
}
