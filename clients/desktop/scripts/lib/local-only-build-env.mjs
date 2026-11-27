/**
 * The one parser for the two egress-guarded desktop build profiles.
 *
 * - `CANOPY_LOCAL_ONLY` turns every hosted service and automatic third-party
 *   call off at build time (see docs/local-only-build.md).
 * - `CANOPY_SELF_HOST` keeps the cloud on, pointed at the self-hosted server
 *   in `CANOPY_CLOUD_BASE_URL`, and turns every third-party hosted service
 *   off (see "Self-host profile" in docs/local-only-build.md).
 *
 * The two profiles are mutually exclusive: both readers throw when both
 * variables are on, so every bundler fails whichever one it reads.
 *
 * Every bundler that defines `__CANOPY_LOCAL_ONLY__` or `__CANOPY_SELF_HOST__`
 * (electron.vite.config.ts, build-cli.mjs, build-core-daemon.mjs,
 * build-builtin-actions.mjs) must read the switches through this helper, so
 * a desktop bundle can never carry a profile beside a CLI, pipeline host or
 * builtin-action bundle that does not.
 *
 * The accepted values match `readEnvBoolean` in electron.vite.config.ts:
 * `1`, `true`, `yes` and `on`, case-insensitive, surrounding space ignored.
 */
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export const LOCAL_ONLY_BUILD_ENV = 'CANOPY_LOCAL_ONLY';
export const SELF_HOST_BUILD_ENV = 'CANOPY_SELF_HOST';

/**
 * Hosts the desktop runtime accepts over plain http (`isLocalhostHostname`
 * in apps/desktop-app/src/main/canopy-cloud/config.ts). `URL.hostname`
 * keeps the brackets on an IPv6 literal, so both spellings are listed.
 */
const HTTP_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} name
 * @returns {boolean}
 */
function readTruthy(env, name) {
  const value = env[name];
  if (typeof value !== 'string') {
    return false;
  }
  return TRUE_VALUES.has(value.trim().toLowerCase());
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
function assertOneProfile(env) {
  if (
    readTruthy(env, LOCAL_ONLY_BUILD_ENV) &&
    readTruthy(env, SELF_HOST_BUILD_ENV)
  ) {
    throw new Error(
      `${LOCAL_ONLY_BUILD_ENV} and ${SELF_HOST_BUILD_ENV} are both set. ` +
        'Set one of them: a build is either local-only or self-host.',
    );
  }
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function readLocalOnlyBuildEnv(env = process.env) {
  assertOneProfile(env);
  return readTruthy(env, LOCAL_ONLY_BUILD_ENV);
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function readSelfHostBuildEnv(env = process.env) {
  assertOneProfile(env);
  return readTruthy(env, SELF_HOST_BUILD_ENV);
}

/**
 * Validates the server URL of a self-host build and returns its origin.
 *
 * Rules: a valid URL; `https:`, or `http:` only for a loopback host (the
 * same rule `getCanopyCloudBaseUrl()` applies at run time); no path, query,
 * hash or credentials. Surrounding space is ignored and a trailing slash is
 * accepted.
 *
 * @param {string | undefined} value
 * @returns {string}
 */
export function assertSelfHostCloudBaseUrl(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new Error(
      'CANOPY_CLOUD_BASE_URL must be set for a self-host build. Set it to ' +
        'your server’s address, for example https://canopy.example.com.',
    );
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `CANOPY_CLOUD_BASE_URL is not a valid URL: ${trimmed}. Set it to your ` +
        'server’s address, for example https://canopy.example.com.',
    );
  }
  if (url.protocol === 'http:') {
    if (!HTTP_LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error(
        `CANOPY_CLOUD_BASE_URL must use https unless the server runs on this ` +
          `computer (localhost): ${trimmed}. Put the server behind TLS and ` +
          'use its https address.',
      );
    }
  } else if (url.protocol !== 'https:') {
    throw new Error(
      `CANOPY_CLOUD_BASE_URL must be an https address: ${trimmed}.`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      'CANOPY_CLOUD_BASE_URL must not include a user name or password. ' +
        'Remove them from the address.',
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(
      `CANOPY_CLOUD_BASE_URL must be the server’s origin, with no path: ` +
        `${trimmed}. Remove "${url.pathname}".`,
    );
  }
  if (
    url.search ||
    url.hash ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    throw new Error(
      `CANOPY_CLOUD_BASE_URL must not include a query or fragment: ` +
        `${trimmed}. Remove everything after the host and port.`,
    );
  }
  return url.origin;
}

/**
 * The cloud base URL a bundler should inline. Local-only builds inline an
 * empty string whatever the environment says; self-host builds inline the
 * validated server origin and fail when it is missing or invalid.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function readCloudBaseUrlForBundle(env = process.env) {
  if (readLocalOnlyBuildEnv(env)) {
    return '';
  }
  if (readSelfHostBuildEnv(env)) {
    return assertSelfHostCloudBaseUrl(env.CANOPY_CLOUD_BASE_URL);
  }
  return env.CANOPY_CLOUD_BASE_URL ?? '';
}

/**
 * The LaunchDarkly desktop client-side ID a bundler should inline. `off`
 * means no ID, and neither local-only nor self-host builds carry one.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function readLaunchDarklyClientSideIdForBundle(env = process.env) {
  if (readLocalOnlyBuildEnv(env) || readSelfHostBuildEnv(env)) {
    return '';
  }
  const value = env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID?.trim() ?? '';
  return value === 'off' ? '' : value;
}
