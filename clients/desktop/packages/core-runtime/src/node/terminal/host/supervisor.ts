import { randomUUID } from 'node:crypto';
import { WORKER_TERMINAL_LOST_SIGNAL } from '@canopy/protocol/canopy-core';
import { TERMINAL_WORKTREE_CLEANUP_SIGNAL } from '@canopy/protocol/terminal';
import type { SpawnFailureDetails } from '../../../runtime/errors';
import { isRestorableExitSignal } from '../engine';
import type { TerminalRecordRegistration } from '../record/authority';
import {
  isTerminalHostMessage,
  type TerminalHostMessage,
  type TerminalHostError,
  type TerminalHostEvent,
  type TerminalHostExit,
  type TerminalHostItem,
  type TerminalHostReport,
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

/** A PTY exit; the host's own exits confirm their final output offset. */
type RetainedExit = TerminalHostExit & { outputOffset?: number };

interface AttachmentRoute {
  readonly terminalId: string;
  lifetimeId: number;
  awaitingReply: boolean;
  /** At most one exit held until the attach reply supplies its lifetime. */
  pendingExit?: { lifetimeId: number; exit: RetainedExit };
  readonly sink: TerminalHostAttachmentSink;
  offset: number;
}

interface LiveHost {
  readonly process: TerminalHostProcess;
  readonly pending: Map<number, Pending>;
  /** Each live terminal's PTY pid, kept so a host fault cannot orphan it. */
  readonly terminals: Map<string, number | null>;
  readonly lifetimes: Map<string, number>;
  /** Local authority handles never cross the host's structured-clone channel. */
  readonly registrations: Map<string, TerminalRecordRegistration>;
  readonly acknowledgedExitSignals: Map<string, string>;
  /**
   * Exits that arrived with, or before, the response that registers their
   * terminal: announced once it is registered, never as a live terminal.
   */
  readonly early: Map<string, TerminalHostEvent>;
  /** Reports received before create/restore installs its attribution. */
  readonly earlyReports: Map<string, TerminalHostReport[]>;
  openings: number;
  /** Counts exits; each terminal's latest is kept, so a reply can tell. */
  exitCount: number;
  readonly exits: Map<string, number>;
  readonly attachments: Map<string, AttachmentRoute>;
  /** Final exits retained only while that lifetime has open attachments. */
  readonly attachmentExits: Map<string, RetainedExit>;
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
 * them lost: an `exit` event precedes each open attachment's exit item and
 * completion, so no client waits on output that will never come. That item
 * carries the PTY's known exit, else its acknowledged exit reason, else
 * {@link WORKER_TERMINAL_LOST_SIGNAL}. It is truncated unless the host's own
 * exit confirmed that the attachment received every byte. These lost exits
 * carry no output offset: the host's final offset is unknown. A lost
 * terminal is gone from this worker; restoring it recreates it.
 */
export class TerminalHostSupervisor {
  private host: LiveHost | null = null;

  private stopped = false;

  private nextId = 1;

  private readonly listeners = new Set<
    (
      event: TerminalHostEvent,
      registration: TerminalRecordRegistration | undefined,
    ) => void
  >();

  private readonly reporters = new Set<
    (
      report: TerminalHostReport,
      registration: TerminalRecordRegistration | undefined,
    ) => void
  >();

  public constructor(private readonly options: TerminalHostSupervisorOptions) {}

  /** Whether a terminal is live in the current host. */
  public isLive(terminalId: string): boolean {
    return this.host?.terminals.has(terminalId) ?? false;
  }

  /**
   * Exits to record before shutdown fences an unconfirmed host drain. The
   * host never confirmed them, so they carry no output offset.
   */
  public pendingRecordExits(): ReadonlyArray<{
    registration: TerminalRecordRegistration;
    exitCode: number | null;
    signal: string | null;
  }> {
    const host = this.host;
    if (!host) return [];
    return [...host.registrations].map(([key, registration]) => ({
      registration,
      ...this.exitFor(host, key),
    }));
  }

  public onEvent(
    listener: (
      event: TerminalHostEvent,
      registration: TerminalRecordRegistration | undefined,
    ) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Observes the host's output reports (CAN-7051), in the order the host
   * sent them; a terminal's bytes precede its `exit` event.
   */
  public onReport(
    listener: (
      report: TerminalHostReport,
      registration: TerminalRecordRegistration | undefined,
    ) => void,
  ): () => void {
    this.reporters.add(listener);
    return () => {
      this.reporters.delete(listener);
    };
  }

  /** `initialize` records the terminal before held reports and exits arrive. */
  public async create(
    launch: TerminalHostLaunch,
    cols: number,
    rows: number,
    initialize?: (
      terminal: TerminalHostTerminal,
    ) => TerminalRecordRegistration | void,
  ): Promise<TerminalHostTerminal> {
    const host = this.current();
    const since = host.exitCount;
    host.openings += 1;
    try {
      const terminal = hostTerminal(
        await this.request({ op: 'create', launch, cols, rows }, host),
      );
      this.register(
        host,
        terminal,
        since,
        initialize
          ? (): TerminalRecordRegistration | void => initialize(terminal)
          : undefined,
      );
      return terminal;
    } finally {
      this.finishOpening(host);
    }
  }

  /** `initialize` records a recreation before held reports and exits arrive. */
  public async restore(
    request: Extract<TerminalHostRequest, { op: 'restore' }>,
    initialize?: (
      terminal: TerminalHostTerminal,
      recreated: boolean,
    ) => TerminalRecordRegistration | void,
  ): Promise<{ terminal: TerminalHostTerminal; recreated: boolean }> {
    const host = this.current();
    const since = host.exitCount;
    host.openings += 1;
    try {
      const value = await this.request(request, host);
      if (!isRecord(value) || typeof value.recreated !== 'boolean')
        throw new TerminalHostRequestError({
          code: 'failed',
          message: 'The terminal host returned an invalid restore.',
        });
      const terminal = hostTerminal(value.terminal);
      const recreated = value.recreated;
      this.register(
        host,
        terminal,
        since,
        initialize
          ? (): TerminalRecordRegistration | void =>
              initialize(terminal, recreated)
          : undefined,
      );
      return { terminal, recreated };
    } finally {
      this.finishOpening(host);
    }
  }

  private finishOpening(host: LiveHost): void {
    host.openings -= 1;
    // Only reports belonging to unresolved creates/restores can still be used.
    if (host.openings === 0) {
      host.earlyReports.clear();
      this.pruneEarlyExits(host);
      // No unresolved reply can still compare an exited lifetime.
      for (const id of host.lifetimes.keys()) {
        if (!host.terminals.has(id)) host.lifetimes.delete(id);
      }
      if (host.acknowledgedExitSignals.size > 0) {
        const liveKeys = new Set(
          [...host.terminals.keys()].map(
            (id) => `${id}\u0000${host.lifetimes.get(id) ?? 0}`,
          ),
        );
        for (const key of host.acknowledgedExitSignals.keys()) {
          if (!liveKeys.has(key)) host.acknowledgedExitSignals.delete(key);
        }
      }
    }
  }

  private pruneEarlyExits(host: LiveHost): void {
    // An unresolved opening may still need any of these exits after its bytes.
    if (host.openings > 0) return;
    for (const id of host.early.keys()) {
      if (host.early.size <= MAX_EARLY_EXITS) break;
      host.early.delete(id);
    }
  }

  /**
   * Tracks a terminal its reply returned, unless it exited since the
   * request was sent (`since`, the host's exit count then).
   */
  private register(
    host: LiveHost,
    terminal: TerminalHostTerminal,
    since: number,
    initialize?: () => TerminalRecordRegistration | void,
  ): void {
    const id = terminal.session.id;
    const lifetime = terminal.lifetimeId ?? 0;
    const key = `${id}\u0000${lifetime}`;
    // A later restore's reply can resolve first; never re-attribute backwards.
    if ((host.lifetimes.get(id) ?? 0) > lifetime) return;
    const alreadyExited =
      host.lifetimes.get(id) === lifetime && !host.terminals.has(id);
    host.lifetimes.set(id, lifetime);
    const exit = host.early.get(key);
    const lost = host.exited || this.host !== host;
    // Pending replies retain known exits, not permission to announce them twice.
    if (
      alreadyExited ||
      (!exit && !lost && (host.exits.get(key) ?? 0) > since)
    ) {
      initialize?.();
      this.scheduleIdleStop(host);
      return;
    }
    if (!exit && !lost) host.terminals.set(id, terminal.pid);
    // No observer sees these bytes until the caller has installed attribution.
    const registration = initialize?.();
    if (registration !== undefined) host.registrations.set(key, registration);
    const reports = host.earlyReports.get(key) ?? [];
    host.earlyReports.delete(key);
    for (const report of reports) this.report(host, report);
    if (!exit && !lost) return;
    // An initializer already recorded it: its exit must precede a subsequent
    // recreation of this id, not arrive later and exit the new lifetime.
    // Callers without one retain the after-response announcement contract.
    host.early.delete(key);
    // Without the host's own exit, its final output offset is unknown.
    const ended: TerminalHostEvent = exit ?? {
      type: 'exit',
      terminalId: id,
      lifetimeId: terminal.lifetimeId,
      ...this.exitFor(host, key),
    };
    const announce = (): void => this.emit(host, ended);
    if (initialize) announce();
    else setTimeout(announce, 0);
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

  /** `signal` is the exit reason the terminal reports (CAN-7051). */
  public async kill(
    terminalId: string,
    signal?: string,
  ): Promise<TerminalHostTerminal> {
    return hostTerminal(
      await this.request({
        op: 'kill',
        terminalId,
        ...(signal !== undefined && { signal }),
      }),
    );
  }

  /** Stops the terminal's process tree and waits until it is gone. */
  public async release(terminalId: string, signal?: string): Promise<boolean> {
    if (!this.isLive(terminalId)) return false;
    return (
      (await this.request({
        op: 'release',
        terminalId,
        ...(signal !== undefined && { signal }),
      })) === true
    );
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
      lifetimeId: host.lifetimes.get(request.terminalId) ?? 0,
      awaitingReply: true,
      sink,
      offset: request.fromOffset,
    });
    try {
      const terminal = hostTerminal(
        await this.request({ op: 'attach', attachmentId, ...request }, host),
      );
      return { attachmentId, terminal };
    } catch (error) {
      this.removeAttachment(host, attachmentId);
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
   * requests are refused. Aborting ends the stop request and its exit wait;
   * the host is still killed, but its drain is then unconfirmed.
   */
  public async stop(signal?: AbortSignal): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const host = this.host;
    if (!host || host.exited) return;
    const exited = new Promise<void>((resolve) => {
      host.process.on('exit', () => resolve());
    });
    try {
      await this.send({ op: 'stop' }, host, SLOW_REQUEST_TIMEOUT_MS, signal);
    } catch {
      // The host is stopped below whatever it answered.
    }
    host.process.kill();
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        signal?.removeEventListener('abort', done);
        resolve();
      };
      signal?.addEventListener('abort', done, { once: true });
      void exited.then(done);
    });
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
      lifetimes: new Map(),
      registrations: new Map(),
      acknowledgedExitSignals: new Map(),
      early: new Map(),
      earlyReports: new Map(),
      openings: 0,
      exitCount: 0,
      exits: new Map(),
      attachments: new Map(),
      attachmentExits: new Map(),
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (host.exited)
      return Promise.reject(
        new TerminalHostRequestError({
          code: 'unavailable',
          message: 'The terminal host stopped.',
        }),
      );
    const id = this.nextId++;
    const lifetime =
      request.op === 'kill' || request.op === 'release'
        ? host.lifetimes.get(request.terminalId)
        : undefined;
    if (host.idleTimer !== undefined) {
      clearTimeout(host.idleTimer);
      host.idleTimer = undefined;
    }
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        host.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        fail(
          new TerminalHostRequestError({
            code: 'unavailable',
            message: 'The terminal host stop was aborted.',
          }),
        );
      };
      const timer = setTimeout(() => {
        fail(
          new TerminalHostRequestError({
            code: 'unavailable',
            message: 'The terminal host did not answer.',
          }),
        );
        // A host that stops answering is faulted: end it, and its terminals.
        host.process.kill();
      }, timeoutMs);
      host.pending.set(id, {
        resolve: (value): void => {
          if (request.op === 'attach' && isHostTerminal(value)) {
            const route = host.attachments.get(request.attachmentId);
            if (route && value.session.id === route.terminalId) {
              const previousKey = `${route.terminalId}\u0000${route.lifetimeId}`;
              // Bind before another message can end the host in this turn.
              route.lifetimeId = value.lifetimeId ?? 0;
              route.awaitingReply = false;
              const pendingExit = route.pendingExit;
              route.pendingExit = undefined;
              this.pruneAttachmentExit(host, previousKey);
              const key = `${route.terminalId}\u0000${route.lifetimeId}`;
              const early = host.early.get(key);
              const exit =
                pendingExit?.lifetimeId === route.lifetimeId
                  ? pendingExit.exit
                  : early?.type === 'exit'
                    ? early
                    : undefined;
              if (exit)
                this.retainAttachmentExit(
                  host,
                  route.terminalId,
                  route.lifetimeId,
                  exit,
                );
            }
          }
          // Capture the acknowledgement before another message can end the host.
          this.acknowledgeExitSignal(host, request, value, lifetime);
          cleanup();
          resolve(value);
        },
        reject: fail,
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        host.process.postMessage({ kind: 'request', id, request });
      } catch (error) {
        fail(
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

  private acknowledgeExitSignal(
    host: LiveHost,
    request: TerminalHostRequest,
    value: unknown,
    lifetime: number | undefined,
  ): void {
    if (request.op !== 'kill' && request.op !== 'release') return;
    if (request.op === 'kill') {
      if (!isHostTerminal(value) || value.session.id !== request.terminalId)
        return;
      lifetime = value.lifetimeId ?? 0;
      const currentLifetime = host.lifetimes.get(request.terminalId);
      // A kill can be acknowledged before create/restore installs its reply.
      if (currentLifetime !== undefined && currentLifetime > lifetime) return;
      if (
        host.openings === 0 &&
        (currentLifetime !== lifetime ||
          !host.terminals.has(request.terminalId))
      )
        return;
    } else if (value !== true) return;
    if (
      lifetime === undefined ||
      (request.op === 'release' &&
        (host.lifetimes.get(request.terminalId) !== lifetime ||
          !host.terminals.has(request.terminalId)))
    )
      return;
    const key = `${request.terminalId}\u0000${lifetime}`;
    const current = host.acknowledgedExitSignals.get(key) ?? null;
    // Ranked as the engine ranks a kill's and a release's reasons.
    if (request.op === 'kill') {
      if (
        request.signal &&
        (current === null ||
          isRestorableExitSignal(current) ||
          !isRestorableExitSignal(request.signal))
      )
        host.acknowledgedExitSignals.set(key, request.signal);
    } else if (
      !request.signal ||
      current === null ||
      (isRestorableExitSignal(current) &&
        !isRestorableExitSignal(request.signal))
    ) {
      host.acknowledgedExitSignals.set(
        key,
        request.signal || TERMINAL_WORKTREE_CLEANUP_SIGNAL,
      );
    }
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
        this.removeAttachment(host, message.attachmentId);
        route.sink.end(message.outcome, message.offset);
        return;
      }
      case 'report': {
        const { terminalId } = message.report;
        const lifetime = message.report.lifetimeId ?? 0;
        const key = `${terminalId}\u0000${lifetime}`;
        if (
          (!host.terminals.has(terminalId) ||
            host.lifetimes.get(terminalId) !== lifetime) &&
          host.openings > 0
        ) {
          const reports = host.earlyReports.get(key) ?? [];
          reports.push(message.report);
          host.earlyReports.set(key, reports);
          return;
        }
        if ((host.lifetimes.get(terminalId) ?? 0) !== lifetime) return;
        this.report(host, message.report);
        return;
      }
      case 'event': {
        const { event } = message;
        const lifetime = event.lifetimeId ?? 0;
        const key = `${event.terminalId}\u0000${lifetime}`;
        if (event.type === 'exit') {
          this.retainAttachmentExit(host, event.terminalId, lifetime, event);
          // A resolved opening can register after the last attachment drains.
          if (host.openings > 0) host.early.set(key, event);
          host.exitCount += 1;
          host.exits.delete(key);
          host.exits.set(key, host.exitCount);
          for (const id of host.exits.keys()) {
            if (host.exits.size <= MAX_RECENT_EXITS) break;
            host.exits.delete(id);
          }
        }
        if (
          event.type === 'exit' &&
          (host.lifetimes.get(event.terminalId) !== lifetime ||
            !host.terminals.delete(event.terminalId))
        ) {
          host.early.set(key, event);
          // Exits of terminals no request registers are kept briefly only.
          this.pruneEarlyExits(host);
          return;
        }
        if ((host.lifetimes.get(event.terminalId) ?? 0) !== lifetime) return;
        if (event.type === 'exit' && host.openings === 0)
          host.lifetimes.delete(event.terminalId);
        this.emit(host, event);
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
    const lost = [...host.terminals.keys()];
    const exits = new Map<string, TerminalHostExit>();
    for (const key of host.attachmentExits.keys())
      exits.set(key, this.exitFor(host, key));
    for (const terminalId of lost) {
      const key = `${terminalId}\u0000${host.lifetimes.get(terminalId) ?? 0}`;
      exits.set(key, this.exitFor(host, key));
    }
    for (const pid of host.terminals.values())
      if (pid !== null && pid > 0) this.options.killProcessGroup?.(pid);
    host.terminals.clear();
    // No output offset: the host never confirmed these lifetimes' final output.
    for (const terminalId of lost)
      this.emit(host, {
        type: 'exit',
        terminalId,
        lifetimeId: host.lifetimes.get(terminalId),
        ...this.exitFor(
          host,
          `${terminalId}\u0000${host.lifetimes.get(terminalId) ?? 0}`,
        ),
      });
    host.registrations.clear();
    for (const [attachmentId, route] of host.attachments) {
      const key = `${route.terminalId}\u0000${route.lifetimeId}`;
      const confirmedOffset = host.attachmentExits.get(key)?.outputOffset;
      route.sink.item(
        {
          terminalId: route.terminalId,
          fromOffset: route.offset,
          toOffset: route.offset,
          data: new Uint8Array(0),
          // Only the host's own exit can confirm that no output was lost.
          truncatedBefore:
            confirmedOffset === undefined || confirmedOffset > route.offset,
          exit: exits.get(key) ?? this.exitFor(host, key),
        },
        attachmentId,
      );
      route.sink.end('completed', route.offset);
    }
    host.attachments.clear();
    host.attachmentExits.clear();
    // Already-resolved create/restore replies still need their lifetime's reason.
    if (host.openings === 0) host.acknowledgedExitSignals.clear();
    this.options.onHostExit?.({ code, lost, expected: this.stopped });
  }

  private exitFor(host: LiveHost, key: string): TerminalHostExit {
    const known = host.attachmentExits.get(key);
    if (known) return { exitCode: known.exitCode, signal: known.signal };
    return {
      exitCode: null,
      signal:
        host.acknowledgedExitSignals.get(key) ?? WORKER_TERMINAL_LOST_SIGNAL,
    };
  }

  private retainAttachmentExit(
    host: LiveHost,
    terminalId: string,
    lifetimeId: number,
    exit: RetainedExit,
  ): void {
    const known: RetainedExit = {
      exitCode: exit.exitCode,
      signal: exit.signal,
      ...(exit.outputOffset !== undefined && {
        outputOffset: exit.outputOffset,
      }),
    };
    let retained = false;
    for (const route of host.attachments.values()) {
      if (route.terminalId !== terminalId) continue;
      if (
        route.awaitingReply &&
        (route.pendingExit?.lifetimeId ?? -1) <= lifetimeId
      )
        route.pendingExit = { lifetimeId, exit: known };
      if (route.lifetimeId === lifetimeId) retained = true;
    }
    if (retained)
      host.attachmentExits.set(`${terminalId}\u0000${lifetimeId}`, known);
  }

  private pruneAttachmentExit(host: LiveHost, key: string): void {
    if (!host.attachmentExits.has(key)) return;
    for (const route of host.attachments.values()) {
      if (`${route.terminalId}\u0000${route.lifetimeId}` === key) return;
    }
    host.attachmentExits.delete(key);
  }

  private removeAttachment(host: LiveHost, attachmentId: string): void {
    const route = host.attachments.get(attachmentId);
    if (!route) return;
    host.attachments.delete(attachmentId);
    this.pruneAttachmentExit(
      host,
      `${route.terminalId}\u0000${route.lifetimeId}`,
    );
  }

  private report(host: LiveHost, report: TerminalHostReport): void {
    const key = `${report.terminalId}\u0000${report.lifetimeId ?? 0}`;
    const registration = host.registrations.get(key);
    for (const listener of this.reporters) listener(report, registration);
  }

  private emit(host: LiveHost, event: TerminalHostEvent): void {
    const key = `${event.terminalId}\u0000${event.lifetimeId ?? 0}`;
    const registration = host.registrations.get(key);
    if (event.type === 'exit') {
      host.registrations.delete(key);
      host.acknowledgedExitSignals.delete(key);
    }
    for (const listener of this.listeners) listener(event, registration);
  }
}
