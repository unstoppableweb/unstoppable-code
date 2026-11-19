// Pure structural detection of provider usage/rate-limit frames.
//
// Moved here from `apps/desktop-app/src/main/agents/ai-credits-quota-state.ts`
// (which re-exports them) so the browser-safe portal projection can suppress
// these frames without a second hand-maintained copy of the
// `assistant+error | result+429 | codex rate_limit` rule — the same
// one-place-only principle as `isNoBillingSourceFailureEvent` (CAN-2413).
// The desktop renders these frames as the composer usage-limit banner, never
// as transcript rows; the portal mirrors that via
// `RemoteControlChatSummaryEntity.usageLimit` (CAN-2601). That includes the synthetic
// `codex_error` result codex-session emits after a usage-limit failure, which
// the transcript reducer also keeps banner-only (CAN-4564). Keep these rules in
// sync with the Codex handlers in `@canopy/agent-transcript`'s parser.

import { isAiCreditsFailureEventShape } from '../lib/transcript-parser';
import {
  isClaudeAuthenticationFailureMessage,
  readClaudeApiErrorStatus,
} from '../lib/provider-errors';
import {
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG,
  AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
  AI_CREDITS_PROXY_ERROR_MARKER,
  parseCanopyProxyError,
  type CanopyProxyError,
} from '@canopy/protocol';
import { normalizeEpochMs } from '../lib/epoch-ms';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasCodexUsageLimitInfo(value: unknown): boolean {
  return (
    value === 'usageLimitExceeded' ||
    (isRecord(value) &&
      Object.prototype.hasOwnProperty.call(value, 'usageLimitExceeded'))
  );
}

function findNumericReset(value: unknown, depth = 0): number | undefined {
  if (depth > 5 || value === null || typeof value !== 'object') {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNumericReset(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const record = value;
  if (typeof record.resetsAt === 'number' && Number.isFinite(record.resetsAt)) {
    return record.resetsAt;
  }
  for (const entry of Object.values(record)) {
    const found = findNumericReset(entry, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Detect a Claude usage-limit signal on a raw emitted SDK event. Mirrors the
 * renderer detection in `transcript-parser.ts` (the structured `assistant`
 * `error: 'rate_limit'` union and the `result` `is_error` + `api_error_status
 * === 429` shape) — keep the two in sync. These events carry no reset time;
 * Claude reports it on a separate `rate_limit_event`, read by
 * {@link readClaudeQuotaResetsAt}.
 *
 * Only a genuine upstream `429` (or Claude's own `error: 'rate_limit'`
 * classification) counts as a usage limit. Canopy's llm-proxy deliberately does
 * NOT emit `429` for its own transient per-account concurrency guard — it uses
 * the distinct, retryable status from `AI_CREDITS_CONCURRENCY_GUARD` (503,
 * defined in `@canopy/protocol`) precisely so a "request already in progress"
 * collision is never misclassified
 * here as a provider usage limit and does not trip the on-quota fallback
 * (CAN-838). The SDK only surfaces the HTTP status to us, so the status is the
 * discriminator: keep this keyed on `429` and never widen it to other statuses.
 * An explicitly recognized authentication message still wins over 429 so an
 * expired OAuth session never trips quota routing or the usage banner.
 */
export function detectClaudeQuotaReached(event: unknown): boolean {
  if (!isRecord(event)) return false;
  return (
    (event.type === 'assistant' && event.error === 'rate_limit') ||
    (event.type === 'result' &&
      event.is_error === true &&
      event.api_error_status === 429 &&
      !isClaudeAuthenticationFailureMessage(event.result))
  );
}

/**
 * Reset time (ms since epoch) from a Claude SDK `rate_limit_event` whose
 * limit was rejected. Warnings, missing reset times and malformed payloads
 * return `undefined`. The SDK reports epoch seconds; milliseconds also work.
 */
export function readClaudeQuotaResetsAt(event: unknown): number | undefined {
  if (!isRecord(event) || event.type !== 'rate_limit_event') return undefined;
  const info = event.rate_limit_info;
  if (!isRecord(info) || info.status !== 'rejected') return undefined;
  return typeof info.resetsAt === 'number'
    ? normalizeEpochMs(info.resetsAt)
    : undefined;
}

/**
 * Detect a Codex usage-limit signal on a raw emitted event
 * (`{ type: 'codex', event: {...} }`). Covers the proactive
 * `rate_limit.reached` snapshot plus the reactive `turn.failed` / `error`
 * `usageLimitExceeded` paths, mirroring `transcript-parser.ts` — keep in sync.
 * Returns the first reset time the event carries, normalized to ms.
 */
export function detectCodexQuotaReached(event: unknown): {
  reached: boolean;
  resetsAt?: number;
} {
  if (!isRecord(event) || event.type !== 'codex' || !isRecord(event.event)) {
    return { reached: false };
  }
  const providerEvent = event.event;
  const reached =
    providerEvent.type === 'rate_limit.reached' ||
    ((providerEvent.type === 'turn.failed' || providerEvent.type === 'error') &&
      (hasCodexUsageLimitInfo(providerEvent.codexErrorInfo) ||
        (isRecord(providerEvent.error) &&
          hasCodexUsageLimitInfo(providerEvent.error.codexErrorInfo))));
  if (!reached) return { reached: false };
  const rawResetsAt = findNumericReset(providerEvent);
  const resetsAt =
    rawResetsAt === undefined ? undefined : normalizeEpochMs(rawResetsAt);
  return {
    reached: true,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/**
 * codex-session's synthetic terminal `result` for a usage-limit turn failure.
 * Deliberately not part of {@link detectCodexQuotaReached}: the native
 * `turn.failed` / `error` frame already drove routing and usage-limit
 * recording, so matching the result there would record the failure twice.
 * Dropping it is safe because the result only carries `codexErrorInfo` after
 * the app-server client has emitted that native frame, so the Portal banner
 * state never depends on this result.
 */
function isCodexUsageLimitResultFrame(event: unknown): boolean {
  return (
    isRecord(event) &&
    event.type === 'result' &&
    event.is_error === true &&
    event.subtype === 'codex_error' &&
    hasCodexUsageLimitInfo(event.codexErrorInfo)
  );
}

/**
 * True when a raw provider frame is a usage/rate-limit signal for either
 * provider — the portal projection's "this is banner state, not a transcript
 * message" discriminator.
 */
export function isProviderUsageLimitFrame(event: unknown): boolean {
  return (
    detectClaudeQuotaReached(event) ||
    detectCodexQuotaReached(event).reached ||
    isCodexUsageLimitResultFrame(event)
  );
}

/** Surviving markers, stamps and explicit classifications block inference, even malformed bodies. */
export function hasClaudeProxyFailureEvidence(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string')
    return value.includes(AI_CREDITS_PROXY_ERROR_MARKER);
  if (Array.isArray(value))
    return value.some((entry) =>
      hasClaudeProxyFailureEvidence(entry, depth + 1),
    );
  if (!isRecord(value)) return false;
  if (
    value[AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG] === true ||
    'canopy_proxy' in value
  )
    return true;
  if (
    depth === 0 &&
    (value.code !== undefined ||
      value.error_code !== undefined ||
      (isRecord(value.error) && value.error.code !== undefined) ||
      (typeof value.error === 'string' &&
        [
          'authentication_failed',
          'rate_limit',
          'server_error',
          'overloaded_error',
          'oauth_organization_forbidden',
          // Current SDKAssistantMessageError alternatives to billing_error
          // and unknown remain authoritative even if result text conflicts.
          'oauth_org_not_allowed',
          'account_on_hold',
          'verification_required',
          'overloaded',
          'invalid_request',
          'model_not_found',
          'max_output_tokens',
          'cloud_credential_error',
        ].includes(value.error)))
  )
    return true;
  return Object.values(value).some((entry) =>
    hasClaudeProxyFailureEvidence(entry, depth + 1),
  );
}

function claudeHostedErrorMessage(event: UnknownRecord): string | undefined {
  // Result wins, just as in claudeResultErrorMessage. errors[] alone deliberately
  // cannot establish this refusal. Structured/direct messages precede SDK enums.
  if (typeof event.result === 'string' && event.result.trim())
    return event.result;
  if (
    isRecord(event.error) &&
    typeof event.error.message === 'string' &&
    event.error.message.trim()
  )
    return event.error.message;
  if (typeof event.message === 'string' && event.message.trim())
    return event.message;
  if (isRecord(event.message) && Array.isArray(event.message.content)) {
    const text = event.message.content
      .filter(isRecord)
      .filter(
        (block) => block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('\n');
    if (text.trim()) return text;
  }
  return typeof event.error === 'string' ? event.error : undefined;
}

/**
 * Claude refusal detection, including SDK frames whose HTTP body was stripped.
 * Main must gate on the hosted route actually used; status cannot prove it.
 */
export function detectClaudeHostedNoBillingSource(
  event: unknown,
): CanopyProxyError | null {
  if (!isRecord(event) || !isAiCreditsFailureEventShape(event, 'claude'))
    return null;
  const message = claudeHostedErrorMessage(event)?.trim();
  const renderedStatus = /^API Error: (\d{3})\b/.exec(message ?? '');
  const status =
    'api_error_status' in event
      ? readClaudeApiErrorStatus(event)
      : renderedStatus
        ? Number(renderedStatus[1])
        : undefined;
  const parsed = message ? parseCanopyProxyError(message) : null;
  // A surviving explicit code wins, including unknown codes' generic fallback.
  // When only the marker survives, the trusted HTTP status restores recovery.
  if (
    parsed &&
    (parsed.code !== 'proxy_internal_error' || /"code"\s*:/.test(message ?? ''))
  )
    return parsed;
  if (status === 401 || status === 503) {
    return {
      code: status === 401 ? 'credentials_unavailable' : 'upstream_unavailable',
      message: null,
      correlationId: parsed?.correlationId ?? null,
    };
  }
  if (parsed) return parsed;
  if (hasClaudeProxyFailureEvidence(event)) return null;
  const prefixedMessage = `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`;
  if (
    message !== AI_CREDITS_NO_BILLING_SOURCE_MESSAGE &&
    message !== prefixedMessage
  )
    return null;
  // The harness never puts `api_error_status` on its synthetic assistant error
  // frame, only on the terminal result. That frame is persisted and rendered
  // too, so it must be normalized with the result; its exact rendered prefix is
  // the same text-derived status fallback `readClaudeApiErrorStatus` applies to
  // `result`, and a present status field still takes precedence.
  const billingStatus =
    event.type === 'assistant' && !('api_error_status' in event)
      ? message === prefixedMessage
        ? 402
        : undefined
      : readClaudeApiErrorStatus(event);
  if (billingStatus !== 402) return null;
  // A structured status must not override a conflicting rendered status.
  if (typeof event.result === 'string') {
    const renderedStatus = /^API Error: (\d{3})\b/.exec(event.result.trim());
    if (renderedStatus && renderedStatus[1] !== '402') return null;
  }
  return {
    code: 'no_billing_source',
    message: AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
    correlationId: null,
  };
}
