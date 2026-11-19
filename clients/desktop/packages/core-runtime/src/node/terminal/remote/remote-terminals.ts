import {
  TERMINAL_REPLAY_BUFFER_MAX_BYTES,
  TERMINAL_RESTORED_REPLAY_MAX_BYTES,
  TRUNCATION_MARKER_BYTES,
  buildRestoreMarker,
  exitEndsNoCommand,
} from '../engine';
import type {
  TerminalEnvironment,
  TerminalKillAllOptions,
  TerminalPersistencePort,
  TerminalResourceHandle,
  TerminalResourcePort,
  TerminalWorktreeScope,
  WorkerTerminalEvent,
} from '../ports';
import type { ResolvedTerminalShell } from '../shells';
import {
  WORKER_TERMINAL_LOST_SIGNAL,
  type CanopyWorkspaceScope,
  type WorkerTerminal,
  type WorkerTerminalAttachItem,
  type WorkerTerminalAttachParams,
  type WorkerTerminalCreateParams,
  type WorkerTerminalCreateResult,
  type WorkerTerminalKillParams,
  type WorkerTerminalReleaseParams,
  type WorkerTerminalReleaseResult,
  type WorkerTerminalResizeParams,
  type WorkerTerminalRestoreParams,
  type WorkerTerminalRestoreResult,
  type WorkerTerminalWriteParams,
  type WorkerTerminalWriteResult,
} from '@canopy/protocol/canopy-core';
import {
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
  type TerminalAttachResponse,
  type TerminalKind,
  type TerminalSession,
} from '@canopy/protocol/terminal';

/** One frame of a `worker.terminal.attach` stream, as the client delivers it. */
export type RemoteTerminalFrame =
  | { kind: 'item'; item: WorkerTerminalAttachItem }
  | {
      kind: 'end';
      outcome: 'completed' | 'cancelled' | 'error';
      error: { kind: string; code?: string } | null;
    };

/**
 * The `worker.terminal.*` calls remote terminals make, over whatever session
 * is current. Each call resolves that session itself, so a reconnect is
 * invisible here; a rejection carries the client's typed error.
 */
export interface RemoteTerminalTransport {
  create(
    params: WorkerTerminalCreateParams,
  ): Promise<WorkerTerminalCreateResult>;
  restore(
    params: WorkerTerminalRestoreParams,
  ): Promise<WorkerTerminalRestoreResult>;
  write(params: WorkerTerminalWriteParams): Promise<WorkerTerminalWriteResult>;
  resize(params: WorkerTerminalResizeParams): Promise<WorkerTerminal>;
  kill(params: WorkerTerminalKillParams): Promise<WorkerTerminal>;
  release(
    params: WorkerTerminalReleaseParams,
  ): Promise<WorkerTerminalReleaseResult>;
  attach(
    params: WorkerTerminalAttachParams,
    onFrame: (frame: RemoteTerminalFrame) => void,
  ): Promise<{ close(): void }>;
}

export interface RemoteTerminalsOptions {
  readonly transport: RemoteTerminalTransport;
  /** The client's terminal state; the worker keeps none (CAN-5092 places it). */
  readonly persistence: TerminalPersistencePort;
  /** Execution accounting for each terminal's process tree (CAN-4135). */
  readonly resources: TerminalResourcePort;
  /** Every terminal event, as the in-process engine emits them. */
  readonly emit: (event: WorkerTerminalEvent) => void;
  readonly log: (message: string, details: Record<string, unknown>) => void;
  readonly now?: () => number;
  /** Reattach attempts after a stream ended without the terminal's exit. */
  readonly reattachDelaysMs?: readonly number[];
  readonly createIdempotencyKey: () => string;
}

/** Where a terminal starts on the worker, as its client resolved it. */
export interface RemoteTerminalLaunch {
  /** The client's ids; events and persistence use them. */
  readonly projectId: string;
  readonly worktreeId: string;
  /** The worker's ids for the same worktree, after alias resolution. */
  readonly scope: CanopyWorkspaceScope;
  readonly cwdRootId: string;
  readonly cwdRelativePath: string;
  /** The host directory the worker resolves the root and path to. */
  readonly cwd: string;
  readonly shell: ResolvedTerminalShell;
  readonly environment: TerminalEnvironment;
  readonly cols: number;
  readonly rows: number;
  readonly initialCommand?: string;
}

/** The managed-session fields a client mirror carries for a managed command (CAN-5097). */
export interface RemoteManagedTerminal {
  readonly kind: Exclude<TerminalKind, 'shell'>;
  readonly title: string;
  readonly focusOnSpawn?: boolean;
  readonly chatId?: string;
  readonly sessionKey?: string;
}

export interface RemoteTerminalCreate extends RemoteTerminalLaunch {
  readonly profileId?: WorkerTerminalCreateParams['profileId'];
  readonly managed?: RemoteManagedTerminal;
}

export interface RemoteTerminalRecreate extends RemoteTerminalLaunch {
  readonly terminalId: string;
  readonly createdAt: number;
  /** The persisted scrollback the restored terminal replays first. */
  readonly scrollback: string;
}

/**
 * A terminal's replay window as its client mirrors it from its attachment,
 * addressed by the worker's byte offsets.
 */
class OutputMirror {
  private bytes: Buffer = Buffer.alloc(0);

  private end = 0;

  public constructor(
    private readonly capacity: number,
    private readonly marksTruncation: boolean,
  ) {}

  public get endOffset(): number {
    return this.end;
  }

  public append(fromOffset: number, data: Buffer): void {
    // Bytes that left the worker's window before delivery: start over there.
    if (fromOffset !== this.end) {
      this.bytes = Buffer.alloc(0);
      this.end = fromOffset;
    }
    this.end += data.length;
    const combined =
      this.bytes.length === 0 ? data : Buffer.concat([this.bytes, data]);
    this.bytes =
      combined.length <= this.capacity
        ? combined
        : Buffer.from(combined.subarray(combined.length - this.capacity));
  }

  public replay(): Uint8Array {
    const window =
      this.marksTruncation && this.end > this.bytes.length
        ? Buffer.concat([TRUNCATION_MARKER_BYTES, this.bytes])
        : this.bytes;
    return new Uint8Array(window);
  }

  public text(): string {
    return this.bytes.toString('utf8');
  }

  /** The bytes this window holds before `offset`. */
  public before(offset: number): Buffer {
    return this.bytes.subarray(
      0,
      Math.max(0, this.bytes.length - Math.max(0, this.end - offset)),
    );
  }
}

/**
 * The part of a live terminal's replay window that its persisted scrollback
 * lacks. Both are tails of the same output and no byte offset was persisted,
 * so they are aligned by content: usually the scrollback reaches back past
 * the window's start, and the longest start of the window that ends the
 * scrollback is what it already holds. Output repeated after that point
 * stays unpersisted. Only a scrollback that starts inside the window (it
 * dropped more old lines than the window did) is found by containment.
 */
function unpersistedOutput(persisted: Buffer, window: Buffer): Buffer {
  if (persisted.length === 0) return window;
  const overlap = windowStartEndingScrollback(persisted, window);
  if (overlap > 0) return window.subarray(overlap);
  const contained = window.lastIndexOf(persisted);
  return contained >= 0
    ? window.subarray(contained + persisted.length)
    : window;
}

/** The longest start of `window` that ends `persisted` (KMP). */
function windowStartEndingScrollback(
  persisted: Buffer,
  window: Buffer,
): number {
  const prefix = new Int32Array(window.length);
  for (let index = 1, length = 0; index < window.length; index += 1) {
    while (length > 0 && window[index] !== window[length])
      length = prefix[length - 1] ?? 0;
    if (window[index] === window[length]) length += 1;
    prefix[index] = length;
  }
  let matched = 0;
  for (const byte of persisted) {
    while (
      matched > 0 &&
      (matched === window.length || window[matched] !== byte)
    )
      matched = prefix[matched - 1] ?? 0;
    if (window[matched] === byte) matched += 1;
  }
  return matched;
}

interface Mirror {
  readonly session: TerminalSession;
  readonly scope: CanopyWorkspaceScope;
  readonly output: OutputMirror;
  /** Output up to here was already replayed or persisted; never re-emitted. */
  readonly seededOffset: number;
  running: boolean;
  processName: string | null;
  signalOverride: string | null;
  /** Kills and releases that end no command, not yet known to have failed. */
  noCommandKills: number;
  /** The worker's idle dropped during such a kill; reported if it fails. */
  heldIdle?: WorkerTerminalEvent;
  resource?: TerminalResourceHandle;
  attachment?: { close(): void };
  /** Writes and resizes reach the worker in order. */
  queue: Promise<void>;
  readonly exited: Promise<void>;
  finish: () => void;
  done: boolean;
  reconnecting: boolean;
  /** Reattaches since the last item arrived. */
  failures: number;
  /** Called after each delivery and at the end, while a caller waits on replay. */
  progress?: () => void;
  /**
   * A live terminal adopted on restore: its persisted scrollback, until the
   * output it lacks from before `seededOffset` is persisted.
   */
  persisted?: Buffer;
  /**
   * Set while create or restore has not returned the session: an exit then
   * is announced only after its caller has the session, as an in-process
   * PTY's exit always is.
   */
  adopting?: { exit?: () => void };
}

const REATTACH_DELAYS_MS = [100, 500, 2_000];
const KILL_EXIT_WAIT_MS = 3_000;
const REPLAY_WAIT_MS = 5_000;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const payload: unknown = Reflect.get(error, 'payload');
  const code: unknown =
    typeof payload === 'object' && payload !== null
      ? Reflect.get(payload, 'code')
      : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** The client reports the call as not applied and safe to send again. */
function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const payload: unknown = Reflect.get(error, 'payload');
  const retry: unknown =
    typeof payload === 'object' && payload !== null
      ? Reflect.get(payload, 'retry')
      : undefined;
  const kind: unknown =
    typeof retry === 'object' && retry !== null
      ? Reflect.get(retry, 'kind')
      : undefined;
  return kind === 'same_request' || kind === 'after_refresh';
}

function isGone(error: unknown): boolean {
  return errorCode(error) === 'worker.terminal.notFound';
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * A client's side of the terminals it placed on a worker that holds the
 * PTYs, such as the daemon's terminal host (CAN-5088). Each one is mirrored
 * from a single attachment: its output feeds a local replay window, the same
 * events the in-process engine emits and the client's terminal state, so
 * interfaces and persistence see these terminals as they see in-process
 * ones. The client keeps writing terminal state and accounting for the
 * process tree.
 *
 * A stream that ends before the terminal's exit reattaches from the last
 * byte. A terminal the daemon no longer has, or that cannot be reached
 * again, ends as lost with the shared `connection-lost` signal, so its
 * scrollback stays and Restart recreates it.
 */
export class RemoteTerminals {
  private readonly mirrors = new Map<string, Mirror>();

  /** Set by an app shutdown's kill-all: no exit after it ends a command. */
  private shuttingDown = false;

  /**
   * Terminals ended here as lost whose release the worker did not confirm:
   * worktree release and quit ask again, so none runs on untracked.
   */
  private readonly unreleased = new Map<
    string,
    {
      readonly scope: CanopyWorkspaceScope;
      readonly worktree: TerminalWorktreeScope;
    }
  >();

  /** Creates and restores waiting on the worker. */
  private readonly starts = new Set<Promise<TerminalSession>>();

  /** Restores in flight, so concurrent ones share one outcome and mirror. */
  private readonly restoring = new Map<string, Promise<TerminalSession>>();

  private killing: Promise<void> | undefined;

  public constructor(private readonly options: RemoteTerminalsOptions) {}

  public has(terminalId: string): boolean {
    return this.mirrors.has(terminalId);
  }

  public count(): number {
    return this.mirrors.size;
  }

  public get(terminalId: string): TerminalSession | null {
    return this.mirrors.get(terminalId)?.session ?? null;
  }

  public list(): TerminalSession[] {
    return Array.from(this.mirrors.values(), (mirror) => ({
      ...mirror.session,
      running: mirror.running,
      processName: mirror.processName,
    }));
  }

  public replay(terminalId: string): TerminalAttachResponse | null {
    const mirror = this.mirrors.get(terminalId);
    if (!mirror) return null;
    return {
      session: mirror.session,
      replay: mirror.output.replay(),
      seq: mirror.output.endOffset,
    };
  }

  public replayText(terminalId: string): string | null {
    return this.mirrors.get(terminalId)?.output.text() ?? null;
  }

  public create(request: RemoteTerminalCreate): Promise<TerminalSession> {
    return this.starting(this.createOnce(request));
  }

  /** Tracks a start until it settles, so killAll reaches what it produces. */
  private starting(start: Promise<TerminalSession>): Promise<TerminalSession> {
    this.starts.add(start);
    void start.then(
      () => this.starts.delete(start),
      () => this.starts.delete(start),
    );
    return start;
  }

  private async createOnce(
    request: RemoteTerminalCreate,
  ): Promise<TerminalSession> {
    const { managed } = request;
    if (
      managed &&
      (request.profileId !== undefined || request.initialCommand !== undefined)
    )
      throw new Error('A managed command takes no profile or initial command.');
    const created = await this.options.transport.create({
      scope: request.scope,
      cwdRootId: request.cwdRootId,
      cwdRelativePath: request.cwdRelativePath,
      shell: request.shell.shell,
      args: request.shell.args,
      env: environmentParams(request.environment),
      cols: request.cols,
      rows: request.rows,
      kind: managed ? 'managed' : 'interactive',
      _meta: { idempotencyKey: this.options.createIdempotencyKey() },
      ...(request.profileId !== undefined && { profileId: request.profileId }),
      ...(request.initialCommand !== undefined && {
        initialCommand: request.initialCommand,
      }),
    });
    const session: TerminalSession = {
      id: created.terminalId,
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      shell: request.shell.shell,
      shellBasename: request.shell.shellBasename,
      cwd: request.cwd,
      createdAt: this.now(),
      ...(request.initialCommand !== undefined && {
        initialCommand: request.initialCommand,
      }),
      ...(managed && {
        kind: managed.kind,
        ...(managed.focusOnSpawn !== undefined && {
          focusOnSpawn: managed.focusOnSpawn,
        }),
        title: managed.title,
        ...(managed.chatId !== undefined && { chatId: managed.chatId }),
        ...(managed.sessionKey !== undefined && {
          sessionKey: managed.sessionKey,
        }),
      }),
    };
    await this.adopt(session, request.scope, {
      pid: created.pid,
      capacity: TERMINAL_REPLAY_BUFFER_MAX_BYTES,
      marksTruncation: false,
      seededOffset: 0,
    });
    return session;
  }

  /** Resizes a live terminal, as restoring a live terminal does. */
  public async reattach(
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<TerminalSession> {
    const mirror = this.mirrors.get(terminalId);
    if (!mirror) throw new Error(`Terminal not found: ${terminalId}`);
    await this.options.transport.restore({
      scope: mirror.scope,
      terminalId,
      restoreMode: 'reattach_if_live',
      cols,
      rows,
      _meta: { idempotencyKey: this.options.createIdempotencyKey() },
    });
    return mirror.session;
  }

  /** Restarts a persisted shell on the worker under its own id. */
  public recreate(request: RemoteTerminalRecreate): Promise<TerminalSession> {
    const mirrored = this.mirrors.get(request.terminalId);
    if (mirrored) return Promise.resolve(mirrored.session);
    const pending = this.restoring.get(request.terminalId);
    if (pending) return pending;
    const restoring = this.starting(
      this.restoreOnce(request).finally(() => {
        this.restoring.delete(request.terminalId);
      }),
    );
    this.restoring.set(request.terminalId, restoring);
    return restoring;
  }

  private async restoreOnce(
    request: RemoteTerminalRecreate,
  ): Promise<TerminalSession> {
    const restored = await this.options.transport.restore({
      scope: request.scope,
      terminalId: request.terminalId,
      restoreMode: 'recreate_if_exited',
      cols: request.cols,
      rows: request.rows,
      _meta: { idempotencyKey: this.options.createIdempotencyKey() },
      snapshot: {
        cwdRootId: request.cwdRootId,
        cwdRelativePath: request.cwdRelativePath,
        shell: request.shell.shell,
        args: request.shell.args,
        env: environmentParams(request.environment),
        scrollback: request.scrollback,
        ...(request.initialCommand !== undefined && {
          initialCommand: request.initialCommand,
        }),
      },
    });
    const session: TerminalSession = {
      id: request.terminalId,
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      shell: request.shell.shell,
      shellBasename: request.shell.shellBasename,
      cwd: request.cwd,
      createdAt: request.createdAt,
      ...(request.initialCommand !== undefined && {
        initialCommand: request.initialCommand,
      }),
    };
    if (!restored.recreated) {
      // Still live on the worker: nothing restarted, so no marker, and its
      // replay window (with output from while no client mirrored it) is
      // read before the session is returned.
      await this.adopt(session, request.scope, {
        pid: restored.pid,
        capacity: TERMINAL_REPLAY_BUFFER_MAX_BYTES,
        marksTruncation: true,
        seededOffset: restored.outputOffset,
        replayTo: restored.outputOffset,
        persisted: Buffer.from(request.scrollback, 'utf8'),
      });
      return session;
    }
    // As in process: the persisted output ends with the restore marker.
    const marker = buildRestoreMarker(request.scrollback.length > 0);
    this.options.persistence.appendTerminalOutput(
      session.projectId,
      session.worktreeId,
      session.id,
      marker,
    );
    await this.adopt(session, request.scope, {
      pid: restored.pid,
      capacity:
        TERMINAL_RESTORED_REPLAY_MAX_BYTES - TRUNCATION_MARKER_BYTES.length,
      marksTruncation: true,
      seededOffset: restored.outputOffset,
      // The worker's replay up to `outputOffset` is this same scrollback and
      // marker, so the mirror holds it before the session is returned.
      seed: Buffer.concat([Buffer.from(request.scrollback, 'utf8'), marker]),
    });
    return session;
  }

  public write(terminalId: string, data: string): void {
    const mirror = this.mirrors.get(terminalId);
    if (!mirror) return;
    this.enqueue(mirror, 'write', () =>
      this.options.transport.write({
        scope: mirror.scope,
        terminalId,
        input: data,
        encoding: 'utf8',
      }),
    );
  }

  public resize(terminalId: string, cols: number, rows: number): void {
    const mirror = this.mirrors.get(terminalId);
    if (!mirror) return;
    this.enqueue(mirror, 'resize', () =>
      this.options.transport.resize({
        scope: mirror.scope,
        terminalId,
        cols,
        rows,
      }),
    );
  }

  /** Kills the process tree; the exit follows, under `signal` when given. */
  public kill(terminalId: string, signal?: string | null): void {
    const mirror = this.mirrors.get(terminalId);
    if (!mirror) return;
    if (signal) mirror.signalOverride = signal;
    const endsNoCommand = exitEndsNoCommand(signal ?? null);
    if (endsNoCommand) mirror.noCommandKills += 1;
    this.enqueue(
      mirror,
      'kill',
      () => this.options.transport.kill({ scope: mirror.scope, terminalId }),
      () => {
        if (endsNoCommand) this.noCommandKillFailed(mirror);
      },
    );
  }

  /** As in process, the exits report a worktree cleanup, not a signal. */
  public killWorktree(scope: TerminalWorktreeScope): void {
    for (const mirror of this.matching(scope))
      this.kill(mirror.session.id, TERMINAL_WORKTREE_CLEANUP_SIGNAL);
  }

  /** Kills every terminal and waits, bounded, for their exits. */
  public killAll(options?: TerminalKillAllOptions): Promise<void> {
    if (options) this.shuttingDown = true;
    if (this.killing) return this.killing;
    const mirrors = Array.from(this.mirrors.values());
    for (const mirror of mirrors) this.kill(mirror.session.id);
    // A terminal still starting is killed once it exists, even after this
    // bounded wait.
    const started = Array.from(this.starts, (start) =>
      start.then(
        (session) => {
          this.kill(session.id);
          return this.mirrors.get(session.id)?.exited;
        },
        () => undefined,
      ),
    );
    const killing = withTimeout(
      Promise.all([
        ...mirrors.map((mirror) => mirror.exited),
        ...started,
        // Quit cannot wait on an unreachable daemon; its stop ends them.
        this.releaseUnreleased(() => true).catch(() => undefined),
      ]).then(() => undefined),
      KILL_EXIT_WAIT_MS,
    ).finally(() => {
      if (this.killing === killing) this.killing = undefined;
    });
    this.killing = killing;
    return killing;
  }

  /** Stops the process tree and waits until it is gone. */
  public async release(terminalId: string): Promise<void> {
    const mirror = this.mirrors.get(terminalId);
    if (!mirror) return;
    mirror.signalOverride ??= TERMINAL_WORKTREE_CLEANUP_SIGNAL;
    mirror.noCommandKills += 1;
    try {
      await this.options.transport.release({ scope: mirror.scope, terminalId });
    } catch (error) {
      if (!isGone(error)) {
        this.noCommandKillFailed(mirror);
        throw error;
      }
      this.finish(mirror, null, WORKER_TERMINAL_LOST_SIGNAL);
    }
    await mirror.exited;
  }

  public async releaseWorktree(scope: TerminalWorktreeScope): Promise<void> {
    const results = await Promise.allSettled([
      ...this.matching(scope).map((mirror) => this.release(mirror.session.id)),
      this.releaseUnreleased(
        ({ projectId, worktreeId }) =>
          projectId === scope.projectId && worktreeId === scope.worktreeId,
      ),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  /** Includes a lost terminal whose release the worker has not confirmed. */
  public hasLiveTerminals(scope: TerminalWorktreeScope): boolean {
    return (
      this.matching(scope).length > 0 ||
      Array.from(this.unreleased.values()).some(
        ({ worktree }) =>
          worktree.projectId === scope.projectId &&
          worktree.worktreeId === scope.worktreeId,
      )
    );
  }

  public runningWorktrees(): TerminalWorktreeScope[] {
    return Array.from(this.mirrors.values())
      .filter((mirror) => mirror.running)
      .map(({ session }) => ({
        projectId: session.projectId,
        worktreeId: session.worktreeId,
      }));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private matching({ projectId, worktreeId }: TerminalWorktreeScope): Mirror[] {
    return Array.from(this.mirrors.values()).filter(
      ({ session }) =>
        session.projectId === projectId && session.worktreeId === worktreeId,
    );
  }

  private enqueue(
    mirror: Mirror,
    operation: string,
    call: () => Promise<unknown>,
    onFailed?: () => void,
  ): void {
    mirror.queue = mirror.queue.then(async () => {
      const delays = this.options.reattachDelaysMs ?? REATTACH_DELAYS_MS;
      for (let attempt = 0; !mirror.done; attempt += 1) {
        try {
          await call();
          return;
        } catch (error) {
          if (isGone(error)) {
            this.finish(mirror, null, WORKER_TERMINAL_LOST_SIGNAL);
            return;
          }
          // Only a call the client reports as not applied is sent again, in
          // order: a write has no idempotency key, so one with an unknown
          // outcome is never replayed.
          const delay = delays[attempt];
          if (delay === undefined || !isRetryable(error)) {
            this.options.log('Daemon terminal call failed', {
              operation,
              terminalId: mirror.session.id,
              code: errorCode(error) ?? null,
            });
            onFailed?.();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    });
  }

  private async adopt(
    session: TerminalSession,
    scope: CanopyWorkspaceScope,
    window: {
      pid: unknown;
      capacity: number;
      marksTruncation: boolean;
      seededOffset: number;
      seed?: Buffer;
      /** Waits, bounded, until the mirror holds output up to this offset. */
      replayTo?: number;
      persisted?: Buffer;
    },
  ): Promise<void> {
    let finish = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const mirror: Mirror = {
      session,
      scope,
      output: new OutputMirror(window.capacity, window.marksTruncation),
      seededOffset: window.seededOffset,
      running: false,
      processName: null,
      signalOverride: null,
      noCommandKills: 0,
      queue: Promise.resolve(),
      exited,
      finish,
      done: false,
      reconnecting: false,
      failures: 0,
      ...(window.persisted && { persisted: window.persisted }),
    };
    if (window.seed) {
      const seed = window.seed.subarray(
        Math.max(0, window.seed.length - window.seededOffset),
      );
      mirror.output.append(window.seededOffset - seed.length, seed);
    }
    const adopting: { exit?: () => void } = {};
    mirror.adopting = adopting;
    this.mirrors.set(session.id, mirror);
    this.options.persistence.registerLiveSession(session);
    if (typeof window.pid === 'number' && Number.isInteger(window.pid))
      mirror.resource = this.options.resources.register(session, window.pid);
    try {
      if (!(await this.attach(mirror, mirror.output.endOffset)))
        void this.reconnect(mirror);
    } catch (error) {
      if (isGone(error)) this.finish(mirror, null, WORKER_TERMINAL_LOST_SIGNAL);
      else void this.reconnect(mirror);
    }
    if (window.replayTo !== undefined)
      await this.replayed(mirror, window.replayTo);
    mirror.adopting = undefined;
    const { exit } = adopting;
    if (exit) setTimeout(exit, 0);
  }

  private async replayed(mirror: Mirror, offset: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (mirror.done || mirror.output.endOffset >= offset) resolve();
      };
      mirror.progress = check;
      timer = setTimeout(resolve, REPLAY_WAIT_MS);
      check();
    });
    clearTimeout(timer);
    mirror.progress = undefined;
  }

  /**
   * Attaches from `fromOffset`. Resolves false when the stream ended while it
   * opened and the terminal still needs another attachment: an end delivered
   * then cannot reconnect, since its caller is still attaching.
   */
  private async attach(mirror: Mirror, fromOffset: number): Promise<boolean> {
    const terminalId = mirror.session.id;
    let ended = false;
    let open = false;
    const attachment = await this.options.transport.attach(
      { scope: mirror.scope, terminalId, fromOffset },
      (frame) => {
        if (ended || mirror.done) return;
        if (frame.kind === 'item') {
          this.receive(mirror, frame.item);
          return;
        }
        ended = true;
        if (open) mirror.attachment = undefined;
        if (mirror.done) return;
        // The exit item closes a completed stream; anything else lost it.
        if (frame.error?.code === 'worker.terminal.notFound')
          this.finish(mirror, null, WORKER_TERMINAL_LOST_SIGNAL);
        else if (open) void this.reconnect(mirror);
      },
    );
    if (ended || mirror.done) {
      attachment.close();
      return mirror.done;
    }
    open = true;
    mirror.attachment = attachment;
    return true;
  }

  /**
   * Reattaches from the last byte. Attempts count until an item arrives, so
   * a stream that keeps ending without progress ends the terminal as lost.
   */
  private async reconnect(mirror: Mirror): Promise<void> {
    if (mirror.reconnecting) return;
    mirror.reconnecting = true;
    const delays = this.options.reattachDelaysMs ?? REATTACH_DELAYS_MS;
    let gone = false;
    try {
      while (mirror.failures < delays.length) {
        const delay = delays[mirror.failures] ?? 0;
        mirror.failures += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (mirror.done) return;
        try {
          const attached = await this.attach(mirror, mirror.output.endOffset);
          if (mirror.done) return;
          // An end that arrived since it opened could not start another
          // reconnect while this one runs, so this one carries on.
          if (attached && mirror.attachment) return;
        } catch (error) {
          if (isGone(error)) {
            gone = true;
            break;
          }
        }
      }
      // It may still run on the worker: ask it to stop before ending it here.
      if (!gone && !mirror.done) await this.releaseLost(mirror);
      this.finish(mirror, null, WORKER_TERMINAL_LOST_SIGNAL);
    } finally {
      mirror.reconnecting = false;
    }
  }

  private async releaseLost(mirror: Mirror): Promise<void> {
    const { session, scope } = mirror;
    try {
      await this.options.transport.release({ scope, terminalId: session.id });
    } catch (error) {
      if (isGone(error)) return;
      this.unreleased.set(session.id, {
        scope,
        worktree: {
          projectId: session.projectId,
          worktreeId: session.worktreeId,
        },
      });
      this.options.log('Daemon terminal release failed after a lost stream', {
        terminalId: session.id,
        code: errorCode(error) ?? null,
      });
    }
  }

  /**
   * Asks again to release lost terminals the worker may still run. One whose
   * release fails stays tracked, and the call rejects with its failure.
   */
  private async releaseUnreleased(
    matches: (worktree: TerminalWorktreeScope) => boolean,
  ): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.unreleased)
        .filter(([, { worktree }]) => matches(worktree))
        .map(async ([terminalId, { scope }]) => {
          try {
            await this.options.transport.release({ scope, terminalId });
          } catch (error) {
            if (!isGone(error)) throw error;
          }
          this.unreleased.delete(terminalId);
        }),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  private receive(mirror: Mirror, item: WorkerTerminalAttachItem): void {
    const { session } = mirror;
    mirror.failures = 0;
    const data = Buffer.from(item.data, item.encoding);
    if (data.length > 0) {
      mirror.output.append(item.fromOffset, data);
      if (mirror.persisted && item.toOffset >= mirror.seededOffset) {
        // Output from while no client mirrored it, persisted once, in order.
        const missing = unpersistedOutput(
          mirror.persisted,
          mirror.output.before(mirror.seededOffset),
        );
        mirror.persisted = undefined;
        if (missing.length > 0)
          this.options.persistence.appendTerminalOutput(
            session.projectId,
            session.worktreeId,
            session.id,
            Buffer.from(missing),
          );
      }
      if (item.toOffset > mirror.seededOffset) {
        const fresh =
          item.fromOffset >= mirror.seededOffset
            ? data
            : data.subarray(mirror.seededOffset - item.fromOffset);
        this.options.persistence.appendTerminalOutput(
          session.projectId,
          session.worktreeId,
          session.id,
          fresh,
        );
        this.options.emit({
          type: 'output',
          payload: {
            projectId: session.projectId,
            worktreeId: session.worktreeId,
            terminalId: session.id,
            data: new Uint8Array(fresh),
            seq: item.toOffset,
          },
        });
      }
    }
    if (
      item.running &&
      (item.running.running !== mirror.running ||
        item.running.processName !== mirror.processName)
    ) {
      mirror.running = item.running.running;
      mirror.processName = item.running.processName;
      const event: WorkerTerminalEvent = {
        type: 'runningChanged',
        payload: {
          projectId: session.projectId,
          worktreeId: session.worktreeId,
          terminalId: session.id,
          kind: session.kind ?? 'shell',
          running: item.running.running,
          processName: item.running.processName,
          ...(item.running.interruptedByUser !== undefined && {
            interruptedByUser: item.running.interruptedByUser,
          }),
        },
      };
      // The worker sends its own idle before the exit item; after a kill
      // that ends no command, that idle is no completion either.
      mirror.heldIdle =
        item.running.running || !this.killEndsNoCommand(mirror)
          ? undefined
          : event;
      if (!mirror.heldIdle) this.options.emit(event);
    }
    if (item.exit) this.finish(mirror, item.exit.code, item.exit.signal);
    mirror.progress?.();
  }

  private finish(
    mirror: Mirror,
    exitCode: number | null,
    signal: string | null,
  ): void {
    if (mirror.done) return;
    mirror.done = true;
    const { session } = mirror;
    if (this.mirrors.get(session.id) === mirror)
      this.mirrors.delete(session.id);
    mirror.progress?.();
    mirror.attachment?.close();
    mirror.attachment = undefined;
    mirror.resource?.unregister();
    mirror.resource = undefined;
    const announce = (): void =>
      this.announceExit(
        mirror,
        exitCode,
        mirror.signalOverride ?? signal,
        // `signal`, not the override: an override can outlive a failed kill.
        this.killEndsNoCommand(mirror) || exitEndsNoCommand(signal),
      );
    if (mirror.adopting) mirror.adopting.exit = announce;
    else announce();
  }

  private killEndsNoCommand(mirror: Mirror): boolean {
    return this.shuttingDown || mirror.noCommandKills > 0;
  }

  /** The terminal may have outlived the kill, so a held idle was real. */
  private noCommandKillFailed(mirror: Mirror): void {
    mirror.noCommandKills -= 1;
    const held = mirror.heldIdle;
    if (!held || mirror.done || this.killEndsNoCommand(mirror)) return;
    mirror.heldIdle = undefined;
    this.options.emit(held);
  }

  private announceExit(
    mirror: Mirror,
    exitCode: number | null,
    resolvedSignal: string | null,
    endsNoCommand: boolean,
  ): void {
    const { session } = mirror;
    if ((mirror.running || mirror.processName !== null) && !endsNoCommand) {
      mirror.running = false;
      mirror.processName = null;
      this.options.emit({
        type: 'runningChanged',
        payload: {
          projectId: session.projectId,
          worktreeId: session.worktreeId,
          terminalId: session.id,
          kind: session.kind ?? 'shell',
          running: false,
          processName: null,
        },
      });
    }
    this.options.emit({
      type: 'exit',
      payload: {
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        terminalId: session.id,
        kind: session.kind ?? 'shell',
        exitCode,
        signal: resolvedSignal,
      },
    });
    this.options.persistence.markTerminalExited(
      session.projectId,
      session.worktreeId,
      session.id,
      exitCode,
      resolvedSignal,
    );
    mirror.finish();
  }
}

function environmentParams(
  environment: TerminalEnvironment,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment))
    if (value !== undefined) params[name] = value;
  return params;
}
