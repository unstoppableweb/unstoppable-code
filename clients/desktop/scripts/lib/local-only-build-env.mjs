/**
 * The one parser for the local-only desktop build profile switch.
 *
 * `CANOPY_LOCAL_ONLY` turns every hosted service and automatic third-party
 * call off at build time (see docs/local-only-build.md). Every bundler that
 * defines `__CANOPY_LOCAL_ONLY__` (electron.vite.config.ts, build-cli.mjs,
 * build-core-daemon.mjs, build-builtin-actions.mjs) must read the switch
 * through this helper, so a desktop bundle can never be local-only beside a
 * CLI, pipeline host or builtin-action bundle that is not.
 *
 * The accepted values match `readEnvBoolean` in electron.vite.config.ts:
 * `1`, `true`, `yes` and `on`, case-insensitive, surrounding space ignored.
 */
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export const LOCAL_ONLY_BUILD_ENV = 'CANOPY_LOCAL_ONLY';

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function readLocalOnlyBuildEnv(env = process.env) {
  const value = env[LOCAL_ONLY_BUILD_ENV];
  if (typeof value !== 'string') {
    return false;
  }
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

/**
 * The cloud base URL a bundler should inline. Local-only builds inline an
 * empty string whatever the environment says.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function readCloudBaseUrlForBundle(env = process.env) {
  if (readLocalOnlyBuildEnv(env)) {
    return '';
  }
  return env.CANOPY_CLOUD_BASE_URL ?? '';
}

/**
 * The LaunchDarkly desktop client-side ID a bundler should inline. `off`
 * means no ID, and local-only builds never carry one.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function readLaunchDarklyClientSideIdForBundle(env = process.env) {
  if (readLocalOnlyBuildEnv(env)) {
    return '';
  }
  const value = env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID?.trim() ?? '';
  return value === 'off' ? '' : value;
}
