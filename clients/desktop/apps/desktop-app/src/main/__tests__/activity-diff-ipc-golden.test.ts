import { toAppError } from '@canopy/protocol/app-errors';
import { readFile, writeFile } from 'node:fs/promises';
import { getWorkspaceWorktreesFilePath } from '../lib/paths';
import { readWorkspaceWorktreesUnlocked } from '../lib/workspace-persistence';
// CAN-4070 rule: captured on the unchanged `activity:changed-files`,
// `activity:file-diff` and `activity:turn-file-diff` IPC handlers before
// CAN-4103 served them through `worker.git.diff.get`. Real data root,
// workspace records, Git checkouts and bare origins; only IPC registration is
// mocked. Pinned divergences the canonical engine handles differently:
// rename/copy line counts and binary flags dropped (1), untracked files past
// 200 dropped without a flag (2), Git failures read as empty (3), trimmed
// paths (4), and the desktop status vocabulary (5). CAN-3224 corrects the
// C-quoted-path divergence: snapshots now retain actual filename identities.
import type { IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  type ActivityChangedFilesResponse,
  type ChangedFileInfo,
} from '@canopy/desktop-shared/types';
import {
  CONFLICT_WS,
  GONE_BASE_WORKTREE,
  MANY_WS,
  MULTI_WS,
  NO_ORIGIN_WS,
  PENDING_WORKTREE,
  PENDING_WS,
  POSIX,
  POSIX_WS,
  SINGLE_WS,
  UNBORN_WS,
  WORKTREE,
  createDiffGoldenFixture,
  describeError,
  git,
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

import { registerActivityGoldenHandlers } from './helpers/activity-golden-registration';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';

jest.setTimeout(120_000);

const posixIt = POSIX ? it : it.skip;

let fixture: DiffGoldenFixture;
let originalDataDir: string | undefined;
let registration: ReturnType<typeof registerActivityGoldenHandlers> | undefined;

beforeAll(() => {
  fixture = createDiffGoldenFixture('activity-diff-golden-');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = fixture.dataDir;
  registration = registerActivityGoldenHandlers();
});

afterAll(async () => {
  await registration?.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  fixture.cleanup();
});

it('rejects non-string stop-polling IDs and keeps valid cleanup idempotent', async () => {
  const stop = mockHandlers.get(IPC_CHANNELS.activityStopOutputPolling);
  if (!stop) throw new Error('Stop-polling handler was not registered');
  const request = {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
  };

  const error = await Promise.resolve()
    .then(() => stop({}, { ...request, taskId: 23 }))
    .catch((thrown: unknown) => toAppError(thrown));
  expect(error).toMatchObject({ code: 'input.not_accepted' });
  await expect(
    Promise.resolve().then(() => stop({}, { ...request, taskId: '23' })),
  ).resolves.toBeUndefined();
});

type Outcome = { result: unknown } | { error: Record<string, unknown> };

const localEvent: Partial<IpcMainInvokeEvent> = {};
// A remote-control bridge sender, which the desktop resolves to a
// `remote-device:<id>` principal with the desktop grants.
const remoteEvent = { sender: { id: 9_001 }, remoteDeviceId: 'device-01' };

async function ipc(
  channel: string,
  request: unknown,
  event: unknown = localEvent,
): Promise<Outcome> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  try {
    return { result: await handler(event, request) };
  } catch (error) {
    return { error: describeError(error, fixture.scrub) };
  }
}

const changedFiles = (request: unknown, event?: unknown): Promise<Outcome> =>
  ipc(IPC_CHANNELS.activityChangedFiles, request, event);
async function changedFilesResult(
  request: unknown,
): Promise<ActivityChangedFilesResponse> {
  const handler = mockHandlers.get(IPC_CHANNELS.activityChangedFiles);
  if (!handler) throw new Error('activity:changed-files was not registered');
  const value = await handler(localEvent, request);
  if (!isChangedFilesResponse(value))
    throw new Error('expected a changed-files response');
  return value;
}

function isChangedFileList(value: unknown): value is ChangedFileInfo[] {
  return (
    Array.isArray(value) &&
    value.every(
      (file: unknown) =>
        typeof file === 'object' &&
        file !== null &&
        typeof Reflect.get(file, 'path') === 'string' &&
        typeof Reflect.get(file, 'status') === 'string' &&
        typeof Reflect.get(file, 'insertions') === 'number',
    )
  );
}

function isChangedFilesResponse(
  value: unknown,
): value is ActivityChangedFilesResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    isChangedFileList(Reflect.get(value, 'uncommitted')) &&
    isChangedFileList(Reflect.get(value, 'committed'))
  );
}

const fileDiff = (request: unknown): Promise<Outcome> =>
  ipc(IPC_CHANNELS.activityFileDiff, request);
const turnFileDiff = (request: unknown): Promise<Outcome> =>
  ipc(IPC_CHANNELS.activityTurnFileDiff, request);

describe('activity:changed-files', () => {
  it('lists uncommitted and committed files of a single-repo worktree', async () => {
    const outcome = await changedFiles({
      projectId: SINGLE_WS,
      worktreeId: WORKTREE,
    });
    expect(outcome).toMatchSnapshot();
    // The projection fetched origin first; the merge base keeps the upstream
    // commit out of the committed set.
    expect(
      git(fixture.repos[SINGLE_WS], ['rev-parse', 'refs/remotes/origin/main']),
    ).toBe(fixture.upstreamTip);
  });

  it('answers a tunneled caller with the same result', async () => {
    const request = { projectId: SINGLE_WS, worktreeId: WORKTREE };
    expect(await changedFiles(request, remoteEvent)).toEqual(
      await changedFiles(request),
    );
  });

  it('drops rename and copy line counts and the renamed binary flag (1)', async () => {
    const response = await changedFilesResult({
      projectId: SINGLE_WS,
      worktreeId: WORKTREE,
    });
    expect(
      response.committed.filter(
        (file) => file.status === 'renamed' || file.status === 'copied',
      ),
    ).toMatchSnapshot();
  });

  it('keeps 200 untracked files without a truncated flag (2)', async () => {
    const response = await changedFilesResult({
      projectId: MANY_WS,
      worktreeId: WORKTREE,
    });
    expect({
      keys: Object.keys(response),
      count: response.uncommitted.length,
      first: response.uncommitted[0],
      last: response.uncommitted.at(-1),
      insertions: response.uncommitted.reduce(
        (sum, file) => sum + file.insertions,
        0,
      ),
      committed: response.committed,
    }).toMatchSnapshot();
  });

  it('reads Git failures in a checkout without a commit as empty (3)', async () => {
    expect(
      await changedFiles({ projectId: UNBORN_WS, worktreeId: WORKTREE }),
    ).toMatchSnapshot();
  });

  posixIt(
    'decodes Git-quoted filename identities while retaining edge trimming (CAN-3224)',
    async () => {
      expect(
        await changedFiles({ projectId: POSIX_WS, worktreeId: WORKTREE }),
      ).toMatchSnapshot();
    },
  );

  it('marks unmerged paths during a stopped merge (5)', async () => {
    expect(
      await changedFiles({ projectId: CONFLICT_WS, worktreeId: WORKTREE }),
    ).toMatchSnapshot();
  });

  it('selects the local default without origin and lists nothing committed for a missing base', async () => {
    expect(
      await changedFiles({ projectId: NO_ORIGIN_WS, worktreeId: WORKTREE }),
    ).toMatchSnapshot('local main');
    expect(
      await changedFiles({
        projectId: NO_ORIGIN_WS,
        worktreeId: GONE_BASE_WORKTREE,
      }),
    ).toMatchSnapshot('missing tracked base');
  });

  it('fans out over multi-repo checkouts with repository identity', async () => {
    expect(
      await changedFiles({ projectId: MULTI_WS, worktreeId: WORKTREE }),
    ).toMatchSnapshot();
  });

  it('returns nothing for a Git-pending worktree reservation', async () => {
    expect(
      await changedFiles({
        projectId: PENDING_WS,
        worktreeId: PENDING_WORKTREE,
      }),
    ).toMatchSnapshot();
  });

  it('keeps the failures of invalid and unknown scopes', async () => {
    for (const request of [
      { projectId: 'Bad', worktreeId: WORKTREE },
      { projectId: SINGLE_WS, worktreeId: '' },
      { projectId: 'ghost-ws', worktreeId: WORKTREE },
      { projectId: SINGLE_WS, worktreeId: 'ghost-01' },
    ])
      expect(await changedFiles(request)).toMatchSnapshot(
        `${request.projectId}/${request.worktreeId}`,
      );
  });
});

describe('activity:file-diff', () => {
  const sources = ['uncommitted', 'committed', 'combined'] as const;

  it('reads each source for each kind of change', async () => {
    for (const filePath of [
      'edit.txt',
      'renamed.txt',
      'copied.txt',
      'delete-me.txt',
      'image.bin',
      'bin-renamed.bin',
      'uncommitted-edit.txt',
      'keep.txt',
      'staged-new.txt',
      'staged-renamed.txt',
      'café.md',
      'untracked.txt',
      'untracked.bin',
      'big-untracked.txt',
      'missing.txt',
    ])
      for (const source of sources)
        expect(
          await fileDiff({
            projectId: SINGLE_WS,
            worktreeId: WORKTREE,
            filePath,
            source,
          }),
        ).toMatchSnapshot(`${filePath} ${source}`);
  });

  it('selects multi-repo checkouts by repository id', async () => {
    for (const [repoId, filePath] of [
      [undefined, 'root.txt'],
      [WORKSPACE_ROOT_REPO_ID, 'root-committed.txt'],
      ['alpha', 'shared.txt'],
      ['beta', 'beta-committed.txt'],
    ] as const)
      for (const source of sources)
        expect(
          await fileDiff({
            projectId: MULTI_WS,
            worktreeId: WORKTREE,
            ...(repoId === undefined ? {} : { repoId }),
            filePath,
            source,
          }),
        ).toMatchSnapshot(`${String(repoId)} ${filePath} ${source}`);
  });

  it('reads an unborn checkout and a missing base', async () => {
    for (const source of sources) {
      expect(
        await fileDiff({
          projectId: UNBORN_WS,
          worktreeId: WORKTREE,
          filePath: 'staged.txt',
          source,
        }),
      ).toMatchSnapshot(`unborn ${source}`);
      expect(
        await fileDiff({
          projectId: NO_ORIGIN_WS,
          worktreeId: GONE_BASE_WORKTREE,
          filePath: 'README.md',
          source,
        }),
      ).toMatchSnapshot(`missing base ${source}`);
    }
  });

  it('keeps request validation messages', async () => {
    for (const request of [
      { projectId: SINGLE_WS, worktreeId: WORKTREE, filePath: '../x' },
      { projectId: SINGLE_WS, worktreeId: WORKTREE, filePath: '/etc/hosts' },
      { projectId: SINGLE_WS, worktreeId: WORKTREE, filePath: '' },
      {
        projectId: SINGLE_WS,
        worktreeId: WORKTREE,
        filePath: 'edit.txt',
        source: 'staged',
      },
      {
        projectId: MULTI_WS,
        worktreeId: WORKTREE,
        repoId: 'Bad',
        filePath: 'shared.txt',
        source: 'uncommitted',
      },
    ])
      expect(
        await fileDiff({ source: 'uncommitted', ...request }),
      ).toMatchSnapshot(JSON.stringify(request));
  });
});

describe('activity:turn-file-diff', () => {
  it('reads a file between two trees', async () => {
    const { startTree, endTree, startCommit } = fixture.turn;
    for (const [filePath, start, end] of [
      ['edit.txt', startTree, endTree],
      ['renamed.txt', startTree, endTree],
      ['rename-src.txt', startTree, endTree],
      ['image.bin', startTree, endTree],
      ['new-file.txt', startTree, endTree],
      ['delete-me.txt', startTree, endTree],
      ['edit.txt', endTree, startTree],
      ['edit.txt', startCommit, endTree],
      ['missing.txt', startTree, endTree],
      ['edit.txt', 'f'.repeat(40), endTree],
    ] as const)
      expect(
        await turnFileDiff({
          projectId: SINGLE_WS,
          worktreeId: WORKTREE,
          filePath,
          startTree: start,
          endTree: end,
        }),
      ).toMatchSnapshot(
        `${filePath} ${start === startTree ? 'start' : start === endTree ? 'end' : start === startCommit ? 'commit' : 'absent'}..${end === endTree ? 'end' : 'start'}`,
      );
  });

  it('keeps tree and path validation messages', async () => {
    const { startTree, endTree } = fixture.turn;
    for (const request of [
      { filePath: 'edit.txt', startTree: 'HEAD', endTree },
      { filePath: 'edit.txt', startTree, endTree: endTree.toUpperCase() },
      { filePath: 'edit.txt', startTree: startTree.slice(0, 39), endTree },
      { filePath: '../edit.txt', startTree, endTree },
    ])
      expect(
        await turnFileDiff({
          projectId: SINGLE_WS,
          worktreeId: WORKTREE,
          ...request,
        }),
      ).toMatchSnapshot(
        JSON.stringify({
          ...request,
          startTree: request.startTree.length,
          endTree: request.endTree === endTree ? 'end' : request.endTree.length,
        }),
      );
  });
});

it('reads a healthy worktree when a peer row cannot be decoded', async () => {
  const listPath = getWorkspaceWorktreesFilePath(SINGLE_WS);
  const original = await readFile(listPath, 'utf8');
  const { worktrees } = await readWorkspaceWorktreesUnlocked(SINGLE_WS);
  const request = { projectId: SINGLE_WS, worktreeId: WORKTREE };
  const expected = await changedFilesResult(request);
  expect(expected.uncommitted.length).toBeGreaterThan(0);
  try {
    await writeFile(
      listPath,
      JSON.stringify({ version: 1, worktrees: [...worktrees, { id: 99 }] }),
    );
    const partial = await readWorkspaceWorktreesUnlocked(SINGLE_WS);
    expect(partial.authority).toBe('partial');
    expect(await changedFilesResult(request)).toEqual(expected);
  } finally {
    await writeFile(listPath, original);
  }
});

// Revision 2 and a recorded base are the web core's (CAN-6093): the desktop
// dispatcher advertises no schema revision and records no base, so it refuses
// both before reading anything; the daemon serves the same handler.
it('refuses worker.git.diff.get revision 2 and an omitted base as capability_unavailable', async () => {
  const runtime = createDesktopRuntime();
  const caller = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-web-contents:1',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['worker.git.read'],
  } as const;
  const diff = (extra: Record<string, unknown>): Promise<unknown> =>
    runtime.query(
      'worker.git.diff.get',
      {
        scope: { workspaceId: SINGLE_WS, worktreeId: WORKTREE },
        repoId: WORKSPACE_ROOT_REPO_ID,
        head: 'WORKTREE',
        ...extra,
      },
      { caller: { ...caller, grants: [...caller.grants] } },
    );
  try {
    expect(await diff({ base: 'HEAD' })).toMatchObject({ truncated: false });
    await expect(diff({ base: 'HEAD', revision: 2 })).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { unsupported: ['revision'], reason: 'unserved' },
      },
    });
    await expect(diff({})).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
  } finally {
    await runtime.shutdown();
  }
});
