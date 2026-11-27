import { toAppError } from '@canopy/protocol/app-errors';
import { chmodSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectCanopyClient } from '@canopy/core-client/node';
import { CanopyOperationError } from '@canopy/core-runtime';
import { getDesktopInstrumentationConfig } from '@canopy/desktop-instrumentation';
import {
  deriveLocalAuthorityIdentity,
  hostLocalAuthorityObservation,
} from '@canopy/core-platform';
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
  CODE_REVIEW_CHAT_PROJECT_ID,
  IPC_CHANNELS,
  STANDALONE_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type WorkspaceType,
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
import {
  createDaemonGitRoute,
  type DaemonGitQueryClient,
  type DaemonGitRoute,
} from '../canopy-runtime/daemon-git-route';
import { createReachableDaemonGitRoute } from '../canopy-runtime/daemon-git-reachability';
import { createElectronDaemonCallerLifetime } from '../canopy-runtime/electron-daemon-caller-lifetime';
import {
  createDesktopDaemonGitRoute,
  type DesktopDaemonGitRouteHost,
} from '../canopy-runtime/electron-daemon-git-access';
import {
  ELECTRON_DAEMON_DEFINITIONS,
  type ElectronDaemonClient,
} from '../canopy-runtime/electron-daemon-host';
import { resolveRepository } from '../canopy-runtime/worker-git-adapter';
import { FakeSender } from '../canopy-runtime/__tests__/daemon-files-route-harness';
import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';
import {
  getWorkspaceType,
  listRegisteredWorkspaceIds,
  registerWorkspaceTypes,
} from '../lib/workspace-registry';
import { diffScopeAdmitted } from '../lib/worktree-health';
import { registerCodeReviewTarget } from '../lib/code-review-registry';
import {
  startCanopyDaemon,
  type RunningCanopyDaemon,
} from '../../../../core-daemon/src/daemon';

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

it('classifies refused start-polling and full-read requests as input.not_accepted', async () => {
  const start = mockHandlers.get(IPC_CHANNELS.activityStartOutputPolling);
  const readFull = mockHandlers.get(IPC_CHANNELS.activityReadFullOutput);
  if (!start || !readFull)
    throw new Error('Output handlers were not registered');
  const ids = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };
  const refused = (run: () => Promise<unknown>): Promise<unknown> =>
    Promise.resolve()
      .then(run)
      .then(
        () => undefined,
        (thrown: unknown) => toAppError(thrown),
      );

  expect(
    await refused(() =>
      start({}, { ...ids, taskId: '../x', outputFile: '/tmp/x.output' }),
    ),
  ).toMatchObject({ code: 'input.not_accepted' });
  expect(
    await refused(() =>
      start({}, { ...ids, taskId: '1', outputFile: '/etc/hosts' }),
    ),
  ).toMatchObject({ code: 'input.not_accepted' });
  expect(
    await refused(() => readFull({}, { outputFile: '/etc/hosts' })),
  ).toMatchObject({ code: 'input.not_accepted' });
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

// CAN-4729: on macOS and Linux the lists come from the bundled daemon's
// revision-3 reads over its socket, rebuilt in main exactly as from main's own
// reads. Every routed case must ask the daemon, so equality is not in-process
// twice; every unadmitted case must not.
(POSIX ? describe : describe.skip)(
  'activity:changed-files through the bundled daemon (CAN-4729)',
  () => {
    let daemon: RunningCanopyDaemon | undefined;
    let client: ElectronDaemonClient | undefined;
    let routed: ReturnType<typeof registerActivityGoldenHandlers> | undefined;
    let authority = '';
    const lifetime = createElectronDaemonCallerLifetime();
    const record = jest.fn();
    const noteFallback = jest.fn();
    let inProcess: (request: unknown) => Promise<Outcome>;
    const event = { sender: new FakeSender(1) };
    /** Diff calls, for one member repository when `repoId` is given. */
    const diffCalls = (spy: jest.SpyInstance, repoId?: string): number =>
      spy.mock.calls.filter(
        ([name, params]: unknown[]) =>
          name === 'worker.git.diff.get' &&
          (repoId === undefined ||
            (typeof params === 'object' &&
              params !== null &&
              Reflect.get(params, 'repoId') === repoId)),
      ).length;
    const connected = (): ElectronDaemonClient => {
      if (!client) throw new Error('The daemon did not start.');
      return client;
    };
    const host: DesktopDaemonGitRouteHost = {
      hostContext: (): Promise<{ authorityId: string }> =>
        Promise.resolve({ authorityId: authority }),
      connections: () => ({
        get: (): Promise<{ client: ElectronDaemonClient }> =>
          Promise.resolve({ client: connected() }),
      }),
      reachability: { isLatched: (): boolean => false, noteFallback },
      lifetime,
      record,
    };
    // Production's route (electron-daemon-git-access.ts) over the test daemon.
    const routeFor = (): DaemonGitRoute => createDesktopDaemonGitRoute(host);
    // The production inputs on win32, which the host platform cannot select.
    const windowsRoute = (): DaemonGitRoute =>
      createReachableDaemonGitRoute({
        inputs: {
          hostContext: host.hostContext,
          connections: host.connections,
          repositoryPath: resolveRepository,
        },
        reachability: host.reachability,
        createRoute: (inputs) =>
          createDaemonGitRoute({
            lifetime,
            platform: 'win32',
            workspaceType: getWorkspaceType,
            resolveWorktreeTargetIds,
            diffScopeAdmitted,
            ...inputs,
          }),
        record,
        appVersion: undefined,
      });

    beforeAll(async () => {
      const plain = mockHandlers.get(IPC_CHANNELS.activityChangedFiles);
      if (!plain) throw new Error('activity:changed-files was not registered');
      inProcess = async (request): Promise<Outcome> => {
        try {
          return { result: await plain(localEvent, request) };
        } catch (error) {
          return { error: describeError(error, fixture.scrub) };
        }
      };
      // The daemon publishes its runtime files only under a private root.
      chmodSync(fixture.dataDir, 0o700);
      daemon = await startCanopyDaemon({
        dataRoot: fixture.dataDir,
        runtimeMode: 'dev',
        buildVersion: 'test',
        brandId: 'canopy',
        secureDataRoot: join(fixture.dir, 'secure'),
        coworkManagedDirName: '.canopy',
        // Main's own PATH, so both read with the same Git.
        environment: {
          HOME: fixture.dir,
          TMPDIR: tmpdir(),
          PATH: process.env.PATH ?? '/usr/bin:/bin',
        },
      });
      const { descriptor } = daemon;
      client = await connectCanopyClient({
        endpoint: {
          kind: 'socket',
          path: descriptor.endpoint.path,
          auth: {
            secret: readFileSync(descriptor.tokenRef, 'utf8'),
            dataRootHash: createHash('sha256')
              .update(fixture.dataDir)
              .digest('hex'),
          },
        },
        clientName: 'activity-changed-files',
        clientVersion: '0',
        definitions: ELECTRON_DAEMON_DEFINITIONS,
      });
      await client.instruction('core.client.lease.acquire', {
        clientInstanceId: 'activity-changed-files',
        interfaceKind: 'desktop',
        label: 'Changed files',
        interactive: true,
        foreground: true,
        renewalIntervalMs: 15_000,
        _meta: { idempotencyKey: 'activity-changed-files-lease' },
      });
      ({ authorityId: authority } = await deriveLocalAuthorityIdentity(
        { brandId: 'canopy', dataRoot: fixture.dataDir },
        hostLocalAuthorityObservation(),
      ));
      routed = registerActivityGoldenHandlers(routeFor());
    });

    afterAll(async () => {
      lifetime.disposeAll();
      await routed?.shutdown();
      await client?.close();
      await daemon?.stop('test');
    });

    it.each([
      [SINGLE_WS, WORKTREE],
      [MANY_WS, WORKTREE],
      [UNBORN_WS, WORKTREE],
      [POSIX_WS, WORKTREE],
      [CONFLICT_WS, WORKTREE],
      [NO_ORIGIN_WS, WORKTREE],
      [NO_ORIGIN_WS, GONE_BASE_WORKTREE],
      [MULTI_WS, WORKTREE],
    ])(
      'answers %s/%s as in process, from the daemon',
      async (projectId, worktreeId) => {
        const request = { projectId, worktreeId };
        const expected = await inProcess(request);
        expect(expected).toHaveProperty('result');
        const asked = jest.spyOn(connected(), 'query');
        record.mockClear();
        try {
          expect(await changedFiles(request, event)).toEqual(expected);
          const diffs = diffCalls(asked);
          expect(diffs).toBeGreaterThan(0);
          expect(record.mock.calls).toEqual(
            Array.from({ length: diffs }, () => ['served']),
          );
        } finally {
          asked.mockRestore();
        }
        expect(noteFallback).not.toHaveBeenCalled();
      },
    );

    it('cancels, with no daemon call, when the document navigates before the request reaches the route', async () => {
      // A document of its own, so retiring it leaves the shared event alone.
      const sender = new FakeSender(1);
      const asked = jest.spyOn(connected(), 'query');
      try {
        const pending = changedFiles(
          { projectId: SINGLE_WS, worktreeId: WORKTREE },
          { sender },
        );
        // The handler is still in its own discovery awaits.
        sender.emit('did-navigate');
        const outcome = await pending;
        expect(diffCalls(asked)).toBe(0);
        expect('error' in outcome && String(outcome.error.message)).toContain(
          'The request was cancelled.',
        );
      } finally {
        asked.mockRestore();
      }
    });

    it('cancels a multi-repo list, with no daemon call, when the document navigates before the request reaches the route', async () => {
      const sender = new FakeSender(1);
      const asked = jest.spyOn(connected(), 'query');
      try {
        const pending = changedFiles(
          { projectId: MULTI_WS, worktreeId: WORKTREE },
          { sender },
        );
        sender.emit('did-navigate');
        const outcome = await pending;
        expect(diffCalls(asked)).toBe(0);
        expect('error' in outcome && String(outcome.error.message)).toContain(
          'The request was cancelled.',
        );
      } finally {
        asked.mockRestore();
      }
    });

    it('keeps a registered code-review chat on an eligible checkout in process', async () => {
      const scope = `${SINGLE_WS}--review`;
      await registerCodeReviewTarget(scope, {
        projectId: SINGLE_WS,
        worktreeId: WORKTREE,
      });
      const request = {
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: scope,
      };
      const expected = await inProcess(request);
      // The borrowed checkout's own lists, not an empty answer.
      expect(
        'result' in expected &&
          isChangedFilesResponse(expected.result) &&
          expected.result.uncommitted.length > 0,
      ).toBe(true);
      const asked = jest.spyOn(connected(), 'query');
      try {
        expect(await changedFiles(request, event)).toEqual(expected);
        expect(diffCalls(asked)).toBe(0);
      } finally {
        asked.mockRestore();
      }
    });

    // Golden 3: what the daemon would not resolve to main's checkout, and
    // what the guard keeps in process, answers as in process with no call.
    it('keeps unadmitted lists in process, with no daemon call', async () => {
      const single = { projectId: SINGLE_WS, worktreeId: WORKTREE };
      // `name` is a record file under the data root's `workspaces/`.
      const rewrite =
        (
          name: string,
          edit: (document: Record<string, unknown>) => unknown,
        ): (() => Promise<() => Promise<void>>) =>
        async () => {
          const path = join(fixture.dataDir, 'workspaces', name);
          const before = await readFile(path, 'utf8');
          const document: unknown = JSON.parse(before);
          if (typeof document !== 'object' || document === null)
            throw new Error(`${name} is not an object`);
          await writeFile(path, JSON.stringify(edit({ ...document })));
          return () => writeFile(path, before);
        };
      const types = new Map(
        listRegisteredWorkspaceIds().flatMap(
          (id): [string, WorkspaceType][] => {
            const type = getWorkspaceType(id);
            return type === null ? [] : [[id, type]];
          },
        ),
      );
      const unchanged = (): Promise<() => Promise<void>> =>
        Promise.resolve(() => Promise.resolve());
      // The optional fourth entry: the one member that must stay in process.
      const cases: ReadonlyArray<
        readonly [string, unknown, () => Promise<() => Promise<void>>, string?]
      > = [
        [
          'a worktree listed twice',
          single,
          rewrite(`${SINGLE_WS}/worktrees.json`, (list) => ({
            ...list,
            worktrees: [list.worktrees, list.worktrees].flat(),
          })),
        ],
        [
          'a workspace indexed twice',
          single,
          rewrite('index.json', (index) => ({
            ...index,
            workspaces: [
              index.workspaces,
              (Array.isArray(index.workspaces) ? index.workspaces : []).filter(
                (entry: unknown) =>
                  typeof entry === 'object' &&
                  entry !== null &&
                  Reflect.get(entry, 'id') === SINGLE_WS,
              ),
            ].flat(),
          })),
        ],
        [
          'a manifest the daemon refuses',
          single,
          rewrite(`${SINGLE_WS}/workspace.json`, (manifest) => ({
            ...manifest,
            authorityId: 'another-authority',
          })),
        ],
        [
          // Listed like `repos/notes`; the daemon's id rule refuses the name.
          'a member directory the daemon refuses',
          { projectId: MULTI_WS, worktreeId: WORKTREE },
          async () => {
            const member = join(
              fixture.worktreePath(MULTI_WS),
              'repos',
              'tools_v2',
            );
            await mkdir(member);
            await writeFile(join(member, 'tool.txt'), 'tool\n');
            return () => rm(member, { recursive: true, force: true });
          },
          'tools_v2',
        ],
        [
          'a cowork workspace',
          single,
          () => {
            registerWorkspaceTypes(new Map([...types, [SINGLE_WS, 'cowork']]));
            return Promise.resolve(() => {
              registerWorkspaceTypes(types);
              return Promise.resolve();
            });
          },
        ],
        [
          'the standalone chat',
          { projectId: STANDALONE_CHAT_PROJECT_ID, worktreeId: SINGLE_WS },
          unchanged,
        ],
        [
          'an app-managed scope',
          { projectId: CODE_REVIEW_CHAT_PROJECT_ID, worktreeId: WORKTREE },
          unchanged,
        ],
      ];
      const asked = jest.spyOn(connected(), 'query');
      try {
        for (const [label, request, setup, member] of cases) {
          const restore = await setup();
          try {
            asked.mockClear();
            const expected = await inProcess(request);
            expect([label, await changedFiles(request, event)]).toEqual([
              label,
              expected,
            ]);
            expect([label, diffCalls(asked, member)]).toEqual([label, 0]);
          } finally {
            await restore();
          }
        }
        // Windows keeps the in-process read until CAN-4732.
        asked.mockClear();
        const windows = registerActivityGoldenHandlers(windowsRoute());
        try {
          expect(await changedFiles(single, event)).toEqual(
            await inProcess(single),
          );
          expect(diffCalls(asked)).toBe(0);
        } finally {
          await windows.shutdown();
        }
      } finally {
        asked.mockRestore();
      }
    });

    // App and daemon both report CANOPY_VERSION, else the root version
    // (CAN-4729). A daemon stamped by the earlier root-only rule is another
    // build, as an earlier release candidate's daemon is.
    const parsedRoot: unknown = JSON.parse(
      readFileSync(join(__dirname, '../../../../../package.json'), 'utf8'),
    );
    const rootVersion =
      typeof parsedRoot === 'object' && parsedRoot !== null
        ? String(Reflect.get(parsedRoot, 'version'))
        : '';
    /** Changed files from a daemon reporting `buildVersion` that refuses revision 3. */
    const fromRefusingDaemon = async (
      buildVersion: string,
    ): Promise<{
      outcome: Outcome;
      queried: number;
      recorded: unknown[][];
    }> => {
      const query = jest.fn(() =>
        Promise.reject(
          new CanopyOperationError({
            kind: 'invalid_argument',
            message: 'Refused.',
            retry: { kind: 'never' },
          }),
        ),
      );
      const attached = registerActivityGoldenHandlers(
        createDesktopDaemonGitRoute({
          ...host,
          connections: () => ({
            get: (): Promise<{ client: DaemonGitQueryClient }> =>
              Promise.resolve({
                client: {
                  signal: new AbortController().signal,
                  identity: {
                    runtimeId: 'runtime',
                    daemonEpoch: `epoch-${buildVersion}`,
                    buildVersion,
                  },
                  query,
                },
              }),
          }),
        }),
      );
      record.mockClear();
      try {
        const outcome = await changedFiles(
          { projectId: SINGLE_WS, worktreeId: WORKTREE },
          event,
        );
        return {
          outcome,
          queried: query.mock.calls.length,
          recorded: Array.from(record.mock.calls, (call: unknown[]) => [
            ...call,
          ]),
        };
      } finally {
        await attached.shutdown();
      }
    };

    it("keeps this build's daemon refusing the revision typed", async () => {
      const { outcome, queried, recorded } = await fromRefusingDaemon(
        getDesktopInstrumentationConfig().appVersion ?? '',
      );
      expect(outcome).toHaveProperty('error');
      expect(queried).toBeGreaterThan(0);
      expect(recorded).toContainEqual(['refused']);
      expect(recorded).not.toContainEqual(['version_skew']);
    });

    it("lists in process when an earlier build's daemon refuses the revision", async () => {
      expect(rootVersion).not.toBe(
        getDesktopInstrumentationConfig().appVersion,
      );
      const request = { projectId: SINGLE_WS, worktreeId: WORKTREE };
      const expected = await inProcess(request);
      const { outcome, queried, recorded } =
        await fromRefusingDaemon(rootVersion);
      expect(outcome).toEqual(expected);
      expect(queried).toBeGreaterThan(0);
      expect(recorded).toContainEqual(['version_skew']);
    });
  },
);
