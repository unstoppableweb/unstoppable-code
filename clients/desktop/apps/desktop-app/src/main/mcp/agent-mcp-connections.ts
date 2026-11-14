import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import type {
  McpConnectionCredentials,
  McpCredentialRef,
  McpUpstreamAuthorization,
} from '@canopy/core-runtime/node/mcp-auth';
import { createCopilotCapabilitySnapshot } from '@canopy/copilot-recipient/capability-snapshot';
import { classifyMcpAuthFailure } from '@canopy/execution-engine/agent-failures';
import {
  CanopyCloudClientError,
  resolveCanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import { clearAuthFailureToolNameCache } from '../lib/auth-failure-event';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  registerAccountMcpRouteStatus,
  removeAccountMcpRouteStatus,
  setAccountMcpRouteReauthRequired,
} from './account-route-status';
import {
  getHeaderValue,
  isRecord,
  MAX_REQUEST_BODY_BYTES,
  readRequestBody,
  RequestBodyTooLargeError,
  writeJson,
} from './integration-http';
import {
  clearPendingAuthFailures,
  recordPendingMcpAuthFailure,
} from './pending-auth-failures';

/** A route as the connection service stores it (CAN-4126): a credential reference, never an OAuth definition or token. */
export interface AgentMcpRoute {
  routeId: string;
  sessionId: string | null;
  serverId: string;
  configId: string;
  displayName: string;
  upstreamUrl: string;
  headers: Record<string, string>;
  oauthEnabled: boolean;
  authSupplier?: 'oauth' | 'canopy-cloud';
  reauthRequired?: boolean;
  oauthRequired?: boolean;
  /** Owner-minted reference; present exactly when the route authenticates with MCP OAuth. */
  credential?: McpCredentialRef;
  /** Delegated routes must never forward without their live parent gate. */
  requireToolCallGate?: boolean;
}
export interface AgentMcpRouteRegistration extends Omit<
  AgentMcpRoute,
  'routeId' | 'reauthRequired'
> {
  routeKey?: string;
  /**
   * The host-neutral key the capability snapshot names a plugin server's
   * route by (CAN-6168); `routeKey` names it otherwise.
   */
  snapshotKey?: string;
}

interface InternalMcpProxyRoute extends AgentMcpRoute {
  routeKey?: string;
  snapshotKey?: string;
  parsedUpstream: URL;
}

/**
 * Execution-time gate a session installs for the proxied plugin and
 * standalone MCP routes it owns. Consulted for every `tools/call` before it
 * is forwarded upstream; `false` answers the call with a denial instead.
 */
export type McpProxiedToolCallGate = (call: {
  proxyUrl: string;
  tool: string;
  args: Record<string, unknown>;
  requestId?: string;
}) => Promise<boolean>;

export interface AgentMcpConnectionsOptions {
  /** The transport's URL for a route; throws `Error('MCP proxy is not started.')` while stopped. */
  readonly proxyUrl: (routeId: string) => string;
  /** True while the transport listens. */
  readonly listening: () => boolean;
  readonly credentials: McpConnectionCredentials;
}

const SAFE_FORWARD_HEADERS = new Set([
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

const SAFE_RESPONSE_HEADERS = new Set([
  'transfer-encoding',
  'content-type',
  'cache-control',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
  'www-authenticate',
]);

function createProxyRouteId(): string {
  return randomBytes(16).toString('base64url');
}

async function buildForwardHeaders(
  req: IncomingMessage,
  route: InternalMcpProxyRoute,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    host: route.parsedUpstream.host,
  };

  for (const headerName of Array.from(SAFE_FORWARD_HEADERS.values())) {
    const value = getHeaderValue(req.headers, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  for (const [name, value] of Object.entries(route.headers)) {
    headers[name] = value;
  }

  if (route.authSupplier === 'canopy-cloud') {
    const credentials = await resolveCanopyCloudCredentialContext();
    if (!credentials.apiKey)
      throw new CanopyCloudClientError(
        'missing-api-key',
        'Sign in to use account MCP connections.',
      );
    const base = new URL(credentials.baseUrl);
    if (
      route.parsedUpstream.origin !== base.origin ||
      !route.parsedUpstream.pathname.startsWith(
        `${base.pathname.replace(/\/$/, '')}/api/v1/mcp-proxy/`,
      )
    ) {
      throw new Error(
        'Account MCP route no longer belongs to the configured cloud.',
      );
    }
    for (const name of Object.keys(headers))
      if (name.toLowerCase() === 'authorization') delete headers[name];
    headers.Authorization = `Bearer ${credentials.apiKey}`;
  }

  return headers;
}

function copyResponseHeaders(
  upstream: IncomingMessage,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const name of Array.from(SAFE_RESPONSE_HEADERS.values())) {
    const value = upstream.headers[name];
    if (typeof value === 'string' || Array.isArray(value)) {
      headers[name] = value;
    }
  }
  return headers;
}

/**
 * Worker-side agent MCP connections (CAN-4125): the upstream routes each
 * agent session owns, their tool-call gates and request forwarding. The
 * transport authenticates nothing here; it hands over a route id it parsed.
 */
export class AgentMcpConnections {
  private readonly options: AgentMcpConnectionsOptions;
  private routes = new Map<string, InternalMcpProxyRoute>();
  private routesBySession = new Map<string, Set<string>>();
  private readonly sessionToolCallGates = new Map<
    string,
    McpProxiedToolCallGate
  >();

  constructor(options: AgentMcpConnectionsOptions) {
    this.options = options;
  }

  register(route: AgentMcpRouteRegistration): Promise<string> {
    if (route.requireToolCallGate && route.sessionId === null) {
      return Promise.reject(new Error('A gated MCP route requires a session.'));
    }
    const parsedUpstream = new URL(route.upstreamUrl);
    if (
      parsedUpstream.protocol !== 'http:' &&
      parsedUpstream.protocol !== 'https:'
    ) {
      return Promise.reject(
        new Error('MCP proxy only supports HTTP and HTTPS upstream URLs.'),
      );
    }

    const routeId = createProxyRouteId();
    const previousRoute = this.routes.get(routeId);
    if (previousRoute) {
      this.removeRouteFromSessionIndex(routeId, previousRoute.sessionId);
      if (previousRoute.credential)
        this.options.credentials.release(previousRoute.credential);
    }
    const fullRoute: InternalMcpProxyRoute = {
      routeId,
      sessionId: route.sessionId,
      serverId: route.serverId,
      configId: route.configId,
      displayName: route.displayName,
      upstreamUrl: route.upstreamUrl,
      headers: route.headers,
      oauthEnabled:
        route.authSupplier === 'canopy-cloud' ? false : route.oauthEnabled,
      authSupplier: route.authSupplier ?? 'oauth',
      reauthRequired: false,
      oauthRequired: route.oauthRequired,
      ...(route.credential ? { credential: route.credential } : {}),
      ...(route.requireToolCallGate ? { requireToolCallGate: true } : {}),
      ...(route.routeKey ? { routeKey: route.routeKey } : {}),
      ...(route.snapshotKey ? { snapshotKey: route.snapshotKey } : {}),
      parsedUpstream,
    };
    this.routes.set(routeId, fullRoute);
    if (fullRoute.authSupplier === 'canopy-cloud')
      registerAccountMcpRouteStatus(
        routeId,
        route.serverId,
        route.configId,
        parsedUpstream.pathname.split('/').pop() ?? '',
      );

    if (route.sessionId !== null) {
      const existing = this.routesBySession.get(route.sessionId) ?? new Set();
      existing.add(routeId);
      this.routesBySession.set(route.sessionId, existing);
    }

    return Promise.resolve(routeId);
  }

  routeStatus(routeId: string): { reauthRequired: boolean } | undefined {
    const route = this.routes.get(routeId);
    return route
      ? { reauthRequired: route.reauthRequired === true }
      : undefined;
  }

  private removeRouteFromSessionIndex(
    routeId: string,
    sessionId: string | null,
  ): void {
    if (sessionId === null) {
      return;
    }

    const sessionRoutes = this.routesBySession.get(sessionId);
    if (!sessionRoutes) {
      return;
    }

    sessionRoutes.delete(routeId);
    if (sessionRoutes.size === 0) {
      this.routesBySession.delete(sessionId);
    }
  }

  unregister(routeId: string): void {
    const route = this.routes.get(routeId);
    if (!route) {
      return;
    }

    this.routes.delete(routeId);
    if (route.credential) this.options.credentials.release(route.credential);
    removeAccountMcpRouteStatus(routeId);
    this.removeRouteFromSessionIndex(routeId, route.sessionId);
  }

  /** Installs (or replaces) the session's proxied tool-call gate. */
  setSessionToolCallGate(
    sessionId: string,
    gate: McpProxiedToolCallGate,
  ): void {
    this.sessionToolCallGates.set(sessionId, gate);
  }

  disconnectSession(sessionId: string): void {
    // Drop any auth failure this owner published but never claimed, and
    // its tool-name correlation cache (CAN-1814), unconditionally — a
    // session can end without routes still registered (e.g. already
    // unregistered individually) while either process-global registry
    // still holds an entry with no other eviction path.
    clearPendingAuthFailures(sessionId);
    clearAuthFailureToolNameCache(sessionId);
    this.sessionToolCallGates.delete(sessionId);

    const routeIds = this.routesBySession.get(sessionId);
    if (!routeIds) {
      return;
    }

    for (const routeId of Array.from(routeIds.values())) {
      this.unregister(routeId);
    }
  }

  sessionRoute(
    sessionId: string,
    serverId: string,
    configId: string,
  ): { displayName: string } | undefined {
    const routeIds = this.routesBySession.get(sessionId);
    if (!routeIds) return undefined;
    for (const routeId of Array.from(routeIds)) {
      const route = this.routes.get(routeId);
      if (route?.serverId === serverId && route.configId === configId) {
        return { displayName: route.displayName };
      }
    }
    return undefined;
  }

  /**
   * The authority ids the capability snapshot names proxied servers by:
   * a plugin route by its host-neutral key (fingerprint v2, CAN-6168),
   * any other by its route key. `legacy` gives fingerprint v1's, by route
   * key alone, to recognize a lease written before v2.
   */
  codexCapabilityAuthorityIds(
    mcpServers: Record<string, unknown>,
    legacy = false,
  ): string[] {
    if (!this.options.listening()) {
      return [];
    }
    const authorityIds: string[] = [];
    for (const [serverName, value] of Object.entries(mcpServers)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        continue;
      }
      const url: unknown = Reflect.get(value, 'url');
      if (typeof url !== 'string') {
        continue;
      }
      for (const [routeId, route] of Array.from(this.routes.entries())) {
        if (route.routeKey && this.options.proxyUrl(routeId) === url) {
          const key = legacy
            ? route.routeKey
            : (route.snapshotKey ?? route.routeKey);
          authorityIds.push(`${serverName}:${key}`);
          break;
        }
      }
    }
    return authorityIds.sort();
  }

  /** Stable config identities without persisting credentials or ephemeral proxy addresses. */
  capabilityDigests(
    mcpServers: Record<string, unknown>,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(mcpServers).map(([name, value]) => {
        const config = isRecord(value) ? value : {};
        const route =
          this.options.listening() && typeof config.url === 'string'
            ? Array.from(this.routes.entries()).find(
                ([id]) => this.options.proxyUrl(id) === config.url,
              )?.[1]
            : undefined;
        // These fields are an allowlist, not a recursive hash of configuration.
        // Arbitrary headers/env/args, OAuth records and URL path/query/userinfo
        // can contain credentials. Even their hashes must never be persisted.
        const endpoint = route?.upstreamUrl ?? config.url;
        let origin: string | undefined;
        if (typeof endpoint === 'string') {
          try {
            origin = new URL(endpoint).origin;
          } catch {
            /* Invalid URLs have no public origin. */
          }
        }
        const headers = route?.headers ?? config.headers;
        const manifest = {
          type: typeof config.type === 'string' ? config.type : undefined,
          command:
            typeof config.command === 'string' ? config.command : undefined,
          origin,
          tools: Array.isArray(config.tools)
            ? config.tools
                .filter((tool): tool is string => typeof tool === 'string')
                .sort()
            : undefined,
          headerNames: isRecord(headers)
            ? Object.keys(headers)
                .map((key) => key.toLowerCase())
                .sort()
            : [],
          environmentNames: isRecord(config.env)
            ? Object.keys(config.env).sort()
            : [],
          authority: route
            ? {
                serverId: route.serverId,
                configId: route.configId,
                oauthEnabled: route.oauthEnabled,
                oauthRequired: route.oauthRequired,
                authSupplier: route.authSupplier,
              }
            : undefined,
        };
        return [name, createCopilotCapabilitySnapshot(manifest).digest];
      }),
    );
  }

  /** Registered routes, for /health and the start rule. */
  get size(): number {
    return this.routes.size;
  }

  /** Serves one request for a route id: 404 when unknown, 405 for other methods, else forwarding. */
  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    routeId: string,
  ): Promise<void> {
    const route = this.routes.get(routeId);
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (
      req.method !== 'GET' &&
      req.method !== 'POST' &&
      req.method !== 'DELETE'
    ) {
      res.writeHead(405, { Allow: 'GET, POST, DELETE' });
      res.end();
      return;
    }

    await this.forwardRequest(req, res, route);
  }

  /** Shutdown: removes every account route status and clears routes and the session index (gates stay). */
  clear(): void {
    for (const [routeId, route] of Array.from(this.routes.entries())) {
      if (route.credential) this.options.credentials.release(route.credential);
      removeAccountMcpRouteStatus(routeId);
    }
    this.routes.clear();
    this.routesBySession.clear();
  }

  /**
   * Answers a proxied `tools/call` the session's gate refuses; batches that
   * include a tool call are refused outright rather than partially forwarded.
   * Returns `'forward'` when the request should continue upstream unchanged.
   */
  private async answerGatedToolCall(
    gate: McpProxiedToolCallGate,
    route: InternalMcpProxyRoute,
    body: string,
    res: ServerResponse,
  ): Promise<'answered' | 'forward'> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return 'forward';
    }
    const isToolCall = (value: unknown): value is Record<string, unknown> =>
      isRecord(value) && value.method === 'tools/call';
    if (Array.isArray(parsed)) {
      if (!parsed.some(isToolCall)) return 'forward';
      writeJson(res, 200, {
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Batched tool calls are not accepted on this route.',
        },
        id: null,
      });
      return 'answered';
    }
    if (!isToolCall(parsed)) return 'forward';
    const id =
      typeof parsed.id === 'string' || typeof parsed.id === 'number'
        ? parsed.id
        : null;
    const params = isRecord(parsed.params) ? parsed.params : {};
    const tool = typeof params.name === 'string' ? params.name : null;
    const args = isRecord(params.arguments) ? params.arguments : {};
    let allowed = false;
    if (tool !== null) {
      try {
        allowed = await gate({
          proxyUrl: this.options.proxyUrl(route.routeId),
          tool,
          args,
          ...(id !== null ? { requestId: String(id) } : {}),
        });
      } catch (error) {
        logMainProcessError('MCP proxied tool-call gate failed', error);
      }
    }
    if (allowed) return 'forward';
    writeJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `${tool ?? 'Tool'} was denied.` }],
        isError: true,
      },
    });
    return 'answered';
  }

  /** CAN-4126: one authorization attempt for an OAuth route. */
  private async authorizeUpstream(
    route: InternalMcpProxyRoute,
  ): Promise<
    | { kind: 'authorized'; authorization: McpUpstreamAuthorization }
    | { kind: 'none' }
    | { kind: 'unavailable' }
  > {
    if (!route.credential) return { kind: 'none' };
    try {
      const outcome = await this.options.credentials.authorize({
        credential: route.credential,
        purpose: 'mcp.upstream.forward',
        upstreamUrl: route.upstreamUrl,
      });
      return outcome.status === 'authorized'
        ? { kind: 'authorized', authorization: outcome.authorization }
        : { kind: 'none' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  private async forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    route: InternalMcpProxyRoute,
  ): Promise<void> {
    const selectedRouteActive = (gate?: McpProxiedToolCallGate): boolean =>
      !route.requireToolCallGate ||
      (this.routes.get(route.routeId) === route &&
        route.sessionId !== null &&
        (gate
          ? this.sessionToolCallGates.get(route.sessionId) === gate
          : this.sessionToolCallGates.has(route.sessionId)));
    const selectedRouteUnavailable = (): void => {
      writeJson(res, 200, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Selected MCP route is unavailable.' },
      });
    };
    const answerAuthorizationRequired = (): void => {
      writeJson(res, 401, {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'MCP server authorization required',
        },
        id: null,
      });
    };
    const answerAuthorizationUnavailable = (): void => {
      res.setHeader('Retry-After', '30');
      writeJson(res, 503, {
        jsonrpc: '2.0',
        error: {
          code: -32002,
          message:
            'MCP authorization is temporarily unavailable. Try again shortly.',
        },
        id: null,
      });
    };
    if (!selectedRouteActive()) {
      selectedRouteUnavailable();
      return;
    }
    let authorization: McpUpstreamAuthorization | null = null;
    if (route.authSupplier !== 'canopy-cloud' && route.oauthEnabled) {
      const first = await this.authorizeUpstream(route);
      if (first.kind === 'unavailable') {
        answerAuthorizationUnavailable();
        return;
      }
      if (first.kind === 'none' && route.oauthRequired !== false) {
        answerAuthorizationRequired();
        return;
      }
      if (first.kind === 'authorized') authorization = first.authorization;
    }

    // A session that owns this route may gate tool calls at execution time;
    // its POST bodies are read here so the JSON-RPC method can be inspected.
    const gate =
      route.sessionId !== null
        ? this.sessionToolCallGates.get(route.sessionId)
        : undefined;
    if (!selectedRouteActive(gate)) {
      selectedRouteUnavailable();
      return;
    }
    let bufferedBody: string | null = null;
    if (gate && req.method === 'POST') {
      try {
        bufferedBody = await readRequestBody(req);
      } catch (error) {
        writeJson(res, error instanceof RequestBodyTooLargeError ? 413 : 400, {
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Request body could not be read.' },
          id: null,
        });
        return;
      }
      if (
        (await this.answerGatedToolCall(gate, route, bufferedBody, res)) ===
        'answered'
      )
        return;
    }

    if (!selectedRouteActive(gate)) {
      selectedRouteUnavailable();
      return;
    }

    let forwardHeaders: Record<string, string>;
    try {
      forwardHeaders = await buildForwardHeaders(req, route);
    } catch (error: unknown) {
      const signedOut =
        error instanceof CanopyCloudClientError &&
        error.code === 'missing-api-key';
      if (signedOut) {
        route.reauthRequired = true;
        setAccountMcpRouteReauthRequired(route.routeId, true);
      }
      writeJson(res, signedOut ? 401 : 502, {
        error: signedOut ? 'mcp_reauth_required' : 'account_route_unavailable',
      });
      return;
    }
    if (!selectedRouteActive(gate)) {
      selectedRouteUnavailable();
      return;
    }
    let appliedAuthorization = false;
    if (authorization) {
      if (authorization.apply(forwardHeaders) === 'applied')
        appliedAuthorization = true;
      else {
        const again = await this.authorizeUpstream(route);
        if (!selectedRouteActive(gate)) {
          selectedRouteUnavailable();
          return;
        }
        if (again.kind === 'unavailable') {
          answerAuthorizationUnavailable();
          return;
        }
        if (again.kind === 'none') {
          if (route.oauthRequired !== false) {
            answerAuthorizationRequired();
            return;
          }
          authorization = null;
        } else {
          if (again.authorization.apply(forwardHeaders) !== 'applied') {
            answerAuthorizationUnavailable();
            return;
          }
          authorization = again.authorization;
          appliedAuthorization = true;
        }
      }
    }

    const upstreamPath = `${route.parsedUpstream.pathname}${route.parsedUpstream.search}`;
    const options: RequestOptions = {
      protocol: route.parsedUpstream.protocol,
      hostname: route.parsedUpstream.hostname,
      port: route.parsedUpstream.port,
      method: req.method,
      path: upstreamPath,
      headers: forwardHeaders,
    };
    const requestFn =
      route.parsedUpstream.protocol === 'https:' ? httpsRequest : httpRequest;

    const upstreamReq = requestFn(options, (upstreamRes) => {
      const upstreamStatusCode = upstreamRes.statusCode;
      if (route.authSupplier === 'canopy-cloud') {
        if (upstreamStatusCode === 401) {
          // Observe a bounded copy while piping the original bytes and headers.
          const chunks: Buffer[] = [];
          let size = 0;
          upstreamRes.on('data', (chunk: Buffer): void => {
            size += chunk.length;
            if (size <= MAX_REQUEST_BODY_BYTES) chunks.push(chunk);
          });
          upstreamRes.on('end', (): void => {
            if (size > MAX_REQUEST_BODY_BYTES) return;
            try {
              const body: unknown = JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              );
              if (isRecord(body) && body.error === 'mcp_reauth_required') {
                route.reauthRequired = true;
                setAccountMcpRouteReauthRequired(route.routeId, true);
              }
            } catch {
              /* Non-JSON 401 responses are forwarded too. */
            }
          });
        } else if (
          upstreamStatusCode &&
          upstreamStatusCode >= 200 &&
          upstreamStatusCode < 300
        ) {
          route.reauthRequired = false;
          setAccountMcpRouteReauthRequired(route.routeId, false);
        }
      }
      let invalidation: Promise<void> | undefined;
      if (
        appliedAuthorization &&
        authorization &&
        (upstreamStatusCode === 401 || upstreamStatusCode === 403)
      ) {
        const diagnostic = `OAuth token was rejected by the upstream MCP server (HTTP ${String(
          upstreamStatusCode,
        )}).`;
        if (upstreamStatusCode === 401) {
          invalidation = authorization.rejected();
        }
        // Publish for transcript attachment. A route with no owning session
        // (for example a settings-surface health check) has no turn to
        // attach to, so it is intentionally skipped here while still
        // recording the error above.
        if (route.sessionId) {
          const failure = classifyMcpAuthFailure({
            serverId: route.serverId,
            configId: route.configId,
            displayName: route.displayName,
            statusCode: upstreamStatusCode,
            diagnostic,
          });
          if (failure) {
            recordPendingMcpAuthFailure(route.sessionId, failure);
          }
        }
      }
      const forwardResponse = (): void => {
        if (res.destroyed) {
          upstreamRes.destroy();
          return;
        }
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          upstreamRes.statusMessage,
          copyResponseHeaders(upstreamRes),
        );
        upstreamRes.pipe(res);
      };
      // Persist the rejection before the caller can retry the failed request.
      if (invalidation) void invalidation.then(forwardResponse);
      else forwardResponse();
    });

    upstreamReq.on('error', (error: Error) => {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      writeJson(res, 502, {
        error: 'MCP proxy upstream request failed',
        message: error.message,
      });
    });

    if (bufferedBody !== null) upstreamReq.end(bufferedBody);
    else req.pipe(upstreamReq);
  }
}
