import { workingDirectoryLaunchError } from '@canopy/desktop-shared/node/lib/working-directory';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  connectExecutionHostChannel,
  type ConnectedExecutionHostChannel,
  type ExecutionHostChannel,
} from '@canopy/desktop-shared/node/execution-host/channel';
import { killProcessGroupByPid } from '@canopy/execution-engine/node/lib/process-kill';
import { killChildProcessGroup } from '../lib/process-kill';
import type {
  ClaudeProcessHostRequest,
  ClaudeProcessHostResponse,
  ClaudeProcessHostSpawnRequest,
} from './claude-process-host-protocol';
import { CLAUDE_PROCESS_HOST_STDOUT_WINDOW_BYTES } from './claude-process-host-protocol';

interface HostedClaudeProcess {
  child: ChildProcess;
  stdoutInFlightBytes: number;
  pendingStdout: Buffer[];
  stdoutCreditPaused: boolean;
  discardingStdout: boolean;
  stdoutEnded: boolean;
  close: { code: number | null; signal: NodeJS.Signals | null } | null;
  sigkillEscalation: NodeJS.Timeout | null;
}

/** How long a child may ignore a softer signal before its group is SIGKILLed. */
const SIGKILL_ESCALATION_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRequest(value: unknown): value is ClaudeProcessHostRequest {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'shutdown') return true;
  return typeof value.requestId === 'string';
}

export interface ClaudeProcessHostHandle {
  /** The host's shutdown: SIGKILL every tracked CLI group, report shutdown-complete, exit. Idempotent. */
  shutdown(): Promise<void>;
}

export function startClaudeProcessHost(
  channel: ExecutionHostChannel,
  exitProcess: (code: number) => void = (code) => process.exit(code),
): ClaudeProcessHostHandle {
  const active = new Map<string, HostedClaudeProcess>();
  let shuttingDown = false;
  const post = (response: ClaudeProcessHostResponse): void => {
    channel.postMessage(response);
  };

  const clearSigkillEscalation = (state: HostedClaudeProcess): void => {
    if (!state.sigkillEscalation) return;
    clearTimeout(state.sigkillEscalation);
    state.sigkillEscalation = null;
  };

  const killProcess = (
    requestId: string,
    state: HostedClaudeProcess,
    signal: NodeJS.Signals,
  ): void => {
    killChildProcessGroup(state.child, signal);
    if (signal === 'SIGKILL') {
      clearSigkillEscalation(state);
      return;
    }
    if (state.sigkillEscalation) return;
    state.sigkillEscalation = setTimeout(() => {
      state.sigkillEscalation = null;
      if (active.get(requestId) === state && state.close === null) {
        killChildProcessGroup(state.child, 'SIGKILL');
      }
    }, SIGKILL_ESCALATION_MS);
    state.sigkillEscalation.unref?.();
  };

  const finishClosedProcess = (
    requestId: string,
    state: HostedClaudeProcess,
  ): void => {
    if (!state.close || !state.stdoutEnded || state.pendingStdout.length > 0)
      return;
    if (active.get(requestId) !== state) return;
    active.delete(requestId);
    clearSigkillEscalation(state);
    post({
      type: 'exit',
      requestId,
      code: state.close.code,
      signal: state.close.signal,
    });
  };

  const discardStdout = (
    requestId: string,
    state: HostedClaudeProcess,
  ): void => {
    state.discardingStdout = true;
    state.pendingStdout.length = 0;
    state.stdoutInFlightBytes = 0;
    state.stdoutCreditPaused = false;
    state.stdoutEnded = true;
    state.child.stdout?.resume();
    if (state.close) state.child.stdout?.destroy();
    finishClosedProcess(requestId, state);
  };

  const flushStdout = (requestId: string, state: HostedClaudeProcess): void => {
    if (state.discardingStdout) {
      finishClosedProcess(requestId, state);
      return;
    }
    while (
      state.pendingStdout.length > 0 &&
      state.stdoutInFlightBytes < CLAUDE_PROCESS_HOST_STDOUT_WINDOW_BYTES
    ) {
      const pending = state.pendingStdout[0];
      const available =
        CLAUDE_PROCESS_HOST_STDOUT_WINDOW_BYTES - state.stdoutInFlightBytes;
      const forwarded =
        pending.length <= available ? pending : pending.subarray(0, available);
      post({
        type: 'stdout',
        requestId,
        dataBase64: forwarded.toString('base64'),
      });
      state.stdoutInFlightBytes += forwarded.length;
      if (forwarded.length === pending.length) {
        state.pendingStdout.shift();
      } else {
        state.pendingStdout[0] = pending.subarray(forwarded.length);
      }
    }

    const shouldPause =
      state.pendingStdout.length > 0 ||
      state.stdoutInFlightBytes >= CLAUDE_PROCESS_HOST_STDOUT_WINDOW_BYTES;
    if (shouldPause && !state.stdoutCreditPaused) {
      state.stdoutCreditPaused = true;
      state.child.stdout?.pause();
    } else if (!shouldPause && state.stdoutCreditPaused) {
      state.stdoutCreditPaused = false;
      state.child.stdout?.resume();
    }
    finishClosedProcess(requestId, state);
  };

  const startProcess = (request: ClaudeProcessHostSpawnRequest): void => {
    if (shuttingDown || active.has(request.requestId)) {
      post({
        type: 'error',
        requestId: request.requestId,
        message: shuttingDown
          ? 'Claude process host is shutting down.'
          : 'Duplicate Claude process host request.',
      });
      return;
    }
    try {
      const startedAtMs = Date.now();
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      const state: HostedClaudeProcess = {
        child,
        stdoutInFlightBytes: 0,
        pendingStdout: [],
        stdoutCreditPaused: false,
        discardingStdout: false,
        stdoutEnded: false,
        close: null,
        sigkillEscalation: null,
      };
      active.set(request.requestId, state);
      const finishStdout = (): void => {
        if (state.stdoutEnded) return;
        state.stdoutEnded = true;
        finishClosedProcess(request.requestId, state);
      };
      // Teardown can race with forwarded stdin writes or unread stdout. The
      // child lifecycle events below remain the source of terminal status.
      child.stdin?.on('error', () => undefined);
      child.stdout?.on('error', finishStdout);
      child.stderr?.on('error', () => undefined);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (state.discardingStdout || active.get(request.requestId) !== state)
          return;
        state.pendingStdout.push(Buffer.from(chunk));
        flushStdout(request.requestId, state);
      });
      child.stdout?.once('end', finishStdout);
      child.stdout?.once('close', finishStdout);
      child.stderr?.on('data', (chunk: Buffer) => {
        if (request.captureStderr) {
          post({
            type: 'stderr',
            requestId: request.requestId,
            dataBase64: Buffer.from(chunk).toString('base64'),
          });
        }
      });
      // `on`, not `once`: a tracked child can fail more than one signal, and an
      // unhandled 'error' would crash this host and orphan every child.
      let errorReported = false;
      child.on('error', (error) => {
        if (active.get(request.requestId) !== state || errorReported) return;
        errorReported = true;
        // With a pid the child was spawned, and an error (a signal it could
        // not be sent) does not mean it exited. Keep it tracked, killable and
        // in shutdown's sweep until its exit arrives.
        if (child.pid !== undefined) {
          post({
            type: 'error',
            requestId: request.requestId,
            message: error.message,
            exitPending: true,
          });
          return;
        }
        active.delete(request.requestId);
        void workingDirectoryLaunchError(error, request.cwd).then((failure) =>
          post({
            type: 'error',
            requestId: request.requestId,
            message:
              failure instanceof Error ? failure.message : String(failure),
          }),
        );
      });
      child.once('exit', (code, signal) => {
        if (active.get(request.requestId) !== state) return;
        state.close = { code, signal };
        if (state.discardingStdout) state.child.stdout?.destroy();
        finishClosedProcess(request.requestId, state);
      });
      child.once('close', (code, signal) => {
        if (active.get(request.requestId) !== state) return;
        state.close = { code, signal };
        flushStdout(request.requestId, state);
      });
      post({
        type: 'started',
        requestId: request.requestId,
        pid: child.pid ?? 0,
        startedAtMs,
      });
    } catch (error) {
      post({
        type: 'error',
        requestId: request.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // On Windows the hosted roots belong to this utility's job object. Keep
    // them alive until taskkill has walked their trees, before exiting closes
    // the job. Bound parallel cleanup below the main host's six-second wait.
    await Promise.allSettled(
      Array.from(active.values(), (state) => {
        if (state.child.pid !== undefined) {
          return killProcessGroupByPid(state.child.pid, 'SIGKILL', {
            timeoutMs: 5_000,
          });
        }
        return Promise.resolve();
      }),
    );
    for (const state of Array.from(active.values()))
      clearSigkillEscalation(state);
    active.clear();
    post({ type: 'shutdown-complete' });
    exitProcess(0);
  };

  channel.on('message', (event: unknown): void => {
    const payload = isRecord(event) && 'data' in event ? event.data : event;
    if (!isRequest(payload)) return;
    if (payload.type === 'spawn') {
      startProcess(payload);
    } else if (payload.type === 'stdin') {
      active
        .get(payload.requestId)
        ?.child.stdin?.write(Buffer.from(payload.dataBase64, 'base64'));
    } else if (payload.type === 'stdin-end') {
      active.get(payload.requestId)?.child.stdin?.end();
    } else if (payload.type === 'kill') {
      const state = active.get(payload.requestId);
      if (state) {
        // Once a caller aborts, unread output is no longer observable. Stop
        // waiting for consumer credit so a paused stream cannot withhold the
        // process exit and leave its request/pid tracked indefinitely.
        const alreadyExited = state.close !== null;
        discardStdout(payload.requestId, state);
        if (!alreadyExited)
          killProcess(payload.requestId, state, payload.signal);
      }
    } else if (
      payload.type === 'stdout-ack' &&
      Number.isFinite(payload.bytes) &&
      payload.bytes > 0
    ) {
      const state = active.get(payload.requestId);
      if (state) {
        state.stdoutInFlightBytes = Math.max(
          0,
          state.stdoutInFlightBytes - Math.floor(payload.bytes),
        );
        flushStdout(payload.requestId, state);
      }
    } else if (payload.type === 'shutdown') {
      void shutdown();
    }
  });
  return { shutdown };
}

/** Serves the host over a launched channel; a lost launcher shuts it down (CAN-4116). */
export function serveClaudeProcessHost(
  channel: ConnectedExecutionHostChannel,
): ClaudeProcessHostHandle {
  const host = startClaudeProcessHost(channel, (code) => channel.exit(code));
  // A launcher that can no longer be reached leaves no one to stop the
  // CLIs, which run in their own process groups.
  channel.onDisconnect(() => {
    void host.shutdown();
  });
  return host;
}

const channel = connectExecutionHostChannel();
if (channel) serveClaudeProcessHost(channel);
