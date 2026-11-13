import { normalizeModelGatewayBaseUrl } from '@canopy/protocol/canopy-server';
import {
  MODEL_LIBRARY_PROTOCOL_HEADER,
  MODEL_LIBRARY_PROTOCOL_VERSION,
} from '@canopy/protocol/models';
// AI Credits fallback routing helpers (CAN-838, B1a).
//
// Consumes the environment-neutral `@canopy/protocol/llm-gateway` model→harness
// registry and turns a selected model id + the user's cloud account into the
// per-session provider config (env + Codex `-c` args) that points a live Claude
// or Codex session at the apps/web LLM proxy. Routing is always session/tab
// scoped — these helpers build config on demand at session spawn and never
// mutate global process state.

import {
  AI_CREDITS_ATTRIBUTION_WORKSPACE_HEADER,
  AI_CREDITS_ATTRIBUTION_WORKTREE_HEADER,
  AI_CREDITS_ORG_PROJECT_HEADER,
  AI_CREDITS_WORK_OWNER_HEADER,
  type GatewayModelEntry,
  type WorkOwner,
} from '@canopy/protocol/llm-gateway';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { BRAND } from '@canopy/brand/current';
import type { AiGatewayHarness } from '@canopy/protocol/ai-gateway-models';
// Re-export the browser-safe alias bridge so existing call sites keep importing
// it from this module. The canonical implementation now lives in shared code so
// the renderer picker can consume it too (behavior unchanged). Also imported
// locally below for the generic routing-override resolver.
import {
  isUnavailableModelSelection,
  resolveGatewayModelEntry,
} from '@canopy/execution-engine/lib/gateway-model-availability';
export {
  isRemovedGatewayOnlyModel,
  resolveGatewayModelEntry,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import type {
  AgentProviderType,
  AiCreditsRoutingMode,
  AiCreditsRoutingState,
  AiCreditsRoutingStatusEventData,
  AiCreditsNoBillingSourceEventData,
  AiCreditsUsageLimitEventData,
  ModelHarness,
} from '@canopy/desktop-shared/types';
import {
  AI_CREDITS_ROUTING_STATUS_EVENT_TYPE,
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE,
  AI_CREDITS_USAGE_LIMIT_EVENT_TYPE,
  buildAiCreditsRequiredError,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CREDITS_CODEX_MODEL,
  resolveModelAlias,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';
import type { CodexConfig } from '@canopy/execution-engine/lib/codex-model-config';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { aiCreditsOutrankAccountProxy } from '@canopy/desktop-shared/lib/account-proxy';
import { hasUserSuppliedProviderCredential } from './user-supplied-credential';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import {
  isCanopyCloudAccountReadDegraded,
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { readPreferencesFile } from '../lib/preferences-store';
import { loadNativeAiCreditsAvailability } from '../ipc/settings';
import { readWorkspaceIndexEntry } from '../lib/sidebar-items';
import {
  readWorkspaceOwnership,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import { isProviderNativelyAuthenticatedForRouting } from '../auth/provider-auth-state';
import { isProviderQuotaReached } from './ai-credits-quota-state';
import {
  billedProviderFor,
  effectiveTabAiCreditsRouting,
} from './effective-ai-credits-routing';
import { getCodexGatewayProxyService } from './codex-gateway-proxy-service';
import { createHash, randomUUID } from 'node:crypto';
import {
  loadModelGatewayCredential,
  markModelGatewayCredentialRejected,
} from '../lib/model-gateway-credential-store';
import {
  checkModelGatewayRoute,
  getModelGatewayRequirementForOwner,
} from '../lib/model-gateway-state';
import { getMockLlmOrigin } from '../lib/e2e-mock-control-plane';
import { sendToAllWindows } from '../lib/window-send';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  resolveBackgroundWorkOwner,
  resolveInvocationWorkOwner,
  resolveNavigationWorkOwner,
  resolveSessionWorkOwner,
  type WorkOwnerSession,
} from './work-owner';
import {
  CLAUDE_BROKER_ALLOWED_PATHS,
  CLAUDE_BROKER_ALLOWED_QUERIES,
  CLAUDE_BROKER_FORWARD_HEADERS,
  CODEX_BROKER_ALLOWED_PATHS,
  LOOPBACK_BROKER_AUTH_TOKEN,
} from './gateway-broker-routes';
import { resolveAccountProxySessionRoute } from '../account-proxy/routing';

/** Stable Codex provider id used for the AI Credits gateway provider block. */
export const AI_CREDITS_CODEX_PROVIDER_ID = 'canopy_ai_credits';
export const ORG_GATEWAY_CODEX_PROVIDER_ID = 'canopy_org_gateway';

/**
 * Resolved cloud context needed to both gate the in-chat fallback prompt
 * (credits eligible) and build the per-session proxy config.
 */
export interface AiCreditsRoutingContext {
  /** Canopy secret key (`csk_…`) used as the gateway bearer token. */
  cskToken: string;
  /** Stable, non-secret identity of the account that owns the token. */
  accountIdentity: string;
  /** Resolved cloud account email, when known. */
  email: string | null;
  /** True iff the account currently has a usable AI-credit balance. */
  creditsEligible: boolean;
  /** False when the availability loader returned fallback defaults. */
  creditsEligibilityKnown: boolean;
  /** Cloud base URL the proxy routes are appended to. */
  cloudBaseUrl: string;
  /**
   * True iff the token is a guest device credential. The proxy limits a guest
   * to the guest model allowlist, so the Claude route pins its side models.
   */
  guestPrincipal: boolean;
}

/** Codex provider config: env vars plus the validated `-c` override args. */
export interface CodexProxyConfig {
  env: Record<string, never>;
  /** `key=value` overrides applied via repeated `-c` app-server flags. */
  configOverrides: Record<string, string>;
  /** Gateway slug used as the Codex model id. */
  model: string;
}

/**
 * Workspace/worktree the routed session belongs to. Attached to proxy requests
 * (via provider custom headers) so the LLM proxy can label the AI-credit ledger
 * "AI usage" activity line with where the spend came from. Both optional — a
 * surface with no real workspace/worktree (e.g. App Advisor) or an unavailable
 * name simply omits it, and the ledger falls back to the plain "AI usage".
 *
 * `workOwner` is the owner bound when the work started (CAN-3456). Unlike the
 * display names it is sent on every routed surface, App Advisor included;
 * absent only when owner authority could not be read.
 */
export interface AiCreditsAttribution {
  workspaceName?: string;
  worktreeName?: string;
  workOwner?: WorkOwner;
  organizationProjectId?: string;
}

/**
 * `encodeURIComponent`-encoded [header, value] pairs for the present attribution
 * fields — encoding keeps the value ASCII-safe for a provider custom header; the
 * proxy decodes + sanitizes it. The current client protocol claim is always
 * included for the same compatibility context as native entitlements.
 */
export function attributionHeaderPairs(
  attribution: AiCreditsAttribution | undefined,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    [MODEL_LIBRARY_PROTOCOL_HEADER, String(MODEL_LIBRARY_PROTOCOL_VERSION)],
  ];
  if (!attribution) return pairs;
  if (attribution.workspaceName) {
    pairs.push([
      AI_CREDITS_ATTRIBUTION_WORKSPACE_HEADER,
      encodeURIComponent(attribution.workspaceName),
    ]);
  }
  if (attribution.worktreeName) {
    pairs.push([
      AI_CREDITS_ATTRIBUTION_WORKTREE_HEADER,
      encodeURIComponent(attribution.worktreeName),
    ]);
  }
  if (attribution.workOwner) {
    // `personal` / `org:<uuid>` is already ASCII-safe and is parsed verbatim
    // by the proxy, so it is deliberately not percent-encoded.
    pairs.push([
      AI_CREDITS_WORK_OWNER_HEADER,
      serializeWorkspaceContext(attribution.workOwner),
    ]);
  }
  if (attribution.organizationProjectId) {
    pairs.push([
      AI_CREDITS_ORG_PROJECT_HEADER,
      attribution.organizationProjectId,
    ]);
  }
  return pairs;
}

/**
 * Resolve the workspace name + worktree branch name for a routed session, for
 * ledger attribution. Best-effort and failure-safe: any read failure or missing
 * entry yields an empty/partial result — attribution is decorative and must
 * never fail a spawn. It is a blocking read (the caller awaits it before
 * building the proxy env), but the two lookups are parallelized and run on the
 * cold session-spawn path, so the added latency is acceptable. Read from the
 * persisted workspace index + worktree list.
 */
export async function resolveAiCreditsAttribution(
  projectId: string,
  worktreeId: string,
): Promise<AiCreditsAttribution> {
  const [indexEntry, worktrees, ownership] = await Promise.all([
    readWorkspaceIndexEntry(projectId).catch(() => null),
    readWorkspaceWorktrees(projectId).catch(() => []),
    readWorkspaceOwnership(projectId).catch(() => null),
  ]);
  const worktree = worktrees.find((entry) => entry.id === worktreeId);
  return {
    ...(indexEntry?.name ? { workspaceName: indexEntry.name } : {}),
    ...(worktree?.branchName ? { worktreeName: worktree.branchName } : {}),
    ...(ownership?.authority === 'ok' && ownership.owner
      ? { organizationProjectId: ownership.owner.projectId }
      : {}),
  };
}

/**
 * {@link resolveAiCreditsAttribution} plus the owner bound to the chat session
 * (see `captureSessionWorkOwner`), for interactive sessions.
 */
export async function resolveSessionAiCreditsAttribution(
  session: WorkOwnerSession,
): Promise<AiCreditsAttribution> {
  const [names, workOwner] = await Promise.all([
    resolveAiCreditsAttribution(session.projectId, session.worktreeId),
    resolveSessionWorkOwner(session),
  ]);
  return { ...names, ...(workOwner ? { workOwner } : {}) };
}

/**
 * Build the proxy base URL from the recommended local harness.
 */
export function buildProxyBaseUrl(
  cloudBaseUrl: string,
  harness: AiGatewayHarness,
): string {
  const base = cloudBaseUrl.replace(/\/+$/, '');
  // The Codex trailing `/responses` is NOT redundant. The app-server appends
  // its own `/responses` to whatever base URL it is given, so the wire path is
  // `.../llm-proxy/openai/responses/responses` — which is exactly what the
  // `openai/responses/[...path]` route allowlists. Dropping the segment here
  // 404s every credits-routed Codex turn.
  return harness === 'claude'
    ? `${base}/api/v1/llm-proxy/anthropic`
    : `${base}/api/v1/llm-proxy/openai/responses`;
}

/** Codex appends `/responses`, while an organization configures its gateway root. */
export function buildOrgGatewayCodexBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1`;
}

// The user-supplied-credential probe lives in its own leaf module so surfaces
// that must NOT import this one (the settings IPC handlers, which this module
// imports from) can consume it without closing an import cycle. Re-exported
// here because every existing caller — and every test mock — imports it from
// this module.
export { hasUserSuppliedProviderCredential };

/** Principal facts that change the Claude proxy env. */
export interface ClaudeProxyEnvOptions {
  /** The routed token is a guest credential (see `AiCreditsRoutingContext`). */
  guestPrincipal?: boolean;
}

/**
 * Claude Code variables that pick the model for aliases (`haiku`, `sonnet`,
 * `opus`), background work (titles, summaries, WebFetch) and subagents.
 */
const CLAUDE_SIDE_MODEL_ENV_NAMES = [
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

/**
 * Claude harness proxy env. Points the Claude binary at the gateway and swaps
 * its bearer for the Canopy secret key. `ANTHROPIC_API_KEY` is blanked so the
 * SDK uses `ANTHROPIC_AUTH_TOKEN` instead of a stored key.
 */
export function buildClaudeProxyEnv(
  entry: GatewayModelEntry,
  cskToken: string,
  cloudBaseUrl: string,
  attribution?: AiCreditsAttribution,
  options?: ClaudeProxyEnvOptions,
): Record<string, string> {
  return buildClaudeProxyEnvForBaseUrl(
    entry,
    cskToken,
    buildProxyBaseUrl(cloudBaseUrl, 'claude'),
    attribution,
    options,
  );
}

export function buildClaudeProxyEnvForBaseUrl(
  entry: GatewayModelEntry,
  authToken: string,
  proxyBaseUrl: string,
  attribution?: AiCreditsAttribution,
  options?: ClaudeProxyEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: proxyBaseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_API_KEY: '',
    // The gateway rejects the CLI's inline `tool_definition` blocks with a
    // `messages.N.content: Invalid input` the CLI cannot recognize, so it never
    // falls back and every later turn of the chat fails (CAN-4647). Deferred
    // tools are then announced by reference, which the gateway accepts.
    CLAUDE_CODE_INLINE_TOOLS: 'false',
  };
  if (options?.guestPrincipal === true) {
    // The proxy's guest gate checks each request body's raw `model` against
    // the guest allowlist. Claude Code sends side requests (aliases, titles,
    // summaries, WebFetch, subagents) on its built-in ids, which the gate
    // refuses mid-turn, so pin them all to the session's own gateway model.
    for (const name of CLAUDE_SIDE_MODEL_ENV_NAMES) {
      env[name] = entry.gatewayId;
    }
    // Without this, an agent whose frontmatter names a full model id still
    // sends that id instead of `CLAUDE_CODE_SUBAGENT_MODEL`. Like the names
    // above, it is read by the bundled Claude Code CLI, not by this repo.
    env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
  }
  if (!entry.gatewayId.startsWith('anthropic/')) {
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  }
  if (
    entry.origin === 'org-gateway' &&
    entry.promptCachePassthrough === false
  ) {
    env.DISABLE_PROMPT_CACHING = '1';
  }
  const attributionHeaders = attributionHeaderPairs(attribution);
  if (attributionHeaders.length > 0) {
    // Claude Code sends ANTHROPIC_CUSTOM_HEADERS (newline-separated
    // `Name: Value`) on every request to ANTHROPIC_BASE_URL (our proxy), which
    // reads them for ledger attribution and strips them before forwarding.
    env.ANTHROPIC_CUSTOM_HEADERS = attributionHeaders
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n');
  }
  return env;
}

/**
 * Register a parent-owned Claude route for an organization gateway. The child
 * receives only the loopback broker token, while each HTTP request reloads the
 * current credential and binds any rejection to that credential generation.
 */
export async function buildBrokeredOrgGatewayClaudeEnv(
  entry: GatewayModelEntry,
  sessionId: string,
  requestBaseUrl: string,
  attribution?: AiCreditsAttribution,
): Promise<Record<string, string>> {
  if (
    entry.origin !== 'org-gateway' ||
    !entry.organizationId ||
    !entry.baseUrl
  ) {
    throw new Error('The AI gateway route is incomplete.');
  }
  const organizationId = entry.organizationId;
  const route = await getCodexGatewayProxyService().registerRoute({
    sessionId,
    upstreamUrl: requestBaseUrl,
    allowedPaths: CLAUDE_BROKER_ALLOWED_PATHS,
    allowedQueries: CLAUDE_BROKER_ALLOWED_QUERIES,
    resolveToken: async () => {
      const refreshed = await loadModelGatewayCredential(organizationId);
      return refreshed &&
        refreshed.baseUrlAtSave === entry.baseUrl &&
        !refreshed.lastError
        ? {
            token: refreshed.apiKey,
            credentialVersion: refreshed.updatedAt,
          }
        : null;
    },
    forwardHeaders: CLAUDE_BROKER_FORWARD_HEADERS,
    stripCacheControl: entry.promptCachePassthrough === false,
    onCredentialRejected: (status, credentialVersion) =>
      markOrgGatewayCredentialRejected(
        organizationId,
        status,
        credentialVersion,
      ),
  });
  return buildClaudeProxyEnvForBaseUrl(
    entry,
    LOOPBACK_BROKER_AUTH_TOKEN,
    route.baseUrl,
    attribution,
  );
}

/**
 * Codex harness proxy config. Registers a dedicated model provider that speaks
 * the Responses API to the gateway with `requires_openai_auth=false`, and
 * selects the exact gateway ID as the model. The app-server receives only an
 * opaque loopback route; the parent injects the bearer token upstream.
 */
export function buildCodexProxyConfig(
  entry: GatewayModelEntry,
  proxyBaseUrl: string,
  attribution?: AiCreditsAttribution,
): CodexProxyConfig {
  const providerId =
    entry.origin === 'org-gateway'
      ? ORG_GATEWAY_CODEX_PROVIDER_ID
      : AI_CREDITS_CODEX_PROVIDER_ID;
  const providerName =
    entry.origin === 'org-gateway'
      ? 'Organization Gateway'
      : `${BRAND.displayName} AI Credits`;
  const configOverrides: Record<string, string> = {
    [`model_providers.${providerId}.name`]: providerName,
    [`model_providers.${providerId}.base_url`]: proxyBaseUrl,
    [`model_providers.${providerId}.wire_api`]: 'responses',
    [`model_providers.${providerId}.requires_openai_auth`]: 'false',
    model_provider: providerId,
    model: entry.gatewayId,
  };
  // Static per-provider headers the app-server sends to the gateway base URL
  // (our proxy), which reads them for ledger attribution and strips them before
  // forwarding. The header names are TOML-bare-key-safe (dashes allowed) and the
  // values are percent-encoded (no spaces/quotes), so the `-c` overrides parse.
  for (const [name, value] of attributionHeaderPairs(attribution)) {
    configOverrides[`model_providers.${providerId}.http_headers.${name}`] =
      value;
  }
  return {
    env: {},
    configOverrides,
    model: entry.gatewayId,
  };
}

/**
 * Nested thread-scoped Codex provider config. Mirrors
 * {@link buildCodexProxyConfig} without exposing parent credentials.
 */
export function buildCodexProxyConfigObject(
  entry: GatewayModelEntry,
  proxyBaseUrl: string,
  attribution?: AiCreditsAttribution,
): CodexConfig {
  const providerId =
    entry.origin === 'org-gateway'
      ? ORG_GATEWAY_CODEX_PROVIDER_ID
      : AI_CREDITS_CODEX_PROVIDER_ID;
  const httpHeaders: Record<string, string> = {};
  for (const [name, value] of attributionHeaderPairs(attribution)) {
    httpHeaders[name] = value;
  }
  return {
    model_provider: providerId,
    model: entry.gatewayId,
    model_providers: {
      [providerId]: {
        name:
          entry.origin === 'org-gateway'
            ? 'Organization Gateway'
            : `${BRAND.displayName} AI Credits`,
        base_url: proxyBaseUrl,
        wire_api: 'responses',
        requires_openai_auth: false,
        ...(Object.keys(httpHeaders).length > 0
          ? { http_headers: httpHeaders }
          : {}),
      },
    },
  };
}

/**
 * Short-lived cache for the resolved routing context. `getAiCreditsRoutingContext`
 * fires blocking cloud reads (account store + the native availability read, which
 * covers the personal balance and per-org spendable headroom), and it is called
 * once per routed session spawn; without this a burst of new sessions would each
 * re-hit the network. The TTL is intentionally small so credit exhaustion is
 * reflected quickly.
 */
const ROUTING_CONTEXT_CACHE_TTL_MS = 30_000;
const cachedRoutingContexts = new Map<
  string,
  {
    value: AiCreditsRoutingContext | null;
    degraded: boolean;
    expiresAt: number;
  }
>();
let routingContextGeneration = 0;

/** Clear the memoized routing context (test seam + explicit invalidation). */
export function clearAiCreditsRoutingContextCache(): void {
  cachedRoutingContexts.clear();
  routingContextGeneration += 1;
}

// Sign-in, sign-out, guest upgrade, and token replacement all flow through the
// account store. A cached signed-out result must not survive one of those
// writes: otherwise an immediately following turn reports no billing source
// until the routing TTL expires even though the new account can pay.
subscribeCanopyCloudAccountChanges((): void => {
  clearAiCreditsRoutingContextCache();
});

/**
 * Resolve the cloud context used to gate and build AI Credits routing. Returns
 * `null` when no cloud account / secret key is available or the cloud base URL
 * is not configured (routing cannot be built in either case). Results are
 * memoized for a short TTL to avoid redundant blocking cloud reads across a
 * burst of session spawns.
 */
export async function getAiCreditsRoutingContext(
  options: { owner?: WorkOwner; forceRefresh?: boolean } | boolean = {},
): Promise<AiCreditsRoutingContext | null> {
  return (await getAiCreditsRoutingContextWithStatus(options)).context;
}

/**
 * {@link getAiCreditsRoutingContext} plus whether a `null` context came from a
 * FAILED account read rather than a real sign-out.
 *
 * Callers that must distinguish the two — billing lane resolution — have to use
 * THIS, not the context plus a separate flag read. Writing the flag atomically
 * with the value is not sufficient: the resolver reads the context early and
 * does not need the status until much later, with the org-policy `Promise.all`
 * and the native auth probe loop (~20s on a cold cache) awaiting in between.
 * Any of the other `getAiCreditsRoutingContext()` callers — session spawns, the
 * startup prewarm, the `forceRefresh` sites — can land in that window and
 * rewrite a module-level flag, so a degraded resolution would read back
 * `false` and report a CONFIRMED dead credits lane. Returning both together
 * makes every call site correct by construction instead of by await-adjacency.
 */
export async function getAiCreditsRoutingContextWithStatus(
  options: { owner?: WorkOwner; forceRefresh?: boolean } | boolean = {},
): Promise<{ context: AiCreditsRoutingContext | null; degraded: boolean }> {
  const normalized =
    typeof options === 'boolean' ? { forceRefresh: options } : options;
  const forceRefresh = normalized.forceRefresh === true;
  const owner = normalized.owner;
  const cacheKey =
    owner?.kind === 'organization'
      ? `org:${owner.organizationId}`
      : owner?.kind === 'personal'
        ? 'personal'
        : 'missing';
  for (;;) {
    const now = Date.now();
    const cachedRoutingContext = cachedRoutingContexts.get(cacheKey);
    if (
      !forceRefresh &&
      cachedRoutingContext &&
      cachedRoutingContext.expiresAt > now
    ) {
      // A degraded read is never cached (see below), so a cache hit is always a
      // conclusive answer.
      return { context: cachedRoutingContext.value, degraded: false };
    }

    const generation = routingContextGeneration;
    const context = await loadAiCreditsRoutingContext(owner);
    if (generation !== routingContextGeneration) {
      // The account changed while this load was awaiting cloud state. Retry
      // against the current account rather than returning or caching a context
      // that belongs to the prior identity.
      continue;
    }
    // The degraded status is captured ATOMICALLY with the value it qualifies.
    //
    // A process-global "was the last account read degraded?" flag cannot work
    // here: ~10 other main-process subsystems call `loadCanopyCloudAccount()`
    // (org billing, telemetry enforcement, portal sessions, feature-flag
    // targeting, …) and would rewrite it, while THIS value is memoized for its
    // own TTL. The two would then be read at different instants and disagree in
    // both directions — a later successful read elsewhere would re-mark a cached
    // degraded `null` as a CONFIRMED dead lane, and an unrelated degraded read
    // would pin a genuine sign-out at UNKNOWN so the dead-end banner never shows.
    const degraded = context === null && isCanopyCloudAccountReadDegraded();
    // A degraded read is NOT memoized: it carries no usable routing information,
    // and caching it would hold the credits lane at UNKNOWN for the full TTL
    // after the keychain recovers. Re-reading on the next call makes recovery
    // immediate.
    // A confirmed unfunded account can receive purchased or daily credits
    // without changing account identity. Do not retain a negative answer:
    // the next normal Send must re-read eligibility rather than refuse the
    // restored draft until the 30-second routing TTL expires (CAN-5348).
    if (degraded || context?.creditsEligible === false) {
      cachedRoutingContexts.delete(cacheKey);
    } else {
      cachedRoutingContexts.set(cacheKey, {
        value: context,
        degraded: false,
        expiresAt: now + ROUTING_CONTEXT_CACHE_TTL_MS,
      });
    }
    return { context, degraded };
  }
}

async function loadAiCreditsRoutingContext(
  owner?: WorkOwner,
): Promise<AiCreditsRoutingContext | null> {
  const account = await loadCanopyCloudAccount();
  if (!account) {
    return null;
  }
  const cskToken = account.apiKey.trim();
  if (!cskToken) {
    return null;
  }

  let cloudBaseUrl: string;
  try {
    cloudBaseUrl = getCanopyCloudBaseUrl();
  } catch {
    return null;
  }

  // Native availability signal (CAN-1235): on-quota routing must activate for
  // org-covered members with spendable headroom too, not just users with a
  // personal (native or already-linked UD) balance. `personalEligible` is
  // source-agnostic; `orgSpendable` mirrors the gateway org-pool spend gate.
  //
  // The org half is already gated per-org (CAN-2311): `orgSpendable` is an
  // `.some()` over `loadOrgAiCreditsSpendable`, which reports no coverage for
  // an org that has lost the `teams` capability. So a lapsed org contributes
  // nothing here while the user's healthy orgs still make routing eligible —
  // do NOT add an account-wide lapse check at this layer, it would turn a
  // per-org gate into a kill switch.
  const availability = await loadNativeAiCreditsAvailability(owner);
  const accountIdentity =
    account.account?.id ??
    account.serverApiKeyId ??
    createHash('sha256').update(cskToken).digest('hex');
  return {
    cskToken,
    accountIdentity,
    email: account?.account?.email ?? null,
    creditsEligible: availability.personalEligible || availability.orgSpendable,
    creditsEligibilityKnown: availability.inconclusive !== true,
    cloudBaseUrl,
    // Same guest signal the default-model lane uses, so lane and spawn agree.
    guestPrincipal: isGuestAccount(account),
  };
}

/** Fire-and-forget warm of the native AI Credits availability/context cache. */
export function prewarmAiCreditsAvailability(): void {
  void resolveNavigationWorkOwner()
    .then((owner) => getAiCreditsRoutingContext({ owner }))
    .catch(() => undefined);
}

/**
 * Cache for the `aiCreditsRoutingMode` preference. The routing decision is
 * consulted on *every* session spawn across all chat surfaces, and spawn is a
 * timing-sensitive path, so the read must never block on `preferences.json`
 * disk I/O. Resolution is therefore stale-while-revalidate (mirroring
 * `getLoginShellPath`): the cached value is returned immediately (or `'off'`
 * before the first resolution) while an expired cache triggers a background
 * refresh. `prewarmAiCreditsRoutingMode()` warms it at startup and the
 * preference-save hook updates it in place, so in practice the cache is warm
 * before the first spawn.
 */
const ROUTING_MODE_CACHE_TTL_MS = 10_000;
let cachedRoutingMode: {
  value: AiCreditsRoutingMode;
  expiresAt: number;
} | null = null;
let routingModeRefreshInFlight = false;
const routingModeListeners = new Set<() => void>();

/** Keep source-dependent usage projections in step with the routing choice. */
export function subscribeAiCreditsRoutingModeChanges(
  listener: () => void,
): () => void {
  routingModeListeners.add(listener);
  return () => {
    routingModeListeners.delete(listener);
  };
}

function notifyRoutingModeChanged(): void {
  for (const listener of Array.from(routingModeListeners)) {
    try {
      listener();
    } catch (error: unknown) {
      logMainProcessError('AI Credits routing mode listener failed', error);
    }
  }
}

/**
 * Seed/refresh the cached routing mode synchronously (startup prewarm result,
 * preference-save keep-warm, and test seam).
 */
export function setAiCreditsRoutingModeCache(mode: AiCreditsRoutingMode): void {
  const previousMode = cachedRoutingMode?.value ?? 'off';
  cachedRoutingMode = {
    value: mode,
    expiresAt: Date.now() + ROUTING_MODE_CACHE_TTL_MS,
  };
  if (mode !== previousMode) notifyRoutingModeChanged();
}

/** Clear the memoized routing mode (test seam + explicit invalidation). */
export function clearAiCreditsRoutingModeCache(): void {
  const previousMode = cachedRoutingMode?.value ?? 'off';
  cachedRoutingMode = null;
  if (previousMode !== 'off') notifyRoutingModeChanged();
}

function refreshRoutingModeInBackground(): void {
  if (routingModeRefreshInFlight) {
    return;
  }
  routingModeRefreshInFlight = true;
  void (async (): Promise<void> => {
    try {
      const preferences = await readPreferencesFile();
      setAiCreditsRoutingModeCache(preferences.aiCreditsRoutingMode ?? 'off');
    } catch {
      // Keep the prior cache; the reader falls back to `'off'` when cold.
    } finally {
      routingModeRefreshInFlight = false;
    }
  })();
}

/**
 * Warm the routing-mode cache at startup so the first session spawn reads a warm
 * value instead of the `'off'` cold default. Fire-and-forget; never blocks.
 */
export function prewarmAiCreditsRoutingMode(): void {
  refreshRoutingModeInBackground();
}

function getAiCreditsRoutingMode(): AiCreditsRoutingMode {
  const now = Date.now();
  if (cachedRoutingMode && cachedRoutingMode.expiresAt > now) {
    return cachedRoutingMode.value;
  }
  refreshRoutingModeInBackground();
  return cachedRoutingMode?.value ?? 'off';
}

/**
 * Decide whether a session should route through AI Credits, honoring both the
 * per-session override and the global preference. This is the single decision
 * point consulted by every chat surface's spawn path.
 *
 * - Per-session `active` (from a chat surface that threaded per-tab state, e.g.
 *   a manual "just this time" activation) always wins and carries its optional
 *   `modelId` override.
 * - Global `aiCreditsRoutingMode === 'on'` routes every session from the start.
 * - Global `aiCreditsRoutingMode === 'on-quota'` routes once the given
 *   provider's native quota has been reached (fed from the common provider
 *   event streams via `ai-credits-quota-state`).
 *
 * Because this is the single decision point every surface's spawn path consults,
 * on/on-quota apply uniformly to worktree chat, standalone (cowork), App
 * Advisor, the pipeline editor, plan review, and any future surface without
 * per-surface wiring.
 *
 * Returns the effective model-id override (per-session `modelId` when set, else
 * undefined so the caller falls back to the session model), or `null` when
 * routing should not be attempted. Harness/credit-eligibility gating still
 * happens in the caller after this returns non-null.
 */
/**
 * Emit the authoritative "is this session routing through AI Credits" status to
 * the renderer via the session event stream. Both providers call this once per
 * session spawn (after resolving routing), so a single target-keyed renderer
 * store can drive the shared status banner on every chat surface. `active`
 * reflects whether routing was actually applied (credits eligible + harness
 * match), not merely the mode/quota decision; `accountProxyRouted` whether the
 * account proxy serves the session, so account and limit surfaces follow it.
 */
export function emitAiCreditsRoutingStatus(
  emit: (data: unknown) => void | Promise<void>,
  provider: AgentProviderType,
  active: boolean,
  accountProxyRouted = false,
): void | Promise<void> {
  const event: AiCreditsRoutingStatusEventData = {
    type: AI_CREDITS_ROUTING_STATUS_EVENT_TYPE,
    active,
    ...(accountProxyRouted ? { accountProxyRouted: true } : {}),
    provider,
  };
  return emit(event);
}

/**
 * Emit a usage-limit-reached signal to the renderer via the session event
 * stream, so the shared usage-limit banner surfaces on every chat surface —
 * including ones (App Advisor) whose transcript never runs renderer-side
 * quota detection. Fed from the common provider `emitEvent` choke point, which
 * already detects native quota exhaustion (CAN-838).
 */
export function emitAiCreditsUsageLimitReached(
  emit: (data: unknown) => void | Promise<void>,
  provider: AgentProviderType,
  resetsAt?: number,
): void | Promise<void> {
  const event: AiCreditsUsageLimitEventData = {
    type: AI_CREDITS_USAGE_LIMIT_EVENT_TYPE,
    provider,
    ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt)
      ? { resetsAt }
      : {}),
  };
  return emit(event);
}

/** Emit the distinct runtime signal for a marked hosted billing-source 402. */
export function emitAiCreditsNoBillingSource(
  emit: (data: unknown) => void | Promise<void>,
  provider: AgentProviderType,
): void | Promise<void> {
  const event: AiCreditsNoBillingSourceEventData = {
    type: AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE,
    provider,
  };
  return emit(event);
}

/**
 * Whether AI Credits were chosen over the account proxy: an explicit "AI
 * Credits for this chat", or the global mode set to always route through AI
 * Credits. A per-chat subscription choice keeps the global mode from applying,
 * as it does for routing itself. `on-quota` does not count: it reacts to the
 * user's own plan running out, and the proxy's accounts are not that plan
 * (CAN-4090).
 */
export function isAiCreditsChosenOverAccountProxy(
  aiCreditsRouting: AiCreditsRoutingState | undefined,
  subscriptionBillingOverride?: boolean,
): boolean {
  // The renderer's AI Credits alerts read the same rule, so they show what
  // this decides.
  return aiCreditsOutrankAccountProxy({
    chatChoseAiCredits: aiCreditsRouting?.active === true,
    routingMode: getAiCreditsRoutingMode(),
    subscriptionBillingOverride,
  });
}

export function resolveAiCreditsRoutingActivation(
  storedAiCreditsRouting: AiCreditsRoutingState | undefined,
  provider: AgentProviderType,
): { modelId?: string } | null {
  const aiCreditsRouting = effectiveTabAiCreditsRouting(
    storedAiCreditsRouting,
    billedProviderFor(provider),
  );
  if (aiCreditsRouting?.active) {
    return { modelId: aiCreditsRouting.modelId };
  }
  const mode = getAiCreditsRoutingMode();
  if (mode === 'on') {
    return {};
  }
  if (mode === 'on-quota' && isProviderQuotaReached(provider)) {
    return {};
  }
  return null;
}

/**
 * Why a session is being routed through AI Credits.
 *
 * - `session-override` — a chat surface threaded a per-tab "just this time"
 *   activation (carries its optional `modelId`).
 * - `mode` — the global `aiCreditsRoutingMode` (`on`, or `on-quota` after the
 *   provider's native quota is reached) triggered routing.
 * - `no-native-auth` — the user has no native login for the selected provider,
 *   so routing is enabled regardless of the global mode. `off` only suppresses
 *   *pre-emptive* routing for a user who still has a native session to bill
 *   (ECW-9091).
 */
export interface AiCreditsRoutingAttempt {
  modelId?: string;
  reason: 'session-override' | 'mode' | 'no-native-auth';
}

/**
 * Async wrapper over {@link resolveAiCreditsRoutingActivation} that adds the
 * per-chat subscription override and the `no-native-auth` trigger. Precedence
 * is **subscription-override → session-override → mode → no-native-auth**:
 *
 * 1. `subscriptionBillingOverride` (the user explicitly picked "My
 *    subscription") forces a native attempt for Claude/Codex, even if a cached
 *    auth or quota probe says it cannot succeed. A failed native attempt is
 *    surfaced as that failure, never silently replaced with paid credits.
 * 2. An active per-session `aiCreditsRouting` applies unless it is stale (see
 *    {@link effectiveTabAiCreditsRouting}) or superseded by that explicit
 *    subscription choice.
 * 3. The global `aiCreditsRoutingMode` (`on`, or `on-quota` once native quota
 *    is reached) routes.
 * 4. Absent a native login for a gateway-routable provider, routing is enabled
 *    (`no-native-auth`) in **every** mode, including `off` (ECW-9091). A
 *    credits-only account has no subscription for `off` to protect, and
 *    stranding it produced a raw `Please run /login` on the first message. A
 *    real native login still short-circuits to the native path first, so `off`
 *    keeps meaning "don't pre-emptively spend my credits" for subscribers.
 *
 * Native auth is injected as a callback so this module does not need to import
 * `provider-auth-state.ts`; an explicit subscription attempt skips the probe.
 *
 * Returns `null` when routing should not be attempted. Harness/credit
 * eligibility gating still happens in the caller after this returns non-null.
 */
export async function resolveAiCreditsRoutingAttempt(
  storedAiCreditsRouting: AiCreditsRoutingState | undefined,
  provider: AgentProviderType,
  isNativelyAuthenticated: () => Promise<boolean>,
  subscriptionBillingOverride?: boolean,
): Promise<AiCreditsRoutingAttempt | null> {
  const isGatewayProvider = provider === 'claude' || provider === 'codex';
  // The actual model and organization gateway requirements are checked by the
  // callers after this choice: a gateway-only model still has no native route.
  if (subscriptionBillingOverride && isGatewayProvider) return null;

  // Stale session routing (reset, account change or allowance restoration) falls
  // through to the rules below (CAN-4200).
  const aiCreditsRouting = effectiveTabAiCreditsRouting(
    storedAiCreditsRouting,
    billedProviderFor(provider),
  );
  // 2. Per-session "just this time" activation wins over automatic modes.
  if (aiCreditsRouting?.active) {
    return {
      ...(aiCreditsRouting.modelId !== undefined
        ? { modelId: aiCreditsRouting.modelId }
        : {}),
      reason: 'session-override',
    };
  }

  // 3. Global routing mode (`on` / `on-quota`). `aiCreditsRouting.active` is
  //    already handled above, so a non-null activation here is always mode-driven.
  const activation = resolveAiCreditsRoutingActivation(
    aiCreditsRouting,
    provider,
  );
  if (activation) {
    return {
      ...(activation.modelId !== undefined
        ? { modelId: activation.modelId }
        : {}),
      reason: 'mode',
    };
  }

  // Ollama and any future local provider are never gateway-routable, so a
  // missing native login for them must not force credit routing.
  if (!isGatewayProvider) {
    return null;
  }

  // 4. There is no native login to bill, so route through AI Credits regardless
  //    of the global mode (ECW-9091). `off` still suppresses *pre-emptive*
  //    routing for a user who has a native session to fall back on — that is
  //    what the check below preserves. It previously short-circuited above this
  //    point, stranding every credits-only account on a raw login error.
  //
  //    `isProviderNativelyAuthenticated` fails CLOSED toward the subscription:
  //    every inconclusive answer is flagged `probeFailed` and returns `true`.
  //    That covers a thrown probe (timeout, parse failure, missing
  //    binary/ENOENT) AND a *successful* read that is merely indeterminate —
  //    notably Codex `{ account: null, requiresOpenaiAuth: false }`, i.e. a
  //    custom `model_provider` that does not use OpenAI auth. A `false` reaching
  //    this line is therefore a CONFIRMED signed-out state, never a probe blip
  //    and never an unknown, so no extra confidence plumbing is required.
  if (await isNativelyAuthenticated()) {
    return null;
  }
  return { reason: 'no-native-auth' };
}

/**
 * Normalized per-provider AI Credits routing override, produced by
 * {@link resolveAiCreditsRoutingOverride}. This is the single bundle consumed
 * uniformly by interactive sessions (via the extracted shared middle),
 * in-process helpers, and — as plain serializable data — pipeline subprocesses.
 *
 * - `env` — provider proxy env. For Claude the `ANTHROPIC_*` proxy vars,
 *   including the real bearer token (the Claude SDK spawns a plain
 *   subprocess, so the child needs it directly). For Codex this is always
 *   `{}` (see `buildCodexProxyConfig`): the app-server child receives only an
 *   opaque loopback route with `requires_openai_auth: false`, and the parent
 *   injects the real bearer token upstream from the gateway proxy service —
 *   the token itself never reaches the Codex child's environment. Callers
 *   that redact secret values out of Codex step output still include this
 *   field for seam-symmetry/defense-in-depth (in case a future Codex routing
 *   mode ever does need to hand the child a real credential), not because it
 *   carries one today.
 * - `codexConfig` — nested provider block supplied on `thread/start`.
 */
export interface AiCreditsRoutingOverride {
  provider: 'claude' | 'codex';
  model: string;
  env: Record<string, string>;
  /** True when this exact invocation uses an organization-owned gateway. */
  modelGatewayRouted?: boolean;
  /**
   * True when the invocation goes to the account proxy (CAN-4020). It is
   * billed to a proxy account, not AI Credits, and keeps its native model id.
   */
  accountProxyRouted?: boolean;
  accountProxyConnectionId?: string;
  /** Stable proxy identity for continuations; set with `accountProxyRouted`. */
  accountProxyAccountKey?: string;
  codexConfig?: CodexConfig;
}

/** Options for {@link resolveAiCreditsRoutingOverride}. */
export interface ResolveAiCreditsRoutingOverrideOptions {
  requiredAccountProxyConnectionId?: string;
  checkpointProxyQuota?: boolean;
  signal?: AbortSignal;
  /** Preserve an explicit native billing choice for delegated child work. */
  subscriptionBillingOverride?: boolean;
  /**
   * Whether an absent native login may route this call through AI Credits.
   *
   * Defaults to `true`, matching the interactive session path: a credits-only
   * user's turn should work rather than fail with a raw `Please run /login`.
   *
   * Unattended callers should pass `false`. This resolver is also the entry
   * point for scheduled background work, and ECW-9091 removed the `off`-mode
   * short-circuit that used to make those calls no-ops for a user with no
   * native login. Without the opt-out, an automatic task can silently debit
   * credits with no user action — for a guest whose only balance was a small free grant,
   * the worktree-summary scheduler could consume the whole allowance before the
   * first message is sent, so the new no-billing-source backstop then fires on
   * the chat the user actually cares about. A background task that fails is
   * invisible and harmless; one that quietly spends the last credit is not.
   */
  allowNoNativeAuthFallback?: boolean;
  /**
   * Workspace whose Canopy Environments assignments apply, for the
   * user-supplied-credential guard. Optional — the environment has a global
   * per-runtime slot, so omitting this still resolves the globally-assigned
   * variables.
   */
  workspaceId?: string;
  /** Worktree whose branch name is attached to direct gateway requests. */
  worktreeId?: string;
  /** Runtime slot for that guard. Pipeline callers pass `'pipeline'`. */
  environmentRuntime?: 'agent' | 'pipeline';
  /**
   * Owner already bound by the invoking work, e.g. the parent chat session of
   * a delegation child. Wins over every other owner source.
   */
  workOwner?: WorkOwner | null;
  /**
   * Persisted `execution_context` of a pipeline run. Pipeline callers
   * (`environmentRuntime: 'pipeline'`) resolve the owner from it; every other
   * caller captures the navigation context when the invocation starts.
   */
  executionContext?: string;
  /**
   * Route key of the chat this work runs for, e.g. a delegation child's
   * parent. The account proxy keeps it on the parent's account when it can.
   */
  accountProxyParentSessionId?: string;
}

/**
 * Attribution for a {@link resolveAiCreditsRoutingOverride} invocation: the
 * workspace/worktree display names when a workspace is known, plus the owner
 * of the work, resolved once per invocation.
 */
export async function resolveRoutingOverrideAttribution(
  options: ResolveAiCreditsRoutingOverrideOptions,
): Promise<AiCreditsAttribution> {
  const target = {
    ...(options.workspaceId ? { projectId: options.workspaceId } : {}),
    ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
  };
  const hasBoundWorkOwner = Object.prototype.hasOwnProperty.call(
    options,
    'workOwner',
  );
  const [names, workOwner] = await Promise.all([
    options.workspaceId
      ? resolveAiCreditsAttribution(
          options.workspaceId,
          options.worktreeId ?? '',
        )
      : Promise.resolve<AiCreditsAttribution>({}),
    hasBoundWorkOwner
      ? Promise.resolve(options.workOwner ?? undefined)
      : options.environmentRuntime === 'pipeline'
        ? resolveBackgroundWorkOwner(target, options.executionContext)
        : resolveInvocationWorkOwner(target),
  ]);
  return { ...names, ...(workOwner ? { workOwner } : {}) };
}

export async function resolveOrgGatewayCredential(
  entry: GatewayModelEntry,
  owner: WorkOwner | undefined,
): Promise<{
  baseUrl: string;
  apiKey: string;
  credentialVersion: string;
}> {
  if (
    entry.origin !== 'org-gateway' ||
    !entry.organizationId ||
    !entry.baseUrl
  ) {
    throw new Error('The AI gateway route is incomplete.');
  }
  const account = await loadCanopyCloudAccount();
  const ownerOrganizationId =
    owner?.kind === 'personal'
      ? account?.personalOrganizationId
      : owner?.kind === 'organization'
        ? owner.organizationId
        : undefined;
  if (
    ownerOrganizationId?.toLowerCase() !== entry.organizationId.toLowerCase()
  ) {
    throw new Error('This model belongs to another AI gateway.');
  }
  const credential = await loadModelGatewayCredential(entry.organizationId);
  if (
    !credential ||
    normalizeModelGatewayBaseUrl(credential.baseUrlAtSave) !==
      normalizeModelGatewayBaseUrl(entry.baseUrl) ||
    credential.lastError
  ) {
    throw new Error('Add your AI gateway key in Providers before sending.');
  }
  return {
    baseUrl: entry.baseUrl,
    apiKey: credential.apiKey,
    credentialVersion: credential.updatedAt,
  };
}

/** Record a gateway-issued auth rejection and refresh every mounted key banner. */
export async function markOrgGatewayCredentialRejected(
  organizationId: string,
  status: 401 | 403,
  credentialVersion?: string,
  expectedAccountId?: string,
): Promise<void> {
  try {
    const rejection: Parameters<typeof markModelGatewayCredentialRejected> = [
      organizationId,
      `Gateway returned HTTP ${String(status)}.`,
      credentialVersion,
    ];
    if (expectedAccountId !== undefined) rejection[3] = expectedAccountId;
    const updated = await markModelGatewayCredentialRejected(...rejection);
    if (updated) {
      sendToAllWindows(
        IPC_CHANNELS.modelGatewayCredentialChanged,
        organizationId,
      );
    }
  } catch {
    // Rejection bookkeeping is best-effort and must not replace the provider's
    // actionable HTTP error when secure storage is unavailable or unwritable.
  }
}

/**
 * The single generic routing resolver. Reuses the #1216 primitives — the
 * attempt resolver (session-override → mode → automatic no-native-auth), the
 * browser-safe gateway model registry, and the short-TTL cloud context — to
 * produce a normalized override bundle, or `null` when routing should not apply.
 *
 * Native-capable models return `null` when routing is inactive or unavailable.
 * Gateway-only models instead force a route attempt and throw a clear error
 * when credits are unavailable, so helper and pipeline callers can never
 * launch them against a native provider by accident.
 */
export async function resolveAiCreditsRoutingOverride(
  model: string | undefined,
  provider: ModelHarness,
  routingState?: AiCreditsRoutingState,
  routeSessionId?: string,
  options: ResolveAiCreditsRoutingOverrideOptions = {},
): Promise<AiCreditsRoutingOverride | null> {
  if (provider !== 'claude' && provider !== 'codex') {
    return null;
  }
  const attributionPromise = resolveRoutingOverrideAttribution(options);
  const attribution = await attributionPromise;
  const gatewayRequirement = await getModelGatewayRequirementForOwner(
    attribution.workOwner,
    'resolveAiCreditsRoutingOverride',
  );
  const gatewayEnforced = gatewayRequirement.kind !== 'unrestricted';
  if (isUnavailableModelSelection(model, provider)) {
    throw new Error(
      'This model is no longer available. Pick another model to continue.',
    );
  }
  // Only AI Credits chosen for this chat or for every session beats the
  // account proxy the user turned on for this device. Stale session routing
  // is no choice, matching the attempt below (CAN-4200).
  const aiCreditsChosen = isAiCreditsChosenOverAccountProxy(
    effectiveTabAiCreditsRouting(routingState, provider),
    options.subscriptionBillingOverride,
  );
  if (options.requiredAccountProxyConnectionId && aiCreditsChosen) {
    throw new Error(
      'The account proxy connection for this continuation is unavailable.',
    );
  }
  if (!aiCreditsChosen) {
    const proxyRoute = await resolveAccountProxySessionRoute({
      harness: provider,
      requiredConnectionId: options.requiredAccountProxyConnectionId,
      signal: options.signal,
      checkpointQuota: options.checkpointProxyQuota,
      model,
      sessionId: routeSessionId ?? `ephemeral:${randomUUID()}`,
      ...(options.accountProxyParentSessionId
        ? { parentSessionId: options.accountProxyParentSessionId }
        : {}),
      resolveWorkOwner: () => Promise.resolve(attribution.workOwner),
    });
    if (proxyRoute) {
      return {
        provider,
        model:
          model ??
          (provider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL),
        env: { ...proxyRoute.env },
        accountProxyRouted: true,
        accountProxyAccountKey: proxyRoute.accountKey,
        accountProxyConnectionId: proxyRoute.accountKey.slice(
          'account-proxy:'.length,
        ),
        ...(proxyRoute.codexConfig
          ? { codexConfig: proxyRoute.codexConfig }
          : {}),
      };
    }
  }
  let nativeAuthPromise: Promise<boolean> | undefined;
  const checkNativeAuth = (): Promise<boolean> =>
    (nativeAuthPromise ??= isProviderNativelyAuthenticatedForRouting(
      provider,
      'ai-credits-routing',
    ));
  const resolvedAttempt = await resolveAiCreditsRoutingAttempt(
    routingState,
    provider,
    checkNativeAuth,
    options.subscriptionBillingOverride,
  );
  // Two independent reasons to drop a `no-native-auth` attempt here. Only that
  // reason is ever dropped — an explicit `on` / `on-quota` mode or a session
  // override is a user decision and still routes, and `gatewayOnly` below still
  // forces a route for a model that has no native path at all.
  //
  // 1. An unattended caller opted out, so a scheduled background task can never
  //    spend credits the user did not choose to spend.
  // 2. The user supplies their own provider credential through Canopy
  //    Environments, which the auth probe cannot see but the helper/pipeline
  //    spawn honors. The session paths apply the same guard; without it here,
  //    helper and pipeline spawns would suppress that credential and bill
  //    credits instead (ECW-9091 review rounds 5-6).
  const dropNoNativeAuth =
    resolvedAttempt?.reason === 'no-native-auth' &&
    !gatewayEnforced &&
    (options.allowNoNativeAuthFallback === false ||
      hasUserSuppliedProviderCredential(
        provider,
        options.workspaceId,
        options.environmentRuntime,
      ));
  const attempt = dropNoNativeAuth ? null : resolvedAttempt;
  // An omitted model needs a gateway default whenever credits routing is
  // requested, regardless of the activation reason.
  const selectedModel =
    attempt?.modelId ??
    model ??
    (attempt
      ? provider === 'claude'
        ? DEFAULT_CLAUDE_MODEL
        : DEFAULT_CREDITS_CODEX_MODEL
      : undefined);
  // Helpers pass the native default explicitly, including saved retired
  // aliases. Without native auth, use its credits counterpart while retaining
  // the selected model as the session's route-cache key.
  const entry =
    resolveGatewayModelEntry(selectedModel) ??
    (attempt &&
    !gatewayEnforced &&
    selectedModel !== undefined &&
    resolveModelAlias(selectedModel) === DEFAULT_CODEX_MODEL &&
    !(await checkNativeAuth())
      ? resolveGatewayModelEntry(DEFAULT_CREDITS_CODEX_MODEL)
      : undefined);
  const routeCheck = await checkModelGatewayRoute(
    selectedModel,
    attribution.workOwner,
  );
  if (!routeCheck.ok) throw new Error(routeCheck.message);
  const gatewayOnly = entry?.gatewayOnly === true;
  const enforcedOrgRoute = gatewayEnforced && entry?.origin === 'org-gateway';
  if (!attempt && !gatewayOnly && !enforcedOrgRoute) {
    return null;
  }
  if (!entry) {
    return null;
  }
  if (entry.origin === 'org-gateway') {
    const credential = await resolveOrgGatewayCredential(
      entry,
      attribution.workOwner,
    );
    // E2E builds route the declared HTTPS gateway through the deterministic
    // local provider surface. Production bundles fold this to the exact URL
    // delivered by the organization policy.
    const requestBaseUrl = getMockLlmOrigin() ?? credential.baseUrl;
    if (provider === 'claude') {
      return {
        provider,
        model: entry.gatewayId,
        modelGatewayRouted: true,
        env: await buildBrokeredOrgGatewayClaudeEnv(
          entry,
          routeSessionId ?? `ephemeral:${randomUUID()}`,
          requestBaseUrl,
          attribution,
        ),
      };
    }
    const route = await getCodexGatewayProxyService().registerRoute({
      sessionId: routeSessionId ?? `ephemeral:${randomUUID()}`,
      upstreamUrl: buildOrgGatewayCodexBaseUrl(requestBaseUrl),
      allowedPaths: CODEX_BROKER_ALLOWED_PATHS,
      resolveToken: async () => {
        const refreshed = await loadModelGatewayCredential(
          entry.organizationId ?? '',
        );
        return refreshed &&
          refreshed.baseUrlAtSave === entry.baseUrl &&
          !refreshed.lastError
          ? {
              token: refreshed.apiKey,
              credentialVersion: refreshed.updatedAt,
            }
          : null;
      },
      stripCacheControl: entry.promptCachePassthrough === false,
      onCredentialRejected: (status, credentialVersion) =>
        markOrgGatewayCredentialRejected(
          entry.organizationId ?? '',
          status,
          credentialVersion,
        ),
    });
    return {
      provider,
      model: entry.gatewayId,
      modelGatewayRouted: true,
      env: {},
      codexConfig: buildCodexProxyConfigObject(
        entry,
        route.baseUrl,
        attribution,
      ),
    };
  }
  // Resolve the immutable work owner before eligibility so the cache key and
  // every token refresh probe the same funding scope as the request header.
  const context = await getAiCreditsRoutingContext({
    owner: attribution.workOwner,
  });
  if (!context || !context.creditsEligible) {
    if (gatewayOnly) {
      throw new Error(buildAiCreditsRequiredError(BRAND.displayName));
    }
    return null;
  }
  if (provider === 'claude') {
    if (routeSessionId) {
      const route = await getCodexGatewayProxyService().registerRoute({
        sessionId: routeSessionId,
        upstreamUrl: buildProxyBaseUrl(context.cloudBaseUrl, 'claude'),
        allowedPaths: CLAUDE_BROKER_ALLOWED_PATHS,
        allowedQueries: CLAUDE_BROKER_ALLOWED_QUERIES,
        resolveToken: async () => {
          const refreshed = await getAiCreditsRoutingContext({
            owner: attribution.workOwner,
            forceRefresh: true,
          });
          return refreshed?.accountIdentity === context.accountIdentity
            ? refreshed.cskToken
            : null;
        },
        forwardHeaders: [
          'anthropic-beta',
          'anthropic-version',
          'user-agent',
          'x-stainless-arch',
          'x-stainless-lang',
          'x-stainless-os',
          'x-stainless-package-version',
          'x-stainless-retry-count',
          'x-stainless-runtime',
          'x-stainless-runtime-version',
          'x-stainless-timeout',
        ],
      });
      return {
        provider,
        model: entry.gatewayId,
        env: buildClaudeProxyEnvForBaseUrl(
          entry,
          LOOPBACK_BROKER_AUTH_TOKEN,
          route.baseUrl,
          attribution,
          { guestPrincipal: context.guestPrincipal },
        ),
      };
    }
    return {
      provider,
      model: entry.gatewayId,
      env: buildClaudeProxyEnv(
        entry,
        context.cskToken,
        context.cloudBaseUrl,
        attribution,
        { guestPrincipal: context.guestPrincipal },
      ),
    };
  }
  const route = await getCodexGatewayProxyService().registerRoute({
    sessionId: routeSessionId ?? `ephemeral:${randomUUID()}`,
    upstreamUrl: buildProxyBaseUrl(context.cloudBaseUrl, 'codex'),
    allowedPaths: CODEX_BROKER_ALLOWED_PATHS,
    resolveToken: async () => {
      const refreshed = await getAiCreditsRoutingContext({
        owner: attribution.workOwner,
        forceRefresh: true,
      });
      return refreshed?.accountIdentity === context.accountIdentity
        ? refreshed.cskToken
        : null;
    },
  });
  const proxy = buildCodexProxyConfig(entry, route.baseUrl, attribution);
  return {
    provider,
    model: entry.gatewayId,
    env: proxy.env,
    codexConfig: buildCodexProxyConfigObject(entry, route.baseUrl, attribution),
  };
}
