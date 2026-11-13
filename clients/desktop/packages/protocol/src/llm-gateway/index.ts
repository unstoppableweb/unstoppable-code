import type { DailyDripBlockedReason, DailyDripGrantOutcome } from '../billing';
import type {
  AiGatewayHarness,
  AiGatewayModelFamily,
  AiGatewayToolSchemaProfile,
} from '../ai-gateway-models';
import type { ThinkingLevel } from '../thinking/index';

/** Presentation context only; the upstream failure remains an HTTP 400. */
export const CLAUDE_AI_CREDITS_FALLBACK_ERROR_CODE =
  'claude_ai_credits_fallback_rejected';
export type ClaudeAiCreditsFallbackErrorCode =
  typeof CLAUDE_AI_CREDITS_FALLBACK_ERROR_CODE;

export function isClaudeAiCreditsFallbackErrorCode(
  value: unknown,
): value is ClaudeAiCreditsFallbackErrorCode {
  return value === CLAUDE_AI_CREDITS_FALLBACK_ERROR_CODE;
}

/** Runtime AI Gateway metadata attached by the validated catalog merge. */
export interface GatewayModelConfig {
  gatewayId: string;
  family: AiGatewayModelFamily;
  recommendedHarness: AiGatewayHarness;
  gatewayOnly: boolean;
  contextWindow: number;
  supportsPromptCaching: boolean;
  /** Explicit gateway capability; never inferred from the native harness. */
  supportsImages?: boolean;
  /**
   * Canonical thinking levels for the merged runtime entry. Wire catalog rows
   * keep `off` implicit; the merge materializes it, so a non-empty set here
   * always starts at `off` while an empty set still means "thinking
   * unsupported".
   */
  supportedThinkingLevels: ThinkingLevel[];
  toolSchemaProfile: AiGatewayToolSchemaProfile;
  /** Hosted is the backward-compatible default when this field is absent. */
  origin?: 'hosted' | 'org-gateway';
  /** Present only for direct org-gateway routes. Never contains credentials. */
  baseUrl?: string;
  organizationId?: string;
  promptCachePassthrough?: boolean;
}

/** Normalized gateway entry consumed by desktop and CLI routing. */
export interface GatewayModelEntry extends GatewayModelConfig {
  /** Canonical runtime model id (e.g. 'opus[1m]' or 'gpt-5.5'). */
  modelId: string;
}

/**
 * Wire contract for the llm-proxy per-account concurrency guard (CAN-838
 * interaction). When the proxy rejects a request because the account has
 * reached its per-replica in-flight limit, it responds with THIS distinct
 * status — deliberately **not** 429.
 *
 * Why not 429: the desktop on-quota fallback classifies a Claude `result`
 * (`is_error` + `api_error_status === 429`) or an `assistant` `error:
 * 'rate_limit'` event as a provider usage-limit and reverts routing to native
 * auth for the rest of the process session (with no auto-revert for Claude,
 * which reports no reset time). A transient in-flight-limit collision is not a
 * usage limit, so emitting 429 for it would falsely trip that fallback and
 * silently kick the account out of AI-Credits routing.
 *
 * The guard therefore reserves 429 for genuine upstream usage limits and uses a
 * distinct, retryable status (`503`) plus `Retry-After` so the harness SDK
 * (Anthropic / Codex) backs off and retries for a slot. The desktop quota
 * detectors react only to a genuine upstream 429, so this status is never
 * misclassified. The marker header/body code additionally lets HTTP-aware
 * consumers and tests identify a guard rejection unambiguously.
 *
 * Hosted and desktop deploy independently, and an installed desktop reads
 * `httpStatus`, `markerHeader`, and `markerValue` from its own bundled copy.
 * Those three must not change; the Retry-After bounds are read only by the
 * hosted proxy.
 *
 * The desktop Codex proxy does not retry a guard rejection itself. It passes
 * the 503 and its Retry-After through to the harness unchanged, so the jittered
 * range survives end to end. Its own retry loop caps Retry-After at two
 * seconds; if it ever starts retrying guard rejections, that cap would flatten
 * this range to a constant and bring back lockstep retries.
 */
export const AI_CREDITS_CONCURRENCY_GUARD = {
  /** Distinct, SDK-retryable status. MUST NOT be 429 (see above). */
  httpStatus: 503,
  /** Inclusive lower bound (seconds) of the jittered Retry-After. */
  retryAfterMinSeconds: 2,
  /**
   * Inclusive upper bound (seconds) of the jittered Retry-After. The proxy
   * picks a random integer in the range per rejection so colliding clients do
   * not retry in lockstep.
   */
  retryAfterMaxSeconds: 5,
  /** Response header stamped on a concurrency-guard rejection. */
  markerHeader: 'x-canopy-ai-credits-guard',
  /** Value of {@link markerHeader} on a concurrency-guard rejection. */
  markerValue: 'concurrent-request-in-progress',
  /** Structured `code` on the JSON error body. */
  bodyCode: 'ai_credits_concurrent_request_in_progress',
} as const;

/**
 * Wire contract carrying **delivery provenance** for a gateway failure that the
 * hosted proxy synthesized itself, rather than relayed from the gateway.
 *
 * Why this has to cross the wire. The desktop proxy retries a billed,
 * non-idempotent POST, so it retries a *connection* error only when the error
 * code proves the request never left the host (`RETRYABLE_CONNECTION_CODES`);
 * `ECONNRESET` and friends are excluded because they can fire after the request
 * was transmitted. But that allowlist only governs the desktop's own socket.
 * When `apps/web`'s own `fetch` to the gateway rejects, the desktop sees a
 * well-formed HTTP response, not a connection error — so without this header the
 * whole rejection class collapses into a bare `502` and the desktop replays it
 * on status alone, which is exactly the double-charge the allowlist prevents
 * locally.
 *
 * The header is stamped ONLY on proxy-synthesized failures. Its absence
 * therefore means "this status came from the gateway itself" and leaves normal
 * status-based retry untouched; only an explicit {@link ambiguous} value
 * suppresses a replay. That keeps the fix fail-closed on the one shape that is
 * genuinely ambiguous without disabling retry for real upstream 5xx.
 */
export const AI_CREDITS_GATEWAY_DELIVERY = {
  /** Response header stamped on a proxy-synthesized gateway failure. */
  header: 'x-canopy-gateway-delivery',
  /**
   * The request provably never reached the gateway (DNS, refused, unroutable,
   * connect timeout), so no turn was started and a replay cannot double-charge.
   */
  notSent: 'not-sent',
  /**
   * The request may already have been transmitted (mid-flight reset, socket or
   * headers timeout). A replay could start a second billed turn, so the desktop
   * proxy MUST NOT retry this even though the status is nominally retryable.
   */
  ambiguous: 'ambiguous',
} as const;

/**
 * The header governs the PROXY-level replay only. Suppressing that alone is not
 * enough, because the proxy relays the hosted body to Codex verbatim and the
 * turn-level `transient-error-retry-service` re-dispatches anything the
 * classifier calls `provider_temporarily_unavailable`.
 *
 * So the synthesized body carries the same provenance as a structured failure
 * code, and the two states map onto the classifier's existing semantics:
 *
 *   not-sent  -> `upstream_unavailable`  -> transient, turn-level retry ALLOWED
 *   ambiguous -> `proxy_internal_error`  -> SUPPRESS, turn-level retry REFUSED
 *
 * Known residual: a desktop build carrying the retry loop talking to a hosted
 * deployment that predates this contract sees no header and no marked body, and
 * falls back to status-based retry. Hosted must therefore deploy before a
 * desktop release that includes the loop. The reverse skew is safe — a desktop
 * without the loop performs no proxy-level replay at all.
 */

/** Correlates hosted-gateway responses with desktop proxy diagnostics. */
export const AI_CREDITS_CORRELATION_HEADER = 'x-canopy-request-id';

/**
 * Marker the local AI Credits proxy and hosted gateway routes stamp first in
 * every structured error body they synthesize, before `code`,
 * `correlation_id`, and `message`.
 *
 * When a harness relays the body, this separates a Canopy-originated failure
 * from upstream errors. Both Claude and Codex may strip response details.
 * Codex can restore a proxy-observed failure; desktop Claude has a narrow,
 * routing-gated fallback for the exact hosted no-billing-source refusal.
 * Marker parsing supports live marked responses and stored transcripts.
 * This constant is not user-visible copy.
 */
export const AI_CREDITS_PROXY_ERROR_MARKER = 'CANOPY_AI_CREDITS_PROXY';

/**
 * Main-owned verdict on a failure: either Codex's local proxy observed the
 * marked hosted body, or Claude's captured AI Credits route, failure shape,
 * HTTP status and exact hosted wording qualified for the narrow fallback.
 * Claude's text-derived fallback cannot recover correlation ids or prove
 * first-hand proxy provenance. Neither harness guarantees body preservation.
 *
 * The same normalized event feeds live recovery and persisted per-tab state.
 * Consumers still require a failure shape; bare 402 text alone is insufficient.
 * Surviving marked bodies are preserved, and parsing remains valid for live
 * responses and existing stored transcripts.
 */
export const AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG =
  'canopy_ai_credits_no_billing_source';

/**
 * The `message` on the hosted `no_billing_source` 402 body.
 *
 * Shared rather than written twice because two places must agree on it: the
 * hosted route that sends it (`noBillingSourceResponse`) and the desktop, which
 * restores a lost marked body for Codex or a qualified Claude refusal. If those drift, the
 * restored transcript entry stops matching the failure the user actually hit.
 */
export const AI_CREDITS_NO_BILLING_SOURCE_MESSAGE =
  'AI Credits are unavailable for this request.';

/**
 * The `message` on the hosted `work_owner_not_member` 403 body (CAN-3462).
 *
 * Sent when the owner a request claims (or the owner of the Cloud workspace a
 * session is bound to) is an organization the signed-in user no longer
 * belongs to. Shared for the same reason as
 * {@link AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}: the hosted routes send it and
 * the desktop restores it after Codex discards the marked body.
 */
export const AI_CREDITS_WORK_OWNER_REFUSED_MESSAGE =
  "You're no longer in this organization, so its AI Credits can't be used here.";

/** Closed set of `code` values the AI Credits proxy can emit. */
export type CanopyProxyErrorCode =
  | 'credentials_unavailable'
  | 'guest_model_not_allowed'
  | 'model_locked'
  | 'invalid_request'
  | 'no_billing_source'
  | 'proxy_internal_error'
  | 'session_budget_exhausted'
  | 'upstream_unavailable'
  | 'work_owner_not_member';

export type AiCreditsNoBillingSourceReason =
  | 'organization_pool_unavailable'
  | 'personal_wallet_empty';

export interface CanopyProxyError {
  code: CanopyProxyErrorCode;
  recovery?: 'sign_in' | 'add_credits';
  /** Machine-readable reason for a `no_billing_source` refusal. */
  reason?: AiCreditsNoBillingSourceReason;
  /** The proxy's own `message` field, when the body survived intact. */
  message: string | null;
  /** Correlation id bridging a rendered notice to the diagnostics sink. */
  correlationId: string | null;
}

const PROXY_ERROR_CODES: ReadonlySet<string> = new Set([
  'credentials_unavailable',
  'guest_model_not_allowed',
  'model_locked',
  'invalid_request',
  'no_billing_source',
  'proxy_internal_error',
  'session_budget_exhausted',
  'upstream_unavailable',
  'work_owner_not_member',
]);

// Truncation fallbacks. Codex may cut the body short inside
// `unexpected status <code>: <body>`, which defeats `JSON.parse`; the proxy
// writes the marker and `code` first precisely so these still land.
const PROXY_CODE_PATTERN = /"code"\s*:\s*"([a-z_]+)"/;
const PROXY_CORRELATION_ID_PATTERN = /"correlation_id"\s*:\s*"([^"]+)"/;

function isProxyErrorCode(value: string): value is CanopyProxyErrorCode {
  return PROXY_ERROR_CODES.has(value);
}

function isProxyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProxyString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readProxyErrorObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (!isProxyRecord(parsed)) {
      return null;
    }
    return isProxyRecord(parsed.error) ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * Parse a structured AI Credits proxy failure out of a chat error message.
 *
 * Lives in `@canopy/protocol` rather than the desktop renderer because the
 * marker "must never appear in rendered text" on ANY surface, and shared runs
 * replay the same transcript through the web Portal. A parser that only the
 * desktop could reach meant Portal rendered the raw
 * `{"error":{"canopy_proxy":...,"elapsed_ms":...}}` body verbatim.
 *
 * Returns `null` only when the marker is absent — a passed-through upstream 5xx
 * or the concurrency-guard 503 carries no marker and keeps its existing
 * rendering. A marker-bearing body whose `code` is unrecognized is deliberately
 * reported as `proxy_internal_error` rather than `null`: the codes are a closed
 * set maintained alongside the proxy, and failing open there would put the raw
 * JSON back in front of the user the moment a fifth code is added.
 */
export function parseCanopyProxyError(
  message: string,
): CanopyProxyError | null {
  if (!message.includes(AI_CREDITS_PROXY_ERROR_MARKER)) {
    return null;
  }
  const parsed = readProxyErrorObject(message);
  const rawCode =
    (parsed ? readProxyString(parsed, 'code') : null) ??
    PROXY_CODE_PATTERN.exec(message)?.[1] ??
    null;
  const code: CanopyProxyErrorCode =
    rawCode !== null && isProxyErrorCode(rawCode)
      ? rawCode
      : 'proxy_internal_error';
  return {
    code,
    ...(parsed?.recovery === 'sign_in' || parsed?.recovery === 'add_credits'
      ? { recovery: parsed.recovery }
      : {}),
    ...(parsed &&
    (readProxyString(parsed, 'reason') === 'organization_pool_unavailable' ||
      readProxyString(parsed, 'reason') === 'personal_wallet_empty')
      ? {
          reason: readProxyString(
            parsed,
            'reason',
          ) as AiCreditsNoBillingSourceReason,
        }
      : {}),
    message: parsed ? readProxyString(parsed, 'message') : null,
    correlationId:
      (parsed ? readProxyString(parsed, 'correlation_id') : null) ??
      PROXY_CORRELATION_ID_PATTERN.exec(message)?.[1] ??
      null,
  };
}

// ---------------------------------------------------------------------------
// AI Credits contract types (mirror the ECW-8671 read shapes). Shared by the
// apps/web read routes and the desktop status UI.
// ---------------------------------------------------------------------------

/**
 * Which ledger a balance/subscription is reported against. `unstoppable` is the
 * external UD/ECW ledger keyed on the linked UD email; `canopy` is the web app's
 * own prepaid AI-credit ledger keyed on the Canopy user id (CAN-1034 / T13). The
 * display APIs report the source the proxy would bill against right now.
 */
export type AiCreditsSource = 'unstoppable' | 'canopy';

/**
 * Immutable owner of model work, captured when that work starts. This is
 * intentionally distinct from live navigation context, while retaining the
 * same shape so `serializeWorkspaceContext` produces its wire value.
 */
export type WorkOwner =
  | { readonly kind: 'personal' }
  | {
      readonly kind: 'organization';
      /** Organization external id (UUID, lower case). */
      readonly organizationId: string;
    };

/**
 * HTTP headers a routed desktop session attaches so the LLM proxy can attribute
 * a Canopy AI-credit debit to the originating workspace/worktree and record its
 * claimed work owner. Display-name values are `encodeURIComponent`-encoded to
 * stay ASCII-safe in transit; the work owner uses workspace-context serialization
 * (`personal` or `org:<uuid>`). Organization-owned work also carries the stable
 * tracked-project id so privileged reports can enforce project visibility even
 * after a rename. The proxy records and strips all four headers before forwarding
 * upstream so they never leak to the gateway.
 */
export const AI_CREDITS_ATTRIBUTION_WORKSPACE_HEADER = 'x-canopy-workspace';
export const AI_CREDITS_ATTRIBUTION_WORKTREE_HEADER = 'x-canopy-worktree';
export const AI_CREDITS_WORK_OWNER_HEADER = 'x-canopy-work-owner';
export const AI_CREDITS_ORG_PROJECT_HEADER = 'x-canopy-org-project';

/**
 * Set to `1` on Codex Responses requests from a session running multi-agent
 * v2. The proxy keeps such a request on OpenAI, because only OpenAI can read
 * the encrypted task a v2 child receives. Stripped before forwarding.
 */
export const AI_CREDITS_CODEX_MULTI_AGENT_V2_HEADER =
  'x-canopy-codex-multi-agent-v2';

export interface AiCreditsOrgPoolFunding {
  /** Organization wire id. */
  orgId: string;
  /** Organization display name. */
  orgName: string;
}

/** Current AI-credit balance for an account. */
export interface AiCreditsBalance {
  dailyDripBlockedReason?: DailyDripBlockedReason;
  /**
   * What this read's daily-drip attempt did (CAN-4633). APPEND-ONLY /
   * optional: older servers omit it, and so do reads with no user wallet.
   */
  dailyDripOutcome?: DailyDripGrantOutcome;
  /** Credits the drip minted during this read; only with `granted`. */
  dailyDripGrantedCredits?: number;
  /** Resolved account email the balance belongs to. */
  email: string;
  /** Remaining balance, expressed in credits (not USD). */
  credits: number;
  /**
   * The plan's daily free-credit allowance, shown even when the user has not
   * opted in (it is what turning the drip on gets them). Older servers omit it;
   * do not infer usage without it.
   */
  dailyDripCapCredits?: number;
  /**
   * Whether the user opted in to the daily free-credit drip. APPEND-ONLY /
   * optional on the wire: older servers omit it, and `undefined` means
   * "unknown, keep current behavior". Only an explicit `false` hides
   * free-allowance readouts and offers "Turn on". The server also omits it
   * when the plan allowance is 0 or unknown (CAN-4762).
   */
  dailyDripEnabled?: boolean;
  /**
   * Whether an eligible organization pool is available, including when personal
   * credits remain. Omitted if unchecked or unavailable. A free-allowance
   * warning requires an explicit false; missing must never mean unfunded.
   */
  orgFundingAvailable?: boolean;
  /** True iff the user's personal wallet has credits remaining. */
  eligible: boolean;
  /** Which ledger this balance is reported against. */
  source: AiCreditsSource;
  /**
   * APPEND-ONLY / optional on the wire: older servers omit it, so consumers MUST
   * default a missing value to null.
   *
   * The org credit pool the gateway would debit once this user's personal
   * balance is exhausted. The balance route resolves this only when
   * `credits <= 0`; null can also mean unchecked while personal credits remain.
   * Use `orgFundingAvailable` to classify a low positive balance for disclosure.
   */
  orgPool?: AiCreditsOrgPoolFunding | null;
}

/**
 * Whether an organization currently has spendable AI-credit headroom that a
 * member could draw on right now. Mirrors the LLM-proxy org-pool spend gate
 * (`resolveScopedOrgPool`) so the desktop usage-exhausted CTA can classify an
 * org-covered member into "switch-and-resume" vs. "contact your org admin".
 */
export interface OrgAiCreditsSpendable {
  /**
   * True when the org can spend right now. Mirrors the LLM-proxy gateway spend
   * gate exactly (`org_credit_pool` capability AND a positive pool balance now),
   * so it equals `hasBalanceNow`. Deliberately excludes `canReplenish`: the
   * gateway never funds an empty pool synchronously, so treating a replenishable
   * empty pool as spendable would route a run the gateway then rejects.
   */
  hasSpendableHeadroom: boolean;
  /** Org has the `org_credit_pool` capability AND a positive pool balance now. */
  hasBalanceNow: boolean;
  /**
   * Informational only (NOT part of `hasSpendableHeadroom`): armed auto-top-up
   * could fund the pool for a future request (capable + enabled + a configured
   * positive amount + payment method + within the monthly cap).
   */
  canReplenish: boolean;
  /** Org carries the `org_credit_pool` capability (business plan / trial). */
  orgCreditPoolCapable: boolean;
  /** Current org pool balance in credits. OWNER/ADMIN only; omitted for MEMBER. */
  balanceCredits?: number;
  /** Current org pool balance in USD. OWNER/ADMIN only; omitted for MEMBER. */
  balanceUsd?: number;
  /** A default payment method is on file for the org billing account. */
  hasPaymentMethodOnFile: boolean;
  /** The org has an active trial or subscription. */
  billingActive: boolean;
}

/** Active subscription summary for an account. */
export interface AiCreditsSubscription {
  /** Resolved account email the subscription belongs to. */
  email: string;
  /** True when the user has an active paid subscription. */
  active: boolean;
  /** Plan/tier label, when present (e.g. 'Pro'). */
  plan?: string;
  /** Subscription status string from ECW (e.g. 'active', 'canceled'). */
  status?: string;
  /** ISO-8601 renewal or expiry date, when present. */
  renewsAt?: string;
  /** Which ledger this subscription is reported against. */
  source: AiCreditsSource;
  /**
   * Account scope this summary reflects: `'business'` when the resolved account
   * owns an ECW-bootstrapped Business org (the org is the payer, so this is the
   * org's summary), else `'individual'`. Lets a client tell a business trial
   * (org created) apart from an individual trial (no org) and present the right
   * subscription options — the `plan`/`status` fields alone cannot, since every
   * trial resolves to the Business plan. APPEND-ONLY / optional on the wire:
   * older servers omit it, so consumers MUST default a missing value to
   * `'individual'`.
   */
  scope?: 'individual' | 'business';
  /**
   * Free-trial window for this account, when recorded, else omitted. `active` is
   * `false` once the trial has ended. Distinct from the top-level `active`/
   * `status`, which describe a live SUBSCRIPTION — a trialing account with no
   * subscription row reports `active: false` yet still carries a `trial`.
   * APPEND-ONLY / optional on the wire: older servers omit it.
   */
  trial?: { active: boolean; endsAt: string };
}

/**
 * A single AI-credit ledger entry — the CUSTOMER-FACING contract.
 *
 * The privileged audit fields are declared here as `?: never` on purpose
 * (CAN-2300). Without them this interface is an open structural supertype of
 * {@link AiCreditsAdminLedgerEntry}, so a customer route declared
 * `Promise<AiCreditsLedgerPage>` could `return getAdminLedgerPage()` with no
 * type error (return-position assignment skips excess-property checking) and
 * serialize `internalReason` straight to the customer. Pinning them to `never`
 * turns that swap into a COMPILE error rather than a silent PII leak.
 */
export interface AiCreditsLedgerEntry {
  /** Stable ledger entry id. */
  id: string;
  /** ISO-8601 timestamp of the entry. */
  createdAt: string;
  /** Signed credit delta (negative = debit, positive = credit/top-up). */
  credits: number;
  /** Source/category of the entry (e.g. 'canopy'). */
  source?: string;
  /** Human-readable description, when present. */
  description?: string;
  /** Privileged-only; present only on {@link AiCreditsAdminLedgerEntry}. */
  internalReason?: never;
  /** Privileged-only; present only on {@link AiCreditsAdminLedgerEntry}. */
  transactionType?: never;
  /** Privileged-only; present only on {@link AiCreditsAdminLedgerEntry}. */
  grantedByAdminId?: never;
}

/** One page of AI-credit ledger entries. */
export interface AiCreditsLedgerPage {
  /** Resolved UD account email the ledger belongs to. */
  email: string;
  entries: AiCreditsLedgerEntry[];
  /** Opaque cursor for the next page, when more entries exist. */
  nextCursor?: string;
}

/**
 * A privileged (staff-only) view of a ledger entry: the same customer-safe
 * fields as {@link AiCreditsLedgerEntry} plus the raw audit fields (CAN-2300).
 *
 * `description` on the base entry is a SAFE DISPLAY STRING and must never be
 * treated as an audit record — admin free text is deliberately suppressed
 * there. `internalReason` is the unmodified `reason` column and is the field a
 * staff surface should render. Consumers must not show `internalReason` to end
 * customers.
 *
 * Declared over `Omit<AiCreditsLedgerEntry, …>` rather than `extends
 * AiCreditsLedgerEntry`: the base pins these three fields to `never` so the
 * admin shape can never be passed off as the customer shape (see the note on
 * {@link AiCreditsLedgerEntry}). The safe display fields are still inherited
 * from one definition, so the two projections cannot drift.
 */
export interface AiCreditsAdminLedgerEntry extends Omit<
  AiCreditsLedgerEntry,
  'internalReason' | 'transactionType' | 'grantedByAdminId'
> {
  /** Raw, unsanitized `reason` column — audit record, staff surfaces only. */
  internalReason: string;
  /** Ledger transaction type (`GRANT`, `USAGE`, `REFUND_CLAWBACK`, …). */
  transactionType: string;
  /**
   * Admin principal id recorded on an admin adjustment, else `null`. `0` is the
   * synthetic external-billing principal (an ECW-originated grant), NOT an
   * absent value — test against `null`, never truthiness.
   */
  grantedByAdminId: number | null;
}

/** One page of privileged AI-credit ledger entries (CAN-2300). */
export interface AiCreditsAdminLedgerPage {
  /** Resolved account email the ledger belongs to. */
  email: string;
  entries: AiCreditsAdminLedgerEntry[];
  /** Opaque cursor for the next page, when more entries exist. */
  nextCursor?: string;
}

/** A single AI-credit account row from the ECW admin listing endpoint. */
export interface AiCreditsAccount {
  /** Verified account email (the only owner key the external boundary exposes). */
  email: string;
  /** Current spendable AI-credit balance on the ECW ledger. */
  balanceCredits: number;
}

/** One page of AI-credit accounts (ECW `/admin/ai-credits/accounts` listing). */
export interface AiCreditsAccountsPage {
  accounts: AiCreditsAccount[];
  /** Numeric cursor for the next page, or `null` when the listing is drained. */
  nextCursor: number | null;
}
