import { randomBytes } from 'node:crypto';
import type {
  McpAuthorizationOutcome,
  McpAuthorizationRequest,
  McpCredentialRef,
  McpUpstreamAuthorization,
} from '@canopy/core-runtime/node/mcp-auth';
import type { McpOAuthSubject } from '../mcp/oauth-credentials';
import type { PluginMcpOAuthRoute } from '../plugins/plugin-resolver';

/*
 * Electron main's side of a daemon run's plugin MCP OAuth (CAN-6168, X1 (a)):
 * the run's steps name a plugin server and the hash of the declaration they
 * read; this app reads the declaration itself and binds its own credential
 * for the run. The daemon receives an opaque route ref, then one header per
 * upstream request, for the upstream this app read. Tokens stay with the
 * broker; nothing here logs a value.
 */

/** The most routes or outstanding grants one run holds. */
export const PIPELINE_OWNER_MCP_ROUTES_MAX = 64;
export const PIPELINE_OWNER_MCP_GRANTS_MAX = 256;

/** The broker members this side uses: the app's CAN-4126 broker. */
export interface PipelineOwnerMcpBroker {
  bind(subject: McpOAuthSubject): McpCredentialRef;
  release(credential: McpCredentialRef): void;
  authorize(request: McpAuthorizationRequest): Promise<McpAuthorizationOutcome>;
}

export interface PipelineOwnerMcpDeps {
  readonly broker: () => PipelineOwnerMcpBroker;
  /** The owner subscription's generation; a route ends with the subscription that bound it. */
  readonly generation: () => number;
  /** This app's own resolution of a plugin server; null refuses. */
  readonly resolve: (request: {
    marketplaceId: string;
    pluginName: string;
    serverName: string;
    contentHash: string;
  }) => Promise<PluginMcpOAuthRoute | null>;
}

interface BoundRoute {
  readonly credential: McpCredentialRef;
  readonly upstreamUrl: string;
  readonly generation: number;
}

function mint(prefix: 'mcpr1_' | 'mcpg1_'): string {
  return `${prefix}${randomBytes(16).toString('base64url')}`;
}

/** One daemon run's bound MCP routes and the authorizations it presented. */
export class PipelineOwnerMcpCredentials {
  private readonly routes = new Map<string, BoundRoute>();
  private readonly grants = new Map<string, McpUpstreamAuthorization>();
  /** Binds still resolving, which count against the route cap. */
  private pending = 0;
  private closed = false;

  constructor(private readonly deps: PipelineOwnerMcpDeps) {}

  /** A route ref for the server, bound to this run and the current owner subscription, or null when this app refuses it. */
  async bind(request: {
    marketplaceId: string;
    pluginName: string;
    serverName: string;
    contentHash: string;
  }): Promise<string | null> {
    if (this.routes.size + this.pending >= PIPELINE_OWNER_MCP_ROUTES_MAX)
      return null;
    const generation = this.deps.generation();
    this.pending += 1;
    let route: PluginMcpOAuthRoute | null;
    try {
      route = await this.deps.resolve(request);
    } finally {
      this.pending -= 1;
    }
    if (route === null || this.closed || generation !== this.deps.generation())
      return null;
    const broker = this.deps.broker();
    let credential: McpCredentialRef;
    try {
      credential = broker.bind(route.subject);
    } catch {
      return null;
    }
    const routeRef = mint('mcpr1_');
    this.routes.set(routeRef, {
      credential,
      upstreamUrl: route.upstreamUrl,
      generation,
    });
    return routeRef;
  }

  /**
   * One header for one upstream request on a route this run bound, with the
   * grant that names it; null when the broker holds no usable credential.
   * Throws when the broker cannot decide now, so the request fails closed.
   */
  async authorize(
    routeRef: string,
    signal: AbortSignal,
  ): Promise<{ grantId: string; authorization: string } | null> {
    const route = this.routes.get(routeRef);
    if (route === undefined || this.expired(routeRef, route)) return null;
    const outcome = await this.deps.broker().authorize({
      credential: route.credential,
      purpose: 'mcp.upstream.forward',
      upstreamUrl: route.upstreamUrl,
      signal,
    });
    // The owner subscription may have ended while the broker resolved.
    if (
      outcome.status !== 'authorized' ||
      this.closed ||
      this.expired(routeRef, route)
    )
      return null;
    const headers: Record<string, string> = {};
    if (outcome.authorization.apply(headers) !== 'applied') return null;
    const authorization = headers.Authorization;
    if (authorization === undefined || authorization === '') return null;
    if (this.grants.size >= PIPELINE_OWNER_MCP_GRANTS_MAX) {
      const oldest = this.grants.keys().next();
      if (!oldest.done) this.grants.delete(oldest.value);
    }
    const grantId = mint('mcpg1_');
    this.grants.set(grantId, outcome.authorization);
    return { grantId, authorization };
  }

  /**
   * Whether `route` was bound under an earlier owner subscription; such a ref
   * ended with it, so it is released here.
   */
  private expired(routeRef: string, route: BoundRoute): boolean {
    if (route.generation === this.deps.generation()) return false;
    if (this.routes.get(routeRef) === route) {
      this.routes.delete(routeRef);
      this.deps.broker().release(route.credential);
    }
    return true;
  }

  /** The upstream refused a grant's header: invalidates exactly that token, once. */
  async rejected(grantId: string): Promise<void> {
    const grant = this.grants.get(grantId);
    if (grant === undefined) return;
    this.grants.delete(grantId);
    await grant.rejected();
  }

  /** Releases every credential the run bound. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const broker = this.routes.size > 0 ? this.deps.broker() : null;
    for (const route of this.routes.values()) broker?.release(route.credential);
    this.routes.clear();
    this.grants.clear();
  }
}
