// Pure parsers for CLIProxyAPI's v8 management API and response headers.
// Browser-safe: the main process feeds them untrusted JSON and header values,
// and the renderer reuses the formatting helpers.
//
// The management config response includes upstream API keys in plain text.
// Nothing here reads a key value: only group names and `auth_index`.

import {
  ACCOUNT_PROXY_MIN_MAJOR_VERSION,
  type AccountProxyAccount,
  type AccountProxyAccountStatus,
  type AccountProxyLimit,
  type AccountProxyUsageSnapshot,
  type AccountProxyRouting,
  type AccountProxyRoutingStrategy,
  type AccountProxyStatus,
} from '../types/account-proxy';
import { ACCOUNT_PROXY_SETTINGS_REFERENCE } from '@canopy/protocol/auth-recovery';
import type { ProviderRateLimitSnapshot } from '@canopy/execution-engine/types/observability';
import {
  isOllamaModel,
  type AgentProviderType,
  type AiCreditsRoutingMode,
} from '../types';
import { isGatewayOnlyModel } from '@canopy/execution-engine/lib/gateway-model-availability';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function timeField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'string') return Number.NaN;
  return Date.parse(value);
}

export {
  isAccountProxyRoutingStrategy,
  normalizeAccountProxyUrl,
} from '@canopy/protocol/preferences';
export type { AccountProxyUrlResult } from '@canopy/protocol/preferences';

/** `8.0.27` → `{ major: 8 }`; null when the header is missing or malformed. */
export function parseAccountProxyVersion(
  header: string | null | undefined,
): { readonly raw: string; readonly major: number } | null {
  const raw = header?.trim() ?? '';
  const match = /^v?(\d+)\.\d+(?:\.\d+)?/.exec(raw);
  if (!match?.[1]) return null;
  return { raw: raw.replace(/^v/, ''), major: Number(match[1]) };
}

export function isSupportedAccountProxyVersion(major: number): boolean {
  return major >= ACCOUNT_PROXY_MIN_MAJOR_VERSION;
}

const AUTH_INDEX_PATTERN = /^[a-f0-9]{8,64}$/i;

/**
 * `X-CPA-TRACE-ID: <yyyymmddhhmmss>-<auth_index>-<request id>`, sent on every
 * proxied response. The auth index is the account that served the request.
 */
export function parseAccountProxyTraceId(
  header: string | null | undefined,
): { readonly authIndex: string; readonly requestId: string } | null {
  const match = /^(\d{14})-([a-f0-9]+)-(.+)$/i.exec(header?.trim() ?? '');
  const authIndex = match?.[2];
  const requestId = match?.[3];
  if (!authIndex || !requestId || !AUTH_INDEX_PATTERN.test(authIndex)) {
    return null;
  }
  return { authIndex: authIndex.toLowerCase(), requestId };
}

/**
 * The key one proxy account goes by in cost views (CAN-4021):
 * `proxy:<connectionId>:<auth_index>`. An `auth_index` names a credential on
 * one proxy only, so the connection is part of the key.
 */
export function accountProxyAccountKey(
  connectionId: string,
  authIndex: string,
): string {
  return `proxy:${connectionId}:${authIndex}`;
}

function signalNumber(
  signals: Record<string, unknown>,
  name: string,
): number | null {
  const normalizedName = name.toLowerCase();
  const entry = Object.entries(signals).find(
    ([key]) => key.toLowerCase() === normalizedName,
  );
  const value = entry?.[1];
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function secondsToMs(value: number | null): number | null {
  return value === null || value <= 0 ? null : value * 1000;
}

const CLAUDE_WINDOWS = [
  { id: 'five-hour', prefix: 'anthropic-ratelimit-unified-5h-' },
  { id: 'weekly', prefix: 'anthropic-ratelimit-unified-7d-' },
] as const;

function codexWindowId(minutes: number | null): AccountProxyLimit['id'] | null {
  if (minutes === null) return null;
  if (minutes <= 6 * 60) return 'five-hour';
  if (minutes >= 6 * 24 * 60) return 'weekly';
  return null;
}

interface ParsedAccountProxyLimit {
  readonly limit: AccountProxyLimit;
  readonly windowDurationMins?: number;
  readonly codexWindow?: 'primary' | 'secondary';
}

function parseAccountProxyQuotaLimits(
  provider: string,
  quota: unknown,
): ParsedAccountProxyLimit[] {
  if (!isRecord(quota) || !isRecord(quota.signals)) return [];
  const signals = quota.signals;
  const observedAt = timeField(quota, 'observed_at');
  const limits: ParsedAccountProxyLimit[] = [];

  if (provider === 'claude') {
    for (const window of CLAUDE_WINDOWS) {
      const utilization = signalNumber(signals, `${window.prefix}utilization`);
      if (utilization === null) continue;
      const resetsAt = secondsToMs(
        signalNumber(signals, `${window.prefix}reset`),
      );
      limits.push({
        limit: {
          id: window.id,
          usedPercent: clampPercent(utilization * 100),
          resetsAt,
        },
        windowDurationMins: window.id === 'five-hour' ? 5 * 60 : 7 * 24 * 60,
      });
    }
  } else if (provider === 'codex') {
    for (const window of ['primary', 'secondary'] as const) {
      const used = signalNumber(signals, `x-codex-${window}-used-percent`);
      const windowDurationMins = signalNumber(
        signals,
        `x-codex-${window}-window-minutes`,
      );
      const id =
        codexWindowId(windowDurationMins) ??
        (window === 'primary' ? 'five-hour' : 'weekly');
      if (used === null || limits.some((limit) => limit.limit.id === id)) {
        continue;
      }
      const resetAt = secondsToMs(
        signalNumber(signals, `x-codex-${window}-reset-at`),
      );
      const resetAfter = signalNumber(
        signals,
        `x-codex-${window}-reset-after-seconds`,
      );
      limits.push({
        limit: {
          id,
          usedPercent: clampPercent(used),
          resetsAt:
            resetAt ??
            (resetAfter !== null && Number.isFinite(observedAt)
              ? observedAt + resetAfter * 1000
              : null),
        },
        ...(windowDurationMins !== null && windowDurationMins > 0
          ? { windowDurationMins }
          : {}),
      });
    }
  }
  return limits;
}

/**
 * Reads the limits a provider reported on the last response the proxy saw
 * (`quota`: its `signals` and their `observed_at`): Claude's unified
 * rate-limit headers and Codex's primary and secondary windows. Other
 * providers report none. A relative reset counts from when the proxy saw the
 * response, so it does not move with each poll.
 */
export function parseAccountProxyLimits(
  provider: string,
  quota: unknown,
  nowMs: number,
): AccountProxyLimit[] {
  return parseAccountProxyQuotaLimits(provider, quota)
    .map(({ limit }) => limit)
    .filter((limit) => limit.resetsAt === null || limit.resetsAt > nowMs);
}

function epochMsToIsoString(value: number): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function accountProxyLimitName(id: AccountProxyLimit['id']): string {
  return id === 'five-hour' ? '5-hour window' : '7-day window';
}

function parseCodexPassiveQuotaLimits(
  quota: unknown,
): ParsedAccountProxyLimit[] {
  if (!isRecord(quota) || !isRecord(quota.signals)) return [];
  const signals = quota.signals;
  const observedAt = timeField(quota, 'observed_at');
  const limits: ParsedAccountProxyLimit[] = [];
  for (const window of ['primary', 'secondary'] as const) {
    const used = signalNumber(signals, `x-codex-${window}-used-percent`);
    if (used === null) continue;
    const windowDurationMins = signalNumber(
      signals,
      `x-codex-${window}-window-minutes`,
    );
    const id =
      codexWindowId(windowDurationMins) ??
      (window === 'primary' ? 'five-hour' : 'weekly');
    const resetAt = secondsToMs(
      signalNumber(signals, `x-codex-${window}-reset-at`),
    );
    const resetAfter = signalNumber(
      signals,
      `x-codex-${window}-reset-after-seconds`,
    );
    limits.push({
      limit: {
        id,
        usedPercent: clampPercent(used),
        resetsAt:
          resetAt ??
          (resetAfter !== null && Number.isFinite(observedAt)
            ? observedAt + resetAfter * 1000
            : null),
      },
      codexWindow: window,
      ...(windowDurationMins !== null && windowDurationMins > 0
        ? { windowDurationMins }
        : {}),
    });
  }
  return limits;
}

/** Builds a passive usage snapshot from the proxy's last observed quota. */
export function parseAccountProxyPassiveUsage(
  provider: string,
  quota: unknown,
): AccountProxyUsageSnapshot | undefined {
  if (!isRecord(quota)) return undefined;
  const parsedLimits =
    provider === 'codex'
      ? parseCodexPassiveQuotaLimits(quota)
      : parseAccountProxyQuotaLimits(provider, quota);
  if (parsedLimits.length === 0) return undefined;

  const observedAt = timeField(quota, 'observed_at');
  const lastUpdatedAt = Number.isFinite(observedAt)
    ? epochMsToIsoString(observedAt)
    : undefined;
  const rateLimits: ProviderRateLimitSnapshot[] = parsedLimits.map(
    ({ limit, windowDurationMins, codexWindow }) => {
      const resetsAt =
        limit.resetsAt === null
          ? undefined
          : epochMsToIsoString(limit.resetsAt);
      const usageWindow = {
        usedPercent: limit.usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
      };
      return {
        limitId: codexWindow ?? limit.id,
        limitName: codexWindow ? 'Codex' : accountProxyLimitName(limit.id),
        ...(codexWindow === 'secondary'
          ? { secondary: usageWindow }
          : { primary: usageWindow }),
      };
    },
  );

  return {
    rateLimits,
    source: 'passive',
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
  };
}

function credentialCooldownEnd(
  entry: Record<string, unknown>,
  nowMs: number,
): number | null {
  const ends: number[] = [];
  const cooldowns = entry.cooldowns;
  if (Array.isArray(cooldowns)) {
    for (const cooldown of cooldowns) {
      if (!isRecord(cooldown) || cooldown.scope !== 'credential') continue;
      const retryAt = timeField(cooldown, 'retry_at');
      if (retryAt > nowMs) ends.push(retryAt);
    }
  }
  if (entry.unavailable === true) {
    const nextRetry = timeField(entry, 'next_retry_after');
    if (nextRetry > nowMs) ends.push(nextRetry);
  }
  return ends.length > 0 ? Math.min(...ends) : null;
}

function credentialStatus(
  entry: Record<string, unknown>,
  availableAt: number | null,
): AccountProxyAccountStatus {
  const status = stringField(entry, 'status');
  if (entry.disabled === true || status === 'disabled') return 'disabled';
  // CLIProxyAPI 8.0.48+ marks a credential it can no longer renew.
  if (entry.requires_sign_in === true || entry.next_action === 'sign_in')
    return 'sign-in-required';
  if (availableAt !== null) return 'cooling';
  if (status === 'refreshing') return 'refreshing';
  if (status === 'pending') return 'pending';
  if (status === 'error') return 'error';
  return 'active';
}

function planTypeOf(entry: Record<string, unknown>): string | null {
  const idToken = entry.id_token;
  if (isRecord(idToken)) {
    const plan = stringField(idToken, 'plan_type');
    if (plan) return plan;
  }
  return null;
}

/**
 * Signed-in accounts from `GET /v8/management/credentials`. Entries without
 * an auth index (the proxy assigns one to every listed credential) are
 * skipped rather than shown without a way to act on them.
 */
export function parseAccountProxyCredentials(
  body: unknown,
  nowMs: number,
): AccountProxyAccount[] {
  if (!isRecord(body) || !Array.isArray(body.files)) return [];
  const accounts: AccountProxyAccount[] = [];
  for (const entry of body.files) {
    if (!isRecord(entry)) continue;
    const authIndex = stringField(entry, 'auth_index').toLowerCase();
    const provider = (
      stringField(entry, 'provider') || stringField(entry, 'type')
    ).toLowerCase();
    if (!AUTH_INDEX_PATTERN.test(authIndex) || !provider) continue;
    const availableAt = credentialCooldownEnd(entry, nowMs);
    const quota = entry.quota;
    accounts.push({
      authIndex,
      provider,
      label:
        stringField(entry, 'email') ||
        stringField(entry, 'label') ||
        stringField(entry, 'account') ||
        stringField(entry, 'name'),
      source: 'sign-in',
      fileName: stringField(entry, 'name') || null,
      planType: planTypeOf(entry),
      status: credentialStatus(entry, availableAt),
      statusMessage: stringField(entry, 'status_message') || null,
      availableAt,
      limits: parseAccountProxyLimits(provider, quota, nowMs),
    });
  }
  return accounts;
}

/** `api-keys` groups in the server config, by provider. */
const CONFIG_KEY_PROVIDERS: Readonly<Record<string, string>> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  vertex: 'vertex',
  xai: 'xai',
  kimi: 'kimi',
  'openai-compatibility': 'openai',
};

/**
 * API-key accounts from `GET /v8/management/config`: one per key, labelled
 * with its group name. The key value in the same object is never read.
 */
export function parseAccountProxyConfigAccounts(
  body: unknown,
): AccountProxyAccount[] {
  if (!isRecord(body) || !isRecord(body['api-keys'])) return [];
  const accounts: AccountProxyAccount[] = [];
  for (const [section, groups] of Object.entries(body['api-keys'])) {
    const provider = CONFIG_KEY_PROVIDERS[section] ?? section;
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!isRecord(group) || !Array.isArray(group.keys)) return;
      const name =
        stringField(group, 'name') || `${section} ${String(groupIndex + 1)}`;
      const keys = group.keys.filter(isRecord);
      keys.forEach((key, keyIndex) => {
        const authIndex = stringField(key, 'auth_index').toLowerCase();
        if (!AUTH_INDEX_PATTERN.test(authIndex)) return;
        accounts.push({
          authIndex,
          provider,
          label:
            keys.length > 1 ? `${name} · key ${String(keyIndex + 1)}` : name,
          source: 'api-key',
          fileName: null,
          planType: null,
          status: key.disabled === true ? 'disabled' : 'active',
          statusMessage: null,
          availableAt: null,
          limits: [],
        });
      });
    });
  }
  return accounts;
}

/** As the proxy runs it: these aliases, and anything else as round robin. */
function parseRoutingStrategy(value: string): AccountProxyRoutingStrategy {
  switch (value.toLowerCase()) {
    case 'weighted-round-robin':
    case 'weightedroundrobin':
    case 'wrr':
      return 'weighted-round-robin';
    case 'fill-first':
    case 'fillfirst':
    case 'ff':
      return 'fill-first';
    default:
      return 'round-robin';
  }
}

/** The server's `routing` block; null fields when it is not reported. */
export function parseAccountProxyRouting(body: unknown): AccountProxyRouting {
  const routing = isRecord(body) && isRecord(body.routing) ? body.routing : {};
  const affinity = routing['session-affinity'];
  return {
    strategy: parseRoutingStrategy(stringField(routing, 'strategy')),
    sessionAffinity: typeof affinity === 'boolean' ? affinity : false,
  };
}

/** Signed-in accounts first, then API keys; each group by provider, label. */
export function sortAccountProxyAccounts(
  accounts: readonly AccountProxyAccount[],
): AccountProxyAccount[] {
  const seen = new Set<string>();
  return [...accounts]
    .filter((account) => {
      if (seen.has(account.authIndex)) return false;
      seen.add(account.authIndex);
      return true;
    })
    .sort(
      (a, b) =>
        (a.source === b.source ? 0 : a.source === 'sign-in' ? -1 : 1) ||
        a.provider.localeCompare(b.provider) ||
        a.label.localeCompare(b.label),
    );
}

/** Accounts that can take a request now. */
export function isAccountProxyAccountReady(
  account: AccountProxyAccount,
): boolean {
  return account.status === 'active' || account.status === 'refreshing';
}

/** Whether this device can sign the account in again itself (its own proxy). */
export function canSignInAccountProxyAccountHere(
  account: AccountProxyAccount,
  connectionKind: string | undefined,
): boolean {
  return (
    account.status === 'sign-in-required' &&
    account.source === 'sign-in' &&
    connectionKind === 'local' &&
    (account.provider === 'claude' || account.provider === 'codex')
  );
}

/** The agent harnesses the account proxy can route. */
export type AccountProxyHarness = 'claude' | 'codex';

/** CLIProxyAPI providers whose accounts serve each harness's models. */
const HARNESS_PROVIDERS: Readonly<
  Record<AccountProxyHarness, ReadonlySet<string>>
> = {
  claude: new Set(['claude']),
  codex: new Set(['codex']),
};

/** Accounts that can take a `harness` request now. */
export function countReadyAccountProxyAccounts(
  accounts: readonly AccountProxyAccount[],
  harness: AccountProxyHarness,
): number {
  return accountProxyAccountsForHarness(accounts, harness).filter(
    isAccountProxyAccountReady,
  ).length;
}

/** The proxy's accounts that serve `harness` requests, in list order. */
export function accountProxyAccountsForHarness(
  accounts: readonly AccountProxyAccount[],
  harness: AccountProxyHarness,
): AccountProxyAccount[] {
  const providers = HARNESS_PROVIDERS[harness];
  return accounts.filter((account) => providers.has(account.provider));
}

/**
 * Whose plan limits apply to a harness's work: the user's own sign-in on this
 * device (`native`) or the account proxy's accounts. Every surface that shows
 * a provider account, its limits, or a usage alert reads it from
 * {@link resolveProviderAccountSource} or {@link resolveChatAccountSource}.
 */
export type ProviderAccountSource = 'native' | 'account-proxy';

function isLocalConnectionServing(status: AccountProxyStatus): boolean {
  const connection = status.connection;
  if (connection?.kind !== 'local') return true;
  if (status.local.phase !== 'running' || status.local.port === null) {
    return false;
  }
  try {
    return new URL(connection.url).port === String(status.local.port);
  } catch {
    return false;
  }
}

/** Whether the proxy's own state sends new `harness` work to it. */
function isProxyRoutingHarness(
  status: AccountProxyStatus | null,
  harness: AccountProxyHarness,
): boolean {
  if (
    !status?.available ||
    !status.connection ||
    status.state !== 'connected' ||
    status.error
  ) {
    return false;
  }
  if (!(harness === 'claude' ? status.routeClaude : status.routeCodex)) {
    return false;
  }
  return isLocalConnectionServing(status);
}

/**
 * Where new `harness` work on this device goes, as main's route check decides
 * it: AI Credits set to route every session go first (see
 * {@link aiCreditsOutrankAccountProxy}); otherwise the work goes through the
 * proxy while it is connected without an error, routing is on for the
 * harness, and a proxy on this device is running. Unlike
 * {@link isAccountProxyReadyForHarness}, it does not need a ready account:
 * main still routes to the proxy and waits for one. An organization gateway
 * outranks the proxy for its own work, which this device-wide read cannot see.
 */
export function resolveProviderAccountSource(input: {
  readonly status: AccountProxyStatus | null;
  readonly harness: AccountProxyHarness;
  /** The global AI Credits mode; null until it loads. */
  readonly aiCreditsRoutingMode: AiCreditsRoutingMode | null;
}): ProviderAccountSource {
  if (
    aiCreditsOutrankAccountProxy({
      chatChoseAiCredits: false,
      routingMode: input.aiCreditsRoutingMode,
    })
  ) {
    return 'native';
  }
  return isProxyRoutingHarness(input.status, input.harness)
    ? 'account-proxy'
    : 'native';
}

/**
 * The harness whose account proxy routing a chat's work can take, or null
 * when main never routes it through the proxy. Main routes only Claude Code
 * and Codex sessions, and neither for a model that runs locally on Ollama or
 * exists only on AI Credits. OpenCode, Cursor, Copilot, and Ollama chats have
 * none.
 */
export function accountProxyHarnessForChat(input: {
  /** The chat's execution provider, as main creates its session. */
  readonly providerType: AgentProviderType | undefined;
  readonly model: string | undefined;
}): AccountProxyHarness | null {
  // Main's session manager and `checkAccountProxySessionRoute` decide it.
  if (input.providerType !== 'claude' && input.providerType !== 'codex') {
    return null;
  }
  if (isOllamaModel(input.model) || isGatewayOnlyModel(input.model)) {
    return null;
  }
  return input.providerType;
}

/** What one chat brings to main's route decision. */
export interface ChatAccountRoute {
  /** The chat's execution provider, as main creates its session. */
  readonly providerType: AgentProviderType | undefined;
  readonly model: string | undefined;
  /** From the session's routing report; undefined before a session exists. */
  readonly sessionAccountProxyRouted: boolean | undefined;
  /** AI Credits chosen for this chat. */
  readonly chatChoseAiCredits: boolean;
  /** The user picked their own subscription for this chat. */
  readonly subscriptionBillingOverride?: boolean;
}

/**
 * Where one chat's work goes. Main reports the route it applied when it
 * created the chat's session, and that fact wins; until then the chat takes
 * the route main would give it: none for a harness the proxy cannot serve,
 * AI Credits when they outrank the proxy for this chat, and otherwise the
 * route new work on this device would get.
 */
export function resolveChatAccountSource(
  input: ChatAccountRoute & {
    readonly status: AccountProxyStatus | null;
    /** The global AI Credits mode; null until it loads. */
    readonly aiCreditsRoutingMode: AiCreditsRoutingMode | null;
  },
): ProviderAccountSource {
  const harness = accountProxyHarnessForChat(input);
  if (harness === null) return 'native';
  if (input.sessionAccountProxyRouted !== undefined) {
    return input.sessionAccountProxyRouted ? 'account-proxy' : 'native';
  }
  if (
    aiCreditsOutrankAccountProxy({
      chatChoseAiCredits: input.chatChoseAiCredits,
      routingMode: input.aiCreditsRoutingMode,
      subscriptionBillingOverride: input.subscriptionBillingOverride,
    })
  ) {
    return 'native';
  }
  return isProxyRoutingHarness(input.status, harness)
    ? 'account-proxy'
    : 'native';
}

/**
 * Whether AI Credits outrank the account proxy for a harness's work, as main
 * decides it when it creates a session: AI Credits chosen for the chat, or the
 * global mode set to route every session through AI Credits. A per-chat
 * subscription choice keeps the global mode from applying. `on-quota` never
 * does: it reacts to the user's own plan running out, and the proxy's
 * accounts are not that plan (CAN-4090). Otherwise work on a harness routed
 * through the proxy waits for a proxy account, or fails when the proxy has
 * none, and never falls back to AI Credits.
 */
export function aiCreditsOutrankAccountProxy(input: {
  /** AI Credits chosen for this chat; false for a device-wide read. */
  readonly chatChoseAiCredits: boolean;
  readonly routingMode: AiCreditsRoutingMode | null;
  /** The user picked their own subscription for this chat. */
  readonly subscriptionBillingOverride?: boolean;
}): boolean {
  if (input.chatChoseAiCredits) return true;
  return !input.subscriptionBillingOverride && input.routingMode === 'on';
}

const SIGNED_OUT_PATTERN =
  /unauthori[sz]ed|authentication|invalid.credentials|expired.token|\b401\b|\b403\b/i;

/** An account the proxy reports as signed out: only signing in again fixes it. */
export function isAccountProxyAccountSignedOut(
  account: AccountProxyAccount,
): boolean {
  return (
    account.status === 'sign-in-required' ||
    (account.status === 'error' &&
      SIGNED_OUT_PATTERN.test(account.statusMessage ?? ''))
  );
}

const HARNESS_LABELS: Readonly<Record<AccountProxyHarness, string>> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * Why `harness` work cannot wait on the proxy for an account, or null when
 * waiting can help: an account is ready, cooling down, or finishing sign-in.
 * Accounts the user turned off or that are signed out need the user first.
 */
export function accountProxyNoUsableAccountsMessage(
  accounts: readonly AccountProxyAccount[],
  harness: AccountProxyHarness,
): string | null {
  const providers = HARNESS_PROVIDERS[harness];
  const own = accounts.filter((account) => providers.has(account.provider));
  const label = HARNESS_LABELS[harness];
  if (own.length === 0) {
    return `The account proxy has no ${label} accounts. Add one in ${ACCOUNT_PROXY_SETTINGS_REFERENCE}, or turn off Use for ${label} there.`;
  }
  if (
    own.some(
      (account) =>
        account.status !== 'disabled' &&
        !isAccountProxyAccountSignedOut(account),
    )
  ) {
    return null;
  }
  // Here every account is turned off or signed out; when all need a new
  // sign-in, say so, since that is the only fix.
  if (own.every(isAccountProxyAccountSignedOut)) {
    return `The account proxy's ${label} accounts need a new sign-in. Sign in again in ${ACCOUNT_PROXY_SETTINGS_REFERENCE}, or turn off Use for ${label} there.`;
  }
  return `None of the account proxy's ${label} accounts can be used. Turn one on or sign in again in ${ACCOUNT_PROXY_SETTINGS_REFERENCE}, or turn off Use for ${label} there.`;
}

/**
 * Whether new `harness` work on this device can bill through the proxy: it is
 * connected without an error, routing is on for the harness, and an account
 * for it is ready. An organization gateway still takes precedence; callers
 * that know the work owner check that separately.
 */
export function isAccountProxyReadyForHarness(
  status: AccountProxyStatus | null,
  harness: AccountProxyHarness,
): boolean {
  if (!status?.available || status.state !== 'connected' || status.error) {
    return false;
  }
  if (!(harness === 'claude' ? status.routeClaude : status.routeCodex)) {
    return false;
  }
  return countReadyAccountProxyAccounts(status.accounts, harness) > 0;
}
