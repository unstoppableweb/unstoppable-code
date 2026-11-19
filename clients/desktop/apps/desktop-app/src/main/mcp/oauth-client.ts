import { isIP } from 'node:net';
import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import { classifyFetchFailure } from '@canopy/desktop-shared/node/lib/app-error-classification';
import { classifyError } from '@canopy/protocol/app-errors/classification';
import {
  createPkceChallenge,
  parseHttpUrl,
  parseDiscoveredOAuthUrl,
  parseDiscoveredPublicHttpsUrl,
  loopbackOriginOf,
  isTrustedOAuthEndpointPair,
  isTrustedOAuthEndpointPairForResource,
  parseTokenResponse,
  buildCanonicalResourceUrl,
  buildProtectedResourceMetadataUrls,
  parseProtectedResourceMetadata,
  buildAuthorizationServerMetadataUrls,
  parseAuthorizationServerMetadata,
  isAccessTokenFresh,
  buildOAuthDiscoveryHeaders,
  createCodeVerifier,
  isClientIdMetadataDocumentUrl,
  selectTokenEndpointAuthMethod,
  supportsClientIdMetadataDocument,
  supportsPkceS256,
  tokenEndpointClientAuthentication,
  type TokenEndpointAuthMethod,
  type TokenExchangeResult,
  type TokenRequestConfig,
  type ProtectedResourceMetadata,
  type AuthorizationServerMetadata,
} from '@canopy/mcp-oauth-core';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import { BRAND } from '@canopy/brand/current';
import {
  MCP_DESKTOP_OAUTH_REDIRECT_URIS,
  mcpDesktopClientMetadataDocumentPath,
} from '@canopy/protocol/mcp-servers';
import { loadRequiredNodeModule } from '@canopy/desktop-shared/node/lib/packaged-module-loader';
import type {
  McpServerConfigData,
  McpServerDefinitionData,
  StartMcpOAuthLoginResponse,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  clearMcpOAuthToken,
  getMcpOAuthToken,
  recordMcpOAuthTokenError,
  saveMcpOAuthTokenIfCurrent,
  type McpOAuthTokenRecord,
} from './oauth-token-store';
export type {
  AuthorizationChallenge,
  McpHttpOAuthProbeResult,
} from './oauth-probe';
import {
  probeMcpHttpOAuthRequirementUncached,
  type AuthorizationChallenge,
} from './oauth-probe';
import {
  recordE2eMcpOAuthAuthorizationLaunch,
  resolveE2eMcpOAuthFixtureUrl,
  resolveE2eMcpOAuthPublicAddresses,
} from './oauth-e2e-fixture';
import {
  fetchPinnedHttpGetResponse,
  fetchPinnedHttpResponse,
  type PinnedHttpAddress,
} from './pinned-http-fetch';
import { isNonPublicIpAddress } from './network-address';
import { writeMcpOAuthCallbackPage } from './oauth-callback-page';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import { noteMcpEgressHost } from '../local-only/mcp-egress-hosts';

const OAUTH_STATE_TTL_MS = 10 * 60_000;

const OAUTH_HTTP_TIMEOUT_MS = 30_000;
const MAX_METADATA_REDIRECTS = 5;

/**
 * Protected-resource origins whose Google OAuth flow uses Canopy's own
 * pre-registered "Desktop app" client.
 *
 * Google requires `client_secret` at token exchange even for installed-app
 * clients (a bare code exchange fails with `client_secret is missing`), while
 * documenting that the value "is obviously not treated as a secret" for this
 * client type. The curated catalog must never carry credentials, so the secret
 * is bundled into the main process at build time and applied here, keyed to
 * the same first-party origins the delegated-endpoint policy trusts.
 */
const FIRST_PARTY_GOOGLE_OAUTH_RESOURCE_ORIGINS: ReadonlySet<string> = new Set([
  'https://code.unstoppabledomains.com',
  'https://code.ud-staging.com',
  'https://app.unstoppable.ai',
]);

/**
 * The only token endpoint the bundled Google secret may ever be sent to.
 * Gating on the resource origin alone would let a first-party `url` paired with
 * manual same-origin endpoint overrides carry the secret somewhere else.
 */
const GOOGLE_TOKEN_ORIGIN = 'https://oauth2.googleapis.com';

/** Google's authorization origin, used to scope Google-only auth parameters. */
const GOOGLE_AUTHORIZATION_ORIGIN = 'https://accounts.google.com';

function readBundledGoogleOAuthClientSecret(): string | undefined {
  // Any Electron build defines this (possibly empty). An undefined value means
  // an unbundled context — Jest or tsx — where the env fallback is the only
  // way to exercise the flow locally. Packaged builds therefore never read a
  // live environment variable for this value.
  if (typeof __CANOPY_GOOGLE_OAUTH_CLIENT_SECRET__ !== 'undefined') {
    return __CANOPY_GOOGLE_OAUTH_CLIENT_SECRET__?.trim() || undefined;
  }
  return process.env.CANOPY_GOOGLE_OAUTH_CLIENT_SECRET?.trim() || undefined;
}

/**
 * Resolve the client secret for a first-party Google connector, if any.
 *
 * An explicitly configured `oauth.clientSecret` always wins so a developer can
 * still override locally.
 */
function resolveGoogleOAuthClientSecret(
  configuredSecret: string | undefined,
  resourceUrl: string | undefined,
  tokenUrl: string | undefined,
): string | undefined {
  const configured = firstNonEmptyString(configuredSecret);
  if (configured) return configured;
  if (!resourceUrl || !tokenUrl) return undefined;
  let resourceOrigin: string;
  let tokenOrigin: string;
  try {
    resourceOrigin = new URL(resourceUrl).origin;
    tokenOrigin = new URL(tokenUrl).origin;
  } catch {
    return undefined;
  }
  if (!FIRST_PARTY_GOOGLE_OAUTH_RESOURCE_ORIGINS.has(resourceOrigin)) {
    return undefined;
  }
  if (tokenOrigin !== GOOGLE_TOKEN_ORIGIN) return undefined;
  return readBundledGoogleOAuthClientSecret();
}

interface ElectronShellModule {
  shell?: {
    openExternal(url: string): Promise<void>;
  };
}

function isElectronShellModule(value: unknown): value is ElectronShellModule {
  if (typeof value !== 'object' || value === null || !('shell' in value)) {
    return false;
  }

  const { shell } = value;
  return (
    typeof shell === 'object' &&
    shell !== null &&
    'openExternal' in shell &&
    typeof shell.openExternal === 'function'
  );
}

export interface StartMcpOAuthFlowInput {
  definition: McpServerDefinitionData;
  config: McpServerConfigData;
  proxyPort: number;
  force?: boolean;
  browser?: 'external' | 'embedded';
  /**
   * CAN-4126: set for a sign-in a client presents itself (embedded). The
   * callback is refused, and nothing is saved, once `isLive()` is false.
   */
  presentation?: { isLive(): boolean };
}

interface PendingMcpOAuthState {
  processing?: boolean;
  state: string;
  serverId: string;
  configId: string;
  codeVerifier?: string;
  createdAt: number;
  redirectUri: string;
  upstreamUrl: string;
  oauth: ResolvedMcpOAuthConfig;
  callbackServer?: Server;
  callbackTimeout?: ReturnType<typeof setTimeout>;
  presentation?: { isLive(): boolean };
}

interface ResolvedMcpOAuthConfig extends TokenRequestConfig {
  authorizationUrl: string;
  authorizationUrlRequiresPublicAddress: boolean;
  scopes: string[];
  audience?: string;
  resource: string;
  /**
   * The authorization server a response must come from, when both endpoints
   * came from its metadata. `required` when it advertises RFC 9207 `iss`.
   */
  issuerBinding?: { issuer: string; required: boolean };
}

const ISSUER_MISMATCH_MESSAGE =
  'Sign-in came back from a different service. Connect again.';

/**
 * Whether an authorization response may be exchanged: an `iss` it carries
 * must equal the flow's issuer exactly, and one the server promised (RFC
 * 9207) must be there. A metadata document client signs in only where it is
 * promised, since its client ID and callback are the same at every server and
 * `iss` alone tells a server's own response from a relayed one (RFC 9700
 * §4.4).
 */
function isResponseFromFlowIssuer(
  binding: ResolvedMcpOAuthConfig['issuerBinding'],
  iss: string | null,
): boolean {
  if (!binding) return true;
  if (iss === null) return !binding.required;
  return iss === binding.issuer;
}

const pendingStates = new Map<string, PendingMcpOAuthState>();
const latestAttempts = new Map<string, string>();

function attemptKey(serverId: string, configId: string): string {
  return JSON.stringify([serverId, configId]);
}

/** Invalidates callbacks, including an exchange that is already in flight. */
export async function cancelMcpOAuthFlow(flowId: string): Promise<void> {
  const pending = pendingStates.get(flowId);
  pendingStates.delete(flowId);
  if (pending?.callbackTimeout) clearTimeout(pending.callbackTimeout);
  for (const [key, state] of Array.from(latestAttempts.entries())) {
    if (state === flowId) latestAttempts.delete(key);
  }
  await closeCallbackServer(pending?.callbackServer);
}

function isCurrentAttempt(pending: PendingMcpOAuthState): boolean {
  return (
    pendingStates.get(pending.state) === pending &&
    latestAttempts.get(attemptKey(pending.serverId, pending.configId)) ===
      pending.state
  );
}
const fixedPortOperationTails = new Map<number, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pruneExpiredStates(): void {
  const now = Date.now();
  for (const [state, pending] of Array.from(pendingStates.entries())) {
    if (now - pending.createdAt > OAUTH_STATE_TTL_MS) {
      void cancelMcpOAuthFlow(state);
    }
  }
}

/**
 * Redirect URI for a client Canopy registered itself, through dynamic client
 * registration. Canopy chose this shape at registration time, so it is the
 * shape the authorization server has on file and must keep receiving.
 */
function buildProxyRedirectUri(port: number): string {
  return `http://127.0.0.1:${String(port)}/oauth/callback`;
}

/**
 * Redirect URI for a client the *vendor* registered and published.
 *
 * A definition that declares `oauth.callbackPort` is pinning a port because
 * the client id belongs to someone else — Slack ships client
 * `1601185624273...` and port 3118 in a public plugin manifest — and that
 * vendor's redirect allowlist is fixed. Canopy has no way to add an entry to
 * it, so it has to send the shape that is already there, which is the one the
 * reference client sends. Canopy's own `/oauth/callback` on 127.0.0.1 is not
 * in Slack's list, and Connect failed with `redirect_uri did not match any
 * configured URIs` until this matched.
 *
 * The cost of the pinned port is inherited, not chosen: one such flow at a
 * time, and any other process holding the port blocks it.
 */
function buildVendorRedirectUri(port: number): string {
  return `http://localhost:${String(port)}/callback`;
}

function startFixedCallbackServer(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const callbackUrl = new URL(
        request.url ?? '/',
        `http://127.0.0.1:${String(port)}`,
      );
      // Both shapes are accepted because this server is local and the cost is
      // nil, while a path mismatch here is a silent 404 in the middle of a
      // browser redirect — the hardest possible place to notice it.
      if (
        request.method !== 'GET' ||
        (callbackUrl.pathname !== '/callback' &&
          callbackUrl.pathname !== '/oauth/callback')
      ) {
        response.writeHead(404).end();
        return;
      }
      void handleMcpOAuthCallback(callbackUrl)
        .then((result) => {
          writeMcpOAuthCallbackPage(
            response,
            result.success ? 200 : 400,
            result,
          );
        })
        .catch((error: unknown) => {
          reportMainAppError(error, { source: 'mcp.oauth.callback' });
          writeMcpOAuthCallbackPage(response, 500, {
            success: false,
            message: 'OAuth callback failed.',
          });
        });
    });
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      server.unref();
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // Bound to IPv4 loopback although `buildVendorRedirectUri` advertises
    // `localhost`. The advertised host is not ours to choose — it has to match
    // what the vendor registered, and that is the shape the reference client
    // sends. On an IPv6-first host a browser resolving `localhost` to `::1`
    // reaches this listener only by falling back to IPv4, which every mainstream
    // browser does but none guarantees. Serving both stacks needs a second
    // server; until then this is a known, narrow limitation rather than an
    // oversight.
    server.listen(port, '127.0.0.1');
  });
}

async function closeCallbackServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function cancelPendingFixedPortFlows(port: number): Promise<void> {
  // Either shape can be in flight on a declared port — vendor for curated
  // entries, Canopy's own for a user-configured one — so match both rather
  // than stranding the pending state of whichever this is not.
  const redirectUris = new Set([
    buildVendorRedirectUri(port),
    buildProxyRedirectUri(port),
  ]);
  for (const [state, pending] of Array.from(pendingStates.entries())) {
    if (!redirectUris.has(pending.redirectUri)) continue;
    await cancelMcpOAuthFlow(state);
  }
}

async function replaceFixedCallbackServer(
  port: number,
  pending: PendingMcpOAuthState,
): Promise<void> {
  const previousTail = fixedPortOperationTails.get(port) ?? Promise.resolve();
  let releaseCurrent: () => void = () => undefined;
  const currentOperation = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const currentTail = previousTail
    .catch(() => undefined)
    .then(() => currentOperation);
  fixedPortOperationTails.set(port, currentTail);

  await previousTail.catch(() => undefined);
  try {
    await cancelPendingFixedPortFlows(port);
    pending.callbackServer = await startFixedCallbackServer(port);
    pending.callbackTimeout = setTimeout(() => {
      if (pendingStates.get(pending.state) !== pending) return;
      void cancelMcpOAuthFlow(pending.state);
    }, OAUTH_STATE_TTL_MS);
    pending.callbackTimeout.unref();
    pendingStates.set(pending.state, pending);
  } finally {
    releaseCurrent();
    if (fixedPortOperationTails.get(port) === currentTail) {
      fixedPortOperationTails.delete(port);
    }
  }
}

async function resolveDiscoveredPublicAddresses(
  url: URL,
  label: string,
): Promise<PinnedHttpAddress[]> {
  const e2eAddresses = resolveE2eMcpOAuthPublicAddresses();
  if (e2eAddresses) return e2eAddresses;
  const normalizedHostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const family = isIP(normalizedHostname);
  const resolved =
    family === 0
      ? await lookup(normalizedHostname, { all: true, verbatim: true })
      : [{ address: normalizedHostname, family }];
  if (
    resolved.length === 0 ||
    resolved.some(
      ({ address }) => isIP(address) === 0 || isNonPublicIpAddress(address),
    )
  ) {
    throw new Error(`${label} must resolve only to public network addresses.`);
  }
  return resolved.map(({ address, family: addressFamily }) => ({
    address,
    family: addressFamily === 6 ? 6 : 4,
  }));
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const entry = value[key];
  return typeof entry === 'string' && entry.trim().length > 0
    ? entry.trim()
    : undefined;
}

async function fetchJsonObject(
  url: URL,
  requirePublicAddress = false,
): Promise<Record<string, unknown> | null> {
  try {
    let nextUrl = url;
    for (
      let redirects = 0;
      redirects <= MAX_METADATA_REDIRECTS;
      redirects += 1
    ) {
      const e2eFixtureUrl = resolveE2eMcpOAuthFixtureUrl(nextUrl);
      noteMcpEgressHost(e2eFixtureUrl ?? nextUrl);
      const response = e2eFixtureUrl
        ? await fetch(e2eFixtureUrl, {
            headers: { Accept: 'application/json' },
          })
        : requirePublicAddress
          ? await fetchPinnedHttpGetResponse(
              nextUrl,
              await resolveDiscoveredPublicAddresses(
                nextUrl,
                'OAuth metadata URL',
              ),
              { Accept: 'application/json' },
              AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
            )
          : await fetch(nextUrl, {
              headers: { Accept: 'application/json' },
            });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (
          !requirePublicAddress ||
          !location ||
          redirects === MAX_METADATA_REDIRECTS
        ) {
          return null;
        }
        nextUrl = parseDiscoveredPublicHttpsUrl(
          new URL(location, nextUrl).toString(),
          'OAuth metadata redirect URL',
        );
        continue;
      }
      if (!response.ok) {
        return null;
      }
      const payload: unknown = await response.json();
      return isRecord(payload) ? payload : null;
    }
    return null;
  } catch {
    return null;
  }
}

function getCanonicalUpstreamUrl(definition: McpServerDefinitionData): string {
  return buildCanonicalResourceUrl(definition.url ?? '');
}

function hasCurrentUpstreamBinding(
  token: McpOAuthTokenRecord,
  definition: McpServerDefinitionData,
): boolean {
  return token.upstreamUrl === getCanonicalUpstreamUrl(definition);
}

async function clearInvalidStoredToken(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
): Promise<void> {
  try {
    await clearMcpOAuthToken(definition.id, config.id);
  } catch {
    // Leave the flow resilient if token cleanup fails; the caller still
    // treats the token as unusable for this request.
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (recordE2eMcpOAuthAuthorizationLaunch(url)) return;
  const electronModule = loadRequiredNodeModule<ElectronShellModule>({
    moduleId: 'electron',
    requireFrom: __filename,
    validate: isElectronShellModule,
  });
  const electronShell = electronModule.shell;
  if (!electronShell) {
    throw new Error('Electron shell API is unavailable.');
  }
  const { markExternalOpenLoopGuard } = await import('../lib/open-external');
  const rollbackLoopGuard = markExternalOpenLoopGuard(url);
  try {
    await electronShell.openExternal(url);
  } catch (error) {
    rollbackLoopGuard?.();
    throw error;
  }
}

async function discoverAuthorizationChallenge(
  mcpUrl: string,
  headers: Record<string, string> = {},
): Promise<AuthorizationChallenge> {
  return (await probeMcpHttpOAuthRequirementUncached(mcpUrl, headers))
    .challenge;
}

async function discoverProtectedResourceMetadata(
  mcpUrl: string,
  challenge: AuthorizationChallenge,
): Promise<ProtectedResourceMetadata | null> {
  const mcpOrigin = parseHttpUrl(mcpUrl, 'MCP server URL').origin;
  let urls = buildProtectedResourceMetadataUrls(mcpUrl);
  if (challenge.resourceMetadataUrl) {
    try {
      const metadataUrl = parseHttpUrl(
        challenge.resourceMetadataUrl,
        'Resource metadata URL',
      );
      if (metadataUrl.origin === mcpOrigin) {
        urls = [metadataUrl];
      }
    } catch {
      // Fall back to the well-known locations when the challenge is malformed.
    }
  }

  for (const url of urls) {
    const payload = await fetchJsonObject(url);
    if (!payload) {
      continue;
    }
    const { normalized, expectedResource } = normalizeResourceIdentifier(
      payload,
      mcpUrl,
      mcpOrigin,
    );
    const metadata = parseProtectedResourceMetadata(
      normalized,
      expectedResource,
      loopbackOriginOf(mcpUrl),
    );
    if (metadata) {
      return metadata;
    }
  }
  return null;
}

/**
 * Desktop servers predate strict RFC 9728 identifiers: many omit `resource`
 * or publish only their origin. Keep accepting those while still binding the
 * identifier to the MCP origin, so a cross-origin `resource` is rejected.
 */
function normalizeResourceIdentifier(
  payload: Record<string, unknown>,
  mcpUrl: string,
  mcpOrigin: string,
): { normalized: Record<string, unknown>; expectedResource: string } {
  const canonical = buildCanonicalResourceUrl(mcpUrl);
  const resource = payload.resource;
  if (resource === undefined) {
    return {
      normalized: { ...payload, resource: canonical },
      expectedResource: canonical,
    };
  }
  if (typeof resource !== 'string') {
    return { normalized: payload, expectedResource: canonical };
  }
  try {
    const sameOrigin =
      parseHttpUrl(resource, 'Protected resource URL').origin === mcpOrigin;
    return {
      normalized: payload,
      expectedResource: sameOrigin ? resource : canonical,
    };
  } catch {
    return { normalized: payload, expectedResource: canonical };
  }
}

/** `loopbackOrigin` admits an authorization server on a local MCP server's own origin. */
async function discoverAuthorizationServerMetadata(
  issuer: string,
  loopbackOrigin: string | undefined,
): Promise<AuthorizationServerMetadata | null> {
  parseDiscoveredOAuthUrl(issuer, 'Authorization server URL', loopbackOrigin);
  for (const url of buildAuthorizationServerMetadataUrls(
    issuer,
    loopbackOrigin,
  )) {
    const payload = await fetchJsonObject(url, url.origin !== loopbackOrigin);
    if (!payload) {
      continue;
    }
    const metadata = parseAuthorizationServerMetadata(
      payload,
      issuer,
      loopbackOrigin,
    );
    if (metadata) {
      return metadata;
    }
  }
  return null;
}

async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string | null> {
  try {
    const url = parseDiscoveredPublicHttpsUrl(
      registrationEndpoint,
      'OAuth registration endpoint',
    );
    noteMcpEgressHost(url);
    const response = await fetchPinnedHttpResponse(
      url,
      await resolveDiscoveredPublicAddresses(
        url,
        'OAuth registration endpoint',
      ),
      {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      JSON.stringify({
        client_name: BRAND.displayName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
    );
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    return isRecord(payload)
      ? (readString(payload, 'client_id') ?? null)
      : null;
  } catch {
    return null;
  }
}

/**
 * The client ID for a server that takes Client ID Metadata Documents: the
 * brand's desktop document on its cloud host, which lists only the proxy's
 * default loopback callback. Null for any other callback or without a public
 * cloud host, so the sign-in registers a client instead.
 */
function desktopClientIdMetadataDocumentUrl(
  redirectUri: string,
): string | null {
  if (!MCP_DESKTOP_OAUTH_REDIRECT_URIS.includes(redirectUri)) return null;
  let cloudBaseUrl: string;
  try {
    cloudBaseUrl = getCanopyCloudBaseUrl();
  } catch {
    return null;
  }
  const url = new URL(
    `/api${mcpDesktopClientMetadataDocumentPath(BRAND.id)}`,
    cloudBaseUrl,
  ).toString();
  return isClientIdMetadataDocumentUrl(url) ? url : null;
}

function firstNonEmptyString(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

/**
 * A client secret authenticates the way the discovered token endpoint takes
 * it; a manual token endpoint has no metadata to honor and keeps the form
 * body. A client without a secret is public even where the server lists only
 * secret methods: Slack does, yet takes its published desktop client.
 */
function tokenEndpointAuthMethodFor(
  clientSecret: string | undefined,
  metadata: AuthorizationServerMetadata | null,
): TokenEndpointAuthMethod {
  if (!clientSecret) return 'none';
  return (
    (metadata && selectTokenEndpointAuthMethod(metadata, true)) ??
    'client_secret_post'
  );
}

async function resolveMcpOAuthConfig(
  definition: McpServerDefinitionData,
  redirectUri: string,
  discoveryHeaders: Record<string, string> = {},
): Promise<ResolvedMcpOAuthConfig> {
  const oauth = definition.oauth ?? {};
  if (!definition.url) {
    throw new Error('MCP server URL is required for OAuth discovery.');
  }

  const challenge = await discoverAuthorizationChallenge(
    definition.url,
    discoveryHeaders,
  );
  const resourceMetadata = await discoverProtectedResourceMetadata(
    definition.url,
    challenge,
  );
  const authorizationServer =
    resourceMetadata?.authorizationServers[0] ?? undefined;
  const loopbackOrigin = loopbackOriginOf(definition.url);
  const authorizationServerMetadata = authorizationServer
    ? await discoverAuthorizationServerMetadata(
        authorizationServer,
        loopbackOrigin,
      )
    : null;

  const manualAuthorizationUrl = firstNonEmptyString(oauth.authorizationUrl);
  const manualTokenUrl = firstNonEmptyString(oauth.tokenUrl);
  const authorizationUrl = firstNonEmptyString(
    manualAuthorizationUrl,
    authorizationServerMetadata?.authorizationEndpoint,
  );
  const tokenUrl = firstNonEmptyString(
    manualTokenUrl,
    authorizationServerMetadata?.tokenEndpoint,
  );
  if (!authorizationUrl || !tokenUrl) {
    throw new Error(
      'Could not discover OAuth authorization and token endpoints. Add manual OAuth overrides in Advanced settings.',
    );
  }
  // Discovered metadata must advertise PKCE with S256, which every sign-in
  // sends (MCP authorization spec). Manual endpoints have no metadata to ask.
  if (
    authorizationServerMetadata &&
    !manualAuthorizationUrl &&
    !supportsPkceS256(authorizationServerMetadata)
  ) {
    throw new Error(
      'This server’s sign-in doesn’t support the PKCE protection MCP requires, so it can’t connect.',
    );
  }
  const authorizationOrigin = parseHttpUrl(
    authorizationUrl,
    'OAuth authorization URL',
  ).origin;
  const tokenOrigin = parseHttpUrl(tokenUrl, 'OAuth token URL').origin;
  if (authorizationOrigin !== tokenOrigin) {
    // Manual overrides remain same-origin only. Split endpoints are accepted
    // solely from validated authorization-server metadata, where both are
    // public HTTPS URLs in the shared mcp-oauth-core pair policy.
    if (manualAuthorizationUrl || manualTokenUrl) {
      throw new Error(
        'OAuth authorization and token endpoints must use the same origin.',
      );
    }
    const delegatedAuthorizationUrl = parseDiscoveredPublicHttpsUrl(
      authorizationUrl,
      'OAuth authorization endpoint',
    );
    const delegatedTokenUrl = parseDiscoveredPublicHttpsUrl(
      tokenUrl,
      'OAuth token endpoint',
    );
    if (
      !isTrustedOAuthEndpointPair(delegatedAuthorizationUrl, delegatedTokenUrl)
    ) {
      throw new Error(
        'OAuth authorization and token endpoints must use a trusted origin pair.',
      );
    }
    const protectedResourceUrl = parseHttpUrl(
      resourceMetadata?.resource ?? definition.url,
      'Protected resource URL',
    );
    if (
      !isTrustedOAuthEndpointPairForResource(
        protectedResourceUrl,
        delegatedAuthorizationUrl,
        delegatedTokenUrl,
      )
    ) {
      throw new Error(
        'OAuth delegated endpoints are not trusted for this protected resource.',
      );
    }
    await Promise.all([
      resolveDiscoveredPublicAddresses(
        delegatedAuthorizationUrl,
        'OAuth authorization endpoint',
      ),
      resolveDiscoveredPublicAddresses(
        delegatedTokenUrl,
        'OAuth token endpoint',
      ),
    ]);
  }

  // A response is bound to the server whose metadata named both endpoints;
  // manual endpoints may belong to another server.
  const issuerBinding =
    authorizationServerMetadata && !manualAuthorizationUrl && !manualTokenUrl
      ? {
          issuer: authorizationServerMetadata.issuer,
          required:
            authorizationServerMetadata.authorizationResponseIssParameterSupported,
        }
      : undefined;
  // A configured client comes first, then a Client ID Metadata Document (RFC
  // 9207 servers only, so the response can be bound to its server), then
  // dynamic registration.
  const manualClientId = firstNonEmptyString(oauth.clientId);
  const metadataDocumentClientId =
    !manualClientId &&
    issuerBinding?.required &&
    authorizationServerMetadata &&
    supportsClientIdMetadataDocument(authorizationServerMetadata)
      ? desktopClientIdMetadataDocumentUrl(redirectUri)
      : null;
  const dynamicClientId =
    manualClientId ||
    metadataDocumentClientId ||
    !authorizationServerMetadata?.registrationEndpoint
      ? null
      : await registerDynamicClient(
          authorizationServerMetadata.registrationEndpoint,
          redirectUri,
        );
  const clientId = firstNonEmptyString(
    manualClientId,
    metadataDocumentClientId ?? dynamicClientId ?? undefined,
  );
  if (!clientId) {
    throw new Error(
      'Could not discover an OAuth client ID. Add a Client ID in Advanced OAuth settings.',
    );
  }

  // A metadata document client is public: it has no secret to send.
  const clientSecret = metadataDocumentClientId
    ? undefined
    : resolveGoogleOAuthClientSecret(
        oauth.clientSecret,
        definition.url,
        tokenUrl,
      );
  return {
    clientId,
    clientSecret,
    tokenEndpointAuthMethod: tokenEndpointAuthMethodFor(
      clientSecret,
      manualTokenUrl ? null : authorizationServerMetadata,
    ),
    authorizationUrl,
    authorizationUrlRequiresPublicAddress:
      manualAuthorizationUrl === undefined &&
      authorizationOrigin !== loopbackOrigin,
    tokenUrl,
    tokenUrlRequiresPublicAddress:
      manualTokenUrl === undefined && tokenOrigin !== loopbackOrigin,
    scopes:
      oauth.scopes && oauth.scopes.length > 0
        ? oauth.scopes
        : challenge.scopes && challenge.scopes.length > 0
          ? challenge.scopes
          : resourceMetadata?.scopesSupported &&
              resourceMetadata.scopesSupported.length > 0
            ? resourceMetadata.scopesSupported
            : (authorizationServerMetadata?.scopesSupported ?? []),
    audience: oauth.audience,
    resource:
      resourceMetadata?.resource ?? buildCanonicalResourceUrl(definition.url),
    ...(issuerBinding ? { issuerBinding } : {}),
  };
}

async function recordOAuthCallbackError(
  pending: PendingMcpOAuthState,
  message: string,
): Promise<void> {
  try {
    await recordMcpOAuthTokenError(
      pending.serverId,
      pending.configId,
      message,
      {
        upstreamUrl: pending.upstreamUrl,
      },
      () => isCurrentAttempt(pending),
    );
  } catch {
    // Preserve the browser callback response even if durable status recording
    // fails; polling will still report the token-store error separately.
  }
}

async function requestToken(
  oauth: TokenRequestConfig,
  body: URLSearchParams,
  signal?: AbortSignal,
): Promise<TokenExchangeResult> {
  const tokenUrl = parseHttpUrl(oauth.tokenUrl, 'OAuth token URL');
  const client = tokenEndpointClientAuthentication(oauth);
  for (const [name, value] of Object.entries(client.body))
    body.set(name, value);

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    ...client.headers,
  };
  noteMcpEgressHost(tokenUrl);
  const response = oauth.tokenUrlRequiresPublicAddress
    ? await fetchPinnedHttpResponse(
        parseDiscoveredPublicHttpsUrl(
          tokenUrl.toString(),
          'OAuth token endpoint',
        ),
        await resolveDiscoveredPublicAddresses(
          tokenUrl,
          'OAuth token endpoint',
        ),
        headers,
        body.toString(),
        signal ?? AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
      )
    : await fetch(tokenUrl, {
        method: 'POST',
        headers,
        body,
        signal,
      });

  if (!response.ok) {
    let code: string | undefined;
    try {
      const payload: unknown = await response.json();
      if (isRecord(payload) && typeof payload.error === 'string')
        code = payload.error;
    } catch {
      /* Non-JSON error responses are transient unless proven otherwise. */
    }
    throw new OAuthTokenEndpointError(response.status, code);
  }

  const payload: unknown = await response.json();
  return parseTokenResponse(payload);
}

class OAuthTokenEndpointError extends Error {
  readonly requiresReauthorization: boolean;
  constructor(status: number, code: string | undefined) {
    super(`OAuth token endpoint returned HTTP ${String(status)}.`);
    this.requiresReauthorization =
      status >= 400 &&
      status < 500 &&
      ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(
        code ?? '',
      );
  }
}

/**
 * Reports a token request failure by stage. The app-error path keeps only the
 * classification and stack, never the message, so no URL or provider text
 * leaves the device.
 */
function reportTokenFailure(
  error: unknown,
  source: 'mcp.oauth.exchange' | 'mcp.oauth.refresh',
): void {
  const classified =
    error instanceof OAuthTokenEndpointError
      ? classifyError(
          error,
          error.requiresReauthorization
            ? 'external.sign_in_required'
            : 'external.service_unavailable',
        )
      : classifyFetchFailure(error, error);
  reportMainAppError(classified, { source });
}

async function adoptCurrentUsableMcpAccessToken(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
): Promise<string | null> {
  const current = await getMcpOAuthToken(definition.id, config.id);
  if (
    !current ||
    current.lastError ||
    !current.accessToken ||
    !hasCurrentUpstreamBinding(current, definition) ||
    !isAccessTokenFresh(current.expiresAt)
  ) {
    return null;
  }
  return current.accessToken;
}

const tokenResolutions = new Map<string, Promise<string | null>>();
const refreshRetryAfter = new Map<string, { revision: string; at: number }>();

/** Share rotating refreshes and keep caller cancellation independent. */
export async function getValidMcpAccessToken(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  const key = JSON.stringify([
    definition.id,
    config.id,
    definition.url ? buildCanonicalResourceUrl(definition.url) : '',
  ]);
  let operation = tokenResolutions.get(key);
  if (!operation) {
    operation = resolveValidMcpAccessToken(
      definition,
      config,
      AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
    );
    tokenResolutions.set(key, operation);
    const current = operation;
    void operation
      .finally(() => {
        if (tokenResolutions.get(key) === current) tokenResolutions.delete(key);
      })
      .catch(() => undefined);
  }
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = (): void =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Request canceled', 'AbortError'),
      );
    signal.addEventListener('abort', abort, { once: true });
    void operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function resolveValidMcpAccessToken(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
  signal?: AbortSignal,
): Promise<string | null> {
  const token = await getMcpOAuthToken(definition.id, config.id);
  if (!token) {
    return null;
  }

  if (!hasCurrentUpstreamBinding(token, definition)) {
    await clearInvalidStoredToken(definition, config);
    return null;
  }

  if (token.lastError) {
    return null;
  }

  if (isAccessTokenFresh(token.expiresAt)) {
    return token.accessToken;
  }

  if (!token.refreshToken) {
    return null;
  }

  const clientId = firstNonEmptyString(
    token.clientId,
    definition.oauth?.clientId,
  );
  const tokenUrl = firstNonEmptyString(
    token.tokenUrl,
    definition.oauth?.tokenUrl,
  );
  if (!clientId || !tokenUrl) {
    return null;
  }
  const tokenUrlRequiresPublicAddress =
    token.tokenUrlRequiresPublicAddress ??
    (token.tokenUrl !== undefined &&
      firstNonEmptyString(definition.oauth?.tokenUrl) === undefined);

  const retryKey = JSON.stringify([
    definition.id,
    config.id,
    token.upstreamUrl,
  ]);
  const retry = refreshRetryAfter.get(retryKey);
  if (retry?.revision === token.updatedAt && retry.at > Date.now())
    throw new Error(
      'MCP authorization is temporarily unavailable. Try again shortly.',
    );
  refreshRetryAfter.delete(retryKey);
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
    });
    if (token.resource) {
      body.set('resource', token.resource);
    }
    const clientSecret = resolveGoogleOAuthClientSecret(
      definition.oauth?.clientSecret,
      definition.url,
      tokenUrl,
    );
    const refreshed = await requestToken(
      {
        tokenUrl,
        clientId,
        clientSecret,
        // Refresh authenticates the way sign-in chose; a token stored before
        // that choice was recorded keeps the form body.
        tokenEndpointAuthMethod: clientSecret
          ? (token.tokenEndpointAuthMethod ?? 'client_secret_post')
          : 'none',
        tokenUrlRequiresPublicAddress,
      },
      body,
      signal,
    );
    const saved = await saveMcpOAuthTokenIfCurrent(
      {
        serverId: definition.id,
        configId: config.id,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? token.refreshToken,
        upstreamUrl: getCanonicalUpstreamUrl(definition),
        clientId,
        authorizationUrl:
          token.authorizationUrl ?? definition.oauth?.authorizationUrl,
        tokenUrl,
        tokenUrlRequiresPublicAddress,
        tokenEndpointAuthMethod: token.tokenEndpointAuthMethod,
        resource: token.resource,
        tokenType: refreshed.tokenType,
        scope: refreshed.scope ?? token.scope,
        expiresAt: refreshed.expiresAt,
        updatedAt: new Date().toISOString(),
      },
      token,
    );
    return saved
      ? refreshed.accessToken
      : adoptCurrentUsableMcpAccessToken(definition, config);
  } catch (error: unknown) {
    reportTokenFailure(error, 'mcp.oauth.refresh');
    if (
      error instanceof OAuthTokenEndpointError &&
      error.requiresReauthorization
    ) {
      await recordMcpOAuthTokenError(definition.id, config.id, error.message, {
        upstreamUrl: token.upstreamUrl,
        accessToken: token.accessToken,
      });
      return adoptCurrentUsableMcpAccessToken(definition, config);
    } else {
      // Network failures, rate limits and server outages do not revoke a grant.
      // Bound retries across chat traffic and UI probes without persisting a dead end.
      refreshRetryAfter.set(retryKey, {
        revision: token.updatedAt,
        at: Date.now() + 30_000,
      });
      throw new Error(
        'MCP authorization is temporarily unavailable. Try again shortly.',
      );
    }
    return null;
  }
}

export async function startMcpOAuthFlow(
  input: StartMcpOAuthFlowInput,
): Promise<StartMcpOAuthLoginResponse> {
  const key = attemptKey(input.definition.id, input.config.id);
  const previous = latestAttempts.get(key);
  const cancelPrevious = previous
    ? cancelMcpOAuthFlow(previous)
    : Promise.resolve();
  const state = randomBytes(16).toString('base64url');
  latestAttempts.set(key, state);
  try {
    await cancelPrevious;
    if (latestAttempts.get(key) !== state)
      throw new Error('Sign-in was canceled.');
    const definition: McpServerDefinitionData = input.definition.oauth
      ? input.definition
      : {
          ...input.definition,
          oauth: { usePkce: true },
        };

    if (input.force) {
      await clearMcpOAuthToken(definition.id, input.config.id);
    } else {
      let existingToken: string | null = null;
      try {
        existingToken = await getValidMcpAccessToken(definition, input.config);
      } catch {
        // Renewal is only an optimization for an explicit sign-in. A temporary
        // token-endpoint failure must not prevent browser authorization, even
        // during the bounded refresh backoff window.
      }
      if (existingToken) {
        return { status: 'completed' };
      }
    }

    pruneExpiredStates();
    // Who owns the OAuth client decides the redirect shape — and that is stated
    // explicitly rather than inferred. `callbackPort` alone is not the signal: it
    // is a general-purpose field a user can set on their own server, and those
    // users registered Canopy's historic `127.0.0.1/oauth/callback` with their
    // provider. Switching them to the vendor shape would break a working flow on
    // upgrade with no migration, so only a definition instantiated from a curated
    // entry that pins a port gets it.
    const declaredCallbackPort = definition.oauth?.callbackPort;
    const usesVendorRedirect =
      declaredCallbackPort !== undefined &&
      definition.oauth?.vendorRegisteredRedirect === true;
    const callbackPort = declaredCallbackPort ?? input.proxyPort;
    if (
      !Number.isInteger(callbackPort) ||
      callbackPort < 1 ||
      callbackPort > 65_535
    ) {
      throw new Error(
        'OAuth callback port must be an integer from 1 to 65535.',
      );
    }
    const redirectUri = usesVendorRedirect
      ? buildVendorRedirectUri(callbackPort)
      : buildProxyRedirectUri(callbackPort);
    const oauth = await resolveMcpOAuthConfig(
      definition,
      redirectUri,
      buildOAuthDiscoveryHeaders(definition, input.config),
    );
    const authorizationUrl = parseHttpUrl(
      oauth.authorizationUrl,
      'OAuth authorization URL',
    );
    const codeVerifier = createCodeVerifier();

    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', oauth.clientId);
    authorizationUrl.searchParams.set('redirect_uri', redirectUri);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('resource', oauth.resource);
    if (oauth.scopes.length > 0) {
      authorizationUrl.searchParams.set('scope', oauth.scopes.join(' '));
    }
    if (oauth.audience) {
      authorizationUrl.searchParams.set('audience', oauth.audience);
    }
    // Google-only: it issues a refresh token solely when access_type=offline is
    // present AND the user is re-consenting — a later authorization for an
    // already-consented client returns an access token alone, after which the
    // connector dies ~1h post-login. Scoped to Google's authorization origin so
    // this does not alter the request sent to every other OAuth provider.
    if (authorizationUrl.origin === GOOGLE_AUTHORIZATION_ORIGIN) {
      authorizationUrl.searchParams.set('access_type', 'offline');
      authorizationUrl.searchParams.set('prompt', 'consent');
    }
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set(
      'code_challenge',
      await createPkceChallenge(codeVerifier),
    );

    if (latestAttempts.get(key) !== state)
      throw new Error('Sign-in was canceled.');
    const pending: PendingMcpOAuthState = {
      state,
      serverId: definition.id,
      configId: input.config.id,
      codeVerifier,
      createdAt: Date.now(),
      redirectUri,
      upstreamUrl: getCanonicalUpstreamUrl(definition),
      oauth,
      ...(input.presentation ? { presentation: input.presentation } : {}),
    };
    try {
      if (declaredCallbackPort !== undefined) {
        await replaceFixedCallbackServer(callbackPort, pending);
      } else {
        pendingStates.set(state, pending);
      }

      const url = authorizationUrl.toString();
      if (oauth.authorizationUrlRequiresPublicAddress) {
        await resolveDiscoveredPublicAddresses(
          parseDiscoveredPublicHttpsUrl(url, 'OAuth authorization endpoint'),
          'OAuth authorization endpoint',
        );
      }
      if (!isCurrentAttempt(pending)) throw new Error('Sign-in was canceled.');
      if (input.browser !== 'embedded') await openExternalUrl(url);
      return { status: 'started', authorizationUrl: url, flowId: state };
    } catch (error) {
      pendingStates.delete(state);
      pending.callbackServer?.close();
      if (pending.callbackTimeout) clearTimeout(pending.callbackTimeout);
      throw error;
    }
  } finally {
    if (!pendingStates.has(state) && latestAttempts.get(key) === state)
      latestAttempts.delete(key);
  }
}

// Injected by the IPC layer so OAuth completion (success or failure) can
// refresh downstream projections without coupling this module to them.
export interface McpOAuthSettledEvent {
  success: boolean;
  serverId?: string;
  configId?: string;
}

let oauthSettledListener: ((event: McpOAuthSettledEvent) => void) | null = null;

export function setMcpOAuthSettledListener(
  listener: ((event: McpOAuthSettledEvent) => void) | null,
): void {
  oauthSettledListener = listener;
}

export async function handleMcpOAuthCallback(
  url: URL,
): Promise<{ success: boolean; message: string }> {
  const state = url.searchParams.get('state');
  const target = state ? pendingStates.get(state) : undefined;
  let result: { success: boolean; message: string } | undefined;
  try {
    result = await handleMcpOAuthCallbackInternal(url);
    return result;
  } finally {
    oauthSettledListener?.({
      success: result?.success === true,
      ...(target
        ? { serverId: target.serverId, configId: target.configId }
        : {}),
    });
  }
}

async function handleMcpOAuthCallbackInternal(
  url: URL,
): Promise<{ success: boolean; message: string }> {
  pruneExpiredStates();
  const state = url.searchParams.get('state');
  if (!state) {
    return { success: false, message: 'OAuth callback is missing state.' };
  }

  const pending = pendingStates.get(state);
  if (!pending || pending.processing || !isCurrentAttempt(pending)) {
    return {
      success: false,
      message: 'OAuth sign-in state expired or invalid.',
    };
  }

  pending.processing = true;
  try {
    pending.callbackServer?.close();
    if (pending.callbackTimeout) clearTimeout(pending.callbackTimeout);
    if (pending.presentation && !pending.presentation.isLive())
      return { success: false, message: 'Sign-in was canceled.' };

    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description');
      const message = description ? `${error}: ${description}` : error;
      await recordOAuthCallbackError(pending, message);
      return {
        success: false,
        message,
      };
    }

    const code = url.searchParams.get('code');
    if (!code) {
      await recordOAuthCallbackError(
        pending,
        'OAuth callback is missing code.',
      );
      return { success: false, message: 'OAuth callback is missing code.' };
    }
    // Bind the response to the flow's server before the code and verifier
    // are sent anywhere.
    if (
      !isResponseFromFlowIssuer(
        pending.oauth.issuerBinding,
        url.searchParams.get('iss'),
      )
    ) {
      await recordOAuthCallbackError(pending, ISSUER_MISMATCH_MESSAGE);
      return { success: false, message: ISSUER_MISMATCH_MESSAGE };
    }

    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
      });
      body.set('resource', pending.oauth.resource);
      if (pending.codeVerifier) {
        body.set('code_verifier', pending.codeVerifier);
      }

      const token = await requestToken(pending.oauth, body);
      // An authorization-code exchange can represent a different principal.
      // Never pair its access token with a refresh grant from the previous
      // authorization when the provider omits a new refresh token. Google is
      // asked for fresh consent above so it can issue a replacement grant.
      const saved = await saveMcpOAuthTokenIfCurrent(
        {
          serverId: pending.serverId,
          configId: pending.configId,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          upstreamUrl: pending.upstreamUrl,
          clientId: pending.oauth.clientId,
          authorizationUrl: pending.oauth.authorizationUrl,
          tokenUrl: pending.oauth.tokenUrl,
          tokenUrlRequiresPublicAddress:
            pending.oauth.tokenUrlRequiresPublicAddress,
          tokenEndpointAuthMethod: pending.oauth.tokenEndpointAuthMethod,
          resource: pending.oauth.resource,
          tokenType: token.tokenType,
          scope: token.scope,
          expiresAt: token.expiresAt,
          updatedAt: new Date().toISOString(),
        },
        undefined,
        () => isCurrentAttempt(pending),
      );
      if (!saved || !isCurrentAttempt(pending))
        return { success: false, message: 'Sign-in was canceled.' };
      return { success: true, message: 'OAuth sign-in completed.' };
    } catch (callbackError: unknown) {
      reportTokenFailure(callbackError, 'mcp.oauth.exchange');
      const message =
        callbackError instanceof Error
          ? callbackError.message
          : 'OAuth token exchange failed.';
      await recordOAuthCallbackError(pending, message);
      return {
        success: false,
        message,
      };
    }
  } finally {
    await cancelMcpOAuthFlow(state);
  }
}
