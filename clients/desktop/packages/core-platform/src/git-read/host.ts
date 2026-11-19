import { userInfo } from 'node:os';
import {
  captureWindowsClosureContext,
  observeWindowsClosure,
} from '../supervision/windows-closure';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import {
  GitIgnoreHostError,
  type GitIgnoreCheckRequest,
  type GitIgnoredListingRequest,
  type GitIgnoreHostFailureCode,
  type GitIgnoreHostPort,
} from '@canopy/core-runtime/node';
import {
  GitRepositoryReadError,
  type GitExecutableSelectionFacts,
  type GitExecutableSelectionRequest,
  type GitRepositoryReadPort,
  type GitRepositoryReadRequest,
} from '@canopy/core-runtime/node/git';
import {
  gitRepositoryCommandFor,
  GitReadError,
  type GitReadEnvironment,
  isHostAbsolute,
  type SelectedGit,
  validateEnvironment,
} from './commands';
import {
  createGitReadRunner,
  type GitReadRunner,
  type GitReadRunnerOptions,
} from './runner';
import {
  createGitSelection,
  DEFAULT_SELECTION_TIMING,
  type GitSelection,
  NODE_SELECTION_IO,
  type SelectionAccount,
  type SelectionIo,
  type SelectionTiming,
} from './selection';

export interface GitReadHostCleanupReport {
  readonly kind: 'scratch_removal' | 'kill';
  readonly outcome: 'failed' | 'cleanup_unconfirmed';
}

export interface GitReadHostOptions {
  readonly os: PlatformOperatingSystem;
  /** Trusted Windows host staging path, never a request or environment field. */
  readonly nativePath?: string;
  /**
   * Daemon's own startup env after claim-marker removal. Copied once;
   * undefined dropped. Never a client's: a repository read's own
   * `environment` replaces it for that read only (CAN-5496).
   */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Trusted absolute directory: cwd for validation/discovery probes. L2 passes the canonical data root (0700). */
  readonly probeDirectory: string;
  readonly onCleanupReport?: (report: GitReadHostCleanupReport) => void;
}

/** A Git a `check-ignore` or `ls-files` process started with; `version` is null when unvalidated. */
export interface GitReadSelected {
  readonly executable: string;
  readonly version: string | null;
}

/** Every distinct Git a started `check-ignore` or `ls-files` ran, in first-start order. */
export interface GitReadSelections {
  readonly selections: readonly GitReadSelected[];
  /** A further distinct Git, or one with an over-long field, was not kept. */
  readonly overflow: boolean;
}

/** Bounds on the selections a host keeps, so its report stays bounded. */
export const GIT_READ_SELECTION_LIMITS = Object.freeze({
  selections: 4,
  executableLength: 4096,
  versionLength: 256,
});

export interface GitReadHost {
  readonly port: GitIgnoreHostPort;
  /**
   * The `worker.git.*` repository reads and executable
   * selection facts, over the same selection, runner and stop as `port`.
   */
  readonly repository: GitRepositoryReadPort;
  /**
   * The executable this host's selection chose, for the daemon's Git write
   * host (CAN-4108), so one daemon selects Git once. The path stays in
   * process. Rejects as `readRepository`'s selection does.
   */
  selectWriteExecutable(
    this: void,
    readSavedExecutablePath: (signal: AbortSignal) => Promise<string>,
    signal: AbortSignal,
  ): Promise<string>;
  /** macOS and Linux x64/arm64: start the login-PATH refresh; otherwise a no-op. Never throws. */
  prewarm(this: void): void;
  lastFailure(this: void): GitIgnoreHostFailureCode | null;
  /** A snapshot of the Gits `check-ignore` and `ls-files` have started with so far. Never throws. */
  selections(this: void): GitReadSelections;
  stop(
    this: void,
    signal: AbortSignal,
  ): Promise<{ readonly state: 'stopped' | 'cleanup_unconfirmed' }>;
}

export interface GitReadHostTiming extends SelectionTiming {
  /** One deadline across a request's selections and chunks (U1's 30 s). */
  readonly requestDeadlineMs: number;
}

/** Private seams, reachable only by relative import (tests). */
export interface GitReadHostSeams {
  readonly arch?: string;
  readonly io?: SelectionIo;
  /** Monotonic clock for the rejection and login-PATH TTLs. */
  readonly now?: () => number;
  readonly timing?: Partial<GitReadHostTiming>;
  readonly userInfo?: () => SelectionAccount;
  readonly uid?: () => number | undefined;
  /** The runner's test seams; the host always sets os, signal and reporters. */
  readonly runner?: Pick<
    GitReadRunnerOptions,
    'operations' | 'timing' | 'scratch' | 'isExecutable'
  >;
  readonly createRunner?: (options: GitReadRunnerOptions) => GitReadRunner;
}

/** One caller field, read once; a throwing getter reads as absent. */
function fieldOf(source: unknown, key: string): unknown {
  try {
    return Reflect.get(Object(source), key);
  } catch {
    return undefined;
  }
}

/** The startup snapshot, copied once; `null` when it cannot be read. */
function copyEnvironment(source: unknown): Record<string, unknown> | null {
  try {
    if (typeof source !== 'object' || source === null) return null;
    const copied: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source))
      if (value !== undefined) copied[key] = value;
    return copied;
  } catch {
    return null;
  }
}

function isSpawnFailure(error: unknown): boolean {
  const syscall = fieldOf(error, 'syscall');
  return typeof syscall === 'string' && syscall.startsWith('spawn');
}

function defaultAccount(): SelectionAccount {
  const info = userInfo();
  return { username: info.username, shell: info.shell };
}

/**
 * Read-only Git selection, `check-ignore` and the ignored listing for a
 * long-lived daemon, over the private runner. Construction does no I/O and
 * never throws; a request with an unusable snapshot or probe directory
 * rejects `invalid_request`.
 */
export function createGitReadHost(options: GitReadHostOptions): GitReadHost {
  return createGitReadHostWith(options, {});
}

export function createGitReadHostWith(
  options: GitReadHostOptions,
  seams: GitReadHostSeams,
): GitReadHost {
  const os = fieldOf(options, 'os');
  const closure =
    os === 'win32' ? observeWindowsClosure('git-host') : undefined;
  const checkClosureContext =
    os === 'win32' ? captureWindowsClosureContext() : undefined;
  const probeDirectory = fieldOf(options, 'probeDirectory');
  const reporter = fieldOf(options, 'onCleanupReport');
  const snapshot = copyEnvironment(fieldOf(options, 'environment'));
  const timing: GitReadHostTiming = {
    ...DEFAULT_SELECTION_TIMING,
    requestDeadlineMs: 30_000,
    ...seams.timing,
  };
  const stopping = new AbortController();
  let stopped = false;
  let failure: GitIgnoreHostFailureCode | null = null;
  const selected: GitReadSelected[] = [];
  let selectionOverflow = false;

  /** Keeps `chosen` once, within GIT_READ_SELECTION_LIMITS. */
  function recordSelected({ executable, version }: SelectedGit): void {
    const entry = { executable, version: version ?? null };
    if (
      selected.some(
        (kept) =>
          kept.executable === entry.executable &&
          kept.version === entry.version,
      )
    )
      return;
    if (
      selected.length >= GIT_READ_SELECTION_LIMITS.selections ||
      entry.executable.length > GIT_READ_SELECTION_LIMITS.executableLength ||
      (entry.version?.length ?? 0) > GIT_READ_SELECTION_LIMITS.versionLength
    )
      selectionOverflow = true;
    else selected.push(Object.freeze(entry));
  }

  function report(outcome: GitReadHostCleanupReport): void {
    try {
      if (typeof reporter === 'function')
        Reflect.apply(reporter, undefined, [Object.freeze(outcome)]);
    } catch {
      // A failing reporter must not change a request or surface as unhandled.
    }
  }

  interface Ready {
    readonly os: PlatformOperatingSystem;
    readonly environment: GitReadEnvironment;
    readonly runner: GitReadRunner;
    readonly selection: GitSelection;
  }
  let ready: Ready | undefined;

  /**
   * Validated on use until it succeeds, then kept; a failure is answered
   * with its code and never kept (CAN-7113).
   */
  function readiness(): Ready | 'invalid_request' | 'environment_invalid' {
    if (ready !== undefined) return ready;
    const supported = os === 'darwin' || os === 'linux' || os === 'win32';
    if (
      !supported ||
      typeof probeDirectory !== 'string' ||
      !isHostAbsolute(os, probeDirectory)
    )
      return 'invalid_request';
    if (snapshot === null) return 'environment_invalid';
    let environment: GitReadEnvironment;
    try {
      environment = validateEnvironment(snapshot);
    } catch {
      return 'environment_invalid';
    }
    const runner = (seams.createRunner ?? createGitReadRunner)({
      ...seams.runner,
      os,
      nativePath: options.nativePath,
      hostSignal: stopping.signal,
      onKillCleanup: (outcome) => report({ kind: 'kill', outcome }),
      onScratchCleanupFailure: (error) =>
        report({
          kind: 'scratch_removal',
          outcome:
            error instanceof GitReadError &&
            error.code === 'cleanup_unconfirmed'
              ? 'cleanup_unconfirmed'
              : 'failed',
        }),
    });
    const selection = createGitSelection({
      os,
      arch: seams.arch ?? process.arch,
      environment,
      probeDirectory,
      runner,
      io: seams.io ?? NODE_SELECTION_IO,
      now: seams.now ?? ((): number => performance.now()),
      timing,
      hostSignal: stopping.signal,
      userInfo: seams.userInfo ?? defaultAccount,
      uid: seams.uid ?? ((): number | undefined => process.getuid?.()),
    });
    ready = { os, environment, runner, selection };
    return ready;
  }

  function failWith(code: GitIgnoreHostFailureCode): never {
    failure = code;
    throw new GitIgnoreHostError(code);
  }

  function codeOf(error: unknown): GitIgnoreHostFailureCode {
    if (error instanceof GitIgnoreHostError) return error.code;
    if (stopping.signal.aborted) return 'stopped';
    if (error instanceof GitReadError)
      return error.code === 'command_not_found'
        ? 'git_unavailable'
        : error.code;
    // A raw spawn error (no pid) means the executable could not start; other
    // raw errors (a stdin EPIPE) are Git failing the request.
    return isSpawnFailure(error) ? 'git_unavailable' : 'exit_status';
  }

  async function checkIgnoredPaths(
    request: GitIgnoreCheckRequest,
  ): Promise<Set<string>> {
    checkClosureContext?.();
    // Each field is read once: an untyped caller's getters run no later.
    const signal = fieldOf(request, 'signal');
    if (signal instanceof AbortSignal) signal.throwIfAborted();
    if (stopped) failWith('stopped');
    const root = fieldOf(request, 'root');
    const paths = fieldOf(request, 'relativePaths');
    const readSaved = fieldOf(request, 'readSavedExecutablePath');
    if (
      !(signal instanceof AbortSignal) ||
      typeof root !== 'string' ||
      !Array.isArray(paths) ||
      typeof readSaved !== 'function'
    )
      failWith('invalid_request');
    if (paths.length === 0) return new Set();
    const host = readiness();
    if (typeof host === 'string') failWith(host);
    const readSavedExecutablePath = (saved: AbortSignal): Promise<unknown> =>
      Promise.resolve().then((): unknown =>
        Reflect.apply(readSaved, request, [saved]),
      );
    try {
      const ignored = await host.runner.checkIgnoredPathsSelected({
        cwd: root,
        paths,
        environment: host.environment,
        deadlineAt: performance.now() + timing.requestDeadlineMs,
        signal,
        executableForChunk: async (_chunk, selectionSignal) => {
          try {
            return await host.selection.select(
              readSavedExecutablePath,
              selectionSignal,
            );
          } catch (error) {
            if (error instanceof GitIgnoreHostError || selectionSignal.aborted)
              throw error;
            throw new GitIgnoreHostError('git_unavailable');
          }
        },
        // Not on selection: an aborted or unspawned chunk ran no Git.
        onChunkStarted: (_chunk, started) => recordSelected(started),
      });
      failure = null;
      return ignored;
    } catch (error) {
      signal.throwIfAborted();
      return failWith(codeOf(error));
    }
  }

  /** `work`, or the first abort of `signals`, rethrowing its reason. */
  async function untilAborted<T>(
    work: Promise<T>,
    signals: readonly AbortSignal[],
  ): Promise<T> {
    const outcome = await new Promise<
      { readonly value: T } | { readonly error: unknown }
    >((settle) => {
      let done = false;
      const listeners = signals.map((each): [AbortSignal, () => void] => [
        each,
        (): void => finish({ error: each.reason }),
      ]);
      function finish(
        result: { readonly value: T } | { readonly error: unknown },
      ): void {
        if (done) return;
        done = true;
        listeners.forEach(([each, listener]) =>
          each.removeEventListener('abort', listener),
        );
        settle(result);
      }
      const preAborted = signals.find((each) => each.aborted);
      if (preAborted) return finish({ error: preAborted.reason });
      listeners.forEach(([each, listener]) =>
        each.addEventListener('abort', listener, { once: true }),
      );
      work.then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  /**
   * One repository read: selection, then the fixed command, under one request
   * deadline from the call, as `check-ignore`. The runner's limits, group kill
   * and host stop apply to the command.
   */
  async function readRepository(
    request: GitRepositoryReadRequest,
  ): Promise<string> {
    checkClosureContext?.();
    const signal = fieldOf(request, 'signal');
    if (signal instanceof AbortSignal) signal.throwIfAborted();
    const failRead = (code: GitIgnoreHostFailureCode): never => {
      throw new GitRepositoryReadError(code);
    };
    if (stopped) failRead('stopped');
    const cwd = fieldOf(request, 'cwd');
    const read = fieldOf(request, 'read');
    const readSaved = fieldOf(request, 'readSavedExecutablePath');
    const forwarded = fieldOf(request, 'environment');
    if (
      !(signal instanceof AbortSignal) ||
      typeof cwd !== 'string' ||
      typeof readSaved !== 'function'
    )
      return failRead('invalid_request');
    const host = readiness();
    if (typeof host === 'string') return failRead(host);
    if (!isHostAbsolute(host.os, cwd)) return failRead('invalid_request');
    // Validated per request and used for this command only; selection keeps
    // the snapshot (D2).
    let environment = host.environment;
    if (forwarded !== undefined) {
      const copied = copyEnvironment(forwarded);
      try {
        environment = validateEnvironment(copied);
      } catch {
        return failRead('invalid_request');
      }
    }
    const deadlineAt = performance.now() + timing.requestDeadlineMs;
    // The deadline also ends a selection still waiting on detection.
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new GitReadError('deadline_exceeded')),
      timing.requestDeadlineMs,
    );
    try {
      const command = gitRepositoryCommandFor(host.os, read);
      const readSavedExecutablePath = (saved: AbortSignal): Promise<unknown> =>
        Promise.resolve().then((): unknown =>
          Reflect.apply(readSaved, request, [saved]),
        );
      const selectionSignal = AbortSignal.any([signal, deadline.signal]);
      const selected = await untilAborted(
        host.selection.select(readSavedExecutablePath, selectionSignal),
        [selectionSignal, stopping.signal],
      ).catch((error: unknown) => {
        // As check-ignore: a failed saved-preference read is no usable Git.
        if (
          error instanceof GitIgnoreHostError ||
          selectionSignal.aborted ||
          stopping.signal.aborted
        )
          throw error;
        throw new GitIgnoreHostError('git_unavailable');
      });
      const output = await host.runner.run(command(selected.executable), {
        cwd,
        environment,
        deadlineAt,
        signal,
      });
      if (output.code !== 0 || output.signal !== null)
        throw new GitReadError('exit_status', {
          exitCode: output.code,
          signal: output.signal,
        });
      return output.stdout;
    } catch (error) {
      signal.throwIfAborted();
      const code = codeOf(error);
      // The exit code alone: `rev-parse --verify` exits 1 for an absent object.
      if (code === 'exit_status' && error instanceof GitReadError)
        throw new GitRepositoryReadError(code, { exitCode: error.exitCode });
      return failRead(code);
    } finally {
      clearTimeout(timer);
    }
  }

  async function selectExecutable(
    request: GitExecutableSelectionRequest,
  ): Promise<GitExecutableSelectionFacts> {
    checkClosureContext?.();
    const signal = fieldOf(request, 'signal');
    if (signal instanceof AbortSignal) signal.throwIfAborted();
    const readSaved = fieldOf(request, 'readSavedExecutablePath');
    const recheck = fieldOf(request, 'recheck');
    if (stopped) return { ready: false, code: 'stopped', explicit: false };
    if (
      !(signal instanceof AbortSignal) ||
      typeof readSaved !== 'function' ||
      typeof recheck !== 'boolean'
    )
      throw new GitRepositoryReadError('invalid_request');
    const host = readiness();
    if (typeof host === 'string') throw new GitRepositoryReadError(host);
    const readSavedExecutablePath = (saved: AbortSignal): Promise<unknown> =>
      Promise.resolve().then((): unknown =>
        Reflect.apply(readSaved, request, [saved]),
      );
    return untilAborted(
      host.selection.observe(readSavedExecutablePath, signal, recheck),
      [signal],
    );
  }

  async function listIgnoredPathEntries(
    request: GitIgnoredListingRequest,
  ): Promise<string[]> {
    checkClosureContext?.();
    // Each field is read once: an untyped caller's getters run no later.
    const signal = fieldOf(request, 'signal');
    if (signal instanceof AbortSignal) signal.throwIfAborted();
    if (stopped) failWith('stopped');
    const root = fieldOf(request, 'root');
    const readSaved = fieldOf(request, 'readSavedExecutablePath');
    if (
      !(signal instanceof AbortSignal) ||
      typeof root !== 'string' ||
      typeof readSaved !== 'function'
    )
      failWith('invalid_request');
    const host = readiness();
    if (typeof host === 'string') failWith(host);
    const readSavedExecutablePath = (saved: AbortSignal): Promise<unknown> =>
      Promise.resolve().then((): unknown =>
        Reflect.apply(readSaved, request, [saved]),
      );
    try {
      const entries = await host.runner.listIgnoredPathsSelected({
        cwd: root,
        environment: host.environment,
        deadlineAt: performance.now() + timing.requestDeadlineMs,
        signal,
        selectExecutable: async (selectionSignal) => {
          try {
            return await host.selection.select(
              readSavedExecutablePath,
              selectionSignal,
            );
          } catch (error) {
            if (error instanceof GitIgnoreHostError || selectionSignal.aborted)
              throw error;
            throw new GitIgnoreHostError('git_unavailable');
          }
        },
        // Not on selection: an aborted or unspawned listing ran no Git.
        onStarted: recordSelected,
      });
      failure = null;
      return entries;
    } catch (error) {
      signal.throwIfAborted();
      return failWith(codeOf(error));
    }
  }

  async function selectWriteExecutable(
    readSaved: (signal: AbortSignal) => Promise<string>,
    signal: AbortSignal,
  ): Promise<string> {
    checkClosureContext?.();
    if (!(signal instanceof AbortSignal) || typeof readSaved !== 'function')
      throw new GitRepositoryReadError('invalid_request');
    signal.throwIfAborted();
    if (stopped) throw new GitRepositoryReadError('stopped');
    const host = readiness();
    if (typeof host === 'string') throw new GitRepositoryReadError(host);
    try {
      const selected = await untilAborted(
        host.selection.select(readSaved, signal),
        [signal, stopping.signal],
      );
      return selected.executable;
    } catch (error) {
      signal.throwIfAborted();
      if (stopping.signal.aborted) throw new GitRepositoryReadError('stopped');
      throw new GitRepositoryReadError(
        error instanceof GitIgnoreHostError ? error.code : 'git_unavailable',
      );
    }
  }

  function prewarm(): void {
    checkClosureContext?.();
    try {
      const host = stopped ? undefined : readiness();
      if (typeof host === 'object') host.selection.prewarm();
    } catch {
      // Prewarming is advisory.
    }
  }

  async function stop(
    signal: AbortSignal,
  ): Promise<{ readonly state: 'stopped' | 'cleanup_unconfirmed' }> {
    checkClosureContext?.();
    if (!(signal instanceof AbortSignal))
      throw new GitIgnoreHostError('invalid_request');
    if (stopped) throw new GitIgnoreHostError('stopped');
    stopped = true;
    stopping.abort(new GitIgnoreHostError('stopped'));
    const host = ready ?? null;
    if (host === null) {
      closure?.close();
      return { state: 'stopped' };
    }
    const selection = await host.selection.whenIdle(signal);
    const runner = await host.runner.whenIdle(signal);
    if (selection !== 'idle' || runner !== 'idle') closure?.unsafe();
    closure?.close();
    return {
      state:
        selection === 'idle' && runner === 'idle'
          ? 'stopped'
          : 'cleanup_unconfirmed',
    };
  }

  return Object.freeze({
    port: Object.freeze({ checkIgnoredPaths, listIgnoredPathEntries }),
    repository: Object.freeze({ readRepository, selectExecutable }),
    selectWriteExecutable,
    prewarm,
    lastFailure: (): GitIgnoreHostFailureCode | null => failure,
    selections: (): GitReadSelections =>
      Object.freeze({
        selections: Object.freeze([...selected]),
        overflow: selectionOverflow,
      }),
    stop,
  });
}
