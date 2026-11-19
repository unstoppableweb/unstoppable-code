import { waitForAccountProxyCapacity } from './quota-wait';
// Routes a Claude or Codex session through the connected account proxy
// (CAN-4020). The session's harness talks to an opaque loopback broker route;
// the broker sends this device's client key upstream, adds the session ids
// the proxy keys its account affinity on, and reports which account served
// each response. The harness child never sees the client key.

import { createHash } from 'node:crypto';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { resolveGatewayModelEntry } from '@canopy/execution-engine/lib/gateway-model-availability';
import { isOllamaModel } from '@canopy/desktop-shared/types';
import type { CodexConfig } from '@canopy/execution-engine/lib/codex-model-config';
import { getCodexGatewayProxyService } from '../agents/codex-gateway-proxy-service';
import {
  CLAUDE_BROKER_ALLOWED_PATHS,
  CLAUDE_BROKER_ALLOWED_QUERIES,
  CLAUDE_BROKER_FORWARD_HEADERS,
  CODEX_BROKER_ALLOWED_PATHS,
  LOOPBACK_BROKER_AUTH_TOKEN,
} from '../agents/gateway-broker-routes';
import { getModelGatewayRequirementForOwner } from '../lib/model-gateway-state';
import { recordAccountProxyResponse } from './attribution';
import { ACCOUNT_PROXY_CODEX_PROVIDER_ID } from './codex-provider';
import { isAccountProxyFlagEnabled } from './feature-flag';
import { ACCOUNT_PROXY_OPEN_SERVER_TOKEN } from './client-key';
import {
  accountProxyClientKeyVersion,
  getAccountProxyRouteTarget,
  loadAccountProxyClientKey,
  revealAccountProxyClientKey,
  reportAccountProxyClientKeyRejected,
  type AccountProxyHarness,
  type AccountProxyRouteTarget,
  accountProxyServingSignal,
  findAccountProxyAccount,
  isAccountProxyConnectionServing,
} from './service';

/** The request that runs a turn, per harness. */
const TURN_PATHS: Readonly<Record<AccountProxyHarness, string>> = {
  claude: '/v1/messages',
  codex: '/responses',
};

/**
 * A stable id for a session that does not reveal it: local session keys can
 * contain project and worktree names, and the proxy is a third party.
 */
function opaqueSessionId(sessionKey: string): string {
  return `canopy-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 32)}`;
}

export interface AccountProxySessionRoute {
  /** Claude: proxy env for the SDK child. Codex: empty. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Who serves the work, stable across resolutions: each one registers a new
   * loopback route, but the proxy connection stays the same until the user
   * connects elsewhere. Continuations compare it.
   */
  readonly accountKey: string;
  /** Codex only: the thread-scoped provider block. The model stays native. */
  readonly codexConfig?: CodexConfig;
}

export interface ResolveAccountProxySessionRouteOptions {
  /** A quota continuation must never fall back to another billing route. */
  readonly requiredConnectionId?: string;
  readonly signal?: AbortSignal;
  /** Agent steps persist their quota pause instead of keeping a request open. */
  readonly checkpointQuota?: boolean;
  readonly harness: AccountProxyHarness;
  readonly model: string | undefined;
  /** The broker route owner, also the attribution key. */
  readonly sessionId: string;
  /** The parent chat's session, for a subagent run in its own process. */
  readonly parentSessionId?: string;
  /** Resolved only when the proxy could take the session. */
  readonly resolveWorkOwner: () => Promise<WorkOwner | undefined>;
}

type AccountProxyRouteCheck = Pick<
  ResolveAccountProxySessionRouteOptions,
  'harness' | 'model' | 'resolveWorkOwner' | 'requiredConnectionId'
>;

/**
 * The proxy this session would go to, or null when it should use its usual
 * billing: the proxy is not set up for this harness, the model runs locally on Ollama or exists only on AI
 * Credits, or an organization requires its own gateway.
 */
async function checkAccountProxySessionRoute(
  options: AccountProxyRouteCheck,
  requireKnownAbsence = false,
): Promise<AccountProxyRouteTarget | null> {
  // Cheap checks first: with the flag off this costs a session nothing.
  if (!isAccountProxyFlagEnabled()) return null;
  // Local models stay on this device.
  if (isOllamaModel(options.model)) return null;
  if (resolveGatewayModelEntry(options.model)?.gatewayOnly === true) {
    return null;
  }
  // A proxy that cannot be checked is treated like one that cannot be
  // reached: the work uses its usual billing instead of failing.
  const target = await getAccountProxyRouteTarget(options.harness).catch(
    (error: unknown) => {
      if (requireKnownAbsence) throw error;
      return null;
    },
  );
  if (!target) return null;
  const gateway = await getModelGatewayRequirementForOwner(
    await options.resolveWorkOwner(),
    'resolveAccountProxySessionRoute',
  );
  return gateway.kind === 'unrestricted' ? target : null;
}

/**
 * Whether the proxy would take a session, without registering a route. The
 * session manager decides this once when it creates a session, so the
 * registry and the session agree on how the session is billed.
 */
export async function previewAccountProxySessionRoute(
  options: AccountProxyRouteCheck,
  requireKnownAbsence = false,
): Promise<boolean> {
  const target = await checkAccountProxySessionRoute(
    options,
    requireKnownAbsence,
  );
  return (
    target !== null &&
    (!options.requiredConnectionId ||
      target.connection.id === options.requiredConnectionId)
  );
}

/** The proxy route for one session, or null; see the check above. */
export async function resolveAccountProxySessionRoute(
  options: ResolveAccountProxySessionRouteOptions,
): Promise<AccountProxySessionRoute | null> {
  let target = await checkAccountProxySessionRoute(options);
  if (
    options.requiredConnectionId &&
    (!target || target.connection.id !== options.requiredConnectionId)
  ) {
    throw new Error(
      'The account proxy connection for this continuation is unavailable.',
    );
  }
  if (target?.noUsableAccounts) throw new Error(target.noUsableAccounts);
  if (target && target.readyAccounts === 0) {
    const waitingConnection = target.connection.id;
    await waitForAccountProxyCapacity(
      options.harness,
      waitingConnection,
      {},
      options.signal,
    );
    target = await checkAccountProxySessionRoute(options);
    if (!target || target.connection.id !== waitingConnection)
      throw new Error(
        'The account proxy connection for this continuation is unavailable.',
      );
  }
  if (!target) return null;
  const connectionId = target.connection.id;
  const sessionHeaders: Record<string, string> = target.keepChatOnOneAccount
    ? {
        'x-session-id': opaqueSessionId(options.sessionId),
        ...(options.parentSessionId
          ? { 'x-parent-session-id': opaqueSessionId(options.parentSessionId) }
          : {}),
      }
    : {};
  const route = await getCodexGatewayProxyService().registerRoute({
    sessionId: options.sessionId,
    upstreamUrl:
      options.harness === 'claude'
        ? target.connection.url
        : `${target.connection.url}/v1`,
    allowedPaths:
      options.harness === 'claude'
        ? CLAUDE_BROKER_ALLOWED_PATHS
        : CODEX_BROKER_ALLOWED_PATHS,
    allowedQueries:
      options.harness === 'claude' ? CLAUDE_BROKER_ALLOWED_QUERIES : [],
    forwardHeaders: [
      ...(options.harness === 'claude' ? CLAUDE_BROKER_FORWARD_HEADERS : []),
    ],
    // The harness's own session headers stay behind. CLIProxyAPI takes the
    // first identity it recognizes: for Claude that is Claude Code's session
    // in the request body, which keeps a chat and its in-process subagents on
    // one account; a delegated Claude child is its own Claude session and
    // keeps its own account. For Codex, Codex's headers would outrank
    // Canopy's ids, so without them the chat id and X-Parent-Session-ID keep
    // delegated Codex children on their parent's account.
    forwardCanopyHeaders: false,
    extraHeaders: sessionHeaders,
    // The proxy is the user's own; large context windows send bodies past
    // the hosted routes' 8 MiB ceiling.
    unlimitedRequestBody: true,
    // Requests in flight, and their retries, stop when the proxy on this
    // device stops serving, before its released port can be taken.
    upstreamSignal: accountProxyServingSignal,
    // Re-read per request so a replaced key applies to running sessions.
    resolveToken: async () => {
      // A stopped proxy on this device gets no key, so the broker forwards
      // nothing to the port it released.
      if (!isAccountProxyConnectionServing(target.connection)) return null;
      const clientKey = await loadAccountProxyClientKey(target.connection);
      if (!isAccountProxyConnectionServing(target.connection)) return null;
      if (clientKey === undefined) return null;
      if (clientKey === null) return ACCOUNT_PROXY_OPEN_SERVER_TOKEN;
      // Revealed last: a launch that ended meanwhile sends nothing.
      const token = revealAccountProxyClientKey(clientKey);
      if (token === null) return null;
      return {
        token,
        credentialVersion: accountProxyClientKeyVersion(clientKey),
      };
    },
    ...(options.checkpointQuota
      ? {}
      : {
          waitForQuotaRecovery: (signal: AbortSignal): Promise<void> =>
            waitForAccountProxyCapacity(
              options.harness,
              connectionId,
              {},
              signal,
            ),
        }),
    // A refused client key is checked and replaced before the next session
    // routes, so later sessions do not keep sending a revoked key.
    onCredentialRejected: (_status, credentialVersion) => {
      if (credentialVersion)
        reportAccountProxyClientKeyRejected(credentialVersion);
    },
    onUpstreamResponse: ({ status, path, headers }) => {
      recordAccountProxyResponse({
        sessionId: options.sessionId,
        connectionId,
        traceHeader: headers.get('x-cpa-trace-id'),
        lookupAccount: findAccountProxyAccount,
        // Only a turn that succeeded shows where the chat runs now. Claude
        // Code's token counts carry no session in the body, so the proxy can
        // answer them from another account, and a failed attempt may be
        // retried elsewhere; either would show a move that did not happen.
        movesChat:
          status >= 200 && status < 300 && path === TURN_PATHS[options.harness],
      });
    },
  });
  if (options.harness === 'claude') {
    return {
      accountKey: `account-proxy:${connectionId}`,
      env: {
        ANTHROPIC_BASE_URL: route.baseUrl,
        ANTHROPIC_AUTH_TOKEN: LOOPBACK_BROKER_AUTH_TOKEN,
        ANTHROPIC_API_KEY: '',
        // Either flag sends Claude Code to a cloud provider and skips the base
        // URL, so the chat would bill there while labelled as the proxy's.
        CLAUDE_CODE_USE_BEDROCK: '',
        CLAUDE_CODE_USE_VERTEX: '',
      },
    };
  }
  return {
    accountKey: `account-proxy:${connectionId}`,
    env: {},
    codexConfig: {
      model_provider: ACCOUNT_PROXY_CODEX_PROVIDER_ID,
      model_providers: {
        [ACCOUNT_PROXY_CODEX_PROVIDER_ID]: {
          name: 'Account proxy',
          base_url: route.baseUrl,
          wire_api: 'responses',
          requires_openai_auth: false,
        },
      },
    },
  };
}
