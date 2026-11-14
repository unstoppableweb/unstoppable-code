import { randomBytes } from 'node:crypto';
import {
  MCP_AUTHORIZATION_TTL_MS,
  McpAuthorizationUnavailableError,
  type McpAuthorizationOutcome,
  type McpAuthorizationRequest,
  type McpConnectionCredentials,
  type McpCredentialRef,
  type McpUpstreamAuthorization,
} from '@canopy/core-runtime/node/mcp-auth';

/** One `owner.mcp.authorize` answer: a grant and its header, or none. */
export interface OwnerMcpAuthorizeAnswer {
  readonly grantId: string | null;
  /** The `Authorization` header value, from the host-local owner values. */
  readonly authorization?: string;
  /**
   * Why the owner gave none. Only `stale_route` lets this run bind the route
   * again; any other reason, known or not, refuses.
   */
  readonly refused?: string;
}

/** The run's owner requests these credentials forward to (CAN-6168). */
export interface OwnerMcpRequests {
  /** Raises `owner.mcp.authorize`; throws when the owner can't decide now. */
  authorize(
    routeRef: string,
    signal: AbortSignal | undefined,
  ): Promise<OwnerMcpAuthorizeAnswer>;
  /** Raises `owner.mcp.rejected`. Never rejects. */
  rejected(grantId: string): Promise<void>;
}

/**
 * Binds the route's server again for the run's current owner, replacing
 * `staleRef`; null when it binds none. The run shares one replacement across
 * every step that found the same route stale.
 */
export type OwnerMcpRebind = (staleRef: string) => Promise<string | null>;

/** Credentials whose refs name routes Electron main bound for this run. */
export interface OwnerMcpCredentials extends McpConnectionCredentials {
  /** A local credential for one `owner.mcp.bind` route. Holds no secret. */
  register(routeRef: string, rebind: OwnerMcpRebind): McpCredentialRef;
}

interface RegisteredRoute {
  routeRef: string;
  readonly rebind: OwnerMcpRebind;
  /** A rebind in flight, which concurrent requests on this route share. */
  rebinding?: Promise<string | null>;
}

/**
 * The daemon's side of a plugin MCP server's OAuth credential (CAN-6168):
 * every upstream request asks Electron main for one authorization over the
 * run's owner session. The header lives in one handle, written once and
 * within MCP_AUTHORIZATION_TTL_MS, and is never stored, logged or retried.
 * A rejection asks the owner to invalidate exactly that grant, once.
 * Released credentials answer none.
 *
 * A route bound under an earlier owner subscription answers `stale_route`:
 * the request binds the server again once and asks once more. A second
 * stale answer fails the request closed. The reason never leaves these
 * credentials: the agent sees only the proxy's own refusal.
 */
export function createOwnerMcpCredentials(
  requests: OwnerMcpRequests,
  now: () => number = (): number => Date.now(),
): OwnerMcpCredentials {
  const routes = new Map<string, RegisteredRoute>();

  const rebound = async (
    credentialId: string,
    route: RegisteredRoute,
    staleRef: string,
  ): Promise<string | null> => {
    // Another request on this route already bound it again.
    if (route.routeRef !== staleRef) return route.routeRef;
    route.rebinding ??= route
      .rebind(staleRef)
      .then((routeRef) => {
        if (routeRef !== null && routes.get(credentialId) === route)
          route.routeRef = routeRef;
        return routeRef;
      })
      .finally(() => {
        route.rebinding = undefined;
      });
    return route.rebinding;
  };

  return {
    register(routeRef, rebind): McpCredentialRef {
      const credentialId = `mcpc1_${randomBytes(16).toString('base64url')}`;
      routes.set(credentialId, { routeRef, rebind });
      return { credentialId };
    },
    release(credential): void {
      routes.delete(credential.credentialId);
    },
    async authorize(
      request: McpAuthorizationRequest,
    ): Promise<McpAuthorizationOutcome> {
      const credentialId = request.credential.credentialId;
      const route = routes.get(credentialId);
      if (route === undefined) return { status: 'none' };
      const ask = async (
        routeRef: string,
      ): Promise<OwnerMcpAuthorizeAnswer> => {
        try {
          return await requests.authorize(routeRef, request.signal);
        } catch {
          // The owner went away or failed: never a credential of our own.
          throw new McpAuthorizationUnavailableError();
        }
      };
      const firstRef = route.routeRef;
      let answer = await ask(firstRef);
      if (answer.grantId === null && answer.refused === 'stale_route') {
        let routeRef: string | null;
        try {
          routeRef = await rebound(credentialId, route, firstRef);
        } catch {
          throw new McpAuthorizationUnavailableError();
        }
        if (routeRef === null || !routes.has(credentialId))
          return { status: 'none' };
        answer = await ask(routeRef);
        // One rebind and one retry: a route still stale fails closed.
        if (answer.grantId === null && answer.refused === 'stale_route')
          throw new McpAuthorizationUnavailableError();
      }
      const header = answer.authorization;
      if (answer.grantId === null || header === undefined)
        return { status: 'none' };
      const grantId = answer.grantId;
      const issuedAt = now();
      let applied = false;
      let spent = false;
      let invalidated: Promise<void> | undefined;
      const authorization: McpUpstreamAuthorization = {
        apply(headers): 'applied' | 'stale' {
          if (
            spent ||
            !routes.has(credentialId) ||
            now() - issuedAt > MCP_AUTHORIZATION_TTL_MS
          ) {
            spent = true;
            return 'stale';
          }
          spent = true;
          applied = true;
          headers.Authorization = header;
          return 'applied';
        },
        rejected(): Promise<void> {
          if (!applied) return Promise.resolve();
          invalidated ??= requests.rejected(grantId).catch(() => undefined);
          return invalidated;
        },
      };
      return { status: 'authorized', authorization };
    },
  };
}
