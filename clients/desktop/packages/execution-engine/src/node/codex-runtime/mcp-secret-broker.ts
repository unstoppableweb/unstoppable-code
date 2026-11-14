import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import { killProcessGroupByPid } from '@canopy/execution-engine/node/lib/process-kill';
import {
  codexMcpRouteAuthFileName,
  CODEX_MCP_STDIO_LAUNCHER_COMMAND,
} from './mcp-stdio-auth';
import { ensureCodexMcpBrokerRuntimeDir } from './mcp-runtime-dir';
import type { McpAvailabilityObserver } from './mcp-availability-observer';
import { observeMcpStdio } from './mcp-stdio-observer';
import {
  relayGovernedMcpStdio,
  type CodexStdioMcpToolCallGate,
} from './mcp-stdio-gate';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

export type { CodexStdioMcpToolCallGate } from './mcp-stdio-gate';

export interface CodexStdioMcpLaunchRequest {
  ownerId: string;
  routeKey: string;
  command: string;
  args?: string[];
  cwd?: string;
  /** Explicit base for restricted delegated routes; ordinary routes use the host profile. */
  baseEnv?: Record<string, string>;
  env?: Record<string, string>;
}

export interface CodexStdioMcpLaunchRoute {
  routeId: string;
  capabilityId: string;
  command: string;
  args: string[];
  cwd?: string;
}

export interface CodexStdioMcpRegistrationOptions {
  signal?: AbortSignal;
  toolCallGate?: CodexStdioMcpToolCallGate;
  observeConnection?: () => McpAvailabilityObserver;
}

interface RouteRecord extends CodexStdioMcpLaunchRequest {
  digest: string;
  launchToken: string;
  activeChildren: Map<number, ChildProcessWithoutNullStreams>;
  activeConnections: Set<AbortController>;
  toolCallGate?: CodexStdioMcpToolCallGate;
  observeConnection?: () => McpAvailabilityObserver;
  revoked: boolean;
}

interface BrokerLocator {
  version: 3;
  port: number;
  parentPid: number;
}

interface BrokerRouteAuth {
  version: 1;
  routeId: string;
  capabilityId: string;
  launchToken: string;
  parentPid: number;
}

/**
 * A stdio MCP server's capability id: the digest of what it runs, not of how
 * a host launches it. The broker's launch route carries it, and the capability
 * snapshot reads it, so the same server has the same id on every host.
 */
export function codexStdioMcpCapabilityId(
  request: Pick<
    CodexStdioMcpLaunchRequest,
    'command' | 'args' | 'cwd' | 'baseEnv' | 'env'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        command: request.command,
        args: request.args ?? [],
        cwd: request.cwd ?? null,
        baseEnv: Object.entries(request.baseEnv ?? {}).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
        env: Object.entries(request.env ?? {}).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      }),
    )
    .digest('hex');
}

function combineErrors(message: string, errors: unknown[]): Error {
  const error = new Error(message);
  Object.defineProperty(error, 'cause', {
    value: errors[0],
    configurable: true,
  });
  Object.defineProperty(error, 'errors', {
    value: errors,
    configurable: true,
  });
  return error;
}

async function awaitBrokerTasks(
  tasks: readonly Promise<void>[],
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      errors.push(result.reason as unknown);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw combineErrors(message, errors);
  }
}

const PROCESS_TERMINATION_GRACE_MS = 1_000;
const SERVER_CLOSE_TIMEOUT_MS = 1_000;

function isChildAlive(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (!isChildAlive(child)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', finish);
      child.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once('exit', finish);
    child.once('close', finish);
  });
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const pid = child.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || !isChildAlive(child)) {
    return;
  }
  await killProcessGroupByPid(pid, 'SIGTERM');
  await waitForChildExit(child, PROCESS_TERMINATION_GRACE_MS);
  if (!isChildAlive(child)) {
    return;
  }
  await killProcessGroupByPid(pid, 'SIGKILL');
  await waitForChildExit(child, PROCESS_TERMINATION_GRACE_MS);
  if (isChildAlive(child)) {
    throw new Error(`MCP child process ${String(pid)} did not terminate`);
  }
}

export class CodexMcpSecretBroker {
  private readonly brokerId = randomBytes(16).toString('hex');
  private readonly routes = new Map<string, RouteRecord>();
  private readonly routeByOwnerKey = new Map<string, string>();
  private readonly ownerRevocationVersions = new Map<string, number>();
  private readonly revokedOwners = new Set<string>();
  private server: Server | null = null;
  private port: number | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly runtimeDir: string,
    private readonly launcherCommand: string,
    private readonly launcherArgs: readonly string[] = [],
    private readonly launcherCwd?: string,
  ) {}

  async registerRoute(
    request: CodexStdioMcpLaunchRequest,
    options: CodexStdioMcpRegistrationOptions = {},
  ): Promise<CodexStdioMcpLaunchRoute> {
    options.signal?.throwIfAborted();
    if (this.revokedOwners.has(request.ownerId)) {
      throw new Error(
        `MCP launch route registration for owner ${request.ownerId} was revoked`,
      );
    }
    const ownerRevocationVersion =
      this.ownerRevocationVersions.get(request.ownerId) ?? 0;
    const assertRegistrationActive = (): void => {
      options.signal?.throwIfAborted();
      if (
        this.revokedOwners.has(request.ownerId) ||
        (this.ownerRevocationVersions.get(request.ownerId) ?? 0) !==
          ownerRevocationVersion
      ) {
        throw new Error(
          `MCP launch route registration for owner ${request.ownerId} was revoked`,
        );
      }
    };
    await this.ensureStarted();
    assertRegistrationActive();
    const ownerKey = `${request.ownerId}\0${request.routeKey}`;
    const digest = codexStdioMcpCapabilityId(request);
    const existingId = this.routeByOwnerKey.get(ownerKey);
    const existing = existingId ? this.routes.get(existingId) : undefined;
    if (
      existingId &&
      existing &&
      !existing.revoked &&
      existing.digest === digest &&
      existing.toolCallGate === options.toolCallGate &&
      existing.observeConnection === options.observeConnection
    ) {
      return this.toLaunchRoute(existingId, existing.digest);
    }
    if (existingId) await this.revokeRoute(existingId);
    assertRegistrationActive();
    const routeId = `${this.brokerId}.${randomBytes(24).toString('hex')}`;
    const route: RouteRecord = {
      ...request,
      digest,
      launchToken: randomBytes(32).toString('hex'),
      activeChildren: new Map<number, ChildProcessWithoutNullStreams>(),
      activeConnections: new Set<AbortController>(),
      toolCallGate: options.toolCallGate,
      observeConnection: options.observeConnection,
      revoked: false,
    };
    this.routes.set(routeId, route);
    try {
      this.writeRouteAuth(routeId, route);
      this.routeByOwnerKey.set(ownerKey, routeId);
    } catch (error) {
      this.routes.delete(routeId);
      throw error;
    }
    return this.toLaunchRoute(routeId, digest);
  }

  async revokeOwner(ownerId: string): Promise<void> {
    this.revokedOwners.add(ownerId);
    this.ownerRevocationVersions.set(
      ownerId,
      (this.ownerRevocationVersions.get(ownerId) ?? 0) + 1,
    );
    await awaitBrokerTasks(
      Array.from(this.routes.entries())
        .filter(([, route]) => route.ownerId === ownerId)
        .map(([routeId]) => this.revokeRoute(routeId)),
      `Failed to revoke MCP launch routes for owner ${ownerId}`,
    );
  }

  async shutdown(): Promise<void> {
    const errors: unknown[] = [];
    const routeResults = await Promise.allSettled(
      Array.from(this.routes.keys()).map((routeId) =>
        this.revokeRoute(routeId),
      ),
    );
    for (const result of routeResults) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    const server = this.server;
    this.server = null;
    this.port = null;
    this.startPromise = null;
    if (server) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          server.closeAllConnections();
          finish();
        }, SERVER_CLOSE_TIMEOUT_MS);
        server.close(finish);
        server.closeAllConnections();
      });
    }
    try {
      fs.unlinkSync(this.locatorPath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw combineErrors(
        'Codex MCP broker shutdown encountered multiple failures',
        errors,
      );
    }
  }

  private toLaunchRoute(
    routeId: string,
    capabilityId: string,
  ): CodexStdioMcpLaunchRoute {
    const route = this.routes.get(routeId);
    if (!route || route.revoked) {
      throw new Error('MCP launch route not found');
    }
    return {
      routeId,
      command: this.launcherCommand,
      capabilityId,
      ...(this.launcherCwd ? { cwd: this.launcherCwd } : {}),
      args: [
        ...this.launcherArgs,
        CODEX_MCP_STDIO_LAUNCHER_COMMAND,
        capabilityId,
        routeId,
      ],
    };
  }

  private async revokeRoute(routeId: string): Promise<void> {
    const route = this.routes.get(routeId);
    if (!route) return;
    route.revoked = true;
    for (const connection of Array.from(route.activeConnections))
      connection.abort();
    const errors: unknown[] = [];
    try {
      this.removeRouteAuth(routeId);
    } catch (error) {
      errors.push(error);
    }
    try {
      await awaitBrokerTasks(
        Array.from(route.activeChildren.values()).map((child) =>
          terminateChild(child),
        ),
        `Failed to terminate MCP children for route ${routeId}`,
      );
    } catch (error) {
      errors.push(error);
    } finally {
      this.routes.delete(routeId);
      const ownerKey = `${route.ownerId}\0${route.routeKey}`;
      if (this.routeByOwnerKey.get(ownerKey) === routeId) {
        this.routeByOwnerKey.delete(ownerKey);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw combineErrors(
        `Failed to revoke MCP launch route ${routeId}`,
        errors,
      );
    }
  }

  private locatorPath(): string {
    return path.join(this.runtimeDir, `${this.brokerId}.json`);
  }

  private routeAuthPath(routeId: string): string {
    return path.join(this.runtimeDir, codexMcpRouteAuthFileName(routeId));
  }

  private writeRouteAuth(routeId: string, route: RouteRecord): void {
    const auth: BrokerRouteAuth = {
      version: 1,
      routeId,
      capabilityId: route.digest,
      launchToken: route.launchToken,
      parentPid: process.pid,
    };
    fs.writeFileSync(this.routeAuthPath(routeId), JSON.stringify(auth), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  }

  private removeRouteAuth(routeId: string): void {
    try {
      fs.unlinkSync(this.routeAuthPath(routeId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  protected async ensureStarted(): Promise<void> {
    if (this.server && this.port !== null) return;
    if (this.startPromise) return this.startPromise;
    ensureCodexMcpBrokerRuntimeDir(this.runtimeDir);
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response).catch(() => {
          if (!response.headersSent) {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end('{"error":"MCP launch route unavailable"}');
            return;
          }
          response.destroy();
        });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('MCP secret broker did not bind loopback'));
          return;
        }
        this.server = server;
        this.port = address.port;
        const locator: BrokerLocator = {
          version: 3,
          port: address.port,
          parentPid: process.pid,
        };
        fs.writeFileSync(this.locatorPath(), JSON.stringify(locator), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        resolve();
      });
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const expectedHost = `127.0.0.1:${String(this.port)}`;
    if (request.method !== 'POST' || request.headers.host !== expectedHost) {
      throw new Error('MCP broker authentication failed');
    }
    const match = request.url?.match(
      /^\/launch\/([a-f0-9]{32}\.[a-f0-9]{48})$/,
    );
    const routeId = match?.[1];
    const route = routeId ? this.routes.get(routeId) : undefined;
    if (
      !routeId ||
      !route ||
      route.revoked ||
      request.headers.authorization !== `Bearer ${route.launchToken}`
    ) {
      throw new Error('MCP launch route not found');
    }

    const child = spawn(route.command, route.args ?? [], {
      ...(route.cwd ? { cwd: route.cwd } : {}),
      env: { ...(route.baseEnv ?? getEnhancedEnv()), ...(route.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: hostOperatingSystem() !== 'win32',
      windowsHide: true,
    });
    if (child.pid) {
      route.activeChildren.set(child.pid, child);
    }
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    if (!child.pid) {
      throw new Error('MCP child did not report a process id');
    }
    const childPid = child.pid;
    route.activeChildren.set(childPid, child);
    if (this.routes.get(routeId) !== route || route.revoked) {
      await terminateChild(child);
      route.activeChildren.delete(childPid);
      throw new Error('MCP launch route was revoked during child startup');
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    const connection = new AbortController();
    route.activeConnections.add(connection);
    // The app-server must never receive child diagnostics that could include
    // resolved environment values. Drain stderr inside the trusted parent.
    child.stderr.resume();

    const terminate = (): void => {
      connection.abort();
      void terminateChild(child).catch(() => response.destroy());
    };
    child.stdin.once('error', terminate);
    if (route.toolCallGate) {
      void relayGovernedMcpStdio({
        input: request,
        upstreamInput: child.stdin,
        upstreamOutput: child.stdout,
        output: response,
        gate: route.toolCallGate,
        observer: route.observeConnection?.(),
        signal: connection.signal,
      }).catch(() => {
        terminate();
        response.destroy();
      });
    } else {
      const observer = route.observeConnection?.();
      if (observer)
        observeMcpStdio({
          input: request,
          upstreamOutput: child.stdout,
          observer,
          signal: connection.signal,
        });
      request.pipe(child.stdin);
      child.stdout.pipe(response);
    }
    request.once('aborted', terminate);
    request.once('error', terminate);
    response.once('close', () => {
      if (!response.writableEnded) terminate();
    });
    child.once('exit', () => {
      if (child.pid) route.activeChildren.delete(child.pid);
      if (!route.toolCallGate && !response.writableEnded) response.end();
    });
    child.once('close', () => {
      connection.abort();
      route.activeConnections.delete(connection);
    });
  }
}
