import { randomUUID } from 'node:crypto';
import type { StdioJsonRpcSession } from '@canopy/desktop-shared/node/mcp/stdio-json-rpc-session';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { subscribeDesktopInventoryChanges } from '../../services/desktop-inventory-sync-signals';
import type { ReachBackServer } from './allow-list';
import type {
  ReachBackAdmission,
  ReachBackForwarder,
  ReachBackUpstreamResponse,
} from './serve';

/**
 * Reach-back for stdio MCP servers (CAN-6176 PR 7b, D25): one server process
 * per cloud MCP session, started on `initialize` through the stdio broker's
 * launcher (which supplies the server's own command and environment), and
 * closed on DELETE, after {@link STDIO_SESSION_IDLE_MS} idle, or when the
 * server is turned off. At most {@link MAX_STDIO_SESSIONS} run at once; the
 * least recently used goes first.
 *
 * Every request is admitted with a ticket taken synchronously at its entry:
 * the server's turn-off generation, the bridge's epoch and the settings
 * revision, all as of that moment. Every later stage only checks the ticket
 * against the bridge as it is now. A process is spawned only in
 * {@link launch}, which checks the ticket and registers the session in the
 * same synchronous section as the spawn, and turning a server off, closing
 * the bridge or changing its settings ends every session started on an older
 * ticket, one still starting included. A save or delete of a server's
 * settings ends its sessions at once, not at their next request. A race that
 * slips past a check is still cleaned up.
 *
 * Each request answers once with the server's JSON-RPC response (D24).
 * Notifications from the server are dropped, and a request from it (such as
 * sampling) is refused: reach-back has no server-to-client channel in v1.
 */

/**
 * Calls `listener` after each save or delete of a desktop MCP server's
 * settings; returns its unsubscribe.
 */
export function onMcpServerSettingsChange(listener: () => void): () => void {
  return subscribeDesktopInventoryChanges((kinds) => {
    if (kinds.includes('mcp_servers')) listener();
  });
}

export const STDIO_SESSION_IDLE_MS = 600_000;
export const MAX_STDIO_SESSIONS = 16;

/** A launcher route for one server and config, released with its session. */
export interface ReachBackStdioLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** The launcher's own environment: the broker supplies the server's. */
  readonly env?: Readonly<Record<string, string>>;
  release(): Promise<void>;
}

/** A server's settings as read once, synchronously. */
export interface ReachBackStdioSettings {
  /** Whether it is a command (stdio) server, so `initialize` starts one. */
  readonly startsProcess: boolean;
  /** A hash of its definition and config's content. */
  readonly configRevision: string;
}

/** What a request was admitted on; issued by {@link admit} only. */
export interface ReachBackStdioTicket extends ReachBackAdmission {
  readonly key: string;
  readonly generation: number;
  readonly epoch: number;
}

/** The awaits on a start, where a test can turn the server off. */
export type ReachBackStdioStartPoint =
  | 'admitted'
  | 'launch-resolved'
  | 'spawned'
  | 'answered';

interface Session {
  readonly id: string;
  readonly key: string;
  readonly target: { readonly serverId: string; readonly configId: string };
  /** The ticket the process was started on. */
  readonly ticket: ReachBackStdioTicket;
  readonly launch: ReachBackStdioLaunch;
  /** Null while its process is still opening. */
  process: StdioJsonRpcSession | null;
  ended: boolean;
  /** Requests awaiting the server's response, by JSON-RPC id. */
  readonly pending: Map<string, (message: unknown) => void>;
  timer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
}

const JSON_TYPE = 'application/json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idKey = (id: unknown): string => JSON.stringify(id);

function json(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): ReachBackUpstreamResponse {
  return {
    status,
    headers: { 'content-type': JSON_TYPE, ...headers },
    body: Buffer.from(JSON.stringify(value)),
  };
}

const accepted = (): ReachBackUpstreamResponse => ({
  status: 202,
  headers: {},
  body: new Uint8Array(),
});

const NOT_ALLOWED = (): ReachBackUpstreamResponse =>
  json(404, { error: 'mcp_server_not_allowed' });

export function createReachBackStdioBridge(deps: {
  /** The server's settings, read synchronously; null when unreadable. */
  readonly readSettings: (target: {
    readonly serverId: string;
    readonly configId: string;
  }) => ReachBackStdioSettings | null;
  /**
   * The launcher for a command (stdio) server's config on the settings at
   * `revision`; null when it isn't a command server, `configChanged` when
   * the settings it reads are no longer that revision.
   */
  readonly resolveLaunch: (
    server: ReachBackServer,
    revision: string,
  ) => Promise<ReachBackStdioLaunch | null | 'configChanged'>;
  /** Spawns the process before it first awaits. */
  readonly openSession: (
    launch: ReachBackStdioLaunch,
  ) => Promise<StdioJsonRpcSession>;
  /**
   * Subscribes to saves and deletes of MCP server settings; each one ends
   * the sessions whose settings are no longer the revision they started on.
   */
  readonly onSettingsChange?: (listener: () => void) => () => void;
  /** Tests: runs at each await on a start. */
  readonly startPoint?: (point: ReachBackStdioStartPoint) => Promise<void>;
  readonly idleMs?: number;
  readonly maxSessions?: number;
  readonly now?: () => number;
}): {
  /**
   * The ticket a request runs on, taken synchronously; call it before any
   * await. Null when this desktop can't read the server's settings.
   */
  admit(target: {
    readonly serverId: string;
    readonly configId: string;
  }): ReachBackStdioTicket | null;
  forward(
    server: ReachBackServer,
    request: Parameters<ReachBackForwarder['forward']>[1] & {
      readonly admission: ReachBackStdioTicket;
    },
  ): ReturnType<ReachBackForwarder['forward']>;
  /** Ends the sessions of a server turned off, one still starting included. */
  forget(serverId: string, configId: string): void;
  close(): void;
  /** Closes the bridge and stops listening for settings changes. */
  dispose(): void;
  /** Open sessions, starting ones included; for tests and diagnostics. */
  size(): number;
} {
  const idleMs = deps.idleMs ?? STDIO_SESSION_IDLE_MS;
  const maxSessions = deps.maxSessions ?? MAX_STDIO_SESSIONS;
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, Session>();
  /** Bumped when a server is turned off. */
  const generations = new Map<string, number>();
  /** Bumped when the bridge closes; the next serving run starts afresh. */
  let epoch = 0;
  const keyOf = (serverId: string, configId: string): string =>
    JSON.stringify([serverId, configId]);
  const pause = async (point: ReachBackStdioStartPoint): Promise<void> => {
    if (deps.startPoint) await deps.startPoint(point);
  };

  const end = (session: Session): void => {
    if (session.ended) return;
    session.ended = true;
    sessions.delete(session.id);
    if (session.timer !== null) clearTimeout(session.timer);
    for (const resolve of session.pending.values()) resolve(null);
    session.pending.clear();
    void session.process?.close().catch(() => undefined);
    void session.launch
      .release()
      .catch((error: unknown) =>
        logMainProcessWarn(
          '[cloud-reach-back] A stdio launch route was not released.',
          error,
        ),
      );
  };

  /**
   * Whether a ticket still holds: the server not turned off, the bridge not
   * closed, and its settings still the revision admitted.
   */
  const check = (
    ticket: ReachBackStdioTicket,
    target: { readonly serverId: string; readonly configId: string },
  ): 'current' | 'revoked' | 'configChanged' => {
    if (
      epoch !== ticket.epoch ||
      (generations.get(ticket.key) ?? 0) !== ticket.generation
    )
      return 'revoked';
    let settings: ReachBackStdioSettings | null;
    try {
      settings = deps.readSettings(target);
    } catch {
      settings = null;
    }
    return settings?.configRevision === ticket.configRevision
      ? 'current'
      : 'configChanged';
  };

  /** Ends each session whose server's settings changed or went away. */
  const reconcile = (): void => {
    for (const session of [...sessions.values()])
      if (check(session.ticket, session.target) !== 'current') end(session);
  };
  const stopListening = deps.onSettingsChange?.(reconcile) ?? ((): void => {});

  const touch = (session: Session): void => {
    session.lastUsed = now();
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = setTimeout(() => end(session), idleMs);
  };

  /**
   * The only spawn: checks the ticket, registers the session and spawns its
   * process in one synchronous section, so nothing comes between the check
   * and the registration. A session ended while its process opens closes
   * that process as soon as it exists.
   */
  const launch = (
    server: ReachBackServer,
    ticket: ReachBackStdioTicket,
    route: ReachBackStdioLaunch,
  ):
    | { readonly session: Session; readonly opened: Promise<void> }
    | 'revoked'
    | 'configChanged' => {
    const held = check(ticket, server);
    if (held !== 'current') return held;
    while (sessions.size >= maxSessions) {
      let oldest: Session | null = null;
      for (const candidate of sessions.values())
        if (oldest === null || candidate.lastUsed < oldest.lastUsed)
          oldest = candidate;
      if (oldest === null) break;
      end(oldest);
    }
    const session: Session = {
      id: randomUUID(),
      key: ticket.key,
      target: { serverId: server.serverId, configId: server.configId },
      ticket,
      launch: route,
      process: null,
      ended: false,
      pending: new Map(),
      timer: null,
      lastUsed: now(),
    };
    sessions.set(session.id, session);
    let spawned: Promise<StdioJsonRpcSession>;
    try {
      spawned = deps.openSession(route);
    } catch (error) {
      end(session);
      throw error;
    }
    const opened = spawned.then(
      (process) => {
        if (session.ended) {
          void process.close().catch(() => undefined);
          return;
        }
        session.process = process;
        process.onMessage((message) => {
          if (!isRecord(message)) return;
          if ('method' in message) {
            // A request from the server can't reach the cloud chat: refuse it.
            if ('id' in message)
              void process
                .send({
                  jsonrpc: '2.0',
                  id: message.id,
                  error: {
                    code: -32601,
                    message: 'Not available to a cloud chat on this desktop.',
                  },
                })
                .catch(() => undefined);
            return;
          }
          if ('id' in message)
            session.pending.get(idKey(message.id))?.(message);
        });
        process.onClose(() => end(session));
        touch(session);
      },
      (error: unknown) => {
        end(session);
        throw error;
      },
    );
    return { session, opened };
  };

  /** Sends a request and waits for its response; null when the session ends. */
  const call = (
    session: Session,
    message: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const process = session.process;
      // Ended, or withdrawn already: never sent, so the server can't run it
      // unanswered.
      if (process === null || session.ended) {
        resolve(null);
        return;
      }
      if (signal.aborted) {
        reject(new Error('The request was withdrawn.'));
        return;
      }
      const key = idKey(message.id);
      const abort = (): void => {
        session.pending.delete(key);
        reject(new Error('The request was withdrawn.'));
      };
      session.pending.set(key, (response) => {
        signal.removeEventListener('abort', abort);
        session.pending.delete(key);
        resolve(response);
      });
      signal.addEventListener('abort', abort, { once: true });
      process.send(message).catch((error: unknown) => {
        signal.removeEventListener('abort', abort);
        session.pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

  /** Answers a start that stopped: nothing it began keeps running. */
  const stopped = (
    held: 'revoked' | 'configChanged' | 'withdrawn',
  ): ReachBackUpstreamResponse | 'configChanged' =>
    held === 'configChanged'
      ? 'configChanged'
      : held === 'revoked'
        ? NOT_ALLOWED()
        : json(499, { error: 'mcp_request_withdrawn' });

  /** An `initialize`: starts a session on the ticket, then its first call. */
  const start = async (
    server: ReachBackServer,
    ticket: ReachBackStdioTicket,
    message: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ReachBackUpstreamResponse | 'configChanged'> => {
    const holds = (): 'revoked' | 'configChanged' | 'withdrawn' | null => {
      const held = check(ticket, server);
      if (held !== 'current') return held;
      return signal.aborted ? 'withdrawn' : null;
    };
    await pause('admitted');
    const atEntry = holds();
    if (atEntry !== null) return stopped(atEntry);
    const route = await deps.resolveLaunch(server, ticket.configRevision);
    if (route === null) return json(501, { error: 'mcp_server_unsupported' });
    if (route === 'configChanged') return 'configChanged';
    await pause('launch-resolved').catch((error: unknown) => {
      void route.release().catch(() => undefined);
      throw error;
    });
    const afterRoute = holds();
    if (afterRoute !== null) {
      await route.release().catch(() => undefined);
      return stopped(afterRoute);
    }
    const launched = launch(server, ticket, route);
    if (launched === 'revoked' || launched === 'configChanged') {
      await route.release().catch(() => undefined);
      return stopped(launched);
    }
    const { session } = launched;
    // Until its id reaches the cloud, nothing else would end this session.
    try {
      await launched.opened;
      await pause('spawned');
      const afterSpawn = holds();
      if (afterSpawn !== null || session.ended) {
        end(session);
        return stopped(afterSpawn ?? 'revoked');
      }
      touch(session);
      const response = await call(session, message, signal);
      await pause('answered');
      const afterAnswer = holds();
      if (afterAnswer !== null || session.ended) {
        end(session);
        return stopped(afterAnswer ?? 'revoked');
      }
      if (response === null) {
        end(session);
        return json(502, { error: 'mcp_server_exited' });
      }
      return json(200, response, { 'mcp-session-id': session.id });
    } catch (error) {
      end(session);
      throw error;
    }
  };

  return {
    admit(target) {
      let settings: ReachBackStdioSettings | null;
      try {
        settings = deps.readSettings(target);
      } catch {
        return null;
      }
      if (settings === null) return null;
      const key = keyOf(target.serverId, target.configId);
      return {
        key,
        generation: generations.get(key) ?? 0,
        epoch,
        startsProcess: settings.startsProcess,
        configRevision: settings.configRevision,
      };
    },
    async forward(server, request) {
      const ticket = request.admission;
      if (
        request.expectedConfigRevision !== undefined &&
        request.expectedConfigRevision !== ticket.configRevision
      )
        return 'configChanged';
      // A process started on settings since edited stops; the client's next
      // initialize starts one on the settings as they are now. Judged against
      // the settings now, never this request's ticket, which may be the stale
      // one.
      reconcile();
      const answer = await serve(server, ticket, request);
      return answer === 'configChanged'
        ? answer
        : { ...answer, configRevision: ticket.configRevision };
    },
    forget(serverId, configId) {
      const key = keyOf(serverId, configId);
      generations.set(key, (generations.get(key) ?? 0) + 1);
      for (const session of [...sessions.values()])
        if (session.key === key) end(session);
    },
    close() {
      epoch += 1;
      for (const session of [...sessions.values()]) end(session);
    },
    dispose() {
      stopListening();
      epoch += 1;
      for (const session of [...sessions.values()]) end(session);
    },
    size: () => sessions.size,
  };

  /** One request on its ticket. */
  async function serve(
    server: ReachBackServer,
    ticket: ReachBackStdioTicket,
    request: Parameters<ReachBackForwarder['forward']>[1],
  ): Promise<ReachBackUpstreamResponse | 'configChanged'> {
    const sessionId = request.headers['mcp-session-id'];
    const existing =
      sessionId === undefined ? undefined : sessions.get(sessionId);
    const current =
      existing?.key === ticket.key && existing.process !== null
        ? existing
        : undefined;
    if (request.method === 'DELETE') {
      if (current === undefined)
        return json(404, { error: 'mcp_session_not_found' });
      end(current);
      return { status: 200, headers: {}, body: new Uint8Array() };
    }
    let message: unknown;
    try {
      message = JSON.parse(Buffer.from(request.body).toString('utf8'));
    } catch {
      return json(400, { error: 'invalid_json' });
    }
    if (!isRecord(message)) return json(400, { error: 'invalid_json' });
    if (message.method === 'initialize' && 'id' in message)
      return start(server, ticket, message, request.signal);
    // MCP: an unknown session answers 404, and the client initializes again.
    if (current === undefined)
      return json(404, { error: 'mcp_session_not_found' });
    const held = check(ticket, server);
    if (held !== 'current') {
      end(current);
      return stopped(held);
    }
    touch(current);
    const process = current.process;
    if (process === null) return json(404, { error: 'mcp_session_not_found' });
    if (!('id' in message) || !('method' in message)) {
      await process.send(message);
      return accepted();
    }
    const response = await call(current, message, request.signal);
    if (response === null) return json(502, { error: 'mcp_server_exited' });
    return json(200, response, { 'mcp-session-id': current.id });
  }
}
