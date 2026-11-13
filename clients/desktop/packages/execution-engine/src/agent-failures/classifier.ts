import { redactSecrets } from '../lib/redaction';
import { AI_CREDITS_PROXY_ERROR_MARKER } from '@canopy/protocol';
import { isClaudeAuthenticationFailureMessage } from '@canopy/agent-transcript';
import type {
  AgentFailureClassification,
  AgentFailureClassificationContext,
} from '../types/agent-failures';

type RecordValue = Record<string, unknown>;

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CAPACITY_MESSAGE =
  'Selected model is at capacity. Please try a different model.';
const CAPACITY_WRAPPERS = ['', 'Error: ', 'Codex query failed: '];
const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504, 529]);
const CODEX_UNEXPECTED_STATUS_PATTERN = /\bunexpected status (\d{3})\b/;
const CANOPY_PROXY_MARKER = AI_CREDITS_PROXY_ERROR_MARKER;
const CANOPY_PROXY_CODE_PATTERN = /"code"\s*:\s*"([a-z_]+)"/;
const CONNECTION_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const CODEX_CONNECTION_VARIANTS = [
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
] as const;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordsFrom(values: readonly unknown[]): RecordValue[] {
  const records: RecordValue[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || records.length >= 500 || !isRecord(value)) {
      return;
    }
    records.push(value);
    for (const nested of Object.values(value)) {
      if (Array.isArray(nested)) {
        for (const entry of nested) {
          visit(entry, depth + 1);
        }
      } else {
        visit(nested, depth + 1);
      }
    }
  };
  for (const value of values) {
    visit(value, 0);
  }
  return records;
}

function stringsFrom(values: readonly unknown[]): string[] {
  const strings: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || strings.length >= 500) return;
    if (typeof value === 'string') {
      strings.push(value);
      return;
    }
    if (value instanceof Error) {
      strings.push(value.message);
      if ('cause' in value) {
        visit(value.cause, depth + 1);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const entry of Object.values(value)) visit(entry, depth + 1);
    }
  };
  for (const value of values) visit(value, 0);
  return strings;
}

function readHttpStatus(record: RecordValue): number | undefined {
  for (const key of [
    'status',
    'statusCode',
    'status_code',
    'httpStatus',
    'httpStatusCode',
    'api_error_status',
  ]) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value)) {
      return value;
    }
  }
  return undefined;
}

function providerHttpStatuses(
  context: AgentFailureClassificationContext,
): number[] {
  // Terminal-first is ABSOLUTE, not "the terminal status is also in the list".
  // Callers consume this with `.includes()` in a fixed priority order
  // (401 -> 429 -> 5xx), so a buffered status merely sitting alongside the
  // terminal one still wins whenever it ranks higher. A turn can record a
  // failure it then RECOVERED from, and that value must never speak for the
  // failure that actually ended the turn — in either direction:
  //
  //   - buffered 429 + terminal 503 would classify as a usage limit, hiding a
  //     genuine transient failure and suppressing auto-retry;
  //   - buffered 502 + terminal 429 would classify as transient, dropping the
  //     usage-limit banner and `resets_at` and driving billed, non-idempotent
  //     work straight back into the rate limit.
  //
  // So: collect the terminal error's statuses and the buffered ones into
  // SEPARATE lists, and return the buffered list only when the terminal error
  // yields nothing at all — which is exactly the case where a buffered
  // `turn.failed` / `result` event IS the terminal signal.
  const collect = (target: number[], value: unknown): void => {
    if (!isRecord(value)) return;
    const status = readHttpStatus(value);
    if (status !== undefined) target.push(status);
  };

  const terminalStatuses: number[] = [];
  const bufferedStatuses: number[] = [];

  // The terminal error must be read with the SAME shape handling the buffered
  // loop below uses: unwrap the `{type:'codex', event:{...}}` envelope and
  // descend into the nested `.error` record. The terminal error is very often
  // literally `events[events.length - 1]` (see `transient-error-retry-service`),
  // so reading only its top level would miss a structured nested status,
  // leave `terminalStatuses` empty, and hand the decision back to the buffered
  // pass — reinstating the stale-signal precedence this whole split removes.
  const collectFailureStatuses = (target: number[], value: unknown): void => {
    if (!isRecord(value)) return;
    const inner =
      value.type === 'codex' && isRecord(value.event) ? value.event : value;
    collect(target, inner);
    collect(target, inner.error);
  };

  collectFailureStatuses(terminalStatuses, context.error);
  for (const event of context.events ?? []) {
    if (!isRecord(event)) continue;
    if (
      context.provider === 'claude' &&
      (event.type === 'assistant' || event.type === 'result')
    ) {
      collect(bufferedStatuses, event);
      continue;
    }
    if (context.provider !== 'codex') continue;
    const providerEvent =
      event.type === 'codex' && isRecord(event.event) ? event.event : event;
    if (providerEvent.type !== 'turn.failed' && providerEvent.type !== 'error')
      continue;
    collect(bufferedStatuses, providerEvent);
    collect(bufferedStatuses, providerEvent.error);
  }

  if (context.provider === 'codex') {
    const findStatus = (values: readonly unknown[]): string | undefined =>
      stringsFrom(values)
        .map((message) => CODEX_UNEXPECTED_STATUS_PATTERN.exec(message)?.[1])
        .find((value): value is string => value !== undefined);
    // Codex reports most failures as `unexpected status NNN: <body>` text
    // rather than a numeric field, so the message parse is the primary source
    // for this provider. It is applied to each side independently so the
    // terminal-vs-buffered split above still holds.
    if (terminalStatuses.length === 0) {
      const terminalMessageStatus = findStatus([context.error]);
      if (terminalMessageStatus !== undefined) {
        terminalStatuses.push(Number(terminalMessageStatus));
      }
    }
    if (bufferedStatuses.length === 0) {
      const bufferedMessageStatus = findStatus(context.events ?? []);
      if (bufferedMessageStatus !== undefined) {
        bufferedStatuses.push(Number(bufferedMessageStatus));
      }
    }
  }

  return terminalStatuses.length > 0 ? terminalStatuses : bufferedStatuses;
}

/**
 * Provider-agnostic (CAN-2413 review round 2). Both harnesses may strip response
 * details; main restores Codex proxy evidence and narrowly qualifying Claude
 * refusals before classification. Bare 402 text still cannot supply a proxy
 * code here; live marked responses and stored transcripts remain supported.
 *
 * This was previously gated to `codex`, which meant a Claude turn routed
 * through AI Credits could receive the identical hosted marked 402 and never
 * reach `credits_depleted`. The renderer surfaces did not care — the banner and
 * the transcript notice both read the marker directly — but pipeline and
 * `builtin/agent-prompt` recoverable-pause handling key off the CLASSIFICATION,
 * so a Claude credit exhaustion failed as an ordinary error instead of pausing
 * recoverably. The hosted route emits the marker for both providers, so the
 * gate was describing the old world.
 *
 * Widening is safe because of WHERE this is consumed: the caller runs the
 * `canopyProxyFailureCode` branches only AFTER the authentication and
 * usage-limit branches, so a real Claude auth failure or 429 still wins, and
 * the `CANOPY_AI_CREDITS_PROXY` marker is specific enough that no ordinary
 * provider error text matches it.
 *
 * ONE PRE-EXISTING CLAUDE SHAPE DOES CHANGE, deliberately. Claude AI-Credits
 * turns point `ANTHROPIC_BASE_URL` straight at the hosted proxy route (the
 * local loopback proxy is Codex-only), so a hosted 502 carrying
 * `proxy_internal_error` is reachable for Claude. It now hits the `SUPPRESS`
 * branch instead of falling through to `TRANSIENT_HTTP_STATUSES` → `http_5xx`,
 * which means it is no longer eligible for `transient-error-retry-service`
 * auto-retry. That is the intended outcome: `proxy_internal_error` is an
 * AMBIGUOUS-delivery failure, so the turn may already have been billed, and
 * silently re-dispatching it would double-charge. `upstream_unavailable` — the
 * majority recoverable 502 — still maps to `provider_temporarily_unavailable`
 * and still auto-retries, so ordinary transient recovery is unaffected.
 * Both halves are pinned by tests below.
 */
function readCanopyProxyFailureCode(
  strings: readonly string[],
): string | undefined {
  const marked = strings.find((message) =>
    message.includes(CANOPY_PROXY_MARKER),
  );
  return marked?.match(CANOPY_PROXY_CODE_PATTERN)?.[1];
}

function readCodexErrorInfo(record: RecordValue): unknown {
  return record.codexErrorInfo;
}

function hasVariant(value: unknown, variant: string): boolean {
  return (
    value === variant ||
    (isRecord(value) && Object.prototype.hasOwnProperty.call(value, variant))
  );
}

function variantStatus(value: unknown, variant: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const payload = value[variant];
  return isRecord(payload) ? readHttpStatus(payload) : undefined;
}

function readResetValue(records: readonly RecordValue[]): string | undefined {
  for (const record of records) {
    for (const key of [
      'resets_at',
      'resetsAt',
      'reset_at',
      'resetAt',
      'reset_time',
      'resetTime',
    ]) {
      const value = record[key];
      if (typeof value === 'string') {
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp))
          return new Date(timestamp).toISOString();
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        const millis = value < 10_000_000_000 ? value * 1000 : value;
        const date = new Date(millis);
        if (Number.isFinite(date.getTime())) return date.toISOString();
      }
    }
  }
  return undefined;
}

function diagnosticMessage(values: readonly unknown[]): string {
  const records = recordsFrom(values);
  const message =
    records
      .flatMap((record) => [record.message, record.error_message])
      .find(
        (value): value is string =>
          typeof value === 'string' && Boolean(value.trim()),
      ) ??
    values.find((value): value is Error => value instanceof Error)?.message ??
    stringsFrom(values)
      .map((value) => value.trim())
      .find(Boolean) ??
    'Agent provider request failed';
  return redactSecrets(message.replace(ANSI_PATTERN, '').trim()).slice(0, 2000);
}

function result(
  context: AgentFailureClassificationContext,
  kind: AgentFailureClassification['kind'],
  code: AgentFailureClassification['code'],
  diagnostic: string,
  resetsAt?: string,
): AgentFailureClassification {
  return {
    kind,
    code,
    provider: context.provider,
    account_scope: context.accountScope,
    ...(context.model ? { model: context.model } : {}),
    ...(resetsAt ? { resets_at: resetsAt } : {}),
    diagnostic_message: diagnostic,
  };
}

/**
 * The signals the branch chain decides from, collected from ONE source — either
 * the terminal error or the buffered events, never both at once.
 */
interface ClassificationSignals {
  records: RecordValue[];
  topLevelRecords: RecordValue[];
  strings: string[];
  /**
   * Terminal-error strings only. Empty in the buffered pass, because the
   * branches that read it are deliberately scoped to the failure that ended the
   * turn and must not match text buffered earlier.
   */
  errorStrings: string[];
  statuses: number[];
  canopyProxyFailureCode: string | undefined;
}

/**
 * "Recognized, and deliberately NOT a classification."
 *
 * Distinct from `null`, which means "nothing here was recognized at all". The
 * difference is load-bearing: a terminal `invalid_request` /
 * `proxy_internal_error` must stop classification outright rather than fall
 * through to the buffered pass, or a stale buffered signal would classify a
 * failure the terminal error already told us to leave alone.
 */
const SUPPRESS = 'suppress';
type ClassificationOutcome =
  | AgentFailureClassification
  | typeof SUPPRESS
  | null;

function buildSignals(
  context: AgentFailureClassificationContext,
  values: readonly unknown[],
  statuses: number[],
  isTerminal: boolean,
): ClassificationSignals {
  const strings = stringsFrom(values).map((value) => value.trim());
  return {
    records: recordsFrom(values),
    topLevelRecords: values.filter(isRecord),
    strings,
    errorStrings: isTerminal ? strings : [],
    statuses,
    canopyProxyFailureCode: readCanopyProxyFailureCode(strings),
  };
}

export function classifyAgentFailure(
  context: AgentFailureClassificationContext,
): AgentFailureClassification | null {
  if (context.provider === 'ollama') return null;

  const values = [...(context.events ?? []), context.error].filter(
    (value) => value !== undefined,
  );
  // Detail, not decision. The human-readable message and `resets_at` are drawn
  // from the WHOLE turn, so a terminal error that carries the signal but not the
  // detail — a 429 whose `resets_at` arrived on an earlier event — still renders
  // fully. Only the DECISION is terminal-first.
  const diagnostic = diagnosticMessage(values);
  const resetsAt = readResetValue(recordsFrom(values));

  // Terminal-first, applied to EVERY signal rather than only to statuses and
  // proxy codes. A turn can record a failure it then RECOVERED from — a
  // buffered `usageLimitExceeded`, `serverOverloaded`, `overloaded_error`, a
  // stale status, a stale proxy code — and none of those may speak for the
  // failure that actually ended the turn. Getting this wrong is not cosmetic:
  // it either hides a genuine transient failure behind a stale usage limit
  // (dropping the banner and auto-retry), or makes a terminal permanent failure
  // look transient and drives billed, non-idempotent work straight back into
  // the wall that just rejected it.
  //
  // The buffered pass runs only when the terminal error contained nothing
  // recognizable — which is exactly the case where a buffered `turn.failed` /
  // `error` / `result` event IS the terminal signal, or where there is no
  // terminal error object at all.
  const terminalSignals = buildSignals(
    context,
    context.error === undefined ? [] : [context.error],
    providerHttpStatuses({ ...context, events: [] }),
    true,
  );
  const terminalOutcome = classifySignals(
    context,
    terminalSignals,
    diagnostic,
    resetsAt,
  );
  if (terminalOutcome === SUPPRESS) return null;
  if (terminalOutcome !== null) return terminalOutcome;

  // The terminal error produced no classification, but if it carried a
  // definitive signal — an HTTP status or a proxy failure code — then why the
  // turn ended is already accounted for, and a buffered signal must not
  // override it. Without this, a terminal permanent failure (say a 400) would
  // fall through to a buffered `serverOverloaded` and be classified transient,
  // which is precisely how billed, non-idempotent work gets auto-retried into a
  // wall that already refused it.
  if (isDefinitiveTerminalSignal(terminalSignals)) {
    return null;
  }

  const bufferedOutcome = classifySignals(
    context,
    buildSignals(
      context,
      context.events ?? [],
      providerHttpStatuses({ ...context, error: undefined }),
      false,
    ),
    diagnostic,
    resetsAt,
  );
  return bufferedOutcome === SUPPRESS ? null : bufferedOutcome;
}

function isDefinitiveTerminalSignal(signals: ClassificationSignals): boolean {
  return (
    signals.statuses.length > 0 || signals.canopyProxyFailureCode !== undefined
  );
}

/**
 * Whether the error that ended a turn carries a definitive signal: an HTTP
 * status or an AI Credits proxy code. {@link classifyAgentFailure} never lets
 * buffered events explain such a failure, even when it leaves the failure
 * unclassified, and callers with a fallback of their own must follow the same
 * rule.
 */
export function hasDefinitiveTerminalFailureSignal(
  context: Pick<AgentFailureClassificationContext, 'provider' | 'error'>,
): boolean {
  if (context.provider === 'ollama' || context.error === undefined) {
    return false;
  }
  const terminalContext: AgentFailureClassificationContext = {
    provider: context.provider,
    accountScope: 'native',
    events: [],
    error: context.error,
  };
  return isDefinitiveTerminalSignal(
    buildSignals(
      terminalContext,
      [context.error],
      providerHttpStatuses(terminalContext),
      true,
    ),
  );
}

function classifySignals(
  context: AgentFailureClassificationContext,
  signals: ClassificationSignals,
  diagnostic: string,
  resetsAt: string | undefined,
): ClassificationOutcome {
  const {
    records,
    topLevelRecords,
    strings,
    errorStrings,
    statuses,
    canopyProxyFailureCode,
  } = signals;

  // Authentication has highest precedence.
  if (
    context.provider === 'claude' &&
    records.some(
      (record) =>
        record.type === 'assistant' && record.error === 'authentication_failed',
    )
  ) {
    return result(
      context,
      'provider_authentication_required',
      'authentication_failed',
      diagnostic,
    );
  }
  if (
    context.provider === 'codex' &&
    records.some((record) =>
      hasVariant(readCodexErrorInfo(record), 'unauthorized'),
    )
  ) {
    return result(
      context,
      'provider_authentication_required',
      'unauthorized',
      diagnostic,
    );
  }
  if (
    context.provider === 'claude' &&
    records.some(
      (record) =>
        record.code === 'oauth_organization_forbidden' ||
        record.error === 'oauth_organization_forbidden',
    )
  ) {
    return result(
      context,
      'provider_authentication_required',
      'oauth_organization_forbidden',
      diagnostic,
    );
  }
  if (statuses.includes(401)) {
    return result(
      context,
      'provider_authentication_required',
      'http_401',
      diagnostic,
    );
  }
  if (
    context.provider === 'claude' &&
    strings.some(isClaudeAuthenticationFailureMessage)
  ) {
    return result(
      context,
      'provider_authentication_required',
      'authentication_failed',
      diagnostic,
    );
  }

  // Native provider usage limits are distinct from general transient errors.
  if (
    context.provider === 'claude' &&
    records.some(
      (record) => record.type === 'assistant' && record.error === 'rate_limit',
    )
  ) {
    return result(
      context,
      'provider_usage_limit',
      'rate_limit',
      diagnostic,
      resetsAt,
    );
  }
  if (
    context.provider === 'claude' &&
    records.some(
      (record) =>
        record.type === 'result' &&
        record.is_error === true &&
        record.api_error_status === 429,
    )
  ) {
    return result(
      context,
      'provider_usage_limit',
      'http_429',
      diagnostic,
      resetsAt,
    );
  }
  if (
    context.provider === 'codex' &&
    records.some((record) => record.type === 'rate_limit.reached')
  ) {
    return result(
      context,
      'provider_usage_limit',
      'rate_limit',
      diagnostic,
      resetsAt,
    );
  }
  if (
    context.provider === 'codex' &&
    records.some((record) =>
      hasVariant(readCodexErrorInfo(record), 'usageLimitExceeded'),
    )
  ) {
    return result(
      context,
      'provider_usage_limit',
      'usage_limit_exceeded',
      diagnostic,
      resetsAt,
    );
  }
  if (
    context.provider === 'codex' &&
    records.some((record) => {
      const type = record.reachedType ?? record.rateLimitReachedType;
      return (
        type === 'workspace_owner_credits_depleted' ||
        type === 'workspace_member_credits_depleted'
      );
    })
  ) {
    return result(
      context,
      'provider_usage_limit',
      'credits_depleted',
      diagnostic,
      resetsAt,
    );
  }
  if (
    context.provider === 'codex' &&
    records.some((record) => {
      const type = record.reachedType ?? record.rateLimitReachedType;
      return (
        type === 'workspace_owner_usage_limit_reached' ||
        type === 'workspace_member_usage_limit_reached'
      );
    })
  ) {
    return result(
      context,
      'provider_usage_limit',
      'usage_limit_exceeded',
      diagnostic,
      resetsAt,
    );
  }
  if (statuses.includes(429)) {
    return result(
      context,
      'provider_usage_limit',
      'http_429',
      diagnostic,
      resetsAt,
    );
  }

  // Canopy AI Credits proxy failures are classified AFTER the authentication
  // and usage-limit branches. The marker is matched against every buffered
  // string in the turn, so a proxy failure recorded earlier in a turn that
  // ultimately died on a real 429 / usageLimitExceeded must not shadow the
  // genuine limit — that would drop the usage-limit banner and `resets_at`,
  // and make the turn eligible for transient auto-retry straight back into the
  // rate limit. It still precedes the generic capacity/5xx/connection branches
  // below, which is what the structured code is here to disambiguate.
  if (canopyProxyFailureCode === 'credentials_unavailable') {
    return result(
      context,
      'provider_authentication_required',
      'http_401',
      diagnostic,
    );
  }
  if (canopyProxyFailureCode === 'upstream_unavailable') {
    return result(
      context,
      'provider_temporarily_unavailable',
      'connection_failed',
      diagnostic,
    );
  }
  if (canopyProxyFailureCode === 'no_billing_source') {
    // Credit exhaustion is terminal until the user adds a billing source. It
    // deliberately maps to usage-limit handling, never the transient kind
    // that the main-process retry service automatically re-dispatches.
    return result(
      context,
      'provider_usage_limit',
      'credits_depleted',
      diagnostic,
      resetsAt,
    );
  }
  if (
    canopyProxyFailureCode === 'invalid_request' ||
    canopyProxyFailureCode === 'proxy_internal_error' ||
    // The work owner is an organization the user has left (CAN-3462). No
    // retry can succeed until the user is back in it or moves the work, so
    // it is never eligible for transient auto-retry.
    canopyProxyFailureCode === 'work_owner_not_member'
  ) {
    // Recognized and deliberately unclassified — NOT "nothing found here".
    // Returning plain `null` would let the buffered pass run and classify from
    // a stale signal the terminal error already ruled out.
    return SUPPRESS;
  }

  // Capacity, overload, provider 5xx, and recognized connection failures.
  if (
    context.provider === 'codex' &&
    strings.some((message) =>
      CAPACITY_WRAPPERS.some(
        (prefix) => message === `${prefix}${CAPACITY_MESSAGE}`,
      ),
    )
  ) {
    return result(
      context,
      'provider_temporarily_unavailable',
      'model_capacity',
      diagnostic,
    );
  }
  if (
    context.provider === 'codex' &&
    records.some((record) =>
      hasVariant(readCodexErrorInfo(record), 'serverOverloaded'),
    )
  ) {
    return result(
      context,
      'provider_temporarily_unavailable',
      'server_overloaded',
      diagnostic,
    );
  }
  if (
    context.provider === 'codex' &&
    records.some((record) =>
      hasVariant(readCodexErrorInfo(record), 'internalServerError'),
    )
  ) {
    return result(
      context,
      'provider_temporarily_unavailable',
      'internal_server_error',
      diagnostic,
    );
  }
  if (
    context.provider === 'claude' &&
    topLevelRecords.some(
      (record) =>
        record.type === 'assistant' && record.error === 'server_error',
    )
  ) {
    return result(
      context,
      'provider_temporarily_unavailable',
      'internal_server_error',
      diagnostic,
    );
  }
  if (
    records.some(
      (record) =>
        record.error === 'overloaded_error' ||
        record.code === 'overloaded_error' ||
        record.type === 'overloaded_error',
    )
  ) {
    return result(
      context,
      'provider_temporarily_unavailable',
      'server_overloaded',
      diagnostic,
    );
  }
  if (
    context.provider === 'claude' &&
    errorStrings.some(
      (message) =>
        message === 'server_error' ||
        message === 'Claude SDK error: server_error' ||
        message.startsWith('Claude SDK error: server_error:'),
    )
  ) {
    return result(
      context,
      'provider_temporarily_unavailable',
      'internal_server_error',
      diagnostic,
    );
  }
  if (statuses.some((status) => TRANSIENT_HTTP_STATUSES.has(status))) {
    return result(
      context,
      'provider_temporarily_unavailable',
      'http_5xx',
      diagnostic,
    );
  }
  if (context.provider === 'codex') {
    for (const record of records) {
      const info = readCodexErrorInfo(record);
      for (const variant of CODEX_CONNECTION_VARIANTS) {
        if (!hasVariant(info, variant)) continue;
        const embeddedStatus = variantStatus(info, variant);
        if (embeddedStatus === 401 || embeddedStatus === 429) continue;
        return result(
          context,
          'provider_temporarily_unavailable',
          variant === 'responseStreamDisconnected'
            ? 'stream_disconnected'
            : 'connection_failed',
          diagnostic,
        );
      }
      if (hasVariant(info, 'responseTooManyFailedAttempts')) {
        const embeddedStatus = variantStatus(
          info,
          'responseTooManyFailedAttempts',
        );
        if (
          embeddedStatus !== undefined &&
          TRANSIENT_HTTP_STATUSES.has(embeddedStatus)
        ) {
          return result(
            context,
            'provider_temporarily_unavailable',
            'provider_timeout',
            diagnostic,
          );
        }
      }
    }
  }
  if (
    records.some((record) => {
      const code = record.code;
      return typeof code === 'string' && CONNECTION_CODES.has(code);
    })
  ) {
    return result(
      context,
      'provider_temporarily_unavailable',
      strings.some((message) => /timed out|timeout/i.test(message))
        ? 'provider_timeout'
        : 'connection_failed',
      diagnostic,
    );
  }

  return null;
}
