/**
 * CAN-6985: worktree graph builds and eager seeds through the real build
 * scheduler reach its `launchBuildHost` while `worktree_code_graph` stays
 * legacy. With the owner set to the daemon (a test-only override of the
 * runtime ownership table) no build host is launched for a worktree graph,
 * while a workspace base graph build still launches one. The utility process
 * launch is the only stand-in: it refuses with a marker, so a reached launch
 * fails the build as `spawn-failed`.
 */
import type * as CoreStorage from '@canopy/core-runtime/storage';

jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  return { ...actual, STORAGE_OWNERSHIP: [...actual.STORAGE_OWNERSHIP] };
});

jest.mock('electron', () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: jest.fn() },
}));

jest.mock('../execution-host/utility-process-host', () => {
  const launch = jest.fn((): never => {
    throw new Error('build host launch reached');
  });
  return {
    getExecutionHostPort: (): unknown => ({ launch }),
    testLaunch: launch,
  };
});

jest.mock('../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: (): boolean => true,
  getCodeGraphGenerationTimeoutMs: (): number => 60_000,
}));

jest.mock('../lib/background-process', () => ({
  lowerSpawnedProcessPriority: jest.fn(),
  leaveBackgroundProcessPolicy: jest.fn(),
}));

import {
  beginCodeGraphWorkerBuild,
  runCodeGraphWorkerEagerSeed,
  type CodeGraphWorkerBuildRequest,
  type CodeGraphWorkerEagerSeedRequest,
} from '../code-graph/build-runner';

const mockLaunch = jest.requireMock<{ testLaunch: jest.Mock }>(
  '../execution-host/utility-process-host',
).testLaunch;

function setGraphOwner(owner: 'legacy' | 'daemon'): void {
  const compiled = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  ).STORAGE_OWNERSHIP;
  const rows = jest.requireMock<{
    STORAGE_OWNERSHIP: CoreStorage.StorageOwnershipRow[];
  }>('@canopy/core-runtime/storage').STORAGE_OWNERSHIP;
  compiled.forEach((row, index) => {
    rows[index] =
      owner === 'daemon' && row.id === 'worktree_code_graph'
        ? { ...row, transitionOwner: 'daemon', currentWriters: ['daemon'] }
        : row;
  });
}

const request = (name: string): CodeGraphWorkerBuildRequest => ({
  dbPath: `/graphs/${name}/graph.db`,
  worktreeRootPath: `/checkouts/${name}`,
  resourcesDir: '/resources',
  repositories: [{ repoId: 'root', rootPath: `/checkouts/${name}` }],
  options: {},
});
const seed = (name: string): CodeGraphWorkerEagerSeedRequest => ({
  operation: 'eager-seed',
  targetDbPath: `/graphs/${name}/graph.db`,
  repositories: [{ repoId: 'root', rootPath: `/checkouts/${name}` }],
  source: { kind: 'base-worktree', dbPath: '/graphs/base/graph.db' },
});

const LAUNCHED = {
  name: 'CodeGraphWorkerBuildError',
  reason: 'spawn-failed',
  message: 'Failed to spawn code-graph build worker: build host launch reached',
};
const REFUSED = {
  name: 'CodeGraphWorkerBuildError',
  reason: 'unavailable',
  message:
    'Storage write to worktree_code_graph by utility_process refused: daemon_owned',
};

beforeEach(() => {
  setGraphOwner('legacy');
  mockLaunch.mockClear();
});

afterAll(() => {
  setGraphOwner('legacy');
});

it('launches a build host for worktree builds and seeds while the store is legacy', async () => {
  await expect(
    beginCodeGraphWorkerBuild('project/legacy-build', request('legacy-build'))
      .promise,
  ).rejects.toMatchObject(LAUNCHED);
  await expect(
    runCodeGraphWorkerEagerSeed('project/legacy-seed', seed('legacy-seed')),
  ).rejects.toMatchObject(LAUNCHED);
  expect(mockLaunch).toHaveBeenCalledTimes(2);
});

it('launches no build host for a worktree graph once the daemon owns it', async () => {
  setGraphOwner('daemon');
  await expect(
    beginCodeGraphWorkerBuild('project/daemon-build', request('daemon-build'))
      .promise,
  ).rejects.toMatchObject(REFUSED);
  await expect(
    runCodeGraphWorkerEagerSeed('project/daemon-seed', seed('daemon-seed')),
  ).rejects.toMatchObject(REFUSED);
  expect(mockLaunch).not.toHaveBeenCalled();
});

it('still launches a build host for a workspace base graph', async () => {
  setGraphOwner('daemon');
  await expect(
    beginCodeGraphWorkerBuild(
      'base:0123456789abcdef0123456789abcdef',
      request('base'),
    ).promise,
  ).rejects.toMatchObject(LAUNCHED);
  expect(mockLaunch).toHaveBeenCalledTimes(1);
});
