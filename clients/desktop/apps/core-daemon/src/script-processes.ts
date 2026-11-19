import { randomUUID } from 'node:crypto';
import type {
  PlatformExecutionOutput,
  PlatformExecutionProcess,
  PlatformExecutionProcessServices,
  PlatformOperatingSystem,
  PlatformStopMode,
} from '@canopy/core-runtime';
import {
  FORCE_KILL_DELAY_MS,
  type ScriptChildOutput,
  type ScriptChildProcess,
  type ScriptProcessHost,
} from '@canopy/core-runtime/node/script/execution';
import { createExecutionProcessServices } from '@canopy/core-platform';
import { lowerSpawnedProcessPriority } from '@canopy/core-platform/execution-host/process-priority';
import type { DaemonExecutionAccounting } from './execution';

export interface DaemonScriptProcessOptions {
  readonly processes: PlatformExecutionProcessServices;
  readonly accounting?: DaemonExecutionAccounting;
}

export type DaemonScriptProcessHost = Pick<
  ScriptProcessHost,
  | 'spawn'
  | 'prepareLaunch'
  | 'lowerPriority'
  | 'drainOwnedProcess'
  | 'registerProcess'
>;

interface PumpedOutput extends ScriptChildOutput {
  readonly destroyed: boolean;
  pump(output: PlatformExecutionOutput): Promise<void>;
}

function pumpedOutput(): PumpedOutput {
  const listeners: Array<(chunk: Buffer) => void> = [];
  let source: PlatformExecutionOutput | null = null;
  let destroyed = false;
  return {
    get destroyed(): boolean {
      return destroyed;
    },
    onData: (listener): void => {
      listeners.push(listener);
    },
    destroy: (): void => {
      destroyed = true;
      source?.discard();
    },
    pump: async (output): Promise<void> => {
      source = output;
      if (destroyed) output.discard();
      for (;;) {
        const chunk = await output.read();
        if (chunk === null) return;
        const data = Buffer.from(
          chunk.buffer,
          chunk.byteOffset,
          chunk.byteLength,
        );
        listeners.forEach((listener) => listener(data));
        output.acknowledge(chunk.byteLength);
      }
    },
  };
}

/**
 * Script processes as owned-process children of the daemon (CAN-5087, D5):
 * each runs in its own tree through the CAN-4134 primitive, which starts
 * asynchronously, so a child's PID is known only once it runs.
 */
/**
 * The owned-process services script shells run under: a graceful stop keeps
 * the in-process runner's SIGTERM-to-SIGKILL window.
 */
export function createDaemonScriptProcessServices(
  os: PlatformOperatingSystem,
  /** Windows only: the owned-child addon (CAN-5140). */
  nativePath?: string,
): PlatformExecutionProcessServices {
  return createExecutionProcessServices(
    { os, ...(nativePath !== undefined && { nativePath }) },
    { graceMs: FORCE_KILL_DELAY_MS },
  );
}

export function createDaemonScriptProcessHost(
  options: DaemonScriptProcessOptions,
): DaemonScriptProcessHost {
  // The runner calls prepareLaunch and spawn back to back.
  let nextBackground = false;
  const running = new Map<number, PlatformExecutionProcess>();

  const account = (pid: number): (() => void) => {
    const { accounting } = options;
    if (!accounting) return (): void => undefined;
    const id = `script-run:${randomUUID()}`;
    const lease = accounting.track('script', id);
    const registration = accounting.register({
      id,
      groupId: 'scripts',
      kind: 'script',
      label: 'Script',
      pid,
      metadata: { type: 'generic' },
    });
    return (): void => {
      registration.unregister();
      lease.release();
    };
  };

  return {
    prepareLaunch: (command, args, background) => {
      nextBackground = background;
      return { command, args };
    },
    lowerPriority: (pid) => lowerSpawnedProcessPriority(pid),
    // The primitive never reports a PID at spawn; spawn accounts instead.
    registerProcess: () => undefined,
    drainOwnedProcess: async (pid, isOwned) => {
      const child = running.get(pid);
      if (child && isOwned()) await child.terminate({ mode: 'force' });
    },
    spawn: (command, args, spawnOptions): ScriptChildProcess => {
      const background = nextBackground;
      nextBackground = false;
      const environment: Record<string, string> = {};
      for (const [key, value] of Object.entries(spawnOptions.env ?? {}))
        if (typeof value === 'string') environment[key] = value;
      const stdout = pumpedOutput();
      const stderr = pumpedOutput();
      const errorListeners: Array<(error: Error) => void> = [];
      const closeListeners: Array<(code: number | null) => void> = [];
      let pid: number | undefined;
      const pidListeners: Array<(pid: number) => void> = [];
      let started: PlatformExecutionProcess | null = null;
      let requested: PlatformStopMode | null = null;
      let forcing: Promise<void> | null = null;
      const terminate = (mode: PlatformStopMode): void => {
        if (started === null) {
          if (requested !== 'force') requested = mode;
          return;
        }
        // A graceful stop keeps what the script prints while it exits, as
        // the in-process runner does.
        const attempt = started.terminate({
          mode,
          keepOutput: mode === 'graceful',
        });
        void attempt.catch(() => undefined);
        if (mode === 'force') forcing ??= attempt;
      };
      void options.processes
        .start({
          executable: command,
          args,
          cwd: spawnOptions.cwd,
          environment,
          stdin: 'ignore',
          stderr: 'pipe',
        })
        .then(
          (child) => {
            started = child;
            pid = child.pid;
            pidListeners.splice(0).forEach((listener) => listener(child.pid));
            running.set(child.pid, child);
            if (background)
              lowerSpawnedProcessPriority(child.pid, { background: true });
            const release = account(child.pid);
            const pumps = Promise.all([
              stdout.pump(child.stdout),
              child.stderr ? stderr.pump(child.stderr) : Promise.resolve(),
            ]).catch(() => undefined);
            // A run the runner gave up on before its start ends at once.
            if (requested !== null || stdout.destroyed)
              terminate(requested ?? 'force');
            void Promise.all([child.outcome, pumps]).then(async ([outcome]) => {
              // A force-ended run (a drain or a stop's SIGKILL) closes once
              // its whole tree has gone, not when its shell exits (CAN-5839).
              await forcing?.catch(() => undefined);
              running.delete(child.pid);
              release();
              closeListeners.forEach((listener) => listener(outcome.code));
            });
          },
          () => {
            const error = new Error('The script process could not start.');
            errorListeners.forEach((listener) => listener(error));
          },
        );
      return {
        get pid(): number | undefined {
          return pid;
        },
        onPid: (listener): void => {
          if (pid !== undefined) listener(pid);
          else pidListeners.push(listener);
        },
        stdout,
        stderr,
        onError: (listener): void => {
          errorListeners.push(listener);
        },
        onClose: (listener): void => {
          closeListeners.push(listener);
        },
        killGroup: (signal): void => {
          terminate(signal === 'SIGTERM' ? 'graceful' : 'force');
        },
        // A drain of a run that had not started reads how its forced end went.
        forced: (): Promise<void> => forcing ?? Promise.resolve(),
      };
    },
  };
}
