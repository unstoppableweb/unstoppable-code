import { TERMINAL_USER_CLOSE_SIGNAL } from '@canopy/protocol/terminal';

import type { WorkerTerminalPort } from '../../terminal/ports';
import {
  MAX_SCRIPT_OUTPUT_BYTES,
  type ScriptProcessHost,
  type ScriptProcessOutcome,
} from './process-runner';
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
} from './shell-command';

/** The `worker.terminal` operations a terminal-backed run uses. */
export type ScriptTerminalPort = Pick<
  WorkerTerminalPort,
  'create' | 'kill' | 'release' | 'lowerPriority' | 'addEventListener'
>;

/** The host facts a terminal-backed run reads, as the process runner does. */
export type ScriptTerminalHost = Pick<
  ScriptProcessHost,
  | 'platform'
  | 'findExecutable'
  | 'windowsGitBash'
  | 'cmdCommandLine'
  | 'loginShell'
  | 'comSpec'
  | 'prepareLaunch'
  | 'assertStartAllowed'
> & {
  /**
   * Whether the host's interfaces reveal a run's terminal when it starts:
   * presentation intent, so the host decides it. Omitted, they do not.
   */
  revealTerminal?(tracking: ScriptRunTracking): boolean;
};

export interface RunScriptTerminalOptions {
  script: string;
  cwd: string;
  /**
   * Exactly the terminal's environment, with nothing laid under it. Omitted,
   * the terminal starts with the worktree's environment.
   */
  env?: NodeJS.ProcessEnv;
  shell?: ScriptCommandShell;
  /** `login` starts a POSIX shell with `-l` instead of `-li`. */
  shellStartup?: 'interactive' | 'login';
  /** Null or omitted runs without a timeout. */
  timeoutMs?: number | null;
  onChunk?: (lines: string[]) => void;
  signal?: AbortSignal;
  /** The worktree owns the terminal; a run without one is refused. */
  tracking?: ScriptRunTracking;
  backgroundPriority?: boolean;
  /** The terminal's title; defaults to the script's label. */
  title?: string;
  /** Overrides the host's {@link ScriptTerminalHost.revealTerminal}. */
  focus?: boolean;
  /** Called synchronously after the terminal is registered for teardown. */
  onProcessStarted?: () => void;
}

function definedVariables(
  env: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function failedBeforeStart(
  output: string,
  startTime: number,
  failure: ScriptProcessOutcome['failure'],
  onChunk: RunScriptTerminalOptions['onChunk'],
): ScriptProcessOutcome {
  onChunk?.(output.split('\n'));
  return {
    success: false,
    exitCode: 1,
    output,
    timedOut: false,
    durationMs: Date.now() - startTime,
    outputBytes: Buffer.byteLength(output, 'utf8'),
    outputTruncated: false,
    failure,
  };
}

/**
 * Run a script in a terminal the worker owns for its worktree (moved from
 * Electron main's interactive runner, CAN-5082), as the CAN-5062 goldens
 * pin: the managed command gets exactly `env` and `cwd`, output is kept to
 * 256 KiB and split into lines for observers, a timeout or stop kills the
 * terminal, and a terminal its user closed is cancelled. The terminal takes
 * its own `terminal` execution lease, so the run registers no script
 * process. A start the host's fences refuse throws; every other failure
 * resolves.
 */
export async function runScriptTerminal(
  host: ScriptTerminalHost,
  loadTerminals: () => Promise<ScriptTerminalPort>,
  registry: ScriptRunRegistry,
  options: RunScriptTerminalOptions,
): Promise<ScriptProcessOutcome> {
  const startTime = Date.now();
  const tracking = options.tracking;
  if (!tracking?.projectId || !tracking.worktreeId) {
    return failedBeforeStart(
      'Interactive scripts require projectId and worktreeId tracking ownership.',
      startTime,
      'spawn-failed',
      options.onChunk,
    );
  }
  host.assertStartAllowed?.(tracking.projectId, tracking.worktreeId);
  const terminals = await loadTerminals();
  let shell: ScriptShellCommand;
  try {
    shell = buildScriptShellCommand(host, options.script, options.shell, {
      interactive: options.shellStartup !== 'login',
      environment: options.env,
    });
  } catch (error) {
    return failedBeforeStart(
      String(error),
      startTime,
      'shell-unavailable',
      options.onChunk,
    );
  }
  const background = options.backgroundPriority === true;
  const launch = host.prepareLaunch(shell.command, shell.args, background);

  return new Promise((resolve) => {
    let terminalId: string | null = null;
    let settled = false;
    let stoppedManually = false;
    let aborted = false;
    let timedOut = false;
    let output = '';
    let outputBytes = 0;
    let lineBuffer = '';
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const exit: { resolve: (result: ScriptProcessResult) => void } = {
      resolve: (): void => undefined,
    };
    const waitForExit = new Promise<ScriptProcessResult>((done) => {
      exit.resolve = done;
    });

    // PTY chunks can split a multibyte character; decode across them.
    const decoder = new TextDecoder();
    const appendText = (text: string): void => {
      if (Buffer.byteLength(output, 'utf8') < MAX_SCRIPT_OUTPUT_BYTES) {
        output = `${output}${text}`;
        if (Buffer.byteLength(output, 'utf8') > MAX_SCRIPT_OUTPUT_BYTES) {
          output = Buffer.from(output, 'utf8')
            .subarray(0, MAX_SCRIPT_OUTPUT_BYTES)
            .toString('utf8');
        }
      }
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      if (Buffer.byteLength(lineBuffer, 'utf8') > MAX_SCRIPT_OUTPUT_BYTES) {
        lineBuffer = Buffer.from(lineBuffer, 'utf8')
          .subarray(0, MAX_SCRIPT_OUTPUT_BYTES)
          .toString('utf8');
      }
      if (lines.length > 0) options.onChunk?.(lines);
    };
    const emitChunk = (chunk: Uint8Array): void => {
      outputBytes += chunk.length;
      appendText(decoder.decode(chunk, { stream: true }));
    };

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      appendText(decoder.decode());
      if (lineBuffer.length > 0) options.onChunk?.([lineBuffer]);
      unsubscribeEvents();
      shell.cleanup?.();
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
      }
      registry.delete(activeScript);
      const cancelled =
        stoppedManually || aborted || signal === TERMINAL_USER_CLOSE_SIGNAL;
      const result: ScriptProcessResult = {
        success:
          !timedOut &&
          !aborted &&
          !stoppedManually &&
          exitCode === 0 &&
          signal === null,
        exitCode: cancelled ? null : exitCode,
        output,
        timedOut,
        durationMs: Date.now() - startTime,
      };
      exit.resolve(result);
      resolve({
        ...result,
        outputBytes: Math.min(outputBytes, MAX_SCRIPT_OUTPUT_BYTES),
        outputTruncated: outputBytes > MAX_SCRIPT_OUTPUT_BYTES,
        failure: null,
      });
    };

    const unsubscribeEvents = terminals.addEventListener((event): void => {
      if (terminalId === null) return;
      if (event.type === 'output') {
        if (event.payload.terminalId === terminalId) {
          emitChunk(Buffer.from(event.payload.data));
        }
      } else if (
        event.type === 'exit' &&
        event.payload.terminalId === terminalId
      ) {
        finish(event.payload.exitCode, event.payload.signal);
      }
    });

    const stop = (reason: 'manual' | 'abort' | 'timeout' = 'manual'): void => {
      if (settled || terminalId === null) return;
      if (reason === 'manual') stoppedManually = true;
      if (reason === 'abort') aborted = true;
      if (reason === 'timeout') timedOut = true;
      terminals.kill(terminalId);
    };
    const activeScript: ActiveScriptRun = {
      stop,
      drain: async () => {
        stoppedManually = true;
        if (terminalId !== null) await terminals.release(terminalId);
        await waitForExit;
      },
      waitForExit,
      tracking,
    };

    try {
      const session = terminals.create({
        projectId: tracking.projectId,
        worktreeId: tracking.worktreeId,
        cols: 80,
        rows: 24,
        managedCommand: {
          executable: launch.command,
          args: launch.args,
          env: definedVariables(options.env),
          title:
            options.title ?? tracking.script?.label ?? 'Interactive command',
          kind: 'script',
          focusOnSpawn:
            options.focus ?? host.revealTerminal?.(tracking) ?? false,
        },
        cwd: options.cwd,
        // An explicit environment is an exact process boundary, not an
        // overlay on the worktree's: shared-container runs keep Canopy-held
        // and user-assigned secrets out of the terminal this way.
        ...(options.env ? { environment: options.env } : {}),
      });
      terminalId = session.id;
      if (background && host.platform() !== 'darwin') {
        terminals.lowerPriority(session.id);
      }
    } catch (error) {
      unsubscribeEvents();
      shell.cleanup?.();
      const failed = failedBeforeStart(
        String(error),
        startTime,
        'spawn-failed',
        options.onChunk,
      );
      exit.resolve(failed);
      resolve(failed);
      return;
    }

    registry.add(activeScript);
    options.onProcessStarted?.();
    if (options.signal) {
      abortListener = (): void => stop('abort');
      if (options.signal.aborted) abortListener();
      else
        options.signal.addEventListener('abort', abortListener, { once: true });
    }
    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => stop('timeout'), options.timeoutMs);
    }
  });
}
