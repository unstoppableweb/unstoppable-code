import { randomUUID } from 'node:crypto';
import { WORKER_TERMINAL_LOST_SIGNAL } from '@canopy/protocol/canopy-core';
import type { SpawnFailureDetails } from '../../../runtime/errors';
import {
  isTerminalHostMessage,
  type TerminalHostMessage,
  type TerminalHostError,
  type TerminalHostEvent,
  type TerminalHostItem,
  type TerminalHostLaunch,
  type TerminalHostRequest,
  type TerminalHostRequestMessage,
  type TerminalHostTerminal,
} from './protocol';

/** A launched terminal host, as the execution host port reports it. */
export interface TerminalHostProcess {
  /** Why the host never started, set before its `exit` (CAN-7113). */
  readonly startFailure?: SpawnFailureDetails | undefined;
  postMessage(message: TerminalHostRequestMessage): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

export interface TerminalHostAttachmentSink {
  item(item: TerminalHostItem, attachmentId: string): void;
  end(outcome: 'completed' | 'cancelled', offset: number): void;
}

export interface TerminalHostSupervisorOptions {
  /** Starts a new terminal host process. */
  readonly launch: () => TerminalHostProcess;
  /** Bounds every request but `release` and `stop`; a host past it is stopped. */
  readonly requestTimeoutMs?: number;
  /**
   * How long a host with no terminals, attachments or requests stays up
   * before it stops; the next request starts another. Default 5 s.
   */
  readonly idleStopMs?: number;
  /**
   * Ends a terminal's PTY process group that outlived its host. Each PTY is
   * its own session, so ending the host's tree does not reach it.
   */
  readonly killProcessGroup?: (pid: number) => void;
  /** Observes each host that ended, with the terminals it took with it. */
  readonly onHostExit?: (report: {
    readonly code: number;
    readonly lost: readonly string[];
    readonly expected: boolean;
  }) => void;
}

/** A host request that failed, typed by the host or by its supervisor. */
export class TerminalHostRequestError extends Error {
  public constructor(
    public readonly error: TerminalHostError,
    /** The host's spawn failure, when it never started (CAN-7113). */
    public readonly startFailure?: SpawnFailureDetails,
  ) {
    super(error.message);
    this.name = 'TerminalHostRequestError';
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
const IDLE_STOP_MS = 5_000;
const MAX_EARLY_EXITS = 64;
const MAX_RECENT_EXITS = 256;
// `release` drains a process tree for up to 5 s; `stop` waits 3 s for exits.
const SLOW_REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface AttachmentRoute {
  readonly terminalId: string;
  readonly sink: TerminalHostAttachmentSink;
  offset: number;
}

interface LiveHost {
  readonly process: TerminalHostProcess;
  readonly pending: Map<number, Pending>;
  /** Each live terminal's PTY pid, kept so a host fault cannot orphan it. */
  readonly terminals: Map<string, number | null>;
  /**
   * Exits that arrived with, or before, the response that registers their
   * terminal: announced once it is registered, never as a live terminal.
   */
  readonly early: Map<string, TerminalHostEvent>;
  /** Counts exits; each terminal's latest is kept, so a reply can tell. */
  exitCount: number;
  readonly exits: Map<string, number>;
  readonly attachments: Map<string, AttachmentRoute>;
  exited: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHostTerminal(value: unknown): value is TerminalHostTerminal {
  return (
    isRecord(value) &&
    isRecord(value.session) &&
    typeof value.session.id === 'string' &&
    typeof value.cols === 'number' &&
    typeof value.rows === 'number' &&
    typeof value.outputOffset === 'number' &&
    typeof value.running === 'boolean'
  );
}

function hostTerminal(value: unknown): TerminalHostTerminal {
  if (!isHostTerminal(value))
    throw new TerminalHostRequestError({
      code: 'failed',
      message: 'The terminal host returned an invalid terminal.',
    });
  return value;
}

/**
 * Supervises the terminal host process (CAN-5088): starts it on first use,
 * routes requests, attachment items and events, and restarts it on the next
 * request after it ends. A host that ends under its terminals reports each of
 * them lost: every open attachment receives an exit item with
 * {@link WORKER_TERMINAL_LOST_SIGNAL} and completes, and an `exit` event
 * follows, so no client waits on output that will never come. A lost
 * terminal is gone from this worker; restoring it recreates it.
 */
export class TerminalHostSupervisor {
  private host: LiveHost | null = null;

  private stopped = false;

  private nextId = 1;

  private readonly listeners = new Set<(event: TerminalHostEvent) => void>();

  public constructor(private readonly options: TerminalHostSupervisorOptions) {}

  /** Whether a terminal is live in the current host. */
  public isLive(terminalId: string): boolean {
    return this.host?.terminals.has(terminalId) ?? false;
  }

  public onEvent(listener: (event: TerminalHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async create(
    launch: TerminalHostLaunch,
    cols: number,
    rows: number,
  ): Promise<TerminalHostTerminal> {
    const host = this.current();
    const since = host.exitCount;
    const terminal = hostTerminal(
      await this.request({ op: 'create', launch, cols, rows }, host),
    );
    this.register(host, terminal, since);
    return terminal;
  }

  public async restore(
    request: Extract<TerminalHostRequest, { op: 'restore' }>,
  ): Promise<{ terminal: TerminalHostTerminal; recreated: boolean }> {
    const host = this.current();
    const since = host.exitCount;
    const value = await this.request(request, host);
    if (!isRecord(value) || typeof value.recreated !== 'boolean')
      throw new TerminalHostRequestError({
        code: 'failed',
        message: 'The terminal host returned an invalid restore.',
      });
    const terminal = hostTerminal(value.terminal);
    this.register(host, terminal, since);
    return { terminal, recreated: value.recreated };
  }

  /**
   * Tracks a terminal its reply returned, unless it exited since the
   * request was sent (`since`, the host's exit count then).
   */
  private register(
    host: LiveHost,
    terminal: TerminalHostTerminal,
    since: number,
  ): void {
    if (host.exited || this.host !== host) return;
    const id = terminal.session.id;
    const exit = host.early.get(id);
    if (!exit) {
      // Its exit was already announced while it was tracked (a live
      // restore): it stays exited.
      if ((host.exits.get(id) ?? 0) > since) {
        this.scheduleIdleStop(host);
        return;
      }
      host.terminals.set(id, terminal.pid);
      return;
    }
    // It exited before its caller saw it: announce the exit after the
    // caller records the terminal, and keep no pid that may be reused.
    host.early.delete(id);
    setTimeout(() => this.emit(exit), 0);
    this.scheduleIdleStop(host);
  }

  public async write(
    terminalId: string,
    data: string,
  ): Promise<TerminalHostTerminal> {
    return hostTerminal(await this.request({ op: 'write', terminalId, data }));
  }

  public async resize(
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalHostTerminal> {
    return hostTerminal(
      await this.request({ op: 'resize', terminalId, cols, rows }),
    );
  }

  public async kill(terminalId: string): Promise<TerminalHostTerminal> {
    return hostTerminal(await this.request({ op: 'kill', terminalId }));
  }

  /** Stops the terminal's process tree and waits until it is gone. */
  public async release(terminalId: string): Promise<boolean> {
    if (!this.isLive(terminalId)) return false;
    return (await this.request({ op: 'release', terminalId })) === true;
  }

  public async list(): Promise<TerminalHostTerminal[]> {
    if (!this.host) return [];
    const value = await this.request({ op: 'list' });
    return Array.isArray(value) ? value.map(hostTerminal) : [];
  }

  /**
   * Opens an attachment in the current host. Items and the end arrive on
   * `sink`, in order; a host that ends delivers a lost exit item first.
   */
  public async attach(
    request: {
      terminalId: string;
      fromOffset: number;
      maxReplayBytes?: number;
    },
    sink: TerminalHostAttachmentSink,
  ): Promise<{ attachmentId: string; terminal: TerminalHostTerminal }> {
    const host = this.current();
    const attachmentId = randomUUID();
    host.attachments.set(attachmentId, {
      terminalId: request.terminalId,
      sink,
      offset: request.fromOffset,
    });
    try {
      const terminal = hostTerminal(
        await this.request({ op: 'attach', attachmentId, ...request }, host),
      );
      return { attachmentId, terminal };
    } catch (error) {
      host.attachments.delete(attachmentId);
      throw error;
    }
  }

  /** Returns credit for every item delivered up to `offset`. */
  public acknowledge(attachmentId: string, offset: number): void {
    const host = this.host;
    if (!host?.attachments.has(attachmentId)) return;
    this.request({ op: 'acknowledge', attachmentId, offset }, host).catch(
      () => undefined,
    );
  }

  /** Ends one attachment; its terminal and other attachments are unaffected. */
  public detach(attachmentId: string): void {
    const host = this.host;
    if (!host?.attachments.has(attachmentId)) return;
    this.request({ op: 'detach', attachmentId }, host).catch(() => undefined);
  }

  /**
   * Kills every terminal, waits for their exits, then stops the host. Later
   * requests are refused.
   */
  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const host = this.host;
    if (!host || host.exited) return;
    const exited = new Promise<void>((resolve) => {
      host.process.on('exit', () => resolve());
    });
    try {
      await this.send({ op: 'stop' }, host, SLOW_REQUEST_TIMEOUT_MS);
    } catch {
      // The host is stopped below whatever it answered.
    }
    host.process.kill();
    await exited;
  }

  private current(): LiveHost {
    if (this.stopped)
      throw new TerminalHostRequestError({
        code: 'unavailable',
        message: 'The terminal host is shutting down.',
      });
    if (this.host && !this.host.exited) return this.host;
    const process = this.options.launch();
    const host: LiveHost = {
      process,
      pending: new Map(),
      terminals: new Map(),
      early: new Map(),
      exitCount: 0,
      exits: new Map(),
      attachments: new Map(),
      exited: false,
    };
    this.host = host;
    process.on('message', (message) => this.receive(host, message));
    process.on('exit', (code) => this.ended(host, code));
    return host;
  }

  private request(
    request: TerminalHostRequest,
    host: LiveHost = this.current(),
  ): Promise<unknown> {
    const slow = request.op === 'release' || request.op === 'stop';
    return this.send(
      request,
      host,
      slow
        ? SLOW_REQUEST_TIMEOUT_MS
        : (this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
    );
  }

  private send(
    request: TerminalHostRequest,
    host: LiveHost,
    timeoutMs: number,
  ): Promise<unknown> {
    if (host.exited)
      return Promise.reject(
        new TerminalHostRequestError({
          code: 'unavailable',
          message: 'The terminal host stopped.',
        }),
      );
    const id = this.nextId++;
    if (host.idleTimer !== undefined) {
      clearTimeout(host.idleTimer);
      host.idleTimer = undefined;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(id);
        reject(
          new TerminalHostRequestError({
            code: 'unavailable',
            message: 'The terminal host did not answer.',
          }),
        );
        // A host that stops answering is faulted: end it, and its terminals.
        host.process.kill();
      }, timeoutMs);
      host.pending.set(id, { resolve, reject, timer });
      try {
        host.process.postMessage({ kind: 'request', id, request });
      } catch (error) {
        clearTimeout(timer);
        host.pending.delete(id);
        reject(
          new TerminalHostRequestError({
            code: 'unavailable',
            message:
              error instanceof Error
                ? error.message
                : 'The terminal host stopped.',
          }),
        );
      }
    });
  }

  private receive(host: LiveHost, message: unknown): void {
    if (host.exited || !isTerminalHostMessage(message)) return;
    this.handle(host, message);
    this.scheduleIdleStop(host);
  }

  /**
   * Stops a host that holds nothing: no terminal, attachment or request. It
   * leaves the current slot first, so a request meanwhile starts another.
   */
  private scheduleIdleStop(host: LiveHost): void {
    if (
      host.exited ||
      host.idleTimer !== undefined ||
      this.host !== host ||
      host.terminals.size > 0 ||
      host.attachments.size > 0 ||
      host.pending.size > 0
    )
      return;
    const timer = setTimeout(() => {
      host.idleTimer = undefined;
      if (
        this.host !== host ||
        host.terminals.size > 0 ||
        host.attachments.size > 0 ||
        host.pending.size > 0
      )
        return;
      this.host = null;
      host.process.kill();
    }, this.options.idleStopMs ?? IDLE_STOP_MS);
    timer.unref?.();
    host.idleTimer = timer;
  }

  private handle(host: LiveHost, message: TerminalHostMessage): void {
    switch (message.kind) {
      case 'ready':
        return;
      case 'response': {
        const pending = host.pending.get(message.id);
        if (!pending) return;
        host.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new TerminalHostRequestError(message.error));
        return;
      }
      case 'item': {
        const route = host.attachments.get(message.attachmentId);
        if (!route) return;
        route.offset = message.item.toOffset;
        route.sink.item(message.item, message.attachmentId);
        return;
      }
      case 'end': {
        const route = host.attachments.get(message.attachmentId);
        if (!route) return;
        host.attachments.delete(message.attachmentId);
        route.sink.end(message.outcome, message.offset);
        return;
      }
      case 'event': {
        const { event } = message;
        if (event.type === 'exit') {
          host.exitCount += 1;
          host.exits.delete(event.terminalId);
          host.exits.set(event.terminalId, host.exitCount);
          for (const id of host.exits.keys()) {
            if (host.exits.size <= MAX_RECENT_EXITS) break;
            host.exits.delete(id);
          }
        }
        if (event.type === 'exit' && !host.terminals.delete(event.terminalId)) {
          host.early.set(event.terminalId, event);
          // Exits of terminals no request registers are kept briefly only.
          for (const id of host.early.keys()) {
            if (host.early.size <= MAX_EARLY_EXITS) break;
            host.early.delete(id);
          }
          return;
        }
        this.emit(event);
        return;
      }
    }
  }

  private ended(host: LiveHost, code: number): void {
    if (host.exited) return;
    host.exited = true;
    if (host.idleTimer !== undefined) clearTimeout(host.idleTimer);
    if (this.host === host) this.host = null;
    for (const pending of host.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new TerminalHostRequestError(
          {
            code: 'unavailable',
            message: 'The terminal host stopped.',
          },
          host.process.startFailure,
        ),
      );
    }
    host.pending.clear();
    const exit = { exitCode: null, signal: WORKER_TERMINAL_LOST_SIGNAL };
    for (const [attachmentId, route] of host.attachments) {
      route.sink.item(
        {
          terminalId: route.terminalId,
          fromOffset: route.offset,
          toOffset: route.offset,
          data: new Uint8Array(0),
          truncatedBefore: false,
          exit,
        },
        attachmentId,
      );
      route.sink.end('completed', route.offset);
    }
    host.attachments.clear();
    const lost = [...host.terminals.keys()];
    for (const pid of host.terminals.values())
      if (pid !== null && pid > 0) this.options.killProcessGroup?.(pid);
    host.terminals.clear();
    for (const terminalId of lost)
      this.emit({ type: 'exit', terminalId, ...exit });
    this.options.onHostExit?.({ code, lost, expected: this.stopped });
  }

  private emit(event: TerminalHostEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
