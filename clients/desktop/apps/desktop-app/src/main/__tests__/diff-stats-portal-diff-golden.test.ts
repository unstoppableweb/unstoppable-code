import { installRoutedW5GoldenStore } from '../lib/__tests__/fixtures/w5-routed-golden-store';
// CAN-4070 rule: captured on the unchanged `worktree:diff-stats`,
// `worktree:diff-stats-batch` IPC handlers and the `portal.diff.read` Portal
// command before CAN-4103 moved diff computation behind `worker.git.diff.get`.
// Real data root, workspace records, Git checkouts and bare origins; only IPC
// registration is mocked.
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  type PortalCommandEnvelope,
  type PortalCommandPayloadMap,
  type PortalDiffReadPayload,
  type PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
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
import { handlePortalDiffRead } from '../portal/adapters/diff-adapter';
import type { PortalAdapterContext } from '../portal/adapters/types';
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

function portalCommand(
  payload: PortalDiffReadPayload,
): PortalCommandEnvelope<PortalCommandPayloadMap['portal.diff.read']> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    sequence: 1,
    type: 'portal.diff.read',
    createdAt: '2026-10-31T00:00:00.000Z',
    expiresAt: null,
    payload,
  };
}

/**
 * The command's outcome. The snapshot event repeats the completion's roster
 * and patch, so it is recorded by its type and whether it matches; `roster`
 * `count` keeps a per-path read to the roster size.
 */
async function portalDiff(
  payload: PortalDiffReadPayload,
  roster: 'full' | 'count' = 'full',
): Promise<unknown> {
  const events: PortalEventEnvelope[] = [];
  const completed: unknown[] = [];
  const failed: unknown[] = [];
  const context: PortalAdapterContext = {
    getWindow: () => null,
    enqueueEvent: (event: PortalEventEnvelope): void => {
      events.push(event);
    },
    complete: (_command, result): void => {
      completed.push(result);
    },
    fail: (_command, code, message, retryable): void => {
      failed.push({ code, message: fixture.scrub(message), retryable });
    },
  };
  await handlePortalDiffRead(portalCommand(payload), context);
  const field = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null
      ? Reflect.get(value, key)
      : undefined;
  return scrubbed({
    events: events.map((event) => ({
      type: event.type,
      matchesCompletion:
        JSON.stringify(field(event.payload, 'files')) ===
          JSON.stringify(field(completed[0], 'files')) &&
        field(event.payload, 'patch') === (field(completed[0], 'patch') ?? ''),
      filePath: field(event.payload, 'filePath'),
    })),
    completed: completed.map((result) => {
      if (roster === 'full' || typeof result !== 'object' || result === null)
        return result;
      const files = field(result, 'files');
      return {
        ...result,
        files: Array.isArray(files) ? files.length : files,
      };
    }),
    failed,
  });
}

describe('portal.diff.read', () => {
  const sources = ['uncommitted', 'committed', 'combined'] as const;

  it('reads the roster and the combined patch for each source', async () => {
    for (const source of [...sources, undefined])
      expect(
        await portalDiff({
          workspaceId: SINGLE_WS,
          worktreeId: WORKTREE,
          ...(source === undefined ? {} : { source }),
        }),
      ).toMatchSnapshot(String(source));
  });

  it('reads one path for each source', async () => {
    for (const path of [
      'edit.txt',
      'renamed.txt',
      'image.bin',
      'uncommitted-edit.txt',
      'staged-new.txt',
      'untracked.txt',
      'missing.txt',
    ])
      for (const source of sources)
        expect(
          await portalDiff(
            { workspaceId: SINGLE_WS, worktreeId: WORKTREE, path, source },
            'count',
          ),
        ).toMatchSnapshot(`${path} ${source}`);
  });

  it('reads the other worktree states', async () => {
    for (const [workspaceId, worktreeId] of SCOPES.slice(1))
      for (const source of sources)
        expect(
          // The Portal roster keeps every untracked file: count many-ws's.
          await portalDiff(
            { workspaceId, worktreeId, source },
            workspaceId === MANY_WS ? 'count' : 'full',
          ),
        ).toMatchSnapshot(`${workspaceId}/${worktreeId} ${source}`);
  });

  it('selects multi-repo checkouts by repository id', async () => {
    for (const [repoId, path] of [
      [WORKSPACE_ROOT_REPO_ID, 'root.txt'],
      ['alpha', 'shared.txt'],
      ['beta', undefined],
    ] as const)
      expect(
        await portalDiff({
          workspaceId: MULTI_WS,
          worktreeId: WORKTREE,
          repoId,
          ...(path === undefined ? {} : { path }),
          source: 'combined',
        }),
      ).toMatchSnapshot(`${repoId} ${String(path)}`);
  });

  posixIt('reads quoted names', async () => {
    for (const source of sources)
      expect(
        await portalDiff({
          workspaceId: POSIX_WS,
          worktreeId: WORKTREE,
          source,
        }),
      ).toMatchSnapshot(source);
  });

  it('keeps request validation failures', async () => {
    for (const payload of [
      { workspaceId: 'Bad', worktreeId: WORKTREE },
      { workspaceId: SINGLE_WS, worktreeId: WORKTREE, path: '../x' },
      { workspaceId: SINGLE_WS, worktreeId: WORKTREE, path: '/etc/hosts' },
    ])
      expect(await portalDiff(payload)).toMatchSnapshot(
        JSON.stringify(payload),
      );
  });
});
