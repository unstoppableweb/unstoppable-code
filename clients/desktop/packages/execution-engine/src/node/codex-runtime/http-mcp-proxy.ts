import { randomBytes } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

interface HttpMcpRoute {
  ownerId: string;
  upstreamUrl: URL;
  headers: Record<string, string>;
  activeRequests: Set<ClientRequest>;
}

export interface CodexHttpMcpProxyLease {
  routeId: string;
  url: string;
}

function normalizedHeaders(
  incoming: IncomingHttpHeaders,
  fixed: Record<string, string>,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming)) {
    const normalized = key.toLowerCase();
    if (
      value !== undefined &&
      !HOP_BY_HOP_HEADERS.has(normalized) &&
      normalized !== 'authorization'
    ) {
      headers[normalized] = value;
    }
  }
  for (const [key, value] of Object.entries(fixed)) {
    headers[key.toLowerCase()] = value;
  }
  return headers;
}

function responseHeaders(
  incoming: IncomingHttpHeaders,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(incoming).filter(
      ([key, value]) =>
        value !== undefined && !HOP_BY_HOP_HEADERS.has(key.toLowerCase()),
    ),
  ) as Record<string, string | string[]>;
}

export class CodexHttpMcpProxyService {
  private readonly routes = new Map<string, HttpMcpRoute>();
  private server: Server | null = null;
  private port: number | null = null;
  private startPromise: Promise<void> | null = null;

  async registerRoute(options: {
    ownerId: string;
    upstreamUrl: string;
    headers?: Record<string, string>;
  }): Promise<CodexHttpMcpProxyLease> {
    await this.ensureStarted();
    const routeId = randomBytes(24).toString('hex');
    this.routes.set(routeId, {
      ownerId: options.ownerId,
      upstreamUrl: new URL(options.upstreamUrl),
      headers: { ...(options.headers ?? {}) },
      activeRequests: new Set<ClientRequest>(),
    });
    return {
      routeId,
      url: `http://127.0.0.1:${String(this.port)}/mcp/${routeId}`,
    };
  }

  revokeOwner(ownerId: string): void {
    for (const [routeId, route] of Array.from(this.routes.entries())) {
      if (route.ownerId !== ownerId) continue;
      this.routes.delete(routeId);
      for (const request of Array.from(route.activeRequests)) {
        request.destroy();
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const route of Array.from(this.routes.values())) {
      for (const request of Array.from(route.activeRequests)) {
        request.destroy();
      }
    }
    this.routes.clear();
    const server = this.server;
    this.server = null;
    this.port = null;
    this.startPromise = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.server && this.port !== null) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        this.proxy(request, response);
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Codex HTTP MCP proxy did not bind loopback'));
          return;
        }
        this.server = server;
        this.port = address.port;
        resolve();
      });
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private proxy(request: IncomingMessage, response: ServerResponse): void {
    const match = request.url?.match(/^\/mcp\/([a-f0-9]{48})$/);
    const route = match?.[1] ? this.routes.get(match[1]) : undefined;
    if (!route) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"MCP proxy route unavailable"}');
      return;
    }
    const requestImpl =
      route.upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = requestImpl(
      route.upstreamUrl,
      {
        method: request.method,
        headers: normalizedHeaders(request.headers, route.headers),
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          responseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      },
    );
    route.activeRequests.add(upstream);
    const cleanup = (): void => {
      route.activeRequests.delete(upstream);
    };
    upstream.once('close', cleanup);
    upstream.once('error', () => {
      cleanup();
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end('{"error":"MCP upstream request failed"}');
        return;
      }
      response.destroy();
    });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => {
      if (!response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
  }
}
