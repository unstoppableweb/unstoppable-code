import { getAntigravityModelEntries } from '@canopy/execution-engine/model-catalog';
import { peekOpenCodeRuntimeAvailability } from '../opencode/runtime-availability';
import { resolveClaudePlanType } from '@canopy/desktop-shared/lib/account-proxy-claude-plan';
import { peekCopilotRuntimeAvailability } from '../copilot/runtime-availability';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type AgentProviderAuthStatus,
  type AgentProviderType,
  type PortalChatProviderAvailability,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  getBundledClaudeBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';
import { parseGetAccountResponsePayload } from '../codex/app-server-client';
import type { GetAccountResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/GetAccountResponse';
import { getObservedCanonicalCodexHome } from '@canopy/execution-engine/node/codex-runtime';
import { getCodexRuntimeService } from '../codex/runtime-service';
import {
  fetchMockControlPlaneRecord,
  getMockLlmOrigin,
} from '../lib/e2e-mock-control-plane';
import { readClaudeOauthPlanMetadata } from './claude-oauth-credentials';
import { peekCursorRuntimeAvailability } from '../cursor/runtime-availability';
import { invalidateProviderAuthSessions } from '../agents/session-manager';
import { invalidateCodexSpeedCatalog } from '../model-routing/codex-account-models';
import { getObservabilityService } from '../observability';
import {
  logMainProcessInfo,
  logMainProcessWarn,
} from '../lib/main-process-logging';

const execFileAsync = promisify(execFile);

/**
 * Timeout for a single provider auth CLI probe. Deliberately generous
 * (was 10s) so a slow-but-recoverable spawn — e.g. during a bundled-binary
 * swap on auto-update — is retried rather than counted as a failure.
 *
 * Tail-latency trade-off (intentional): with the single non-ENOENT retry, a
 * probe that truly hangs can block a `forceRefresh` caller for up to ~40s
 * (20s + {@link AUTH_PROBE_RETRY_BACKOFF_MS} + 20s). This is on the
 * interactive gating path ({@link isProviderNativelyAuthenticated}, terminal
 * launch, worker retry/run). We accept the worst case because it is TTL-cached
 * and request-deduped, and because the alternative — a short timeout that
 * false-fails a recoverable spawn — is the exact regression this change fixes.
 * If this ever needs tightening, cap the *total* budget across both attempts
 * rather than shrinking a single attempt below the binary's cold-start time.
 */
const AUTH_PROBE_TIMEOUT_MS = 20_000;
/** Backoff before the single non-ENOENT retry of an auth CLI probe. */
const AUTH_PROBE_RETRY_BACKOFF_MS = 250;
/**
 * Short cache TTL for a probe-failure entry so an inconclusive read recovers
 * quickly instead of pinning a stale "unknown" for the full confirmed TTL.
 */
const PROBE_FAILURE_TTL_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Emit a diagnostic + structured warn when an auth probe fails. Fire-and-forget:
 * never throws into the auth path. A failed probe is money-adjacent (it must not
 * be misread as a logout that force-routes to credits), so it is always logged.
 */
function recordProviderAuthProbeFailure(
  provider: AuthObservedProvider,
  error: unknown,
  retainedConfirmed: boolean,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const reason = `${provider} auth probe failed (retainedConfirmed=${retainedConfirmed})`;
  try {
    logMainProcessWarn(`provider-auth: ${reason}`, message);
  } catch {
    // Logging must never break the auth probe being diagnosed.
  }
  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'provider_auth_probe_failed',
      reason,
      error: message,
    });
  } catch {
    // Diagnostics are best-effort and must never throw into the auth path.
  }
}

type AuthObservedProvider = Extract<AgentProviderType, 'claude' | 'codex'>;
type AuthObservationConfidence = 'confirmed' | 'unknown';

interface ProviderAuthObservation {
  provider: AuthObservedProvider;
  status: AgentProviderAuthStatus;
  confidence: AuthObservationConfidence;
  fingerprint: string | null;
  forceInvalidation?: boolean;
  /** An explicit transition already interrupted old-account sessions. */
  explicitInvalidationApplied?: boolean;
}

const lastConfirmedFingerprints = new Map<AuthObservedProvider, string>();
const pendingConfirmedFingerprints = new Map<AuthObservedProvider, string>();
const invalidationInFlight = new Map<AuthObservedProvider, Promise<void>>();
const providersWithUnknownSessionBaseline = new Set<AuthObservedProvider>();
/**
 * When each provider's last session-baseline probe came back *successful but
 * indeterminate*. Such a probe records no fingerprint, so
 * {@link ensureProviderAuthBaselineForSession}'s fast path can never engage;
 * this stamp bounds how often the (uncached) probe is repeated for a state that
 * may never resolve on its own. Cleared as soon as a confirmed probe lands.
 */
const indeterminateBaselineAtMs = new Map<AuthObservedProvider, number>();
/**
 * Cooldown between repeat baseline probes for a stable-indeterminate provider.
 * Matches the provider status-cache TTL below so the two reconverge on the same
 * cadence.
 */
const INDETERMINATE_BASELINE_RETRY_TTL_MS = 30_000;
const CLAUDE_AUTH_STATUS_CACHE_TTL_MS = 30_000;
let claudeAuthStatusCache: {
  status: AgentProviderAuthStatus;
  checkedAtMs: number;
} | null = null;
let claudeAuthStatusRefresh: Promise<AgentProviderAuthStatus> | null = null;
/**
 * The last *confirmed* (non-`probeFailed`) status seen for each provider. Only
 * ever written on a successful probe, so it survives an arbitrarily long run of
 * consecutive probe failures — unlike the working cache, which is overwritten
 * with the `probeFailed` status on the first failure. A probe-failure retains
 * identity/plan from HERE, so a sustained outage never blanks out the last
 * known-good identity after the first failure.
 */
let lastConfirmedClaudeAuthStatus: AgentProviderAuthStatus | null = null;
const CODEX_AUTH_STATUS_CACHE_TTL_MS = 30_000;
let codexAuthStatusCache: {
  status: AgentProviderAuthStatus;
  checkedAtMs: number;
} | null = null;
let codexAuthStatusRefresh: Promise<AgentProviderAuthStatus> | null = null;
/** See {@link lastConfirmedClaudeAuthStatus}; the Codex equivalent. */
let lastConfirmedCodexAuthStatus: AgentProviderAuthStatus | null = null;

/**
 * How a confirmed sign-in came about: the first confirmation this launch, a
 * sign-in through the app, or an account change made outside it.
 */
export type ProviderAccountConnectSource =
  | 'at_startup'
  | 'in_app'
  | 'external_change';

/** A provider's account was confirmed signed in, as a new fingerprint. */
export interface ConfirmedProviderAuthEvent {
  provider: AuthObservedProvider;
  status: AgentProviderAuthStatus;
  /** The confirmed fingerprint; the same account repeats the same value. */
  fingerprint: string;
  connectSource: ProviderAccountConnectSource;
}

type ConfirmedProviderAuthListener = (
  event: ConfirmedProviderAuthEvent,
) => void;

const confirmedProviderAuthListeners = new Set<ConfirmedProviderAuthListener>();

/**
 * Each provider's last confirmed signed-in event, replayed to a listener that
 * subscribes after it fired: the startup auth prewarm can confirm an account
 * before the deferred startup work subscribes, and a repeat observation of
 * that account is never reported again. Cleared by a confirmed sign-out.
 */
const lastConfirmedSignedInEvents = new Map<
  AuthObservedProvider,
  ConfirmedProviderAuthEvent
>();

/**
 * Hear each confirmed sign-in: the first confirmed observation of a signed-in
 * account, an explicit sign-in, a managed Codex sign-in, and a passive account
 * change once it is confirmed. A provider already confirmed signed in when
 * the listener subscribes is replayed to it at once. A repeat observation of
 * the same account, a sign-out, and an inconclusive probe are not reported.
 * Listeners run in the observation's call path, so they must be quick and
 * must not throw; a throw is logged and the other listeners still run.
 */
export function subscribeConfirmedProviderAuth(
  listener: ConfirmedProviderAuthListener,
): () => void {
  confirmedProviderAuthListeners.add(listener);
  for (const event of Array.from(lastConfirmedSignedInEvents.values()))
    deliverConfirmedProviderAuth(listener, event);
  return (): void => {
    confirmedProviderAuthListeners.delete(listener);
  };
}

function deliverConfirmedProviderAuth(
  listener: ConfirmedProviderAuthListener,
  event: ConfirmedProviderAuthEvent,
): void {
  try {
    listener(event);
  } catch (error) {
    logMainProcessWarn(
      `provider-auth: listener failed for ${event.provider} sign-in`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function notifyConfirmedProviderAuth(
  provider: AuthObservedProvider,
  status: AgentProviderAuthStatus,
  fingerprint: string,
  connectSource: ProviderAccountConnectSource,
): void {
  if (!status.authenticated) {
    lastConfirmedSignedInEvents.delete(provider);
    return;
  }
  const event: ConfirmedProviderAuthEvent = {
    provider,
    status,
    fingerprint,
    connectSource,
  };
  lastConfirmedSignedInEvents.set(provider, event);
  for (const listener of Array.from(confirmedProviderAuthListeners))
    deliverConfirmedProviderAuth(listener, event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === 'string' && field.trim().length > 0
    ? field.trim()
    : null;
}

function readBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | null {
  const field = value[key];
  return typeof field === 'boolean' ? field : null;
}

function isMissingExecutableError(error: unknown): boolean {
  const errorCode =
    isRecord(error) && typeof error.code === 'string' ? error.code : null;
  return (
    errorCode === 'ENOENT' ||
    (error instanceof Error && error.message.includes('ENOENT'))
  );
}

/**
 * Unwrap the stdout of a non-zero `claude auth status --json` exit **only** when
 * it carries an explicit `loggedIn: false`, which is Claude CLI's normal
 * signed-out exit. Any other non-zero exit stays an inconclusive probe failure.
 *
 * Non-OAuth configurations are deliberately NOT a concern here: unlike Codex —
 * where a custom `model_provider` yields a successful-but-indeterminate read
 * that must not be treated as a logout — every third-party Claude configuration
 * reports `loggedIn: true` and exits 0. Verified against the bundled binary,
 * including with an empty `CLAUDE_CONFIG_DIR` so no OAuth credential could be
 * masking the result:
 *
 * - `CLAUDE_CODE_USE_BEDROCK=1` → `{ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }`
 * - `CLAUDE_CODE_USE_VERTEX=1`  → `{ loggedIn: true, authMethod: 'third_party', apiProvider: 'vertex' }`
 * - `ANTHROPIC_API_KEY=…`       → `{ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }`
 * - `ANTHROPIC_BASE_URL=…`      → `{ loggedIn: true, … }`
 *
 * So a `loggedIn: false` reaching this function is a genuine signed-out state,
 * never a user whose own provider is about to be suppressed by
 * `buildClaudeProxyEnv`. `provider-auth-state.test.ts` pins these payloads as
 * authenticated so a future CLI change that starts reporting `loggedIn: false`
 * for a third-party provider fails a test instead of silently rerouting spend.
 */
function readConfirmedClaudeLogoutStdout(error: unknown): string | null {
  if (!isRecord(error) || typeof error.stdout !== 'string') {
    return null;
  }

  try {
    const payload: unknown = JSON.parse(error.stdout);
    return isRecord(payload) && readBoolean(payload, 'loggedIn') === false
      ? error.stdout
      : null;
  } catch {
    return null;
  }
}

function fingerprintStatus(status: AgentProviderAuthStatus): string {
  if (status.authenticated) {
    const accountIdentity = (status.accountEmail ?? status.accountLabel ?? '')
      .trim()
      .toLowerCase();
    return `auth:${status.accountKind ?? 'unknown'}:${accountIdentity}`;
  }
  return 'unauthenticated';
}

function isCodexApiKeyStatus(status: AgentProviderAuthStatus): boolean {
  return status.authenticated && status.accountLabel === 'API key';
}

function hashCredentialRevision(value: string | Buffer): string {
  const hash = createHash('sha256');
  if (typeof value === 'string') {
    hash.update(value, 'utf8');
  } else {
    hash.update(value);
  }
  return hash.digest('hex').slice(0, 16);
}

function readCodexAuthFileCredentialRevision(
  env: Record<string, string | undefined>,
): string | null {
  const codexHome =
    getObservedCanonicalCodexHome() ??
    (env.CODEX_HOME?.trim() || path.join(env.HOME ?? homedir(), '.codex'));
  const authFilePath = path.join(codexHome, 'auth.json');
  try {
    if (!existsSync(authFilePath)) {
      return null;
    }
    return `auth-file:${hashCredentialRevision(readFileSync(authFilePath))}`;
  } catch {
    return null;
  }
}

function readCodexApiKeyCredentialRevision(): string {
  const env = getEnhancedEnv({ environment: false });
  const apiKey =
    typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  return (
    readCodexAuthFileCredentialRevision(env) ??
    (apiKey ? `env:${hashCredentialRevision(apiKey)}` : null) ??
    'unknown'
  );
}

export function fingerprintCodexAuthStatus(
  status: AgentProviderAuthStatus,
): string {
  if (!isCodexApiKeyStatus(status)) {
    return fingerprintStatus(status);
  }
  return `${fingerprintStatus(status)}:api-key:${readCodexApiKeyCredentialRevision()}`;
}

/** A recovery identity must change even when a separate CLI swaps credentials. */
export function fingerprintCodexRecoveryIdentity(
  status: AgentProviderAuthStatus,
): string | null {
  if (!status.authenticated || status.probeFailed) return null;
  const stableAccountIdentity =
    status.accountEmail?.trim() || status.accountLabel?.trim() || null;
  const credentialRevision = isCodexApiKeyStatus(status)
    ? readCodexApiKeyCredentialRevision()
    : (readCodexAuthFileCredentialRevision(
        getEnhancedEnv({ environment: false }),
      ) ?? (stableAccountIdentity ? fingerprintStatus(status) : null));
  if (!credentialRevision || credentialRevision === 'unknown') return null;
  return `credential:${status.accountKind ?? 'unknown'}:${credentialRevision}`;
}

async function enqueueProviderInvalidation(
  provider: AuthObservedProvider,
  reason: string,
  activeTurnPolicy: 'interrupt' | 'preserve',
): Promise<void> {
  const previous = invalidationInFlight.get(provider) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() =>
      invalidateProviderAuthSessions(
        provider,
        reason,
        // A passive identity confirmation can fire from the turn's own
        // start-up (the audit entry warms the account cache); keep that turn.
        activeTurnPolicy === 'preserve'
          ? { activeTurnPolicy, preservePreparingTurns: true }
          : { activeTurnPolicy },
      ),
    );
  invalidationInFlight.set(provider, next);

  try {
    await next;
  } finally {
    if (invalidationInFlight.get(provider) === next) {
      invalidationInFlight.delete(provider);
    }
    // Models and speeds are per account: the old account's Codex catalog
    // must not outlive its sessions.
    if (provider === 'codex') invalidateCodexSpeedCatalog('auth-transition');
  }
}

export async function observeProviderAuthStatus(
  observation: ProviderAuthObservation,
  reason: string,
): Promise<void> {
  if (observation.confidence === 'unknown') {
    pendingConfirmedFingerprints.delete(observation.provider);
    return;
  }

  const fingerprint =
    observation.fingerprint ?? fingerprintStatus(observation.status);
  const previous = lastConfirmedFingerprints.get(observation.provider);
  if (previous === undefined) {
    lastConfirmedFingerprints.set(observation.provider, fingerprint);
    pendingConfirmedFingerprints.delete(observation.provider);
    // An in-app sign-in can be the first confirmed check of this launch; the
    // Codex auth terminal applies its transition before probing.
    notifyConfirmedProviderAuth(
      observation.provider,
      observation.status,
      fingerprint,
      observation.forceInvalidation === true ||
        observation.explicitInvalidationApplied === true
        ? 'in_app'
        : 'at_startup',
    );
    if (
      observation.forceInvalidation === true ||
      providersWithUnknownSessionBaseline.delete(observation.provider)
    ) {
      await enqueueProviderInvalidation(
        observation.provider,
        reason,
        observation.forceInvalidation === true ? 'interrupt' : 'preserve',
      );
    }
    return;
  }

  if (
    observation.forceInvalidation === true ||
    observation.explicitInvalidationApplied === true
  ) {
    lastConfirmedFingerprints.set(observation.provider, fingerprint);
    pendingConfirmedFingerprints.delete(observation.provider);
    logMainProcessInfo(
      `provider-auth: applying explicit ${observation.provider} auth transition (${reason})`,
    );
    if (previous !== fingerprint)
      notifyConfirmedProviderAuth(
        observation.provider,
        observation.status,
        fingerprint,
        'in_app',
      );
    if (observation.explicitInvalidationApplied !== true) {
      await enqueueProviderInvalidation(
        observation.provider,
        reason,
        'interrupt',
      );
    }
    return;
  }

  if (previous === fingerprint) {
    pendingConfirmedFingerprints.delete(observation.provider);
    return;
  }

  if (pendingConfirmedFingerprints.get(observation.provider) !== fingerprint) {
    pendingConfirmedFingerprints.set(observation.provider, fingerprint);
    logMainProcessWarn(
      `provider-auth: observed possible ${observation.provider} auth transition; awaiting confirmation (${reason})`,
    );
    return;
  }

  lastConfirmedFingerprints.set(observation.provider, fingerprint);
  pendingConfirmedFingerprints.delete(observation.provider);
  logMainProcessInfo(
    `provider-auth: confirmed passive ${observation.provider} auth transition; preserving active turns (${reason})`,
  );
  notifyConfirmedProviderAuth(
    observation.provider,
    observation.status,
    fingerprint,
    'external_change',
  );
  await enqueueProviderInvalidation(observation.provider, reason, 'preserve');
}

export function resetProviderAuthStateForTests(): void {
  lastConfirmedFingerprints.clear();
  pendingConfirmedFingerprints.clear();
  confirmedProviderAuthListeners.clear();
  lastConfirmedSignedInEvents.clear();
  invalidationInFlight.clear();
  providersWithUnknownSessionBaseline.clear();
  indeterminateBaselineAtMs.clear();
  claudeAuthStatusCache = null;
  claudeAuthStatusRefresh = null;
  lastConfirmedClaudeAuthStatus = null;
  codexAuthStatusCache = null;
  codexAuthStatusRefresh = null;
  lastConfirmedCodexAuthStatus = null;
}

export function markProviderAuthSessionCreatedWithoutBaseline(
  provider: AuthObservedProvider,
): void {
  if (!lastConfirmedFingerprints.has(provider)) {
    providersWithUnknownSessionBaseline.add(provider);
  }
}

export async function ensureProviderAuthBaselineForSession(
  provider: AuthObservedProvider,
  reason: string,
): Promise<boolean> {
  if (lastConfirmedFingerprints.has(provider)) {
    return true;
  }

  // An indeterminate probe records NOTHING (see below), so the fingerprint
  // check above can never start short-circuiting for this provider. Without a
  // cooldown, a *stable* indeterminate state — a Codex custom `model_provider`
  // is permanent, not transient — makes every `getOrCreateSession`,
  // `sessionMatchesOptions`, and `canPreserveSessionCapabilitySnapshot` pay a
  // fresh UNCACHED probe (`checkCodexAuthStatus` is the raw
  // `admin().request('account/read')`, not the TTL-cached read), i.e. an
  // app-server round trip on essentially every message send.
  //
  // Reuse the provider status-cache TTL so the state still reconverges on its
  // own (a user who fixes their config is picked up within one window) while
  // the steady-state cost drops to at most one probe per TTL. The `catch` path
  // below deliberately does NOT take this cooldown: a thrown probe is genuinely
  // transient and should be retried on the next session check.
  const indeterminateAtMs = indeterminateBaselineAtMs.get(provider);
  if (
    indeterminateAtMs !== undefined &&
    Date.now() - indeterminateAtMs < INDETERMINATE_BASELINE_RETRY_TTL_MS
  ) {
    return false;
  }

  try {
    const status =
      provider === 'claude'
        ? await checkClaudeAuthStatus()
        : await checkCodexAuthStatus();
    // A *successful* probe can still be indeterminate (Codex custom
    // `model_provider`). Apply the same rule as `checkCodexAuthStatusObserved`:
    // never label an unknown `confirmed`, and never give it a fingerprint.
    //
    // (Note the fingerprint here was never a *wrong identity* — `fingerprintStatus`
    // returns the literal `'unauthenticated'` for both an indeterminate and a
    // confirmed logout. The defect being fixed is the `confidence` label.)
    const indeterminate = status.probeFailed === true;
    await observeProviderAuthStatus(
      {
        provider,
        status,
        confidence: indeterminate ? 'unknown' : 'confirmed',
        fingerprint: indeterminate
          ? null
          : provider === 'codex'
            ? fingerprintCodexAuthStatus(status)
            : fingerprintStatus(status),
      },
      reason,
    );
    if (indeterminate) {
      // `observeProviderAuthStatus` short-circuits on `'unknown'` and records
      // NOTHING, so no baseline exists. Without this marker a later real login
      // seeds the fingerprint as a first observation (`previous === undefined`),
      // enqueues no invalidation, and the live session keeps running against the
      // pre-login state. This is the same "session created without a baseline"
      // situation the `catch` path below handles, so it takes the same escape
      // hatch — reached via a successful-but-unknown probe rather than a throw.
      markProviderAuthSessionCreatedWithoutBaseline(provider);
      indeterminateBaselineAtMs.set(provider, Date.now());
      return false;
    }
    indeterminateBaselineAtMs.delete(provider);
    return true;
  } catch {
    markProviderAuthSessionCreatedWithoutBaseline(provider);
    return false;
  }
}

function buildClaudeAuthDetail(
  payload: Record<string, unknown>,
): string | null {
  const method = readString(payload, 'authMethod');
  const subscription = readString(payload, 'subscriptionType');
  if (method && subscription) {
    return `${method} (${subscription})`;
  }
  return method ?? subscription;
}

/**
 * Map a parsed `claude auth status --json` payload to the renderer-facing auth
 * status. Pure: takes the already-parsed record, so it is unit-testable without
 * spawning a binary or hitting the network.
 */
export function buildClaudeAuthStatusFromPayload(
  payload: Record<string, unknown>,
): AgentProviderAuthStatus {
  const authenticated = readBoolean(payload, 'loggedIn') === true;
  const email = readString(payload, 'email');
  const subscriptionType = readString(payload, 'subscriptionType');
  const authMethod = readString(payload, 'authMethod');
  let accountKind: AgentProviderAuthStatus['accountKind'] = 'unknown';
  if (authenticated) {
    if (subscriptionType) {
      accountKind = 'subscription';
    } else if (authMethod && /api[_\s-]*key/i.test(authMethod)) {
      accountKind = 'api_key';
    }
  }
  return {
    authenticated,
    accountLabel: email ?? readString(payload, 'orgName'),
    detail: buildClaudeAuthDetail(payload),
    error: authenticated ? null : 'Claude is not authenticated.',
    accountEmail: authenticated ? email : null,
    planType: authenticated ? subscriptionType : null,
    accountKind,
  };
}

async function fetchMockClaudeAuthStatus(
  origin: string,
): Promise<AgentProviderAuthStatus> {
  const payload = await fetchMockControlPlaneRecord(
    origin,
    '/__mock/claude/auth',
  );
  return buildClaudeAuthStatusFromPayload(payload);
}

/**
 * `claude auth status --json` reports the billing plan in `subscriptionType`
 * (pro / max / team / enterprise) but hides sub-plan tiers: Max collapses 5x and
 * 20x to a bare `max`, and Team collapses standard/premium seats to `team`. The
 * distinguishing signal lives in the OAuth `rateLimitTier` — a *rate-limit
 * bucket*, not a billing plan — so we consult it only for the ambiguous plans
 * and interpret it in the context of `subscriptionType`:
 *
 * - `max`  → use the raw bucket (`default_claude_max_20x` / `_5x`); the web
 *   catalog normalizes it to the Max 20x / 5x plan key.
 * - `team` → premium seats report `default_claude_max_5x`; emit an explicit
 *   `team-premium` / `team` seat plan-type rather than the raw bucket (which
 *   would otherwise be misread as a personal Max plan downstream).
 *
 * For every other plan `subscriptionType` is authoritative.
 */
async function enrichClaudePlanTypeWithTier(
  status: AgentProviderAuthStatus,
): Promise<AgentProviderAuthStatus> {
  if (!status.authenticated) {
    return status;
  }
  const subscriptionType = status.planType?.trim().toLowerCase() ?? '';
  if (subscriptionType !== 'team' && !subscriptionType.startsWith('max')) {
    return status;
  }
  try {
    const credentials = await readClaudeOauthPlanMetadata();
    const rateLimitTier = credentials?.rateLimitTier;
    return {
      ...status,
      planType:
        resolveClaudePlanType(subscriptionType, rateLimitTier ?? null) ??
        status.planType,
    };
  } catch {
    // Keep the subscriptionType-derived plan type below.
  }
  return status;
}

export async function checkClaudeAuthStatus(): Promise<AgentProviderAuthStatus> {
  if (__CANOPY_E2E__) {
    const mockOrigin = getMockLlmOrigin();
    if (!mockOrigin) {
      throw new Error(
        'E2E Claude auth probe requires CANOPY_MOCK_LLM_BASE_URL.',
      );
    }
    return fetchMockClaudeAuthStatus(mockOrigin);
  }

  const bundledExecutable = getBundledClaudeBinaryPath();
  const runProbe = (executable: string): Promise<{ stdout: string }> =>
    execFileAsync(executable, ['auth', 'status', '--json'], {
      timeout: AUTH_PROBE_TIMEOUT_MS,
      env: getEnhancedEnv({ environment: false }),
      windowsHide: process.platform === 'win32',
    });
  const runProbeWithTransientRetry = async (
    executable: string,
  ): Promise<{ stdout: string }> => {
    try {
      return await runProbe(executable);
    } catch (error: unknown) {
      // Claude CLI exits 1 for a normal signed-out state while still emitting
      // the authoritative JSON payload on stdout. Treat only an explicit
      // `loggedIn: false` payload as a successful auth observation; every
      // other non-zero exit remains an inconclusive probe failure.
      const confirmedLogoutStdout = readConfirmedClaudeLogoutStdout(error);
      if (confirmedLogoutStdout !== null) {
        return { stdout: confirmedLogoutStdout };
      }
      // Missing executables are deterministic. Other failures get one retry
      // for transient swaps, locks, and cold-start timeouts.
      if (isMissingExecutableError(error)) {
        throw error;
      }
      await delay(AUTH_PROBE_RETRY_BACKOFF_MS);
      try {
        return await runProbe(executable);
      } catch (retryError: unknown) {
        // The retry gets the same treatment as the first attempt: a transient
        // failure followed by Claude CLI's normal signed-out exit 1 is still an
        // authoritative logout. Without this, that ordering degrades to
        // `probeFailed`, the user is treated as natively authenticated, and the
        // raw `Please run /login` this path exists to prevent comes back.
        const retryLogoutStdout = readConfirmedClaudeLogoutStdout(retryError);
        if (retryLogoutStdout !== null) {
          return { stdout: retryLogoutStdout };
        }
        throw retryError;
      }
    }
  };

  const { stdout } = await runProbeWithTransientRetry(bundledExecutable);

  const payload: unknown = JSON.parse(stdout);
  if (!isRecord(payload)) {
    throw new Error('Invalid Claude auth status response.');
  }

  return enrichClaudePlanTypeWithTier(
    buildClaudeAuthStatusFromPayload(payload),
  );
}

export async function checkClaudeAuthStatusObserved(
  reason: string,
  options: { forceAuthenticatedInvalidation?: boolean } = {},
): Promise<AgentProviderAuthStatus> {
  try {
    const status = await checkClaudeAuthStatus();
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status,
        confidence: 'confirmed',
        fingerprint: fingerprintStatus(status),
        forceInvalidation:
          options.forceAuthenticatedInvalidation === true &&
          status.authenticated,
      },
      reason,
    );
    claudeAuthStatusCache = { status, checkedAtMs: Date.now() };
    lastConfirmedClaudeAuthStatus = status;
    return status;
  } catch (error: unknown) {
    // The probe itself failed — this is NOT a confirmed logout. Mark it
    // `probeFailed` so no consumer reads `authenticated: false` as signed out.
    //
    // CONTRACT: reaching this branch means there was no authoritative auth
    // answer. A genuine logout can be exit 0 or Claude CLI's normal exit 1,
    // provided stdout is valid JSON with an explicit `loggedIn: false` field;
    // both are handled by `checkClaudeAuthStatus` above. Only spawn, timeout,
    // malformed-output, and other inconclusive failures land here.
    //
    // The `error` string is user-visible (ProviderAuthPanel/AuthLoginModal), so
    // it must read as an inconclusive verification failure, not a confirmed
    // signed-out state — "not authenticated" is reserved for a real logout.
    const failureStatus: AgentProviderAuthStatus = {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: isMissingExecutableError(error)
        ? 'Claude CLI is not installed.'
        : 'Could not verify Claude authentication.',
      probeFailed: true,
    };
    await observeProviderAuthStatus(
      {
        provider: 'claude',
        status: failureStatus,
        confidence: 'unknown',
        fingerprint: null,
      },
      reason,
    );
    // Preserve the last *confirmed* status (authenticated/identity/plan) when
    // one exists, flagged `probeFailed`; otherwise cache the cold failure.
    // Retain from `lastConfirmedClaudeAuthStatus` (only ever written on a
    // successful probe) rather than the working cache — the cache is already
    // `probeFailed` after the first failure, so reading it here would blank out
    // the identity on the SECOND consecutive failure. Reading the dedicated
    // confirmed status keeps the identity across an arbitrarily long outage.
    const retained = lastConfirmedClaudeAuthStatus;
    const retainedConfirmed = retained != null;
    const cacheStatus: AgentProviderAuthStatus = retainedConfirmed
      ? { ...retained, probeFailed: true }
      : failureStatus;
    claudeAuthStatusCache = { status: cacheStatus, checkedAtMs: Date.now() };
    recordProviderAuthProbeFailure('claude', error, retainedConfirmed);
    return cacheStatus;
  }
}

export async function getCachedClaudeAuthStatusObserved(
  reason: string,
  options: {
    forceAuthenticatedInvalidation?: boolean;
    forceRefresh?: boolean;
    maxAgeMs?: number;
  } = {},
): Promise<AgentProviderAuthStatus> {
  const baseMaxAgeMs = options.maxAgeMs ?? CLAUDE_AUTH_STATUS_CACHE_TTL_MS;
  const maxAgeMs =
    claudeAuthStatusCache?.status.probeFailed === true
      ? Math.min(baseMaxAgeMs, PROBE_FAILURE_TTL_MS)
      : baseMaxAgeMs;
  if (
    options.forceRefresh !== true &&
    claudeAuthStatusCache &&
    Date.now() - claudeAuthStatusCache.checkedAtMs <= maxAgeMs
  ) {
    return claudeAuthStatusCache.status;
  }

  if (claudeAuthStatusRefresh) {
    return claudeAuthStatusRefresh;
  }

  claudeAuthStatusRefresh = checkClaudeAuthStatusObserved(reason, {
    forceAuthenticatedInvalidation: options.forceAuthenticatedInvalidation,
  }).finally(() => {
    claudeAuthStatusRefresh = null;
  });
  return claudeAuthStatusRefresh;
}

function codexAccountToAuthStatus(
  response: GetAccountResponse,
): AgentProviderAuthStatus {
  const account = response.account;
  if (account?.type === 'chatgpt') {
    return {
      authenticated: true,
      accountLabel: account.email,
      detail: account.planType,
      error: null,
      accountEmail: account.email,
      planType: account.planType,
      workspaceName: account.workspaceName,
      accountKind: 'subscription',
    };
  }

  if (account?.type === 'apiKey') {
    return {
      authenticated: true,
      accountLabel: 'API key',
      detail: null,
      error: null,
      accountEmail: null,
      planType: null,
      accountKind: 'api_key',
    };
  }

  if (account?.type === 'amazonBedrock') {
    return {
      authenticated: true,
      accountLabel: 'Amazon Bedrock',
      detail: null,
      error: null,
      accountEmail: null,
      planType: null,
      accountKind: 'bedrock',
    };
  }

  // No account. Only `requiresOpenaiAuth` distinguishes a CONFIRMED logout from
  // an INDETERMINATE state, and conflating the two is a money bug (ECW-9091):
  // since a confirmed `authenticated: false` now force-routes onto the user's
  // AI Credits in every mode, an indeterminate state read as "signed out"
  // silently bills a user who has their own working provider. The canonical
  // example is a custom `model_provider` with `requires_openai_auth = false`
  // (Azure / self-hosted / proxy): `account/read` returns
  // `{ account: null, requiresOpenaiAuth: false }`, which
  // `buildCodexAccountUsageSummary` already models as `authState: 'unknown'`.
  //
  // `probeFailed` is the existing contract for "this `false` is not confirmed"
  // (see `AgentProviderAuthStatus`), so the indeterminate branch carries it and
  // every fail-closed consumer — `isProviderNativelyAuthenticated`,
  // `peekProviderNativeAuthAvailability`, the renderer's `probeFailed →
  // loading` mapping — treats it as unknown rather than signed out.
  if (response.requiresOpenaiAuth) {
    return {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Codex is not authenticated.',
      accountEmail: null,
      planType: null,
      accountKind: 'unknown',
    };
  }

  return {
    authenticated: false,
    accountLabel: null,
    detail: null,
    error: 'Codex authentication status is unknown.',
    accountEmail: null,
    planType: null,
    accountKind: 'unknown',
    probeFailed: true,
    // The probe SUCCEEDED — this answer is stable, not a blip. Retrying cannot
    // change it, so the probe-failure retry TTL must not apply or a custom
    // `model_provider` account would re-probe ~10x more often, forever.
    probeRetryable: false,
  };
}

async function readCodexAccountAuthStatus(): Promise<AgentProviderAuthStatus> {
  if (__CANOPY_E2E__) {
    const mockOrigin = getMockLlmOrigin();
    if (!mockOrigin) {
      throw new Error(
        'E2E Codex auth probe requires CANOPY_MOCK_LLM_BASE_URL.',
      );
    }
    const payload = await fetchMockControlPlaneRecord(
      mockOrigin,
      '/__mock/codex/account',
    );
    const parsed = parseGetAccountResponsePayload(payload);
    if (!parsed) {
      throw new Error('Codex auth mock returned an invalid account payload');
    }
    return codexAccountToAuthStatus(parsed);
  }

  const response = await getCodexRuntimeService()
    .admin()
    .request('account/read', { refreshToken: false });
  const parsed = parseGetAccountResponsePayload(response);
  if (!parsed) {
    throw new Error('Codex app-server returned an invalid account payload');
  }
  return codexAccountToAuthStatus(parsed);
}

export async function checkCodexAuthStatus(): Promise<AgentProviderAuthStatus> {
  // The shared app-server is the authoritative account source. A failed
  // account/read is inconclusive: falling back to another process can touch
  // the same credential store and can misclassify a transient token failure as
  // a confirmed account transition.
  return readCodexAccountAuthStatus();
}

/** Accept only a fresh account read made while the runtime's login lease is held. */
export function verifiedCodexAccountStatus(
  response: unknown,
): AgentProviderAuthStatus {
  const parsed = parseGetAccountResponsePayload(response);
  if (!parsed) throw new Error('Could not verify Codex authentication.');
  const status = codexAccountToAuthStatus(parsed);
  if (status.probeFailed || !status.authenticated)
    throw new Error('Could not verify Codex authentication.');
  const fingerprint = fingerprintCodexAuthStatus(status);
  return { ...status, authFingerprint: fingerprint };
}

/** The managed lease has already applied invalidation; commit without yielding. */
export function commitVerifiedCodexAccount(
  verified: AgentProviderAuthStatus,
): AgentProviderAuthStatus {
  const fingerprint =
    verified.authFingerprint ?? fingerprintCodexAuthStatus(verified);
  const previous = lastConfirmedFingerprints.get('codex');
  lastConfirmedFingerprints.set('codex', fingerprint);
  pendingConfirmedFingerprints.delete('codex');
  logMainProcessInfo(
    'provider-auth: applying explicit codex auth transition (managed-sign-in)',
  );
  codexAuthStatusCache = { status: verified, checkedAtMs: Date.now() };
  lastConfirmedCodexAuthStatus = verified;
  invalidateCodexSpeedCatalog('auth-transition');
  if (previous !== fingerprint)
    notifyConfirmedProviderAuth('codex', verified, fingerprint, 'in_app');
  return verified;
}

export function acceptVerifiedCodexAccount(
  response: unknown,
): Promise<AgentProviderAuthStatus> {
  try {
    return Promise.resolve(
      commitVerifiedCodexAccount(verifiedCodexAccountStatus(response)),
    );
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

export async function checkCodexAuthStatusObserved(
  reason: string,
  options: {
    forceAuthenticatedInvalidation?: boolean;
    /**
     * Successful external login flows must cut over the shared app-server
     * before probing; otherwise `account/read` can briefly return the old
     * in-memory identity and rate-limit reads can fail with its invalid token.
     */
    prepareExplicitTransitionBeforeProbe?: boolean;
  } = {},
): Promise<AgentProviderAuthStatus> {
  let explicitInvalidationApplied = false;
  try {
    if (
      options.prepareExplicitTransitionBeforeProbe === true &&
      options.forceAuthenticatedInvalidation === true
    ) {
      await enqueueProviderInvalidation('codex', reason, 'interrupt');
      explicitInvalidationApplied = true;
      await getCodexRuntimeService()
        .admin()
        .suspendWorkersForExternalAuthChange();
      // A catalog refetched while old workers drained could still describe
      // the previous account; start over now that they are gone.
      invalidateCodexSpeedCatalog('auth-transition');
    }
    const status = await checkCodexAuthStatus();
    // A *successful* `account/read` can still be indeterminate — see
    // `codexAccountToAuthStatus`. Such a status must be observed with the same
    // confidence as a thrown probe: not `confirmed`, no fingerprint (so it
    // never reads as an account transition), and it must NOT overwrite
    // `lastConfirmedCodexAuthStatus`, which exists to preserve the last
    // genuinely confirmed identity across inconclusive reads.
    const indeterminate = status.probeFailed === true;
    const fingerprint = indeterminate
      ? null
      : fingerprintCodexAuthStatus(status);
    const rendererStatus: AgentProviderAuthStatus = {
      ...status,
      authFingerprint: fingerprint,
    };
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: rendererStatus,
        confidence: indeterminate ? 'unknown' : 'confirmed',
        fingerprint,
        forceInvalidation:
          !explicitInvalidationApplied &&
          options.forceAuthenticatedInvalidation === true &&
          status.authenticated,
        explicitInvalidationApplied,
      },
      reason,
    );
    codexAuthStatusCache = { status: rendererStatus, checkedAtMs: Date.now() };
    if (!indeterminate) {
      lastConfirmedCodexAuthStatus = rendererStatus;
    }
    return rendererStatus;
  } catch (error: unknown) {
    // The probe itself failed — treat as unknown, never a confirmed logout.
    // Same CONTRACT as the Claude path: a genuine logout is a *successful*
    // probe (the app-server `account/read` confirms `false` before any CLI
    // fallback can throw), so only spawn/timeout/parse failures reach here.
    // The `error` string is user-visible, so it must read as an inconclusive
    // verification failure, not a confirmed signed-out state.
    const failureStatus: AgentProviderAuthStatus = {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: isMissingExecutableError(error)
        ? 'Codex CLI is not installed.'
        : 'Could not verify Codex authentication.',
      probeFailed: true,
    };
    await observeProviderAuthStatus(
      {
        provider: 'codex',
        status: failureStatus,
        confidence: 'unknown',
        fingerprint: null,
      },
      reason,
    );
    // Preserve the last *confirmed* status when one exists, flagged
    // `probeFailed`; otherwise cache the cold failure. Retain from
    // `lastConfirmedCodexAuthStatus` (written only on a successful probe) so a
    // second consecutive failure does not blank out the identity — see the
    // Claude path for the full rationale.
    const retained = lastConfirmedCodexAuthStatus;
    const retainedConfirmed = retained != null;
    const cacheStatus: AgentProviderAuthStatus = retainedConfirmed
      ? { ...retained, probeFailed: true }
      : failureStatus;
    codexAuthStatusCache = { status: cacheStatus, checkedAtMs: Date.now() };
    recordProviderAuthProbeFailure('codex', error, retainedConfirmed);
    return cacheStatus;
  }
}

/**
 * TTL-cached, deduped Codex auth status. Mirrors
 * {@link getCachedClaudeAuthStatusObserved}: `checkCodexAuthStatus()` spawns a
 * throwaway app-server on every call, which is far too expensive to run on
 * every session spawn, so the observed status is cached for a short TTL and a
 * concurrent burst of callers shares a single in-flight refresh.
 */
export async function getCachedCodexAuthStatusObserved(
  reason: string,
  options: {
    forceAuthenticatedInvalidation?: boolean;
    forceRefresh?: boolean;
    maxAgeMs?: number;
  } = {},
): Promise<AgentProviderAuthStatus> {
  const baseMaxAgeMs = options.maxAgeMs ?? CODEX_AUTH_STATUS_CACHE_TTL_MS;
  // Shorten the TTL to retry a FAILED probe soon — but only when retrying could
  // change the answer. A stable unknown (`probeRetryable: false`, i.e. a custom
  // `model_provider` account) keeps the normal TTL; clamping it would poll ~10x
  // more often, permanently, to re-learn the same answer.
  const maxAgeMs =
    codexAuthStatusCache?.status.probeFailed === true &&
    codexAuthStatusCache.status.probeRetryable !== false
      ? Math.min(baseMaxAgeMs, PROBE_FAILURE_TTL_MS)
      : baseMaxAgeMs;
  if (
    options.forceRefresh !== true &&
    codexAuthStatusCache &&
    Date.now() - codexAuthStatusCache.checkedAtMs <= maxAgeMs
  ) {
    return codexAuthStatusCache.status;
  }

  if (codexAuthStatusRefresh) {
    return codexAuthStatusRefresh;
  }

  codexAuthStatusRefresh = checkCodexAuthStatusObserved(reason, {
    forceAuthenticatedInvalidation: options.forceAuthenticatedInvalidation,
  }).finally(() => {
    codexAuthStatusRefresh = null;
  });
  return codexAuthStatusRefresh;
}

/**
 * True iff the user is natively authenticated to the given provider, read from
 * the provider's TTL-cached observed auth status. Used by the AI Credits
 * routing decision so a session with no native login is force-routed through
 * credits. A Codex API key (`accountLabel === 'API key'`) is native auth and
 * therefore counts as authenticated — it must NOT trigger credit routing.
 *
 * Deliberate asymmetry: a `probeFailed` status returns `true` (fail **closed**
 * toward the user's subscription). A false negative here silently bills the
 * user's credits on an unreliable probe; a false positive merely lets the
 * native session surface its own auth error. So an inconclusive probe stays on
 * the native path rather than force-routing to credits.
 */
export async function isProviderNativelyAuthenticated(
  provider: Extract<AgentProviderType, 'claude' | 'codex'>,
  reason: string,
): Promise<boolean> {
  const status =
    provider === 'claude'
      ? await getCachedClaudeAuthStatusObserved(reason)
      : await getCachedCodexAuthStatusObserved(reason);
  if (status.probeFailed === true) {
    // Includes the ENOENT (missing-binary) case, which is also flagged
    // `probeFailed`. That is deliberate: a missing bundled binary is treated as
    // fail-closed toward the subscription (return `true`, stay on the native
    // path) rather than force-routing to credits. The native session then
    // surfaces its own explicit spawn error, which is the correct place for a
    // "binary missing" failure to appear — silently billing credits because a
    // binary was absent would be the worse outcome.
    return true;
  }
  return status.authenticated;
}

/**
 * Cheap, synchronous projection of native provider availability for the Portal
 * chat-summary entity (CAN-1217). Reads ONLY the module-level caches — never
 * spawns a probe — so it is safe to call on every chat-summary projection. A
 * provider key is set to the LAST OBSERVED `authenticated` value whenever a
 * cache entry exists (the TTL is intentionally NOT enforced here — a stale
 * value is preferred over blocking or omitting) and omitted only when the cache
 * is cold ("unknown"); Ollama is local and always usable. This is an optimistic
 * hint the portal reconciles against, not an authoritative gate. AI-credit
 * eligibility is renderer/cloud-derived and intentionally not projected here.
 */
export function peekProviderNativeAuthAvailability(): PortalChatProviderAvailability {
  const availability: PortalChatProviderAvailability = { ollama: true };
  // A `probeFailed` status is "unknown", not signed-out: omit the key (like a
  // cold cache) so Portal availability never asserts signed-out from a blip.
  if (
    claudeAuthStatusCache &&
    claudeAuthStatusCache.status.probeFailed !== true
  ) {
    availability.claude = claudeAuthStatusCache.status.authenticated;
  }
  if (
    codexAuthStatusCache &&
    codexAuthStatusCache.status.probeFailed !== true
  ) {
    availability.codex = codexAuthStatusCache.status.authenticated;
  }
  return availability;
}

/**
 * Whether the last Claude sign-in check settled without an answer while this
 * process has never confirmed a sign-in. A retained confirmed sign-in is
 * spread into the failure status, so `authenticated` is `true` whenever one
 * exists. Read-only and TTL-free, like
 * {@link peekProviderNativeAuthAvailability}; a cold cache is `false` (the
 * probe is still pending, not inconclusive).
 *
 * This only ranks the default lane a fresh chat is seeded with. Routing a
 * session that already runs a Claude model still fails closed toward the
 * subscription on the same answer ({@link isProviderNativelyAuthenticated}).
 */
export function peekClaudeAuthInconclusiveWithoutSignIn(): boolean {
  return (
    claudeAuthStatusCache !== null &&
    claudeAuthStatusCache.status.probeFailed === true &&
    claudeAuthStatusCache.status.authenticated !== true
  );
}

/**
 * Provider availability as projected to Portal worktree, App Advisor, and
 * Cowork chat surfaces: the native auth peek plus the managed Cursor runtime
 * state.
 *
 * Cursor is not an auth probe. The key reports whether the managed runtime is
 * connected (supported, enabled, installed) as last observed by the shared
 * preflight, and is omitted until that preflight has run once. It is kept out
 * of {@link peekProviderNativeAuthAvailability} on purpose: that peek is read
 * by provider-keyed billing/routing code that treats `false` as a confirmed
 * native logout.
 */
export function peekPortalProviderAvailability(): PortalChatProviderAvailability {
  const availability = peekProviderNativeAuthAvailability();
  availability.antigravity = getAntigravityModelEntries().length > 0;
  const opencode = peekOpenCodeRuntimeAvailability();
  if (opencode !== undefined) availability.opencode = opencode;
  const copilot = peekCopilotRuntimeAvailability();
  if (copilot !== undefined) availability.copilot = copilot;
  const cursor = peekCursorRuntimeAvailability();
  if (cursor !== undefined) availability.cursor = cursor;
  return availability;
}

/**
 * {@link peekProviderNativeAuthAvailability}, but the cache TTL IS enforced.
 *
 * The unqualified peek deliberately prefers a stale value over blocking, which
 * is right for an optimistic Portal hint and wrong for anything that DESTROYS
 * state on a negative. The lane resolver erases a stored `lastResolvedDefault-
 * Lane` record whenever a native lane reads `false`, and with lazy probing it
 * can reach that decision for a lane it never probed — so it needs "this
 * process confirmed the lane dead, recently", not "the cache once said so".
 *
 * A key is omitted when the cache is cold, when it holds a `probeFailed`
 * (unknown) status, or when the entry has aged past its TTL.
 */
export function peekFreshProviderNativeAuthAvailability(): PortalChatProviderAvailability {
  const availability: PortalChatProviderAvailability = { ollama: true };
  const now = Date.now();
  if (
    claudeAuthStatusCache &&
    claudeAuthStatusCache.status.probeFailed !== true &&
    now - claudeAuthStatusCache.checkedAtMs <= CLAUDE_AUTH_STATUS_CACHE_TTL_MS
  ) {
    availability.claude = claudeAuthStatusCache.status.authenticated;
  }
  if (
    codexAuthStatusCache &&
    codexAuthStatusCache.status.probeFailed !== true &&
    now - codexAuthStatusCache.checkedAtMs <= CODEX_AUTH_STATUS_CACHE_TTL_MS
  ) {
    availability.codex = codexAuthStatusCache.status.authenticated;
  }
  return availability;
}

/**
 * Derive the stable per-account attribution key for a provider auth status.
 *
 * Returns `` `${provider}:${normalizedEmail}` `` only when the status is an
 * authenticated subscription login with an email. API-key and Bedrock logins
 * (and any status without an email) return `null` — those turns stay
 * unattributed rather than being lumped under a synthetic account.
 */
export function deriveProviderAccountKey(
  provider: AuthObservedProvider,
  status: AgentProviderAuthStatus,
): string | null {
  if (!status.authenticated || status.accountKind !== 'subscription') {
    return null;
  }
  const email = status.accountEmail?.trim().toLowerCase();
  if (!email) {
    return null;
  }
  return `${provider}:${email}`;
}

export interface ProviderAccountIdentity {
  providerAccountKey: string;
  accountEmail: string;
  planType: string | null;
}

/**
 * Synchronously read the cached auth status for a provider and derive its
 * subscription-account identity, **ignoring the cache TTL**. This is safe
 * because switching accounts changes the provider auth fingerprint, which
 * destroys any live session — so a live session's account is stable for its
 * lifetime and a stale-but-present cache entry still reflects the driving
 * account. Returns `null` when nothing is cached yet or the cached status is
 * not an attributable subscription login.
 */
export function peekProviderAccountIdentity(
  provider: AuthObservedProvider,
): ProviderAccountIdentity | null {
  const cache =
    provider === 'claude' ? claudeAuthStatusCache : codexAuthStatusCache;
  if (!cache) {
    return null;
  }
  const providerAccountKey = deriveProviderAccountKey(provider, cache.status);
  const accountEmail = cache.status.accountEmail?.trim();
  if (!providerAccountKey || !accountEmail) {
    return null;
  }
  return {
    providerAccountKey,
    accountEmail,
    planType: cache.status.planType ?? null,
  };
}

/** How a provider's cached login is authenticated. */
export type ProviderBillingAccountKind = NonNullable<
  AgentProviderAuthStatus['accountKind']
>;

/**
 * Synchronously read how the cached auth status for a provider is
 * authenticated, **ignoring the cache TTL**, for the same reason
 * {@link peekProviderAccountIdentity} may: a live session's account is stable
 * for its lifetime. Performs no I/O and never probes the provider. Returns
 * `'unknown'` when nothing is cached yet, the cached status is signed out, or
 * the kind was not determined.
 */
export function peekProviderBillingAccountKind(
  provider: AuthObservedProvider,
): ProviderBillingAccountKind {
  const cache =
    provider === 'claude' ? claudeAuthStatusCache : codexAuthStatusCache;
  if (!cache || !cache.status.authenticated) {
    return 'unknown';
  }
  return cache.status.accountKind ?? 'unknown';
}

/**
 * Fire-and-forget warm of the provider auth cache so a subsequent
 * {@link peekProviderAccountIdentity} at finalize time can observe the driving
 * account. Never throws and never blocks the caller.
 */
export function warmProviderAccountIdentity(
  provider: AuthObservedProvider,
  reason: string,
): void {
  if (provider === 'claude') {
    void getCachedClaudeAuthStatusObserved(reason).catch(() => undefined);
  } else {
    void getCachedCodexAuthStatusObserved(reason).catch(() => undefined);
  }
}

/**
 * Fire-and-forget warm of the native-auth cache at app startup (ECW-9091).
 * Since a missing native login now force-routes through AI Credits, every
 * Claude/Codex spawn awaits an auth probe; a cold probe costs up to
 * `AUTH_PROBE_TIMEOUT_MS` plus backoff and one retry. Prewarming moves that cost
 * off the first message. Never throws and never blocks the caller.
 *
 * **Claude by default, deliberately.** The Codex probe goes through
 * `getCachedCodexAuthStatusObserved` → `admin().request('account/read')`, and
 * `admin()` resolves a pooled profile anchor — so warming Codex unconditionally
 * would spawn an app-server process at *every* launch, including for the many
 * users who never open a Codex chat. Claude is the default provider
 * (`DEFAULT_MODEL = DEFAULT_CLAUDE_MODEL`) and therefore the reported
 * first-message path, and its probe is a comparatively cheap CLI read.
 *
 * Codex stays lazy for everyone else: the first Codex session spawns the
 * app-server anyway, so the probe rides on a process that turn already needed.
 * That costs a credits-only Codex user one cold probe on their first message —
 * latency, not correctness, and the fail-closed contract means an inconclusive
 * probe stays native.
 *
 * The ONE caller that passes `'codex'` is the startup path in `index.ts`, and
 * only on positive evidence that this user's default lane really is
 * `codex-native` (a persisted `lastResolvedDefaultLaneByScope` entry). An
 * unknown/absent lane — a first-ever launch above all — must NOT warm Codex.
 */
export function prewarmProviderNativeAuthStatus(
  provider: AuthObservedProvider = 'claude',
): void {
  warmProviderAccountIdentity(provider, 'native-auth-prewarm');
}

/**
 * Whether startup may warm the CODEX probe for this user.
 *
 * POSITIVE evidence only. A `!== 'claude-native'` test also matches `undefined`
 * — every first-ever launch, plus every credits-only or Ollama user — and would
 * spawn a Codex app-server at launch for all of them, which is exactly what the
 * "Claude by default" note above exists to avoid.
 */
export function shouldPrewarmCodexNativeAuthAtStartup(
  preferences: Pick<
    PreferencesData,
    'lastResolvedDefaultLane' | 'lastResolvedDefaultLaneByScope'
  >,
): boolean {
  const byScope = preferences.lastResolvedDefaultLaneByScope;
  return (
    byScope?.chat === 'codex-native' ||
    byScope?.worktree === 'codex-native' ||
    // Legacy scope-agnostic slot, for a preferences file written before the
    // per-scope map existed and not yet normalized through a read.
    preferences.lastResolvedDefaultLane === 'codex-native'
  );
}

/**
 * How long a confirmed **authenticated** cache entry may be served to a routing
 * decision past its normal TTL while a background revalidation runs.
 */
const ROUTING_AUTH_STALE_WINDOW_MS = 300_000;

/**
 * Routing-decision variant of {@link isProviderNativelyAuthenticated} with an
 * asymmetric stale-cache fast path (ECW-9091).
 *
 * A cached, non-`probeFailed`, **authenticated** entry up to
 * {@link ROUTING_AUTH_STALE_WINDOW_MS} old returns `true` immediately,
 * scheduling a background revalidation once it is past the normal TTL. Every
 * other state — cold cache, `probeFailed`, cached `authenticated: false`, or
 * beyond the stale window — falls through to the authoritative probe.
 *
 * The asymmetry is the point: "stay native" is the common case and the safe
 * direction to be stale about, while the money-moving direction (routing a turn
 * onto the user's AI Credits) skips this extended window entirely.
 *
 * It is NOT, however, guaranteed to hit the wire: the fall-through calls
 * {@link isProviderNativelyAuthenticated}, which still serves the standard
 * `*_AUTH_STATUS_CACHE_TTL_MS` entry. So a cached `authenticated: false` can
 * bill up to that TTL of turns to credits after the user signs in *outside* the
 * app (terminal `claude /login`). In-app login is unaffected — it force-writes
 * the cache (`ipc/auth-terminal.ts`) — and the TTL is 30s, so the exposure is
 * bounded and strictly smaller than the stale window above.
 *
 * KNOWN COST, deliberately accepted: because the extended window only ever
 * serves a cached `true`, a credits-only user — whose cache is permanently
 * `authenticated: false` — gets no benefit from it. Every session spawn more
 * than `*_AUTH_STATUS_CACHE_TTL_MS` after the last one pays a real probe on the
 * session-start path to re-learn an answer that does not change. That is
 * bounded (per session spawn, not per turn) and the startup prewarm covers the
 * first message, but it is a new mandatory cost for exactly the default-path
 * user. Symmetrically extending the window to cached `false` would be wrong —
 * it is the money-moving direction. A cheaper negative short-circuit (e.g. a
 * credentials-file existence check before paying for the subprocess) is the
 * right follow-up; it is not attempted here because it adds a second, weaker
 * source of truth for auth state.
 *
 * Use this for routing decisions only. The rare backstop re-checks stay on
 * {@link isProviderNativelyAuthenticated} so an abort decision is authoritative.
 */
export async function isProviderNativelyAuthenticatedForRouting(
  provider: Extract<AgentProviderType, 'claude' | 'codex'>,
  reason: string,
): Promise<boolean> {
  const cache =
    provider === 'claude' ? claudeAuthStatusCache : codexAuthStatusCache;
  if (
    cache &&
    cache.status.probeFailed !== true &&
    cache.status.authenticated === true
  ) {
    const ageMs = Date.now() - cache.checkedAtMs;
    if (ageMs <= ROUTING_AUTH_STALE_WINDOW_MS) {
      const ttlMs =
        provider === 'claude'
          ? CLAUDE_AUTH_STATUS_CACHE_TTL_MS
          : CODEX_AUTH_STATUS_CACHE_TTL_MS;
      if (ageMs > ttlMs) {
        warmProviderAccountIdentity(provider, `${reason}:stale-revalidate`);
      }
      return true;
    }
  }
  return isProviderNativelyAuthenticated(provider, reason);
}
