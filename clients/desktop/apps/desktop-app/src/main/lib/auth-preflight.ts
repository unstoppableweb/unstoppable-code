import { getCachedAccountMcpConnection } from '../canopy-cloud/mcp-connections';
import { readMcpAccountIndexEntry } from '../mcp/account-routing';
// ---------------------------------------------------------------------------
// Send-time authentication preflight (CAN-1814 PR 5).
//
// Refuses a turn whose REQUIRED dependencies are already known to be
// unauthenticated, before anything about that turn is persisted. It mirrors the
// billing/model-policy preflight in `portal/adapters/chat-adapter.ts`: same
// placement (before the user message and tab are written), same failure mode
// (refuse, never substitute), and the same rule that only a PROVABLE dead end
// refuses while everything unknown falls through to dispatch's own error.
//
// ## Zero network I/O — the load-bearing constraint
//
// Every read below is local: the encrypted MCP OAuth token store, the
// `mcp-servers/server-<id>.json` files, the preferences file, and the chat's
// own persisted selections. Nothing here POSTs, spawns, or opens a browser.
//
//   - CAN-399. `plugins/mcp-inventory.ts` infers whether an HTTP MCP server
//     needs OAuth by POSTing `initialize` upstream
//     (`probeMcpHttpOAuthRequirement`). Running that passively produced
//     repeated Linear auth prompts on window focus. A send preflight runs far
//     more often than a window focus, so it must never call it — which is
//     exactly why a server with no declared `oauth` block is left alone here
//     rather than probed (see `resolveMcpBlockers`).
//   - CAN-492. Unattended paths that reached an interactive login opened a
//     surprise browser. Nothing in a preflight may start an OAuth flow.
//
// A stale cache therefore yields a mid-turn failure instead of a refusal. That
// is the intended trade: PR 1/2/6 already turn a mid-turn auth failure into the
// same named recovery card and stop the turn, so being late is cheap while a
// probe storm on every keystroke-to-send is not.
// ---------------------------------------------------------------------------

import type {
  AuthDependencyFailure,
  AuthFailureClass,
} from '@canopy/protocol/auth-recovery';
import type {
  AgentProviderType,
  ChatSendAuthRefusal,
  ChatTabPluginSelections,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type {
  McpHttpAuthHandler,
  McpServerFile,
} from '@canopy/execution-engine/types/mcp-servers';
import { normalizeMcpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import { chatSurfaceUsesGlobalPluginDefaults } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  getMcpHttpAuthDefault,
  getMcpHttpAuthHandler,
} from '@canopy/execution-engine/lib/mcp-http-auth';
import { toAuthDiagnosticDetail } from '@canopy/execution-engine/agent-failures/auth-diagnostic-detail';
import { TurnAuthPreflightBlockedError } from './auth-preflight-error';
import { safeReadJsonAsync } from './fs-utils';
import { getMcpServerFilePath } from './paths';
import { readPreferencesFile } from './preferences-store';
import {
  getMcpOAuthAuthStatus,
  type McpOAuthAuthStatusResult,
} from '../mcp/oauth-token-store';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { resolveEffectivePluginSelectionRefs } from '../plugins/plugin-resolver';
import { MCP_ACCOUNT_RECONNECT_DETAIL } from '../mcp/account-copy';

export interface TurnAuthPreflightTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export interface TurnAuthPreflightInput {
  target: TurnAuthPreflightTarget;
  /**
   * The selections the TURN will run with — i.e. whatever the caller is about
   * to hand `dispatchWorktreeChatTurn`, not the tab's stored value.
   *
   * Judging a different set from the one dispatch resolves is the trap the
   * billing preflight documents at length (it once judged the `claude` lane
   * while dispatch ran `ollama`). The global default-plugin overlay is applied
   * here for the same reason: `worktree-chat-turn.ts` passes
   * `applyGlobalPluginDefaults: chatSurfaceUsesGlobalPluginDefaults(projectId)`
   * into the session, so a globally-defaulted MCP server is genuinely required
   * by the turn even though it appears nowhere in the tab's own selections.
   */
  pluginSelections?: ChatTabPluginSelections;
  /**
   * The provider the turn will run on, when the caller knows it.
   *
   * Used to exclude extensions that the provider cannot load. It does not
   * establish provider sign-in or billing eligibility.
   */
  providerType?: AgentProviderType;
}

/**
 * Thrown by {@link assertTurnAuthDependencies} when a turn's required
 * dependencies are already known-unauthenticated. Defined in a leaf module so
 * `chat-queue-service.ts` can recognize it without importing this one — see
 * `auth-preflight-error.ts`.
 */
export { TurnAuthPreflightBlockedError } from './auth-preflight-error';

/**
 * Translate a thrown preflight refusal into the typed IPC result, or `null`
 * when the error is anything else.
 *
 * `null` is load-bearing: an IPC handler that gets it must RETHROW. Only a
 * proven auth dead end becomes a refusal result; a dispatch failure, a
 * validation error, or an org-policy block keeps rejecting, so widening this
 * translator would silently convert unrelated errors into a reconnect card.
 */
export function describeTurnAuthRefusal(
  error: unknown,
): ChatSendAuthRefusal | null {
  if (!(error instanceof TurnAuthPreflightBlockedError)) return null;
  return { message: error.message, failures: [...error.failures] };
}

/**
 * Map a cached MCP OAuth token state onto a failure class, or `null` when the
 * state is not a confirmed authentication problem.
 *
 * `unsupported` / `not_configured` never appear for the servers this module
 * inspects (it filters to HTTP servers with a declared `oauth` block), and
 * `connected` is the healthy case.
 *
 * Of the three remaining, only `not_connected` and `error` are unconditional
 * dead ends — for those Canopy genuinely holds no usable credential, and both
 * are fixed by the same inline `mcp_oauth` reconnect, which is what makes them
 * safe to refuse on.
 *
 * `expired` IS CONDITIONAL, and treating it like the other two was a real
 * defect (CAN-1814 review). `getMcpOAuthAuthStatus` derives it from
 * `expiresAt <= Date.now()` alone; the resolver the proxy actually uses,
 * `getValidMcpAccessToken`, treats the same record as recoverable and performs
 * a `grant_type: 'refresh_token'` exchange that succeeds. Short-lived access
 * tokens plus refresh tokens are the MCP spec's recommended pattern, so
 * refusing on `expired` alone made every chat selecting such a server
 * unsendable roughly once per token lifetime — the exact repeated-reconnect
 * experience CAN-399 (this module's header) exists to prevent.
 *
 * So an expired token blocks only when NO refresh credential is stored, which
 * `canRefresh` reports off the record this read already decrypted — still a
 * cached-only read with zero network I/O.
 *
 * A terminal grant/client rejection writes `lastError`, so the next send
 * blocks via `reauthorization_required`. Temporary failures retain the grant
 * and back off; the proxy reports service unavailability instead of asking
 * the user to sign in again. The unrefreshable case is kept as a
 * blocker precisely because it never self-escalates that way —
 * `getValidMcpAccessToken` returns `null` without recording anything when
 * `refreshToken` is absent, so nothing would ever promote it to `error`.
 */
function mcpAuthFailureClass(
  auth: McpOAuthAuthStatusResult,
): AuthFailureClass | null {
  switch (auth.status) {
    case 'not_connected':
      return 'unauthenticated';
    case 'expired':
      return auth.canRefresh === true ? null : 'expired';
    case 'error':
      // A stored `lastError` is written by `recordMcpOAuthTokenError` when
      // acquisition or refresh requires reauthorization. A resource-server
      // 401 only expires the access token, leaving renewal available.
      return 'reauthorization_required';
    case 'connected':
    case 'unsupported':
    case 'not_configured':
      return null;
  }
}

/**
 * Read one server file. ASYNC deliberately: this runs on the Electron main
 * thread once per selected MCP server on every send, and `readFileSync` there
 * blocks the event loop (CAN-1814 review). Still purely local — see the
 * zero-network note in this module's header.
 */
async function readMcpServerFile(
  serverId: string,
): Promise<McpServerFile | null> {
  try {
    return normalizeMcpServerFile(
      await safeReadJsonAsync<unknown>(getMcpServerFilePath(serverId)),
      serverId,
    );
  } catch {
    // Unknown is not broken. `plugin-resolver.ts` warns and skips an
    // unreadable server, so the turn is not blocked on it either.
    return null;
  }
}

/**
 * Blockers contributed by the standalone MCP servers this chat has selected.
 *
 * This is the ONLY axis that can produce a blocker today, because it is the
 * only one where Canopy both owns the credential and can read its state
 * without touching the network:
 *
 *   - `command`/stdIO servers have no auth axis at all (`unsupported`).
 *   - HTTP servers whose effective handler is `provider` are authenticated by
 *     Claude/Codex against their own OAuth client; Canopy holds nothing to
 *     judge.
 *   - HTTP servers with NO declared `oauth` block might still require OAuth,
 *     but the only way to find out is the upstream `initialize` probe that
 *     caused CAN-399. They are left alone; the legacy regex fallback in
 *     `chatConnectionErrors.ts` remains their only signal, exactly as before.
 *   - A disabled config is skipped by `resolvePlugins`, so the turn does not
 *     require it and it must not block.
 *
 * Plugin-declared MCP servers are excluded for the same reason: their
 * credentials live in plugin config/env or with the provider, so there is no
 * Canopy-owned cached state to consult.
 */
/**
 * The blocker one selected MCP ref contributes, or `null` when it contributes
 * none. Every `null` below is a deliberate "cannot be proven broken from
 * cache", not an oversight — see {@link resolveMcpBlockers}.
 */
async function resolveMcpBlockerForRef(
  ref: { serverId: string; configId: string },
  selections: ChatTabPluginSelections,
  defaultHandler: McpHttpAuthHandler,
): Promise<AuthDependencyFailure | null> {
  const file = await readMcpServerFile(ref.serverId);
  if (!file) return null;
  const { definition } = file.server;
  if (definition.type !== 'http') return null;
  const config = file.server.configs.find((entry) => entry.id === ref.configId);
  if (!config?.enabled) return null;

  const indexEntry = await readMcpAccountIndexEntry(definition.id);
  const { handler } = getMcpHttpAuthHandler(
    selections,
    { kind: 'standalone', serverId: definition.id, configId: config.id },
    getMcpHttpAuthDefault(definition, indexEntry, defaultHandler),
  );
  if (handler === 'account') {
    const connection = await getCachedAccountMcpConnection({
      curatedKey: definition.curated?.key,
      accountConnectionId: indexEntry?.accountConnectionId,
      configId: config.id,
    });
    // Unknown cloud state is verified (or skipped) by the resolver. Never launch
    // local OAuth, even if the local definition also contains OAuth metadata.
    // A connection the user turned off is skipped there too; no sign-in fixes it.
    if (
      !connection ||
      connection.status === 'CONNECTED' ||
      connection.enabled === false
    )
      return null;
    return {
      dependencyClass: 'mcp',
      dependencyId: `${definition.id}:${config.id}`,
      displayName: definition.name,
      failureClass:
        connection.status === 'REAUTH_REQUIRED'
          ? 'reauthorization_required'
          : 'unauthenticated',
      recovery: {
        kind: 'settings_deeplink',
        target: { page: 'mcp-servers', serverId: definition.id },
      },
      detail: MCP_ACCOUNT_RECONNECT_DETAIL,
    };
  }
  if (handler === 'provider') return null;
  if (config.authToken || !definition.oauth) return null;

  // Purely local: reads the encrypted token store off disk. The `ForDefinition`
  // variant is deliberately NOT used — it CLEARS a token bound to a stale
  // upstream URL, and a read-only preflight must not mutate credential state as
  // a side effect of inspecting it. That case falls through to the mid-turn
  // path instead.
  const auth = await getMcpOAuthAuthStatus(definition.id, config.id).catch(
    (): McpOAuthAuthStatusResult => ({
      status: 'connected',
    }),
  );
  const failureClass = mcpAuthFailureClass(auth);
  if (!failureClass) return null;

  return {
    dependencyClass: 'mcp',
    dependencyId: `${definition.id}:${config.id}`,
    displayName: definition.name,
    failureClass,
    recovery: {
      kind: 'mcp_oauth',
      serverId: definition.id,
      configId: config.id,
    },
    ...(auth.lastError
      ? { detail: toAuthDiagnosticDetail(auth.lastError) }
      : {}),
  };
}

async function resolveMcpBlockers(
  selections: ChatTabPluginSelections,
  overlayPreferences: PreferencesData | undefined,
): Promise<AuthDependencyFailure[]> {
  const refs = await resolveEffectivePluginSelectionRefs(selections);
  if (refs.mcpServerRefs.length === 0) return [];

  // The overlay already read preferences for the surfaces it applies to; only
  // the app-managed surfaces it skips pay for a read here, and only when there
  // is actually a server to judge.
  const preferences =
    overlayPreferences ?? (await readPreferencesFile().catch(() => null));
  const defaultHandler = preferences?.mcpHttpAuthDefaultHandler ?? 'canopy';

  const seen = new Set<string>();
  const uniqueRefs = refs.mcpServerRefs.filter((ref) => {
    const dependencyId = `${ref.serverId}:${ref.configId}`;
    if (seen.has(dependencyId)) return false;
    seen.add(dependencyId);
    return true;
  });

  // Concurrent, not sequential: these are independent local reads and this runs
  // on the send path, so awaiting them one at a time made latency scale with
  // the number of selected servers for no reason. Order is preserved because
  // `Promise.all` resolves positionally, which keeps the checklist's primary
  // row stable.
  const resolved = await Promise.all(
    uniqueRefs.map((ref) =>
      resolveMcpBlockerForRef(ref, selections, defaultHandler),
    ),
  );
  return resolved.filter(
    (blocker): blocker is AuthDependencyFailure => blocker !== null,
  );
}

/**
 * Every dependency this turn is KNOWN to require and KNOWN to be unable to
 * authenticate, read from cache only.
 *
 * "Known to require" is the whole guard. A disconnected dependency the turn
 * does not need must never block it, so an axis that cannot be proven from
 * local state contributes nothing:
 *
 *   - PROVIDER. A signed-out Claude/Codex is not a dead end. `resolveAiCredits-
 *     RoutingAttempt` activates credits routing on `no-native-auth` in EVERY
 *     mode, including `off`, so "not natively authenticated" is the normal,
 *     working state of every credits-only account — refusing on it would break
 *     those users entirely. The one state that IS a dead end (no native lane
 *     AND no credits lane) is a BILLING verdict already owned by
 *     `resolveConcreteModelDispatchability`, and reaching it requires the
 *     provider CLI probe this module may not run. So no provider blocker is
 *     emitted here. `input.providerType` only excludes unloaded extension
 *     dependencies; it is not an authentication signal.
 *   - INTEGRATIONS. Nothing declares that a chat turn needs GitHub or Linear —
 *     `resolveGitHubTokenWithSource` / `resolveLinearToken` are consumed only
 *     by pipeline `secretEnv` — so no turn can be *known* to require them.
 *     Guessing here would be exactly the unrelated-dependency block this
 *     preflight forbids. (`resolveGitHubTokenWithSource` also shells out to
 *     `gh` on a cold cache, which this module may not do.)
 *
 *     CAN-1814 PR 4 settled the other half: integration blockers are detected
 *     MID-TURN, from the tool call that actually needed the integration, not
 *     ahead of it. GitHub has exactly one first-party chat surface —
 *     `WatchGitHubItems` — and its `not_authenticated` result is a structured
 *     verdict, so `canopy-tools/core.ts` publishes an `integration` failure
 *     from there. Linear has NO first-party chat surface at all: there is no
 *     Linear injected tool, and in a chat Linear is reached as an MCP server,
 *     which the `mcp` blockers above and the PR 1/2 mid-turn path already
 *     cover end to end. Do not add a Linear branch here or a first-party
 *     Linear chat detector; there is nothing for either to observe.
 */
export async function resolveTurnAuthBlockers(
  input: TurnAuthPreflightInput,
): Promise<AuthDependencyFailure[]> {
  const context = await resolveEffectiveChatPluginContext(
    input.pluginSelections,
    input.target,
    chatSurfaceUsesGlobalPluginDefaults(input.target.projectId),
  );
  return resolveMcpBlockers(context.selections, context.preferences);
}

/**
 * Refuse the send when a required dependency is already known-broken.
 *
 * Call BEFORE the tab, the user message, or any queue row is written — the
 * point of refusing at all is to not durably record a prompt that provably
 * cannot run. Failures inside the preflight itself are swallowed by the
 * individual reads above, so this throws only on a confirmed blocker.
 */
export async function assertTurnAuthDependencies(
  input: TurnAuthPreflightInput,
): Promise<void> {
  const failures = await resolveTurnAuthBlockers(input);
  if (failures.length === 0) return;
  throw new TurnAuthPreflightBlockedError(failures);
}
