import { installRoutedW5GoldenStore } from '../../lib/__tests__/fixtures/w5-routed-golden-store';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type SidebarItemsFile,
  type WorktreeEffectiveOverrides,
} from '@canopy/desktop-shared/types';

/** A remote-control bridge's sender; every other sender is a local window. */
const REMOTE_SENDER = { id: 4242 };
const LOCAL_SENDER = { id: 1 };

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../register', () => ({
  registerIpcHandler: (
    name: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): typeof mockHandlers => mockHandlers.set(name, handler),
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: (): number => 0,
}));
jest.mock('../../remote-control/host/bridge-window', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../remote-control/host/bridge-window',
  ),
  resolveRemoteBridgeSender: (sender: { id: number }): string | null =>
    sender.id === 4242 ? 'paired-mobile' : null,
}));

import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { registerProjectHandlers } from '../projects';
import { registerWorkspaceTypes } from '../../lib/workspace-registry';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';

const caller: CanopyCallerDescriptor = {
  principalId: 'local',
  clientInstanceId: 'worktree-effective-golden',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read', 'core.worktree.read'],
};

let root: string;
let data: string;
let saved: NodeJS.ProcessEnv;
let runtime: ReturnType<typeof createDesktopRuntime>;
let closeW5Store: (() => Promise<void>) | undefined;

function json(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function checkout(worktreeId: string): string {
  return join(data, 'workspaces', 'single', 'worktrees', worktreeId);
}

function launch(command: string): unknown {
  return { version: 1, scripts: { launch: command } };
}

async function ipc(
  channel: string,
  sender: { id: number },
  request?: unknown,
): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`missing handler ${channel}`);
  return handler({ sender }, request);
}

function configReadsBy(caller: string): number {
  return Object.entries(snapshotWorkCounters().metadata)
    .filter(([key]) => key.startsWith('config.') && key.endsWith(`.${caller}`))
    .reduce((sum, [, value]) => sum + value, 0);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-effective-')));
  data = join(root, 'data');
  saved = { ...process.env };
  process.env.CANOPY_DATA_DIR = data;
  const source = join(root, 'source');
  json(join(source, 'canopy.json'), launch('pnpm dev'));
  json(join(data, 'workspaces/index.json'), {
    version: 1,
    workspaces: [
      {
        id: 'single',
        name: 'Single',
        type: 'single-repo',
        color: '#3B82F6',
        collapsed: false,
        order: 0,
      },
    ],
  });
  json(join(data, 'workspaces/single/workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: source,
    repos: [],
  });
  json(join(data, 'workspaces/single/worktrees.json'), {
    version: 1,
    worktrees: [
      { id: 'same', branchName: 'same', createdAt: '2026-11-16T00:00:00.000Z' },
      {
        id: 'changed',
        branchName: 'changed',
        createdAt: '2026-11-16T00:00:01.000Z',
      },
    ],
  });
  json(join(checkout('same'), 'canopy.json'), launch('pnpm dev'));
  json(join(checkout('changed'), 'canopy.json'), launch('pnpm start:branch'));
  registerWorkspaceTypes(new Map([['single', 'single-repo']]));
  runtime = createDesktopRuntime();
  registerProjectHandlers(
    () => new BrowserWindow(),
    runtime,
    () => caller,
  );
  closeW5Store = await installRoutedW5GoldenStore();
});

afterAll(async () => {
  await closeW5Store?.();
  await settleDetachedWork();
  await runtime?.shutdown();
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => resetWorkCounters());

function single(file: unknown): SidebarItemsFile['items'][number] {
  const items = (file as SidebarItemsFile).items;
  const item = items.find((candidate) => candidate.id === 'single');
  if (!item) throw new Error('missing project');
  return item;
}

function launchOf(
  effective: Record<string, WorktreeEffectiveOverrides> | undefined,
  worktreeId: string,
): unknown {
  return effective?.[worktreeId]?.effectiveScripts?.launch;
}

it('keeps per-worktree scripts out of a local load', async () => {
  const item = single(await ipc(IPC_CHANNELS.projectsLoad, LOCAL_SENDER));
  expect(item.type === 'cowork' ? undefined : item.worktreeEffective).toBe(
    undefined,
  );
  expect(configReadsBy('sidebar.worktree')).toBe(0);
});

it("gives a paired remote session each worktree's own scripts, in today's shape", async () => {
  const item = single(await ipc(IPC_CHANNELS.projectsLoad, REMOTE_SENDER));
  if (item.type === 'cowork') throw new Error('expected a code project');
  expect(Object.keys(item.worktreeEffective ?? {}).sort()).toEqual([
    'changed',
    'same',
  ]);
  expect(launchOf(item.worktreeEffective, 'changed')).toEqual(
    'pnpm start:branch',
  );
  expect(launchOf(item.worktreeEffective, 'same')).toEqual('pnpm dev');
  expect(snapshotWorkCounters().metadata['projectsLoad.remote']).toBe(1);
});

it("reads one worktree's own scripts on demand and follows edits", async () => {
  const read = async (): Promise<unknown> =>
    launchOf(
      (await ipc(IPC_CHANNELS.worktreeEffectiveGet, LOCAL_SENDER, {
        projectId: 'single',
        worktreeIds: ['changed'],
      })) as Record<string, WorktreeEffectiveOverrides>,
      'changed',
    );
  expect(await read()).toEqual('pnpm start:branch');
  json(join(checkout('changed'), 'canopy.json'), launch('pnpm start:edited'));
  expect(await read()).toEqual('pnpm start:edited');
});

it("refuses, rather than answering empty, when the worktree list can't be read", async () => {
  const list = join(data, 'workspaces/single/worktrees.json');
  const before = readFileSync(list, 'utf8');
  writeFileSync(list, '{"version":1,"worktrees":[');
  try {
    await expect(
      ipc(IPC_CHANNELS.worktreeEffectiveGet, LOCAL_SENDER, {
        projectId: 'single',
        worktreeIds: ['changed'],
      }),
    ).rejects.toThrow();
  } finally {
    writeFileSync(list, before);
  }
});

it("refuses, rather than answering empty, when a worktree's canopy.json can't be parsed", async () => {
  const config = join(checkout('changed'), 'canopy.json');
  const before = readFileSync(config, 'utf8');
  writeFileSync(config, '{"version":1,"scripts":');
  try {
    await expect(
      ipc(IPC_CHANNELS.worktreeEffectiveGet, LOCAL_SENDER, {
        projectId: 'single',
        worktreeIds: ['changed'],
      }),
    ).rejects.toThrow('Workspace storage is temporarily unavailable');
  } finally {
    writeFileSync(config, before);
  }
});
