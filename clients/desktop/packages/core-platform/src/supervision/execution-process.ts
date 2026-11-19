import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { statSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import type { Duplex, Readable, Writable } from 'node:stream';
import {
  spawnFailureDetails,
  type SpawnFailureDetails,
} from '@canopy/core-runtime';
import type {
  PlatformExecutionInput,
  PlatformExecutionOutcome,
  PlatformExecutionOutput,
  PlatformExecutionProcess,
  PlatformExecutionProcessServices,
  PlatformExecutionRequest,
  PlatformOperatingSystem,
  PlatformStopMode,
} from '@canopy/core-runtime';
import { candidatesIn } from '../git-read/resolve';
import { createChildServices } from './child';
import {
  bounded,
  createExitCustody,
  createJobLauncher,
  type ExitCustody,
  fullyQualified,
  type JobLauncher,
  type LaunchedTree,
  OwnedChildError,
} from './owned-child';
import { signalProcessGroup } from './process-group';
import {
  errorCode,
  LIBUV_REQUIRED_KEYS,
  NODE_SUPERVISION,
  type SupervisionOperations,
} from './shared';

export type ExecutionProcessErrorCode =
  | 'capability_unavailable'
  | 'invalid_argument'
  | 'failed_precondition'
  | 'unavailable';

/** Fixed messages only: no paths, arguments, environment, or output. */
export class ExecutionProcessError extends Error {
  override readonly name = 'ExecutionProcessError';
  readonly code: ExecutionProcessErrorCode;

  /** A failed spawn's allowlisted errno (CAN-7113). */
  readonly details: SpawnFailureDetails | undefined;

  constructor(
    code: ExecutionProcessErrorCode,
    message: string,
    details?: SpawnFailureDetails,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const INVALID = 'Execution process request is invalid.';
const UNSUPPORTED = 'Execution processes are unavailable on this host.';
const NOT_STARTED = 'Execution process could not be started.';
const CLOSED = 'Execution process services are shut down.';
const UNCONFIRMED = 'Execution process cleanup did not complete.';
const INPUT_CLOSED = 'Execution process input is closed.';
const BUSY = 'Execution process output is already being read.';

const fail = (
  code: ExecutionProcessErrorCode,
  message: string,
  details?: SpawnFailureDetails,
): ExecutionProcessError => new ExecutionProcessError(code, message, details);

const DEFAULT_WINDOW_BYTES = 64 * 1024;
const MAX_WINDOW_BYTES = 1024 * 1024;
// Windows NTSTATUS error severity: an exception, not a chosen exit code.
const NTSTATUS_ERROR = 0xc0000000;

export type ExecutionProcessRootExit = Pick<
  PlatformExecutionOutcome,
  'kind' | 'code' | 'signal'
>;

/** Host-only custody observation and test seams. */
export interface ExecutionProcessOperations {
  /** Root exit before output drains; false includes lost custody, not just live members. */
  readonly onRootTreeEmpty?: (
    empty: boolean,
    exit: ExecutionProcessRootExit,
  ) => void;
  /** darwin and linux children. */
  readonly spawn: (
    file: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  /**
   * win32: connects to one of a launched child's stdio pipes. The stdin pipe
   * is write-only, so Node reports its readable side ended at once; `input`
   * keeps the writable side open past that.
   */
  readonly connect: (pipe: string, input: boolean) => Promise<Duplex>;
  /** win32: whether a file exists and is not a directory, as libuv tests. */
  readonly isFile: (file: string) => boolean;
  readonly supervision: SupervisionOperations;
  /** TERM-to-KILL escalation for graceful stops on POSIX. */
  readonly graceMs: number;
  /**
   * How long after its first KILL a stop may take to confirm that no member
   * remains.
   */
  readonly cleanupMs: number;
  readonly pollMs: number;
  /** How often the tree of an exited root is checked for remaining members. */
  readonly survivorPollMs: number;
  /**
   * After the root is reaped, only a living member keeps the group's ID from
   * reuse. A group not seen for this long can no longer be told apart from a
   * new group under a recycled ID, so custody lapses rather than signal it.
   */
  readonly reservationMs: number;
}

const DEFAULT_OPERATIONS: ExecutionProcessOperations = {
  spawn: (file, args, options) => nodeSpawn(file, [...args], options),
  connect: (pipe, input) =>
    new Promise((resolve, reject) => {
      const socket = netConnect({ path: pipe, allowHalfOpen: input });
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(socket);
      });
    }),
  isFile: (file) => {
    try {
      return !statSync(file).isDirectory();
    } catch {
      return false;
    }
  },
  supervision: NODE_SUPERVISION,
  graceMs: 2_000,
  cleanupMs: 2_000,
  pollMs: 10,
  survivorPollMs: 250,
  reservationMs: 2_000,
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const MESSAGES: Readonly<Record<ExecutionProcessErrorCode, string>> = {
  capability_unavailable: UNSUPPORTED,
  invalid_argument: INVALID,
  // The shared custody refuses a child only when launching it.
  failed_precondition: NOT_STARTED,
  unavailable: UNCONFIRMED,
};

/** Maps the shared custody's typed failures onto this module's errors. */
function translated(error: unknown): ExecutionProcessError {
  if (error instanceof ExecutionProcessError) return error;
  if (error instanceof OwnedChildError)
    return fail(error.code, MESSAGES[error.code]);
  return fail('unavailable', UNCONFIRMED);
}

/**
 * The tree of one execution child. `settle` runs after the root's exit and
 * never signals; `stop` signals until no member remains.
 */
interface TreeCustody {
  settle(): boolean;
  /** Custody ended without confirming the tree was gone. */
  readonly lapsed: boolean;
  /** Concurrent calls share one attempt; a failed attempt may be retried. */
  stop(mode: PlatformStopMode): Promise<void>;
}

/**
 * A POSIX process group led by the root, which Node spawned detached. Until
 * the root is reaped its PID reserves the group's ID; after that a member
 * seen within the reservation window does. Once a probe finds the group
 * empty, or the window passes unobserved, custody ends and nothing is
 * signaled again.
 */
function groupCustody(
  pgid: number,
  custody: ExitCustody,
  ops: ExecutionProcessOperations,
): TreeCustody {
  const supervision = ops.supervision;
  let released = false;
  let lapsed = false;
  let rootGone = false;
  let seenAt = 0;
  let stopping: Promise<void> | undefined;
  let forceAt = Number.POSITIVE_INFINITY;

  // Darwin answers EPERM while a member is exiting: still present.
  const send = (signal: 'SIGTERM' | 'SIGKILL' | 0): 'sent' | 'absent' => {
    try {
      return signalProcessGroup(pgid, signal, supervision);
    } catch (error) {
      if (errorCode(error) === 'EPERM') return 'sent';
      throw error;
    }
  };
  const releaseCustody = custody.hold(() => {
    try {
      if (!absent()) send('SIGKILL');
    } catch {
      process.stderr.write(`${UNCONFIRMED}\n`);
    }
  });
  const done = (): void => {
    released = true;
    releaseCustody();
  };
  const absent = (): boolean => {
    if (released) return true;
    if (rootGone && performance.now() - seenAt > ops.reservationMs) {
      lapsed = true;
      done();
      return true;
    }
    if (send(0) === 'absent') {
      done();
      return true;
    }
    if (rootGone) seenAt = performance.now();
    return false;
  };

  async function stop(): Promise<void> {
    let terminated = false;
    // The cleanup window runs from the first KILL actually sent, so a poll
    // that resumed late still leaves the KILL its whole window.
    let killedAt: number | undefined;
    for (;;) {
      if (absent()) {
        if (lapsed) throw fail('unavailable', UNCONFIRMED);
        return;
      }
      const now = performance.now();
      // Checked only after a probe, so the last KILL is always probed.
      if (killedAt !== undefined && now - killedAt >= ops.cleanupMs)
        throw fail('unavailable', UNCONFIRMED);
      if (now >= forceAt) {
        send('SIGKILL');
        killedAt ??= performance.now();
      } else if (!terminated) {
        terminated = true;
        send('SIGTERM');
      }
      await delay(ops.pollMs);
    }
  }

  return {
    // Called first when the root's exit is observed, right after its reap.
    settle(): boolean {
      if (!rootGone) {
        rootGone = true;
        seenAt = performance.now();
      }
      return absent();
    },
    get lapsed(): boolean {
      return lapsed;
    },
    stop(mode: PlatformStopMode): Promise<void> {
      if (released)
        return lapsed
          ? Promise.reject(fail('unavailable', UNCONFIRMED))
          : Promise.resolve();
      // A forced request escalates a graceful stop already under way.
      forceAt = Math.min(
        forceAt,
        performance.now() + (mode === 'force' ? 0 : ops.graceMs),
      );
      stopping ??= stop().finally(() => {
        stopping = undefined;
        forceAt = Number.POSITIVE_INFINITY;
      });
      return stopping;
    },
  };
}

/** A Windows job held by the owned-child addon; every stop is forced. */
function jobCustody(tree: LaunchedTree): TreeCustody {
  return {
    settle: () => tree.settle(),
    lapsed: false,
    stop: () => tree.stop(),
  };
}

/** One stdio stream, metered by credit. See PlatformExecutionOutput. */
class CreditedOutput implements PlatformExecutionOutput {
  private readonly queue: Buffer[] = [];
  private queued = 0;
  private inFlight = 0;
  private ended = false;
  private discarded = false;
  private dropped = false;
  private reading = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly stream: Readable,
    private readonly window: number,
    private readonly changed: () => void,
  ) {
    stream.on('data', (chunk: Buffer) => this.push(chunk));
    const end = (): void => this.end();
    stream.once('end', end);
    stream.once('close', end);
    // A failed pipe ends the stream; the root's exit decides the outcome.
    stream.on('error', end);
  }

  /** Everything delivered after the end, or discarded. */
  get settled(): boolean {
    return this.discarded || (this.ended && this.queued === 0);
  }

  /** Whether a caller discarded output that was still undelivered. */
  get lost(): boolean {
    return this.dropped;
  }

  /** Releases the pipe of a stream that will not be read to its end. */
  close(): void {
    if (!this.ended) this.stream.destroy();
  }

  async read(options?: {
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array | null> {
    options?.signal?.throwIfAborted();
    if (this.reading) throw fail('failed_precondition', BUSY);
    this.reading = true;
    try {
      for (;;) {
        if (this.discarded) return null;
        if (this.queued > 0 && this.inFlight < this.window) return this.take();
        if (this.queued === 0 && this.ended) return null;
        await this.next(options?.signal);
      }
    } finally {
      this.reading = false;
    }
  }

  acknowledge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw fail('invalid_argument', INVALID);
    this.inFlight = Math.max(0, this.inFlight - bytes);
    this.flow();
    this.notify();
  }

  discard(): void {
    if (!this.discarded && !this.settled) this.dropped = true;
    this.drain();
  }

  /** Discards without counting anything lost: the request asked for it. */
  drain(): void {
    if (this.discarded) return;
    this.discarded = true;
    this.queue.length = 0;
    this.queued = 0;
    this.inFlight = 0;
    this.flow();
    this.notify();
    this.changed();
  }

  private push(chunk: Buffer): void {
    if (this.discarded) return;
    this.queue.push(chunk);
    this.queued += chunk.byteLength;
    this.flow();
    this.notify();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.notify();
    this.changed();
  }

  private take(): Uint8Array {
    const room = this.window - this.inFlight;
    const head = this.queue[0];
    let out = head;
    if (head.byteLength <= room) this.queue.shift();
    else {
      out = head.subarray(0, room);
      this.queue[0] = head.subarray(room);
    }
    this.queued -= out.byteLength;
    this.inFlight += out.byteLength;
    this.flow();
    // After the caller has resumed from this read, so the outcome follows
    // the last bytes it delivered.
    if (this.settled) setImmediate(this.changed);
    return out;
  }

  /**
   * Stops reading the pipe while bytes wait for a read or for credit. The
   * stream's own state decides, not a cached flag: Node resumes an exited
   * child's pipes to flush them, while descendants may still write to them.
   */
  private flow(): void {
    const hold =
      !this.discarded && (this.queued > 0 || this.inFlight >= this.window);
    if (hold !== this.stream.isPaused())
      if (hold) this.stream.pause();
      else this.stream.resume();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /** Waits for a change, or rejects with the abort reason. */
  private async next(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        signal?.removeEventListener('abort', done);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      this.wake = done;
      signal?.addEventListener('abort', done, { once: true });
    });
    signal?.throwIfAborted();
  }
}

class PipeInput implements PlatformExecutionInput {
  private closed = false;
  private ending: Promise<void> | undefined;

  constructor(private readonly stream: Writable) {
    // A child that stopped reading fails the pending write, not the host.
    stream.on('error', () => {
      this.closed = true;
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array))
      return Promise.reject(fail('invalid_argument', INVALID));
    if (this.closed || this.ending)
      return Promise.reject(fail('failed_precondition', INPUT_CLOSED));
    // An empty write to a child that closed stdin fails though nothing is lost.
    if (bytes.byteLength === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.stream.write(bytes, (error) => {
        if (!error) return resolve();
        this.closed = true;
        reject(fail('failed_precondition', INPUT_CLOSED));
      });
    });
  }

  end(): Promise<void> {
    this.ending ??= new Promise<void>((resolve) => {
      if (this.closed || this.stream.destroyed) return resolve();
      this.stream.end(() => resolve());
    }).then(() => {
      this.closed = true;
    });
    return this.ending;
  }

  close(): void {
    this.closed = true;
    this.stream.destroy();
  }
}

interface Validated {
  readonly environment: Record<string, string>;
  readonly window: number;
}

function validate(
  os: PlatformOperatingSystem,
  request: PlatformExecutionRequest,
): Validated {
  const text = (value: unknown): value is string =>
    typeof value === 'string' && !value.includes('\0');
  const { executable, args, cwd, environment, stdin, stderr } = request;
  const window = request.outputWindowBytes ?? DEFAULT_WINDOW_BYTES;
  const entries: [string, unknown][] =
    typeof environment === 'object' && environment !== null
      ? Object.entries(environment)
      : [['', undefined]];
  // Windows treats names that differ only in case as one variable.
  const names = entries.map(([key]) =>
    os === 'win32' ? key.toUpperCase() : key,
  );
  const valid =
    text(executable) &&
    fullyQualified(os, executable) &&
    text(cwd) &&
    fullyQualified(os, cwd) &&
    Array.isArray(args) &&
    args.every(text) &&
    entries.every(
      ([key, value]) =>
        key !== '' && !key.includes('=') && text(key) && text(value),
    ) &&
    new Set(names).size === names.length &&
    (stdin === undefined || stdin === 'pipe' || stdin === 'ignore') &&
    (stderr === undefined || stderr === 'pipe' || stderr === 'discard') &&
    Number.isSafeInteger(window) &&
    window >= 1 &&
    window <= MAX_WINDOW_BYTES;
  if (!valid) throw fail('invalid_argument', INVALID);
  const copy: Record<string, string> = {};
  for (const [key, value] of entries)
    if (typeof value === 'string') copy[key] = value;
  // As Node starts children: libuv would fill these from the host, so the
  // addon receives each missing one empty and children see what they did.
  if (os === 'win32')
    for (const key of LIBUV_REQUIRED_KEYS)
      if (!names.includes(key)) copy[key] = '';
  return { environment: copy, window };
}

/**
 * The file a Windows start runs, as libuv's spawn picks it for a path with a
 * directory: the name itself when it has an extension, then `.com`, then
 * `.exe`. Batch files are refused, as Node refuses them without a shell,
 * trailing dots and spaces included, which CreateProcessW drops.
 */
function windowsApplication(
  executable: string,
  isFile: (file: string) => boolean,
): string {
  const start = Math.max(
    ...['\\', '/', ':'].map((c) => executable.lastIndexOf(c)),
  );
  const found = candidatesIn(
    'win32',
    executable.slice(0, start + 1),
    executable.slice(start + 1),
  ).find(isFile);
  if (!found || /\.(?:bat|cmd)[\s.]*$/i.test(found))
    throw fail('failed_precondition', NOT_STARTED);
  return found;
}

function classify(
  os: PlatformOperatingSystem,
  cancelled: boolean,
  code: number | null,
  signal: string | null,
): PlatformExecutionOutcome['kind'] {
  if (cancelled) return 'cancelled';
  if (signal !== null) return 'crashed';
  if (os === 'win32' && code !== null && code >>> 0 >= NTSTATUS_ERROR)
    return 'crashed';
  return 'exited';
}

/** Reports the root's exit, or that it can no longer be observed. */
type ExitWatch = (
  exited: (code: number | null, signal: string | null) => void,
  lost: () => void,
) => void;

/**
 * Execution children with stdio pipes, credit-metered output and owned
 * process trees: a detached process group on darwin and linux, and on win32
 * a kill-on-close job that forbids breakaway, held by the owned-child addon
 * at `nativePath` with the same custody and stop path as daemon roots. A
 * win32 child is created suspended inside its job, with stdio over named
 * pipes this process connects to, and runs only once they are connected. The
 * addon loads before the first win32 start; without it, or without its
 * `launch` method, starts fail with `capability_unavailable`. Trees still
 * owned when the host exits are force-stopped synchronously.
 */
export function createExecutionProcessServices(
  options: {
    readonly os: PlatformOperatingSystem;
    /** win32 only: the owned-child addon, fully qualified. */
    readonly nativePath?: string;
    /** win32 only: share a host's lazy addon load, not its per-child jobs. */
    readonly windowsLauncher?: JobLauncher;
  },
  operations: Partial<ExecutionProcessOperations> = {},
): PlatformExecutionProcessServices {
  const { os, nativePath } = options;
  const ops: ExecutionProcessOperations = {
    ...DEFAULT_OPERATIONS,
    ...operations,
  };
  const childOptions = createChildServices(os).childProcessOptions({
    lifetime: 'owned',
  });
  const custody = createExitCustody();
  const launcher =
    os === 'win32'
      ? (options.windowsLauncher ??
        (nativePath !== undefined
          ? createJobLauncher({ os, nativePath })
          : undefined))
      : undefined;
  /** Trees whose custody has not ended, for shutdown. */
  const live = new Set<(mode: PlatformStopMode) => Promise<void>>();
  let closing = false;
  let startupCleanupUnconfirmed = false;

  function begin(
    request: PlatformExecutionRequest,
  ): Promise<PlatformExecutionProcess> {
    if (closing) throw fail('failed_precondition', CLOSED);
    const validated = validate(os, request);
    if (os === 'win32') return beginWindows(request, validated);
    const { environment, window } = validated;
    let child: ChildProcess;
    try {
      child = ops.spawn(request.executable, request.args, {
        ...childOptions,
        cwd: request.cwd,
        env: environment,
        stdio: [request.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw fail(
        'failed_precondition',
        NOT_STARTED,
        spawnFailureDetails(error),
      );
    }
    const { pid, stdout, stderr, stdin } = child;
    return new Promise((resolve, reject) => {
      if (pid === undefined || !stdout || !stderr) {
        // libuv reports the failure as 'error' on a later turn.
        child.once('error', (error) =>
          reject(
            fail(
              'failed_precondition',
              NOT_STARTED,
              spawnFailureDetails(error),
            ),
          ),
        );
        return;
      }
      // A started child reports failures (a refused signal) here; its exit decides.
      child.on('error', () => undefined);
      // Tracked at once, so a shutdown before 'spawn' still stops the tree.
      const tracked = track({
        watch: (exited) => child.once('exit', exited),
        pid,
        tree: groupCustody(pid, custody, ops),
        request,
        window,
        stdout,
        stderr,
        stdin,
      });
      child.once('spawn', () => resolve(tracked));
    });
  }

  /**
   * Launched suspended inside its job, so nothing it starts escapes the job;
   * it runs once this process is the client of each stdio pipe. A shutdown
   * meanwhile stops it before it ever ran, and the start fails.
   */
  function beginWindows(
    request: PlatformExecutionRequest,
    { environment, window }: Validated,
  ): Promise<PlatformExecutionProcess> {
    if (!launcher) throw fail('capability_unavailable', UNSUPPORTED);
    let launched: LaunchedTree;
    try {
      // Loads the addon before anything starts, so a missing one starts nothing.
      launcher.ready();
      launched = launcher.launch({
        executable: windowsApplication(request.executable, ops.isFile),
        argv: [request.executable, ...request.args],
        cwd: request.cwd,
        environment,
        stdin: request.stdin === 'pipe',
      });
    } catch (error) {
      const failure = translated(error);
      // No handle was delivered; the launcher retains native records until host exit.
      if (failure.code === 'unavailable') startupCleanupUnconfirmed = true;
      throw failure;
    }
    // Held by shutdown until the child is tracked or confirmed stopped.
    const pending = (): Promise<void> => launched.stop();
    live.add(pending);
    const { pipes } = launched;
    const paths = [pipes.stdout, pipes.stderr, pipes.stdin];
    return Promise.allSettled(
      paths.map((pipe, index) =>
        pipe === null ? Promise.resolve(null) : ops.connect(pipe, index === 2),
      ),
    ).then((results) => {
      const streams = results.map((result) =>
        result.status === 'fulfilled' ? result.value : null,
      );
      const [stdout, stderr, stdin] = streams;
      try {
        if (!stdout || !stderr || (pipes.stdin !== null && !stdin))
          throw fail('failed_precondition', NOT_STARTED);
        if (closing) throw fail('failed_precondition', CLOSED);
        launched.resume();
      } catch (error) {
        for (const stream of streams) stream?.destroy();
        return launched.stop().then(
          () => {
            live.delete(pending);
            return Promise.reject(translated(error));
          },
          () => Promise.reject(fail('unavailable', UNCONFIRMED)),
        );
      }
      live.delete(pending);
      return track({
        watch: (exited, lost) =>
          void launched.exited.then(
            ({ code, signal }) => exited(code, signal),
            lost,
          ),
        pid: launched.pid,
        tree: jobCustody(launched),
        request,
        window,
        stdout,
        stderr,
        stdin,
      });
    });
  }

  function track(started: {
    readonly watch: ExitWatch;
    readonly pid: number;
    readonly tree: TreeCustody;
    readonly request: PlatformExecutionRequest;
    readonly window: number;
    readonly stdout: Readable;
    readonly stderr: Readable;
    readonly stdin: Writable | null;
  }): PlatformExecutionProcess {
    const { watch, pid, tree, request, window } = started;
    let exit: { code: number | null; signal: string | null } | undefined;
    let cancelled = false;
    let settled = false;
    let released = false;
    let survivors: ReturnType<typeof setInterval> | undefined;
    let settleOutcome: (outcome: PlatformExecutionOutcome) => void = () =>
      undefined;
    const outcome = new Promise<PlatformExecutionOutcome>((resolve) => {
      settleOutcome = resolve;
    });

    const stdout = new CreditedOutput(started.stdout, window, () => check());
    const stderr = new CreditedOutput(started.stderr, window, () => check());
    if (request.stderr === 'discard') stderr.drain();
    const stdin = started.stdin ? new PipeInput(started.stdin) : null;

    const stop = (mode: PlatformStopMode): Promise<void> => terminate({ mode });
    live.add(stop);

    // Shutdown reaches a child until its tree is gone and its outcome settled.
    const retire = (): void => {
      if (released && settled && !tree.lapsed) live.delete(stop);
    };
    const endCustody = (): void => {
      released = true;
      if (survivors) clearInterval(survivors);
      survivors = undefined;
      retire();
    };
    const settle = (): boolean => {
      if (released) return !tree.lapsed;
      try {
        if (tree.settle()) endCustody();
      } catch {
        // Ownership could not be observed; a stop request reports it.
      }
      return released && !tree.lapsed;
    };

    function finish(result: PlatformExecutionOutcome): void {
      if (settled) return;
      settled = true;
      stdout.close();
      stderr.close();
      stdin?.close();
      retire();
      settleOutcome(Object.freeze(result));
    }

    function check(): void {
      if (settled || !exit || !stdout.settled || !stderr.settled) return;
      finish({
        kind: classify(os, cancelled, exit.code, exit.signal),
        code: exit.code,
        signal: exit.signal,
        output: stdout.lost || stderr.lost ? 'discarded' : 'complete',
      });
    }

    watch(
      (code, signal) => {
        exit = { code, signal };
        const empty = settle();
        try {
          ops.onRootTreeEmpty?.(empty, {
            kind: classify(os, cancelled, code, signal),
            code,
            signal,
          });
        } catch {
          // Evidence observers do not change process custody or results.
        }
        // Survivors of the root keep custody; check until they are gone.
        if (!released) {
          survivors = setInterval(settle, ops.survivorPollMs);
          survivors.unref();
        }
        check();
      },
      () => {
        stdout.discard();
        stderr.discard();
        finish({ kind: 'lost', code: null, signal: null, output: 'discarded' });
      },
    );

    function terminate(options?: {
      readonly mode?: PlatformStopMode;
      readonly signal?: AbortSignal;
      readonly keepOutput?: boolean;
    }): Promise<void> {
      const mode = options?.mode ?? 'graceful';
      const signal = options?.signal;
      if (mode !== 'graceful' && mode !== 'force')
        return Promise.reject(fail('invalid_argument', INVALID));
      if (signal?.aborted)
        return Promise.resolve().then(() => signal.throwIfAborted());
      if (!exit) cancelled = true;
      if (options?.keepOutput !== true) {
        stdout.discard();
        stderr.discard();
      }
      if (released)
        return tree.lapsed
          ? Promise.reject(fail('unavailable', UNCONFIRMED))
          : Promise.resolve();
      // Concurrent callers share the custody's one attempt.
      const attempt = tree.stop(mode).then(endCustody, (error: unknown) => {
        // No observed exit: the terminal outcome is that cleanup failed.
        if (!exit)
          finish({
            kind: 'lost',
            code: null,
            signal: null,
            output: 'discarded',
          });
        throw translated(error);
      });
      return bounded(attempt, signal);
    }

    return Object.freeze({
      pid,
      stdin,
      stdout,
      stderr: request.stderr === 'discard' ? null : stderr,
      outcome,
      terminate,
    });
  }

  return Object.freeze({
    start: (request: PlatformExecutionRequest) =>
      new Promise<PlatformExecutionProcess>((resolve) =>
        resolve(begin(request)),
      ),
    async shutdown(options?: { readonly signal?: AbortSignal }): Promise<void> {
      options?.signal?.throwIfAborted();
      closing = true;
      const stops = Promise.allSettled(
        Array.from(live, (stop) => stop('force')),
      ).then((results) => {
        if (
          startupCleanupUnconfirmed ||
          results.some((result) => result.status === 'rejected')
        )
          throw fail('unavailable', UNCONFIRMED);
      });
      await bounded(stops, options?.signal);
    },
  });
}
