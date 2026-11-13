import type {
  ActiveScriptRun,
  ScriptProcessResult,
  ScriptRunRegistry,
  ScriptRunTracking,
} from './run-registry';
import {
  buildScriptShellCommand,
  type ScriptCommandShell,
  type ScriptShellCommand,
  type ScriptShellHost,
} from './shell-command';

export const FORCE_KILL_DELAY_MS = 5_000;
/** The output a run keeps for its result: 256 KiB, then a truncation line. */
export const MAX_SCRIPT_OUTPUT_BYTES = 256 * 1024;

/**
 * How often (ms) buffered lines are flushed to the onChunk callback.
 * Batching keeps observers from being flooded when scripts produce rapid
 * output: 250 ms feels live while holding delivery to about four batches a
 * second per script, which matters when several repos run setup at once.
 */
const EMIT_FLUSH_INTERVAL_MS = 250;

/** Flush immediately once the buffer accumulates this many lines. */
const EMIT_FLUSH_LINE_THRESHOLD = 120;

/** A spawned script process, as the host's process primitive reports it. */
export interface ScriptChildProcess {
  /** Read when it is needed: a host may learn it after spawning. */
  readonly pid: number | undefined;
  readonly stdout: ScriptChildOutput | null;
  readonly stderr: ScriptChildOutput | null;
  onError(listener: (error: Error) => void): void;
  onClose(listener: (code: number | null) => void): void;
  /** Signal the process group off Windows, or the process tree on it. */
  killGroup(signal: NodeJS.Signals): void;
  /**
   * Settles once a forced end the host started (a SIGKILL) has finished, and
   * rejects when the host could not confirm the process tree ended. Hosts
   * that start processes asynchronously (the daemon) report it.
   */
  forced?(): Promise<void>;
}

export interface ScriptChildOutput {
  onData(listener: (chunk: Buffer) => void): void;
  destroy(): void;
}

export interface ScriptSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
  /** A new process group, so stops reach the whole tree; never on Windows. */
  detached: boolean;
}

/**
 * The process facts and effects a host supplies to the script runner. The
 * host creates the process: Electron main with Node's `spawn`, the daemon
 * with its supervised execution primitive when CAN-5087 enables the route.
 */
export interface ScriptProcessHost extends ScriptShellHost {
  /** Throws when the process cannot be created at all. */
  spawn(
    command: string,
    args: string[],
    options: ScriptSpawnOptions,
  ): ScriptChildProcess;
  /** Adjust a launch for background priority where the OS needs a wrapper. */
  prepareLaunch(
    command: string,
    args: string[],
    background: boolean,
  ): { command: string; args: string[] };
  /** Lower a spawned process's priority (non-macOS background runs). */
  lowerPriority(pid: number): void;
  /** End a process group the run owns, while `isOwned` holds. */
  drainOwnedProcess(pid: number, isOwned: () => boolean): Promise<void>;
  /** Refuse a tracked start the host's worktree fences forbid; throws. */
  assertStartAllowed?(projectId: string, worktreeId: string): void;
  /** Account for a tracked script process; unregistered when it ends. */
  registerProcess?(
    pid: number,
    tracking: ScriptRunTracking,
  ): { unregister(): void } | undefined;
}

export interface RunScriptProcessOptions {
  script: string;
  cwd: string;
  shell?: ScriptCommandShell;
  /** `login` starts a POSIX shell with `-l` instead of `-li`. */
  shellStartup?: 'interactive' | 'login';
  /** Null or omitted runs without a timeout. */
  timeoutMs?: number | null;
  onChunk?: (lines: string[]) => void;
  /** Cuts an `onChunk` line longer than this, dropping the rest until its newline; omitted keeps lines whole. */
  maxLineLength?: number;
  /** Raw output as it arrives, before line batching. */
  onData?: (chunk: Buffer, stream: 'stdout' | 'stderr') => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  tracking?: ScriptRunTracking;
  /** Run below the app's priority, for automatic background work. */
  backgroundPriority?: boolean;
  /** Called synchronously after the process is registered for teardown. */
  onProcessStarted?: () => void;
}

/** A run's result with what the protocol records about its output. */
export interface ScriptProcessOutcome extends ScriptProcessResult {
  outputBytes: number;
  outputTruncated: boolean;
  /** Why the process could not start, when it did not. */
  failure: 'shell-unavailable' | 'spawn-failed' | null;
}

/**
 * Run a non-interactive script process (moved from Electron main's
 * `runShellScript`, CAN-4143): a detached process group off Windows,
 * combined output kept to 256 KiB, line batches for observers, a timeout and
 * stops that send SIGTERM and then SIGKILL five seconds later, and a drain
 * that ends the whole group. A start the host refuses throws; every other
 * failure resolves.
 */
export function runScriptProcess(
  host: ScriptProcessHost,
  registry: ScriptRunRegistry,
  options: RunScriptProcessOptions,
): Promise<ScriptProcessOutcome> {
  if (options.tracking) {
    host.assertStartAllowed?.(
      options.tracking.projectId,
      options.tracking.worktreeId,
    );
  }
  const startTime = Date.now();

  return new Promise((resolve) => {
    const exit: { resolve: (result: ScriptProcessResult) => void } = {
      resolve: (): void => undefined,
    };
    const waitForExit = new Promise<ScriptProcessResult>((resolveDone) => {
      exit.resolve = resolveDone;
    });
    let settled = false;
    let stoppedManually = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const lineBuffers = { stdout: '', stderr: '' };
    // The kept start of a pipe's line longer than `maxLineLength`; the rest
    // of it is dropped until its newline.
    const cutLines: Record<'stdout' | 'stderr', string | null> = {
      stdout: null,
      stderr: null,
    };
    let pendingLines: string[] = [];
    let flushTimer: NodeJS.Timeout | undefined;

    const flushPendingLines = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (pendingLines.length > 0 && options.onChunk) {
        options.onChunk(pendingLines);
        pendingLines = [];
      }
    };

    const flushBufferedOutput = (): void => {
      for (const stream of ['stdout', 'stderr'] as const) {
        const rest = cutLines[stream] ?? lineBuffers[stream];
        if (options.onChunk && rest.length > 0) pendingLines.push(rest);
        cutLines[stream] = null;
        lineBuffers[stream] = '';
      }
      flushPendingLines();
    };

    const failBeforeProcessStart = (
      error: unknown,
      failure: ScriptProcessOutcome['failure'],
    ): void => {
      const output = String(error);
      options.onChunk?.(output.split('\n'));
      const response = {
        success: false,
        exitCode: 1,
        output,
        timedOut: false,
        durationMs: Date.now() - startTime,
      };
      exit.resolve(response);
      resolve({
        ...response,
        outputBytes: Buffer.byteLength(output, 'utf8'),
        outputTruncated: false,
        failure,
      });
    };

    let shell: ScriptShellCommand;
    try {
      shell = buildScriptShellCommand(host, options.script, options.shell, {
        interactive: options.shellStartup !== 'login',
      });
    } catch (error) {
      failBeforeProcessStart(error, 'shell-unavailable');
      return;
    }

    const platform = host.platform();
    let child: ScriptChildProcess;
    try {
      const launch = host.prepareLaunch(
        shell.command,
        shell.args,
        options.backgroundPriority === true,
      );
      child = host.spawn(launch.command, launch.args, {
        cwd: options.cwd,
        env: options.env,
        // Windows drops piped output for detached children; taskkill /t still
        // lets us terminate the process tree without CREATE_NEW_PROCESS_GROUP.
        detached: platform !== 'win32',
      });
    } catch (error) {
      shell.cleanup?.();
      failBeforeProcessStart(error, 'spawn-failed');
      return;
    }
    const startedPid = child.pid;
    if (
      options.backgroundPriority &&
      platform !== 'darwin' &&
      typeof startedPid === 'number'
    ) {
      host.lowerPriority(startedPid);
    }
    let resourceHandle: { unregister(): void } | undefined;
    const tracking = options.tracking;
    const spawnedPid = child.pid;
    if (tracking?.script && typeof spawnedPid === 'number') {
      resourceHandle = host.registerProcess?.(spawnedPid, tracking);
    }
    const collectChunk = (chunk: Buffer): void => {
      if (totalBytes >= MAX_SCRIPT_OUTPUT_BYTES) return;
      const remaining = MAX_SCRIPT_OUTPUT_BYTES - totalBytes;
      const slice =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      totalBytes += slice.length;
    };

    const emitLines = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (!options.onChunk) return;
      // A partial line belongs to its pipe; interleaved stderr must never
      // complete an unfinished stdout line (or the reverse).
      const parts = (lineBuffers[stream] + chunk.toString('utf8')).split(
        /\r?\n/,
      );
      // The last element is the incomplete line (or empty string if the
      // chunk ended with a recognized newline).
      let partial = parts.pop() ?? '';
      const cutLine = cutLines[stream];
      if (cutLine !== null && parts.length > 0) {
        parts[0] = cutLine;
        cutLines[stream] = null;
      }
      const { maxLineLength } = options;
      if (
        cutLines[stream] === null &&
        maxLineLength !== undefined &&
        partial.length > maxLineLength
      ) {
        cutLines[stream] = partial.slice(0, maxLineLength);
        partial = '';
      } else if (cutLines[stream] !== null) {
        // Keeps a carriage return whose newline arrives in the next chunk.
        partial = partial.endsWith('\r') ? '\r' : '';
      }
      lineBuffers[stream] = partial;
      if (parts.length === 0) return;

      pendingLines.push(...parts);

      // Flush immediately when the buffer is large enough
      if (pendingLines.length >= EMIT_FLUSH_LINE_THRESHOLD) {
        flushPendingLines();
        return;
      }

      // Schedule a deferred flush. The timer fires after the interval, then
      // `setImmediate` moves delivery into the check phase of the event
      // loop, after the poll phase where request handlers run, so script
      // output never starves interactive requests.
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          setImmediate(flushPendingLines);
        }, EMIT_FLUSH_INTERVAL_MS);
      }
    };

    const handleData =
      (stream: 'stdout' | 'stderr') =>
      (chunk: Buffer): void => {
        collectChunk(chunk);
        options.onData?.(chunk, stream);
        emitLines(chunk, stream);
      };

    let aborted = false;
    let abortListener: (() => void) | undefined;
    const finalize = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (flushTimer) clearTimeout(flushTimer);
      registry.delete(activeScript);
      resourceHandle?.unregister();
      resourceHandle = undefined;
      shell.cleanup?.();
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();

      flushBufferedOutput();

      let output = Buffer.concat(chunks).toString('utf8');
      const truncated = totalBytes >= MAX_SCRIPT_OUTPUT_BYTES;
      const finalLines: string[] = [];
      if (truncated) {
        output += '\n[output truncated]';
        finalLines.push('[output truncated]');
      }
      if (error) {
        output += (output ? '\n' : '') + error;
        finalLines.push(...error.split('\n'));
      }
      if (finalLines.length > 0 && options.onChunk) {
        options.onChunk(finalLines);
      }

      const response = {
        success:
          !timedOut && !aborted && !stoppedManually && exitCode === 0 && !error,
        exitCode: stoppedManually || aborted ? null : exitCode,
        output,
        timedOut,
        durationMs: Date.now() - startTime,
      };

      exit.resolve(response);
      resolve({
        ...response,
        outputBytes: totalBytes,
        outputTruncated: truncated,
        failure: error && totalBytes === 0 ? 'spawn-failed' : null,
      });
    };

    const stop = (reason: 'manual' | 'abort' | 'timeout' = 'manual'): void => {
      if (settled) return;
      if (reason !== 'timeout') {
        stoppedManually = true;
      }
      child.killGroup('SIGTERM');
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          child.killGroup('SIGKILL');
          // Detached descendants can inherit stdout/stderr and keep Node's
          // child "close" event from firing. Once we've escalated to
          // SIGKILL, complete the tracked run so it is not stuck stopping.
          finalize(null);
        }, FORCE_KILL_DELAY_MS);
      }
    };
    const activeScript: ActiveScriptRun = {
      stop,
      drain: async () => {
        stoppedManually = true;
        const ownedPid = child.pid;
        if (ownedPid === undefined && !settled) {
          // The host has not reported the process yet (the daemon starts it
          // asynchronously, CAN-5839): end it as soon as it starts and wait
          // for it to exit. A start that fails settles the run too.
          child.killGroup('SIGKILL');
          await waitForExit;
          await child.forced?.();
          return;
        }
        if (ownedPid !== undefined) {
          await host.drainOwnedProcess(
            ownedPid,
            () => registry.has(activeScript) && child.pid === ownedPid,
          );
        }
        finalize(null);
        await waitForExit;
      },
      waitForExit,
      tracking: options.tracking,
    };
    registry.add(activeScript);
    options.onProcessStarted?.();

    if (options.signal) {
      abortListener = (): void => {
        aborted = true;
        stop('abort');
      };
      if (options.signal.aborted) {
        abortListener();
      } else {
        options.signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    const timeoutTimer =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop('timeout');
          }, options.timeoutMs)
        : undefined;

    child.stdout?.onData(handleData('stdout'));
    child.stderr?.onData(handleData('stderr'));

    child.onError((err) => {
      finalize(1, String(err));
    });

    child.onClose((code) => {
      finalize(code);
    });
  });
}
