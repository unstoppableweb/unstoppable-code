import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { CanopyClientError } from '@canopy/core-client';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  CanopyOperationError,
  type PlatformOperatingSystem,
} from '@canopy/core-runtime';
import { readFilesystemScope } from '@canopy/core-runtime/node';
import { redeemExecutionSecrets } from '@canopy/core-runtime/node/execution-secrets';
import {
  runScriptRemotely,
  scriptContextDirectory,
  type RemoteScriptTransport,
  type ScriptExecutionWorker,
} from '@canopy/core-runtime/node/script/execution';
import { getResolvedCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import {
  CanopyHostExecutionSchema,
  WORKER_SCRIPT_GRANTS,
  type CanopyCallerDescriptor,
  type CanopyHostExecution,
  type WorkerScriptExecuteParams,
  type WorkerScriptExecuteResult,
} from '@canopy/protocol/canopy-core';
import {
  daemonUnreachableReason,
  markUnreachable,
} from '../canopy-runtime/electron-daemon-connection';
import {
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
} from '../canopy-runtime/electron-daemon-access';
import type { ElectronDaemonClient } from '../canopy-runtime/electron-daemon-host';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';
import { getDaemonScopeResolver } from '../canopy-runtime/daemon-scope-resolver';
import {
  recordDaemonRoute,
  recordDaemonRouteDecision,
  type DaemonRouteNote,
} from '../canopy-runtime/daemon-route-telemetry';
import { getDesktopExecutionSecrets } from '../execution-secrets/owner';
import { DaemonScriptRuns } from './daemon-script-runs';
import { logMainProcessWarn } from './main-process-logging';
import { resolveScriptRunDir } from './paths';
import { desktopScriptWorker, setExternalScriptRuns } from './script-runner';
import { assertWorkspaceTargetRuntimeStartAllowed } from './workspace-target-exclusion';

/**
 * Routing of renderer script runs to the daemon's script worker (CAN-5087),
 * by default on eligible hosts (CAN-5960). Only the `script:run` handler
 * passes a route context, so setup, pipelines, agent actions, Portal, gates
 * and the remote-control bridge keep Electron main's worker. Electron main
 * still records the run, redeems its secrets and sends its complete
 * environment as `_execution`; the daemon writes the run log.
 */

/** Which hosts may run renderer scripts in the daemon. Windows since CAN-5091. */
export const DAEMON_SCRIPT_PLATFORMS: Readonly<
  Record<PlatformOperatingSystem, boolean>
> = {
  darwin: true,
  linux: true,
  win32: true,
};

/** Set only by the `script:run` handler, from the trusted event. */
export interface DaemonScriptRouteContext {
  /** The sender is one of this app's own windows, not the remote-control bridge. */
  readonly localWindow: boolean;
}

export interface DaemonScriptRouteInput {
  readonly platform: PlatformOperatingSystem | null;
  readonly context: DaemonScriptRouteContext | undefined;
  /** Main's record says the daemon cannot be reached right now. */
  readonly daemonLatched: boolean;
}

function isDaemonScriptPlatformEligible(
  platform: PlatformOperatingSystem | null,
): boolean {
  return platform !== null && DAEMON_SCRIPT_PLATFORMS[platform] === true;
}

/** Why a renderer run stays in process, or `null` when it may go to the daemon. */
export function daemonScriptRouteExclusion(
  input: DaemonScriptRouteInput,
): 'platform' | 'caller' | 'latched' | null {
  if (!isDaemonScriptPlatformEligible(input.platform)) return 'platform';
  if (input.context?.localWindow !== true) return 'caller';
  if (input.daemonLatched) return 'latched';
  return null;
}

/** Whether a renderer run may go to the daemon, as code. */
export function isDaemonScriptRouteEligible(
  input: DaemonScriptRouteInput,
): boolean {
  return daemonScriptRouteExclusion(input) === null;
}

function hostPlatform(): PlatformOperatingSystem | null {
  try {
    return hostPlatformOperatingSystem();
  } catch {
    return null;
  }
}

/** Reads only local state: the platform and the health latch. */
export function selectDaemonScripts(
  context: DaemonScriptRouteContext | undefined,
): boolean {
  const exclusion = daemonScriptRouteExclusion({
    platform: hostPlatform(),
    context,
    daemonLatched: getElectronDaemonHealth().isLatched(),
  });
  if (exclusion !== null) recordDaemonRoute('scripts', exclusion);
  return exclusion === null;
}

/** As `noteDaemonCodeGraphFallback`, for the `scripts` consumer. */
export function noteDaemonScriptFallback(error: unknown): boolean {
  const reason = daemonUnreachableReason(error);
  if (reason === null) return false;
  getElectronDaemonHealth().noteFallback('scripts', reason);
  return true;
}

const owner = new AbortController();

/** Main's own script session with the daemon, under its verified authority. */
async function client(): Promise<ElectronDaemonClient> {
  getElectronDaemonHealth().setConsumerEnabled('scripts', true);
  const { authorityId } = await getElectronDaemonFilesContext();
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-main:scripts',
    authorityId,
    interfaceKind: 'desktop',
    grants: [WORKER_SCRIPT_GRANTS.execute, WORKER_SCRIPT_GRANTS.read],
  };
  return (await getElectronDaemonConnections().get(caller, owner.signal))
    .client;
}

/** A call on a fresh session; one the session dropped under reads as unreachable. */
async function onSession<T>(
  call: (session: ElectronDaemonClient) => Promise<T>,
): Promise<T> {
  const session = await client();
  try {
    return await call(session);
  } catch (error) {
    throw session.signal.aborted && !owner.signal.aborted
      ? markUnreachable(error, 'connection_lost')
      : error;
  }
}

/** Main's script session, for a write that must know whether it was sent (CAN-7663). */
export function daemonScriptSession(): Promise<ElectronDaemonClient> {
  return client();
}

/** As `onSession`, for the script reads and writes main routes (CAN-7663). */
export function onDaemonScriptSession<T>(
  call: (session: ElectronDaemonClient) => Promise<T>,
): Promise<T> {
  return onSession(call);
}

function transportFor(worker: ScriptExecutionWorker): RemoteScriptTransport {
  return {
    openOutput: async (params, onFrame) => {
      const session = await client();
      const handle = await session.openStream(
        'worker.script.execution.output',
        params,
      );
      let ended = false;
      const end = (completed: boolean): void => {
        if (ended) return;
        ended = true;
        onFrame({ kind: 'end', completed });
      };
      // A dropped connection ends the stream without an end frame.
      const dropped = (): void => end(false);
      session.signal.addEventListener('abort', dropped, { once: true });
      const unsubscribe = handle.onFrame((frame) => {
        if (ended) return;
        if (frame.kind === 'end') {
          session.signal.removeEventListener('abort', dropped);
          // `completed`: the run finished, so no output follows.
          end(frame.outcome === 'completed');
          return;
        }
        onFrame({ kind: 'item', item: frame.item });
      });
      return {
        close: (): void => {
          ended = true;
          session.signal.removeEventListener('abort', dropped);
          unsubscribe();
          handle.close();
        },
      };
    },
    execute: (params, options) =>
      onSession((session) =>
        session.instruction('worker.script.execute', params, {
          metadata: { idempotencyKey: options.idempotencyKey },
          execution: options.execution,
        }),
      ),
    cancel: (params, options) =>
      onSession((session) =>
        session.instruction('worker.script.execution.cancel', params, {
          metadata: { idempotencyKey: options.idempotencyKey },
        }),
      ),
    // The same run-log files the daemon writes, read in process.
    readRun: async (scope, scriptKey) =>
      (await worker.get({ scope, scriptKey, tailLines: 0 })).run?.execution ??
      null,
    isUnreachable: (error) => daemonUnreachableReason(error) !== null,
  };
}

function hostExecution(env: NodeJS.ProcessEnv): CanopyHostExecution | null {
  const childEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (key === '' || key.includes('=') || key.includes('\0')) continue;
    if (value.includes('\0')) continue;
    childEnvironment[key] = value;
  }
  const parsed = CanopyHostExecutionSchema.safeParse({ childEnvironment });
  return parsed.success ? parsed.data : null;
}

async function canonical(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** D9's run-log half: the worktree's run logs are where the daemon keeps them. */
export function isDaemonScriptRunLogPlace(scope: {
  readonly workspaceId: string;
  readonly worktreeId: string;
}): boolean {
  try {
    return (
      relative(
        getResolvedCanopyDataDir().path,
        resolveScriptRunDir(scope.workspaceId, scope.worktreeId),
      ) ===
      join('workspaces', scope.workspaceId, 'script-runs', scope.worktreeId)
    );
  } catch {
    return false;
  }
}

/** D9: the run logs and starts where it would in process, or it stays in process. */
async function samePlace(
  params: WorkerScriptExecuteParams,
  scope: { readonly workspaceId: string; readonly worktreeId: string },
  cwd: string,
): Promise<boolean> {
  try {
    if (!isDaemonScriptRunLogPlace(scope)) return false;
    const catalog = await readFilesystemScope(
      scope,
      await (
        await getDaemonScopeResolver()
      )(scope, 'roots'),
      'roots',
    );
    const directory = scriptContextDirectory(catalog, scope, params.context);
    if (directory === null) return false;
    const [wanted, daemon] = await Promise.all([
      canonical(cwd),
      canonical(directory),
    ]);
    return wanted !== null && wanted === daemon;
  } catch {
    return false;
  }
}

function withoutSecrets(
  params: WorkerScriptExecuteParams,
): WorkerScriptExecuteParams {
  const forwarded = { ...params };
  delete forwarded.secrets;
  return forwarded;
}

/** The dispatcher's daemon branch for one claimed run (D12), recorded once (CAN-5093). */
export function executeScriptInDaemon(
  args: Parameters<typeof executeScriptRoute>[0],
): ReturnType<typeof executeScriptRoute> {
  return recordDaemonRouteDecision('scripts', (note) =>
    executeScriptRoute(args, note),
  );
}

async function executeScriptRoute(
  args: {
    readonly params: WorkerScriptExecuteParams;
    readonly signal: AbortSignal;
    /** The in-process worker: its observers get the relay, and it runs the fallback. */
    readonly worker: ScriptExecutionWorker;
  },
  note: DaemonRouteNote<'scripts'>,
): Promise<{
  readonly result: WorkerScriptExecuteResult;
  readonly servedByDaemon: boolean;
}> {
  const { params, signal, worker } = args;
  // The grant is one-shot: redeemed here, it serves the fallback too.
  const redeemed = await redeemExecutionSecrets(
    getDesktopExecutionSecrets(),
    { operation: 'worker.script.execute', key: params.executionId },
    params.secrets,
    signal,
  );
  const place = await (
    await import('./script-execution-place')
  ).resolveScriptExecutionPlace(params.scope, params.context, redeemed);
  const inProcess = async (
    runSignal: AbortSignal = signal,
  ): Promise<{
    readonly result: WorkerScriptExecuteResult;
    readonly servedByDaemon: boolean;
  }> => ({
    result: await worker.execute(params, runSignal, { secrets: redeemed }),
    servedByDaemon: false,
  });

  const { record } = params;
  const { workspaceId, worktreeId } = params.scope;
  if (
    record === undefined ||
    workspaceId === undefined ||
    worktreeId === undefined
  ) {
    note('scope');
    return inProcess();
  }
  const execution = hostExecution(place.env);
  if (execution === null) {
    note('environment');
    return inProcess();
  }
  const scope = { workspaceId, worktreeId };
  if (!(await samePlace(params, scope, place.cwd))) {
    note('place');
    return inProcess();
  }
  try {
    await client();
  } catch (error) {
    note(noteDaemonScriptFallback(error) ? 'unreachable' : 'refused');
    return inProcess();
  }

  // The worktree fences again after the awaits above, with nothing awaited
  // before the run is mirrored: a drain either sees it or refuses it.
  assertWorkspaceTargetRuntimeStartAllowed(workspaceId, worktreeId);
  const entry = daemonScriptRuns.begin({
    projectId: workspaceId,
    worktreeId,
    scriptKey: record.script.scriptKey,
    runId: params.executionId,
    kind: 'script',
    script: record.script,
    invocation: record.invocation,
    logRef: {
      projectId: workspaceId,
      worktreeId,
      script: record.script,
      runId: params.executionId,
    },
  });
  try {
    const relay = worker.relay(params.executionId);
    const outcome = await runScriptRemotely(transportFor(worker), {
      params: withoutSecrets(params),
      execution,
      signal: AbortSignal.any([signal, entry.signal]),
      relay: {
        started: (): void => {
          // The daemon runs it from here, however it later ends.
          note('served');
          relay.processStarted();
          entry.markStarted();
        },
        lines: (lines): void => relay.lines(lines),
      },
      createIdempotencyKey: randomUUID,
    });
    if (outcome.kind === 'not-started') {
      note(outcome.reason === 'unreachable' ? 'unreachable' : 'refused');
      if (outcome.reason === 'unreachable')
        getElectronDaemonHealth().noteFallback('scripts', 'connection_lost');
      else
        logMainProcessWarn(
          'Daemon scripts are unavailable; running the script in the app.',
        );
      // A stop, or a drain that came first or is still under way, ends the
      // run here: nothing runs.
      if (entry.fenced()) {
        const cancelled: WorkerScriptExecuteResult = {
          executionId: params.executionId,
          status: 'cancelled',
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputBytes: 0,
          outputTruncated: false,
          recorded: false,
        };
        relay.finished({
          success: false,
          exitCode: null,
          output: '',
          timedOut: false,
          durationMs: 0,
          outputBytes: 0,
          outputTruncated: false,
          failure: null,
        });
        return { result: cancelled, servedByDaemon: false };
      }
      entry.end();
      return await inProcess(AbortSignal.any([signal, entry.signal]));
    }
    const { result, output } = outcome;
    relay.finished({
      success: result.status === 'success',
      exitCode: result.exitCode,
      output,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      outputBytes: result.outputBytes,
      outputTruncated: result.outputTruncated,
      failure: null,
    });
    entry.settle(result);
    note('served');
    return { result, servedByDaemon: true };
  } catch (error) {
    throw error instanceof CanopyClientError
      ? new CanopyOperationError(error.payload, error)
      : error;
  } finally {
    entry.end();
  }
}

/**
 * The run-log pass of a worktree drain: drains the script keys of running
 * runs this process does not run itself, including the ones it mirrors. The
 * log keeps only each key's latest run, so the drain names the key, not a
 * run, and the daemon drains every run of it there. A drain answers once
 * each run's whole process tree has exited (CAN-5839); a mirrored run's own
 * abort only stops it, which answers when its shell exits.
 */
async function sweepDaemonScriptRuns(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  if (!isDaemonScriptPlatformEligible(hostPlatform())) return;
  try {
    const scope = { workspaceId: projectId, worktreeId };
    const local = new Set(
      desktopScriptWorker.registry
        .list()
        .flatMap((tracking) => tracking.runId ?? tracking.logRef?.runId ?? []),
    );
    const { runs } = await desktopScriptWorker.list({ scope, tailLines: 0 });
    const scriptKeys = new Set(
      runs
        .filter(
          ({ execution }) =>
            execution.status === 'running' && !local.has(execution.executionId),
        )
        .map(({ execution }) => execution.script.scriptKey),
    );
    if (scriptKeys.size === 0) return;
    // Bounds the connection as well as the cancels.
    const deadline = AbortSignal.timeout(10_000);
    const expired = new Promise<never>((_resolve, reject) => {
      deadline.addEventListener(
        'abort',
        () => reject(new Error('The daemon did not answer the drain in time.')),
        {
          once: true,
        },
      );
    });
    expired.catch(() => undefined);
    await Promise.race([
      expired,
      Promise.all(
        Array.from(scriptKeys, (scriptKey) =>
          onSession((session) =>
            session.instruction(
              'worker.script.execution.cancel',
              { scope, scriptKey, drain: true },
              {
                metadata: { idempotencyKey: randomUUID() },
                signal: deadline,
              },
            ),
          ),
        ),
      ),
    ]);
  } catch {
    logMainProcessWarn('Daemon script runs were not drained.', {
      reason: 'daemon refused or unreachable',
    });
  }
}

/** Electron main's daemon script runs, registered with `setExternalScriptRuns` when this module loads. */
export const daemonScriptRuns: DaemonScriptRuns = new DaemonScriptRuns({
  sweep: sweepDaemonScriptRuns,
});
setExternalScriptRuns(daemonScriptRuns);

/** Worktree removal: ends this worktree's daemon runs, mirrored or not (D17). Never rejects. */
export async function drainDaemonScriptWorktree(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  if (!isDaemonScriptPlatformEligible(hostPlatform())) return;
  await daemonScriptRuns.drainWorktree(projectId, worktreeId).catch(() => {
    logMainProcessWarn('Daemon script runs were not drained.', {
      reason: 'daemon refused or unreachable',
    });
  });
}
