import type { useActivityStore as ActivityStoreHook } from '../../renderer/src/stores/activityStore';
import type { useProjectsStore as ProjectsStoreHook } from '../../renderer/src/stores/projectsStore';
// Real Git and registered activity IPC, through the production renderer refresh
// entry points and store. Only IPC registration and unrelated host APIs are fake.
jest.mock('@canopy/ui-shared/primitives/Skeleton', () => ({
  Skeleton: (): null => null,
}));
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type ActivityChangedFilesRequest,
  type ActivityChangedFilesResponse,
} from '@canopy/desktop-shared/types';
import {
  createDiffGoldenFixture,
  SINGLE_WS,
  WORKTREE,
  type DiffGoldenFixture,
} from './helpers/diff-golden-fixtures';
import { registerActivityGoldenHandlers } from './helpers/activity-golden-registration';
import {
  requestChangedFilesRefresh,
  clearWorktreeActivity,
} from '../../renderer/src/stores/changedFilesRefreshRuntime';

// Real Git reads on a loaded CI runner (a large shard of git-heavy goldens)
// can take over Jest's default 5s. The explicit-refresh tests also await their
// read while an older sample is held, so a refresh that waited on that sample
// would never settle and fail at this timeout. A timeout in those tests most
// likely means the explicit path waits on the in-flight batch: check
// requestChangedFilesRefreshInternal before raising this.
jest.setTimeout(15_000);

type Reader = (
  request: ActivityChangedFilesRequest,
) => Promise<ActivityChangedFilesResponse>;
type ActivityStore = typeof ActivityStoreHook;
type ProjectsStore = typeof ProjectsStoreHook;
const mockHandlers = new Map<
  string,
  (
    event: unknown,
    request: ActivityChangedFilesRequest,
  ) => Promise<ActivityChangedFilesResponse>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    key: string,
    handler: (
      event: unknown,
      request: ActivityChangedFilesRequest,
    ) => Promise<ActivityChangedFilesResponse>,
  ): void => {
    mockHandlers.set(key, handler);
  },
}));

let fixture: DiffGoldenFixture;
let registration: ReturnType<typeof registerActivityGoldenHandlers>;
const originalDataDir = process.env.CANOPY_DATA_DIR;
const key = `${SINGLE_WS}/${WORKTREE}`;
beforeAll(() => {
  fixture = createDiffGoldenFixture('can6090-reconciliation-');
  process.env.CANOPY_DATA_DIR = fixture.dataDir;
  registration = registerActivityGoldenHandlers();
});
// Cold store imports take seconds on a loaded runner; keep them out of the
// first test's timeout.
beforeAll(async () => {
  installHost(() =>
    Promise.reject(new Error('No changed-files reader is installed')),
  );
  await loadStores();
});
afterEach(() => clearWorktreeActivity(SINGLE_WS, WORKTREE));
afterAll(async () => {
  await registration.shutdown();
  fixture.cleanup();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
});

function holdFirstRead(failSecond = false): {
  read: Reader;
  sampled: Promise<void>;
  release: () => void;
} {
  const sampled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  return {
    sampled: sampled.promise,
    release: release.resolve,
    read: async (request): Promise<ActivityChangedFilesResponse> => {
      const index = ++reads;
      if (failSecond && index === 2)
        throw new Error('Checkout unavailable during explicit refresh');
      const handler = mockHandlers.get(IPC_CHANNELS.activityChangedFiles);
      if (!handler) throw new Error('Changed-files handler was not registered');
      const files = await handler({}, request);
      if (index === 1) {
        sampled.resolve();
        await release.promise;
      }
      return files;
    },
  };
}

function installHost(read: Reader): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        activity: { getChangedFiles: read },
        getDiffStatsBatch: () => Promise.resolve([]),
      },
      setTimeout,
      clearTimeout,
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { visibilityState: 'visible', hasFocus: () => true },
  });
}

async function loadStores(): Promise<{
  useProjectsStore: ProjectsStore;
  useActivityStore: ActivityStore;
}> {
  const { useProjectsStore } =
    await import('../../renderer/src/stores/projectsStore');
  const { useActivityStore } =
    await import('../../renderer/src/stores/activityStore');
  return { useProjectsStore, useActivityStore };
}

async function installReader(read: Reader): Promise<ActivityStore> {
  installHost(read);
  const { useProjectsStore, useActivityStore } = await loadStores();
  useProjectsStore.setState({
    projects: [
      {
        id: SINGLE_WS,
        type: 'single-repo',
        name: 'Fixture',
        color: '#38BDF8',
        repoPath: fixture.worktreePath(SINGLE_WS),
        collapsed: false,
        order: 0,
        worktrees: [
          {
            id: WORKTREE,
            branchName: WORKTREE,
            createdAt: '2026-11-13T00:00:00.000Z',
          },
        ],
      },
    ],
  });
  useActivityStore.setState({
    changedFiles: { [key]: { uncommitted: [], committed: [] } },
  });
  return useActivityStore;
}

function drainPublication(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

it('explicit refresh publishes a real edit before an older sample can finish', async () => {
  const held = holdFirstRead();
  const store = await installReader(held.read);
  const old = requestChangedFilesRefresh(SINGLE_WS, WORKTREE, {
    kind: 'automatic',
  });
  try {
    await held.sampled;
    writeFileSync(
      join(fixture.worktreePath(SINGLE_WS), 'fresh-after-sample.txt'),
      'fresh\n',
    );
    const explicit = requestChangedFilesRefresh(SINGLE_WS, WORKTREE, {
      kind: 'explicit',
    });
    // The older sample stays held until the explicit read settles. Ordering,
    // not a wall-clock window, proves the explicit refresh does not wait on it.
    const files = await explicit;
    const hasFresh = (
      list: ActivityChangedFilesResponse | undefined,
    ): boolean =>
      list?.uncommitted.some(
        (file) => file.path === 'fresh-after-sample.txt',
      ) ?? false;
    expect(hasFresh(files)).toBe(true);
    // Published before the older sample is released...
    expect(hasFresh(store.getState().changedFiles[key])).toBe(true);
    held.release();
    await old;
    await drainPublication();
    // ...and the released older sample does not overwrite it.
    expect(hasFresh(store.getState().changedFiles[key])).toBe(true);
  } finally {
    held.release();
    await old;
  }
});

it('a later automatic request sees an external edit after the first sample', async () => {
  const held = holdFirstRead();
  await installReader(held.read);
  const first = requestChangedFilesRefresh(SINGLE_WS, WORKTREE, {
    kind: 'automatic',
  });
  try {
    await held.sampled;
    writeFileSync(
      join(fixture.worktreePath(SINGLE_WS), 'external-edit.txt'),
      'outside renderer events\n',
    );
    const next = requestChangedFilesRefresh(SINGLE_WS, WORKTREE, {
      kind: 'automatic',
    });
    held.release();
    const [, files] = await Promise.all([first, next]);
    expect(
      files?.uncommitted.some((file) => file.path === 'external-edit.txt'),
    ).toBe(true);
  } finally {
    held.release();
    await first;
  }
});

it('a response from a removed lifecycle cannot populate its recreated IDs', async () => {
  const held = holdFirstRead();
  const store = await installReader(held.read);
  const old = requestChangedFilesRefresh(SINGLE_WS, WORKTREE, {
    kind: 'automatic',
  });
  try {
    await held.sampled;
    store.getState().cleanupWorktree(SINGLE_WS, WORKTREE);
    store.setState({
      changedFiles: { [key]: { uncommitted: [], committed: [] } },
    });
    held.release();
    await old;
    await drainPublication();
    expect(store.getState().changedFiles[key]).toEqual({
      uncommitted: [],
      committed: [],
    });
  } finally {
    held.release();
    await old;
  }
});

it('an explicit failure refuses the older response and permits a fresh retry', async () => {
  const held = holdFirstRead(true);
  const store = await installReader(held.read);
  const old = requestChangedFilesRefresh(SINGLE_WS, WORKTREE, {
    kind: 'automatic',
  });
  try {
    await held.sampled;
    const explicit = requestChangedFilesRefresh(SINGLE_WS, WORKTREE, {
      kind: 'explicit',
    });
    // Settles while the older sample is still held, as in the first test.
    const outcome = await explicit.then(
      () => null,
      (error: unknown) => error,
    );
    held.release();
    await old;
    await drainPublication();
    expect(outcome).toEqual(
      new Error('Checkout unavailable during explicit refresh'),
    );
    expect(store.getState().changedFiles[key]).toEqual({
      uncommitted: [],
      committed: [],
    });
    const retry = await requestChangedFilesRefresh(SINGLE_WS, WORKTREE, {
      kind: 'explicit',
    });
    expect(retry?.uncommitted.length).toBeGreaterThan(0);
  } finally {
    held.release();
    await old;
  }
});

it('a replacement lifecycle in the workspace list refuses an old sample', async () => {
  const held = holdFirstRead();
  const store = await installReader(held.read);
  const { useProjectsStore } = await loadStores();
  const old = requestChangedFilesRefresh(SINGLE_WS, WORKTREE, {
    kind: 'automatic',
  });
  try {
    await held.sampled;
    useProjectsStore.setState((state) => ({
      projects: state.projects.map((project) =>
        project.type === 'cowork'
          ? project
          : {
              ...project,
              worktrees: project.worktrees.map((row) => ({
                ...row,
                createdAt: '2026-11-14T00:00:00.000Z',
              })),
            },
      ),
    }));
    held.release();
    await old;
    await drainPublication();
    expect(store.getState().changedFiles[key]).toEqual({
      uncommitted: [],
      committed: [],
    });
  } finally {
    held.release();
    await old;
  }
});
