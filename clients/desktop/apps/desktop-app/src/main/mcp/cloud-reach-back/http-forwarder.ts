import { createHash } from 'node:crypto';
import {
  MCP_HOST_REQUEST_HEADERS,
  MCP_HOST_RESPONSE_MAX_BODY_BYTES,
} from '@canopy/protocol/canopy-core';
import type { McpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import type { McpHttpProxyServiceForResolver } from '../../plugins/plugin-resolver';
import type { ReachBackServer } from './allow-list';
import type { ReachBackForwarder, ReachBackUpstreamResponse } from './serve';

/**
 * Forwards a reach-back request to an HTTP server through the integration
 * server's loopback route (CAN-6176 D25), which injects the config's token
 * or OAuth credential, so none leaves main. One route per allowed server and
 * config, registered on first use and dropped when the server is turned off
 * or the service stops. Every request reads the config again: an edit
 * replaces the route, and a disabled or deleted config drops it and
 * forwards nothing, so no call runs on settings the person has changed.
 *
 * MCP Streamable HTTP may answer a POST with an event stream; reach-back
 * answers once (D24), so the stream is read until the JSON-RPC response
 * for the request arrives and that response is returned as JSON. Progress
 * notifications before it are dropped in v1.
 */

/** The route session reach-back registers under, one per account. */
export const reachBackRouteSession = (accountId: string): string =>
  `cloud-reach-back:${accountId}`;

const JSON_TYPE = 'application/json';

function unsupported(): ReachBackUpstreamResponse {
  return {
    status: 501,
    headers: { 'content-type': JSON_TYPE },
    body: Buffer.from(JSON.stringify({ error: 'mcp_server_unsupported' })),
  };
}

/** Reads at most `limit` bytes; null when the body is larger. */
async function readCapped(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The JSON-RPC response for `id` in an event stream, or null. */
export function responseFromEventStream(
  text: string,
  id: unknown,
): string | null {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      continue;
    }
    if (
      typeof message === 'object' &&
      message !== null &&
      'id' in message &&
      message.id === id &&
      ('result' in message || 'error' in message)
    )
      return data;
  }
  return null;
}

function requestId(body: Uint8Array): unknown {
  try {
    const message: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
    return typeof message === 'object' && message !== null && 'id' in message
      ? message.id
      : undefined;
  } catch {
    return undefined;
  }
}

export function createReachBackHttpForwarder(deps: {
  readonly accountId: () => string | null;
  readonly readServer: (serverId: string) => Promise<McpServerFile>;
  readonly service: McpHttpProxyServiceForResolver & {
    unregisterRoutesForSession(sessionId: string): void;
  };
  /** The integration server's port: the one it runs on, or its preference. */
  readonly port: () => number;
  readonly registerRoute: (args: {
    serverFile: McpServerFile;
    configId: string;
    sessionId: string;
    service: McpHttpProxyServiceForResolver;
    port: number;
  }) => Promise<{ routeId: string; url: string } | null>;
  readonly fetch?: typeof fetch;
}): ReachBackForwarder & {
  /** Drops the route of a server turned off. */
  forget(serverId: string, configId: string): void;
  /** Drops every route of an account. */
  close(accountId: string): void;
} {
  const send = deps.fetch ?? globalThis.fetch;
  interface CachedRoute {
    /** A digest of the definition and config the route was built from. */
    readonly revision: string;
    readonly target: Promise<{ routeId: string; url: string } | null>;
  }
  const routes = new Map<string, CachedRoute>();
  const key = (serverId: string, configId: string): string =>
    JSON.stringify([serverId, configId]);
  // A digest, so the map never keeps a config's token or headers.
  const revisionOf = (serverFile: McpServerFile, configId: string): string =>
    createHash('sha256')
      .update(
        JSON.stringify([
          serverFile.server.definition,
          serverFile.server.configs.find((config) => config.id === configId) ??
            null,
        ]),
      )
      .digest('hex');
  const drop = (id: string): void => {
    const cached = routes.get(id);
    routes.delete(id);
    void cached?.target
      .then((target) => {
        if (target !== null) deps.service.unregisterRoute(target.routeId);
      })
      .catch(() => undefined);
  };

  const route = async (
    accountId: string,
    server: ReachBackServer,
  ): Promise<{
    revision: string;
    target: Promise<{ routeId: string; url: string } | null>;
  }> => {
    const id = key(server.serverId, server.configId);
    let serverFile: McpServerFile;
    try {
      serverFile = await deps.readServer(server.serverId);
    } catch (error) {
      // Gone or unreadable: nothing runs through the route built before.
      drop(id);
      throw error;
    }
    const revision = revisionOf(serverFile, server.configId);
    const cached = routes.get(id);
    if (cached?.revision === revision) return cached;
    drop(id);
    const entry: CachedRoute = {
      revision,
      target: deps.registerRoute({
        serverFile,
        configId: server.configId,
        sessionId: reachBackRouteSession(accountId),
        service: deps.service,
        port: deps.port(),
      }),
    };
    // A failed registration is tried again on the next request.
    entry.target.catch(() => {
      if (routes.get(id) === entry) routes.delete(id);
    });
    routes.set(id, entry);
    return entry;
  };

  /** Sends one request through its route and reads the server's answer. */
  const relay = async (
    url: string,
    request: Parameters<ReachBackForwarder['forward']>[1],
  ): Promise<ReachBackUpstreamResponse> => {
    const headers = new Headers();
    for (const name of MCP_HOST_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (value !== undefined) headers.set(name, value);
    }
    const response = await send(url, {
      method: request.method,
      headers,
      ...(request.method === 'POST'
        ? { body: new Uint8Array(request.body) }
        : {}),
      signal: request.signal,
    });
    const body = await readCapped(response, MCP_HOST_RESPONSE_MAX_BODY_BYTES);
    const passed: Record<string, string> = {};
    for (const name of ['mcp-session-id', 'mcp-protocol-version'])
      if (response.headers.has(name))
        passed[name] = response.headers.get(name) ?? '';
    if (body === null)
      return {
        status: response.status,
        headers: passed,
        // Larger than the protocol carries: the caller answers 502.
        body: new Uint8Array(MCP_HOST_RESPONSE_MAX_BODY_BYTES + 1),
      };
    const type = response.headers.get('content-type') ?? '';
    if (!type.startsWith('text/event-stream'))
      return {
        status: response.status,
        headers: { ...passed, ...(type ? { 'content-type': type } : {}) },
        body,
      };
    const answer = responseFromEventStream(
      Buffer.from(body).toString('utf8'),
      requestId(request.body),
    );
    return answer === null
      ? {
          status: 502,
          headers: { 'content-type': JSON_TYPE },
          body: Buffer.from(JSON.stringify({ error: 'mcp_response_missing' })),
        }
      : {
          status: response.status,
          headers: { ...passed, 'content-type': JSON_TYPE },
          body: Buffer.from(answer),
        };
  };

  return {
    async forward(server, request) {
      const accountId = deps.accountId();
      if (accountId === null) throw new Error('Signed out.');
      const { revision, target: pending } = await route(accountId, server);
      if (
        request.expectedConfigRevision !== undefined &&
        request.expectedConfigRevision !== revision
      )
        return 'configChanged';
      const target = await pending;
      if (target === null)
        return { ...unsupported(), configRevision: revision };
      // The route's URL as the integration server serves it now: a port
      // change moves the listener, not the route.
      return {
        ...(await relay(deps.service.getProxyUrl(target.routeId), request)),
        configRevision: revision,
      };
    },
    forget(serverId, configId) {
      drop(key(serverId, configId));
    },
    close(accountId) {
      routes.clear();
      deps.service.unregisterRoutesForSession(reachBackRouteSession(accountId));
    },
  };
}
