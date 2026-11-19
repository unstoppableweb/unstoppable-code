/**
 * Builder for the options object passed to `new Octokit({...})`.
 *
 * The `baseUrl` redirect is an E2E-only seam: it must NEVER survive in a
 * production bundle (Doc 11 security requirement —
 * `docs/ui-automation-coverage/11-build-time-gating-principle.md`). The
 * `if (__CANOPY_E2E__) { ... }` gate lives in `resolveE2eGithubApiBaseUrl`
 * below so every Octokit construction site picks up the seam by calling
 * `resolveOctokitClientOptions`; production builds fold the gate to
 * `return undefined` and strip the env read. The pure two-arg
 * `buildOctokitClientOptions` stays exported so the option shape can be
 * unit-tested directly (Jest runs with `__CANOPY_E2E__` false, so the gate
 * itself is not exercised there).
 */

/** Options accepted by the `@octokit/rest` `Octokit` constructor we use. */
export interface OctokitClientOptions {
  auth: string;
  baseUrl?: string;
}

/** Octokit's logger. Each method receives a message and nothing else. */
export interface OctokitClientLog {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Options for the broker's credential-free client: no `auth`, an auth
 * strategy whose hook Octokit wraps first (so it runs innermost, after every
 * plugin hook), and an explicit logger.
 */
export interface OctokitBrokerClientOptions {
  authStrategy: () => unknown;
  log: OctokitClientLog;
  baseUrl?: string;
}

/**
 * Build the Octokit constructor options.
 *
 * When `baseUrl` is a non-empty string it is included so requests target the
 * mock REST server; otherwise it is omitted so Octokit uses its default
 * `https://api.github.com`.
 */
export function buildOctokitClientOptions(
  auth: string,
  baseUrl?: string,
): OctokitClientOptions {
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    return { auth, baseUrl };
  }
  return { auth };
}

function resolveE2eGithubApiBaseUrl(): string | undefined {
  if (__CANOPY_E2E__) {
    return process.env.CANOPY_GITHUB_API_BASE_URL;
  }
  return undefined;
}

/**
 * Build Octokit options with the E2E base-URL seam applied. All Octokit
 * construction sites must use this instead of hand-rolling the gate.
 */
export function resolveOctokitClientOptions(
  auth: string,
): OctokitClientOptions {
  return buildOctokitClientOptions(auth, resolveE2eGithubApiBaseUrl());
}

/** Broker client options with the E2E base-URL seam applied. */
export function resolveOctokitBrokerClientOptions(
  authStrategy: () => unknown,
  log: OctokitClientLog,
): OctokitBrokerClientOptions {
  const baseUrl = resolveE2eGithubApiBaseUrl();
  return typeof baseUrl === 'string' && baseUrl.length > 0
    ? { authStrategy, log, baseUrl }
    : { authStrategy, log };
}
