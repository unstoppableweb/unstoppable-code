import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  PlatformOperatingSystem,
  PlatformExecutionProcessServices,
  PlatformExecutionOutput,
} from '@canopy/core-runtime';
import { createChildServices } from '../supervision/child';
import {
  createExecutionProcessServices,
  ExecutionProcessError,
  type ExecutionProcessOperations,
  type ExecutionProcessRootExit,
} from '../supervision/execution-process';
import { killProcessTree } from '../supervision/kill-tree';
import { createJobLauncher } from '../supervision/owned-child';
import {
  captureWindowsClosureContext,
  observeWindowsClosure,
} from '../supervision/windows-closure';
import {
  NODE_SUPERVISION,
  type SupervisionOperations,
} from '../supervision/shared';
import {
  dischargesFsmonitor,
  executableIdentity,
  GitReadError,
  type GitReadCommand,
  type GitReadEnvironment,
  type GitReadPlan,
  isHostAbsolute,
  isRepositoryCommand,
  planGitReadCommand,
  readsWorkingTree,
  searchPath,
  type SelectedGit,
  validateEnvironment,
  windowsChildEnvironment,
  windowsEnvironmentValue,
} from './commands';
import {
  type ExecutableProbe,
  nodeExecutableProbe,
  resolveBareCommand,
} from './resolve';

export interface GitReadTiming {
  /** Window for held pipes to close after the root exits. */
  readonly drainMs: number;
  /** Time kept before the request deadline to stop, reap and drain. */
  readonly cleanupReserveMs: number;
  /** Graceful stops escalate to a forced group kill after this delay. */
  readonly escalateMs: number;
  /** One deadline across every `check-ignore` chunk (desktop git.ts:84). */
  readonly requestDeadlineMs: number;
}

const DEFAULT_TIMING: GitReadTiming = {
  drainMs: 250,
  cleanupReserveMs: 2_000,
  escalateMs: 1_000,
  requestDeadlineMs: 30_000,
};
const CHECK_IGNORE_CHUNK_SIZE = 5_000;
// setTimeout overflows above this; longer waits re-arm.
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface GitReadRunnerOptions {
  readonly os: PlatformOperatingSystem;
  /**
   * The staged CAN-5140 addon that holds Windows repository commands in jobs.
   * A command its launch does not start runs uncontained through Node spawn.
   */
  readonly nativePath?: string;
  /** Host-only custody seam; production always creates native job services. */
  readonly createWindowsProcesses?: (
    onRootTreeEmpty: NonNullable<ExecutionProcessOperations['onRootTreeEmpty']>,
  ) => PlatformExecutionProcessServices;
  /** Aborting it stops every in-flight request and refuses new ones. */
  readonly hostSignal?: AbortSignal;
  /** Test seams; production uses NODE_SUPERVISION. */
  readonly operations?: Partial<SupervisionOperations>;
  readonly timing?: Partial<GitReadTiming>;
  /** Test seam for the bare-init scratch directory. */
  readonly scratch?: Partial<ScratchOperations>;
  /** Test seam for PATH resolution of a bare command. */
  readonly isExecutable?: ExecutableProbe;
  /**
   * Test seam: `executableIdentity` of the file now at `file`, `undefined`
   * when it cannot be read. Synchronous, so nothing runs between the checks
   * and the spawn they bracket.
   */
  readonly imageIdentity?: (file: string) => string | undefined;
  /** A failed scratch removal; it never replaces the request's result. */
  readonly onScratchCleanupFailure?: (error: unknown) => void;
  /**
   * A group kill still running when its request settled
   * (`cleanup_unconfirmed`), and its failure after that (`failed`). Neither
   * changes the settled request.
   */
  readonly onKillCleanup?: (outcome: 'failed' | 'cleanup_unconfirmed') => void;
}

export interface ScratchOperations {
  create(prefix: string): Promise<string>;
  remove(directory: string): Promise<void>;
}

const NODE_SCRATCH: ScratchOperations = {
  create: (prefix) => mkdtemp(prefix),
  remove: (directory) => rm(directory, { recursive: true, force: true }),
};

export interface GitReadRequest {
  /** Every command runs in an explicit directory. */
  readonly cwd: string;
  readonly environment: GitReadEnvironment;
  /** Monotonic `performance.now()` time by which the request settles. */
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
}

export interface GitReadOutput {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** `abandoned`: a group member still held a pipe after the drain window. */
  readonly pipes: 'closed' | 'abandoned';
}

export interface GitCheckIgnoreSelection {
  readonly cwd: string;
  readonly paths: readonly string[];
  readonly environment: GitReadEnvironment;
  /** Monotonic; set before the first selection and shared by every chunk. */
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  /**
   * The executable for chunk `chunk` (0-based), awaited before that chunk
   * runs. While it is awaited, a request or host abort, or the cleanup
   * reserve, aborts its signal and rejects the request. A bare path carries
   * no version, so its Win32 plan gets no fsmonitor discharge.
   */
  readonly executableForChunk: (
    chunk: number,
    signal: AbortSignal,
    deadlineAt: number,
  ) => Promise<string | SelectedGit>;
  /**
   * Chunk `chunk`'s `check-ignore` process started with `started`, its
   * selected executable and version. Not called when the chunk is aborted,
   * fails planning or fails to spawn before then. A throw is ignored.
   */
  readonly onChunkStarted?: (chunk: number, started: SelectedGit) => void;
}

export interface GitIgnoredListingSelection {
  readonly cwd: string;
  readonly environment: GitReadEnvironment;
  /** Monotonic; set before the selection and shared with the listing. */
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  /**
   * The executable, awaited before the listing runs, under the same abort
   * and cleanup-reserve rules as a `check-ignore` chunk's selection.
   */
  readonly selectExecutable: (
    signal: AbortSignal,
    deadlineAt: number,
  ) => Promise<string | SelectedGit>;
  /** The listing's process started with `started`. A throw is ignored. */
  readonly onStarted?: (started: SelectedGit) => void;
}

export interface GitReadRunner {
  run(command: GitReadCommand, request: GitReadRequest): Promise<GitReadOutput>;
  /**
   * Desktop `checkIgnoredPaths`: sequential 5,000-path chunks; exit 1 is an
   * empty chunk; any other failure rejects and discards earlier chunks.
   */
  checkIgnoredPathsWith(
    executable: string | SelectedGit,
    cwd: string,
    paths: readonly string[],
    environment: GitReadEnvironment,
    signal?: AbortSignal,
  ): Promise<Set<string>>;
  /** `checkIgnoredPathsWith`, selecting the executable before each chunk. */
  checkIgnoredPathsSelected(
    request: GitCheckIgnoreSelection,
  ): Promise<Set<string>>;
  /**
   * Desktop `listIgnoredPathEntries`: one `ls-files` listing; any exit but
   * 0 rejects, as desktop's execFile did.
   */
  listIgnoredPathsSelected(
    request: GitIgnoredListingSelection,
  ): Promise<string[]>;
  /**
   * `idle` once no request is in flight and no owned root (until its 'close'),
   * continuing kill or scratch creation or removal remains; `pending` if
   * `signal` aborts first.
   */
  whenIdle(signal: AbortSignal): Promise<'idle' | 'pending'>;
}

type Settlement =
  | { readonly output: GitReadOutput }
  | { readonly error: unknown };

type Waited<T> =
  | { readonly value: T }
  | { readonly error: unknown }
  | { readonly aborted: unknown }
  | { readonly expired: true };

/** Runs `run` at monotonic time `at`; returns a cancel function. */
function timerAt(at: number, run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const wait = at - performance.now();
    timer = setTimeout(
      () => (wait > MAX_TIMER_MS ? arm() : run()),
      Math.min(Math.max(0, wait), MAX_TIMER_MS),
    );
  };
  arm();
  return () => clearTimeout(timer);
}

/** Counts outstanding work; `whenIdle` waits for none to remain. */
function createActivity(): {
  begin(): () => void;
  track<T>(work: Promise<T>): Promise<T>;
  whenIdle(signal: AbortSignal): Promise<'idle' | 'pending'>;
} {
  let outstanding = 0;
  const waiters = new Set<() => void>();
  function begin(): () => void {
    outstanding += 1;
    let ended = false;
    return (): void => {
      if (ended) return;
      ended = true;
      outstanding -= 1;
      if (outstanding === 0) waiters.forEach((wake) => wake());
    };
  }
  function track<T>(work: Promise<T>): Promise<T> {
    const end = begin();
    work.then(end, end);
    return work;
  }
  function whenIdle(signal: AbortSignal): Promise<'idle' | 'pending'> {
    return new Promise((settle) => {
      if (outstanding === 0) return settle('idle');
      if (signal.aborted) return settle('pending');
      const finish = (state: 'idle' | 'pending'): void => {
        waiters.delete(wake);
        signal.removeEventListener('abort', abort);
        settle(state);
      };
      const wake = (): void => finish('idle');
      const abort = (): void => finish('pending');
      waiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  return { begin, track, whenIdle };
}

/** Desktop's execFile `maxBuffer`: bytes of the UTF-8-decoded chunks, per stream. */
class StreamCapture {
  private readonly decoder = new StringDecoder('utf8');
  private readonly chunks: string[] = [];
  private bytes = 0;
  overflowed = false;

  constructor(private readonly limit: number) {}

  /** Returns true when this chunk first crosses the limit. */
  write(chunk: Buffer): boolean {
    return this.add(this.decoder.write(chunk));
  }

  end(): boolean {
    return this.add(this.decoder.end());
  }

  text(): string {
    return this.chunks.join('');
  }

  private add(text: string): boolean {
    if (text === '' || this.overflowed) return false;
    this.bytes += Buffer.byteLength(text, 'utf8');
    if (this.bytes > this.limit) return (this.overflowed = true);
    this.chunks.push(text);
    return false;
  }
}

/**
 * Planning validates `executable`; anything but a string version or identity
 * is none.
 */
function versioned(selected: string | SelectedGit): SelectedGit {
  if (typeof selected !== 'object' || selected === null)
    return { executable: selected, version: undefined };
  const { executable, version, identity } = selected;
  return {
    executable,
    version: typeof version === 'string' ? version : undefined,
    ...(typeof identity === 'string' ? { identity } : {}),
  };
}

function nodeImageIdentity(file: string): string | undefined {
  try {
    return executableIdentity(statSync(file));
  } catch {
    return undefined;
  }
}

/**
 * taskkill's SystemRoot comes from the child's environment, never ambient
 * state, and is the variant the child sees.
 */
export function supervisionFor(
  environment: GitReadEnvironment,
  overrides?: Partial<SupervisionOperations>,
): SupervisionOperations {
  const systemRoot = (): string =>
    windowsEnvironmentValue(environment, 'SystemRoot') ?? '';
  return { ...NODE_SUPERVISION, systemRoot, ...overrides };
}

export function createGitReadRunner(
  options: GitReadRunnerOptions,
): GitReadRunner {
  const { os, hostSignal } = options;
  const checkClosureContext =
    os === 'win32' ? captureWindowsClosureContext() : undefined;
  const timing: GitReadTiming = { ...DEFAULT_TIMING, ...options.timing };
  const scratch: ScratchOperations = { ...NODE_SCRATCH, ...options.scratch };
  const isExecutable = options.isExecutable ?? nodeExecutableProbe(os);
  const imageIdentity = options.imageIdentity ?? nodeImageIdentity;
  const imageIs = (file: string, identity: string | undefined): boolean =>
    identity !== undefined && imageIdentity(file) === identity;
  const childOptions = createChildServices(os).childProcessOptions({
    lifetime: 'owned',
  });
  const activity = createActivity();
  // The addon owns native instances until host exit; reuse its lazy load across reads.
  const windowsLauncher =
    os === 'win32' && options.nativePath !== undefined
      ? createJobLauncher({ os, nativePath: options.nativePath })
      : undefined;

  function reportKill(outcome: 'failed' | 'cleanup_unconfirmed'): void {
    try {
      options.onKillCleanup?.(outcome);
    } catch {
      // A failing reporter must not change the request or surface as unhandled.
    }
  }

  function signalsOf(request: GitReadRequest): AbortSignal[] {
    return [request.signal, hostSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
  }

  /**
   * Settles once; abort reasons are arbitrary values, so failures resolve
   * too. `identity`: the check-ignore image its version was parsed from.
   */
  function execute(
    kind: GitReadCommand['kind'],
    plan: GitReadPlan,
    request: GitReadRequest,
    identity?: string,
    onSpawned?: () => void,
  ): Promise<Settlement> {
    return new Promise((settle) => {
      const reject = (error: unknown): void => settle({ error });
      const signals = signalsOf(request);
      const preAborted = signals.find((signal) => signal.aborted);
      if (preAborted) return reject(preAborted.reason);
      const startedAt = performance.now();
      const stopBy = request.deadlineAt - timing.cleanupReserveMs;
      if (stopBy <= startedAt)
        return reject(new GitReadError('deadline_exceeded'));
      const probeLimited =
        plan.timeoutMs !== undefined && startedAt + plan.timeoutMs <= stopBy;

      const closure = os === 'win32' ? observeWindowsClosure('git') : undefined;
      // A Windows repository read spawns here only when no job holds it.
      if (isRepositoryCommand(kind)) closure?.unsafe();
      // check-ignore may start an fsmonitor daemon that outlives it (E3)
      // unless its plan carries the discharge, which planning adds only for
      // an audited Git for Windows version. That version vouches only for
      // the file validation stat'ed, so the file's identity must hold on both
      // sides of the spawn. Node cannot hold the image against replacement:
      // a swap undone between the two checks stays unseen, as does a swap of
      // an image the file starts (Git for Windows' cmd\git.exe launcher).
      const discharged =
        closure !== undefined && readsWorkingTree(kind)
          ? dischargesFsmonitor(plan.args) && imageIs(plan.file, identity)
          : undefined;
      if (discharged === false) closure?.unsafe();
      let child: ChildProcess;
      try {
        child = spawn(plan.file, [...plan.args], {
          ...childOptions,
          cwd: request.cwd,
          env: plan.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        closure?.unsafe();
        closure?.close();
        return reject(error);
      }
      if (discharged && !imageIs(plan.file, identity)) closure?.unsafe();
      // Outstanding until 'close', which follows 'exit' or a spawn 'error', so
      // idle means its edge closed. An unconfirmed root outlives settlement.
      const rootEnded = activity.begin();
      // Node emits 'spawn' only for a process that started; else 'error'.
      if (onSpawned)
        child.once('spawn', () => {
          try {
            onSpawned();
          } catch {
            // A failing observer must not change the request.
          }
        });
      child.once('close', (code, signal) => {
        if (signal !== null || code === null || code === 259) closure?.unsafe();
        closure?.close();
        rootEnded();
      });

      const ops = supervisionFor(plan.env, options.operations);
      const stdout = new StreamCapture(plan.maxBuffer);
      const stderr = new StreamCapture(plan.maxBuffer);
      const timers = new Set<ReturnType<typeof setTimeout>>();
      let settled = false;
      let pipesClosed = false;
      let exit: { code: number | null; signal: string | null } | undefined;
      let spawnError: unknown;
      // The first failure or abort decides the result; later ones are dropped.
      let cause: { readonly error: unknown } | undefined;
      let aborted = false;
      let killFailure: unknown;
      let stopping = false;
      let cleanupEnd = request.deadlineAt;
      let cleanupExpired = false;
      let killsInFlight = 0;
      let finishPending = false;

      const after = (at: number, run: () => void): void => {
        const wait = at - performance.now();
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            if (wait > MAX_TIMER_MS) after(at, run);
            else run();
          },
          Math.min(Math.max(0, wait), MAX_TIMER_MS),
        );
        timers.add(timer);
      };

      const finish = (): void => {
        if (settled) return;
        // Windows taskkill is asynchronous: settle after it, within the
        // reserve. One still running then continues within the port's bound.
        if (killsInFlight > 0 && !cleanupExpired) {
          finishPending = true;
          return;
        }
        settled = true;
        if (!pipesClosed && spawnError === undefined) closure?.unsafe();
        for (let kill = 0; kill < killsInFlight; kill += 1)
          reportKill('cleanup_unconfirmed');
        timers.forEach(clearTimeout);
        const confirmed = exit !== undefined || spawnError !== undefined;
        if (spawnError !== undefined) cause ??= { error: spawnError };
        // stdin stays open for commands without input, as in desktop.
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        // An unconfirmed root must not keep the host alive.
        if (!confirmed) child.unref();
        const failure = killFailure ?? cause?.error;
        const output: GitReadOutput = Object.freeze({
          code: exit?.code ?? null,
          signal: exit?.signal ?? null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          pipes: pipesClosed ? 'closed' : 'abandoned',
        });
        // A confirmed root closes once its pipes are destroyed. Settling at
        // 'close' keeps the runner idle at settlement with every edge closed;
        // an abort until then still rejects a success.
        const deliver = (): void => {
          listeners.forEach(([signal, listener]) =>
            signal.removeEventListener('abort', listener),
          );
          if (!confirmed)
            reject(new GitReadError('cleanup_unconfirmed', { failure }));
          else if (cause) reject(cause.error);
          else settle({ output });
        };
        if (!confirmed || pipesClosed) deliver();
        else child.once('close', deliver);
      };

      // Only from a timer or setImmediate turn: never an exit/close listener
      // or a continuation of one, where a reaped root still reads as live.
      const signalGroup = (mode: 'graceful' | 'force'): void => {
        if (settled || child.exitCode !== null || child.signalCode !== null)
          return;
        const pid = child.pid;
        if (pid === undefined) return;
        closure?.unsafe();
        killsInFlight += 1;
        const killEnded = activity.begin();
        // No signal: an aborted one would end taskkill and leave the tree.
        killProcessTree(os, { pid, mode }, ops)
          .catch((error: unknown) => {
            if (!settled) killFailure ??= error;
            else reportKill('failed');
          })
          .finally(() => {
            killsInFlight -= 1;
            killEnded();
            if (finishPending && killsInFlight === 0) finish();
          });
      };

      const stop = (): void => {
        if (stopping || settled) return;
        stopping = true;
        if (exit !== undefined) return finish();
        cleanupEnd = Math.min(
          performance.now() + timing.cleanupReserveMs,
          request.deadlineAt,
        );
        setImmediate(() => signalGroup(plan.killMode));
        // taskkill always forces on Windows.
        if (plan.killMode === 'graceful' && os !== 'win32')
          after(performance.now() + timing.escalateMs, () =>
            signalGroup('force'),
          );
        after(cleanupEnd, () => {
          cleanupExpired = true;
          finish();
        });
      };

      const fail = (error: unknown): void => {
        closure?.unsafe();
        cause ??= { error };
      };

      const listeners = signals.map((signal): [AbortSignal, () => void] => [
        signal,
        (): void => {
          aborted = true;
          fail(signal.reason);
          stop();
        },
      ]);
      listeners.forEach(([signal, listener]) =>
        signal.addEventListener('abort', listener, { once: true }),
      );

      const capture = (
        stream: NodeJS.ReadableStream | null,
        sink: StreamCapture,
        name: 'stdout' | 'stderr',
      ): void => {
        const overflow = (crossed: boolean): void => {
          if (!crossed) return;
          fail(new GitReadError('output_limit', { stream: name }));
          stop();
        };
        stream?.on('data', (chunk: Buffer) => overflow(sink.write(chunk)));
        stream?.on('end', () => overflow(sink.end()));
        // Destroyed or failed pipes end the capture; exit decides the result.
        stream?.on('error', () => undefined);
      };
      capture(child.stdout, stdout, 'stdout');
      capture(child.stderr, stderr, 'stderr');

      // A stdin failure before the pipes close wins and settles promptly, as
      // desktop's EPIPE does; a root still reading nothing is stopped.
      child.stdin?.on('error', (error) => {
        if (pipesClosed || settled) return;
        fail(error);
        stop();
      });
      // An empty write to a root that already closed stdin fails with EPIPE
      // though nothing was lost, so empty input only ends the stream.
      if (plan.input?.byteLength) child.stdin?.end(plan.input);
      else if (plan.input) child.stdin?.end();

      child.on('error', (error) => {
        if (child.pid !== undefined) return;
        // A discarded probe stays unsafe: its spawn-failure close is negative.
        closure?.unsafe();
        spawnError = error;
        finish();
      });
      child.once('exit', (code, signal) => {
        exit = { code, signal };
        if (aborted) return finish();
        // Group members left running after a normal exit stay alone.
        const drainEnd = Math.min(
          performance.now() + timing.drainMs,
          stopping ? cleanupEnd : request.deadlineAt,
        );
        after(drainEnd, finish);
      });
      child.once('close', () => {
        pipesClosed = true;
        if (exit !== undefined) finish();
      });

      // Once the root has exited, only the drain window remains.
      const expire = (code: 'timeout' | 'deadline_exceeded'): void => {
        if (exit !== undefined) return;
        fail(new GitReadError(code));
        stop();
      };
      after(stopBy, () => expire('deadline_exceeded'));
      if (probeLimited && plan.timeoutMs !== undefined)
        after(startedAt + plan.timeoutMs, () => expire('timeout'));
    });
  }

  function validateRequest(request: GitReadRequest): GitReadEnvironment {
    if (
      typeof request.cwd !== 'string' ||
      !isHostAbsolute(os, request.cwd) ||
      typeof request.deadlineAt !== 'number' ||
      !Number.isFinite(request.deadlineAt)
    )
      throw new GitReadError('invalid_request');
    return validateEnvironment(request.environment);
  }

  /**
   * Resolves a bare command through the supplied PATH by the request's stop
   * time, unless aborted. Nothing has started, so nothing needs cleanup.
   */
  async function resolved(
    plan: GitReadPlan,
    request: GitReadRequest,
  ): Promise<GitReadPlan> {
    if (isHostAbsolute(os, plan.file)) return plan;
    const signals = signalsOf(request);
    signals.forEach((signal) => signal.throwIfAborted());
    const stopBy = request.deadlineAt - timing.cleanupReserveMs;
    if (stopBy <= performance.now())
      throw new GitReadError('deadline_exceeded');
    const lookup = resolveBareCommand(
      os,
      plan.file,
      searchPath(os, plan.env),
      isExecutable,
    );
    const found = await waitWithin(lookup, stopBy, signals);
    if ('aborted' in found) throw found.aborted;
    if ('expired' in found) throw new GitReadError('deadline_exceeded');
    if ('error' in found) throw found.error;
    if (found.value === undefined) throw new GitReadError('command_not_found');
    return Object.freeze({ ...plan, file: found.value });
  }

  async function outputOf(work: Promise<Settlement>): Promise<GitReadOutput> {
    const settlement = await work;
    if ('error' in settlement) throw settlement.error;
    return settlement.output;
  }

  /**
   * Repository helpers stay in an uncommitted, no-breakaway Windows job. A
   * launch that does not start the command (no addon, or a job, pipe or
   * process creation failure) runs it uncontained, as desktop's execFile did,
   * rather than refusing the read; its closure evidence is then unsafe.
   */
  async function executeWindowsRepository(
    kind: GitReadCommand['kind'],
    plan: GitReadPlan,
    request: GitReadRequest,
  ): Promise<GitReadOutput> {
    const signals = signalsOf(request);
    signals.forEach((signal) => signal.throwIfAborted());
    const startedAt = performance.now();
    const stopBy = request.deadlineAt - timing.cleanupReserveMs;
    if (stopBy <= startedAt) throw new GitReadError('deadline_exceeded');
    // POSIX registers the request timer first, so it wins an exact tie.
    const probeLimited =
      plan.timeoutMs !== undefined && startedAt + plan.timeoutMs < stopBy;
    const closure = observeWindowsClosure('git');
    const custodyEnded = activity.begin();
    let recordExit: (exit: ExecutionProcessRootExit) => void = () => undefined;
    const rootExited = new Promise<ExecutionProcessRootExit>((resolve) => {
      recordExit = resolve;
    });
    const observe = (empty: boolean, exit: ExecutionProcessRootExit): void => {
      // Even successful later cleanup cannot upgrade a surviving helper's evidence.
      if (!empty) closure?.unsafe();
      recordExit(exit);
    };
    const processes =
      options.createWindowsProcesses?.(observe) ??
      createExecutionProcessServices(
        { os: 'win32', nativePath: options.nativePath, windowsLauncher },
        { onRootTreeEmpty: observe },
      );
    const stdout = new StreamCapture(plan.maxBuffer);
    const stderr = new StreamCapture(plan.maxBuffer);
    const capture = async (
      stream: PlatformExecutionOutput | null,
      sink: StreamCapture,
      name: 'stdout' | 'stderr',
    ): Promise<void> => {
      if (!stream) return;
      for (;;) {
        const chunk = await stream.read();
        if (chunk === null) {
          if (sink.end())
            throw new GitReadError('output_limit', { stream: name });
          return;
        }
        const overflow = sink.write(Buffer.from(chunk));
        stream.acknowledge(chunk.byteLength);
        if (overflow) throw new GitReadError('output_limit', { stream: name });
      }
    };
    type CapturedRoot = {
      readonly outcome: ExecutionProcessRootExit;
      readonly captured: Promise<void>;
    };
    type NotStarted = { readonly notStarted: ExecutionProcessError };
    const running = activity.track(
      processes
        .start({
          executable: plan.file,
          args: plan.args,
          cwd: request.cwd,
          environment: plan.env,
          stdin: 'ignore',
        })
        .then(
          async (child): Promise<CapturedRoot> => {
            const captured = activity.track(
              Promise.all([
                capture(child.stdout, stdout, 'stdout'),
                capture(child.stderr, stderr, 'stderr'),
              ]).then(() => undefined),
            );
            // The execution outcome itself waits for credited output, not just exit.
            const completed = child.outcome.then(
              (outcome): ExecutionProcessRootExit => {
                if (outcome.kind === 'lost' || outcome.output !== 'complete') {
                  closure?.unsafe();
                  throw new GitReadError('cleanup_unconfirmed');
                }
                return outcome;
              },
            );
            const outcome = await Promise.race([
              rootExited,
              completed,
              captured.then(() => rootExited),
            ]);
            if (
              outcome.kind !== 'exited' ||
              outcome.code === null ||
              outcome.code === 259
            )
              closure?.unsafe();
            return { outcome, captured };
          },
          // Every typed start failure, a refused request shape included,
          // precedes the child's resume: nothing ran.
          (error: unknown): NotStarted => {
            if (error instanceof ExecutionProcessError)
              return { notStarted: error };
            throw error;
          },
        ),
    );
    const probeEnd =
      plan.timeoutMs === undefined ? stopBy : startedAt + plan.timeoutMs;
    const exited = await waitWithin(
      running,
      Math.min(stopBy, probeEnd),
      signals,
    );
    let result: Waited<GitReadOutput | NotStarted>;
    if (!('value' in exited)) result = exited;
    else if ('notStarted' in exited.value) {
      closure?.unsafe();
      result = { value: exited.value };
    } else {
      const root = exited.value;
      // Like POSIX, exit ends the command cap; only the drain window remains.
      const drained = await waitWithin(
        root.captured,
        Math.min(performance.now() + timing.drainMs, request.deadlineAt),
        signals,
      );
      if ('value' in drained || 'expired' in drained) {
        const pipes = 'value' in drained ? 'closed' : 'abandoned';
        if (pipes === 'abandoned') closure?.unsafe();
        result = {
          value: Object.freeze({
            code: root.outcome.code,
            signal: root.outcome.signal,
            stdout: stdout.text(),
            stderr: stderr.text(),
            pipes,
          }),
        };
      } else result = drained;
    }
    const failure =
      'aborted' in result
        ? result.aborted
        : 'expired' in result
          ? new GitReadError(probeLimited ? 'timeout' : 'deadline_exceeded')
          : 'error' in result
            ? result.error
            : undefined;
    if (!('value' in result)) closure?.unsafe();
    let cleanupAbort: { readonly reason: unknown } | undefined;
    const listeners = signals.map((signal): [AbortSignal, () => void] => [
      signal,
      (): void => {
        closure?.unsafe();
        cleanupAbort ??= { reason: signal.reason };
      },
    ]);
    listeners.forEach(([signal, listener]) => {
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    });
    // Always stop, including after root exit: closed pipes are not tree closure.
    const cleanup = activity.track(
      processes.shutdown().then(
        () => {
          custodyEnded();
          closure?.close();
        },
        (error: unknown) => {
          closure?.unsafe();
          // Failed proof latches non-idle; only host exit can discharge lost custody.
          reportKill('failed');
          throw error;
        },
      ),
    );
    const cleaned = await waitWithin(
      cleanup,
      Math.min(request.deadlineAt, performance.now() + timing.cleanupReserveMs),
      [],
    );
    listeners.forEach(([signal, listener]) =>
      signal.removeEventListener('abort', listener),
    );
    const confirmed = 'value' in cleaned;
    if (!confirmed) {
      closure?.unsafe();
      reportKill('cleanup_unconfirmed');
    }
    if ('value' in result) {
      const { value } = result;
      if ('notStarted' in value) {
        if (cleanupAbort) throw cleanupAbort.reason;
        // Unconfirmed launch records keep the runner non-idle; the read still runs.
        return outputOf(
          execute(
            kind,
            // NUL stdin, as in the job: end the pipe at once.
            { ...plan, input: plan.input ?? new Uint8Array() },
            request,
          ),
        );
      }
      // An abort during cleanup still rejects a success, as on POSIX.
      if (cleanupAbort)
        throw confirmed
          ? cleanupAbort.reason
          : new GitReadError('cleanup_unconfirmed', {
              failure: 'error' in cleaned ? cleaned.error : cleanupAbort.reason,
            });
      // Git's own result stands (q-28); unconfirmed custody stays non-idle,
      // is reported above, and leaves the closure evidence unsafe.
      return value;
    }
    if (!confirmed)
      throw new GitReadError('cleanup_unconfirmed', {
        failure: 'error' in cleaned ? cleaned.error : failure,
      });
    if ('aborted' in result) throw result.aborted;
    if ('expired' in result) throw failure;
    // Failures after the start; a start failure ran uncontained above.
    if (result.error instanceof ExecutionProcessError) {
      switch (result.error.code) {
        case 'invalid_argument':
          throw new GitReadError('invalid_request');
        case 'failed_precondition':
          throw new GitReadError('command_not_found');
        case 'unavailable':
          throw new GitReadError('cleanup_unconfirmed', {
            failure: result.error,
          });
      }
    }
    throw result.error;
  }

  /** `work`'s outcome, the first abort, or expiry at `at`; `work` runs on. */
  function waitWithin<T>(
    work: Promise<T>,
    at: number,
    signals: readonly AbortSignal[],
  ): Promise<Waited<T>> {
    return new Promise((settle) => {
      const preAborted = signals.find((signal) => signal.aborted);
      if (preAborted) return settle({ aborted: preAborted.reason });
      const listeners = signals.map((signal): [AbortSignal, () => void] => [
        signal,
        (): void => finish({ aborted: signal.reason }),
      ]);
      let cancelTimer = (): void => undefined;
      let done = false;
      function finish(result: Waited<T>): void {
        if (done) return;
        done = true;
        cancelTimer();
        listeners.forEach(([signal, listener]) =>
          signal.removeEventListener('abort', listener),
        );
        settle(result);
      }
      listeners.forEach(([signal, listener]) =>
        signal.addEventListener('abort', listener, { once: true }),
      );
      cancelTimer = timerAt(at, () => finish({ expired: true }));
      work.then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
    });
  }

  /** Cleanup problems are reported, never thrown: the request's result stands. */
  function reportScratchFailure(error: unknown): void {
    try {
      options.onScratchCleanupFailure?.(error);
    } catch {
      // A failing reporter must not surface as an unhandled rejection.
    }
  }

  /** Outstanding until it settles, past the request when its bound ends first. */
  function removeScratch(directory: string): Promise<void> {
    return activity.track(
      Promise.resolve()
        .then(() => scratch.remove(directory))
        .catch(reportScratchFailure),
    );
  }

  /**
   * Waits for `removal` until `at`, reporting one still pending then as
   * `cleanup_unconfirmed`. An abort does not cut removal short; it is returned.
   */
  async function awaitRemoval(
    removal: Promise<void>,
    at: number,
    signals: readonly AbortSignal[],
  ): Promise<{ readonly aborted: unknown } | undefined> {
    const first = await waitWithin(removal, at, signals);
    const last = 'aborted' in first ? await waitWithin(removal, at, []) : first;
    if ('expired' in last)
      reportScratchFailure(new GitReadError('cleanup_unconfirmed'));
    return 'aborted' in first ? first : undefined;
  }

  /**
   * Desktop parity: the smoke writes, then removes, a scratch directory. Both
   * run under the request's deadline and abort, and removal never replaces
   * the result. Creation or removal still pending at its bound continues
   * after settlement; a late directory is removed when it appears.
   */
  async function runBareInitSmoke(
    command: Extract<GitReadCommand, { kind: 'git-bare-init-smoke' }>,
    request: GitReadRequest,
  ): Promise<GitReadOutput> {
    const { environment } = request;
    // Validates and resolves the command before anything is written.
    const { file } = await resolved(
      planGitReadCommand(os, command, environment, command.temporaryRoot),
      request,
    );
    const signals = signalsOf(request);
    signals.forEach((signal) => signal.throwIfAborted());
    const stopBy = request.deadlineAt - timing.cleanupReserveMs;
    if (stopBy <= performance.now())
      throw new GitReadError('deadline_exceeded');
    // One reserve from the first abort covers the stop and the removal.
    let abortedAt: number | undefined;
    const noteAbort = (): void => {
      abortedAt ??= performance.now();
    };
    signals.forEach((signal) =>
      signal.addEventListener('abort', noteAbort, { once: true }),
    );
    const cleanupEnd = (): number =>
      Math.min(
        (abortedAt ?? performance.now()) + timing.cleanupReserveMs,
        request.deadlineAt,
      );

    try {
      const creating = Promise.resolve().then(() =>
        scratch.create(path.join(command.temporaryRoot, 'git-validation-')),
      );
      const created = await waitWithin(creating, stopBy, signals);
      if ('error' in created) throw created.error;
      if (!('value' in created)) {
        // A late directory, and its removal, stay outstanding.
        const removal = activity.track(
          creating.then(removeScratch, () => undefined),
        );
        await awaitRemoval(removal, cleanupEnd(), []);
        throw 'aborted' in created
          ? created.aborted
          : new GitReadError('deadline_exceeded');
      }

      const directory = created.value;
      const settlement = await Promise.resolve()
        .then(() =>
          execute(
            command.kind,
            {
              ...planGitReadCommand(os, command, environment, directory),
              file,
            },
            request,
          ),
        )
        .catch((error: unknown): Settlement => ({ error }));
      // As in the drain, an abort before settlement wins over a success.
      const aborted = await awaitRemoval(
        removeScratch(directory),
        cleanupEnd(),
        signals,
      );
      if ('error' in settlement) throw settlement.error;
      if (aborted) throw aborted.aborted;
      return settlement.output;
    } finally {
      signals.forEach((signal) =>
        signal.removeEventListener('abort', noteAbort),
      );
    }
  }

  /** Outstanding from the call until it settles. */
  async function tracked<T>(work: () => Promise<T>): Promise<T> {
    checkClosureContext?.();
    const end = activity.begin();
    try {
      return await work();
    } finally {
      end();
    }
  }

  async function runUntracked(
    command: GitReadCommand,
    request: GitReadRequest,
    onSpawned?: () => void,
  ): Promise<GitReadOutput> {
    const environment = validateRequest(request);
    const checked = { ...request, environment };
    if (command.kind === 'git-bare-init-smoke')
      return runBareInitSmoke(command, checked);
    const plan = await resolved(
      planGitReadCommand(os, command, environment),
      checked,
    );
    if (os === 'win32' && isRepositoryCommand(command.kind))
      return executeWindowsRepository(command.kind, plan, checked);
    return outputOf(
      execute(
        command.kind,
        plan,
        checked,
        (command.kind === 'git-check-ignore' ||
          command.kind === 'git-ls-files-ignored') &&
          typeof command.identity === 'string'
          ? command.identity
          : undefined,
        onSpawned,
      ),
    );
  }

  function run(
    command: GitReadCommand,
    request: GitReadRequest,
  ): Promise<GitReadOutput> {
    return tracked(() => runUntracked(command, request));
  }

  /**
   * The caller's executable for one chunk or listing, awaited until the stop
   * time or an abort. The selection's signal then aborts; its late result is
   * ignored.
   */
  async function selectExecutable(
    deadlineAt: number,
    choose: (signal: AbortSignal) => Promise<string | SelectedGit>,
    signals: readonly AbortSignal[],
  ): Promise<string | SelectedGit> {
    signals.forEach((signal) => signal.throwIfAborted());
    const stopBy = deadlineAt - timing.cleanupReserveMs;
    if (stopBy <= performance.now())
      throw new GitReadError('deadline_exceeded');
    const selection = new AbortController();
    const selecting = Promise.resolve().then(() => choose(selection.signal));
    const selected = await waitWithin(selecting, stopBy, signals);
    if ('value' in selected) return selected.value;
    if ('error' in selected) throw selected.error;
    const failure =
      'aborted' in selected
        ? selected.aborted
        : new GitReadError('deadline_exceeded');
    selection.abort(failure);
    throw failure;
  }

  function validSelection(request: GitCheckIgnoreSelection): boolean {
    return (
      typeof request === 'object' &&
      request !== null &&
      Array.isArray(request.paths) &&
      request.paths.every((entry) => typeof entry === 'string') &&
      request.signal instanceof AbortSignal &&
      typeof request.executableForChunk === 'function' &&
      typeof request.deadlineAt === 'number' &&
      Number.isFinite(request.deadlineAt)
    );
  }

  async function checkIgnoredPathsUntracked(
    request: GitCheckIgnoreSelection,
  ): Promise<Set<string>> {
    if (!validSelection(request)) throw new GitReadError('invalid_request');
    const { cwd, paths, deadlineAt, signal } = request;
    const signals = signalsOf(request);
    signals.forEach((each) => each.throwIfAborted());
    const ignored = new Set<string>();
    if (paths.length === 0) return ignored;
    // The whole request is checked before the caller's first selection.
    const environment = validateRequest(request);
    if (os === 'win32') windowsChildEnvironment(environment);
    const { onChunkStarted } = request;
    for (let i = 0; i < paths.length; i += CHECK_IGNORE_CHUNK_SIZE) {
      const index = i / CHECK_IGNORE_CHUNK_SIZE;
      const selected = versioned(
        await selectExecutable(
          deadlineAt,
          (selectionSignal) =>
            request.executableForChunk(index, selectionSignal, deadlineAt),
          signals,
        ),
      );
      const { executable, version, identity } = selected;
      const chunk = paths.slice(i, i + CHECK_IGNORE_CHUNK_SIZE);
      const input = Buffer.from(`${chunk.join('\0')}\0`, 'utf8');
      const output = await runUntracked(
        { kind: 'git-check-ignore', executable, input, version, identity },
        { cwd, environment, deadlineAt, signal },
        typeof onChunkStarted === 'function'
          ? (): void => onChunkStarted(index, Object.freeze(selected))
          : undefined,
      );
      if (output.code === 0 && output.signal === null)
        output.stdout
          .split('\0')
          .filter(Boolean)
          .forEach((ignoredPath) => ignored.add(ignoredPath));
      else if (output.code !== 1)
        throw new GitReadError('exit_status', {
          exitCode: output.code,
          signal: output.signal,
        });
    }
    return ignored;
  }

  function checkIgnoredPathsSelected(
    request: GitCheckIgnoreSelection,
  ): Promise<Set<string>> {
    return tracked(() => checkIgnoredPathsUntracked(request));
  }

  async function listIgnoredPathsUntracked(
    request: GitIgnoredListingSelection,
  ): Promise<string[]> {
    if (
      typeof request !== 'object' ||
      request === null ||
      !(request.signal instanceof AbortSignal) ||
      typeof request.selectExecutable !== 'function' ||
      typeof request.deadlineAt !== 'number' ||
      !Number.isFinite(request.deadlineAt)
    )
      throw new GitReadError('invalid_request');
    const { cwd, deadlineAt, signal, onStarted } = request;
    const signals = signalsOf(request);
    signals.forEach((each) => each.throwIfAborted());
    // The whole request is checked before the caller's selection.
    const environment = validateRequest(request);
    if (os === 'win32') windowsChildEnvironment(environment);
    const selected = versioned(
      await selectExecutable(
        deadlineAt,
        (selectionSignal) =>
          request.selectExecutable(selectionSignal, deadlineAt),
        signals,
      ),
    );
    const { executable, version, identity } = selected;
    const output = await runUntracked(
      { kind: 'git-ls-files-ignored', executable, version, identity },
      { cwd, environment, deadlineAt, signal },
      typeof onStarted === 'function'
        ? (): void => onStarted(Object.freeze(selected))
        : undefined,
    );
    if (output.code === 0 && output.signal === null)
      return output.stdout.split('\0').filter(Boolean);
    throw new GitReadError('exit_status', {
      exitCode: output.code,
      signal: output.signal,
    });
  }

  function listIgnoredPathsSelected(
    request: GitIgnoredListingSelection,
  ): Promise<string[]> {
    return tracked(() => listIgnoredPathsUntracked(request));
  }

  /** One request deadline across every chunk (desktop git.ts:84). */
  function checkIgnoredPathsWith(
    executable: string | SelectedGit,
    cwd: string,
    paths: readonly string[],
    environment: GitReadEnvironment,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Set<string>> {
    return checkIgnoredPathsSelected({
      cwd,
      paths,
      environment,
      deadlineAt: performance.now() + timing.requestDeadlineMs,
      signal,
      executableForChunk: () => Promise.resolve(executable),
    });
  }

  function whenIdle(signal: AbortSignal): Promise<'idle' | 'pending'> {
    checkClosureContext?.();
    if (!(signal instanceof AbortSignal))
      return Promise.reject(new GitReadError('invalid_request'));
    return activity.whenIdle(signal);
  }

  return Object.freeze({
    run,
    checkIgnoredPathsWith,
    checkIgnoredPathsSelected,
    listIgnoredPathsSelected,
    whenIdle,
  });
}
