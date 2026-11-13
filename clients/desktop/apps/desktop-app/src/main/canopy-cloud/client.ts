import { classifyError } from '@canopy/protocol/app-errors/classification';
import {
  classifyFetchFailure,
  retryAtFromDelay,
} from '@canopy/desktop-shared/node/lib/app-error-classification';
import {
  MODEL_LIBRARY_PROTOCOL_HEADER,
  MODEL_LIBRARY_PROTOCOL_VERSION,
} from '@canopy/protocol/models';
import type { CanopyServerAccountInfo } from '@canopy/protocol/canopy-server';
import type {
  CreateMemberOrgProjectRequest,
  CreateMemberOrgProjectResponse,
  EnsureOrgDefaultChatsRequest,
  EnsureOrgDefaultChatsResponse,
} from '@canopy/protocol/org-projects';
import {
  parseAccountMcpClientSetup,
  type AccountMcpClientSetup,
} from '@canopy/protocol/mcp-servers';
import { BRAND } from '@canopy/brand/current';
import {
  getCanopyCloudCredentials,
  mergeCanopyCloudAccountCapabilities,
} from '../lib/canopy-cloud-account-store';
import { noteCloudWriteSent } from './cloud-write-tracking';
import { CanopyCloudConfigError, getCanopyCloudBaseUrl } from './config';

const CANOPY_CLOUD_REQUEST_TIMEOUT_MS = 15_000;
const CANOPY_CLOUD_GET_RETRY_DELAYS_MS = [400, 1_500] as const;
const CANOPY_CLOUD_MAX_RETRY_AFTER_MS = 5_000;
const CLOUD_DISPLAY_NAME = `${BRAND.displayName} Cloud`;

export interface CanopyCloudRequestInit extends RequestInit {
  timeoutMs?: number;
}

export interface CanopyCloudCredentialContext {
  baseUrl: string;
  apiKey: string;
  capabilities?: readonly string[];
  /** Server account the credential resolved to, when known. */
  account?: CanopyServerAccountInfo;
}

export interface CanopyCloudAuthenticatedRequestInit extends CanopyCloudRequestInit {
  credentialContext?: CanopyCloudCredentialContext;
}

export interface CanopyCloudJsonRequestInit extends CanopyCloudAuthenticatedRequestInit {
  /**
   * Awaited before every attempt, retries included. A rejection stops the
   * request before that attempt is sent and is thrown as it is.
   */
  beforeRequest?: () => Promise<void>;
}

export type CanopyCloudClientErrorCode =
  | 'cloud-not-configured'
  | 'missing-api-key'
  | 'network-error'
  | 'http-error'
  | 'invalid-response'
  | 'unsupported-capability';

export class CanopyCloudClientError extends Error {
  constructor(
    readonly code: CanopyCloudClientErrorCode,
    message: string,
    readonly status?: number,
    /**
     * Machine-readable `code` from the server's JSON error body, when it sent
     * one (e.g. `telemetry_scope_prohibited`). Distinct from {@link code},
     * which classifies the TRANSPORT failure and is always one of
     * {@link CanopyCloudClientErrorCode}.
     *
     * Callers that need to branch on a specific server rejection must read
     * this rather than substring-matching {@link Error.message}: `message`
     * carries the human-readable `error` string, which is prose the server is
     * free to reword and never contains the code.
     */
    readonly serverCode?: string,
    /**
     * Machine-readable `scope` from the server's JSON error body, when it sent
     * one. Paired with {@link serverCode} — a `telemetry_scope_prohibited`
     * rejection names the scope it refused, and that is the only trustworthy
     * attribution at the moment of the refusal: the client's cached policy is
     * by definition stale (it is what let the request through), and a re-probe
     * cannot complete before the caller has to answer.
     */
    readonly serverScope?: string,
    /**
     * True only when the response carried the Cloud API's JSON error envelope
     * with a human-readable `error` string. Status alone is not authoritative:
     * gateways and captive portals can synthesize HTTP failures.
     */
    readonly isValidatedServerError = false,
    /** Parsed Retry-After delay for non-2xx responses, when supplied. */
    readonly retryAfterMs?: number,
    /** Whether an idempotent read may retry this transport-level failure. */
    readonly retryableNetworkFailure = false,
    /** Required pipeline-package client version from a structured 426 body. */
    readonly requiredPackageVersion?: number,
    /** Header name a structured error body refused, e.g. `invalid_headers`. */
    readonly serverHeader?: string,
    /** OAuth app setup a `client_credentials_required` MCP start refusal carries. */
    readonly serverClientSetup?: AccountMcpClientSetup,
    /** Whether a device signs in where a `sign_in_unavailable` MCP start refusal says the account can't. */
    readonly serverDesktopSignIn?: boolean,
    /**
     * Machine-readable `reason` from the error body, e.g. `org_teams_lapsed`.
     * Unlike {@link serverCode}, which names the client behavior shipped
     * builds rely on, this names the cause.
     */
    readonly serverReason?: string,
    /** Response request id header, when the server set one. */
    readonly requestId?: string,
    /** External organization id a refusal body named, e.g. a lapsed org. */
    readonly serverOrganizationId?: string,
  ) {
    super(status === undefined ? message : `HTTP ${status}: ${message}`);
    this.name = 'CanopyCloudClientError';
    if (code === 'http-error') {
      if (status === 401 && isValidatedServerError)
        classifyError(this, 'external.sign_in_required');
      if (status === 429)
        classifyError(this, 'external.rate_limited', {
          retryAt: retryAtFromDelay(retryAfterMs),
        });
      if (status !== undefined && status >= 500 && status <= 599)
        classifyError(this, 'external.service_unavailable');
    }
  }

  /**
   * Set when the failed request was an idempotent read, which cannot have
   * changed anything on the server (for example a share's pre-flight check).
   */
  failedRead = false;
}

function buildCloudPath(baseUrl: string, pathname: string): string {
  return `${baseUrl}${pathname}`;
}

async function resolveCloudCredentials(): Promise<
  Awaited<ReturnType<typeof getCanopyCloudCredentials>>
> {
  try {
    return await getCanopyCloudCredentials();
  } catch (error) {
    if (error instanceof CanopyCloudConfigError) {
      throw new CanopyCloudClientError(
        error.code === 'base-url-not-configured'
          ? 'cloud-not-configured'
          : 'missing-api-key',
        error.message,
      );
    }
    throw error;
  }
}

export async function resolveCanopyCloudCredentialContext(): Promise<CanopyCloudCredentialContext> {
  return resolveCloudCredentials();
}

interface CloudResponseErrorDetail {
  /** Human-readable message, from a supported error envelope when present. */
  message: string;
  /** Machine-readable `code` from the body, when the server sent one. */
  serverCode?: string;
  /** Machine-readable `scope` from the body, when the server sent one. */
  serverScope?: string;
  /** Whether the body matched a supported Cloud API JSON error envelope. */
  isValidatedServerError: boolean;
  /** Required pipeline-package client version, when supplied by the server. */
  requiredPackageVersion?: number;
  /** Header name the server refused, when the body named one. */
  serverHeader?: string;
  /** OAuth app setup a refused MCP connection start carried. */
  serverClientSetup?: AccountMcpClientSetup;
  /** `desktopSignIn` a refused MCP connection start carried. */
  serverDesktopSignIn?: boolean;
  /** Machine-readable `reason` from the body, when the server sent one. */
  serverReason?: string;
  /** External organization id the body named, when the server sent one. */
  serverOrganizationId?: string;
}

/** Bounded identifier-like string from an error body or header. */
function boundedToken(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\w.:-]+$/.test(value)
    ? value
    : undefined;
}

/**
 * Read a failed response into a message plus (when present) the server's
 * machine-readable `code`.
 *
 * The body is read ONCE, as text, and parsed from that text. Consuming it with
 * `response.json()` first would leave the non-JSON fallback with an
 * already-drained stream — and, worse, a structured body carrying only a `code`
 * (no `error` prose) would fall through to that dead fallback and lose the code
 * entirely, which is the one signal callers branch on.
 *
 * `code` is therefore extracted independently of `error`: neither field's
 * absence may suppress the other.
 */
async function readResponseErrorDetail(
  response: Response,
): Promise<CloudResponseErrorDetail> {
  const bodyText = (await response.text().catch(() => '')).trim();
  const statusMessage = `${response.status} ${response.statusText}`.trim();

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') && bodyText.length > 0) {
    try {
      const payload: unknown = JSON.parse(bodyText);
      if (payload && typeof payload === 'object') {
        const rootError = 'error' in payload ? payload.error : undefined;
        const nestedError =
          typeof rootError === 'object' && rootError !== null
            ? rootError
            : undefined;
        const rootCode = 'code' in payload ? payload.code : undefined;
        const nestedCode = nestedError
          ? 'code' in nestedError
            ? nestedError.code
            : undefined
          : undefined;
        const serverCode =
          typeof nestedCode === 'string'
            ? nestedCode
            : typeof rootCode === 'string'
              ? rootCode
              : undefined;
        const rootScope = 'scope' in payload ? payload.scope : undefined;
        const nestedScope = nestedError
          ? 'scope' in nestedError
            ? nestedError.scope
            : undefined
          : undefined;
        const serverScope =
          typeof nestedScope === 'string'
            ? nestedScope
            : typeof rootScope === 'string'
              ? rootScope
              : undefined;
        const nestedMessage = nestedError
          ? 'message' in nestedError
            ? nestedError.message
            : undefined
          : undefined;
        const errorMessage =
          typeof rootError === 'string'
            ? rootError
            : typeof nestedMessage === 'string'
              ? nestedMessage
              : undefined;
        const rawRequiredPackageVersion =
          'requiredPackageVersion' in payload
            ? payload.requiredPackageVersion
            : undefined;
        const requiredPackageVersion =
          typeof rawRequiredPackageVersion === 'number' &&
          Number.isSafeInteger(rawRequiredPackageVersion) &&
          rawRequiredPackageVersion > 0
            ? rawRequiredPackageVersion
            : undefined;
        const rawHeader = 'header' in payload ? payload.header : undefined;
        const serverHeader =
          typeof rawHeader === 'string' &&
          rawHeader.length > 0 &&
          rawHeader.length <= 256
            ? rawHeader
            : undefined;
        const serverClientSetup =
          'clientSetup' in payload
            ? parseAccountMcpClientSetup(payload.clientSetup)
            : null;
        const rawDesktopSignIn =
          'desktopSignIn' in payload ? payload.desktopSignIn : undefined;
        const serverDesktopSignIn =
          typeof rawDesktopSignIn === 'boolean' ? rawDesktopSignIn : undefined;
        const serverReason = boundedToken(
          'reason' in payload ? payload.reason : undefined,
        );
        const serverOrganizationId = boundedToken(
          'organizationId' in payload ? payload.organizationId : undefined,
        );
        // A structured body with no human-readable message gets the status
        // line rather than raw JSON dumped at the user.
        const isValidatedServerError =
          errorMessage !== undefined && errorMessage.trim().length > 0;
        const message = isValidatedServerError ? errorMessage : statusMessage;
        return {
          message,
          isValidatedServerError,
          ...(serverCode ? { serverCode } : {}),
          ...(serverScope ? { serverScope } : {}),
          ...(requiredPackageVersion !== undefined
            ? { requiredPackageVersion }
            : {}),
          ...(serverHeader ? { serverHeader } : {}),
          ...(serverClientSetup ? { serverClientSetup } : {}),
          ...(serverDesktopSignIn !== undefined ? { serverDesktopSignIn } : {}),
          ...(serverReason ? { serverReason } : {}),
          ...(serverOrganizationId ? { serverOrganizationId } : {}),
        };
      }
    } catch {
      // Mislabeled content type — fall through to the raw text.
    }
  }

  return {
    message: bodyText.length > 0 ? bodyText : statusMessage,
    isValidatedServerError: false,
  };
}

/**
 * Build the `http-error` rejection for a non-OK response, preserving the
 * server's machine-readable code on {@link CanopyCloudClientError.serverCode}.
 */
async function httpErrorFromResponse(
  response: Response,
): Promise<CanopyCloudClientError> {
  const detail = await readResponseErrorDetail(response);
  const retryAfter = response.headers.get('retry-after');
  const retryAfterMs = ((): number | undefined => {
    if (!retryAfter) return undefined;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const timestamp = Date.parse(retryAfter);
    return Number.isFinite(timestamp)
      ? Math.max(0, timestamp - Date.now())
      : undefined;
  })();
  return new CanopyCloudClientError(
    'http-error',
    detail.message,
    response.status,
    detail.serverCode,
    detail.serverScope,
    detail.isValidatedServerError,
    retryAfterMs,
    false,
    detail.requiredPackageVersion,
    detail.serverHeader,
    detail.serverClientSetup,
    detail.serverDesktopSignIn,
    detail.serverReason,
    boundedToken(response.headers.get('x-request-id') ?? undefined),
    detail.serverOrganizationId,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const internallyTimedOutFailures = new WeakSet<object>();

function networkErrorFromFailure(
  error: unknown,
  timedOutByHelper = false,
): CanopyCloudClientError {
  const internallyTimedOut =
    timedOutByHelper ||
    (typeof error === 'object' &&
      error !== null &&
      internallyTimedOutFailures.has(error));
  const timedOut = internallyTimedOut || isAbortError(error);
  const result = new CanopyCloudClientError(
    'network-error',
    timedOut
      ? `${CLOUD_DISPLAY_NAME} request timed out.`
      : error instanceof Error
        ? error.message
        : `Failed to reach ${CLOUD_DISPLAY_NAME}.`,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    internallyTimedOut || !timedOut,
  );
  if (internallyTimedOut)
    return classifyError(result, 'external.service_unavailable');
  return classifyFetchFailure(error, result);
}

function createCanopyCloudFetchContext(init: CanopyCloudRequestInit): {
  fetchInit: RequestInit;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const { timeoutMs = CANOPY_CLOUD_REQUEST_TIMEOUT_MS, ...fetchInit } = init;
  const controller = new AbortController();
  let timedOut = false;
  const externalSignal = fetchInit.signal;
  const abortFromExternalSignal = (): void => {
    controller.abort();
  };
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal, {
      once: true,
    });
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (
    typeof timeoutId === 'object' &&
    timeoutId !== null &&
    'unref' in timeoutId &&
    typeof timeoutId.unref === 'function'
  ) {
    timeoutId.unref();
  }
  return {
    fetchInit: { ...fetchInit, signal: controller.signal },
    cleanup: (): void => {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    },
    didTimeout: (): boolean => timedOut,
  };
}

function withModelLibraryProtocolHeader(
  headers: HeadersInit | undefined,
): HeadersInit {
  const version = String(MODEL_LIBRARY_PROTOCOL_VERSION);
  if (headers instanceof Headers || Array.isArray(headers)) {
    const next = new Headers(headers);
    next.set(MODEL_LIBRARY_PROTOCOL_HEADER, version);
    return next;
  }
  // Callers pass plain records; keep that shape so header names stay as written.
  return { ...headers, [MODEL_LIBRARY_PROTOCOL_HEADER]: version };
}

async function fetchCanopyCloud(
  url: string,
  init: CanopyCloudRequestInit,
): Promise<{
  response: Response;
  cleanup: () => void;
  didTimeout: () => boolean;
}> {
  const context = createCanopyCloudFetchContext({
    ...init,
    headers: withModelLibraryProtocolHeader(init.headers),
  });
  // A write counts once it is attempted: if it fails before a response, the
  // server may still have applied it.
  if (!isIdempotentGet(init)) noteCloudWriteSent();
  try {
    return {
      response: await fetch(url, context.fetchInit),
      cleanup: context.cleanup,
      didTimeout: context.didTimeout,
    };
  } catch (error) {
    if (context.didTimeout() && typeof error === 'object' && error !== null) {
      internallyTimedOutFailures.add(error);
    }
    context.cleanup();
    throw error;
  }
}

function isIdempotentGet(init: CanopyCloudRequestInit): boolean {
  return (
    (init.method ?? 'GET').toUpperCase() === 'GET' &&
    (init.body === undefined || init.body === null)
  );
}

/**
 * A transport failure or server-side outage rather than an authoritative
 * rejection. Unvalidated HTTP failures count as transient because gateways
 * and captive portals can synthesize them.
 */
export function isTransientCanopyCloudFailure(error: unknown): boolean {
  if (!(error instanceof CanopyCloudClientError)) return false;
  if (error.code === 'network-error' || error.code === 'invalid-response')
    return true;
  if (error.code !== 'http-error') return false;
  if (!error.isValidatedServerError || error.status === undefined) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function isRetryableCloudReadError(
  error: unknown,
  signal: AbortSignal | null | undefined,
): error is CanopyCloudClientError {
  if (signal?.aborted || !(error instanceof CanopyCloudClientError)) {
    return false;
  }
  if (error.code === 'network-error') return error.retryableNetworkFailure;
  return (
    error.code === 'http-error' &&
    (error.status === 502 || error.status === 503 || error.status === 504)
  );
}

function waitForCloudReadRetry(
  delayMs: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new CanopyCloudClientError(
        'network-error',
        `${CLOUD_DISPLAY_NAME} request cancelled.`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      const cancelled = new CanopyCloudClientError(
        'network-error',
        `${CLOUD_DISPLAY_NAME} request cancelled.`,
      );
      // Only reads wait to retry, so the cancelled request changed nothing.
      cancelled.failedRead = true;
      reject(cancelled);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function withBoundedCloudReadRetry<T>(options: {
  init: CanopyCloudRequestInit;
  attempt: () => Promise<T>;
}): Promise<T> {
  const { init, attempt } = options;
  if (!isIdempotentGet(init)) return attempt();

  for (
    let retryIndex = 0;
    retryIndex <= CANOPY_CLOUD_GET_RETRY_DELAYS_MS.length;
    retryIndex += 1
  ) {
    try {
      return await attempt();
    } catch (error) {
      const fallbackDelay = CANOPY_CLOUD_GET_RETRY_DELAYS_MS[retryIndex];
      if (
        fallbackDelay === undefined ||
        !isRetryableCloudReadError(error, init.signal)
      ) {
        if (error instanceof CanopyCloudClientError) error.failedRead = true;
        throw error;
      }
      const delayMs = Math.min(
        error.retryAfterMs ?? fallbackDelay,
        CANOPY_CLOUD_MAX_RETRY_AFTER_MS,
      );
      await waitForCloudReadRetry(delayMs, init.signal);
    }
  }

  throw new Error('Cloud read retry loop ended unexpectedly.');
}

export async function requestCanopyCloudJson<T>(
  pathname: string,
  init?: CanopyCloudJsonRequestInit,
): Promise<T> {
  const { credentialContext, beforeRequest, ...requestInit } = init ?? {};
  const { baseUrl, apiKey } =
    credentialContext ?? (await resolveCloudCredentials());
  const url = buildCloudPath(baseUrl, pathname);

  return withBoundedCloudReadRetry({
    init: requestInit,
    attempt: async (): Promise<T> => {
      await beforeRequest?.();
      let handle: Awaited<ReturnType<typeof fetchCanopyCloud>> | null = null;
      try {
        handle = await fetchCanopyCloud(url, {
          ...requestInit,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(requestInit.body ? { 'Content-Type': 'application/json' } : {}),
            ...(requestInit.headers ?? {}),
          },
        });
        const response = handle.response;
        if (!response.ok) {
          throw await httpErrorFromResponse(response);
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- The transport helper preserves the typed response contract used by Cloud resource clients.
          return await response.json();
        } catch (error) {
          if (isAbortError(error)) throw error;
          throw new CanopyCloudClientError(
            'invalid-response',
            `${CLOUD_DISPLAY_NAME} returned invalid JSON.`,
            response.status,
          );
        }
      } catch (error) {
        if (error instanceof CanopyCloudClientError) throw error;
        throw networkErrorFromFailure(error, handle?.didTimeout());
      } finally {
        handle?.cleanup();
      }
    },
  });
}

/** Ensure the caller's organization-local default Chats definition. */
export async function ensureOrgDefaultChats(
  request: EnsureOrgDefaultChatsRequest,
): Promise<EnsureOrgDefaultChatsResponse> {
  return requestCanopyCloudJson('/api/v1/projects/default-chats', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export type CreateMemberOrgProjectResult =
  | { ok: true; project: CreateMemberOrgProjectResponse }
  | {
      ok: false;
      code:
        | 'limit-reached'
        | 'repository-project-exists'
        | 'member-project-exists';
    };

/** Create a member-owned organization project. POSTs are never retried. */
export async function createMemberOrgProject(
  request: CreateMemberOrgProjectRequest,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<CreateMemberOrgProjectResult> {
  try {
    const project =
      await requestCanopyCloudJson<CreateMemberOrgProjectResponse>(
        '/api/v1/projects/member',
        {
          credentialContext,
          method: 'POST',
          body: JSON.stringify(request),
        },
      );
    return { ok: true, project };
  } catch (error) {
    if (
      error instanceof CanopyCloudClientError &&
      error.status === 409 &&
      (error.serverCode === 'member_project_limit' ||
        error.serverCode === 'repository_project_exists' ||
        error.serverCode === 'member_project_exists')
    ) {
      return {
        ok: false,
        code:
          error.serverCode === 'member_project_limit'
            ? 'limit-reached'
            : error.serverCode === 'repository_project_exists'
              ? 'repository-project-exists'
              : 'member-project-exists',
      };
    }
    throw error;
  }
}

/** Outcome of a conditional GET: a fresh body with its ETag, or unchanged. */
export type CanopyCloudConditionalResult<T> =
  | { status: 'fresh'; body: T; etag: string | null }
  | { status: 'not-modified' };

/**
 * `GET` with `If-None-Match` (CAN-2955). A 304 answers `not-modified` instead
 * of throwing, so a cached catalog can be kept without re-downloading it;
 * every other non-2xx maps to the usual {@link CanopyCloudClientError}.
 */
export async function requestCanopyCloudJsonConditional<T>(
  pathname: string,
  options: {
    etag: string | null;
    credentialContext?: CanopyCloudCredentialContext;
    timeoutMs?: number;
  },
): Promise<CanopyCloudConditionalResult<T>> {
  const { baseUrl, apiKey } =
    options.credentialContext ?? (await resolveCloudCredentials());
  const url = buildCloudPath(baseUrl, pathname);
  return withBoundedCloudReadRetry({
    init: { method: 'GET', timeoutMs: options.timeoutMs },
    attempt: async (): Promise<CanopyCloudConditionalResult<T>> => {
      let handle: Awaited<ReturnType<typeof fetchCanopyCloud>> | null = null;
      try {
        handle = await fetchCanopyCloud(url, {
          method: 'GET',
          timeoutMs: options.timeoutMs,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(options.etag ? { 'If-None-Match': options.etag } : {}),
          },
        });
        const response = handle.response;
        if (response.status === 304) {
          return { status: 'not-modified' };
        }
        if (!response.ok) {
          throw await httpErrorFromResponse(response);
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- The transport helper preserves the typed response contract used by Cloud resource clients.
          const body: T = await response.json();
          return { status: 'fresh', body, etag: response.headers.get('etag') };
        } catch (error) {
          if (isAbortError(error)) throw error;
          throw new CanopyCloudClientError(
            'invalid-response',
            `${CLOUD_DISPLAY_NAME} returned invalid JSON.`,
            response.status,
          );
        }
      } catch (error) {
        if (error instanceof CanopyCloudClientError) throw error;
        throw networkErrorFromFailure(error, handle?.didTimeout());
      } finally {
        handle?.cleanup();
      }
    },
  });
}

export async function requestCanopyCloudMultipartJson<T>(
  pathname: string,
  options: {
    formData: FormData;
    timeoutMs?: number;
    credentials?: CanopyCloudCredentialContext;
  },
): Promise<T> {
  const { baseUrl, apiKey } =
    options.credentials ?? (await resolveCloudCredentials());
  const url = buildCloudPath(baseUrl, pathname);

  let handle: Awaited<ReturnType<typeof fetchCanopyCloud>> | null = null;
  try {
    handle = await fetchCanopyCloud(url, {
      method: 'POST',
      body: options.formData,
      timeoutMs: options.timeoutMs,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const response = handle.response;
    if (!response.ok) {
      throw await httpErrorFromResponse(response);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- The transport helper preserves the typed response contract used by Cloud resource clients.
      return await response.json();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new CanopyCloudClientError(
        'invalid-response',
        `${CLOUD_DISPLAY_NAME} returned invalid JSON.`,
        response.status,
      );
    }
  } catch (error) {
    if (error instanceof CanopyCloudClientError) throw error;
    throw new CanopyCloudClientError(
      'network-error',
      isAbortError(error)
        ? `${CLOUD_DISPLAY_NAME} request timed out.`
        : error instanceof Error
          ? error.message
          : `Failed to reach ${CLOUD_DISPLAY_NAME}.`,
    );
  } finally {
    handle?.cleanup();
  }
}

export async function requestCanopyCloudBinary(
  pathname: string,
  init?: CanopyCloudAuthenticatedRequestInit,
): Promise<Buffer> {
  const { credentialContext, ...requestInit } = init ?? {};
  const { baseUrl, apiKey } =
    credentialContext ?? (await resolveCloudCredentials());
  const url = buildCloudPath(baseUrl, pathname);

  return withBoundedCloudReadRetry({
    init: requestInit,
    attempt: async (): Promise<Buffer> => {
      let handle: Awaited<ReturnType<typeof fetchCanopyCloud>> | null = null;
      try {
        handle = await fetchCanopyCloud(url, {
          ...requestInit,
          headers: {
            Accept: 'application/gzip',
            Authorization: `Bearer ${apiKey}`,
            ...(requestInit.headers ?? {}),
          },
        });
        const response = handle.response;
        if (!response.ok) {
          throw await httpErrorFromResponse(response);
        }

        try {
          return Buffer.from(await response.arrayBuffer());
        } catch (error) {
          if (isAbortError(error)) throw error;
          throw new CanopyCloudClientError(
            'invalid-response',
            `${CLOUD_DISPLAY_NAME} returned invalid binary data.`,
            response.status,
          );
        }
      } catch (error) {
        if (error instanceof CanopyCloudClientError) throw error;
        throw networkErrorFromFailure(error, handle?.didTimeout());
      } finally {
        handle?.cleanup();
      }
    },
  });
}

export async function requestCanopyCloudPublicJson<T>(
  pathname: string,
  init?: CanopyCloudRequestInit,
): Promise<T> {
  const baseUrl = getCanopyCloudBaseUrl();
  const url = buildCloudPath(baseUrl, pathname);
  const requestInit = init ?? {};

  return withBoundedCloudReadRetry({
    init: requestInit,
    attempt: async (): Promise<T> => {
      let handle: Awaited<ReturnType<typeof fetchCanopyCloud>> | null = null;
      try {
        handle = await fetchCanopyCloud(url, {
          ...requestInit,
          headers: {
            Accept: 'application/json',
            ...(requestInit.body ? { 'Content-Type': 'application/json' } : {}),
            ...(requestInit.headers ?? {}),
          },
        });
        const response = handle.response;
        if (!response.ok) {
          throw await httpErrorFromResponse(response);
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- The public pricing endpoint is validated by its caller before caching.
          return await response.json();
        } catch (error) {
          if (isAbortError(error)) throw error;
          throw new CanopyCloudClientError(
            'invalid-response',
            `${CLOUD_DISPLAY_NAME} returned invalid JSON.`,
            response.status,
          );
        }
      } catch (error) {
        if (error instanceof CanopyCloudClientError) throw error;
        throw networkErrorFromFailure(error, handle?.didTimeout());
      } finally {
        handle?.cleanup();
      }
    },
  });
}

export async function requestCanopyCloudPublicBinary(
  pathname: string,
  init?: CanopyCloudRequestInit,
): Promise<Buffer> {
  const baseUrl = getCanopyCloudBaseUrl();
  const url = buildCloudPath(baseUrl, pathname);
  const requestInit = init ?? {};

  return withBoundedCloudReadRetry({
    init: requestInit,
    attempt: async (): Promise<Buffer> => {
      let handle: Awaited<ReturnType<typeof fetchCanopyCloud>> | null = null;
      try {
        handle = await fetchCanopyCloud(url, {
          ...requestInit,
          headers: {
            Accept: 'application/octet-stream',
            ...(requestInit.headers ?? {}),
          },
        });
        if (!handle.response.ok) {
          throw await httpErrorFromResponse(handle.response);
        }
        return Buffer.from(await handle.response.arrayBuffer());
      } catch (error) {
        if (error instanceof CanopyCloudClientError) throw error;
        throw networkErrorFromFailure(error, handle?.didTimeout());
      } finally {
        handle?.cleanup();
      }
    },
  });
}

/**
 * Open a long-lived authenticated stream (e.g. SSE) to Canopy Cloud. Unlike the
 * JSON helpers this applies NO request timeout — the caller owns the connection
 * lifetime via `signal`, so a persistent stream is never torn down after the
 * short JSON timeout. Returns the raw `Response`; the caller reads
 * `response.body`.
 */
export async function openCanopyCloudStream(
  pathname: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
): Promise<Response> {
  const { baseUrl, apiKey } = await resolveCloudCredentials();
  const url = buildCloudPath(baseUrl, pathname);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: init.signal,
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw new CanopyCloudClientError(
      'network-error',
      isAbortError(error)
        ? `${CLOUD_DISPLAY_NAME} stream cancelled.`
        : error instanceof Error
          ? error.message
          : `Failed to reach ${CLOUD_DISPLAY_NAME}.`,
    );
  }

  if (!response.ok) {
    throw await httpErrorFromResponse(response);
  }

  return response;
}

export async function requestCanopyCloudNoContent(
  pathname: string,
  init: CanopyCloudAuthenticatedRequestInit,
): Promise<void> {
  const { credentialContext, ...requestInit } = init;
  const { baseUrl, apiKey } =
    credentialContext ?? (await resolveCloudCredentials());
  const url = buildCloudPath(baseUrl, pathname);

  let handle: Awaited<ReturnType<typeof fetchCanopyCloud>> | null = null;
  try {
    handle = await fetchCanopyCloud(url, {
      ...requestInit,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(requestInit.headers ?? {}),
      },
    });
    if (!handle.response.ok) {
      throw await httpErrorFromResponse(handle.response);
    }
  } catch (error) {
    if (error instanceof CanopyCloudClientError) throw error;
    throw new CanopyCloudClientError(
      'network-error',
      isAbortError(error)
        ? `${CLOUD_DISPLAY_NAME} request timed out.`
        : error instanceof Error
          ? error.message
          : `Failed to reach ${CLOUD_DISPLAY_NAME}.`,
    );
  } finally {
    handle?.cleanup();
  }
}

export async function revokeCurrentOAuthDesktopKey(
  apiKey: string,
): Promise<void> {
  const baseUrl = getCanopyCloudBaseUrl();
  const url = buildCloudPath(
    baseUrl,
    `/api/v1/${BRAND.web.apiNamespace}/desktop-auth/current-key`,
  );

  let handle: Awaited<ReturnType<typeof fetchCanopyCloud>> | null = null;
  try {
    handle = await fetchCanopyCloud(url, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!handle.response.ok) {
      throw await httpErrorFromResponse(handle.response);
    }
  } catch (error) {
    if (error instanceof CanopyCloudClientError) throw error;
    throw new CanopyCloudClientError(
      'network-error',
      isAbortError(error)
        ? `${CLOUD_DISPLAY_NAME} request timed out.`
        : error instanceof Error
          ? error.message
          : `Failed to reach ${CLOUD_DISPLAY_NAME}.`,
    );
  } finally {
    handle?.cleanup();
  }
}

export async function assertCanopyCloudCapability(
  capability: string,
  credentials?: CanopyCloudCredentialContext,
  signal?: AbortSignal,
): Promise<void> {
  const credentialContext = credentials ?? (await resolveCloudCredentials());
  if (credentialContext.capabilities?.includes(capability)) {
    return;
  }

  const liveCapabilities = await loadLiveCloudCapabilities(
    credentialContext,
    signal,
  );
  if (liveCapabilities.includes(capability)) {
    if (!credentials) {
      void mergeCanopyCloudAccountCapabilities(
        liveCapabilities,
        credentialContext.apiKey,
      ).catch(() => undefined);
    }
    return;
  }

  throw new CanopyCloudClientError(
    'unsupported-capability',
    `${CLOUD_DISPLAY_NAME} does not support ${capability}.`,
  );
}

async function loadLiveCloudCapabilities(
  credentials?: CanopyCloudCredentialContext,
  signal?: AbortSignal,
): Promise<string[]> {
  const payload = await requestCanopyCloudJson<{ capabilities?: unknown }>(
    `/.well-known/${BRAND.web.wellKnownNamespace}`,
    {
      ...(credentials ? { credentialContext: credentials } : {}),
      signal,
    },
  );
  return Array.isArray(payload.capabilities)
    ? payload.capabilities.filter(
        (capability): capability is string => typeof capability === 'string',
      )
    : [];
}
