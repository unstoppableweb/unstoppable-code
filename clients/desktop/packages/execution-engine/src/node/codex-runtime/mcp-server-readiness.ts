import type { ListMcpServerStatusParams } from './generated/v2/ListMcpServerStatusParams';
import type { ListMcpServerStatusResponse } from './generated/v2/ListMcpServerStatusResponse';

const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_MCP_POLL_INTERVAL_MS = 100;

export interface CodexMcpReadinessResult {
  readyServerNames: string[];
  unavailableServers: Array<{ name: string; reason: 'failed' | 'timeout' }>;
}

export type CodexMcpToolEvidence =
  | { name: string; kind: 'tools'; toolCount: number }
  | { name: string; kind: 'auth_required' }
  | { name: string; kind: 'unavailable'; reason: 'startup_failed' | 'timeout' };

/** The pinned protocol reuses the owning connection only with BOTH selectors. */
export async function readCodexMcpToolEvidence(options: {
  threadId: string;
  serverNames: readonly string[];
  request(
    params: ListMcpServerStatusParams,
  ): Promise<ListMcpServerStatusResponse>;
  signal?: AbortSignal;
}): Promise<CodexMcpToolEvidence[]> {
  const observations: CodexMcpToolEvidence[] = [];
  for (const name of options.serverNames) {
    options.signal?.throwIfAborted();
    let cursor: string | null = null;
    const cursors = new Set<string>();
    const names = new Set<string>();
    let complete = false;
    let authRequired = false;
    let failed = false;
    for (let page = 0; page < 100; page++) {
      let response: ListMcpServerStatusResponse;
      try {
        response = await options.request({
          threadId: options.threadId,
          serverName: name,
          detail: 'toolsAndAuthOnly',
          cursor,
        });
      } catch {
        options.signal?.throwIfAborted();
        failed = true;
        break;
      }
      options.signal?.throwIfAborted();
      if (response.data.length !== 1 || response.data[0].name !== name) break;
      const server = response.data[0];
      if (server.runtimeStatus === 'authenticationRequired') {
        authRequired = true;
        break;
      }
      if (server.runtimeStatus !== 'connected' || server.toolsError !== null) {
        failed = true;
        break;
      }
      for (const toolName of Object.keys(server.tools)) names.add(toolName);
      if (names.size > 10_000) break;
      cursor = response.nextCursor;
      if (cursor === null) {
        complete = true;
        break;
      }
      if (cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    observations.push(
      authRequired
        ? { name, kind: 'auth_required' }
        : complete
          ? { name, kind: 'tools', toolCount: names.size }
          : {
              name,
              kind: 'unavailable',
              reason: failed ? 'startup_failed' : 'timeout',
            },
    );
  }
  return observations;
}

export interface WaitForCodexMcpServersOptions {
  threadId: string;
  serverNames: readonly string[];
  request(
    params: ListMcpServerStatusParams,
  ): Promise<ListMcpServerStatusResponse>;
  getStartupState?(serverName: string):
    | {
        status: 'starting' | 'ready' | 'failed' | 'cancelled';
        error?: string;
        failureReason?: string;
      }
    | undefined;
  getStartupFailure?(serverName: string): string | undefined;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return milliseconds > 0
    ? new Promise((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timeout);
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error('MCP readiness wait aborted'),
          );
        };
        const timeout = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, milliseconds);
        signal?.addEventListener('abort', onAbort, { once: true });
      })
    : Promise.resolve();
}

/**
 * Wait for the owning thread's healthy MCP tools before constructing the first
 * turn router. An individual server failure or startup timeout only makes that
 * server unavailable for this round. Keep its selection attached so reload or
 * resume can reconnect it. User cancellation and app-server RPC failures still
 * propagate, because they are not failures of an individual MCP server.
 */
export async function waitForCodexMcpServers(
  options: WaitForCodexMcpServersOptions,
): Promise<CodexMcpReadinessResult> {
  const pending = new Set(
    options.serverNames.filter((name) => name.trim().length > 0),
  );
  const result: CodexMcpReadinessResult = {
    readyServerNames: [],
    unavailableServers: [],
  };
  const now = options.now ?? Date.now;
  const deadline =
    now() + (options.timeoutMs ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_MCP_POLL_INTERVAL_MS;

  const ready = (name: string): void => {
    if (pending.delete(name)) result.readyServerNames.push(name);
  };
  const unavailable = (name: string, reason: 'failed' | 'timeout'): void => {
    pending.delete(name);
    result.unavailableServers.push({ name, reason });
  };

  while (pending.size > 0) {
    options.signal?.throwIfAborted();
    for (const name of Array.from(pending)) {
      const state = options.getStartupState?.(name);
      if (state?.status === 'ready') {
        ready(name);
      } else if (
        state?.status === 'failed' ||
        options.getStartupFailure?.(name)
      ) {
        unavailable(name, 'failed');
      }
      // A cancelled startup round can be replaced by another starting/ready
      // sequence. Keep waiting for that replacement within the same deadline.
    }
    if (pending.size === 0) break;

    // Inventory probes create a separate MCP connection. Only use this legacy
    // fallback when the caller cannot observe owning-thread startup events.
    if (!options.getStartupState) {
      let cursor: string | null = null;
      do {
        const response = await options.request({
          threadId: options.threadId,
          detail: 'toolsAndAuthOnly',
          cursor,
        });
        options.signal?.throwIfAborted();
        for (const server of response.data) {
          if (
            server.serverInfo !== null ||
            Object.keys(server.tools).length > 0
          )
            ready(server.name);
        }
        cursor = response.nextCursor;
      } while (cursor !== null && pending.size > 0 && now() < deadline);
    }
    if (pending.size === 0) break;
    if (now() >= deadline) {
      for (const name of Array.from(pending)) unavailable(name, 'timeout');
      break;
    }
    await delay(pollIntervalMs, options.signal);
  }
  options.signal?.throwIfAborted();
  return result;
}
