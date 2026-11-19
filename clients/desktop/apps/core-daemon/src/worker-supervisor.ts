import { randomBytes } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { isSea } from 'node:sea';
import {
  connectLocalWorkerBinding,
  type LocalWorkerBindingClient,
  type PlatformEndpointServices,
  type PlatformExecutionOutcome,
  type PlatformExecutionOutput,
  type PlatformExecutionProcess,
  type PlatformExecutionProcessServices,
  type RuntimeHealthCheck,
  type RuntimeService,
  type SupervisedLocalWorker,
  type WorkerBindingDefinitions,
} from '@canopy/core-runtime';
import type { CanopyRuntimeMode } from '@canopy/protocol';
import { daemonWorkerCaller } from './bundled-graph';
import {
  connectDaemonWorkerEndpoint,
  daemonWorkerEndpointAddress,
} from './worker-endpoint';
import {
  DAEMON_WORKER_READY,
  encodeDaemonWorkerHandoff,
} from './worker-handoff';

/** The supervisor's service: required, so a worker that never starts fails startup. */
export const DAEMON_WORKER_SERVICE = 'core.daemon.localWorker';

export interface DaemonWorkerCommand {
  /** Fully qualified; the worker mode's arguments follow `args`. */
  readonly executable: string;
  readonly args: readonly string[];
}

/** This daemon executable, relaunched; a source run repeats its loader options and script. */
export function daemonWorkerCommand(): DaemonWorkerCommand {
  return isSea()
    ? { executable: process.execPath, args: [] }
    : {
        executable: process.execPath,
        args: [...process.execArgv, process.argv[1] ?? ''],
      };
}

export interface DaemonWorkerRestartPolicy {
  /** Restarts allowed within `windowMs`; one more leaves the worker down. */
  readonly maxRestarts: number;
  readonly windowMs: number;
  /** The first restart's delay, doubled per consecutive crash up to 2 s. */
  readonly backoffMs: number;
}

const DEFAULT_RESTART: DaemonWorkerRestartPolicy = {
  maxRestarts: 5,
  windowMs: 60_000,
  backoffMs: 100,
};
const MAX_BACKOFF_MS = 2_000;
const START_TIMEOUT_MS = 30_000;
/** How long a worker may take to stop on its own once its core binding ends. */
const STOP_GRACE_MS = 3_000;
/** How long a lost binding waits for its worker's exit before stopping it. */
const EXIT_GRACE_MS = 1_000;

export interface DaemonWorkerSupervisorOptions {
  readonly services: PlatformExecutionProcessServices;
  readonly command: DaemonWorkerCommand;
  /** The core's canonical data root; also every worker's working directory. */
  readonly dataRoot: string;
  readonly runtimeMode: CanopyRuntimeMode;
  readonly authorityId: string;
  readonly coworkManagedDirName: string;
  /** The core's own environment; each worker gets it in full and nothing else. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Names each worker's private endpoint; the worker binds it. */
  readonly endpoints: PlatformEndpointServices;
  /** The route the graph uses; each start attaches its binding. */
  readonly worker: SupervisedLocalWorker;
  readonly definitions: WorkerBindingDefinitions;
  readonly restart?: DaemonWorkerRestartPolicy;
  readonly startTimeoutMs?: number;
}

export type DaemonWorkerState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'failed'
  | 'stopping'
  | 'stopped';

/** Which step of the last failed worker start did not finish. */
type DaemonWorkerStartFailure =
  | 'handoff'
  | 'ready_timeout'
  | 'connect'
  | 'binding';

export interface DaemonWorkerStatus {
  readonly state: DaemonWorkerState;
  /** The running worker's root PID, for correlation only. */
  readonly pid: number | null;
  /** Worker starts so far, the first included. */
  readonly starts: number;
  /** How the last worker ended, when one has. */
  readonly lastOutcome: PlatformExecutionOutcome | null;
}

export interface DaemonWorkerSupervisor {
  readonly service: RuntimeService;
  status(): DaemonWorkerStatus;
}

interface Generation {
  readonly child: PlatformExecutionProcess;
  /** The private endpoint this start's worker binds. */
  readonly path: string;
  client: LocalWorkerBindingClient | null;
  exited: boolean;
}

function definedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment))
    if (value !== undefined) result[name] = value;
  return result;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** Resolves once `stdout` has delivered exactly the ready line; anything else refuses. */
async function readReady(
  stdout: PlatformExecutionOutput,
  signal: AbortSignal,
): Promise<void> {
  const expected = Buffer.from(DAEMON_WORKER_READY);
  let received = Buffer.alloc(0);
  while (received.length < expected.length) {
    const bytes = await stdout.read({ signal });
    if (bytes === null) throw new Error('Worker exited before it was ready.');
    stdout.acknowledge(bytes.length);
    received = Buffer.concat([received, bytes]);
    if (
      !expected
        .subarray(0, Math.min(received.length, expected.length))
        .equals(received.subarray(0, expected.length))
    )
      throw new Error('Worker wrote unexpected output.');
  }
  if (received.length !== expected.length)
    throw new Error('Worker wrote unexpected output.');
}

/**
 * Starts and supervises the split daemon's `--profile worker` process
 * (CAN-5073). Each start runs in its own owned process tree, gets a fresh
 * private endpoint and handshake secret over stdin, and attaches its binding
 * once the worker is ready. A worker that exits or drops its binding
 * unasked is restarted with backoff, within a restart budget; past it the
 * worker stays down and health fails. Phase 5 ends the binding, lets the
 * worker stop on its own, stops its tree if it does not, and then refuses
 * every later start, so no worker or descendant outlives the core.
 */
export function createDaemonWorkerSupervisor(
  options: DaemonWorkerSupervisorOptions,
): DaemonWorkerSupervisor {
  const { services, worker, endpoints } = options;
  const restart = options.restart ?? DEFAULT_RESTART;
  let state: DaemonWorkerState = 'idle';
  let current: Generation | null = null;
  let starts = 0;
  let lastOutcome: PlatformExecutionOutcome | null = null;
  let startFailure: DaemonWorkerStartFailure | null = null;
  let crashes: number[] = [];
  let consecutive = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let launching: Promise<void> | undefined;
  const stopping = new AbortController();

  const halted = (): boolean => state === 'stopping' || state === 'stopped';
  /** Each start names a fresh socket, so nothing else can hold this path. */
  const removeSocket = async (path: string): Promise<void> => {
    if (endpoints.semantics !== 'filesystem-socket') return;
    try {
      if ((await lstat(path)).isSocket()) await unlink(path);
    } catch {
      // Already gone, or the next start's fresh name is unaffected.
    }
  };

  const launch = async (): Promise<void> => {
    starts += 1;
    const endpointName = `w-${hex(6)}`;
    const path = daemonWorkerEndpointAddress(
      endpoints,
      options.dataRoot,
      endpointName,
    );
    const auth = { secret: hex(32), dataRootHash: hex(32) };
    const child = await services.start({
      executable: options.command.executable,
      args: [
        ...options.command.args,
        '--profile',
        'worker',
        '--data-root',
        options.dataRoot,
        '--runtime-mode',
        options.runtimeMode,
      ],
      cwd: options.dataRoot,
      environment: definedEnvironment(options.environment),
      stdin: 'pipe',
      stderr: 'discard',
    });
    const generation: Generation = {
      child,
      path,
      client: null,
      exited: false,
    };
    current = generation;
    void child.outcome.then((outcome) => exited(generation, outcome));
    const deadline = AbortSignal.any([
      stopping.signal,
      AbortSignal.timeout(options.startTimeoutMs ?? START_TIMEOUT_MS),
    ]);
    let stage: DaemonWorkerStartFailure = 'handoff';
    try {
      if (child.stdin === null) throw new Error('Worker stdin unavailable.');
      await child.stdin.write(
        Buffer.from(
          encodeDaemonWorkerHandoff({
            version: 1,
            endpointName,
            ...auth,
            authorityId: options.authorityId,
            coworkManagedDirName: options.coworkManagedDirName,
          }),
        ),
      );
      await child.stdin.end();
      stage = 'ready_timeout';
      await readReady(child.stdout, deadline);
      child.stdout.discard();
      stage = 'connect';
      // A long data root's socket alias is checked before connecting (CAN-5694).
      if (endpoints.semantics === 'filesystem-socket')
        await endpoints.prepare(
          endpoints.address({ dataRoot: options.dataRoot, endpointName }),
        );
      const connection = await connectDaemonWorkerEndpoint({
        path,
        auth,
        signal: deadline,
      });
      if (halted() || generation.exited) {
        connection.close();
        throw new Error('Worker start abandoned.');
      }
      stage = 'binding';
      const client = connectLocalWorkerBinding({
        definitions: options.definitions,
        caller: daemonWorkerCaller(options.authorityId),
        connection,
        workerExited: child.outcome,
      });
      generation.client = client;
      worker.attach(client);
      // A binding that ends while its worker runs leaves that worker useless.
      // A dead worker's exit usually lands just after, so it is awaited first
      // and the crash is recorded as one.
      client.signal.addEventListener(
        'abort',
        () => {
          const wait = setTimeout(() => {
            if (!halted() && !generation.exited)
              void child.terminate({ mode: 'graceful' }).catch(() => undefined);
          }, EXIT_GRACE_MS);
          void child.outcome.then(() => clearTimeout(wait));
        },
        { once: true },
      );
      state = 'running';
      startFailure = null;
    } catch (error) {
      startFailure = stage;
      await child.terminate({ mode: 'graceful' }).catch(() => undefined);
      throw error;
    }
  };

  /** Every worker start, the first and each restart; stop waits for it. */
  const begin = (): Promise<void> => {
    const started = launch();
    launching = started;
    return started;
  };

  const schedule = (): void => {
    const now = Date.now();
    crashes = [...crashes.filter((at) => now - at < restart.windowMs), now];
    if (crashes.length > restart.maxRestarts) {
      state = 'failed';
      return;
    }
    consecutive += 1;
    state = 'restarting';
    const delay = Math.min(
      restart.backoffMs * 2 ** (consecutive - 1),
      MAX_BACKOFF_MS,
    );
    timer = setTimeout(() => {
      timer = undefined;
      if (halted()) return;
      begin().then(
        () => {
          consecutive = 0;
        },
        () => {
          if (!halted()) schedule();
        },
      );
    }, delay);
  };

  function exited(
    generation: Generation,
    outcome: PlatformExecutionOutcome,
  ): void {
    generation.exited = true;
    lastOutcome = outcome;
    generation.client?.close();
    // A worker that stops cleanly removes its socket; a killed one cannot.
    void removeSocket(generation.path);
    if (current !== generation) return;
    current = null;
    // A start still in flight fails on its own and schedules the restart.
    if (halted() || generation.client === null) return;
    schedule();
  }

  const stop = async (signal: AbortSignal): Promise<void> => {
    if (state === 'stopped') return;
    state = 'stopping';
    stopping.abort();
    if (timer !== undefined) clearTimeout(timer);
    await launching?.catch(() => undefined);
    const generation = current;
    if (generation !== null && !generation.exited) {
      // The core end closing is the worker's stop request.
      generation.client?.close();
      const grace = new Promise<void>((resolve) => {
        const wait = setTimeout(resolve, STOP_GRACE_MS);
        void generation.child.outcome.then(() => {
          clearTimeout(wait);
          resolve();
        });
      });
      await grace;
      if (!generation.exited)
        await generation.child.terminate({ mode: 'graceful', signal });
    }
    await services.shutdown({ signal });
    state = 'stopped';
  };

  /** Closed facts only: counts, enum names and the exit code or signal, never output. */
  const details = (): NonNullable<RuntimeHealthCheck['details']> => ({
    starts,
    ...(startFailure !== null && { startFailure }),
    lastOutcome:
      lastOutcome === null
        ? null
        : {
            kind: lastOutcome.kind,
            code: lastOutcome.code,
            signal: lastOutcome.signal,
          },
  });

  const health = (): RuntimeHealthCheck => {
    if (state === 'running')
      return { name: DAEMON_WORKER_SERVICE, status: 'pass', message: null };
    if (state === 'failed')
      return {
        name: DAEMON_WORKER_SERVICE,
        status: 'fail',
        message: 'The local worker stopped and its restart budget is spent.',
        reason: 'worker_unavailable',
        details: details(),
      };
    return {
      name: DAEMON_WORKER_SERVICE,
      status: 'warn',
      message: 'The local worker is not attached.',
      reason: `worker_${state}`,
      details: details(),
    };
  };

  return {
    service: {
      name: DAEMON_WORKER_SERVICE,
      plane: 'core',
      required: true,
      start: async (): Promise<void> => {
        state = 'starting';
        await begin();
      },
      health,
      stop: { 5: stop },
    },
    status: () => ({
      state,
      pid: current?.child.pid ?? null,
      starts,
      lastOutcome,
    }),
  };
}
