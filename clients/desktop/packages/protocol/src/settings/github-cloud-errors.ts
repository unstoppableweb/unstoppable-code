// ---------------------------------------------------------------------------
// "GitHub for cloud" typed errors (REG-3020).
//
// Moved verbatim from `apps/web/src/lib/github/cloud-connection-errors.ts`,
// which re-exports it, so the shared GitHub settings UI, desktop, and the web
// routes share one table. Browser-safe: no imports. The service throws only these codes for
// expected outcomes; the routes serialize them as exactly `{ error, code }`
// with the status below, and the client maps an allowlisted `code` to its own
// copy (an arbitrary body carrying a string `code` is never displayed as-is).
// Messages are fixed safe copy: never a provider message, token or nonce.
//
// Durable effects per code (enforced by the service, documented here):
// - disconnected: none.
// - needs-reauth: generation-fenced NEEDS_REAUTH only with current credential
//   evidence; otherwise (another verified GitHub identity, an unconfirmed
//   refresh rejection) none, and the user is offered Reconnect.
// - needs-install: target-specific; never a global authorization failure.
// - adoption-pending: retry adoption; never ask to reinstall merely because
//   Core is unavailable.
// - state-invalid / installation-not-visible: no target or adoption mutation.
// - operation-superseded: no stale mutation; refresh the projection.
// - rate-limited / unavailable: no connection change.
// ---------------------------------------------------------------------------

export const GITHUB_CLOUD_ERROR_CODES = [
  'github-cloud-disconnected',
  'github-cloud-needs-reauth',
  'github-cloud-needs-install',
  'github-cloud-adoption-pending',
  'github-cloud-state-invalid',
  'github-cloud-installation-not-visible',
  'github-cloud-operation-superseded',
  'github-rate-limited',
  'github-unavailable',
] as const;
export type GitHubCloudErrorCode = (typeof GITHUB_CLOUD_ERROR_CODES)[number];

export type GitHubCloudErrorStatus = 400 | 403 | 409 | 429 | 502 | 503;

export const GITHUB_CLOUD_ERROR_STATUS: Readonly<
  Record<GitHubCloudErrorCode, GitHubCloudErrorStatus>
> = {
  'github-cloud-disconnected': 409,
  'github-cloud-needs-reauth': 409,
  'github-cloud-needs-install': 409,
  'github-cloud-adoption-pending': 503,
  'github-cloud-state-invalid': 400,
  'github-cloud-installation-not-visible': 403,
  'github-cloud-operation-superseded': 409,
  'github-rate-limited': 429,
  'github-unavailable': 502,
};

export const GITHUB_CLOUD_ERROR_COPY: Readonly<
  Record<GitHubCloudErrorCode, string>
> = {
  'github-cloud-disconnected': "GitHub isn't linked. Link GitHub to continue.",
  'github-cloud-needs-reauth':
    'GitHub needs you to sign in again. Reconnect GitHub to continue.',
  'github-cloud-needs-install':
    "The GitHub app isn't available for this account or organization. Install it, then check again.",
  'github-cloud-adoption-pending':
    'GitHub setup is still finishing. Check again in a moment.',
  'github-cloud-state-invalid':
    "Couldn't finish GitHub setup because this link expired or was already used. Start again from Settings.",
  'github-cloud-installation-not-visible':
    "Couldn't find that GitHub installation for your GitHub account. Check that you can access it, then try again.",
  'github-cloud-operation-superseded':
    'Your GitHub connection changed while this was running. Check again.',
  'github-rate-limited': 'GitHub rate limit reached. Try again in a minute.',
  'github-unavailable': "Couldn't reach GitHub. Try again.",
};

export function isGitHubCloudErrorCode(
  value: unknown,
): value is GitHubCloudErrorCode {
  return GITHUB_CLOUD_ERROR_CODES.some((code) => code === value);
}

/** An expected, typed outcome of the connection service. */
export class GitHubCloudConnectionError extends Error {
  readonly code: GitHubCloudErrorCode;
  readonly status: GitHubCloudErrorStatus;
  /**
   * The canopy.json child repository (`owner/name`) a multi-repo project
   * failure is about (REG-3023); repository routes return it as a detail.
   */
  readonly repositoryFullName?: string;

  constructor(
    code: GitHubCloudErrorCode,
    options: { readonly repositoryFullName?: string } = {},
  ) {
    super(GITHUB_CLOUD_ERROR_COPY[code]);
    this.name = 'GitHubCloudConnectionError';
    this.code = code;
    this.status = GITHUB_CLOUD_ERROR_STATUS[code];
    if (options.repositoryFullName !== undefined) {
      this.repositoryFullName = options.repositoryFullName;
    }
  }
}

export function isGitHubCloudConnectionError(
  error: unknown,
): error is GitHubCloudConnectionError {
  return error instanceof GitHubCloudConnectionError;
}

export interface GitHubCloudErrorBody {
  error: string;
  code: GitHubCloudErrorCode;
}

/** The route response body: the fixed safe copy and the code, nothing else. */
export function toGitHubCloudErrorBody(
  error: GitHubCloudConnectionError,
): GitHubCloudErrorBody {
  return { error: GITHUB_CLOUD_ERROR_COPY[error.code], code: error.code };
}

/**
 * The allowlisted code of an untrusted error body, or null. Display the local
 * copy for it; never the body's own `error` text.
 */
export function readGitHubCloudErrorCode(
  body: unknown,
): GitHubCloudErrorCode | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const code: unknown = Reflect.get(body, 'code');
  return isGitHubCloudErrorCode(code) ? code : null;
}
