import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  CanopyHostExecution,
  WorkerScriptContext,
  WorkerScriptExecuteParams,
} from '@canopy/protocol/canopy-core';

import {
  refusingExecutionSecretSource,
  type ExecutionSecretSource,
  type RedeemedExecutionSecrets,
} from '../../../execution-secrets';
import type { CanopyHandlerContext } from '../../../../runtime/types';
import {
  ScriptExecutionWorker,
  scriptRunFileStem,
  type ScriptChildProcess,
  type ScriptExecutionWorkerHost,
} from '..';

export const describePosix =
  process.platform === 'win32' ? describe.skip : describe;

export const SCOPE = { workspaceId: 'project', worktreeId: 'task' } as const;

export interface PlaceCall {
  readonly secrets: RedeemedExecutionSecrets;
  readonly execution: CanopyHostExecution | undefined;
}

export interface ScriptWorkerFixture {
  readonly dir: string;
  readonly worker: ScriptExecutionWorker;
  readonly places: PlaceCall[];
  cleanup(): Promise<void>;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A minimal POSIX host: Node `spawn` detached, run logs in a temp directory. */
export async function createScriptWorkerFixture(
  options: {
    readonly secrets?: ExecutionSecretSource;
    /** Replaces host members, for a host whose processes behave otherwise. */
    readonly host?: Partial<ScriptExecutionWorkerHost>;
  } = {},
): Promise<ScriptWorkerFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'script-worker-'));
  const places: PlaceCall[] = [];
  const host: ScriptExecutionWorkerHost = {
    secrets: options.secrets ?? refusingExecutionSecretSource,
    authorityId: 'local',
    platform: () => process.platform,
    findExecutable: (name) =>
      ['/bin', '/usr/bin'].map((entry) => join(entry, name)).find(executable) ??
      null,
    windowsGitBash: () => null,
    cmdCommandLine: (scriptPath) => scriptPath,
    loginShell: () => '/bin/sh',
    comSpec: () => undefined,
    prepareLaunch: (command, args) => ({ command, args }),
    lowerPriority: () => undefined,
    spawn: (command, args, spawnOptions): ScriptChildProcess => {
      const child = spawn(command, args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      return {
        get pid(): number | undefined {
          return child.pid;
        },
        stdout: child.stdout && {
          onData: (listener): void => {
            child.stdout?.on('data', listener);
          },
          destroy: (): void => {
            child.stdout?.destroy();
          },
        },
        stderr: child.stderr && {
          onData: (listener): void => {
            child.stderr?.on('data', listener);
          },
          destroy: (): void => {
            child.stderr?.destroy();
          },
        },
        onError: (listener): void => {
          child.on('error', listener);
        },
        onClose: (listener): void => {
          child.on('close', listener);
        },
        killGroup: (signal): void => {
          if (child.pid === undefined) return;
          try {
            process.kill(-child.pid, signal);
          } catch {
            // Already gone.
          }
        },
      };
    },
    drainOwnedProcess: (pid, isOwned): Promise<void> => {
      if (isOwned())
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      return Promise.resolve();
    },
    logPaths: {
      runDir: (projectId, worktreeId): string =>
        join(dir, 'runs', projectId, worktreeId),
      fileStem: scriptRunFileStem,
    },
    logFiles: {
      writeFileAtomically: async (path, text): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, text, 'utf8');
        await rename(temp, path);
      },
    },
    resolvePlace: (_scope, _context, secrets, execution) => {
      places.push({ secrets, execution });
      return Promise.resolve({
        cwd: dir,
        env: {
          // Keep login-shell startup inside the fixture.
          HOME: dir,
          ...(execution?.childEnvironment ?? { PATH: '/usr/bin:/bin' }),
          ...secrets.env,
        },
      });
    },
  };
  const worker = new ScriptExecutionWorker({ ...host, ...options.host });
  return {
    dir,
    worker,
    places,
    cleanup: async (): Promise<void> => {
      await worker.registry.drainAll();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const context: WorkerScriptContext = { kind: 'project' };

export function scriptParams(
  command: string,
  overrides: Partial<WorkerScriptExecuteParams> = {},
): WorkerScriptExecuteParams {
  const executionId = overrides.executionId ?? randomUUID();
  return {
    scope: SCOPE,
    executionId,
    context,
    command,
    shellStartup: 'login',
    timeoutMs: null,
    priority: 'normal',
    record: {
      script: {
        scriptKey: 'dev',
        scriptName: 'dev',
        label: 'Dev',
        command,
        lifecycle: 'custom',
        target: 'project',
      },
      invocation: 'manual-run',
    },
    ...overrides,
  };
}

export function handlerContext(
  overrides: Partial<CanopyHandlerContext> = {},
): CanopyHandlerContext {
  return {
    requestId: randomUUID(),
    caller: {
      principalId: 'test',
      clientInstanceId: 'test',
      authorityId: 'local',
      interfaceKind: 'desktop',
      grants: ['worker.script.execute', 'worker.script.read'],
    },
    metadata: { idempotencyKey: randomUUID() },
    signal: new AbortController().signal,
    ...overrides,
  };
}
