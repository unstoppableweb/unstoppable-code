import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type {
  ConnectedExecutionHostChannel,
  ExecutionHostChannel,
} from '@canopy/core-platform/execution-host/channel';
import {
  killProcessGroupByPid,
  signalExitedProcessGroup,
} from '@canopy/execution-engine/node/lib/process-kill';
import {
  spawnProviderProcessDirect,
  type ProviderProcess,
  type ProviderProcessOwner,
  type ProviderProcessSpawner,
} from '@canopy/execution-engine/node/provider-process/spawn';
import {
  isProviderProcessHostRequest,
  PROVIDER_PROCESS_STDERR_LIMIT_BYTES,
  PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
  type ProviderProcessHostRequest,
  type ProviderProcessHostResponse,
} from './protocol';

/*
 * The provider process host (CAN-4118): spawns provider CLIs for its launcher
 * and relays their stdio. Spawn requests carry the user's environment, so
 * nothing here logs, persists or echoes a request (CAN-4118 H1 to H4).
 */

const SHUTDOWN_STOP_TIMEOUT_MS = 5_000;

export interface ProviderProcessHostChildSnapshot {
  readonly requestId: string;
  readonly pid: number | undefined;
  readonly owner: ProviderProcessOwner;
  readonly stderrTruncated: boolean;
}

export interface ProviderProcessHostHandle {
  /** SIGKILL every tracked child group, post shutdown-complete, exit(0). Idempotent. */
  shutdown(): Promise<void>;
  liveChildren(): readonly ProviderProcessHostChildSnapshot[];
}

interface HostedChild {
  readonly requestId: string;
  readonly child: ProviderProcess;
  readonly owner: ProviderProcessOwner;
  /** Set once the child exited: its pid may be reused, its group may not. */
  exited: boolean;
  credit: number;
  /** Set once the child is being stopped: stdout drains without credit. */
  draining: boolean;
  /** Set once a stopping child's stdout was cut: nothing more is relayed. */
  stdoutTruncated: boolean;
  stderrBytes: number;
  stderrTruncated: boolean;
  /** CAN-6726: its stop traces and reaps descendants in their own groups. */
  readonly reapsDescendants: boolean;
  /** The first stop, settled once its cleanup outcome was posted (CAN-6738). */
  stop?: Promise<void>;
}

type SpawnRequest = Extract<ProviderProcessHostRequest, { type: 'spawn' }>;

export function startProviderProcessHost(
  channel: ExecutionHostChannel,
  exitProcess: (code: number) => void = (code) => process.exit(code),
  spawner: ProviderProcessSpawner = spawnProviderProcessDirect,
): ProviderProcessHostHandle {
  const tracked = new Map<string, HostedChild>();
  /**
   * Stops still running, which may outlive their child's close while
   * reaping. Each settles only after its cleanup outcome was posted, so a
   * shutdown that waits for it reports the outcome before exiting.
   */
  const stopsInFlight = new Set<Promise<void>>();
  /**
   * Reaping children that closed before their stop finished: one not yet
   * stopped is reaped when its stop arrives, as the direct spawner does, or
   * at shutdown; one already stopping is kept until its outcome is posted,
   * so a stop arriving meanwhile waits for that outcome (CAN-6738). Owners
   * always stop a reaping child, so each entry is released.
   */
  const closedReapers = new Map<string, HostedChild>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const post = (message: ProviderProcessHostResponse): void => {
    try {
      channel.postMessage(message);
    } catch {
      // The launcher is gone; its exit handling reaps the children.
    }
  };

  const refuse = (requestId: string): void => {
    post({
      type: 'error',
      requestId,
      message: 'The provider process host is not accepting this spawn.',
      code: 'ERR_PROVIDER_PROCESS_HOST_REFUSED',
    });
    post({ type: 'close', requestId, code: null, signal: null });
  };

  const start = (request: SpawnRequest): void => {
    const { requestId } = request;
    if (shuttingDown || tracked.has(requestId)) {
      refuse(requestId);
      return;
    }
    const child = spawner({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      owner: request.owner,
      windowsVerbatimArguments: request.windowsVerbatimArguments,
      ...(request.stdin ? { stdin: request.stdin } : {}),
      ...(request.reapDescendantGroups ? { reapDescendantGroups: true } : {}),
    });
    const hosted: HostedChild = {
      requestId,
      child,
      owner: request.owner,
      exited: false,
      credit: PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
      draining: false,
      stdoutTruncated: false,
      stderrBytes: 0,
      stderrTruncated: false,
      // As the spawner: Windows' forced tree kill already covers descendants.
      reapsDescendants:
        request.reapDescendantGroups === true &&
        hostPlatformOperatingSystem() !== 'win32',
    };
    tracked.set(requestId, hosted);
    // An exited child's stdin is closed; its close reports the end.
    child.stdin?.on('error', () => undefined);
    child.stdout.on('data', (chunk: Buffer) => {
      // A stopping child keeps being read so its pipe can end, but nothing
      // past the credit window is relayed, and relayed stdout stays a prefix.
      if (hosted.stdoutTruncated) return;
      const forwarded = hosted.draining
        ? chunk.subarray(0, Math.max(hosted.credit, 0))
        : chunk;
      if (forwarded.length < chunk.length) hosted.stdoutTruncated = true;
      if (forwarded.length > 0)
        post({
          type: 'stdout',
          requestId,
          dataBase64: forwarded.toString('base64'),
        });
      hosted.credit -= forwarded.length;
      if (hosted.credit <= 0 && !hosted.draining) child.stdout.pause();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Relayed stderr stays a prefix: nothing after the first dropped chunk.
      if (hosted.stderrTruncated) return;
      if (
        hosted.stderrBytes + chunk.length >
        PROVIDER_PROCESS_STDERR_LIMIT_BYTES
      ) {
        hosted.stderrTruncated = true;
        return;
      }
      hosted.stderrBytes += chunk.length;
      post({
        type: 'stderr',
        requestId,
        dataBase64: chunk.toString('base64'),
      });
    });
    // The spawner already reduced the error to a code and a fixed message (H3).
    child.once('error', (error) => {
      post({
        type: 'error',
        requestId,
        message: error.message,
        ...(error.code === undefined ? {} : { code: error.code }),
      });
    });
    child.once('exit', (code, signal) => {
      hosted.exited = true;
      post({ type: 'exit', requestId, code, signal });
    });
    child.once('close', (code, signal) => {
      tracked.delete(requestId);
      if (hosted.reapsDescendants) closedReapers.set(requestId, hosted);
      post({ type: 'close', requestId, code, signal });
    });
    const pid = child.pid;
    if (pid !== undefined) post({ type: 'started', requestId, pid });
  };

  // A paused stdout never reads its end, so the child's close (and stop)
  // would wait on a reader that may be gone.
  const stopChild = (hosted: HostedChild, graceMs: number): Promise<void> => {
    hosted.draining = true;
    hosted.child.stdout.resume();
    // A child stops once; a later call (a shutdown mid-stop) waits for it.
    if (hosted.stop) return hosted.stop;
    const stopping = hosted.child.stop({ graceMs });
    const settled = hosted.reapsDescendants
      ? stopping
          .then(() => hosted.child.stopCleanup?.())
          .catch(() => 'unverified' as const)
          .then((cleanup) => {
            if (cleanup)
              post({ type: 'stopped', requestId: hosted.requestId, cleanup });
          })
      : stopping.catch(() => undefined);
    hosted.stop = settled;
    stopsInFlight.add(settled);
    void settled.finally(() => {
      stopsInFlight.delete(settled);
      closedReapers.delete(hosted.requestId);
    });
    return settled;
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async (): Promise<void> => {
      shuttingDown = true;
      // A child already stopping keeps its own grace; shutdown does not wait
      // for it, so every tracked group is killed now. A child that reaps its
      // descendants is stopped below instead (CAN-6726, CAN-6738). One not
      // yet stopping gets a forced stop: its group is killed at once and its
      // recorded descendants get one SIGKILL round and a check, about 4 s,
      // inside the 5 s bound. One already stopping keeps its own grace: with
      // the default grace its reap can run past the bound, so a descendant
      // group that ignores SIGTERM may survive a shutdown arriving mid-stop,
      // and the launcher reports that cleanup unverified when this host
      // exits. Every stop below settles only after posting its outcome. Any
      // root group still open when this host exits is killed by the
      // launcher's exit handling.
      for (const hosted of tracked.values()) {
        const pid = hosted.child.pid;
        if (pid === undefined) continue;
        if (hosted.reapsDescendants && !hosted.exited) continue;
        if (hosted.exited) signalExitedProcessGroup(pid, 'SIGKILL');
        else void killProcessGroupByPid(pid, 'SIGKILL').catch(() => undefined);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([
            ...Array.from(
              [...tracked.values(), ...closedReapers.values()],
              (hosted) => stopChild(hosted, 0),
            ),
            // Includes stops whose child already closed but whose reap of
            // descendant groups is still running.
            ...Array.from(stopsInFlight, (stop) => stop.catch(() => undefined)),
          ]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SHUTDOWN_STOP_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      post({ type: 'shutdown-complete' });
      exitProcess(0);
    })();
    return shutdownPromise;
  };

  const handle = (request: ProviderProcessHostRequest): void => {
    if (request.type === 'shutdown') {
      void shutdown();
      return;
    }
    if (request.type === 'spawn') {
      start(request);
      return;
    }
    if (request.type === 'stop') {
      const closed = closedReapers.get(request.requestId);
      if (closed) {
        // Starts its stop, or joins the one in flight, whose outcome is
        // posted once.
        void stopChild(closed, request.graceMs);
        return;
      }
    }
    const hosted = tracked.get(request.requestId);
    if (!hosted) {
      // A stop for a child this host no longer holds: one that never reaped,
      // or whose stop already settled and posted its outcome. Answer, so a
      // launcher waiting for a cleanup is never left waiting (CAN-6738).
      if (request.type === 'stop')
        post({
          type: 'stopped',
          requestId: request.requestId,
          cleanup: 'unverified',
        });
      return;
    }
    const { child } = hosted;
    switch (request.type) {
      case 'stdin':
        try {
          child.stdin?.write(Buffer.from(request.dataBase64, 'base64'));
        } catch {
          // As above: the close reports the end.
        }
        return;
      case 'stdin-end':
        child.stdin?.end();
        return;
      case 'stdout-ack':
        hosted.credit = Math.min(
          PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
          hosted.credit + request.bytes,
        );
        if (hosted.credit > 0 || hosted.draining) child.stdout.resume();
        return;
      case 'stop':
        void stopChild(hosted, request.graceMs);
        return;
      case 'record-descendants':
        child.recordDescendants?.();
        return;
    }
  };

  channel.on('message', ({ data }) => {
    if (isProviderProcessHostRequest(data)) handle(data);
  });

  return {
    shutdown,
    liveChildren: () =>
      Array.from(tracked, ([requestId, hosted]) => ({
        requestId,
        pid: hosted.child.pid,
        owner: hosted.owner,
        stderrTruncated: hosted.stderrTruncated,
      })),
  };
}

/** Serves the host over a launched channel; a lost launcher shuts it down. */
export function serveProviderProcessHost(
  channel: ConnectedExecutionHostChannel,
): ProviderProcessHostHandle {
  const host = startProviderProcessHost(channel, (code) => channel.exit(code));
  // A launcher that can no longer be reached leaves no one to stop the
  // children, which run in their own process groups.
  channel.onDisconnect(() => {
    void host.shutdown();
  });
  return host;
}
