import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { withW5ProcessFileLocks } from '@canopy/core-platform/w5-process-file-lock';
import {
  buildCmdCommandLine,
  findExecutableOnPath,
  resolveWindowsGitBash,
} from '@canopy/core-platform/windows-shells';
import {
  defineRuntimeModule,
  type PlatformExecutionProcessServices,
  type PlatformOperatingSystem,
  type PlatformSupervisionServices,
  type RuntimeModule,
} from '@canopy/core-runtime';
import {
  filesystemSnapshotFailure,
  isFilesystemSnapshotUnavailable,
  readFilesystemScope,
  type FilesystemScopeResolver,
} from '@canopy/core-runtime/node';
import { refusingExecutionSecretSource } from '@canopy/core-runtime/node/execution-secrets';
import { validateId } from '@canopy/core-runtime/node/identifiers';
import {
  createWorkerScriptHandlers,
  createWorkerScriptStreamHandlers,
  isScriptRunChildIdentified,
  ScriptExecutionWorker,
  scriptContextDirectory,
  scriptContextUnavailableError,
  scriptRunFileStem,
  type ScriptExecutionWorkerHost,
  type ScriptRunLogStore,
  type ScriptRunWriter,
  type ScriptRunChild,
  type ScriptRunChildReap,
  type ScriptRunChildStop,
  type ScriptRunGroupListing,
  type ScriptRunGroupStop,
  type ScriptRunWriterFence,
  type ScriptRunWriterState,
  scriptRunGroupRemains,
  stopScriptRunChild,
  listScriptRunGroup,
  forceStopScriptRunGroup,
} from '@canopy/core-runtime/node/script/execution';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  WORKER_SCRIPT_GRANTS,
  WORKER_SCRIPT_INSTRUCTION_DEFINITIONS,
  WORKER_SCRIPT_QUERY_DEFINITIONS,
  WORKER_SCRIPT_STREAM_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { DaemonExecutionAccounting } from './execution';
import { createDaemonScriptProcessHost } from './script-processes';

/** Every `worker.script.*` operation the daemon serves (CAN-5087). */
export const DAEMON_SCRIPT_DEFINITIONS = {
  queries: WORKER_SCRIPT_QUERY_DEFINITIONS,
  instructions: WORKER_SCRIPT_INSTRUCTION_DEFINITIONS,
  streams: WORKER_SCRIPT_STREAM_DEFINITIONS,
};

/** The caller a daemon-internal service, such as CAN-4737's worktree setup, runs scripts as. */
export function daemonScriptCoreCaller(
  authorityId: string,
): CanopyCallerDescriptor {
  return {
    principalId: 'core',
    clientInstanceId: 'daemon-core:scripts',
    authorityId,
    interfaceKind: 'daemon',
    grants: [WORKER_SCRIPT_GRANTS.execute, WORKER_SCRIPT_GRANTS.read],
  };
}

export interface DaemonScriptOptions {
  readonly os: PlatformOperatingSystem;
  readonly authorityId: string;
  readonly canonicalDataRoot: string;
  /** The daemon's own environment snapshot; a run without `_execution` gets it. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly resolveScope: FilesystemScopeResolver;
  readonly processes: PlatformExecutionProcessServices;
  readonly supervision: Pick<
    PlatformSupervisionServices,
    'inspectProcess' | 'identifyProcess' | 'listProcessGroup'
  >;
  readonly accounting?: DaemonExecutionAccounting;
}

function stringEntries(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment))
    if (typeof value === 'string') entries[key] = value;
  return entries;
}

/** The account's login shell from the user database, when it has one. */
function accountShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    // No user database entry, as in some containers.
    return undefined;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomically(path: string, text: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The rename is in place; a directory sync is best effort.
  }
}

/**
 * The daemon's script run writer fence (CAN-5087), which also identifies a
 * script's process as it starts and reaps it after a restart only when its
 * PID, process group, start identity and executable path all match what the
 * OS reports now (CAN-6482); exported for tests.
 */
export function daemonScriptRunWriterFence(
  supervision: Pick<
    PlatformSupervisionServices,
    'inspectProcess' | 'identifyProcess' | 'listProcessGroup'
  >,
): ScriptRunWriterFence {
  let self: Promise<ScriptRunWriter | null> | undefined;
  return {
    spawner: 'daemon',
    self: (): Promise<ScriptRunWriter | null> => {
      self ??= supervision
        .inspectProcess({ pid: process.pid })
        .then((found) =>
          found.state === 'running'
            ? { pid: process.pid, startIdentity: found.startIdentity }
            : null,
        );
      return self;
    },
    inspect: async (writer): Promise<ScriptRunWriterState> => {
      try {
        const found = await supervision.inspectProcess({ pid: writer.pid });
        if (found.state === 'running')
          return found.startIdentity === writer.startIdentity
            ? 'running'
            : 'gone';
        return found.state === 'absent' ? 'gone' : 'unverifiable';
      } catch {
        return 'unverifiable';
      }
    },
    identifyChild: async (pid): Promise<ScriptRunChild | null> => {
      let found = await supervision.identifyProcess?.({ pid });
      // A child read between fork and exec still runs this executable; read
      // it again once it runs its own, for at most a second.
      for (
        let attempt = 0;
        attempt < 10 &&
        found?.state === 'running' &&
        found.executablePath === process.execPath;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        found = await supervision.identifyProcess?.({ pid });
      }
      if (found?.state === 'running')
        return {
          pid,
          processGroupId: found.processGroupId,
          startIdentity: found.startIdentity,
          executablePath: found.executablePath,
        };
      // An unreadable identity still records the PID: a restart then reports
      // the run orphaned while it runs, and never reaps it.
      return found?.state === 'absent' ? null : { pid };
    },
    reapChild: async (child, options): Promise<ScriptRunChildReap> => {
      if (!supervision.identifyProcess) {
        const seen = await supervision.inspectProcess({ pid: child.pid });
        return seen.state === 'absent' ? 'gone' : 'unproven';
      }
      const found = await supervision.identifyProcess({ pid: child.pid });
      // A recorded leader that exited while its group lives on leaves the
      // run orphaned: those processes may be the run's, and are not proven.
      if (found.state === 'absent')
        return child.processGroupId !== undefined &&
          scriptRunGroupRemains(child.processGroupId)
          ? 'unproven'
          : 'gone';
      // Another start identity holds the PID: the recorded process ended,
      // so the run is lost, with nothing signalled.
      if (
        found.state === 'running' &&
        child.startIdentity !== undefined &&
        found.startIdentity !== child.startIdentity
      )
        return child.processGroupId !== undefined &&
          scriptRunGroupRemains(child.processGroupId)
          ? 'unproven'
          : 'gone';
      if (
        found.state !== 'running' ||
        child.startIdentity === undefined ||
        child.processGroupId === undefined ||
        child.executablePath === undefined ||
        found.processGroupId !== child.processGroupId ||
        found.executablePath !== child.executablePath
      )
        return 'unproven';
      // A proven run another host started is left running (CAN-7517).
      if (options?.signal === false) return 'unproven';
      try {
        process.kill(-child.processGroupId, 'SIGKILL');
      } catch (error) {
        const code: unknown =
          typeof error === 'object' && error !== null
            ? Reflect.get(error, 'code')
            : undefined;
        return code === 'ESRCH' ? 'gone' : 'unproven';
      }
      return 'reaped';
    },
    // Never a signal by PID alone (CAN-7520).
    refusesUnidentifiedStop: true,
    stopChild: (child, mode): Promise<ScriptRunChildStop> =>
      isScriptRunChildIdentified(child)
        ? stopScriptRunChild({ child, mode, supervision })
        : Promise.resolve('unverifiable'),
    listGroup: (child, runStartedAtMs, runId): Promise<ScriptRunGroupListing> =>
      listScriptRunGroup({ child, runStartedAtMs, runId, supervision }),
    stopGroup: (
      child,
      runStartedAtMs,
      runId,
      members,
    ): Promise<ScriptRunGroupStop> =>
      forceStopScriptRunGroup({
        child,
        runStartedAtMs,
        runId,
        members,
        supervision,
      }),
  };
}

/** The trusted host of the daemon's script worker; exported for tests. */
export function createDaemonScriptHost(
  options: DaemonScriptOptions,
): ScriptExecutionWorkerHost {
  const processes = createDaemonScriptProcessHost({
    processes: options.processes,
    ...(options.accounting && { accounting: options.accounting }),
  });
  return {
    secrets: refusingExecutionSecretSource,
    authorityId: options.authorityId,
    targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
    platform: () => options.os,
    // Windows: cmd, PowerShell and Git Bash, resolved as Electron main does (CAN-5091).
    windowsGitBash: () =>
      options.os === 'win32'
        ? resolveWindowsGitBash(options.environment)
        : null,
    comSpec: () => options.environment.ComSpec ?? options.environment.COMSPEC,
    cmdCommandLine: (scriptPath) => buildCmdCommandLine(scriptPath),
    loginShell: () => {
      if (options.os === 'win32') return undefined;
      // launchd starts the daemon without SHELL; the account still names one.
      const shell = options.environment.SHELL ?? accountShell();
      return shell !== undefined && isAbsolute(shell) ? shell : undefined;
    },
    findExecutable: (name) => {
      if (options.os === 'win32')
        return findExecutableOnPath(name, {
          os: 'win32',
          pathEnv: options.environment.PATH ?? options.environment.Path ?? '',
          ...(options.environment.PATHEXT !== undefined && {
            pathExt: options.environment.PATHEXT,
          }),
        });
      if (isAbsolute(name)) return isExecutableFile(name) ? name : null;
      for (const directory of (options.environment.PATH ?? '').split(':')) {
        if (directory === '') continue;
        const candidate = join(directory, name);
        if (isExecutableFile(candidate)) return candidate;
      }
      return null;
    },
    spawn: processes.spawn,
    prepareLaunch: processes.prepareLaunch,
    lowerPriority: processes.lowerPriority,
    drainOwnedProcess: processes.drainOwnedProcess,
    registerProcess: processes.registerProcess,
    logPaths: {
      runDir: (projectId, worktreeId): string => {
        validateId(projectId, 'workspace id');
        validateId(worktreeId, 'worktree id');
        return join(
          options.canonicalDataRoot,
          'workspaces',
          projectId,
          'script-runs',
          worktreeId,
        );
      },
      fileStem: scriptRunFileStem,
    },
    logFiles: { writeFileAtomically },
    writerFence: daemonScriptRunWriterFence(options.supervision),
    // Electron main writes the same run logs under the same lock (CAN-5839).
    logLock: {
      run: (runDir, work) =>
        withW5ProcessFileLocks(
          [runDir],
          { dataRoot: options.canonicalDataRoot },
          work,
        ),
    },
    resolvePlace: async (scope, context, _secrets, execution) => {
      // The daemon has no automation home or shared-container run copy.
      if (
        context.kind === 'automation-home' ||
        context.kind === 'shared-container'
      )
        throw scriptContextUnavailableError();
      const { workspaceId, worktreeId } = scope;
      try {
        validateId(workspaceId, 'workspace id');
        validateId(worktreeId, 'worktree id');
      } catch {
        throw scriptContextUnavailableError();
      }
      const workspaceScope = { workspaceId, worktreeId };
      let cwd: string | null;
      try {
        const catalog = await readFilesystemScope(
          workspaceScope,
          await options.resolveScope(workspaceScope, 'roots'),
          'roots',
        );
        cwd = scriptContextDirectory(catalog, workspaceScope, context);
      } catch (error) {
        // A catalog the system refused to read is not a missing checkout.
        if (isFilesystemSnapshotUnavailable(error))
          throw filesystemSnapshotFailure(error);
        throw scriptContextUnavailableError();
      }
      if (cwd === null) throw scriptContextUnavailableError();
      // `_secrets` is always empty: the refusing source refuses any binding
      // before the place is resolved.
      return {
        cwd,
        env: execution
          ? { ...execution.childEnvironment }
          : stringEntries(options.environment),
      };
    },
  };
}

async function childDirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    try {
      validateId(entry.name, 'directory name');
      return [entry.name];
    } catch {
      return [];
    }
  });
}

/**
 * One pass over every run the daemon's run logs record (CAN-7663), as the
 * daemon starts and before it serves a script read: each is reconciled as a
 * reap, so a proven process a dead core left is ended while get and list
 * never signal. A worktree that fails is logged and the pass carries on;
 * exported for tests.
 */
export async function reapInterruptedScriptRuns(options: {
  readonly canonicalDataRoot: string;
  readonly logs: Pick<ScriptRunLogStore, 'reapRuns'>;
  readonly log?: (line: string) => void;
  readonly signal?: AbortSignal;
}): Promise<{ checked: number; failed: number }> {
  const log =
    options.log ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const totals = { checked: 0, failed: 0 };
  const workspaces = join(options.canonicalDataRoot, 'workspaces');
  for (const projectId of await childDirectories(workspaces)) {
    const runs = join(workspaces, projectId, 'script-runs');
    for (const worktreeId of await childDirectories(runs)) {
      if (options.signal?.aborted) return totals;
      const place = `${projectId}/${worktreeId}`;
      try {
        const pass = await options.logs.reapRuns({ projectId, worktreeId });
        totals.checked += pass.checked;
        totals.failed += pass.failed.length;
        for (const file of pass.failed)
          log(`[worker.script] start-up reap skipped ${place}/${file}\n`);
      } catch (error) {
        totals.failed += 1;
        log(
          `[worker.script] start-up reap skipped ${place}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
  return totals;
}

/**
 * `worker.script.*` over a script worker in this process (CAN-5087). Runs are
 * detached from their requests: a run ends on a cancel from any leased
 * client, its timeout, or this module's phase 5 stop, which drains every run.
 * Runs hold no keep-alive obligation (D6), so an orphaned run ends at the
 * latest when the daemon idle-stops.
 */
export function createDaemonScriptModule(
  options: DaemonScriptOptions,
): RuntimeModule {
  const worker = new ScriptExecutionWorker(createDaemonScriptHost(options));
  const handlers = createWorkerScriptHandlers(worker, { detached: true });
  return defineRuntimeModule({
    name: 'worker.script',
    plane: 'worker',
    services: [
      {
        name: 'worker.script.runs',
        plane: 'worker',
        // Before any script read: a dead core's proven processes (CAN-7663).
        start: async (signal): Promise<void> => {
          await reapInterruptedScriptRuns({
            canonicalDataRoot: options.canonicalDataRoot,
            logs: worker.logs,
            signal,
          });
        },
        stop: {
          5: async (): Promise<void> => {
            try {
              await worker.stop();
            } finally {
              await options.processes.shutdown();
            }
          },
        },
      },
    ],
    definitions: DAEMON_SCRIPT_DEFINITIONS,
    handlers: {
      queries: handlers.queries,
      instructions: handlers.instructions,
      streams: createWorkerScriptStreamHandlers(worker),
    },
  });
}
