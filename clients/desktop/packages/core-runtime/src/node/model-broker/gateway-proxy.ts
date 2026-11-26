import {
  MODEL_LIBRARY_PROTOCOL_HEADER,
  MODEL_LIBRARY_PROTOCOL_VERSION,
  isSyntacticallyValidModelId,
} from '@canopy/protocol/models';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { LOOPBACK_BROKER_SECRET_HEADER } from './broker-routes';
import { flattenOpenCodeInferenceTools } from './inference-tool-schemas';
import {
  resolveCloudAccountGatewayAuthorization,
  type CloudAccountHeaderAuthorization,
} from '../cloud-account/authorization';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  AI_CREDITS_CONCURRENCY_GUARD,
  AI_CREDITS_CORRELATION_HEADER,
  AI_CREDITS_GATEWAY_DELIVERY,
  AI_CREDITS_PROXY_ERROR_MARKER,
  parseCanopyProxyError,
  type CanopyProxyError,
} from '@canopy/protocol';
import {
  AI_CREDITS_ATTRIBUTION_WORKSPACE_HEADER,
  AI_CREDITS_ATTRIBUTION_WORKTREE_HEADER,
  AI_CREDITS_ORG_PROJECT_HEADER,
  AI_CREDITS_WORK_OWNER_HEADER,
} from '@canopy/protocol/llm-gateway';

const MAX_INFERENCE_REQUESTS_PER_LEASE = 1024;
const INFERENCE_ATTRIBUTION_HEADERS = new Set<string>([
  MODEL_LIBRARY_PROTOCOL_HEADER,
  AI_CREDITS_ATTRIBUTION_WORKSPACE_HEADER,
  AI_CREDITS_ATTRIBUTION_WORKTREE_HEADER,
  AI_CREDITS_ORG_PROJECT_HEADER,
  AI_CREDITS_WORK_OWNER_HEADER,
]);
export const CODEX_PROXY_ROUTE_UNAVAILABLE_MESSAGE =
  'AI Credits proxy route is no longer available.';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/**
 * Status the hosted proxy returns when no spendable ledger backs the request
 * (`noBillingSourceResponse`).
 */
const NO_BILLING_SOURCE_STATUS = 402;
/**
 * Statuses whose marked hosted body is buffered and recorded for the session:
 * the no-billing-source 402 and the marked 403 refusals (a refused work owner,
 * CAN-3462; a guest model outside the allowlist). These bodies are small and
 * non-streaming, so they are safe to buffer whole before relaying; no other
 * status on this path is.
 */
const BUFFERED_REFUSAL_STATUSES: ReadonlySet<number> = new Set([
  401,
  NO_BILLING_SOURCE_STATUS,
  403,
  503,
]);
/**
 * Ceiling on a buffered {@link BUFFERED_REFUSAL_STATUSES} body. The real body
 * is a couple hundred bytes; the cap only stops a misbehaving or spoofed
 * upstream from making the proxy hold an unbounded response in memory. A body
 * that exceeds it is relayed unread rather than classified.
 */
const MAX_BUFFERED_ERROR_BYTES = 64 * 1024;
const EPHEMERAL_ROUTE_TTL_MS = 30 * 60_000;
const CODEX_RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
const CANOPY_PROXY_MARKER = AI_CREDITS_PROXY_ERROR_MARKER;
const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504, 529]);
/**
 * Cap on pre-route diagnostic records per process. Those paths run before any
 * credential or route-id check, so they are reachable by any local caller that
 * finds the loopback port; the triage signal only needs the first few.
 */
const MAX_PRE_ROUTE_DIAGNOSTICS = 50;
/**
 * Sliding window for {@link MAX_PRE_ROUTE_DIAGNOSTICS}. Long enough that a
 * burst still gets bounded, short enough that a genuine expired-route failure
 * hours into a session still reaches support.
 */
const PRE_ROUTE_DIAGNOSTIC_WINDOW_MS = 60 * 60_000;
/**
 * Connection errors that prove the request never reached the gateway.
 *
 * This POST is not idempotent and it is billed: once the gateway accepts a
 * request it starts a turn, and `debitCapturedCost` on the hosted side runs on
 * the background cost-capture pipeline whether or not this proxy is still
 * reading. Retrying an error that could have fired *after* the request was
 * transmitted (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `UND_ERR_HEADERS_TIMEOUT`,
 * `UND_ERR_SOCKET`, `ECONNABORTED`) can therefore start a second turn and debit
 * the user twice. The per-user in-flight guard catches some of that, but it is
 * per-instance in memory and does not hold across `apps/web` replicas.
 *
 * So retry only pre-connect failures: DNS, refused, unroutable, and connect
 * timeout. A dropped connection mid-flight surfaces as a structured 502 and is
 * not replayed HERE.
 *
 * Note the scope precisely: this allowlist governs THIS proxy's own socket to
 * `apps/web`. A drop on the `apps/web` -> gateway hop is not a connection error
 * here at all — it arrives as a well-formed 502 that `RETRYABLE_HTTP_STATUSES`
 * would replay on status alone, bypassing this rule entirely. That hop carries
 * its own provenance via `AI_CREDITS_GATEWAY_DELIVERY`; see
 * `hasAmbiguousDelivery`.
 *
 * Note what that does and does not buy: it keeps this proxy from silently
 * double-charging inside a single request. It does not make the turn-level
 * replay impossible, because that 502 carries `upstream_unavailable`, which the
 * classifier maps to `provider_temporarily_unavailable`, and
 * `agent-failures/transient-retry.ts` auto-retries exactly that kind. That
 * higher-level replay is pre-existing behavior and out of scope for this
 * allowlist — do not read this comment as a guarantee that a mid-flight drop is
 * only ever retried by an explicit user action.
 */
const RETRYABLE_CONNECTION_CODES = new Set([
  // DNS: `ENOTFOUND` is what Node actually reports for a failed name
  // resolution (a resolver blip after wake-from-sleep, a network change, a VPN
  // flap); `EAI_AGAIN` is the rarer temporary-failure variant. Both are
  // pre-connect, so neither can have produced a billed turn.
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ENETDOWN',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export const CODEX_GATEWAY_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
export const CODEX_GATEWAY_RETRY_BUDGET_MS = 8_000;
export const CODEX_GATEWAY_MAX_RETRY_AFTER_MS = 2_000;

type ProxyFailureCode =
  | 'credentials_unavailable'
  | 'invalid_request'
  | 'proxy_internal_error'
  | 'upstream_unavailable';

interface ProxyFailure {
  code: 'upstream_unavailable';
  errorCode?: string;
  retryReason: string;
}

type UpstreamAttemptOutcome =
  | {
      kind: 'response';
      response: Response;
      attempts: number;
      elapsedMs: number;
      retryReason?: string;
      retryStatus?: number;
      errorCode?: string;
    }
  | {
      kind: 'exhausted';
      failure: ProxyFailure;
      attempts: number;
      elapsedMs: number;
    }
  | { kind: 'client-gone'; attempts: number; elapsedMs: number }
  | { kind: 'route-revoked' }
  | { kind: 'model-refused'; attempts: number };

export interface CodexGatewayProxyDiagnosticRecord {
  version: 1;
  timestamp: string;
  kind:
    | 'codex_gateway_proxy_retry'
    | 'codex_gateway_proxy_failed'
    | 'codex_gateway_no_billing_source';
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  providerType: 'codex' | 'opencode';
  elapsedMs?: number;
  codexGatewayAttemptCount?: number;
  codexGatewayUpstreamStatus?: number;
  codexGatewayFailureCode?: ProxyFailureCode;
  codexGatewayRetryReason?: string;
  codexGatewayErrorCode?: string;
  codexGatewayRouteRef?: string;
  codexGatewayCorrelationId?: string;
  /**
   * Whether a relayed 402 body actually parsed as the marked hosted
   * `no_billing_source` failure.
   *
   * Recorded on EVERY relayed 402, including the ones that do not classify,
   * because the two outcomes fail identically from the outside: the user sees a
   * raw error either way, and nothing else on the path distinguishes "the proxy
   * never saw the response" from "it saw it and the body was unmarked" from "it
   * classified it and the verdict was keyed to a session that never read it".
   * The record's `sessionKey` is the route's own session id, so a mismatch
   * against the chat that emitted the failure is visible directly.
   */
  codexGatewayNoBillingSourceClassified?: boolean;
}

export type CodexGatewayProxyDiagnosticSink = (
  record: CodexGatewayProxyDiagnosticRecord,
) => void;

let diagnosticSink: CodexGatewayProxyDiagnosticSink | undefined;

export function setCodexGatewayProxyDiagnosticSink(
  sink: CodexGatewayProxyDiagnosticSink | undefined,
): void {
  diagnosticSink = sink;
}

export function deriveProxyDiagnosticIdentity(
  sessionId: string,
  providerType: 'codex' | 'opencode' = 'codex',
): {
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  providerType: 'codex' | 'opencode';
} {
  if (sessionId.startsWith('pipeline:')) {
    const executionId = sessionId.split(':')[1];
    return {
      sessionKey: sessionId,
      projectId: '',
      worktreeId: '',
      chatId: executionId ? `pipeline:${executionId}` : '',
      providerType,
    };
  }
  const parts = sessionId.split('/');
  if (parts.length === 3 && parts.every(Boolean)) {
    const [projectId = '', worktreeId = '', chatId = ''] = parts;
    return {
      sessionKey: sessionId,
      projectId,
      worktreeId,
      chatId,
      providerType,
    };
  }
  return {
    sessionKey: sessionId,
    projectId: '',
    worktreeId: '',
    chatId: '',
    providerType,
  };
}

/** Trusted host policy for an explicit managed OpenCode turn. */
interface OpenCodeGatewayInferencePolicy {
  providerType: 'opencode';
  modelId: string;
  toolSchemaProfile?: 'standard' | 'flat';
  headers: Readonly<Record<string, string>>;
}

function snapshotInferencePolicy(
  policy: OpenCodeGatewayInferencePolicy | undefined,
): OpenCodeGatewayInferencePolicy | undefined {
  if (!policy) return undefined;
  const headers = { ...policy.headers };
  if (
    policy.providerType !== 'opencode' ||
    (policy.toolSchemaProfile !== undefined &&
      policy.toolSchemaProfile !== 'standard' &&
      policy.toolSchemaProfile !== 'flat') ||
    !isSyntacticallyValidModelId(policy.modelId) ||
    Object.entries(headers).some(
      ([name, value]) =>
        !INFERENCE_ATTRIBUTION_HEADERS.has(name) ||
        typeof value !== 'string' ||
        (name === MODEL_LIBRARY_PROTOCOL_HEADER &&
          value !== String(MODEL_LIBRARY_PROTOCOL_VERSION)) ||
        value.length > 2048 ||
        /[^\x20-\x7e]/.test(value),
    )
  )
    throw new Error('Invalid OpenCode inference lease policy');
  return {
    providerType: 'opencode',
    modelId: policy.modelId,
    toolSchemaProfile: policy.toolSchemaProfile,
    headers,
  };
}

interface CodexGatewayRouteFields {
  expiryHolds: number;
  quotaWaitController?: AbortController;
  waitForQuotaRecovery?: (signal: AbortSignal) => Promise<void>;
  sessionId: string;
  upstreamUrl: string;
  upstreamSignal?: () => AbortSignal;
  allowedPaths: readonly string[];
  allowedQueries: readonly string[];
  forwardHeaders: readonly string[];
  stripCacheControl: boolean;
  /** Whether `x-canopy-*` request headers reach the upstream. */
  forwardCanopyHeaders: boolean;
  extraHeaders: Readonly<Record<string, string>>;
  inferencePolicy?: OpenCodeGatewayInferencePolicy;
  submittedBodies?: Set<string>;
  inferenceFailure?: OpenCodeGatewayInferenceFailure;
  unlimitedRequestBody: boolean;
  onCredentialRejected?: (
    status: 401 | 403,
    credentialVersion?: string,
  ) => Promise<void> | void;
  onUpstreamResponse?: (response: {
    readonly status: number;
    /** The allowed API path the request went to, such as `/v1/messages`. */
    readonly path: string;
    readonly headers: Headers;
  }) => void;
}

type CodexGatewayRoute = CodexGatewayRouteFields &
  (
    | {
        daemon?: undefined;
        resolveToken: () => Promise<CodexGatewayResolvedToken | string | null>;
      }
    | { daemon: GatewayDaemonRoutePolicy; resolveToken?: undefined }
  );

interface CodexGatewayResolvedToken {
  token: string;
  credentialVersion?: string;
}

/**
 * Hosted 403 refusals that block only the route's policy, never the account
 * credential: an organization model-policy block (top-level `code`) and a
 * refused work owner (CAN-3462), which arrives in the marked `error` envelope.
 */
export type HostedPolicyRefusalCode =
  | 'model_policy_blocked'
  | 'work_owner_not_member';

/**
 * Daemon-owned route policy (the daemon broker). Every daemon behaviour in
 * the proxy is keyed on this object; routes without it keep the base relay.
 */
export interface GatewayDaemonRoutePolicy {
  /** Route capability, delivered to children only through their environment. */
  readonly clientSecret: string;
  /** Before the body is read; `false` answers 401 `credentials_unavailable`. */
  preflight(): Promise<boolean>;
  /** The body's `model`; `false` answers the local `model_policy_blocked` 403. */
  admitModel(model: string): Promise<boolean>;
  /**
   * Before each attempt: an unapplied lease, `'model-refused'` for a local
   * refusal of this model, or `null` once the route is revoked (after its
   * checkpoint). The proxy applies the lease only in the tick it sends.
   */
  prepare(
    model: string,
  ): Promise<CloudAccountHeaderAuthorization | 'model-refused' | null>;
  /** Synchronous fence, checked in the same tick as the send. */
  current(): boolean;
  /** Revokes a fenced route and resolves once its checkpoint is recorded. */
  settled(): Promise<void>;
  /** A marked hosted policy 403, before its body is relayed. */
  onPolicyRefusal(code: HostedPolicyRefusalCode): Promise<void>;
  onCredentialRejected(status: 401, credentialVersion?: string): Promise<void>;
}

interface CodexGatewayRouteOptionsBase {
  sessionId: string;
  upstreamUrl: string;
  /**
   * The current signal for whether the upstream may still be sent to. Read
   * before the token; once it aborts, nothing more is sent: the request in
   * flight is cancelled and no retry starts. For an upstream that can go
   * away, such as a proxy whose port is released when it stops.
   */
  upstreamSignal?: () => AbortSignal;
  /** Exact child-request paths this bearer-bearing route may forward. */
  allowedPaths?: readonly string[];
  /** Exact query strings, without `?`, that are valid on approved paths. */
  allowedQueries?: readonly string[];
  forwardHeaders?: readonly string[];
  stripCacheControl?: boolean;
  /**
   * Whether `x-canopy-*` request headers (workspace and worktree names,
   * work owner) reach the upstream. They exist for this app's own cloud;
   * a third-party upstream such as an account proxy must not get them.
   * Defaults to true.
   */
  forwardCanopyHeaders?: boolean;
  /** Headers this route adds to every upstream request. */
  extraHeaders?: Readonly<Record<string, string>>;
  /**
   * Relay request bodies of any size instead of refusing those over
   * {@link MAX_REQUEST_BYTES}. For an upstream the user runs, such as an
   * account proxy: the body is the chat's whole context, which can pass
   * 8 MiB on a large context window, and that upstream sets its own limit.
   * Defaults to false.
   */
  unlimitedRequestBody?: boolean;
  /**
   * Called with each upstream response's status and headers before its
   * body is relayed. Best effort: a throw is swallowed.
   */
  onUpstreamResponse?: (response: {
    readonly status: number;
    readonly path: string;
    readonly headers: Headers;
  }) => void;
}

interface CodexGatewayBaseRouteOptions extends CodexGatewayRouteOptionsBase {
  daemon?: undefined;
  resolveToken: () => Promise<CodexGatewayResolvedToken | string | null>;
  waitForQuotaRecovery?: (signal: AbortSignal) => Promise<void>;
  inferencePolicy?: OpenCodeGatewayInferencePolicy;
  onCredentialRejected?: (
    status: 401 | 403,
    credentialVersion?: string,
  ) => Promise<void> | void;
}

/**
 * A daemon route: a custody lease per attempt, route-secret authentication,
 * refused redirects, and a withdrawal answered while the body uploads.
 */
interface CodexGatewayDaemonRouteOptions extends CodexGatewayRouteOptionsBase {
  daemon: GatewayDaemonRoutePolicy;
  resolveToken?: never;
  waitForQuotaRecovery?: never;
  inferencePolicy?: never;
  onCredentialRejected?: never;
}

/** One daemon attempt's last check; `ready` means its lease is applied. */
type DaemonCommit = 'ready' | 'gone' | 'revoked' | 'stale';

interface DaemonAttemptHook {
  prepare(): Promise<CloudAccountHeaderAuthorization | 'model-refused' | null>;
  /** Synchronous: the caller sends a `ready` attempt in the same tick. */
  commit(lease: CloudAccountHeaderAuthorization): DaemonCommit;
  settled(): Promise<void>;
}

export interface CodexGatewayProxyServiceOptions {
  recordSessionProxyFailure?: (
    sessionId: string,
    failure: CanopyProxyError,
  ) => void;
  retryDelaysMs?: readonly number[];
  retryBudgetMs?: number;
  /**
   * Clock seam. Exists so the pre-attempt deadline guard is testable: the guard
   * only fires when a backoff sleep OVERSHOOTS the deadline (event-loop stall,
   * machine sleep, long GC), which real timers cannot reproduce deterministically.
   * Production always uses `Date.now`.
   */
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hostedPolicyRefusalCode(
  body: string,
): HostedPolicyRefusalCode | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.code === 'model_policy_blocked') return 'model_policy_blocked';
  const nested = parsed.error;
  return isRecord(nested) &&
    nested.canopy_proxy === AI_CREDITS_PROXY_ERROR_MARKER &&
    nested.code === 'work_owner_not_member'
    ? 'work_owner_not_member'
    : undefined;
}

function writeModelNotAdmitted(
  response: ServerResponse,
  correlationId: string,
): void {
  // The hosted model_policy_blocked shape, so children render it alike.
  response.writeHead(403, {
    'content-type': 'application/json',
    [AI_CREDITS_CORRELATION_HEADER]: correlationId,
  });
  response.end(
    JSON.stringify({
      error: 'This model is not admitted for this workflow step.',
      code: 'model_policy_blocked',
    }),
  );
}

function readRequestModel(body: Buffer): string | undefined {
  try {
    const payload: unknown = JSON.parse(body.toString('utf8'));
    return isRecord(payload) && typeof payload.model === 'string'
      ? payload.model
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bounded walk for a connection error's code.
 *
 * Kept deliberately identical to the hosted hop's `readGatewayErrorCode`
 * (`apps/web/src/lib/llm-proxy/gateway-forward.ts`): the two ends decide the
 * same thing — whether a failure provably never left — from the same error
 * shapes, so a divergence here silently means one hop retries a pre-connect
 * refusal and the other does not.
 *
 * Two details are load-bearing:
 *  - the `errors[0]` hop, because undici reports a connect failure against a
 *    multi-A-record host as an `AggregateError` whose per-address errors carry
 *    the code, which is the common real `ECONNREFUSED` shape;
 *  - `Reflect.get` rather than a spread or a cast, because `cause` from
 *    `new Error(msg, { cause })` is non-enumerable and spreading would end the
 *    walk at depth 1.
 */
function readErrorCode(
  error: unknown,
  // Shared across both hop kinds, so an `errors[0]` hop consumes the same
  // budget as a `cause` hop — recursing with a fresh budget would make the
  // bound meaningless. `seen` additionally stops a self-referential chain from
  // recursing until the stack overflows.
  budget = 4,
  seen = new WeakSet<object>(),
): string | undefined {
  let current: unknown = error;
  let remaining = budget;
  while (remaining > 0) {
    if (!current || typeof current !== 'object') return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);
    remaining -= 1;
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
    const nestedErrors: unknown = Reflect.get(current, 'errors');
    if (Array.isArray(nestedErrors) && nestedErrors.length > 0) {
      const nested = readErrorCode(nestedErrors[0], remaining, seen);
      if (nested) return nested;
    }
    current = Reflect.get(current, 'cause');
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  // A malformed Retry-After (neither a number nor a parseable date) yields NaN.
  // NaN survives Math.min/Math.max, and Node coerces a NaN setTimeout delay to
  // 1ms — which would silently bypass the configured backoff and hot-loop the
  // retries. Treat an unusable header as "no server-supplied delay" instead.
  if (!Number.isFinite(milliseconds)) return 0;
  return Math.max(0, Math.min(CODEX_GATEWAY_MAX_RETRY_AFTER_MS, milliseconds));
}

function isConcurrencyGuard(response: Response): boolean {
  return (
    response.headers.get(AI_CREDITS_CONCURRENCY_GUARD.markerHeader) ===
    AI_CREDITS_CONCURRENCY_GUARD.markerValue
  );
}

/**
 * True when the hosted proxy synthesized this failure and could NOT prove the
 * request never reached the gateway.
 *
 * `RETRYABLE_CONNECTION_CODES` keeps this proxy from replaying a mid-flight drop
 * on its own socket, but that only covers the desktop -> `apps/web` hop. A drop
 * on the `apps/web` -> gateway hop comes back as a well-formed 502, which
 * `RETRYABLE_HTTP_STATUSES` would replay on status alone — starting a second
 * billed turn against a request the gateway may already be running. The header
 * carries that provenance across the hop so the same rule can be applied here.
 *
 * Deliberately narrow: only an explicit `ambiguous` suppresses the retry. The
 * header is absent on statuses the gateway itself produced, and those stay
 * retryable, so this cannot disable the recovery the whole change exists for.
 */
function hasAmbiguousDelivery(response: Response): boolean {
  return (
    response.headers.get(AI_CREDITS_GATEWAY_DELIVERY.header) ===
    AI_CREDITS_GATEWAY_DELIVERY.ambiguous
  );
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function writeProxyError(
  response: ServerResponse,
  status: number,
  code: ProxyFailureCode,
  message: string,
  details: {
    attempts?: number;
    elapsedMs?: number;
    correlationId?: string;
  } = {},
): void {
  const correlationId = details.correlationId ?? randomUUID();
  response.writeHead(status, {
    'content-type': 'application/json',
    [AI_CREDITS_CORRELATION_HEADER]: correlationId,
  });
  response.end(
    // Field order is load-bearing. Codex embeds this body inside
    // `unexpected status <code>: <body>` and truncates it, so the fields the UI
    // cannot do without go first: the marker and `code` select the notice, and
    // `correlation_id` is the only actionable detail the user is asked to
    // report — for `invalid_request` and `proxy_internal_error` it is the sole
    // action, and the notice hides both the id and the Copy button when it is
    // absent. `message`/`attempts`/`elapsed_ms` are diagnostic padding and are
    // safe to lose to truncation.
    JSON.stringify({
      error: {
        canopy_proxy: CANOPY_PROXY_MARKER,
        code,
        correlation_id: correlationId,
        message,
        ...(details.attempts !== undefined
          ? { attempts: details.attempts }
          : {}),
        ...(details.elapsedMs !== undefined
          ? { elapsed_ms: details.elapsedMs }
          : {}),
      },
    }),
  );
}

function hasDotPathSegment(requestTarget: string): boolean {
  const rawPathname = requestTarget.split('?', 1)[0] ?? '';
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(rawPathname);
  } catch {
    return true;
  }
  return decodedPathname
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
}

interface OpenCodeGatewayInferenceFailure {
  status?: number;
  proxyFailure?: CanopyProxyError;
}

export interface CodexGatewayRouteLease {
  routeId: string;
  baseUrl: string;
  /** Host-only evidence retained after revocation; absent for native broker routes. */
  readInferenceFailure?: () => OpenCodeGatewayInferenceFailure | undefined;
}

/** Body collection stopped because the route's upstream was withdrawn. */
class RouteWithdrawnError extends Error {}

function readBody(
  request: IncomingMessage,
  maxBytes: number,
  withdrawn?: AbortSignal,
): Promise<Buffer<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    // Attached before reading: a stalled upload must not outlive its route.
    const onWithdrawn = (): void => {
      exceeded = true;
      chunks.length = 0;
      reject(new RouteWithdrawnError('AI Credits route was withdrawn'));
    };
    if (withdrawn?.aborted) {
      onWithdrawn();
      return;
    }
    withdrawn?.addEventListener('abort', onWithdrawn, { once: true });
    request.once('close', () =>
      withdrawn?.removeEventListener('abort', onWithdrawn),
    );
    request.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        // Drop the buffered chunks immediately: the request is rejected, so
        // holding up to MAX_REQUEST_BYTES reachable from the still-attached
        // listener serves no purpose.
        chunks.length = 0;
        // Deliberately keep draining rather than destroying the request. The
        // 413 still has to reach the client, and tearing the socket down (or
        // pausing it) mid-upload can leave the client blocked on its own write
        // before it ever reads the response. The remaining bytes are bounded by
        // what the client already intended to send, and they are discarded.
        reject(new RangeError('AI Credits request exceeded the size limit'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      withdrawn?.removeEventListener('abort', onWithdrawn);
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

export function waitForResponseDrain(response: ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      response.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      response.off('drain', onDrain);
      reject(error);
    };
    response.once('drain', onDrain);
    response.once('error', onError);
  });
}

export class CodexGatewayProxyService {
  private server: Server | null = null;
  private port: number | null = null;
  private readonly routes = new Map<string, CodexGatewayRoute>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private startPromise: Promise<void> | null = null;
  /** Advances on shutdown, so a bind that settles later closes itself. */
  private lifecycle = 0;
  private readonly retryDelaysMs: readonly number[];
  private readonly retryBudgetMs: number;
  private readonly now: () => number;
  private preRouteDiagnosticCount = 0;
  private preRouteDiagnosticWindowStart = 0;

  constructor(private readonly options: CodexGatewayProxyServiceOptions = {}) {
    this.retryDelaysMs = options.retryDelaysMs ?? CODEX_GATEWAY_RETRY_DELAYS_MS;
    this.retryBudgetMs = options.retryBudgetMs ?? CODEX_GATEWAY_RETRY_BUDGET_MS;
    this.now = options.now ?? Date.now;
  }

  async registerRoute(
    options: CodexGatewayBaseRouteOptions | CodexGatewayDaemonRouteOptions,
  ): Promise<CodexGatewayRouteLease> {
    const inferencePolicy = snapshotInferencePolicy(options.inferencePolicy);
    const route: CodexGatewayRoute = {
      ...options,
      expiryHolds: 0,
      ...(options.waitForQuotaRecovery
        ? { quotaWaitController: new AbortController() }
        : {}),
      forwardCanopyHeaders: options.forwardCanopyHeaders ?? true,
      extraHeaders: options.extraHeaders ?? {},
      allowedPaths: [...(options.allowedPaths ?? ['/'])],
      allowedQueries: [...(options.allowedQueries ?? [])],
      forwardHeaders: [...(options.forwardHeaders ?? [])],
      stripCacheControl: options.stripCacheControl ?? false,
      unlimitedRequestBody: options.unlimitedRequestBody ?? false,
      inferencePolicy,
      ...(inferencePolicy ? { submittedBodies: new Set<string>() } : {}),
    };
    const lifecycle = this.lifecycle;
    await this.ensureStarted();
    if (lifecycle !== this.lifecycle)
      throw new Error('AI Credits proxy shut down while registering a route');
    const routeId = randomBytes(24).toString('hex');
    this.routes.set(routeId, route);
    if (route.sessionId.startsWith('ephemeral:')) {
      const timer = setTimeout(
        () => this.removeRoute(routeId),
        EPHEMERAL_ROUTE_TTL_MS,
      );
      timer.unref?.();
      this.expiryTimers.set(routeId, timer);
    }
    return {
      routeId,
      ...(inferencePolicy
        ? {
            readInferenceFailure: ():
              | OpenCodeGatewayInferenceFailure
              | undefined => {
              const failure = route.inferenceFailure;
              return failure
                ? {
                    ...failure,
                    ...(failure.proxyFailure
                      ? { proxyFailure: { ...failure.proxyFailure } }
                      : {}),
                  }
                : undefined;
            },
          }
        : {}),
      baseUrl: `http://127.0.0.1:${String(this.port)}/codex-gateway/${routeId}`,
    };
  }

  /** Keep temporary routes alive while their owner waits and continues work. */
  retainRoutesForSession(sessionId: string): () => void {
    const releases = Array.from(this.routes.entries())
      .filter(([, route]) => route.sessionId === sessionId)
      .map(([routeId]) => this.retainRoute(routeId));
    return (): void => {
      for (const release of releases) release();
    };
  }

  private retainRoute(routeId: string): () => void {
    const route = this.routes.get(routeId);
    if (!route) return (): void => undefined;
    route.expiryHolds += 1;
    const expiry = this.expiryTimers.get(routeId);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(routeId);
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      route.expiryHolds -= 1;
      if (
        route.expiryHolds === 0 &&
        this.routes.get(routeId) === route &&
        route.sessionId.startsWith('ephemeral:')
      ) {
        const expiry = setTimeout(
          () => this.removeRoute(routeId),
          EPHEMERAL_ROUTE_TTL_MS,
        );
        expiry.unref?.();
        this.expiryTimers.set(routeId, expiry);
      }
    };
  }

  unregisterRoutesForSession(sessionId: string): void {
    for (const [routeId, route] of Array.from(this.routes.entries())) {
      if (route.sessionId === sessionId) {
        this.removeRoute(routeId);
      }
    }
  }

  /** Release one host-owned turn without revoking another turn's lease. */
  unregisterRoute(routeId: string): void {
    this.removeRoute(routeId);
  }

  /**
   * `closeActiveConnections` also drops open requests and streams, so a
   * stalled client cannot hold the close. For hosts that already withdrew
   * every route; the desktop's quit keeps draining.
   */
  async shutdown(
    options: { readonly closeActiveConnections?: boolean } = {},
  ): Promise<void> {
    this.lifecycle += 1;
    const starting = this.startPromise;
    for (const route of Array.from(this.routes.values()))
      route.quotaWaitController?.abort();
    this.routes.clear();
    for (const timer of Array.from(this.expiryTimers.values())) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();
    const server = this.server;
    this.server = null;
    this.port = null;
    this.startPromise = null;
    // A pending bind closes its own listener before settling.
    await starting?.catch(() => undefined);
    if (!server) return;
    const closing = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    if (options.closeActiveConnections) server.closeAllConnections();
    await closing;
  }

  private removeRoute(routeId: string): void {
    this.routes.get(routeId)?.quotaWaitController?.abort();
    this.routes.delete(routeId);
    const timer = this.expiryTimers.get(routeId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(routeId);
  }

  private emitDiagnostic(
    routeId: string,
    route: CodexGatewayRoute,
    record: Omit<
      CodexGatewayProxyDiagnosticRecord,
      | 'version'
      | 'timestamp'
      | 'sessionKey'
      | 'projectId'
      | 'worktreeId'
      | 'chatId'
      | 'providerType'
      | 'codexGatewayRouteRef'
    >,
  ): void {
    try {
      diagnosticSink?.({
        version: 1,
        timestamp: new Date().toISOString(),
        ...deriveProxyDiagnosticIdentity(
          route.sessionId,
          route.inferencePolicy?.providerType,
        ),
        codexGatewayRouteRef: createHash('sha256')
          .update(routeId)
          .digest('hex')
          .slice(0, 8),
        ...record,
      });
    } catch {
      // Diagnostics are best-effort and must never alter proxy behavior.
    }
  }

  /**
   * Records a failure that happened before a route (and therefore a session)
   * could be resolved. The notice copy for these codes tells the user to report
   * the correlation id, so the id has to reach a diagnostic record or support
   * receives an id that joins to nothing. Route/session attribution is
   * deliberately omitted rather than faked: there is no route yet.
   */
  private emitPreRouteDiagnostic(record: {
    codexGatewayFailureCode: ProxyFailureCode;
    codexGatewayCorrelationId: string;
  }): void {
    // These paths fire before any credential or route-id check, so anything
    // that can reach the loopback port can drive diagnostic writes. The triage
    // signal they exist for (an expired route, a malformed caller) only needs
    // the first few records, so cap them rather than letting a chatty local
    // caller grow the session-events day file without bound.
    //
    // The cap is per WINDOW, not per process. An expired-route 404 is reachable
    // in normal operation on the 30-minute route TTL, and its notice copy tells
    // the user to report the error id — so a process-lifetime cap meant a long
    // session eventually handed support ids that join to nothing, which is the
    // exact gap this emit exists to close. The window keeps the abuse bound
    // while guaranteeing the support contract recovers.
    const now = this.now();
    if (
      now - this.preRouteDiagnosticWindowStart >=
      PRE_ROUTE_DIAGNOSTIC_WINDOW_MS
    ) {
      this.preRouteDiagnosticWindowStart = now;
      this.preRouteDiagnosticCount = 0;
    }
    if (this.preRouteDiagnosticCount >= MAX_PRE_ROUTE_DIAGNOSTICS) return;
    this.preRouteDiagnosticCount += 1;
    try {
      diagnosticSink?.({
        version: 1,
        timestamp: new Date().toISOString(),
        ...deriveProxyDiagnosticIdentity(''),
        kind: 'codex_gateway_proxy_failed',
        codexGatewayAttemptCount: 0,
        ...record,
      });
    } catch {
      // Diagnostics are best-effort and must never alter proxy behavior.
    }
  }

  private async fetchUpstreamWithRetry(options: {
    upstreamUrl: URL;
    headers: Headers;
    body: Buffer<ArrayBuffer>;
    signal: AbortSignal;
    clientGone: () => boolean;
    budgetExpired: () => boolean;
    /** Sees every upstream response, retried ones included. */
    onResponse?: (response: Response) => void;
    inferenceRouteActive?: () => boolean;
    /** Daemon routes: a custody lease per attempt, applied as it is sent. */
    daemon?: DaemonAttemptHook;
  }): Promise<UpstreamAttemptOutcome> {
    const startedAt = this.now();
    const maxAttempts = this.retryDelaysMs.length + 1;
    let lastRetryReason: string | undefined;
    let lastRetryStatus: number | undefined;
    let lastErrorCode: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.inferenceRouteActive && !options.inferenceRouteActive())
        return { kind: 'route-revoked' };
      // Re-check the deadline immediately before every attempt after the first.
      // The pre-sleep checks below are PREDICTIVE (`elapsedMs + delayMs`), and
      // since the budget timer is deliberately passive nothing interrupts a
      // backoff sleep any more — so an overshoot (event-loop stall, machine
      // sleep, long GC) could otherwise start a post-deadline attempt. This
      // POST is billed and non-idempotent, so that attempt is a real cost.
      // Only new attempts are gated; an already-running one is never aborted.
      if (
        attempt > 1 &&
        (this.now() - startedAt >= this.retryBudgetMs ||
          options.budgetExpired())
      ) {
        return {
          kind: 'exhausted',
          failure: {
            code: 'upstream_unavailable',
            retryReason: lastRetryReason ?? 'retry_budget_expired',
            ...(lastErrorCode ? { errorCode: lastErrorCode } : {}),
          },
          attempts: attempt - 1,
          elapsedMs: this.now() - startedAt,
        };
      }
      try {
        const init: RequestInit = {
          method: 'POST',
          headers: options.headers,
          body: options.body,
          signal: options.signal,
          // A followed redirect would carry the body past the route's checks.
          redirect:
            options.inferenceRouteActive || options.daemon ? 'error' : 'follow',
        };
        if (options.daemon) {
          const lease = await options.daemon.prepare();
          if (lease === 'model-refused')
            return { kind: 'model-refused', attempts: attempt - 1 };
          if (lease === null) return { kind: 'route-revoked' };
          // Custody revalidation may consume the remaining retry budget.
          if (
            attempt > 1 &&
            (this.now() - startedAt >= this.retryBudgetMs ||
              options.budgetExpired())
          ) {
            lease.release();
            return {
              kind: 'exhausted',
              failure: {
                code: 'upstream_unavailable',
                retryReason: lastRetryReason ?? 'retry_budget_expired',
                ...(lastErrorCode ? { errorCode: lastErrorCode } : {}),
              },
              attempts: attempt - 1,
              elapsedMs: this.now() - startedAt,
            };
          }
          // No await from here to the send: an account change retires a
          // lease, and strips its header, only between ticks.
          const committed = options.daemon.commit(lease);
          if (committed === 'gone')
            return {
              kind: 'client-gone',
              attempts: attempt - 1,
              elapsedMs: this.now() - startedAt,
            };
          if (committed === 'revoked') {
            // Fenced across the lease read: wait for the step's checkpoint.
            await options.daemon.settled();
            return { kind: 'route-revoked' };
          }
          if (committed === 'stale') {
            // The account changed after the lease was read; nothing was sent.
            lastRetryReason = 'stale_lease';
            const elapsedMs = this.now() - startedAt;
            const delayMs = this.retryDelaysMs[attempt - 1] ?? 0;
            if (
              attempt < maxAttempts &&
              elapsedMs + delayMs < this.retryBudgetMs &&
              !options.budgetExpired()
            ) {
              await abortableSleep(delayMs, options.signal);
              continue;
            }
            return {
              kind: 'exhausted',
              failure: {
                code: 'upstream_unavailable',
                retryReason: lastRetryReason,
                ...(lastErrorCode ? { errorCode: lastErrorCode } : {}),
              },
              attempts: attempt,
              elapsedMs,
            };
          }
        }
        const upstream = await fetch(options.upstreamUrl, init);
        try {
          options.onResponse?.(upstream);
        } catch {
          // Observers are best effort and must never alter the relay.
        }
        const elapsedMs = this.now() - startedAt;
        const retryable =
          RETRYABLE_HTTP_STATUSES.has(upstream.status) &&
          !isConcurrencyGuard(upstream) &&
          !hasAmbiguousDelivery(upstream) &&
          (!options.inferenceRouteActive ||
            upstream.headers.get(AI_CREDITS_GATEWAY_DELIVERY.header) ===
              AI_CREDITS_GATEWAY_DELIVERY.notSent);
        if (
          !retryable ||
          attempt === maxAttempts ||
          elapsedMs >= this.retryBudgetMs
        ) {
          return {
            kind: 'response',
            response: upstream,
            attempts: attempt,
            elapsedMs,
            ...(lastRetryReason ? { retryReason: lastRetryReason } : {}),
            ...(lastRetryStatus !== undefined
              ? { retryStatus: lastRetryStatus }
              : {}),
            ...(lastErrorCode ? { errorCode: lastErrorCode } : {}),
          };
        }

        lastRetryReason = `http_${String(upstream.status)}`;
        lastRetryStatus = upstream.status;
        const scheduledDelay = this.retryDelaysMs[attempt - 1] ?? 0;
        const delayMs = Math.max(scheduledDelay, retryAfterMs(upstream));
        if (elapsedMs + delayMs >= this.retryBudgetMs) {
          return {
            kind: 'response',
            response: upstream,
            attempts: attempt,
            elapsedMs,
            retryReason: lastRetryReason,
            retryStatus: lastRetryStatus,
          };
        }
        await upstream.body?.cancel().catch(() => {});
        await abortableSleep(delayMs, options.signal);
      } catch (error) {
        const elapsedMs = this.now() - startedAt;
        if (options.clientGone()) {
          return { kind: 'client-gone', attempts: attempt, elapsedMs };
        }
        const errorCode = readErrorCode(error);
        const retryable =
          !isAbortError(error) &&
          errorCode !== undefined &&
          RETRYABLE_CONNECTION_CODES.has(errorCode);
        if (
          retryable &&
          attempt < maxAttempts &&
          elapsedMs < this.retryBudgetMs &&
          !options.budgetExpired()
        ) {
          lastRetryReason = 'connection_error';
          lastErrorCode = errorCode;
          const delayMs = this.retryDelaysMs[attempt - 1] ?? 0;
          if (elapsedMs + delayMs < this.retryBudgetMs) {
            try {
              await abortableSleep(delayMs, options.signal);
              continue;
            } catch {
              if (options.clientGone()) {
                return {
                  kind: 'client-gone',
                  attempts: attempt,
                  elapsedMs: this.now() - startedAt,
                };
              }
            }
          }
        }
        const diagnosticErrorCode =
          errorCode && RETRYABLE_CONNECTION_CODES.has(errorCode)
            ? errorCode
            : lastErrorCode;
        return {
          kind: 'exhausted',
          failure: {
            code: 'upstream_unavailable',
            retryReason: lastRetryReason ?? 'connection_error',
            ...(diagnosticErrorCode ? { errorCode: diagnosticErrorCode } : {}),
          },
          attempts: attempt,
          elapsedMs,
        };
      }
    }

    return {
      kind: 'exhausted',
      failure: {
        code: 'upstream_unavailable',
        retryReason: lastRetryReason ?? 'connection_error',
        ...(lastErrorCode ? { errorCode: lastErrorCode } : {}),
      },
      attempts: maxAttempts,
      elapsedMs: this.now() - startedAt,
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.server && this.port !== null) return;
    if (this.startPromise) return this.startPromise;
    const lifecycle = this.lifecycle;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response).catch(() => {
          if (!response.headersSent) {
            const correlationId = randomUUID();
            this.emitPreRouteDiagnostic({
              codexGatewayFailureCode: 'proxy_internal_error',
              codexGatewayCorrelationId: correlationId,
            });
            writeProxyError(
              response,
              502,
              'proxy_internal_error',
              'AI Credits proxy encountered an internal error.',
              { correlationId },
            );
            return;
          }
          response.destroy();
        });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('AI Credits proxy did not bind a loopback port'));
          return;
        }
        if (lifecycle !== this.lifecycle) {
          server.close(() =>
            reject(new Error('AI Credits proxy shut down while binding')),
          );
          return;
        }
        this.server = server;
        this.port = address.port;
        resolve();
      });
    }).finally(() => {
      // After shutdown, a newer start may own the slot.
      if (lifecycle === this.lifecycle) this.startPromise = null;
    });
    return this.startPromise;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST') {
      const correlationId = randomUUID();
      this.emitPreRouteDiagnostic({
        codexGatewayFailureCode: 'invalid_request',
        codexGatewayCorrelationId: correlationId,
      });
      writeProxyError(
        response,
        405,
        'invalid_request',
        'AI Credits proxy only accepts POST requests.',
        { correlationId },
      );
      return;
    }
    const host = request.headers.host;
    if (
      !host ||
      (host !== `127.0.0.1:${String(this.port)}` &&
        host !== `localhost:${String(this.port)}`)
    ) {
      const correlationId = randomUUID();
      this.emitPreRouteDiagnostic({
        codexGatewayFailureCode: 'invalid_request',
        codexGatewayCorrelationId: correlationId,
      });
      writeProxyError(
        response,
        400,
        'invalid_request',
        'AI Credits proxy received an invalid host.',
        { correlationId },
      );
      return;
    }
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      const correlationId = randomUUID();
      this.emitPreRouteDiagnostic({
        codexGatewayFailureCode: 'invalid_request',
        codexGatewayCorrelationId: correlationId,
      });
      writeProxyError(
        response,
        415,
        'invalid_request',
        'AI Credits proxy requires a JSON request.',
        { correlationId },
      );
      return;
    }
    const requestTarget = request.url ?? '/';
    if (hasDotPathSegment(requestTarget)) {
      const correlationId = randomUUID();
      this.emitPreRouteDiagnostic({
        codexGatewayFailureCode: 'invalid_request',
        codexGatewayCorrelationId: correlationId,
      });
      writeProxyError(
        response,
        400,
        'invalid_request',
        'AI Credits proxy received an invalid path.',
        { correlationId },
      );
      return;
    }
    const requestUrl = new URL(requestTarget, `http://${host}`);
    const match = requestUrl.pathname.match(
      /^\/codex-gateway\/([a-f0-9]{48})(\/.*)?$/,
    );
    const routeId = match?.[1];
    const route = routeId ? this.routes.get(routeId) : undefined;
    if (!route || !routeId) {
      // Genuinely reachable, not just a misconfiguration: ephemeral routes
      // expire on EPHEMERAL_ROUTE_TTL_MS and `unregisterRoutesForSession` drops
      // them on teardown, so a long-lived thread can outlive its route. Without
      // the structured body that lands the user back in the opaque raw-JSON
      // failure this whole change exists to remove.
      const correlationId = randomUUID();
      this.emitPreRouteDiagnostic({
        codexGatewayFailureCode: 'invalid_request',
        codexGatewayCorrelationId: correlationId,
      });
      writeProxyError(
        response,
        404,
        'invalid_request',
        CODEX_PROXY_ROUTE_UNAVAILABLE_MESSAGE,
        { correlationId },
      );
      return;
    }
    const daemon = route.daemon;
    if (daemon) {
      const supplied =
        request.headers[LOOPBACK_BROKER_SECRET_HEADER] ??
        request.headers.authorization?.replace(/^Bearer /, '');
      const expected = Buffer.from(daemon.clientSecret);
      if (
        typeof supplied !== 'string' ||
        Buffer.byteLength(supplied) !== expected.length ||
        !timingSafeEqual(Buffer.from(supplied), expected)
      ) {
        writeProxyError(
          response,
          401,
          'credentials_unavailable',
          'AI Credits proxy requires route authentication.',
          { correlationId: randomUUID() },
        );
        return;
      }
    }
    const apiPath = match?.[2] ?? '/';
    const requestQuery = requestUrl.search.slice(1);
    if (
      (requestQuery.length > 0 &&
        !route.allowedQueries.includes(requestQuery)) ||
      !route.allowedPaths.includes(apiPath)
    ) {
      const correlationId = randomUUID();
      this.emitDiagnostic(routeId, route, {
        kind: 'codex_gateway_proxy_failed',
        codexGatewayAttemptCount: 0,
        codexGatewayFailureCode: 'invalid_request',
        codexGatewayCorrelationId: correlationId,
      });
      writeProxyError(
        response,
        404,
        'invalid_request',
        'AI Credits proxy route does not permit this API path.',
        { correlationId },
      );
      return;
    }
    const upstreamSignal = route.upstreamSignal?.();
    const refuseInferenceRequest = (
      status: number,
      message: string,
      reason: string,
    ): void => {
      if (route.inferencePolicy) route.inferenceFailure ??= { status };
      const correlationId = randomUUID();
      this.emitDiagnostic(routeId, route, {
        kind: 'codex_gateway_proxy_failed',
        codexGatewayFailureCode: 'invalid_request',
        codexGatewayCorrelationId: correlationId,
        codexGatewayRetryReason: reason,
      });
      writeProxyError(response, status, 'invalid_request', message, {
        correlationId,
      });
    };
    const inferenceRouteActive = route.inferencePolicy
      ? (): boolean => this.routes.get(routeId) === route
      : undefined;
    const rejectRevokedInferenceRoute = (): boolean => {
      if (!inferenceRouteActive) return false;
      if (inferenceRouteActive() && !request.aborted && !response.destroyed)
        return false;
      this.removeRoute(routeId);
      if (!response.destroyed)
        refuseInferenceRequest(
          404,
          'AI Credits proxy route is no longer available.',
          'opencode_route_revoked',
        );
      return true;
    };
    const resolveLegacyToken = route.daemon ? undefined : route.resolveToken;
    // Daemon routes present custody per attempt; base routes resolve once.
    let legacyAuthorization: CloudAccountHeaderAuthorization | undefined;
    let credentialsAvailable: boolean;
    if (daemon) {
      credentialsAvailable = await daemon.preflight();
    } else {
      let resolved: Awaited<
        ReturnType<typeof resolveCloudAccountGatewayAuthorization>
      >;
      try {
        resolved = resolveLegacyToken
          ? await resolveCloudAccountGatewayAuthorization(resolveLegacyToken)
          : null;
      } catch (error) {
        if (!inferenceRouteActive) throw error;
        resolved = null;
      }
      if (rejectRevokedInferenceRoute()) return;
      legacyAuthorization = resolved?.authorization;
      credentialsAvailable = legacyAuthorization !== undefined;
    }
    if (!credentialsAvailable || upstreamSignal?.aborted) {
      if (inferenceRouteActive) {
        route.inferenceFailure ??= { status: 401 };
        this.removeRoute(routeId);
      }
      const correlationId = randomUUID();
      this.emitDiagnostic(routeId, route, {
        kind: 'codex_gateway_proxy_failed',
        codexGatewayAttemptCount: 0,
        codexGatewayFailureCode: 'credentials_unavailable',
        codexGatewayCorrelationId: correlationId,
      });
      writeProxyError(
        response,
        401,
        'credentials_unavailable',
        'AI Credits credentials are unavailable.',
        { correlationId },
      );
      return;
    }
    // A child gone during preflight never gets close or end again, so a read
    // would hang holding the withdrawal listener. With the body unread, both
    // flags mean the client disconnected.
    if (daemon && (request.destroyed || response.destroyed)) return;
    let credentialVersion = legacyAuthorization?.credentialVersion;
    let body: Buffer<ArrayBuffer>;
    try {
      body = await readBody(
        request,
        route.unlimitedRequestBody ? Infinity : MAX_REQUEST_BYTES,
        // A stalled upload must not outlive a daemon route.
        daemon ? upstreamSignal : undefined,
      );
    } catch (error) {
      // The answer a withdrawal after the body gets, without waiting for the
      // rest of the upload.
      if (error instanceof RouteWithdrawnError) {
        refuseInferenceRequest(
          404,
          'AI Credits proxy route is no longer available.',
          'opencode_route_revoked',
        );
        return;
      }
      if (error instanceof RangeError) {
        const correlationId = randomUUID();
        this.emitDiagnostic(routeId, route, {
          kind: 'codex_gateway_proxy_failed',
          codexGatewayAttemptCount: 0,
          codexGatewayFailureCode: 'invalid_request',
          codexGatewayCorrelationId: correlationId,
        });
        writeProxyError(
          response,
          413,
          'invalid_request',
          'AI Credits request exceeded the size limit.',
          { correlationId },
        );
        return;
      }
      throw error;
    }
    if (rejectRevokedInferenceRoute()) return;
    const refuseModel = (attempts: number): void => {
      const correlationId = randomUUID();
      this.emitDiagnostic(routeId, route, {
        kind: 'codex_gateway_proxy_failed',
        codexGatewayAttemptCount: attempts,
        codexGatewayFailureCode: 'invalid_request',
        codexGatewayRetryReason: 'model_not_admitted',
        codexGatewayCorrelationId: correlationId,
      });
      writeModelNotAdmitted(response, correlationId);
    };
    let admittedModel: string | undefined;
    if (daemon) {
      const model = readRequestModel(body);
      let admitted = false;
      if (model !== undefined) {
        try {
          admitted = await daemon.admitModel(model);
        } catch {
          admitted = false;
        }
      }
      // The child left during admission; the send's own check also covers it.
      if (response.destroyed) return;
      if (!admitted || model === undefined) {
        refuseModel(0);
        return;
      }
      admittedModel = model;
    }
    if (route.inferencePolicy) {
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        payload = undefined;
      }
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        Reflect.get(payload, 'model') !== route.inferencePolicy.modelId
      ) {
        refuseInferenceRequest(
          400,
          'AI Credits request does not match the selected model.',
          'opencode_model_mismatch',
        );
        return;
      }
      if (route.inferencePolicy.toolSchemaProfile === 'flat') {
        try {
          flattenOpenCodeInferenceTools(payload);
          body = Buffer.from(JSON.stringify(payload), 'utf8');
        } catch {
          refuseInferenceRequest(
            400,
            'OpenCode tool definitions are unavailable for this model.',
            'opencode_tool_schema_invalid',
          );
          return;
        }
      }
    }
    if (route.stripCacheControl) {
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        const strip = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(strip);
            return;
          }
          if (typeof value !== 'object' || value === null) return;
          Reflect.deleteProperty(value, 'cache_control');
          Object.values(value).forEach(strip);
        };
        strip(parsed);
        body = Buffer.from(JSON.stringify(parsed), 'utf8');
      } catch {
        // Invalid JSON is relayed unchanged and rejected by the upstream.
      }
    }
    if (route.submittedBodies) {
      // Native retries can follow an HTTP 200 containing a stream error. Keep
      // only hashes, bounded to this lease; never retain prompt bytes here.
      const digest = createHash('sha256').update(body).digest('hex');
      if (
        route.submittedBodies.has(digest) ||
        route.submittedBodies.size >= MAX_INFERENCE_REQUESTS_PER_LEASE
      ) {
        this.removeRoute(routeId);
        refuseInferenceRequest(
          404,
          'OpenCode stopped this request. Send a new message to continue.',
          route.submittedBodies.has(digest)
            ? 'opencode_request_replay'
            : 'opencode_lease_request_limit',
        );
        return;
      }
      route.submittedBodies.add(digest);
    }
    const headers = new Headers();
    legacyAuthorization?.apply(headers);
    headers.set('content-type', contentType);
    for (const [name, value] of Object.entries(request.headers)) {
      const normalizedName = name.toLowerCase();
      if (normalizedName === LOOPBACK_BROKER_SECRET_HEADER) continue;
      if (
        route.inferencePolicy &&
        (normalizedName.startsWith('x-canopy-') ||
          normalizedName === 'authorization' ||
          normalizedName === 'x-api-key')
      )
        continue;
      if (
        typeof value === 'string' &&
        ((route.forwardCanopyHeaders &&
          normalizedName.startsWith('x-canopy-')) ||
          route.forwardHeaders.includes(normalizedName) ||
          normalizedName === CODEX_RESPONSES_LITE_HEADER)
      ) {
        headers.set(name, value);
      }
    }
    for (const [name, value] of Object.entries({
      ...route.extraHeaders,
      ...(route.inferencePolicy?.headers ?? {}),
    })) {
      headers.set(name, value);
    }
    const abortController = new AbortController();
    let completed = false;
    let clientGone = false;
    let budgetExpired = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abortUpstream = (): void => {
      if (!completed) {
        clientGone = true;
        abortController.abort();
      }
    };
    const abortOnPrematureClose = (): void => {
      if (!response.writableEnded) {
        abortUpstream();
      }
    };
    // The upstream was withdrawn: the client is still there and gets an error.
    const abortWithdrawn = (): void => {
      if (!completed) abortController.abort();
    };
    request.once('aborted', abortUpstream);
    request.once('error', abortUpstream);
    response.once('close', abortOnPrematureClose);
    upstreamSignal?.addEventListener('abort', abortWithdrawn, { once: true });
    if (upstreamSignal?.aborted) abortController.abort();
    // The presentation of the latest daemon attempt; retired on the next
    // attempt and when the request settles.
    let attemptLease: CloudAccountHeaderAuthorization | undefined;
    const daemonAttempt: DaemonAttemptHook | undefined =
      daemon && admittedModel !== undefined
        ? {
            prepare: () => daemon.prepare(admittedModel),
            commit: (lease): DaemonCommit => {
              attemptLease?.release();
              attemptLease = lease;
              // `request.destroyed` is set once the body is read, so only
              // the response tells a departed child apart.
              if (response.destroyed || clientGone) return 'gone';
              if (
                abortController.signal.aborted ||
                this.routes.get(routeId) !== route ||
                !daemon.current()
              )
                return 'revoked';
              try {
                lease.apply(headers);
              } catch {
                return 'stale';
              }
              credentialVersion = lease.credentialVersion;
              return 'ready';
            },
            settled: () => daemon.settled(),
          }
        : undefined;
    // Marks the retry budget as spent so no FURTHER attempt is scheduled. It
    // must not abort the controller: that signal also governs the in-flight
    // `fetch`, so aborting here would kill a healthy request that simply has a
    // slow time-to-first-byte (and, once headers arrived, its streamed body).
    // An abort is also non-retryable, so it would surface as a fabricated
    // `upstream_unavailable` 502 that the CAN-1662 classifier re-dispatches
    // straight back into the same wall. The `elapsedMs >= retryBudgetMs` and
    // `budgetExpired()` checks in `fetchUpstreamWithRetry` are what actually
    // enforce the budget; client disconnect still aborts via `abortUpstream`.
    const startRetryBudgetTimer = (): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(() => {
        if (!completed) budgetExpired = true;
      }, this.retryBudgetMs);
      timer.unref?.();
      return timer;
    };
    let retryBudgetTimer = startRetryBudgetTimer();
    let releaseQuotaRoute: (() => void) | undefined;
    try {
      const upstreamUrl = new URL(route.upstreamUrl);
      if (apiPath !== '/') {
        upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/+$/, '')}${apiPath}`;
      }
      upstreamUrl.search = requestUrl.search;
      let outcome: UpstreamAttemptOutcome;
      for (;;) {
        const candidate = await this.fetchUpstreamWithRetry({
          upstreamUrl,
          headers,
          body,
          signal: abortController.signal,
          clientGone: () => clientGone,
          budgetExpired: () => budgetExpired,
          inferenceRouteActive,
          ...(daemonAttempt ? { daemon: daemonAttempt } : {}),
          // Every attempt is reported, so an account that answered a request
          // that was then retried is still counted for the chat.
          onResponse: (attempt) =>
            route.onUpstreamResponse?.({
              status: attempt.status,
              path: apiPath,
              headers: attempt.headers,
            }),
        });
        if (
          candidate.kind !== 'response' ||
          candidate.response.status !== 429 ||
          !route.waitForQuotaRecovery ||
          isConcurrencyGuard(candidate.response) ||
          hasAmbiguousDelivery(candidate.response)
        ) {
          outcome = candidate;
          break;
        }
        // An explicit 429 before headers is a rejected provider request, so
        // retry that request after capacity returns. Never replay a stream.
        await candidate.response.body?.cancel();
        clearTimeout(retryBudgetTimer);
        releaseQuotaRoute ??= this.retainRoute(routeId);
        const waitSignal = route.quotaWaitController
          ? AbortSignal.any([
              abortController.signal,
              route.quotaWaitController.signal,
            ])
          : abortController.signal;
        await route.waitForQuotaRecovery(waitSignal);
        waitSignal.throwIfAborted();
        if (this.routes.get(routeId) !== route)
          throw new Error('Proxy route was released.');
        const refreshed = resolveLegacyToken
          ? await resolveCloudAccountGatewayAuthorization(resolveLegacyToken)
          : null;
        if (!refreshed) throw new Error('Proxy credentials are unavailable.');
        refreshed.authorization.apply(headers);
        credentialVersion = refreshed.authorization.credentialVersion;
        budgetExpired = false;
        retryBudgetTimer = startRetryBudgetTimer();
      }
      // The retry budget bounds the pre-header retry phase only. Once the
      // retry loop has returned, disarm it: `abortController.signal` also
      // governs the upstream response body, so leaving the timer armed would
      // abort a perfectly healthy stream mid-turn once it outlived the budget
      // (`completed` is not set until the body has been fully relayed).
      // Downstream-disconnect cancellation stays wired through `abortUpstream`.
      clearTimeout(retryBudgetTimer);
      if (outcome.kind === 'client-gone') return;
      if (outcome.kind === 'model-refused') {
        completed = true;
        refuseModel(outcome.attempts);
        return;
      }
      if (outcome.kind === 'route-revoked') {
        completed = true;
        refuseInferenceRequest(
          404,
          'AI Credits proxy route is no longer available.',
          'opencode_route_revoked',
        );
        return;
      }

      if (outcome.kind === 'exhausted') {
        if (inferenceRouteActive) {
          route.inferenceFailure ??= { status: 502 };
          this.removeRoute(routeId);
        }
        const correlationId = randomUUID();
        if (outcome.attempts > 1) {
          this.emitDiagnostic(routeId, route, {
            kind: 'codex_gateway_proxy_retry',
            elapsedMs: outcome.elapsedMs,
            codexGatewayAttemptCount: outcome.attempts,
            codexGatewayRetryReason: outcome.failure.retryReason,
            ...(outcome.failure.errorCode
              ? { codexGatewayErrorCode: outcome.failure.errorCode }
              : {}),
            codexGatewayCorrelationId: correlationId,
          });
        }
        this.emitDiagnostic(routeId, route, {
          kind: 'codex_gateway_proxy_failed',
          elapsedMs: outcome.elapsedMs,
          codexGatewayAttemptCount: outcome.attempts,
          codexGatewayFailureCode: outcome.failure.code,
          codexGatewayRetryReason: outcome.failure.retryReason,
          ...(outcome.failure.errorCode
            ? { codexGatewayErrorCode: outcome.failure.errorCode }
            : {}),
          codexGatewayCorrelationId: correlationId,
        });
        completed = true;
        writeProxyError(
          response,
          502,
          'upstream_unavailable',
          'AI Credits proxy could not reach the gateway.',
          {
            attempts: outcome.attempts,
            elapsedMs: outcome.elapsedMs,
            correlationId,
          },
        );
        return;
      }

      const upstream = outcome.response;
      const upstreamInferenceFailure:
        | OpenCodeGatewayInferenceFailure
        | undefined =
        inferenceRouteActive && upstream.status >= 400
          ? { status: upstream.status }
          : undefined;
      if (upstreamInferenceFailure) {
        route.inferenceFailure ??= upstreamInferenceFailure;
        this.removeRoute(routeId);
      }
      if (upstream.status === 401 || upstream.status === 403) {
        if (daemon) {
          // Revocation must stop other inference, not erase this terminal
          // refusal body and turn an actionable 401/403 into a fabricated
          // 502. Downstream disconnect still cancels it via abortUpstream.
          upstreamSignal?.removeEventListener('abort', abortWithdrawn);
          // A 403 policy refusal is classified from its buffered body below.
          if (upstream.status === 401)
            await daemon.onCredentialRejected(401, credentialVersion);
        } else {
          await route.onCredentialRejected?.(
            upstream.status,
            credentialVersion,
          );
        }
      }
      const correlationId =
        upstream.headers.get(AI_CREDITS_CORRELATION_HEADER) ?? undefined;
      if (outcome.attempts > 1) {
        this.emitDiagnostic(routeId, route, {
          kind: 'codex_gateway_proxy_retry',
          elapsedMs: outcome.elapsedMs,
          codexGatewayAttemptCount: outcome.attempts,
          ...(outcome.retryStatus !== undefined
            ? { codexGatewayUpstreamStatus: outcome.retryStatus }
            : {}),
          ...(outcome.retryReason
            ? { codexGatewayRetryReason: outcome.retryReason }
            : {}),
          ...(outcome.errorCode
            ? { codexGatewayErrorCode: outcome.errorCode }
            : {}),
          ...(correlationId
            ? { codexGatewayCorrelationId: correlationId }
            : {}),
        });
      }
      if (
        RETRYABLE_HTTP_STATUSES.has(upstream.status) &&
        !isConcurrencyGuard(upstream)
      ) {
        this.emitDiagnostic(routeId, route, {
          kind: 'codex_gateway_proxy_failed',
          elapsedMs: outcome.elapsedMs,
          codexGatewayAttemptCount: outcome.attempts,
          codexGatewayUpstreamStatus: upstream.status,
          codexGatewayFailureCode: 'upstream_unavailable',
          ...(outcome.retryReason
            ? { codexGatewayRetryReason: outcome.retryReason }
            : {}),
          ...(correlationId
            ? { codexGatewayCorrelationId: correlationId }
            : {}),
        });
      }
      const responseHeaders: Record<string, string> = {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/json',
      };
      for (const name of [
        'retry-after',
        AI_CREDITS_CONCURRENCY_GUARD.markerHeader,
        AI_CREDITS_CORRELATION_HEADER,
      ]) {
        const value = upstream.headers.get(name);
        if (value !== null) responseHeaders[name] = value;
      }
      const upstreamBody = upstream.body;
      if (!upstreamBody) {
        response.writeHead(upstream.status, responseHeaders);
        completed = true;
        response.end();
        return;
      }
      reader = upstreamBody.getReader();
      // Classify a no-billing-source rejection HERE, while the marked hosted
      // body is still intact. Codex discards it: as of the bundled 0.148.0 it
      // parses the JSON and renders only `error.message`, dropping the marker
      // the renderer's detector keys on, so a verdict recovered from the
      // provider's rendered error text never arrives. The proxy is the last
      // point that still holds the evidence.
      //
      // Buffering is confined to this one small, non-streaming status so the
      // SSE turn body is never held up. The bytes are relayed unchanged either
      // way: on a complete read they are replayed verbatim, and on an oversized
      // one the prefix already read is written before the rest of the stream
      // resumes, so no path can truncate what the client receives.
      let bufferedPrefix: Buffer | null = null;
      if (BUFFERED_REFUSAL_STATUSES.has(upstream.status)) {
        const chunks: Buffer[] = [];
        let bufferedBytes = 0;
        let readWholeBody = false;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            readWholeBody = true;
            break;
          }
          chunks.push(Buffer.from(chunk.value));
          bufferedBytes += chunk.value.length;
          if (bufferedBytes > MAX_BUFFERED_ERROR_BYTES) break;
        }
        bufferedPrefix = Buffer.concat(chunks);
        if (readWholeBody) {
          const parsed = parseCanopyProxyError(bufferedPrefix.toString('utf8'));
          // Only a MARKED body is recorded; an unmarked 402/403 (a provider
          // rejection passed through) keeps its own rendering.
          const recorded =
            parsed !== null &&
            (upstream.status !== NO_BILLING_SOURCE_STATUS ||
              parsed.code === 'no_billing_source');
          if (parsed !== null && recorded) {
            if (upstreamInferenceFailure)
              upstreamInferenceFailure.proxyFailure = parsed;
            else
              this.options.recordSessionProxyFailure?.(route.sessionId, parsed);
          }
          if (upstream.status === NO_BILLING_SOURCE_STATUS) {
            // Emitted for BOTH outcomes. The record carries the route's own
            // session id, so triage can tell a body that never classified
            // apart from a verdict filed against a session key the failing
            // chat does not share.
            this.emitDiagnostic(routeId, route, {
              kind: 'codex_gateway_no_billing_source',
              elapsedMs: outcome.elapsedMs,
              codexGatewayAttemptCount: outcome.attempts,
              codexGatewayUpstreamStatus: upstream.status,
              codexGatewayNoBillingSourceClassified: recorded,
              ...(correlationId
                ? { codexGatewayCorrelationId: correlationId }
                : {}),
            });
          }
          // A hosted policy refusal pauses the step before the child sees it;
          // it blocks only this route's policy, never the credential.
          const policyCode =
            daemon && upstream.status === 403
              ? hostedPolicyRefusalCode(bufferedPrefix.toString('utf8'))
              : undefined;
          if (daemon && policyCode) await daemon.onPolicyRefusal(policyCode);
          response.writeHead(upstream.status, responseHeaders);
          completed = true;
          response.end(bufferedPrefix);
          return;
        }
      }
      response.writeHead(upstream.status, responseHeaders);
      if (bufferedPrefix !== null && bufferedPrefix.length > 0) {
        if (!response.write(bufferedPrefix)) {
          await waitForResponseDrain(response);
        }
      }
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!response.write(Buffer.from(chunk.value))) {
          await waitForResponseDrain(response);
        }
      }
      completed = true;
      response.end();
    } finally {
      attemptLease?.release();
      releaseQuotaRoute?.();
      clearTimeout(retryBudgetTimer);
      request.off('aborted', abortUpstream);
      request.off('error', abortUpstream);
      response.off('close', abortOnPrematureClose);
      upstreamSignal?.removeEventListener('abort', abortWithdrawn);
      if (!completed) {
        if (inferenceRouteActive) {
          route.inferenceFailure ??= {};
          this.removeRoute(routeId);
        }
        abortController.abort();
        await reader?.cancel().catch(() => {});
      }
      reader?.releaseLock();
    }
  }
}
