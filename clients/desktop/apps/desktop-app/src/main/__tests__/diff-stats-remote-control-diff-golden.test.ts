import { installRoutedW5GoldenStore } from '../lib/__tests__/fixtures/w5-routed-golden-store';
// CAN-4070 rule: captured on the unchanged `worktree:diff-stats`,
// `worktree:diff-stats-batch` IPC handlers before CAN-4103 moved diff
// computation behind `worker.git.diff.get`. Real data root, workspace records, Git checkouts and bare origins; only IPC
// registration is mocked.
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  CONFLICT_WS,
  GONE_BASE_WORKTREE,
  MANY_WS,
  MULTI_WS,
  NO_ORIGIN_WS,
  POSIX,
  POSIX_WS,
  SINGLE_WS,
  UNBORN_WS,
  WORKTREE,
  createDiffGoldenFixture,
  describeError,
  type DiffGoldenFixture,
} from './helpers/diff-golden-fixtures';

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

import { registerWorktreeHandlers } from '../ipc/worktrees';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';

jest.setTimeout(180_000);

const posixIt = POSIX ? it : it.skip;

let fixture: DiffGoldenFixture;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher | undefined;

// The grants every desktop IPC caller carries (desktop-ipc-caller.ts).
const desktopCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [
    'worker.filesystem.read',
    'core.workspace.read',
    'core.chat.read',
    'core.chat.write',
    'core.worktree.read',
  ],
};

let closeW5Store: (() => Promise<void>) | undefined;

beforeAll(async () => {
  fixture = createDiffGoldenFixture('diff-stats-portal-golden-');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = fixture.dataDir;
  runtime = createDesktopRuntime();
  registerWorktreeHandlers(() => null, {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
  });
  closeW5Store = await installRoutedW5GoldenStore();
});

afterAll(async () => {
  await closeW5Store?.();
  await runtime?.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  fixture.cleanup();
});

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const OBJECT_ID = /\b[0-9a-f]{12,64}\b/g;

function scrubbed(value: unknown): unknown {
  return JSON.parse(
    fixture
      .scrub(JSON.stringify(value) ?? 'null')
      .replace(ISO, '<time>')
      .replace(OBJECT_ID, '<oid>'),
  );
}

type Outcome = { result: unknown } | { error: Record<string, unknown> };

async function ipc(channel: string, request: unknown): Promise<Outcome> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  try {
    const event: Partial<IpcMainInvokeEvent> = {};
    return { result: scrubbed(await handler(event, request)) };
  } catch (error) {
    return { error: describeError(error, fixture.scrub) };
  }
}

const SCOPES = [
  [SINGLE_WS, WORKTREE],
  [MANY_WS, WORKTREE],
  [UNBORN_WS, WORKTREE],
  [CONFLICT_WS, WORKTREE],
  [NO_ORIGIN_WS, WORKTREE],
  [NO_ORIGIN_WS, GONE_BASE_WORKTREE],
  [MULTI_WS, WORKTREE],
] as const;

describe('worktree:diff-stats', () => {
  it('counts the change since the merge base for each scope', async () => {
    for (const [projectId, worktreeId] of SCOPES)
      expect(
        await ipc(IPC_CHANNELS.worktreeDiffStats, { projectId, worktreeId }),
      ).toMatchSnapshot(`${projectId}/${worktreeId}`);
  });

  posixIt('counts quoted and type-changed paths', async () => {
    expect(
      await ipc(IPC_CHANNELS.worktreeDiffStats, {
        projectId: POSIX_WS,
        worktreeId: WORKTREE,
      }),
    ).toMatchSnapshot();
  });

  it('keeps identifier validation messages', async () => {
    for (const request of [
      { projectId: 'Bad', worktreeId: WORKTREE },
      { projectId: SINGLE_WS, worktreeId: '' },
    ])
      expect(
        await ipc(IPC_CHANNELS.worktreeDiffStats, request),
      ).toMatchSnapshot(JSON.stringify(request));
  });
});

describe('worktree:diff-stats-batch', () => {
  it('answers diff-only and full rows, and an invalid row', async () => {
    expect(
      await ipc(IPC_CHANNELS.worktreeDiffStatsBatch, {
        worktrees: [
          ...SCOPES.map(([projectId, worktreeId]) => ({
            projectId,
            worktreeId,
            mode: 'diff_only',
          })),
          ...SCOPES.map(([projectId, worktreeId]) => ({
            projectId,
            worktreeId,
            mode: 'full',
          })),
          { projectId: 'Bad', worktreeId: WORKTREE, mode: 'full' },
        ],
        skipFetch: true,
        source: 'user-explicit',
      }),
    ).toMatchSnapshot();
  });
});
