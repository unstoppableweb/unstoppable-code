import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import type { BrowserWindow } from 'electron';
import {
  buildCanopyHooksClaudeTerminalRoute,
  buildCanopyMcpProxyRoute,
  buildCanopyMcpWorktreeSessionRoute,
  CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH,
  CANOPY_MCP_PROXY_PATH,
  CANOPY_MCP_WORKTREE_SESSION_PATH,
  DESKTOP_INTEGRATION_SERVER_HOST,
  extractDesktopIntegrationToken,
  isClaudeTerminalHookCallbackBody,
  LEGACY_MCP_PROXY_PATH,
} from '@canopy/desktop-shared/lib/desktop-integration-transport';
import type {
  McpProxyState,
  McpProxyStatus,
  McpServerConfigData,
  McpServerDefinitionData,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  DEFAULT_MCP_PROXY_PORT,
  IPC_CHANNELS,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  AgentMcpConnections,
  type McpProxiedToolCallGate,
} from './agent-mcp-connections';
import {
  getHeaderValue,
  getJsonRpcId,
  isRecord,
  jsonRpcError,
  jsonRpcInternalError,
  readRequestBody,
  RequestBodyTooLargeError,
  writeJson,
  writePayloadTooLargeJsonRpc,
} from './integration-http';
import { writeMcpOAuthCallbackPage } from './oauth-callback-page';
import { getMcpOAuthCoordinator } from './oauth-coordinator';
import {
  getMcpOAuthCredentials,
  mcpOAuthSubjectForRegistration,
} from './oauth-credentials';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { sendToWindow } from '../lib/window-send';
import { rejectRequest } from './pending-requests';
import {
  type getCanopyRouteTools,
  getClaudeCanopyToolKey,
  getClaudeCanopyToolSurface,
  getClaudeTerminalAppAdvisorToolKey,
  listCanopyRouteTools,
} from './canopy-route-tools';

import {
  CanopyToolRouter,
  type CanopyMcpRequestContext,
  type CanopyWorktreeSessionRoute,
} from './canopy-tool-router';
import { createWindowInterfaceToolRequests } from './interface-tool-requests';

/**
 * The desktop integration server (CAN-4125): loopback transport and lifecycle.
 * Upstream agent connections live in agent-mcp-connections.ts, the Canopy tool
 * router in canopy-tool-router.ts and presentation requests behind
 * interface-tool-requests.ts.
 */

export const MCP_PROXY_HEALTH_SERVICE = 'desktop-integration-server';
const MCP_PROXY_HEALTH_VERSION = 1;

export interface McpProxyBroadcastHandlers {
  status: (state: McpProxyState) => void;
}

type WindowAccessor = () => BrowserWindow | null;

export type { McpProxiedToolCallGate } from './agent-mcp-connections';

/**
 * Registration input. The integration server binds `oauthDefinition` and `oauthConfig` into an owner-held credential; neither reaches the connection service (CAN-4126).
 */
export interface McpProxyRoute {
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
  oauthDefinition?: McpServerDefinitionData;
  oauthConfig?: McpServerConfigData;
  /** Delegated routes must never forward without their live parent gate. */
  requireToolCallGate?: boolean;
}

/**
 * Registration input. The integration server binds `oauthDefinition` and `oauthConfig` into an owner-held credential; neither reaches the connection service (CAN-4126).
 */
export interface McpProxyRouteRegistration extends Omit<
  McpProxyRoute,
  'routeId' | 'reauthRequired'
> {
  routeKey?: string;
  /** The capability snapshot's host-neutral key for a plugin server's route (CAN-6168). */
  snapshotKey?: string;
}
export type {
  CanopyWorktreeSessionRoute,
  ClaudeTerminalHookHandler,
} from './canopy-tool-router';

/**
 * Interval between heartbeats while a long-running `/ui` tool call
 * (AskUserQuestion) awaits the user. Claude Code's MCP idle watchdog is 5
 * minutes by default, so emit progress comfortably before that boundary.
 */
const CANOPY_MCP_SSE_KEEPALIVE_MS = 240_000;

export { REPORT_STRUCTURED_RESULT_TOOL_NAME } from './canopy-route-tools';

export interface McpProxyHealthCheck {
  ok: true;
  service: typeof MCP_PROXY_HEALTH_SERVICE;
  version: typeof MCP_PROXY_HEALTH_VERSION;
  port: number | null;
  status: McpProxyStatus;
  routeCount: number;
}

function isMcpProxyStatus(value: unknown): value is McpProxyStatus {
  return value === 'stopped' || value === 'running' || value === 'error';
}

function getIntegrationToken(req: IncomingMessage): string | null {
  return extractDesktopIntegrationToken((name) => {
    const value = getHeaderValue(req.headers, name.toLowerCase());
    return value ?? getHeaderValue(req.headers, name);
  });
}

function integrationTokenMatches(
  req: IncomingMessage,
  expected: string,
): boolean {
  const actual = getIntegrationToken(req);
  if (actual === null) {
    return false;
  }
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isAllowedRequestHost(host: string | undefined, port: number): boolean {
  if (!host) {
    return false;
  }
  return (
    host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`
  );
}

function assertLocalhostHostOrigin(
  req: IncomingMessage,
  res: ServerResponse,
  port: number | null,
): boolean {
  if (port === null) {
    res.writeHead(503);
    res.end();
    return false;
  }
  if (!isAllowedRequestHost(getHeaderValue(req.headers, 'host'), port)) {
    res.writeHead(421);
    res.end();
    return false;
  }
  if (getHeaderValue(req.headers, 'origin')) {
    res.writeHead(403);
    res.end();
    return false;
  }
  return true;
}

function getMcpProgressToken(payload: unknown): string | number | null {
  if (!isRecord(payload) || !isRecord(payload.params)) {
    return null;
  }
  const meta = payload.params._meta;
  if (!isRecord(meta)) {
    return null;
  }
  const token = meta.progressToken;
  return typeof token === 'string' || typeof token === 'number' ? token : null;
}

function mcpProgressNotification(
  progressToken: string | number,
  progress: number,
  message: string,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      progressToken,
      progress,
      message,
    },
  };
}

async function readJsonRpcIdFromRequest(
  req: IncomingMessage,
): Promise<unknown> {
  try {
    const raw = await readRequestBody(req);
    return raw.length > 0 ? getJsonRpcId(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function buildPortInUseMessage(
  port: number,
  health: McpProxyHealthCheck | null,
): string {
  if (health) {
    return `MCP proxy port ${String(port)} is already in use by another ${BRAND.displayName} MCP proxy. Close the other ${BRAND.displayName} instance or choose another port.`;
  }
  return `MCP proxy port ${String(port)} is already in use. Choose another port.`;
}

function isValidPort(port: unknown): port is number {
  return (
    typeof port === 'number' &&
    Number.isFinite(port) &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
  );
}

export function getDevMcpProxyPortOverride(): number | null {
  if (
    typeof __CANOPY_DEV_MCP_PROXY_PORT__ !== 'undefined' &&
    isValidPort(__CANOPY_DEV_MCP_PROXY_PORT__)
  ) {
    return __CANOPY_DEV_MCP_PROXY_PORT__;
  }

  return null;
}

export class McpHttpProxyService {
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;
  private currentPort: number | null = null;
  private sockets = new Set<Socket>();
  private readonly credentials = getMcpOAuthCredentials();
  private readonly connections = new AgentMcpConnections({
    proxyUrl: (routeId): string => this.getProxyUrl(routeId),
    listening: (): boolean => this.currentPort !== null,
    credentials: this.credentials,
  });
  private readonly tools = new CanopyToolRouter({
    interfaceRequests: createWindowInterfaceToolRequests(() =>
      this.getWindow(),
    ),
  });
  private broadcasts: McpProxyBroadcastHandlers | null = null;
  private status: McpProxyStatus = 'stopped';
  private lastError: string | undefined;
  private lastRefreshedAt: string | undefined;
  private preferredPort: number = DEFAULT_MCP_PROXY_PORT;
  private getWindow: WindowAccessor = () => null;

  private resolvePort(port: number): number {
    return getDevMcpProxyPortOverride() ?? port;
  }

  setBroadcastHandlers(handlers: McpProxyBroadcastHandlers): void {
    this.broadcasts = handlers;
    this.broadcastStatus();
  }

  setWindowAccessor(getWindow: WindowAccessor): void {
    this.getWindow = getWindow;
  }

  getState(): McpProxyState {
    const overridePort = getDevMcpProxyPortOverride();
    const preferredPort = overridePort ?? this.preferredPort;
    const portLocked = overridePort !== null;
    return {
      port: this.currentPort ?? preferredPort,
      status: this.status,
      ...(portLocked ? { portLocked: true } : {}),
      ...(this.lastRefreshedAt ? { refreshedAt: this.lastRefreshedAt } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  setPreferredPort(port: number): void {
    this.preferredPort = this.resolvePort(port);
    if (!this.server) {
      this.broadcastStatus();
    }
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getPort(): number | null {
    return this.currentPort;
  }

  async assertPortAvailable(port: number): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    if (this.server && this.currentPort === resolvedPort) {
      return;
    }

    const canBind = await this.canBindPort(resolvedPort);
    if (canBind) {
      return;
    }

    const health = await this.probeHealth(resolvedPort);
    throw new Error(buildPortInUseMessage(resolvedPort, health));
  }

  async refreshPreferredPortStatus(port: number): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    this.preferredPort = resolvedPort;
    if (this.server) {
      if (this.currentPort === resolvedPort) {
        this.markStatus('running');
      } else {
        this.broadcastStatus();
      }
      return;
    }

    try {
      await this.assertPortAvailable(resolvedPort);
      this.markStatus('stopped');
    } catch (error: unknown) {
      this.markStatus(
        'error',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async probeHealth(
    port: number,
    timeoutMs: number = 750,
  ): Promise<McpProxyHealthCheck | null> {
    const controller = new AbortController();
    const timeout = setTimeout((): void => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload)) {
        return null;
      }
      if (
        payload.ok !== true ||
        payload.service !== MCP_PROXY_HEALTH_SERVICE ||
        payload.version !== MCP_PROXY_HEALTH_VERSION
      ) {
        return null;
      }
      return {
        ok: true,
        service: MCP_PROXY_HEALTH_SERVICE,
        version: MCP_PROXY_HEALTH_VERSION,
        port: typeof payload.port === 'number' ? payload.port : null,
        status: isMcpProxyStatus(payload.status) ? payload.status : 'running',
        routeCount:
          typeof payload.routeCount === 'number' &&
          Number.isFinite(payload.routeCount)
            ? payload.routeCount
            : 0,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async canBindPort(port: number): Promise<boolean> {
    const probeServer = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          probeServer.off('error', onError);
          probeServer.off('listening', onListening);
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onListening = (): void => {
          cleanup();
          probeServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        };
        probeServer.once('error', onError);
        probeServer.once('listening', onListening);
        probeServer.listen(port, '127.0.0.1');
      });
      return true;
    } catch {
      return false;
    }
  }

  async ensureStarted(port: number = this.preferredPort): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    this.preferredPort = resolvedPort;
    if (this.server && this.currentPort === resolvedPort) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      if (this.server && this.currentPort === resolvedPort) {
        return;
      }
      if (this.server) {
        if (this.connections.size > 0) {
          return;
        }
        await this.updatePort(resolvedPort);
      }
      return;
    }
    if (this.server) {
      if (this.connections.size > 0) {
        return;
      }
      await this.updatePort(resolvedPort);
      return;
    }

    this.startPromise = (async (): Promise<void> => {
      try {
        await this.assertPortAvailable(resolvedPort);
        await this.listen(resolvedPort);
        this.markStatus('running');
      } catch (error: unknown) {
        this.markStatus(
          'error',
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      } finally {
        this.startPromise = null;
      }
    })();
    await this.startPromise;
  }

  /**
   * Swap the listening socket while preserving registered routes.
   * Existing provider URLs that include the old port become invalid until the
   * caller re-resolves MCP plugin configuration and obtains fresh proxy URLs.
   */
  async updatePort(port: number): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    if (this.server && this.currentPort === resolvedPort) {
      return;
    }

    await this.assertPortAvailable(resolvedPort);
    if (!this.server) {
      this.preferredPort = resolvedPort;
      this.broadcastStatus();
      return;
    }

    const previousPort = this.currentPort;
    await this.closeServer();
    try {
      this.preferredPort = resolvedPort;
      await this.listen(resolvedPort);
      this.markStatus('running');
    } catch (error: unknown) {
      if (previousPort !== null) {
        try {
          this.preferredPort = previousPort;
          await this.listen(previousPort);
          this.markStatus('running');
        } catch {
          this.currentPort = null;
          this.markStatus(
            'error',
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        this.markStatus(
          'error',
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  async registerRoute(
    registration: McpProxyRouteRegistration,
  ): Promise<string> {
    const { oauthDefinition, oauthConfig, ...route } = registration;
    const credential =
      registration.authSupplier !== 'canopy-cloud' && registration.oauthEnabled
        ? this.credentials.bind(
            mcpOAuthSubjectForRegistration({
              serverId: route.serverId,
              configId: route.configId,
              oauthDefinition,
              oauthConfig,
            }),
          )
        : undefined;
    try {
      return await this.connections.register(
        credential ? { ...route, credential } : route,
      );
    } catch (error: unknown) {
      if (credential) this.credentials.release(credential);
      throw error;
    }
  }

  getRouteStatus(routeId: string): { reauthRequired: boolean } | undefined {
    return this.connections.routeStatus(routeId);
  }

  registerMcpProxyRoute(route: McpProxyRouteRegistration): Promise<string> {
    return this.registerRoute(route);
  }

  unregisterRoute(routeId: string): void {
    this.connections.unregister(routeId);
  }

  unregisterMcpProxyRoute(routeId: string): void {
    this.connections.unregister(routeId);
  }

  /** Installs (or replaces) the session's proxied tool-call gate. */
  setSessionToolCallGate(
    sessionId: string,
    gate: McpProxiedToolCallGate,
  ): void {
    this.connections.setSessionToolCallGate(sessionId, gate);
  }

  unregisterRoutesForSession(sessionId: string): void {
    this.connections.disconnectSession(sessionId);
  }

  unregisterMcpProxyRoutesForSession(sessionId: string): void {
    this.connections.disconnectSession(sessionId);
  }

  getProxyUrl(routeId: string): string {
    if (this.currentPort === null) {
      throw new Error('MCP proxy is not started.');
    }
    return `http://${DESKTOP_INTEGRATION_SERVER_HOST}:${String(
      this.currentPort,
    )}${buildCanopyMcpProxyRoute(routeId)}`;
  }

  getCodexCapabilityAuthorityIds(
    mcpServers: Record<string, unknown>,
  ): string[] {
    return this.connections.codexCapabilityAuthorityIds(mcpServers);
  }

  /** Fingerprint v1's authority ids, to recognize a lease written before v2 (CAN-6168). */
  getLegacyCodexCapabilityAuthorityIds(
    mcpServers: Record<string, unknown>,
  ): string[] {
    return this.connections.codexCapabilityAuthorityIds(mcpServers, true);
  }

  /** Stable config identities without persisting credentials or ephemeral proxy addresses. */
  getMcpCapabilityDigests(
    mcpServers: Record<string, unknown>,
  ): Record<string, string> {
    return this.connections.capabilityDigests(mcpServers);
  }

  getCanopyCapabilityDefinitions(sessionKey: string): {
    main: ReturnType<typeof getCanopyRouteTools>;
    ui: ReturnType<typeof getCanopyRouteTools>;
  } {
    return this.tools.capabilityDefinitions(sessionKey);
  }

  getSessionMcpRoute(
    sessionId: string,
    serverId: string,
    configId: string,
  ): { displayName: string } | undefined {
    return this.connections.sessionRoute(sessionId, serverId, configId);
  }

  getMcpProxyUrl(routeId: string): string {
    return this.getProxyUrl(routeId);
  }

  async registerCanopyWorktreeSessionRoute(
    route: CanopyWorktreeSessionRoute,
  ): Promise<string> {
    await this.ensureStarted();
    this.tools.register(route);
    return route.sessionKey;
  }

  unregisterCanopyWorktreeSessionRoute(sessionKey: string): void {
    this.tools.unregister(sessionKey);
  }

  updateCanopyWorktreeSessionDeferredToolsAllowed(
    sessionKey: string,
    allowed: boolean,
  ): boolean {
    return this.tools.updateDeferredToolsAllowed(sessionKey, allowed);
  }

  updateCanopyWorktreeSessionPluginSelections(
    sessionKey: string,
    pluginSelections: ChatTabPluginSelections,
  ): boolean {
    return this.tools.updatePluginSelections(sessionKey, pluginSelections);
  }

  getCanopyWorktreeMcpUrl(sessionKey: string): string {
    if (this.currentPort === null) {
      throw new Error('Desktop integration server is not started.');
    }
    return `http://${DESKTOP_INTEGRATION_SERVER_HOST}:${String(
      this.currentPort,
    )}${buildCanopyMcpWorktreeSessionRoute(sessionKey)}`;
  }

  getCanopyWorktreeUiMcpUrl(sessionKey: string): string {
    return `${this.getCanopyWorktreeMcpUrl(sessionKey)}/ui`;
  }

  getClaudeTerminalHookUrl(sessionKey: string): string {
    if (this.currentPort === null) {
      throw new Error('Desktop integration server is not started.');
    }
    return `http://${DESKTOP_INTEGRATION_SERVER_HOST}:${String(
      this.currentPort,
    )}${buildCanopyHooksClaudeTerminalRoute(sessionKey)}`;
  }

  async shutdown(): Promise<void> {
    await this.closeServer();
    this.connections.clear();
    this.tools.clear();
    this.currentPort = null;
    this.markStatus('stopped');
  }

  private markStatus(status: McpProxyStatus, error?: string): void {
    this.status = status;
    this.lastError = status === 'error' ? error : undefined;
    this.lastRefreshedAt = new Date().toISOString();
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    this.broadcasts?.status(this.getState());
  }

  private async listen(port: number): Promise<void> {
    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on('connection', (socket: Socket): void => {
      this.sockets.add(socket);
      socket.on('close', (): void => {
        this.sockets.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, DESKTOP_INTEGRATION_SERVER_HOST);
    });

    this.server = server;
    this.currentPort = port;
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    this.server = null;
    this.currentPort = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      for (const socket of Array.from(this.sockets.values())) {
        socket.destroy();
      }
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!assertLocalhostHostOrigin(req, res, this.currentPort)) {
      return;
    }

    const requestUrl = new URL(
      req.url ?? '/',
      `http://127.0.0.1:${String(this.currentPort ?? 0)}`,
    );

    if (requestUrl.pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        service: MCP_PROXY_HEALTH_SERVICE,
        version: MCP_PROXY_HEALTH_VERSION,
        port: this.currentPort,
        status: this.status,
        routeCount: this.connections.size + this.tools.size,
      });
      return;
    }

    if (requestUrl.pathname === '/oauth/callback') {
      const result =
        await getMcpOAuthCoordinator().completeCallback(requestUrl);
      writeMcpOAuthCallbackPage(res, result.success ? 200 : 400, result);
      return;
    }

    if (requestUrl.pathname.startsWith(CANOPY_MCP_WORKTREE_SESSION_PATH)) {
      await this.handleCanopyWorktreeMcpRequest(req, res, requestUrl);
      return;
    }

    if (
      requestUrl.pathname.startsWith(
        CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH,
      )
    ) {
      await this.handleClaudeTerminalHookRequest(req, res, requestUrl);
      return;
    }

    const routeId = this.extractMcpProxyRouteId(requestUrl.pathname);
    if (routeId === null) {
      res.writeHead(404);
      res.end();
      return;
    }

    await this.connections.serve(req, res, routeId);
  }

  private extractMcpProxyRouteId(pathname: string): string | null {
    if (pathname.startsWith(`${CANOPY_MCP_PROXY_PATH}/`)) {
      return safeDecodeURIComponent(
        pathname.slice(CANOPY_MCP_PROXY_PATH.length + 1),
      );
    }
    if (pathname.startsWith(`${LEGACY_MCP_PROXY_PATH}/`)) {
      return safeDecodeURIComponent(
        pathname.slice(LEGACY_MCP_PROXY_PATH.length + 1),
      );
    }
    return null;
  }

  private getSessionKeyFromPath(
    pathname: string,
    prefix: string,
  ): string | null {
    if (!pathname.startsWith(`${prefix}/`)) {
      return null;
    }
    const sessionKey = safeDecodeURIComponent(
      pathname.slice(prefix.length + 1),
    );
    if (sessionKey === null) {
      return null;
    }
    return sessionKey.length > 0 ? sessionKey : null;
  }

  private getAuthorizedWorktreeRoute(
    req: IncomingMessage,
    res: ServerResponse,
    sessionKey: string | null,
  ): CanopyWorktreeSessionRoute | null {
    if (!sessionKey) {
      res.writeHead(404);
      res.end();
      return null;
    }
    const route = this.tools.route(sessionKey);
    if (!route) {
      res.writeHead(404);
      res.end();
      return null;
    }
    if (!integrationTokenMatches(req, route.authToken)) {
      res.writeHead(401);
      res.end();
      return null;
    }
    return route;
  }

  private async handleClaudeTerminalHookRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const sessionKey = this.getSessionKeyFromPath(
      requestUrl.pathname,
      CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH,
    );
    const route = this.getAuthorizedWorktreeRoute(req, res, sessionKey);
    if (!route) {
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    try {
      const raw = await readRequestBody(req);
      const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : null;
      if (!isClaudeTerminalHookCallbackBody(parsed)) {
        writeJson(res, 400, { error: 'Invalid Claude terminal hook payload' });
        return;
      }
      const result = await route.hookHandler(parsed);
      if (result === undefined) {
        res.writeHead(200);
        res.end();
      } else {
        writeJson(res, 200, isRecord(result) ? result : { result });
      }
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeJson(res, 413, {
          error: 'Claude terminal hook payload too large',
        });
        return;
      }
      writeJson(res, 500, {
        error: 'Claude terminal hook handler failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCanopyWorktreeMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    let pathname = requestUrl.pathname;
    const uiServer = pathname.endsWith('/ui');
    if (uiServer) {
      pathname = pathname.slice(0, -'/ui'.length);
    }
    const sessionKey = this.getSessionKeyFromPath(
      pathname,
      CANOPY_MCP_WORKTREE_SESSION_PATH,
    );
    const route = sessionKey ? this.tools.route(sessionKey) : undefined;
    if (!route) {
      const id = await readJsonRpcIdFromRequest(req);
      writeJson(
        res,
        404,
        jsonRpcError(
          id,
          -32004,
          `${BRAND.displayName} worktree session not found`,
        ),
      );
      return;
    }
    if (!integrationTokenMatches(req, route.authToken)) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    let payload: unknown;
    try {
      const raw = await readRequestBody(req);
      payload = raw.length > 0 ? JSON.parse(raw) : null;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writePayloadTooLargeJsonRpc(res);
        return;
      }
      writeJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
      return;
    }

    const payloadRecord = isRecord(payload) ? payload : undefined;
    const isToolCall = payloadRecord?.method === 'tools/call';
    const params =
      isToolCall && isRecord(payloadRecord.params)
        ? payloadRecord.params
        : undefined;
    const appAdvisorArgs = isRecord(params?.arguments)
      ? params.arguments
      : undefined;
    const appAdvisorAction = isRecord(appAdvisorArgs?.action)
      ? appAdvisorArgs.action
      : undefined;
    const isAppAdvisorBaseBranchCall =
      !uiServer &&
      route.assistantMode === 'app-advisor' &&
      getClaudeTerminalAppAdvisorToolKey(params?.name) === 'dispatch_action' &&
      appAdvisorAction?.type === 'worktree.set_base_branch';
    const isDirectBaseBranchCall =
      !uiServer &&
      route.assistantMode !== 'app-advisor' &&
      route.assistantMode !== 'pipeline-editor' &&
      getClaudeCanopyToolKey(
        params?.name,
        getClaudeCanopyToolSurface(route),
      ) === 'set_base_branch';
    if (
      isToolCall &&
      (uiServer || isAppAdvisorBaseBranchCall || isDirectBaseBranchCall)
    ) {
      await this.streamCanopyMcpJsonRpc(req, res, route, payload, uiServer);
      return;
    }

    let response: Record<string, unknown> | null;
    try {
      response = await this.handleCanopyMcpJsonRpc(route, payload, uiServer);
    } catch (error) {
      response = jsonRpcInternalError(getJsonRpcId(payload), error);
    }
    if (response === null) {
      res.writeHead(204);
      res.end();
      return;
    }
    const toolRequestId =
      isToolCall &&
      isRecord(payload) &&
      (typeof payload.id === 'string' || typeof payload.id === 'number')
        ? payload.id
        : undefined;
    if (toolRequestId !== undefined && route.nativeToolResultDelivery) {
      const toolUseId = this.tools.routeToolUseId(
        route,
        toolRequestId,
        params?._meta,
      );
      try {
        route.nativeToolResultDelivery({
          requestId: String(toolRequestId),
          toolUseId,
          result: response.result,
        });
      } catch {
        const reason =
          'The tool result could not be verified. Please try again.';
        deferredToolsReloadCoordinator.cancelPendingToolResult(
          {
            projectId: route.projectId,
            worktreeId: route.worktreeId,
            chatId: route.chatId,
          },
          toolUseId,
          reason,
        );
        writeJson(res, 200, jsonRpcError(toolRequestId, -32603, reason));
        return;
      }
    }
    writeJson(res, 200, response);
    // OpenCode acknowledges its ACP receipt after the HTTP response.
    // Reloading here can terminate the process before that native result.
    if (
      toolRequestId !== undefined &&
      !route.nativeToolResultDelivery &&
      route.providerType !== 'opencode'
    ) {
      await deferredToolsReloadCoordinator.markToolResultDeliveredAndWaitForResume(
        {
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          chatId: route.chatId,
        },
        this.tools.routeToolUseId(route, toolRequestId, params?._meta),
      );
    }
  }

  /**
   * Stream a long-running Canopy MCP tool call (AskUserQuestion on the `/ui`
   * server) as Server-Sent Events. The MCP StreamableHTTP client (undici) caps
   * the wait for response headers at its `headersTimeout` (default 5 minutes),
   * so a buffered response that only sends headers once the user answers is
   * killed at 5 minutes regardless of the per-server `timeout`. Sending the SSE
   * headers immediately, with periodic keepalive comments to reset the client's
   * `bodyTimeout`, keeps the connection alive until the user responds (or the
   * in-tool 59-minute timeout fires).
   */
  private async streamCanopyMcpJsonRpc(
    req: IncomingMessage,
    res: ServerResponse,
    route: CanopyWorktreeSessionRoute,
    payload: unknown,
    uiServer: boolean,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    let closed = false;
    let progress = 0;
    const abortController = new AbortController();
    const progressToken = getMcpProgressToken(payload);
    const pendingAskUserRequestIds = new Set<string>();
    const expirePendingAskUserRequest = (requestId: string): void => {
      rejectRequest(requestId, 'transport_closed');
      sendToWindow(this.getWindow(), IPC_CHANNELS.mcpExpireAskUser, {
        requestId,
      });
    };
    const keepAlive = setInterval((): void => {
      if (!closed && !res.writableEnded) {
        res.write(': keepalive\n\n');
        if (progressToken !== null) {
          progress += 1;
          res.write(
            `data: ${JSON.stringify(
              mcpProgressNotification(
                progressToken,
                progress,
                'Waiting for user response',
              ),
            )}\n\n`,
          );
        }
      }
    }, CANOPY_MCP_SSE_KEEPALIVE_MS);
    const onClose = (): void => {
      closed = true;
      clearInterval(keepAlive);
      abortController.abort();
      for (const requestId of Array.from(pendingAskUserRequestIds)) {
        expirePendingAskUserRequest(requestId);
      }
      pendingAskUserRequestIds.clear();
    };
    res.on('close', onClose);
    const cleanup = (): void => {
      clearInterval(keepAlive);
      res.removeListener('close', onClose);
      pendingAskUserRequestIds.clear();
    };
    const requestContext: CanopyMcpRequestContext = {
      signal: abortController.signal,
      onAskUserRequestCreated: (requestId): void => {
        if (closed) {
          expirePendingAskUserRequest(requestId);
          return;
        }
        pendingAskUserRequestIds.add(requestId);
      },
    };
    try {
      const response = await this.handleCanopyMcpJsonRpc(
        route,
        payload,
        uiServer,
        requestContext,
      );
      cleanup();
      if (closed || res.writableEnded) {
        return;
      }
      if (response !== null) {
        res.write(`data: ${JSON.stringify(response)}\n\n`);
      }
      res.end();
    } catch (error) {
      cleanup();
      if (closed || res.writableEnded) {
        return;
      }
      const id = getJsonRpcId(isRecord(payload) ? payload : {});
      res.write(`data: ${JSON.stringify(jsonRpcInternalError(id, error))}\n\n`);
      res.end();
    }
  }

  private async handleCanopyMcpJsonRpc(
    route: CanopyWorktreeSessionRoute,
    payload: unknown,
    uiServer = false,
    requestContext?: CanopyMcpRequestContext,
  ): Promise<Record<string, unknown> | null> {
    if (route.turnSignal) {
      requestContext = {
        ...requestContext,
        signal: requestContext?.signal
          ? AbortSignal.any([route.turnSignal, requestContext.signal])
          : route.turnSignal,
      };
    }
    if (!isRecord(payload)) {
      return jsonRpcError(null, -32600, 'Invalid request');
    }
    const method = typeof payload.method === 'string' ? payload.method : '';
    const id = getJsonRpcId(payload);
    if (!('id' in payload)) {
      return null;
    }

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: {
            name: uiServer
              ? `${BRAND.tools.namespace}_ui`
              : route.assistantMode === 'app-advisor'
                ? `${BRAND.tools.namespace}_app_advisor`
                : route.assistantMode === 'pipeline-editor'
                  ? `${BRAND.tools.namespace}_pipeline_editor`
                  : BRAND.tools.namespace,
            version: '1.0.0',
          },
        },
      };
    }
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: listCanopyRouteTools(route, uiServer) },
      };
    }
    if (method === 'tools/call') {
      return this.tools.callTool(route, {
        id,
        params: isRecord(payload.params) ? payload.params : {},
        uiServer,
        ...(requestContext ? { requestContext } : {}),
      });
    }
    return jsonRpcError(id, -32601, 'Method not found');
  }
}

let service: McpHttpProxyService | null = null;

export function getMcpHttpProxyService(): McpHttpProxyService {
  if (!service) {
    service = new McpHttpProxyService();
  }
  return service;
}
