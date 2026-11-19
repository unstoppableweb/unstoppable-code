import { EventEmitter } from 'node:events';
import type { SpawnFailureDetails } from '@canopy/core-runtime';

/**
 * Launches the worker execution hosts (the pipeline process host and the
 * code-graph build, read and fingerprint hosts) and runs short probes such as
 * the login-shell PATH lookup. Host-neutral: the portable composition serves
 * it over the owned-process primitive (`createOwnedProcessHostPort`), and the
 * Electron in-process composition keeps `utilityProcess` as its adapter.
 */
export interface ExecutionHostPort {
  launch(request: ExecutionHostLaunchRequest): ExecutionHostProcess;
  probe(request: ExecutionProbeRequest): Promise<ExecutionProbeResult>;
}

export interface ExecutionHostLaunchRequest {
  /** Bundled host entry file name, such as `pipeline-process-host-worker.js`. */
  readonly entry: string;
  /** Diagnostic name of the host process. */
  readonly serviceName: string;
  /**
   * Overrides applied to the launching process's environment. Without it the
   * host inherits that environment unchanged.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Memory limits for the host. A port that cannot enforce them either
   * refuses the launch or documents that it ignores them.
   */
  readonly budget?: ExecutionHostBudget;
}

/** Per-host memory limits, in MiB. */
export interface ExecutionHostBudget {
  /**
   * The heap ceiling of the thread running the host entry. The execution host
   * shell stops the entry once its sampled used heap passes this plus
   * max(64, heapMb / 8) MiB of room for the young generation; see
   * `executionHostHeapLimits`.
   */
  readonly heapMb: number;
  /** The resident set ceiling of the whole host process. */
  readonly rssMb: number;
}

/**
 * Exit codes of a budgeted host stopped at one of its limits. They sit
 * outside the 128+signal range and the codes hosts exit with themselves.
 */
export const EXECUTION_HOST_LIMIT_EXIT_CODES = Object.freeze({
  heap: 251,
  rss: 252,
});

export type ExecutionHostLimit = keyof typeof EXECUTION_HOST_LIMIT_EXIT_CODES;

/** The limit a budgeted host was stopped at, from its exit code. */
export function executionHostLimitFromExitCode(
  code: number,
): ExecutionHostLimit | undefined {
  if (code === EXECUTION_HOST_LIMIT_EXIT_CODES.heap) return 'heap';
  if (code === EXECUTION_HOST_LIMIT_EXIT_CODES.rss) return 'rss';
  return undefined;
}

export type ExecutionHostEvent = 'spawn' | 'message' | 'exit';

/**
 * One launched host. `spawn` is emitted at most once, when the host has
 * started; `exit` exactly once, after every message the host sent before it
 * ended was emitted; `message` never after `exit`. Messages posted before
 * `spawn` are delivered once it starts.
 */
export interface ExecutionHostProcess {
  /** Set from `spawn`; correlation only. */
  readonly pid: number | undefined;
  /** Why the host never started, set before its `exit`; absent otherwise. */
  readonly startFailure?: SpawnFailureDetails | undefined;
  /** Throws once the host can no longer receive messages. */
  postMessage(message: unknown): void;
  /**
   * Stops the host. False when nothing could be stopped: the host has not
   * started yet, or it has exited. A caller that kills before `spawn` kills
   * again from `spawn`.
   */
  kill(): boolean;
  on(event: 'spawn', listener: () => void): this;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'message', listener: (message: unknown) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  removeListener(event: ExecutionHostEvent, listener: () => void): this;
}

export interface ExecutionProbeRequest {
  /** Fully qualified; never resolved through PATH. */
  readonly executable: string;
  readonly args: readonly string[];
  /** The complete child environment; nothing is inherited. */
  readonly environment: Readonly<Record<string, string>>;
  /** Stops the probe's whole process tree once exceeded. */
  readonly timeoutMs: number;
  /** stdout beyond this fails the probe and stops it. */
  readonly maxOutputBytes: number;
}

export type ExecutionProbeResult =
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      readonly reason: 'not-started' | 'failed' | 'timeout' | 'too-large';
    };

/**
 * The reporting half of {@link ExecutionHostProcess} that both adapters
 * share, so `spawn` and `exit` reach listeners once whatever the transport
 * reports.
 */
export abstract class ReportedExecutionHost
  extends EventEmitter
  implements ExecutionHostProcess
{
  private started = false;
  private ended = false;

  abstract get pid(): number | undefined;

  /** Whether `exit` has been reported. */
  protected get exited(): boolean {
    return this.ended;
  }

  abstract postMessage(message: unknown): void;
  abstract kill(): boolean;

  protected reportSpawn(): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.emit('spawn');
  }

  protected reportMessage(message: unknown): void {
    if (!this.ended) this.emit('message', message);
  }

  protected reportExit(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('exit', code);
  }
}
