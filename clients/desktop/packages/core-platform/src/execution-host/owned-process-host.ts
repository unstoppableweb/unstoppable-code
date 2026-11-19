import { constants } from 'node:os';
import * as path from 'node:path';
import type {
  SpawnFailureDetails,
  PlatformExecutionOutcome,
  PlatformExecutionOutput,
  PlatformExecutionProcess,
  PlatformExecutionProcessServices,
} from '@canopy/core-runtime';
import {
  EXECUTION_HOST_CHANNEL_ENV,
  EXECUTION_HOST_STDIO_CHANNEL,
  encodeExecutionHostFrame,
  ExecutionHostFrameReader,
} from './channel';
import { ExecutionProcessError } from '../supervision/execution-process';
import { EXECUTION_HOST_ENTRY_PATTERN, executionHostShellArgs } from './shell';
import {
  type ExecutionHostLaunchRequest,
  type ExecutionHostPort,
  type ExecutionHostProcess,
  type ExecutionProbeRequest,
  type ExecutionProbeResult,
  ReportedExecutionHost,
} from './port';

const OUTPUT_WINDOW_BYTES = 256 * 1024;

/**
 * An executable whose arguments, followed by `executionHostShellArgs`, run
 * the execution host shell (`runRequestedExecutionHostShell`) over its own
 * bundled entries.
 */
export interface ExecutionHostShellCommand {
  /** Fully qualified. */
  readonly executable: string;
  readonly args: readonly string[];
}

export interface OwnedProcessHostPortOptions {
  readonly services: PlatformExecutionProcessServices;
  /**
   * A Node runtime, fully qualified: `process.execPath` in a Node host.
   * Without it only budgeted hosts launch, for a runtime such as the single
   * executable that cannot run an entry file directly.
   */
  readonly nodeExecutable?: string;
  /** Runs budgeted hosts; without it a launch with a budget is refused. */
  readonly shell?: ExecutionHostShellCommand;
  /** Directory holding the bundled entries `nodeExecutable` runs. */
  readonly entryDirectory?: string;
  /** Working directory for hosts and probes, fully qualified. */
  readonly cwd: string;
  /** The environment hosts inherit before a launch's overrides. */
  readonly environment: () => Readonly<Record<string, string | undefined>>;
  /** Host output that is not a channel frame, and host stderr; dropped without it. */
  readonly diagnostics?: (
    stream: 'stdout' | 'stderr',
    bytes: Uint8Array,
  ) => void;
}

function completeEnvironment(
  ...sources: readonly (
    | Readonly<Record<string, string | undefined>>
    | undefined
  )[]
): Record<string, string> {
  const merged: Record<string, string | undefined> = {};
  for (const source of sources) if (source) Object.assign(merged, source);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    // The primitive refuses a request with any such entry.
    if (
      value === undefined ||
      key === '' ||
      key.includes('=') ||
      key.includes('\0') ||
      value.includes('\0')
    )
      continue;
    environment[key] = value;
  }
  return environment;
}

/** The exit code a utility process would report for an outcome. */
function exitCode(outcome: PlatformExecutionOutcome): number {
  if (outcome.code !== null) return outcome.code;
  if (outcome.signal !== null) {
    const number: unknown = Reflect.get(constants.signals, outcome.signal);
    if (typeof number === 'number') return 128 + number;
  }
  return 1;
}

async function pump(
  output: PlatformExecutionOutput | null,
  deliver: (bytes: Uint8Array) => void,
): Promise<void> {
  if (!output) return;
  try {
    for (;;) {
      const chunk = await output.read();
      if (chunk === null) return;
      try {
        deliver(chunk);
      } catch (error) {
        // A throwing listener is the listener's fault, as with an emitter;
        // reading on keeps the outcome reachable.
        process.nextTick(() => {
          throw error;
        });
      }
      // Credit returns only after delivery, so a host that writes faster than
      // its messages are handled blocks on its pipe instead of growing memory.
      output.acknowledge(chunk.byteLength);
    }
  } catch {
    output.discard();
  }
}

class OwnedExecutionHost extends ReportedExecutionHost {
  private child: PlatformExecutionProcess | undefined;
  private readonly queued: Uint8Array[] = [];
  private writing: Promise<void> = Promise.resolve();
  private inputClosed = false;
  private stopping = false;
  startFailure: SpawnFailureDetails | undefined;

  constructor(
    started: Promise<PlatformExecutionProcess>,
    private readonly diagnostics: OwnedProcessHostPortOptions['diagnostics'],
  ) {
    super();
    started.then(
      (child) => this.attach(child),
      (error: unknown) => {
        // Nothing started, so nothing is owned.
        if (error instanceof ExecutionProcessError)
          this.startFailure = error.details;
        this.reportExit(1);
      },
    );
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  postMessage(message: unknown): void {
    if (this.exited || this.inputClosed)
      throw new Error('The execution host can no longer receive messages.');
    const frame = encodeExecutionHostFrame(message);
    if (!this.child) {
      this.queued.push(frame);
      return;
    }
    this.write(frame);
  }

  kill(): boolean {
    const child = this.child;
    if (!child || this.exited) return false;
    this.stopping = true;
    child.terminate({ mode: 'graceful' }).catch(() => {
      // The outcome reports a tree whose cleanup was not confirmed as lost.
    });
    return true;
  }

  private write(frame: Uint8Array): void {
    const stdin = this.child?.stdin;
    if (!stdin) return;
    this.writing = this.writing
      .then(() => stdin.write(frame))
      .catch(() => {
        // A host that closed stdin is exiting; its exit is reported.
        this.inputClosed = true;
      });
  }

  private attach(child: PlatformExecutionProcess): void {
    this.child = child;
    const reader = new ExecutionHostFrameReader(
      (message) => this.reportMessage(message),
      (line) => this.diagnostics?.('stdout', line),
      // A host that breaks the channel's bound cannot be trusted to finish.
      () => this.kill(),
      undefined,
      // A frame that does not decode loses a message a request may wait for;
      // stopping the host settles that request through the host's exit.
      () => this.kill(),
    );
    const stdout = pump(child.stdout, (bytes) => reader.push(bytes)).finally(
      () => reader.end(),
    );
    const stderr = pump(child.stderr, (bytes) =>
      this.diagnostics?.('stderr', bytes),
    );
    this.reportSpawn();
    // A host killed as it spawned never sees what was posted while it started.
    const queued = this.queued.splice(0);
    if (!this.stopping) for (const frame of queued) this.write(frame);
    // The outcome follows the delivery of all output, so every message the
    // host sent is reported before its exit.
    void Promise.allSettled([stdout, stderr])
      .then(() => child.outcome)
      .then((outcome) => {
        this.inputClosed = true;
        this.reportExit(exitCode(outcome));
      });
  }
}

/**
 * Collects a probe's stdout up to its bound and stops the probe's tree on
 * timeout or overflow. Never rejects.
 */
export async function runExecutionProbe(
  services: PlatformExecutionProcessServices,
  cwd: string,
  request: ExecutionProbeRequest,
): Promise<ExecutionProbeResult> {
  let child: PlatformExecutionProcess;
  try {
    child = await services.start({
      executable: request.executable,
      args: request.args,
      cwd,
      environment: completeEnvironment(request.environment),
      stdin: 'ignore',
      stderr: 'discard',
    });
  } catch {
    return { ok: false, reason: 'not-started' };
  }
  let stopped: 'timeout' | 'too-large' | undefined;
  let stopping: Promise<void> = Promise.resolve();
  const stop = (reason: 'timeout' | 'too-large'): void => {
    if (stopped) return;
    stopped = reason;
    // The result waits for the stop, so no tree member outlives it.
    stopping = child.terminate({ mode: 'force' }).catch(() => undefined);
  };
  const timer = setTimeout(() => stop('timeout'), request.timeoutMs);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    await pump(child.stdout, (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > request.maxOutputBytes) stop('too-large');
      else chunks.push(Buffer.from(chunk));
    });
    const outcome = await child.outcome;
    await stopping;
    if (stopped) return { ok: false, reason: stopped };
    if (outcome.kind !== 'exited' || outcome.code !== 0)
      return { ok: false, reason: 'failed' };
    return { ok: true, stdout: Buffer.concat(chunks).toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
}

function hostCommand(
  options: OwnedProcessHostPortOptions,
  request: ExecutionHostLaunchRequest,
): { executable: string; args: string[] } {
  if (request.budget) {
    if (!options.shell)
      throw new Error('This execution host port cannot enforce a budget.');
    return {
      executable: options.shell.executable,
      args: [
        ...options.shell.args,
        ...executionHostShellArgs({
          entry: request.entry,
          budget: request.budget,
        }),
      ],
    };
  }
  if (
    options.nodeExecutable === undefined ||
    options.entryDirectory === undefined
  )
    throw new Error('This execution host port launches only budgeted hosts.');
  return {
    executable: options.nodeExecutable,
    args: [path.join(options.entryDirectory, request.entry)],
  };
}

export interface OwnedExecutionHostPort extends ExecutionHostPort {
  /**
   * Stops every live host gracefully, so each budgeted host unwinds through
   * its shell and closes its writers, and resolves once all have exited.
   * The primitive escalates a host that does not stop within its grace to a
   * kill. Launches after it throw. Call it before the services' shutdown,
   * which force-stops whatever is left.
   */
  shutdown(): Promise<void>;
}

/**
 * The execution host port over the owned-process primitive: each host is a
 * Node child in its own owned tree, speaking the stdio channel, and stopping
 * it stops everything it started in that tree.
 */
export function createOwnedProcessHostPort(
  options: OwnedProcessHostPortOptions,
): OwnedExecutionHostPort {
  const live = new Set<ExecutionHostProcess>();
  let closing = false;
  return {
    launch(request: ExecutionHostLaunchRequest): ExecutionHostProcess {
      if (closing) throw new Error('The execution host port is shut down.');
      if (!EXECUTION_HOST_ENTRY_PATTERN.test(request.entry))
        throw new Error('Unknown execution host entry.');
      const command = hostCommand(options, request);
      const started = options.services.start({
        ...command,
        cwd: options.cwd,
        environment: completeEnvironment(
          options.environment(),
          request.env,
          {
            [EXECUTION_HOST_CHANNEL_ENV]: EXECUTION_HOST_STDIO_CHANNEL,
          },
          // V8 heap options are process-wide and override the entry thread's
          // heap limit, so a budgeted host takes none from the environment.
          request.budget ? { NODE_OPTIONS: undefined } : undefined,
        ),
        stdin: 'pipe',
        stderr: 'pipe',
        outputWindowBytes: OUTPUT_WINDOW_BYTES,
      });
      const host = new OwnedExecutionHost(started, options.diagnostics);
      live.add(host);
      host.once('exit', () => live.delete(host));
      return host;
    },
    probe: (request) =>
      runExecutionProbe(options.services, options.cwd, request),
    async shutdown(): Promise<void> {
      closing = true;
      await Promise.all(
        Array.from(live, (host) => {
          const exited = new Promise<void>((resolve) =>
            host.once('exit', () => resolve()),
          );
          // A host that has not started yet is stopped once it does.
          if (!host.kill()) host.once('spawn', () => host.kill());
          return exited;
        }),
      );
    },
  };
}
