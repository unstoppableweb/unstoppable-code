import { toAppError, type AppError } from '@canopy/protocol/app-errors';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import {
  GitHubCloudApiError,
  GitHubCloudRepositoryApiError,
} from '../github/github-cloud-api';
import { MemoryRequestError } from '../memory/api';
import { TeamApiError } from '../organization/team-api';
import type { SettingsLogger } from '../host/settings-host';

/**
 * Friendly copy for failed settings loads and actions.
 *
 * Settings never render server error text. A call site maps the failure's
 * facts (HTTP status, transport code, the route's structured `serverCode`)
 * onto local copy: the known cases it lists first, then offline and
 * uncertain outcomes, then generic copy. The raw details go to logs only,
 * through {@link logSettingsError} or `useSettingsErrorCopy`.
 *
 * Access loss is not an error message. When {@link isSettingsAccessLost} is
 * true for a failure on an organization route, the host re-reads the
 * bootstrap and shows its existing access-lost notice (desktop returns to
 * Organizations with the notice; web re-renders the protected route), instead
 * of showing copy. Use `useSettingsLoadFailure` or
 * `useSettingsAccessLostRefresh`, which refresh at most once per mount.
 */

/** What a failed settings call tells the UI, without any server text. */
export interface SettingsErrorFacts {
  /** HTTP status, when the server answered. */
  readonly status?: number;
  /**
   * The client's failure code: a `SettingsErrorCode` for settings client
   * calls, or the failure kind of a GitHub for cloud call.
   */
  readonly code?: string;
  /** The route's structured code (`last_owner`, `no_saved_card`). */
  readonly serverCode?: string;
  /** The request never reached the server. */
  readonly offline: boolean;
  /** The request was sent but its outcome is unknown; it may have applied. */
  readonly uncertain: boolean;
}

/**
 * A failure a call site has local copy for. It matches when every field it
 * sets equals the failure's fact; a case that sets none never matches.
 */
export interface KnownSettingsError {
  readonly status?: number;
  readonly serverCode?: string;
  readonly code?: string;
  readonly copy: string;
}

export const SETTINGS_LOAD_ERROR_COPY = "Couldn't load this. Try again.";

export const SETTINGS_OFFLINE_ERROR_COPY =
  "You're offline. Check your connection and try again.";

export const SETTINGS_UNCERTAIN_ERROR_COPY =
  "Couldn't confirm that finished. Refresh to check before trying again.";

/** Longest server text a log line carries; the full text stays in `meta`. */
export const SETTINGS_ERROR_LOG_DETAIL_MAX = 200;

/** Statuses a gateway returns after forwarding a request that may have run. */
const UNCERTAIN_STATUSES: ReadonlySet<number> = new Set([502, 504]);

/** Settings client codes that mean the viewer lost the session or access. */
const ACCESS_LOST_CODES: ReadonlySet<string> = new Set([
  'unauthenticated',
  'expired',
  'forbidden',
]);

/**
 * The message a browser `fetch` rejects with when it got no answer. Wording
 * varies by engine and locale; a miss falls back to `navigator.onLine`, then
 * to the generic copy.
 */
const FETCH_NETWORK_FAILURE =
  /failed to fetch|fetch failed|networkerror|network request failed|load failed/i;

interface RawFacts {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly serverCode: string | undefined;
}

function rawFacts(error: unknown): RawFacts {
  if (
    error instanceof SettingsOperationError ||
    error instanceof MemoryRequestError
  )
    return {
      status: error.status,
      code: error.code,
      serverCode: error.serverCode,
    };
  if (error instanceof TeamApiError)
    return { status: error.status, code: undefined, serverCode: error.code };
  if (
    error instanceof GitHubCloudApiError ||
    error instanceof GitHubCloudRepositoryApiError
  )
    return {
      status: error.status ?? undefined,
      code: error.kind,
      serverCode: error.code ?? undefined,
    };
  return { status: undefined, code: undefined, serverCode: undefined };
}

function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function errorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException)
    return error.name;
  return undefined;
}

function isFetchNetworkFailure(error: unknown): boolean {
  return (
    error instanceof TypeError && FETCH_NETWORK_FAILURE.test(error.message)
  );
}

/** The facts of a failed settings call. Never reads the server's text. */
export function settingsErrorFacts(error: unknown): SettingsErrorFacts {
  const raw = rawFacts(error);
  const name = errorName(error);
  const offline =
    raw.status === undefined &&
    (raw.code === 'offline' ||
      raw.code === 'network' ||
      isFetchNetworkFailure(error) ||
      // A dropped write may have landed; that outranks the browser's guess.
      (raw.code !== 'uncertain' && browserOffline()));
  const uncertain =
    !offline &&
    ((raw.status !== undefined && UNCERTAIN_STATUSES.has(raw.status)) ||
      (raw.status === undefined && raw.code === 'uncertain') ||
      name === 'AbortError' ||
      name === 'TimeoutError');
  return {
    ...(raw.status !== undefined ? { status: raw.status } : {}),
    ...(raw.code !== undefined ? { code: raw.code } : {}),
    ...(raw.serverCode !== undefined ? { serverCode: raw.serverCode } : {}),
    offline,
    uncertain,
  };
}

/**
 * Whether the failure means the viewer lost the session or access to the
 * organization (401/403, or the settings client's `unauthenticated`,
 * `expired` and `forbidden` codes). Callers on organization routes send these
 * through the host's access-lost path (`useSettingsRouter().refresh()`)
 * rather than showing copy.
 */
export function isSettingsAccessLost(error: unknown): boolean {
  const facts = settingsErrorFacts(error);
  if (facts.status === 401 || facts.status === 403) return true;
  return facts.code !== undefined && ACCESS_LOST_CODES.has(facts.code);
}

function matchesKnown(
  facts: SettingsErrorFacts,
  known: KnownSettingsError,
): boolean {
  if (
    known.status === undefined &&
    known.serverCode === undefined &&
    known.code === undefined
  )
    return false;
  return (
    (known.status === undefined || known.status === facts.status) &&
    (known.serverCode === undefined || known.serverCode === facts.serverCode) &&
    (known.code === undefined || known.code === facts.code)
  );
}

function knownCopy(
  facts: SettingsErrorFacts,
  known: readonly KnownSettingsError[] | undefined,
): string | null {
  const match = known?.find((entry) => matchesKnown(facts, entry));
  return match?.copy ?? null;
}

/** The first known case the failure matches, if any. */
export function findKnownSettingsError(
  error: unknown,
  known: readonly KnownSettingsError[] | undefined,
): KnownSettingsError | undefined {
  if (known === undefined || known.length === 0) return undefined;
  const facts = settingsErrorFacts(error);
  return known.find((entry) => matchesKnown(facts, entry));
}

/**
 * Copy for a failed load: the first matching known case, otherwise
 * {@link SETTINGS_LOAD_ERROR_COPY}. Pair it with an `ErrorBanner` retry.
 */
export function settingsLoadErrorCopy(
  error: unknown,
  known?: readonly KnownSettingsError[],
): string {
  return (
    knownCopy(settingsErrorFacts(error), known) ?? SETTINGS_LOAD_ERROR_COPY
  );
}

export interface SettingsActionErrorOptions {
  /**
   * What the user tried, as a lowercase verb phrase completing
   * `Couldn't <action>.`: `rename this organization`, `send the invite`.
   */
  readonly action: string;
  readonly known?: readonly KnownSettingsError[];
}

/**
 * Copy for a failed action: the first matching known case, then the offline
 * and uncertain copy, otherwise `Couldn't <action>. Try again.`
 */
export function settingsActionErrorCopy(
  error: unknown,
  { action, known }: SettingsActionErrorOptions,
): string {
  const facts = settingsErrorFacts(error);
  const match = knownCopy(facts, known);
  if (match !== null) return match;
  if (facts.offline) return SETTINGS_OFFLINE_ERROR_COPY;
  if (facts.uncertain) return SETTINGS_UNCERTAIN_ERROR_COPY;
  return `Couldn't ${action}. Try again.`;
}

/**
 * The failure's raw text for logs: the route's `{ error }` text when the
 * server sent one, otherwise the error's own message. Never render it.
 */
export function settingsErrorDetail(error: unknown): string | undefined {
  if (error instanceof TeamApiError || error instanceof MemoryRequestError)
    return error.serverDetail;
  if (error instanceof SettingsOperationError)
    return error.message !== error.code ? error.message : undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return undefined;
}

/**
 * A failed settings call as the UI holds it: our own sentence (`copy`), which
 * renders, and the raw reason (`details`), which never renders. Pass `details`
 * to `ErrorBanner` (or `CopyDetailsButton` in a `Notice`), which copies it for
 * support behind a `Copy details` action.
 */
export interface SettingsFailure {
  readonly copy: string;
  readonly details?: string;
  /**
   * The caught error as an AppError, for recording the failure; never
   * rendered. A restored IPC rejection keeps the shape main recorded, so a
   * report links to its reference. Absent for a cancellation.
   */
  readonly appError?: AppError;
}

/**
 * The raw reason a `Copy details` action hands to the clipboard, or
 * `undefined` when there is none worth copying (empty, or the same words as
 * our sentence).
 */
export function settingsFailureDetails(
  error: unknown,
  copy: string,
): string | undefined {
  const detail = settingsErrorDetail(error)?.trim();
  if (detail === undefined || detail === '' || detail === copy.trim())
    return undefined;
  return detail;
}

/** Recording is best effort: it never stops the failure's copy from showing,
 * for example when a host has no Web Crypto for a fresh reference. */
function settingsAppError(error: unknown): AppError | undefined {
  try {
    return toAppError(error);
  } catch {
    return undefined;
  }
}

/** Builds a {@link SettingsFailure} from a caught error and its copy. */
export function settingsFailure(error: unknown, copy: string): SettingsFailure {
  const details = settingsFailureDetails(error, copy);
  const appError = settingsAppError(error);
  return {
    copy,
    ...(details === undefined ? {} : { details }),
    ...(appError === undefined ? {} : { appError }),
  };
}

function truncateDetail(detail: string): string {
  return detail.length > SETTINGS_ERROR_LOG_DETAIL_MAX
    ? `${detail.slice(0, SETTINGS_ERROR_LOG_DETAIL_MAX)}…`
    : detail;
}

/**
 * Log a failed settings call. Some hosts drop `meta`, so the message itself
 * carries the facts and the server text truncated to
 * {@link SETTINGS_ERROR_LOG_DETAIL_MAX} characters; `meta` carries the full
 * text. Logs are never user-visible.
 */
export function logSettingsError(
  logger: SettingsLogger,
  context: string,
  error: unknown,
): void {
  const facts = settingsErrorFacts(error);
  const detail = settingsErrorDetail(error);
  const parts = [
    facts.status !== undefined ? `status=${facts.status}` : null,
    facts.code !== undefined ? `code=${facts.code}` : null,
    facts.serverCode !== undefined ? `serverCode=${facts.serverCode}` : null,
    facts.offline ? 'offline' : null,
    facts.uncertain ? 'uncertain' : null,
  ].filter((part): part is string => part !== null);
  const summary = parts.length > 0 ? ` (${parts.join(' ')})` : '';
  const text =
    detail !== undefined && detail !== '' ? `: ${truncateDetail(detail)}` : '';
  logger.warn(`${context} failed${summary}${text}`, {
    ...facts,
    ...(detail !== undefined ? { detail } : {}),
    errorName: errorName(error),
  });
}
