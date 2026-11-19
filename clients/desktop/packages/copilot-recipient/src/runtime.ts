import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { CopilotClient, GetStatusResponse } from '@github/copilot-sdk';
import type * as CopilotSdkModule from '@github/copilot-sdk';
import { copilotRuntimeEnvironment } from './runtime-environment';
import {
  describeCopilotProcessFailure,
  snapshotCopilotDescendants,
  terminateCopilotDescendants,
  withCopilotCleanupDeadline,
} from './process-ownership';
import { CopilotProcessReceipt } from './process-receipts';
import type { CopilotReceiptStorage } from './receipt-storage';
import { loadRequiredNodeModule } from './node-module-loader';
import { CopilotRecipientFailure } from './failure';

/**
 * The structural shape of a provider process host child (CAN-4118's
 * ProviderProcess). Declared here because this package imports nothing from
 * desktop-shared; Electron main passes the host's spawnProviderProcess.
 */
export interface CopilotProcess {
  /** Undefined until the child has started. */
  readonly pid: number | undefined;
  /** Null when the request ignored stdin. */
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** The CLI itself exited; 'close' can follow much later. */
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: 'error', listener: (error: Error) => void): this;
  /** TERM to the group, then KILL after the grace; idempotent; resolves after close. */
  stop(options?: { readonly graceMs?: number }): Promise<void>;
}

export interface CopilotProcessOwner {
  readonly kind: 'turn' | 'subagent' | 'helper' | 'pipeline' | 'discovery';
  readonly id: string;
}

export type CopilotProcessSpawner = (request: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly owner: CopilotProcessOwner;
  readonly stdin?: 'pipe' | 'ignore';
}) => CopilotProcess;

export interface CopilotRuntimeOptions {
  executable: string;
  expectedVersion: string;
  workingDirectory: string;
  stateDirectory: string;
  receiptDirectory?: string;
  receiptStorage?: CopilotReceiptStorage;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Starts the CLI; Electron main passes the provider process host's spawner (CAN-4118). */
  spawnProcess: CopilotProcessSpawner;
  /** Attribution for the provider process host; ids go through copilotProcessOwnerId. */
  owner: CopilotProcessOwner;
}

export interface CopilotRecipientIdentity {
  readonly runtimeId: string;
  readonly pid: number;
  /** Spawn identity on the host's monotonic clock, disambiguated by runtimeId. */
  readonly started: number;
}

export interface OwnedCopilotRuntime {
  readonly identity: CopilotRecipientIdentity;
  isClosed(): boolean;
  client: CopilotClient;
  /** Resolves when the native process has been reaped. */
  exited: Promise<void>;
  close(): Promise<void>;
}

export const MAX_CONSECUTIVE_OBSERVATION_FAILURES = 5;

/** The provider process host refuses an empty owner id or one over 200 characters (CAN-4118). */
export function copilotProcessOwnerId(id: string): string {
  if (id.length === 0) return 'copilot-unidentified';
  if (id.length > 200)
    return `sha256:${createHash('sha256').update(id).digest('hex')}`;
  return id;
}

/**
 * The host owns the detached process group; the official SDK owns JSON-RPC.
 * Its stdio factory does not expose a spawn/kill boundary, so use its supported
 * authenticated loopback connection to an explicitly owned native child.
 * Nothing listens until requested, and no runtime survives owner shutdown.
 */
export async function startCopilotRuntime(
  options: CopilotRuntimeOptions,
): Promise<OwnedCopilotRuntime> {
  options.signal.throwIfAborted();
  if (options.receiptDirectory && !options.receiptStorage)
    throw new Error('Copilot receipt storage is missing.');
  for (const value of [
    options.executable,
    options.workingDirectory,
    options.stateDirectory,
    ...(options.receiptDirectory ? [options.receiptDirectory] : []),
  ]) {
    if (!isAbsolute(value))
      throw new Error('Copilot runtime paths must be absolute.');
  }
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  options.signal.throwIfAborted();
  const token = randomBytes(32).toString('hex');
  const child: CopilotProcess = options.spawnProcess({
    command: options.executable,
    args: [
      '--headless',
      '--no-auto-update',
      '--log-level',
      'none',
      '--no-remote-export',
      '--disable-builtin-mcps',
      '--no-bash-env',
      // The host supplies every identity per session; the runtime must not
      // adopt a gh login or stored CLI credentials on its own.
      '--no-auto-login',
    ],
    cwd: options.workingDirectory,
    env: copilotRuntimeEnvironment(options.env, options.stateDirectory, token),
    owner: {
      kind: options.owner.kind,
      id: copilotProcessOwnerId(options.owner.id),
    },
    // The CLI reads no input; keep its stdin on the null device.
    stdin: 'ignore',
  });
  const started = performance.now();
  const runtimeId = randomUUID();
  let reap!: () => void;
  const exited = new Promise<void>((resolve) => {
    reap = resolve;
  });
  let childExited = false;
  let childClosed = false;
  let childErrored = false;
  let spawnEnoent = false;
  let startupFailure: ((error: Error) => void) | undefined;
  let notStarted: Error | undefined;
  const couldNotStart = (): Error =>
    (notStarted ??= new Error(
      'Copilot could not start. Reconnect it in Settings.',
    ));
  // A descendant can hold the CLI's pipes open long after the CLI exits.
  child.once('exit', () => {
    childExited = true;
  });
  child.once('close', () => {
    childClosed = true;
    reap();
  });
  // ProviderProcess emits error at most once, then close (CAN-4118).
  child.once('error', (error) => {
    childErrored = true;
    spawnEnoent = Reflect.get(error, 'code') === 'ENOENT';
    startupFailure?.(couldNotStart());
  });
  // Setup output can contain credentials. Drain it; never forward it to logs.
  child.stderr.resume();
  let client: CopilotClient | undefined;
  let closing: Promise<void> | undefined;
  const receipt =
    options.receiptDirectory && options.receiptStorage
      ? new CopilotProcessReceipt(
          options.receiptDirectory,
          options.receiptStorage,
        )
      : undefined;
  const observedDescendants = new Map<
    string,
    Awaited<ReturnType<typeof snapshotCopilotDescendants>>[number]
  >();
  let observationTimer: ReturnType<typeof setInterval> | undefined;
  let observation: Promise<void> | undefined;
  let observationError: Error | undefined;
  let ownershipLimitReached = false;
  let receiptConfirmed = false;
  let failedObservations = 0;
  const childIsRunning = (): boolean => !childExited && !childClosed;
  // Once the CLI has exited its pid may be reused; survivors are reaped by identity.
  const stopChild = (): Promise<void> =>
    childIsRunning() ? child.stop() : Promise.resolve();
  const observeDescendants = (): Promise<void> => {
    if (observation) return observation;
    if (!child.pid || !childIsRunning()) return Promise.resolve();
    observation = snapshotCopilotDescendants(child.pid, !!receipt)
      .then(
        async (descendants) => {
          failedObservations = 0;
          // The OS query is asynchronous; do not admit a replacement root
          // whose PID was reused while enumeration was in flight.
          if (!childIsRunning()) return;
          for (const descendant of descendants) {
            const key = `${descendant.pid}:${descendant.started}`;
            if (
              observedDescendants.size >= 16_384 &&
              !observedDescendants.has(key)
            ) {
              ownershipLimitReached = true;
              throw new Error('Copilot process ownership limit exceeded.');
            }
            observedDescendants.set(key, descendant);
          }
          try {
            await receipt?.save(Array.from(observedDescendants.values()));
            if (descendants.some((row) => row.pid === child.pid))
              receiptConfirmed = true;
          } catch (error) {
            ownershipLimitReached = true;
            throw error;
          }
        },
        (error: unknown) => {
          // Count each probe once, however many callers share it.
          failedObservations++;
          throw error;
        },
      )
      .finally(() => {
        observation = undefined;
      });
    return observation;
  };
  // A busy host can push one OS process query past its deadline. Earlier
  // observations stay owned, so only a hard limit or repeated failures mean
  // ownership was lost. Probes never overlap, so descendants can go
  // unrecorded until the runtime stops, for up to
  // MAX_CONSECUTIVE_OBSERVATION_FAILURES × (probe timeout + tick).
  const ownershipLost = (): boolean =>
    ownershipLimitReached ||
    failedObservations >= MAX_CONSECUTIVE_OBSERVATION_FAILURES;
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      let stopping: Promise<void> | undefined;
      options.signal.removeEventListener('abort', abort);
      if (observationTimer) clearInterval(observationTimer);
      let cleanupError = observationError;
      const cleanup = async (
        operation: () => Promise<unknown>,
      ): Promise<void> => {
        await withCopilotCleanupDeadline(
          Promise.resolve().then(operation),
        ).catch((error: unknown) => {
          cleanupError ??=
            error instanceof Error
              ? error
              : new Error('Copilot process cleanup failed.');
        });
      };
      // A transient final probe falls back to the descendants already
      // observed; it shares the polling failure budget. A probe that outlives
      // the cleanup deadline still fails cleanup; a warning it logs later is
      // only diagnostic.
      await cleanup(() =>
        observeDescendants().catch((error: unknown) => {
          if (ownershipLost()) throw error;
          const detail = describeCopilotProcessFailure(error);
          process.emitWarning(
            'Copilot process ownership could not be confirmed during cleanup; using the processes observed earlier.',
            {
              code: 'COPILOT_OWNERSHIP_PROBE_SKIPPED',
              ...(detail ? { detail } : {}),
            },
          );
        }),
      );
      const descendants = Array.from(observedDescendants.values());
      if (hostOperatingSystem() === 'win32') {
        // taskkill needs the live parent to discover its tree. RPC shutdown
        // first would orphan tool processes before Windows can enumerate them.
        await cleanup(stopChild);
      } else {
        // URI clients do not own their server. Flush owned sessions before
        // escalating, but an unresponsive RPC is not a reason to skip the kill.
        try {
          if (client && childIsRunning())
            await withCopilotCleanupDeadline(
              Promise.resolve()
                .then(() => client?.rpc.runtime.shutdown())
                .then(() => client?.stop()),
            ).catch(() => undefined);
        } finally {
          stopping = stopChild();
          await withCopilotCleanupDeadline(exited).catch(() => undefined);
        }
      }
      await cleanup(() => terminateCopilotDescendants(descendants));
      await cleanup(() => stopping ?? stopChild());
      if (client) await cleanup(() => client?.forceStop() ?? Promise.resolve());
      await cleanup(() => exited);
      // A late observation may still be writing after the wrapper's deadline.
      if (!cleanupError && !observation && receipt)
        await cleanup(() =>
          receipt.removeIfReaped(Array.from(observedDescendants.values())),
        );
      if (cleanupError) throw cleanupError;
    })();
    return closing;
  };
  const abort = (): void => {
    void close().catch(() => undefined);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    const portReady = new Promise<number>((resolve, reject) => {
      let settled = false;
      let output = '';
      const timeout = setTimeout(
        () =>
          finish(
            new CopilotRecipientFailure(
              'Copilot did not start in time.',
              'start_timeout',
            ),
          ),
        30_000,
      );
      const onExit = (): void =>
        finish(
          childErrored
            ? couldNotStart()
            : new CopilotRecipientFailure(
                'Copilot stopped during startup.',
                'exited_during_startup',
              ),
        );
      const onAbort = (): void =>
        finish(new Error('Copilot startup cancelled.'));
      const onData = (data: Buffer): void => {
        output = (output + data.toString('utf8')).slice(-16_384);
        const match = /listening on port (\d+)/i.exec(output);
        if (match) {
          const value = Number(match[1]);
          if (Number.isInteger(value) && value > 0 && value <= 65_535)
            finish(undefined, value);
        }
      };
      function finish(error?: Error, value?: number): void {
        if (settled) return;
        settled = true;
        startupFailure = undefined;
        clearTimeout(timeout);
        child.stdout.removeListener('data', onData);
        options.signal.removeEventListener('abort', onAbort);
        child.stdout.resume();
        if (error) reject(error);
        else if (value !== undefined) resolve(value);
      }
      child.stdout.on('data', onData);
      startupFailure = (error): void => finish(error);
      child.once('close', onExit);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
      if (childErrored || childClosed) onExit();
    });
    const [port] = await Promise.all([
      portReady,
      observeDescendants().catch((error: unknown) => {
        if (ownershipLost()) throw error;
      }),
    ]);
    options.signal.throwIfAborted();
    // The desktop entry is V8 bytecode and has no dynamic-import callback.
    // Load the SDK's official CJS export lazily through the packaged resolver.
    const sdk = loadRequiredNodeModule<typeof CopilotSdkModule>({
      moduleId: '@github/copilot-sdk',
      requireFrom: __filename,
      validate: (value): value is typeof CopilotSdkModule =>
        !!value &&
        typeof value === 'object' &&
        'CopilotClient' in value &&
        typeof value.CopilotClient === 'function' &&
        'RuntimeConnection' in value &&
        typeof value.RuntimeConnection === 'object',
    });
    options.signal.throwIfAborted();
    client = new sdk.CopilotClient({
      connection: sdk.RuntimeConnection.forUri(`127.0.0.1:${port}`, {
        connectionToken: token,
      }),
      mode: 'empty',
      baseDirectory: options.stateDirectory,
      logLevel: 'none',
    });
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    const status = await Promise.race([
      (async (): Promise<GetStatusResponse> => {
        await client.start();
        options.signal.throwIfAborted();
        return client.getStatus();
      })(),
      exited.then(() => {
        throw new CopilotRecipientFailure(
          'Copilot stopped during startup.',
          'exited_during_startup',
        );
      }),
      new Promise<never>((_resolve, reject) => {
        handshakeTimer = setTimeout(
          () =>
            reject(
              new CopilotRecipientFailure(
                'Copilot did not initialize in time.',
                'start_timeout',
              ),
            ),
          30_000,
        );
      }),
    ]).finally(() => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
    });
    options.signal.throwIfAborted();
    if (status.version !== options.expectedVersion)
      throw new CopilotRecipientFailure(
        `Copilot CLI ${options.expectedVersion} is required. Reconnect Copilot in Settings.`,
        'version_mismatch',
      );
    // A failed first probe is transient like any other; polling retries it.
    await observeDescendants().catch((error: unknown) => {
      if (ownershipLost()) throw error;
    });
    options.signal.throwIfAborted();
    if (receipt && !receiptConfirmed)
      throw new Error('Copilot process ownership could not be inspected.');
    // Keep identities before a crash can orphan separate PTY/process groups.
    // Only one bounded enumeration can be in flight per owned runtime.
    observationTimer = setInterval(() => {
      if (observation) return;
      void observeDescendants().catch((error: unknown) => {
        if (!ownershipLost()) return;
        observationError =
          error instanceof Error
            ? error
            : new Error('Copilot process ownership could not be inspected.');
        void close().catch(() => undefined);
      });
    }, 500);
    observationTimer.unref();
    if (!child.pid) throw new Error('Copilot process identity is missing.');
    const identity = Object.freeze({ runtimeId, pid: child.pid, started });
    return {
      client,
      exited,
      close,
      identity,
      isClosed: () => closing !== undefined || !childIsRunning(),
    };
  } catch (error) {
    await close();
    // A missing working directory is also ENOENT; only a missing executable
    // has a closed cause. Other spawn errors stay unclassified.
    if (
      error === notStarted &&
      spawnEnoent &&
      !(await access(options.executable).then(
        () => true,
        () => false,
      ))
    )
      throw new CopilotRecipientFailure(
        'Copilot could not start. Reconnect it in Settings.',
        'not_installed',
      );
    throw error;
  }
}
