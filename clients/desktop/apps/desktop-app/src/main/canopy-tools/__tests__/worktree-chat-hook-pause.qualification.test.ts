import { readFileSync, rmSync } from 'node:fs';
import { windowAgentInterfacePort } from '../../agents/agent-interface-port';
import { join } from 'node:path';
import { z } from 'zod';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as LegacyStorage from '../../lib/__tests__/fixtures/w5-legacy-storage';
import type * as HooksServiceModule from '../../services/hooks-service';
import type * as AgentCoreOperationsModule from '../agent-core-operations';
import type { AgentCoreOperationDispatcher } from '../agent-core-operations';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<
      typeof LegacyStorage
    >('../../lib/__tests__/fixtures/w5-legacy-storage')
    .createLegacyW5StorageMock(),
);
const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (namespaceIds: readonly string[]) => void;
}>('@canopy/core-runtime/storage');
jest.mock('../../lib/desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToAllWindows: jest.fn(),
}));
// The worktree's hooks come from its project's hook settings; the pause they
// select is what this suite pins.
jest.mock('../../services/hooks-service', () => ({
  ...jest.requireActual<typeof HooksServiceModule>(
    '../../services/hooks-service',
  ),
  listHooks: jest.fn(() =>
    Promise.resolve([
      { hookKey: 'project:before-commit' },
      { hookKey: 'project:after-push' },
    ]),
  ),
}));
const dispatched: Array<{
  name: string;
  params: unknown;
  options: { caller: { grants: readonly string[] } };
}> = [];
let dispatcher: AgentCoreOperationDispatcher | undefined;
// The running turn the desktop surface resolves for a keyed call.
jest.mock('../../agent-actions/desktop-environment-port', () => {
  const overrides = {
    resolveDesktopTurnKey: (): Promise<string> =>
      Promise.resolve('chat-1:message-1'),
  };
  return new Proxy(overrides, {
    get: (target, key): unknown =>
      key in target
        ? Reflect.get(target, key)
        : Reflect.get(
            jest.requireActual<object>(
              '../../agent-actions/desktop-environment-port',
            ),
            key,
          ),
  });
});
jest.mock('../active-agent-core-operations', () => ({
  activeAgentCoreOperations: (
    family: AgentCoreOperationsModule.AgentToolFamily,
  ): AgentCoreOperationDispatcher =>
    jest
      .requireActual<
        typeof AgentCoreOperationsModule
      >('../agent-core-operations')
      .agentCoreOperations(family, {
        query: (name, params, options) => {
          if (!dispatcher) throw new Error('No dispatcher');
          return dispatcher.query(name, params, options);
        },
        instruction: (name, params, options) => {
          if (!dispatcher) throw new Error('No dispatcher');
          dispatched.push({ name, params, options });
          return dispatcher.instruction(name, params, options);
        },
      }),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { __setDesktopW5FileStoreForTests } from '../../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../../lib/w5-file-store';
import { createW5BoundaryFixture } from '../../lib/__tests__/fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from '../../lib/__tests__/fixtures/w5-boundary-host';
import { installW5StoreSide } from '../../lib/__tests__/fixtures/w5-store-sides';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import {
  AGENT_CORE_TOOL_OPERATIONS,
  AgentToolOperationRefusedError,
  agentCoreOperations,
} from '../agent-core-operations';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { sendToWindow } from '../../lib/window-send';
import { desktopLegacyActionFamily } from '../../agent-actions/desktop-legacy-family';
import { desktopAgentActionCall } from '../../agent-actions/desktop-surface';
import type { CanopyInjectedToolRuntime } from '../core';
import type { WorktreeActionRuntime } from '../worktree-actions';

let dir: string;
let root: string;
let host: W5CommitLogHost;
let dbPath: string;
let runtime: DesktopCanopyDispatcher;
let originalDataDir: string | undefined;
let teardownStoreSide = (): Promise<void> => Promise.resolve();

beforeEach(async () => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: 'one', branchName: 'first', createdAt },
  ]));
  dbPath = join(dir, 'data', 'w5', 'commit-log.sqlite');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(
      __dirname,
      '../../lib/__tests__/fixtures/w5-commit-log-source-worker.ts',
    ),
  });
  teardownStoreSide = await installW5StoreSide('in-process', {
    host,
    root,
    setDaemonOwned: setDaemonOwnedForTest,
  });
  runtime = createDesktopRuntime();
  dispatcher = runtime;
  dispatched.length = 0;
  jest.mocked(sendToWindow).mockClear();
});
afterEach(async () => {
  dispatcher = undefined;
  await runtime.shutdown();
  await settleDetachedWork();
  await teardownStoreSide();
  teardownStoreSide = (): Promise<void> => Promise.resolve();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, dbPath);
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A worktree chat's DispatchAction, through the family that serves it, with
 * the call identity the desktop surface gives it: the running turn, when
 * known, beside the provider's tool call id.
 */
async function dispatch(
  action: Record<string, unknown>,
  toolUseId?: string,
  turnKey: string | null = 'turn-1',
): Promise<unknown> {
  const worktreeActionRuntime: WorktreeActionRuntime = {
    projectId: 'a',
    worktreeId: 'one',
    chatId: 'chat-1',
    cwd: join(root, 'a'),
    getWindow: (): null => null,
    interfacePort: windowAgentInterfacePort(() => null),
  };
  const parsed = desktopLegacyActionFamily.parse(action);
  if (!parsed?.ok) throw new Error('The action did not parse');
  return parsed.dispatch({
    host: { worktreeActionRuntime } as unknown as CanopyInjectedToolRuntime,
    scope: { workspaceId: 'a', worktreeId: 'one', chatId: 'chat-1' },
    actorKey: 'local-desktop-user',
    ...(turnKey ? { turnKey } : {}),
    ...(toolUseId ? { toolUseId } : {}),
  });
}

const TOOL_1_PAUSE_KEY =
  'agent-action:hook.pause:a:chat-1:local-desktop-user:turn-1:tool-1';

function pausedHookKeys(): readonly string[] {
  return (
    z
      .object({
        worktrees: z.array(
          z.object({
            id: z.string(),
            pausedHookKeys: z.array(z.string()).optional(),
          }),
        ),
      })
      .parse(
        JSON.parse(readFileSync(join(root, 'a', 'worktrees.json'), 'utf8')),
      )
      .worktrees.find((row) => row.id === 'one')?.pausedHookKeys ?? []
  );
}

describe('worktree chat hook pause through core.worktree.hooks.setPaused (CAN-5830)', () => {
  it('writes through the operation with only core.worktree.write and a key for the tool call', async () => {
    const response = await dispatch(
      { type: 'hook.pause', hookKey: 'project:before-commit' },
      'tool-1',
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        projectId: 'a',
        worktreeId: 'one',
        pausedHookKeys: ['project:before-commit'],
      },
    });
    expect(pausedHookKeys()).toEqual(['project:before-commit']);
    expect(dispatched).toMatchObject([
      {
        name: 'core.worktree.hooks.setPaused',
        params: {
          workspaceId: 'a',
          worktreeId: 'one',
          change: { kind: 'pause', hookKeys: ['project:before-commit'] },
          _meta: { idempotencyKey: TOOL_1_PAUSE_KEY },
        },
        options: {
          caller: { interfaceKind: 'mcp', grants: ['core.worktree.write'] },
          metadata: { idempotencyKey: TOOL_1_PAUSE_KEY },
        },
      },
    ]);
    expect(dispatched).toHaveLength(1);
    expect(jest.mocked(sendToWindow).mock.calls).toMatchObject([
      [
        null,
        IPC_CHANNELS.workspaceWorktreesUpdated,
        {
          workspaceId: 'a',
          worktree: { id: 'one', pausedHookKeys: ['project:before-commit'] },
        },
      ],
    ]);
  });

  it('announces nothing when the change leaves the hooks as they were', async () => {
    await dispatch(
      { type: 'hook.pause', hookKey: 'project:before-commit' },
      'tool-1',
    );
    jest.mocked(sendToWindow).mockClear();

    const unchanged = await dispatch(
      { type: 'hook.pause', hookKey: 'project:before-commit' },
      'tool-2',
    );

    expect(unchanged).toMatchObject({
      ok: true,
      result: { pausedHookKeys: ['project:before-commit'] },
    });
    expect(sendToWindow).not.toHaveBeenCalled();
  });

  it('answers a repeated tool call from its first outcome without writing again', async () => {
    await dispatch(
      { type: 'hook.pause', hookKey: 'project:before-commit' },
      'tool-1',
    );
    await dispatch(
      { type: 'hook.resume', hookKey: 'project:before-commit' },
      'tool-2',
    );
    expect(pausedHookKeys()).toEqual([]);

    const replay = await dispatch(
      { type: 'hook.pause', hookKey: 'project:before-commit' },
      'tool-1',
    );

    expect(replay).toMatchObject({
      ok: true,
      result: {
        pausedHookKeys: ['project:before-commit'],
        hooks: [
          { hookKey: 'project:before-commit', paused: true },
          { hookKey: 'project:after-push', paused: false },
        ],
      },
    });
    expect(pausedHookKeys()).toEqual([]);
  });

  it('refuses a repeated tool call that asks for something else, and writes nothing', async () => {
    await dispatch(
      { type: 'hook.pause', hookKey: 'project:before-commit' },
      'tool-1',
    );

    const reused = await dispatch(
      { type: 'hook.pause', hookKey: 'project:after-push' },
      'tool-1',
    );

    expect(reused).toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict', retryable: false },
    });
    expect(pausedHookKeys()).toEqual(['project:before-commit']);
  });

  it('treats a request id reused in a later turn as a new call', async () => {
    await dispatch(
      { type: 'hook.pause', hookKey: 'project:before-commit' },
      'tool-1',
    );
    await dispatch(
      { type: 'hook.resume', hookKey: 'project:before-commit' },
      'tool-2',
    );

    // A worktree chat's MCP request ids restart with each connection.
    const later = await dispatch(
      { type: 'hook.pause', hookKey: 'project:before-commit' },
      'tool-1',
      'turn-2',
    );

    expect(later).toMatchObject({
      ok: true,
      result: { pausedHookKeys: ['project:before-commit'] },
    });
    expect(pausedHookKeys()).toEqual(['project:before-commit']);
  });

  it('gives a call with no known turn its own key', async () => {
    await dispatch(
      { type: 'hook.pause', hookKey: 'project:before-commit' },
      'tool-1',
      null,
    );
    const second = await dispatch(
      { type: 'hook.pause', hookKey: 'project:after-push' },
      'tool-1',
      null,
    );

    expect(second).toMatchObject({ ok: true });
    expect(pausedHookKeys()).toEqual([
      'project:after-push',
      'project:before-commit',
    ]);
  });

  it('resolves the running turn for hook and script actions', async () => {
    const host = {
      worktreeActionRuntime: {
        projectId: 'a',
        worktreeId: 'one',
        chatId: 'chat-1',
        cwd: join(root, 'a'),
        getWindow: (): null => null,
      },
    } as unknown as CanopyInjectedToolRuntime;
    for (const action of [
      { type: 'hook.pause', all: true },
      { type: 'hook.resume', all: true },
      { type: 'worktree.run_script', scriptId: 'build' },
    ])
      await expect(
        desktopAgentActionCall('dispatch_action', { action }, host, {
          toolUseId: 'tool-1',
        }),
      ).resolves.toMatchObject({ turnKey: 'chat-1:message-1' });
  });

  it('gives a call without a tool call id its own key', async () => {
    await dispatch({ type: 'hook.pause', hookKey: 'project:before-commit' });
    await dispatch({ type: 'hook.pause', hookKey: 'project:after-push' });

    expect(pausedHookKeys()).toEqual([
      'project:after-push',
      'project:before-commit',
    ]);
    const keys = dispatched.map(
      ({ params }) =>
        z
          .object({ _meta: z.object({ idempotencyKey: z.string() }) })
          .parse(params)._meta.idempotencyKey,
    );
    expect(keys).toEqual([
      expect.stringMatching(
        /^agent-chat-action:chat-1:untracked:.+:hook\.pause$/,
      ),
      expect.stringMatching(
        /^agent-chat-action:chat-1:untracked:.+:hook\.pause$/,
      ),
    ]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('answers an unknown hook as not found before dispatching', async () => {
    const response = await dispatch(
      { type: 'hook.pause', hookKey: 'project:missing' },
      'tool-1',
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(dispatched).toEqual([]);
  });

  it("refuses every other operation from the worktree actions' row before dispatch", async () => {
    expect(AGENT_CORE_TOOL_OPERATIONS.worktreeActions).toEqual({
      'core.worktree.hooks.setPaused': ['core.worktree.write'],
    });
    const record = jest.fn();
    const operations = agentCoreOperations('worktreeActions', {
      query: record,
      instruction: record,
    });
    type LooseCall = (
      name: string,
      params: unknown,
      options: { caller: { grants: readonly string[] } },
    ) => Promise<unknown>;
    const instruction = operations.instruction as unknown as LooseCall;
    const query = operations.query as unknown as LooseCall;
    const options = { caller: { grants: ['core.worktree.write'] } };

    await expect(
      instruction('core.worktree.update', {}, options),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);
    await expect(
      query('core.worktree.list', {}, options),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);
    expect(record).not.toHaveBeenCalled();
  });
});
