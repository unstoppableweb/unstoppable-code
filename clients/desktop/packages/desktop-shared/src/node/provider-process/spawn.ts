import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { PlatformSupervisionServices } from '@canopy/core-runtime';
import {
  killProcessGroupByPid,
  signalExitedProcessGroup,
} from '@canopy/execution-engine/node/lib/process-kill';
import {
  delay,
  reapDescendantGroupsWithReason,
  traceWithin,
} from './descendant-groups';
import type {
  DescendantCleanup,
  DescendantGroups,
  DescendantReapReason,
} from './descendant-groups';

/** The least time between two descendant records of one child. */
const RECORD_INTERVAL_MS = 1_000;

/*
 * The spawn seam for provider CLIs (CAN-4118; consumed by the Cursor, Copilot
 * and OpenCode turn drivers). Electron main passes the provider process host's
 * spawner; hosts that are not Electron main pass spawnProviderProcessDirect.
 */

export type ProviderProcessOwnerKind =
  | 'turn'
  | 'subagent'
  | 'helper'
  | 'pipeline'
  | 'discovery';

/** Attribution and diagnostics only: never registered, checked or reaped by. */
export interface ProviderProcessOwner {
  readonly kind: ProviderProcessOwnerKind;
  /** Non-empty, at most PROVIDER_PROCESS_OWNER_ID_MAX characters. */
  readonly id: string;
}

/** 'ignore' gives the child no stdin at all, as a null device. */
export type ProviderProcessStdin = 'pipe' | 'ignore';

export interface ProviderProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The child's complete environment; nothing is merged in. */
  readonly env: NodeJS.ProcessEnv;
  readonly owner: ProviderProcessOwner;
  /** Default 'pipe'. With 'ignore', the returned process has no `stdin`. */
  readonly stdin?: ProviderProcessStdin;
  /**
   * Also stop descendants that started their own process group (CAN-6726,
   * CAN-6738). They are recorded while the child runs, when its owner calls
   * `recordDescendants`, never at stop, so the stop signals the child at
   * once. Best effort; POSIX only. Owners must call `stop` even after the
   * child closes on its own: that stop reaps what was recorded, and through
   * the provider process host it also releases the closed child.
   */
  readonly reapDescendantGroups?: boolean;
  /** cmd.exe callers supply their complete, quoted command line on Windows. */
  readonly windowsVerbatimArguments?: boolean;
}

export interface ProviderProcessStopOptions {
  /** Time between SIGTERM and the unconditional group SIGKILL. Default 1500. */
  readonly graceMs?: number;
}

export interface ProviderProcess {
  /** Undefined until the child has started, and for a child that never started. */
  readonly pid: number | undefined;
  /** Null when the request ignored stdin. */
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /**
   * The child process itself exited. Fires at most once, before 'close', and
   * only for a child that started; 'close' can follow much later while a
   * descendant still holds the child's output pipes.
   */
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: 'error', listener: (error: ProviderProcessError) => void): this;
  /**
   * SIGTERM to the child's process group (Windows: forced tree kill), wait for
   * close or graceMs, then SIGKILL the group whether or not the child closed,
   * then resolve after close. Idempotent: later calls return the first promise.
   *
   * With `reapDescendantGroups` (CAN-6726, CAN-6738), the child is still
   * signalled at once; descendants recorded while it ran are reaped after its
   * group is killed: SIGTERM, then SIGKILL after `graceMs` to any group still
   * proven ours. Completion depends on the spawner:
   * - the direct spawner resolves after that reap. With a grace, its group
   *   is killed within `graceMs + 1 s` (the grace, then a 1 s trace if the
   *   child still runs), and the reap ends within `graceMs + 9 s` after that
   *   (a record in flight, up to 2 s; two 3 s proof rounds around the grace;
   *   a 1 s check that killed groups are gone): `2 × graceMs + 10 s` in all.
   *   A forced stop (`graceMs` 0) waits for no record: one 3 s SIGKILL round
   *   and the 1 s check, 4 s in all;
   * - through the provider process host, it resolves at the child's close,
   *   and the host finishes the reap afterwards within the same bounds.
   * The bounds are budgets enforced around each platform read, plus timer
   * delay. Resolution never proves descendants gone; `stopCleanup` reports
   * that.
   */
  stop(options?: ProviderProcessStopOptions): Promise<void>;
  /**
   * With `reapDescendantGroups`, records the child's current descendants
   * outside its group for the reap at stop (CAN-6738). Owners call it when a
   * descendant may have started, such as on a tool call update. Throttled,
   * best effort and never awaited; a no-op without the option or once
   * stopping.
   */
  recordDescendants?(): void;
  /**
   * With `reapDescendantGroups`: the outcome of the descendant cleanup a
   * stop ran, once it finishes (CAN-6738); see `DescendantCleanup`. Undefined
   * when the process does not reap or was never stopped. `none` and `reaped`
   * speak for recorded members only, and only when every recording requested
   * before the stop finished; never for complete containment. A cancelled
   * task never implies `reaped`.
   */
  stopCleanup?(): Promise<ProviderProcessCleanup | undefined>;
  /**
   * Why `stopCleanup` is `unverified`, once the stop finishes; undefined for
   * any other outcome (CAN-7026). See `ProviderProcessCleanupReason`.
   */
  stopCleanupReason?(): Promise<ProviderProcessCleanupReason | undefined>;
}

/** See `ProviderProcess.stopCleanup`. */
export type ProviderProcessCleanup = DescendantCleanup;

/**
 * The first reason a stop's cleanup is `unverified`:
 * - `record-dropped`: a requested record was never traced, because the stop
 *   came first or a forced stop did not wait for it;
 * - `record-incomplete`: a record's trace failed or missed its budget, so the
 *   recorded set may miss descendants;
 * - `stop-trace-incomplete`: the child outlived its grace, and the trace at
 *   the stop failed or missed its budget;
 * - `proof-inconclusive`: a group's proof before a signal did not settle;
 * - `verify-deadline`: a killed group was not proven gone in time;
 * - `reap-failed`: the reap itself threw.
 */
export type ProviderProcessCleanupReason =
  | 'record-dropped'
  | 'record-incomplete'
  | 'stop-trace-incomplete'
  | 'reap-failed'
  | DescendantReapReason;

export type ProviderProcessSpawner = (
  request: ProviderProcessRequest,
) => ProviderProcess;

export class ProviderProcessError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'ProviderProcessError';
  }
}

export const PROVIDER_PROCESS_DEFAULT_GRACE_MS = 1500;
export const PROVIDER_PROCESS_OWNER_ID_MAX = 200;
export const PROVIDER_PROCESS_OWNER_ERROR_CODE = 'ERR_PROVIDER_PROCESS_OWNER';
export const PROVIDER_PROCESS_HOST_EXIT_ERROR_CODE =
  'ERR_PROVIDER_PROCESS_HOST_EXIT';

const OWNER_KINDS: ReadonlySet<unknown> = new Set<ProviderProcessOwnerKind>([
  'turn',
  'subagent',
  'helper',
  'pipeline',
  'discovery',
]);

export function isProviderProcessOwner(
  value: unknown,
): value is ProviderProcessOwner {
  if (typeof value !== 'object' || value === null) return false;
  const id: unknown = Reflect.get(value, 'id');
  return (
    OWNER_KINDS.has(Reflect.get(value, 'kind')) &&
    typeof id === 'string' &&
    id.length >= 1 &&
    id.length <= PROVIDER_PROCESS_OWNER_ID_MAX
  );
}

/** The only error a spawner forwards: code plus a fixed message naming at most the command (H3). */
export function providerProcessErrorFrom(
  error: unknown,
  command: string,
): ProviderProcessError {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : undefined;
  // Never the native message, spawnargs, path or env: spawn requests carry
  // the user's shell environment (CAN-4118 H3).
  if (typeof code === 'string')
    return new ProviderProcessError(`spawn ${command} ${code}`, code);
  return new ProviderProcessError('The provider process failed.', undefined);
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  // A missing, zero, or negative pid would signal the caller's own group.
  if (pid === undefined || pid <= 0) return;
  // Windows children are spawned with `windowsHide`, so they own no window for
  // a graceful `taskkill /T` to close; it exits non-zero and the shared helper
  // falls back to terminating the parent alone, leaving every tool subprocess
  // reparented and holding worktree file handles. Ask for the forced tree kill
  // up front — the graceful attempt degrades to an unconditional terminate
  // there regardless, so no flush is lost.
  const effective: NodeJS.Signals =
    hostPlatformOperatingSystem() === 'win32' ? 'SIGKILL' : signal;
  // A process that already exited is the ordinary case, not an error.
  void killProcessGroupByPid(pid, effective).catch(() => undefined);
}

class DirectProviderProcess extends EventEmitter implements ProviderProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  private readonly child: ChildProcess | undefined;
  private readonly closed: Promise<void>;
  private markClosed: () => void = () => undefined;
  private errorEmitted = false;
  private closeEmitted = false;
  private exitEmitted = false;
  /** Node reaped the child: its pid may be reused from here on. */
  private childExited = false;
  private spawned = false;
  private stopping: Promise<void> | undefined;
  /** Set when descendants that left the group are reaped on stop. */
  private readonly reapsDescendants: boolean;
  /** The descendant reads; the host's own unless a test supplies them. */
  private readonly supervision: PlatformSupervisionServices | undefined;
  /** Descendants recorded while the child runs, reaped at stop. */
  private readonly recorded: DescendantGroups = new Map();
  /** The record in flight, so at most one runs at a time. */
  private recording: Promise<void> | undefined;
  /**
   * A requested recording was dropped, failed or ran out of time, so the
   * recorded set may miss descendants: the cleanup can only be `unverified`.
   */
  private recordingIncomplete = false;
  /** The first reason the recorded set became incomplete. */
  private incompleteReason: ProviderProcessCleanupReason | undefined;
  private cleanupReason: ProviderProcessCleanupReason | undefined;
  /** Whether the record in flight answers a caller (see `record`). */
  private recordingRequested = false;
  /** Ends a record's throttle wait once the stop begins. */
  private readonly recordWait = new AbortController();
  private recordQueued = false;
  /** A trailing record is owed after the latest requested one. */
  private trailingRecord = false;
  private lastRecordAt = Number.NEGATIVE_INFINITY;
  private cleanupOutcome: ProviderProcessCleanup | undefined;

  constructor(
    request: ProviderProcessRequest,
    supervision?: PlatformSupervisionServices,
  ) {
    super();
    this.supervision = supervision;
    this.closed = new Promise<void>((resolve) => {
      this.markClosed = resolve;
    });
    this.reapsDescendants =
      request.reapDescendantGroups === true &&
      hostPlatformOperatingSystem() !== 'win32';
    if (!isProviderProcessOwner(request.owner)) {
      this.child = undefined;
      [this.stdin, this.stdout, this.stderr] = placeholderStreams(
        request.stdin,
      );
      this.failLater(
        new ProviderProcessError(
          'The provider process owner is invalid.',
          PROVIDER_PROCESS_OWNER_ERROR_CODE,
        ),
      );
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        // Windows has no process groups; the tree is reclaimed by taskkill.
        detached: hostPlatformOperatingSystem() !== 'win32',
        // Electron main is a GUI process on Windows; without this the
        // console-subsystem node.exe flashes a console window each turn.
        windowsHide: true,
        windowsVerbatimArguments: request.windowsVerbatimArguments,
        stdio: [request.stdin ?? 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.child = undefined;
      [this.stdin, this.stdout, this.stderr] = placeholderStreams(
        request.stdin,
      );
      this.failLater(providerProcessErrorFrom(error, request.command));
      return;
    }
    const { stdin, stdout, stderr } = child;
    if (!stdout || !stderr)
      throw new Error('Provider process output is not piped.');
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    this.child = child;
    child.once('spawn', () => {
      this.spawned = true;
    });
    child.on('error', (error) => {
      this.emitError(providerProcessErrorFrom(error, request.command));
    });
    child.once('exit', (code, signal) => {
      this.childExited = true;
      if (this.spawned) this.emitExit(code, signal);
    });
    child.once('close', (code, signal) => {
      if (this.spawned) this.emitClose(code, signal);
      else this.emitClose(null, null);
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  recordDescendants(): void {
    if (!this.canRecord()) return;
    this.trailingRecord = true;
    this.record(true);
  }

  private canRecord(): boolean {
    return (
      this.reapsDescendants &&
      !this.stopping &&
      !this.childExited &&
      this.pid !== undefined
    );
  }

  /**
   * Traces now, or once the throttle allows. `requested` records answer a
   * caller, so dropping one leaves the coverage incomplete; the trailing
   * record after a burst is best effort, for a command that started just
   * after the update that asked for the last trace.
   */
  private record(requested: boolean): void {
    const pid = this.pid;
    if (pid === undefined) return;
    if (this.recording) {
      if (requested) this.recordQueued = true;
      return;
    }
    const wait = Math.max(
      0,
      this.lastRecordAt + RECORD_INTERVAL_MS - performance.now(),
    );
    this.recordingRequested = requested;
    this.recording = delay(wait, true, this.recordWait.signal)
      .then(async () => {
        if (this.stopping || this.childExited) {
          // Requested before the stop, never traced: a gap.
          if (requested) this.markIncomplete('record-dropped');
          return;
        }
        this.lastRecordAt = performance.now();
        if (
          !(await traceWithin(
            pid,
            this.recorded,
            undefined,
            this.supervision,
          )) &&
          requested
        )
          this.markIncomplete('record-incomplete');
      })
      .catch(() => {
        if (requested) this.markIncomplete('record-incomplete');
      })
      .finally(() => {
        this.recording = undefined;
        if (this.recordQueued) {
          this.recordQueued = false;
          if (this.canRecord()) this.record(true);
          else this.markIncomplete('record-dropped');
          return;
        }
        if (this.trailingRecord && this.canRecord()) {
          this.trailingRecord = false;
          this.record(false);
        }
      });
  }

  stopCleanup(): Promise<ProviderProcessCleanup | undefined> {
    if (!this.reapsDescendants || !this.stopping)
      return Promise.resolve(undefined);
    return this.stopping.then(() => this.cleanupOutcome);
  }

  stopCleanupReason(): Promise<ProviderProcessCleanupReason | undefined> {
    if (!this.reapsDescendants || !this.stopping)
      return Promise.resolve(undefined);
    return this.stopping.then(() => this.cleanupReason);
  }

  private markIncomplete(reason: ProviderProcessCleanupReason): void {
    this.recordingIncomplete = true;
    this.incompleteReason ??= reason;
  }

  stop(options: ProviderProcessStopOptions = {}): Promise<void> {
    this.stopping ??= this.runStop(
      options.graceMs ?? PROVIDER_PROCESS_DEFAULT_GRACE_MS,
    );
    return this.stopping;
  }

  private async runStop(graceMs: number): Promise<void> {
    const pid = this.pid;
    if (pid === undefined || pid <= 0) {
      this.cleanupOutcome = 'none';
      await this.closed;
      return;
    }
    // Signalled at once, as without reaping: the provider's own cleanup
    // (Antigravity ends its commands on SIGTERM) must not wait for a trace.
    // Descendants were recorded while it ran (recordDescendants).
    const groups = this.recorded;
    this.signal(pid, 'SIGTERM');
    // A record still waiting out its throttle is dropped now rather than
    // holding the reap.
    this.recordWait.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
      // A child still running after a grace may have started more; with no
      // grace (a forced stop) there was no time to, so the kill is not held.
      // Its 1 s budget is shorter than a recording's 2 s.
      if (
        this.reapsDescendants &&
        graceMs > 0 &&
        !this.childExited &&
        !(await traceWithin(pid, groups, 1_000, this.supervision))
      )
        this.markIncomplete('stop-trace-incomplete');
    } finally {
      if (timer) clearTimeout(timer);
      // Parent closure does not imply group closure: terminate surviving
      // descendants before reporting the child stopped.
      this.signal(pid, 'SIGKILL');
    }
    if (this.reapsDescendants) {
      // A record still in flight finishes within its own budget; one only
      // waiting for its turn is dropped and marks the coverage incomplete.
      // A forced stop does not wait for it, which keeps it inside a 5 s
      // shutdown, and its cleanup can then only be unverified.
      if (graceMs > 0) await this.recording;
      else if (this.recording && (this.recordingRequested || this.recordQueued))
        this.markIncomplete('record-dropped');
      const reaped = await reapDescendantGroupsWithReason(
        groups,
        pid,
        graceMs,
        this.supervision,
      ).catch(
        (): { cleanup: ProviderProcessCleanup; reason: 'reap-failed' } => ({
          cleanup: 'unverified',
          reason: 'reap-failed',
        }),
      );
      // Incomplete coverage outranks an empty or fully reaped recorded set.
      if (this.recordingIncomplete) {
        this.cleanupOutcome = 'unverified';
        this.cleanupReason = this.incompleteReason;
      } else {
        this.cleanupOutcome = reaped.cleanup;
        this.cleanupReason = reaped.reason;
      }
    }
    await this.closed;
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    if (this.childExited || this.closeEmitted)
      signalExitedProcessGroup(pid, signal);
    else signalGroup(pid, signal);
  }

  private failLater(error: ProviderProcessError): void {
    process.nextTick(() => {
      this.emitError(error);
      this.emitClose(null, null);
    });
  }

  private emitError(error: ProviderProcessError): void {
    if (this.errorEmitted || this.closeEmitted) return;
    this.errorEmitted = true;
    this.emit('error', error);
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitEmitted || this.closeEmitted) return;
    this.exitEmitted = true;
    this.emit('exit', code, signal);
  }

  private emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.emit('close', code, signal);
    this.markClosed();
  }
}

/** Streams for a child that never started: stdin discards, outputs are ended. */
function placeholderStreams(
  mode: ProviderProcessStdin | undefined,
): [Writable | null, Readable, Readable] {
  const stdin = mode === 'ignore' ? null : new PassThrough();
  stdin?.resume();
  const stdout = new PassThrough();
  stdout.end();
  const stderr = new PassThrough();
  stderr.end();
  return [stdin, stdout, stderr];
}

/**
 * Plain node spawn. Never use it in Electron main outside the host
 * (check:provider-process-host CU1). `supervision` replaces the host's
 * descendant reads, for tests that drive them deterministically.
 */
export function spawnProviderProcessDirect(
  request: ProviderProcessRequest,
  supervision?: PlatformSupervisionServices,
): ProviderProcess {
  return new DirectProviderProcess(request, supervision);
}
