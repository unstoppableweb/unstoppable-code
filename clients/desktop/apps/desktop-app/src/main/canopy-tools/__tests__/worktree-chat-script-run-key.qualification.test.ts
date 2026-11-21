import type * as CanopyPaths from '@canopy/execution-engine/canopy-paths';
import type * as NodePath from 'node:path';
import type * as ScriptsServiceModule from '../../services/scripts-service';
import type * as WorkspaceRegistryModule from '../../lib/workspace-registry';
import type * as WorkspacePersistenceModule from '../../lib/workspace-persistence';
import type * as ScriptOutputModule from '../../mcp/script-output';
import type * as ScriptExecutionModule from '../../lib/script-execution';
import type * as ScriptEventsModule from '../../lib/script-events';
import { randomUUID } from 'node:crypto';
import { windowAgentInterfacePort } from '../../agents/agent-interface-port';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ScriptDescriptor,
  ScriptRunResponse,
} from '@canopy/desktop-shared/types';
import type { WorkerScriptExecuteParams } from '@canopy/protocol/canopy-core';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';

let mockRoot: string;
jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));
jest.mock('@canopy/execution-engine/canopy-paths', () => {
  const actual = jest.requireActual<typeof CanopyPaths>(
    '@canopy/execution-engine/canopy-paths',
  );
  const path = jest.requireActual<typeof NodePath>('node:path');
  return {
    ...actual,
    getEnvironmentConfigFilePath: (): string =>
      path.join(mockRoot, 'fixtures', 'environments.json'),
  };
});
jest.mock('../../lib/user-environment-store', () => ({
  readEnvironmentConfig: jest.fn(),
}));
jest.mock('../../lib/github-pat-env', () => ({
  readGitHubPatForExecution: jest.fn(() => null),
}));
jest.mock('../../lib/linear-auth', () => ({
  resolveLinearToken: jest.fn(() => null),
}));
jest.mock('../../resource-monitor', () => ({
  getResourceMonitorService: (): unknown => ({
    registerProcess: (): unknown => ({ unregister: (): void => undefined }),
  }),
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToAllWindows: jest.fn(),
}));
// Real exports are read on use: requiring them inside a factory re-enters it
// through the main-process import graph.
function partialMock<T extends object>(path: string, overrides: object): T {
  return new Proxy(overrides, {
    get: (target, key): unknown =>
      key in target
        ? Reflect.get(target, key)
        : Reflect.get(jest.requireActual<T>(path), key),
  }) as T;
}
jest.mock('../../lib/workspace-registry', () =>
  partialMock<typeof WorkspaceRegistryModule>('../../lib/workspace-registry', {
    getWorkspaceType: (): 'single-repo' => 'single-repo',
  }),
);
jest.mock('../../lib/workspace-persistence', () =>
  partialMock<typeof WorkspacePersistenceModule>(
    '../../lib/workspace-persistence',
    {
      readWorkspaceWorktrees: (): Promise<Array<{ id: string }>> =>
        Promise.resolve([{ id: 'worktree' }, { id: 'other-worktree' }]),
    },
  ),
);
jest.mock('../../mcp/script-output', () =>
  partialMock<typeof ScriptOutputModule>('../../mcp/script-output', {
    resolveScriptKey: (input: {
      scriptId: string;
    }): Promise<{ scriptKey: string }> =>
      Promise.resolve({ scriptKey: input.scriptId }),
  }),
);
// The configured scripts, and the Scripts section's run service reduced to
// the real script execution it delegates to and the renderer events it sends
// around it.
const started: Array<{ scriptKey: string; runId: string | undefined }> = [];
jest.mock('../../services/scripts-service', () =>
  partialMock<typeof ScriptsServiceModule>('../../services/scripts-service', {
    listWorktreeScriptEntries: (target: {
      projectId: string;
      worktreeId: string;
    }): Promise<ScriptsServiceModule.WorktreeScriptEntry[]> =>
      Promise.resolve(
        ['build', 'lint', 'serve'].map((key) => ({
          descriptor: descriptor(key),
          request: {
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            scriptKey: key,
          } as unknown as ScriptsServiceModule.WorktreeScriptEntry['request'],
        })),
      ),
    runScript: async (
      request: { projectId: string; worktreeId: string; scriptKey: string },
      options: ScriptsServiceModule.RunScriptOptions = {},
    ): Promise<ScriptRunResponse> => {
      started.push({ scriptKey: request.scriptKey, runId: options.runId });
      const { runDesktopScript } = jest.requireActual<
        typeof ScriptExecutionModule
      >('../../lib/script-execution');
      const events = jest.requireActual<typeof ScriptEventsModule>(
        '../../lib/script-events',
      );
      const { projectId, worktreeId } = request;
      const script = descriptor(request.scriptKey);
      const runId = options.runId ?? randomUUID();
      options.onRendererStarted?.(
        events.createScriptStartedEvent(
          projectId,
          worktreeId,
          script,
          'manual-run',
          runId,
        ),
      );
      let response: ScriptRunResponse = {
        success: false,
        exitCode: 1,
        output: '',
        timedOut: false,
        durationMs: 0,
      };
      try {
        const result = await runDesktopScript(
          {
            projectId,
            worktreeId,
            context: { kind: 'project' },
            script,
            invocation: 'manual-run',
            command: command(request.scriptKey),
            shell: { mac: 'bash', linux: 'bash' },
            timeoutSeconds: 60,
            interactive: false,
            runId,
            ...(options.keyed ? { keyed: true } : {}),
          },
          {
            observer: {
              onProcessStarted: (): void => options.onExecutionStarted?.(),
              onLines: (lines): void =>
                options.onRendererOutput?.(
                  events.createScriptOutputEvent(
                    projectId,
                    worktreeId,
                    script,
                    'manual-run',
                    lines,
                    runId,
                  ),
                ),
            },
          },
        );
        response = result.response;
        return response;
      } finally {
        options.onRendererComplete?.(
          events.createScriptCompleteEvent(
            projectId,
            worktreeId,
            script,
            'manual-run',
            response,
            runId,
          ),
        );
      }
    },
  }),
);

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function command(key: string): string {
  // `serve` says it is up, then keeps running until it is stopped.
  const source =
    key === 'serve'
      ? 'process.stdout.write("up\\n"); setTimeout(() => undefined, 60000)'
      : `process.stdout.write(${JSON.stringify(key)})`;
  return `${quote(process.execPath)} -e ${quote(source)}`;
}
function descriptor(key: string): ScriptDescriptor {
  return {
    scriptKey: key,
    scriptName: key,
    label: key,
    command: command(key),
    lifecycle: 'custom',
    target: 'project',
  };
}

import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { createWorkerScriptAdapter } from '../../canopy-runtime/worker-script-adapter';
import {
  initializeUserEnvironmentRuntime,
  invalidateUserEnvironmentInjectionCache,
} from '../../lib/user-environment-runtime';
import { readEnvironmentConfig } from '../../lib/user-environment-store';
import * as paths from '../../lib/paths';
import { sendToWindow } from '../../lib/window-send';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { desktopLegacyActionFamily } from '../../agent-actions/desktop-legacy-family';
import type { CanopyInjectedToolRuntime } from '../core';
import type { WorktreeActionRuntime } from '../worktree-actions';

let runtime: DesktopCanopyDispatcher;
let operations: CoreOperationAdapter;
let dispatched: WorkerScriptExecuteParams[];
let failNextDispatch: boolean;

function startRuntime(): void {
  operations = createCoreOperationAdapter({
    ledgerPath: (): string => join(mockRoot, 'ledger', 'operations.sqlite'),
  });
  const adapter = createWorkerScriptAdapter();
  const execute = adapter.instructions['worker.script.execute'];
  adapter.instructions['worker.script.execute'] = (
    params,
    context,
  ): ReturnType<typeof execute> => {
    dispatched.push(params);
    if (failNextDispatch) {
      failNextDispatch = false;
      return Promise.reject(new Error('The worker stopped.'));
    }
    return execute(params, context);
  };
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    workerScriptAdapter: adapter,
    shutdownTimeoutMs: 25,
  });
}

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'worktree-chat-script-run-key-'));
  for (const name of ['ledger', 'logs', 'checkout', 'fixtures', 'home'])
    mkdirSync(join(mockRoot, name));
  const config = createDefaultEnvironmentConfig('2026-11-16T00:00:00.000Z');
  writeFileSync(
    join(mockRoot, 'fixtures', 'environments.json'),
    JSON.stringify({ version: 2, data: config }),
  );
  jest
    .mocked(readEnvironmentConfig)
    .mockResolvedValue({ data: config, encryptionAvailable: true });
  jest
    .spyOn(paths, 'getWorktreeDir')
    .mockReturnValue(join(mockRoot, 'checkout'));
  jest
    .spyOn(paths, 'getWorktreeDataDir')
    .mockReturnValue(join(mockRoot, 'checkout'));
  jest
    .spyOn(paths, 'resolveScriptRunDir')
    .mockReturnValue(join(mockRoot, 'logs'));
  invalidateUserEnvironmentInjectionCache();
  initializeUserEnvironmentRuntime();
  dispatched = [];
  started.length = 0;
  failNextDispatch = false;
  jest.mocked(sendToWindow).mockClear();
  startRuntime();
});
afterEach(async () => {
  // Read once: a hook that outlived its timeout must not touch the next case.
  const current = runtime;
  const root = mockRoot;
  try {
    try {
      await stopServe(current);
    } finally {
      await current.shutdown();
    }
  } finally {
    invalidateUserEnvironmentInjectionCache();
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

/** Stops the long-running `serve` fixture, so no run outlives its test. */
async function stopServe(current: typeof runtime): Promise<void> {
  await current.scriptRuns.cancelInFlight({
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    scriptKey: 'serve',
  });
}

/**
 * A worktree chat's run_script through the family that serves it, with the
 * call identity the desktop surface gives it: the running turn, when known,
 * beside the provider's tool call id.
 */
async function runScript(
  scriptId: string,
  toolUseId: string | undefined,
  chat: {
    chatId?: string;
    worktreeId?: string;
    turnKey?: string | null;
    waitSeconds?: number;
    authorize?: () => Promise<boolean>;
  } = {},
): Promise<unknown> {
  const chatId = chat.chatId ?? 'chat-1';
  const worktreeId = chat.worktreeId ?? 'worktree';
  const turnKey = chat.turnKey === undefined ? 'turn-1' : chat.turnKey;
  const worktreeActionRuntime: WorktreeActionRuntime = {
    projectId: 'workspace',
    worktreeId,
    chatId,
    cwd: join(mockRoot, 'checkout'),
    getWindow: (): null => null,
    interfacePort: windowAgentInterfacePort(() => null),
    ...(chat.authorize ? { authorizeScriptCommand: chat.authorize } : {}),
  };
  const parsed = desktopLegacyActionFamily.parse({
    type: 'worktree.run_script',
    scriptId,
    waitSeconds: chat.waitSeconds ?? 30,
  });
  if (!parsed?.ok) throw new Error('The action did not parse');
  return parsed.dispatch({
    host: { worktreeActionRuntime } as unknown as CanopyInjectedToolRuntime,
    scope: { workspaceId: 'workspace', worktreeId, chatId },
    actorKey: 'local-desktop-user',
    ...(turnKey ? { turnKey } : {}),
    ...(toolUseId ? { toolUseId } : {}),
  });
}

async function sentOutput(): Promise<void> {
  const deadline = Date.now() + 3000;
  while (
    !jest
      .mocked(sendToWindow)
      .mock.calls.some(([, channel]) => channel === IPC_CHANNELS.scriptOutput)
  ) {
    if (Date.now() > deadline) throw new Error('The run sent no output.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('worktree chat script runs keyed by the tool call (CAN-5830)', () => {
  it('runs with an execution id derived from the tool call and answers a repeat from that run', async () => {
    const first = await runScript('build', 'tool-1');
    expect(first).toMatchObject({
      ok: true,
      result: { scriptKey: 'build', finished: true, success: true },
    });
    expect(started.map((run) => run.scriptKey)).toEqual(['build']);
    expect(started[0]?.runId).toMatch(/^agent-run-[0-9a-f]{64}$/);
    expect(dispatched.map((params) => params.executionId)).toEqual([
      started[0]?.runId,
    ]);
    expect(
      jest.mocked(sendToWindow).mock.calls.map(([, channel]) => channel),
    ).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.scriptStarted,
        IPC_CHANNELS.scriptComplete,
      ]),
    );
    const query = jest.spyOn(runtime, 'query');
    jest.mocked(sendToWindow).mockClear();

    const repeat = await runScript('build', 'tool-1');

    expect(repeat).toMatchObject({
      ok: true,
      result: {
        scriptKey: 'build',
        replayed: true,
        finished: true,
        status: 'succeeded',
      },
    });
    expect(started).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    expect(sendToWindow).not.toHaveBeenCalled();
    expect(query.mock.calls.map(([name]) => name)).toContain(
      'worker.script.execution.list',
    );
  });

  it('answers a repeat while its run is still going, and starts nothing', async () => {
    const current = runtime;
    const first = await runScript('serve', 'tool-1', { waitSeconds: 0 });
    expect(first).toMatchObject({
      ok: true,
      result: { scriptKey: 'serve', finished: false, status: 'running' },
    });
    // Stopped any sooner, its starting shell would wait out the stop's grace.
    await sentOutput();
    jest.mocked(sendToWindow).mockClear();

    try {
      const repeat = await runScript('serve', 'tool-1');

      expect(repeat).toMatchObject({
        ok: true,
        result: {
          scriptKey: 'serve',
          replayed: true,
          finished: false,
          status: 'running',
        },
      });
      expect(started).toHaveLength(1);
      expect(dispatched).toHaveLength(1);
      expect(sendToWindow).not.toHaveBeenCalled();
    } finally {
      await stopServe(current);
    }
  }, 30_000);

  it('refuses through core a reused tool call for another script that raced past the lookup', async () => {
    // Both calls are approved only once both have looked the key up.
    let arrived = 0;
    let bothLookedUp: () => void = (): void => undefined;
    const lookedUp = new Promise<void>((resolve) => {
      bothLookedUp = resolve;
    });
    const authorize = async (): Promise<boolean> => {
      arrived += 1;
      if (arrived === 2) bothLookedUp();
      await lookedUp;
      return true;
    };

    const [build, lint] = await Promise.all([
      runScript('build', 'tool-1', { authorize }),
      runScript('lint', 'tool-1', { authorize }),
    ]);

    expect(dispatched).toHaveLength(1);
    const ran = dispatched[0]?.record?.script.scriptKey;
    const [ranAnswer, refusedAnswer] =
      ran === 'build' ? [build, lint] : [lint, build];
    expect(ranAnswer).toMatchObject({
      ok: true,
      result: { scriptKey: ran, finished: true, success: true },
    });
    expect(refusedAnswer).toMatchObject({
      ok: false,
      error: { code: 'execution_failed' },
    });
    // The accepted limit: the refused call announced its start first.
    expect(started.map((run) => run.scriptKey).sort()).toEqual([
      'build',
      'lint',
    ]);
    expect(
      jest
        .mocked(sendToWindow)
        .mock.calls.filter(
          ([, channel]) => channel === IPC_CHANNELS.scriptStarted,
        ),
    ).toHaveLength(2);
  }, 30_000);

  it('refuses a repeated tool call that asks for another script, and starts nothing', async () => {
    await runScript('build', 'tool-1');

    const reused = await runScript('lint', 'tool-1');

    expect(reused).toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict', retryable: false },
    });
    expect(started.map((run) => run.scriptKey)).toEqual(['build']);
    expect(dispatched).toHaveLength(1);
  });

  it('answers a repeat from its operation, and refuses a reused tool call for another script, after a later run replaced its log entry', async () => {
    await runScript('build', 'tool-1');
    await runScript('build', 'tool-2');
    expect(started).toHaveLength(2);

    const repeat = await runScript('build', 'tool-1');
    expect(repeat).toMatchObject({
      ok: true,
      result: {
        scriptKey: 'build',
        replayed: true,
        finished: true,
        status: 'succeeded',
      },
    });
    const reused = await runScript('lint', 'tool-1');

    expect(reused).toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict', retryable: false },
    });
    expect(started.map((run) => run.scriptKey)).toEqual(['build', 'build']);
    expect(dispatched).toHaveLength(2);
  });

  it('finds a run whose answer was lost, after a restart, and starts nothing', async () => {
    await runScript('build', 'tool-1');
    await runtime.shutdown();
    startRuntime();

    const retry = await runScript('build', 'tool-1');

    expect(retry).toMatchObject({
      ok: true,
      result: { scriptKey: 'build', replayed: true, finished: true },
    });
    expect(started).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
  });

  it('refuses to run again a tool call whose run did not finish', async () => {
    failNextDispatch = true;
    const first = await runScript('build', 'tool-1');
    expect(first).toMatchObject({ ok: false });

    const retry = await runScript('build', 'tool-1');

    expect(retry).toMatchObject({
      ok: false,
      error: { code: 'execution_failed', retryable: false },
    });
    expect(started).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
  });

  it('keeps execution ids apart across chats and worktrees', async () => {
    await runScript('build', 'tool-1');
    await runScript('build', 'tool-1', { chatId: 'chat-2' });
    await runScript('build', 'tool-1', { worktreeId: 'other-worktree' });

    const ids = started.map((run) => run.runId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(dispatched).toHaveLength(3);
  });

  it('runs again a request id reused in a later turn', async () => {
    await runScript('build', 'tool-1');

    // A worktree chat's MCP request ids restart with each connection.
    const later = await runScript('build', 'tool-1', { turnKey: 'turn-2' });

    expect(later).toMatchObject({
      ok: true,
      result: { scriptKey: 'build', finished: true, success: true },
    });
    expect(later).not.toMatchObject({ result: { replayed: true } });
    expect(started).toHaveLength(2);
    expect(started[0]?.runId).not.toBe(started[1]?.runId);
    expect(dispatched).toHaveLength(2);
  });

  it('gives a call with no known turn a fresh run each time', async () => {
    await runScript('build', 'tool-1', { turnKey: null });
    await runScript('build', 'tool-1', { turnKey: null });

    expect(started).toHaveLength(2);
    expect(started.every((run) => run.runId === undefined)).toBe(true);
    expect(dispatched).toHaveLength(2);
  });

  it('gives a call without a tool call id a fresh run each time', async () => {
    await runScript('build', undefined);
    await runScript('build', undefined);

    expect(started).toHaveLength(2);
    expect(started.every((run) => run.runId === undefined)).toBe(true);
    expect(dispatched).toHaveLength(2);
  });
});
