/**
 * CAN-6985: Electron main's worker-plane store writes pass the storage
 * ownership admission. While `script_runs` and `worktree_code_graph` stay
 * legacy every write goes ahead as before; with the owner set to the daemon
 * (a test-only override of the runtime ownership table) each is refused with
 * a typed answer before anything is written or launched:
 * - run logs: every write and delete enters the run-log lock, which refuses;
 * - worktree graphs: builds, eager seeds and summary repairs on the build
 *   utility process, and snapshot imports on a read utility process.
 * Workspace base graphs share the build scheduler but are another store and
 * stay admitted.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type * as BuildScheduler from '@canopy/code-graph/host/build-scheduler';
import type * as ReadService from '@canopy/code-graph/host/read-service';

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

jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: (): unknown => ({
    registerProcess: (): unknown => ({ unregister: (): void => undefined }),
  }),
}));

// The build runner's scheduler and the desktop read service's worker
// service are stand-ins that record what reaches them.
jest.mock('@canopy/code-graph/host/build-scheduler', () => {
  const scheduler = {
    runBuild: jest.fn(() => Promise.resolve({ ok: true })),
    beginBuild: jest.fn(() => ({
      attemptId: 'attempt',
      promise: Promise.resolve({ ok: true }),
    })),
    runEagerSeed: jest.fn(() => Promise.resolve({ ok: true })),
    requestSummaryRepair: jest.fn(() =>
      Promise.resolve({ ok: false, attemptId: null, reason: 'cooldown' }),
    ),
    testHooks: {},
  };
  return {
    ...jest.requireActual<typeof BuildScheduler>(
      '@canopy/code-graph/host/build-scheduler',
    ),
    createCodeGraphBuildScheduler: (): unknown => scheduler,
    testScheduler: scheduler,
  };
});
jest.mock('@canopy/code-graph/host/read-service', () => {
  const service = {
    importSnapshot: jest.fn(() => Promise.resolve(IMPORTED)),
  };
  return {
    ...jest.requireActual<typeof ReadService>(
      '@canopy/code-graph/host/read-service',
    ),
    createCodeGraphReadService: (): unknown => service,
    testReadService: service,
  };
});
jest.mock('../code-graph/read-runner', () => ({
  runCodeGraphWorkerRead: jest.fn(),
}));
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: (): null => null,
}));
jest.mock('../lib/code-graph-base-manager', () => ({
  describeCodeGraphBaseWorkspace: jest.fn(),
  resolveCodeGraphBaseWorkspaceFingerprint: jest.fn(),
}));

import { StorageWriteRefusedError } from '@canopy/core-runtime/storage';
import { CodeGraphWorkerBuildError } from '@canopy/code-graph/host/build-scheduler';
import {
  beginCodeGraphWorkerBuild,
  requestCodeGraphSummaryRepair,
  runCodeGraphWorkerBuild,
  runCodeGraphWorkerEagerSeed,
  type CodeGraphWorkerBuildRequest,
  type CodeGraphWorkerEagerSeedRequest,
} from '../code-graph/build-runner';
import { desktopCodeGraphReadWorker } from '../code-graph/read-service-host';
import { desktopScriptWorker } from '../lib/script-runner';
import { resolveScriptRunDir } from '../lib/paths';

const IMPORTED = {
  warnings: [],
  filesImported: 1,
  symbolsImported: 2,
  edgesImported: 3,
};

const mockScheduler = jest.requireMock<{
  testScheduler: Record<
    'runBuild' | 'beginBuild' | 'runEagerSeed' | 'requestSummaryRepair',
    jest.Mock
  >;
}>('@canopy/code-graph/host/build-scheduler').testScheduler;
const mockReadService = jest.requireMock<{
  testReadService: { importSnapshot: jest.Mock };
}>('@canopy/code-graph/host/read-service').testReadService;

type Store = 'script_runs' | 'worktree_code_graph';

/** The daemon owns `stores`; every other row is as compiled. */
function setDaemonOwned(stores: readonly Store[]): void {
  const compiled = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  ).STORAGE_OWNERSHIP;
  const rows = jest.requireMock<{
    STORAGE_OWNERSHIP: CoreStorage.StorageOwnershipRow[];
  }>('@canopy/core-runtime/storage').STORAGE_OWNERSHIP;
  compiled.forEach((row, index) => {
    rows[index] = stores.some((store) => store === row.id)
      ? { ...row, transitionOwner: 'daemon', currentWriters: ['daemon'] }
      : row;
  });
}

const PROJECT_ID = 'admission-project';
const WORKTREE_ID = 'admission-worktree';
const WORKTREE_KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const BASE_KEY = 'base:0123456789abcdef0123456789abcdef';

const buildRequest: CodeGraphWorkerBuildRequest = {
  dbPath: '/graphs/graph.db',
  worktreeRootPath: '/checkout',
  resourcesDir: '/resources',
  repositories: [{ repoId: 'root', rootPath: '/checkout' }],
  options: {},
};
const seedRequest: CodeGraphWorkerEagerSeedRequest = {
  operation: 'eager-seed',
  targetDbPath: '/graphs/graph.db',
  repositories: [{ repoId: 'root', rootPath: '/checkout' }],
  source: { kind: 'base-worktree', dbPath: '/graphs/base.db' },
};
const repairRequest = {
  key: WORKTREE_KEY,
  projectId: PROJECT_ID,
  worktreeId: WORKTREE_ID,
  dbPath: '/graphs/graph.db',
};
const signal = new AbortController().signal;
const importParams = {
  scope: { workspaceId: PROJECT_ID, worktreeId: WORKTREE_ID },
  snapshot: { kind: 'snapshot' },
};

let root = '';
let previousDataDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'worker-store-admission-'));
  previousDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = path.join(root, 'data');
  setDaemonOwned([]);
  jest.clearAllMocks();
});

afterEach(() => {
  setDaemonOwned([]);
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

/** Where the run-log lock (a W5 process file lock) keeps its files. */
function lockDir(): string {
  return path.join(root, 'data', 'runtime', 'locks');
}

/** A run log on disk for the worktree; returns its file. */
function writeRunLog(): string {
  const runDir = resolveScriptRunDir(PROJECT_ID, WORKTREE_ID);
  mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, 'dev.log');
  writeFileSync(file, 'started\n');
  return file;
}

describe('run-log writes (script_runs)', () => {
  it('deletes the run logs while the store is legacy', async () => {
    const file = writeRunLog();
    await desktopScriptWorker.logs.deleteWorktree(PROJECT_ID, WORKTREE_ID);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(lockDir())).toBe(true);
  });

  it('refuses before the lock once the daemon owns the store', async () => {
    const file = writeRunLog();
    setDaemonOwned(['script_runs']);
    const refusal = desktopScriptWorker.logs.deleteWorktree(
      PROJECT_ID,
      WORKTREE_ID,
    );
    await expect(refusal).rejects.toBeInstanceOf(StorageWriteRefusedError);
    await expect(refusal).rejects.toMatchObject({
      namespaceId: 'script_runs',
      writer: 'electron_main',
      reason: 'daemon_owned',
    });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(lockDir())).toBe(false);
  });

  it('is not refused for a worktree graph flip', async () => {
    const file = writeRunLog();
    setDaemonOwned(['worktree_code_graph']);
    await desktopScriptWorker.logs.deleteWorktree(PROJECT_ID, WORKTREE_ID);
    expect(existsSync(file)).toBe(false);
  });

  it('still copies a run log out once the daemon owns the store, a read, while writes stay refused', async () => {
    const ref = await desktopScriptWorker.logs.start({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      script: {
        scriptKey: 'project:setup',
        scriptName: 'setup',
        label: 'Setup',
        command: 'echo ready',
        lifecycle: 'setup',
        target: 'project',
      },
      invocation: 'automatic-setup',
    });
    await desktopScriptWorker.logs.append({ ref, lines: ['ready'] });
    setDaemonOwned(['script_runs']);
    const targetPath = path.join(root, 'artifacts', 'setup.log');
    await expect(
      desktopScriptWorker.logs.snapshot({ ref, targetPath }),
    ).resolves.toEqual({ status: 'copied' });
    expect(readFileSync(targetPath, 'utf8')).toContain('ready');
    await expect(
      desktopScriptWorker.logs.append({ ref, lines: ['later'] }),
    ).rejects.toMatchObject({ reason: 'daemon_owned' });
  });
});

describe('worktree graph writes on the build utility process', () => {
  it('forwards every worktree write unchanged while the store is legacy', async () => {
    await expect(
      runCodeGraphWorkerBuild(WORKTREE_KEY, buildRequest),
    ).resolves.toEqual({ ok: true });
    const handle = beginCodeGraphWorkerBuild(WORKTREE_KEY, buildRequest);
    expect(handle.attemptId).toBe('attempt');
    await expect(handle.promise).resolves.toEqual({ ok: true });
    await expect(
      runCodeGraphWorkerEagerSeed(WORKTREE_KEY, seedRequest),
    ).resolves.toEqual({ ok: true });
    await expect(requestCodeGraphSummaryRepair(repairRequest)).resolves.toEqual(
      { ok: false, attemptId: null, reason: 'cooldown' },
    );
    expect(mockScheduler.runBuild).toHaveBeenCalledWith(
      WORKTREE_KEY,
      buildRequest,
      undefined,
    );
    expect(mockScheduler.beginBuild).toHaveBeenCalledWith(
      WORKTREE_KEY,
      buildRequest,
      undefined,
    );
    expect(mockScheduler.runEagerSeed).toHaveBeenCalledWith(
      WORKTREE_KEY,
      seedRequest,
      undefined,
    );
    expect(mockScheduler.requestSummaryRepair).toHaveBeenCalledWith(
      repairRequest,
    );
  });

  it('refuses each worktree write once the daemon owns the store, launching nothing', async () => {
    setDaemonOwned(['worktree_code_graph']);
    const refused = {
      reason: 'unavailable',
      message:
        'Storage write to worktree_code_graph by utility_process refused: daemon_owned',
    };
    const build = runCodeGraphWorkerBuild(WORKTREE_KEY, buildRequest);
    await expect(build).rejects.toBeInstanceOf(CodeGraphWorkerBuildError);
    await expect(build).rejects.toMatchObject(refused);
    const handle = beginCodeGraphWorkerBuild(WORKTREE_KEY, buildRequest);
    expect(handle.attemptId).toBeNull();
    await expect(handle.promise).rejects.toMatchObject(refused);
    await expect(
      runCodeGraphWorkerEagerSeed(WORKTREE_KEY, seedRequest),
    ).rejects.toMatchObject(refused);
    await expect(requestCodeGraphSummaryRepair(repairRequest)).resolves.toEqual(
      { ok: false, attemptId: null, ...refused },
    );
    expect(mockScheduler.runBuild).not.toHaveBeenCalled();
    expect(mockScheduler.beginBuild).not.toHaveBeenCalled();
    expect(mockScheduler.runEagerSeed).not.toHaveBeenCalled();
    expect(mockScheduler.requestSummaryRepair).not.toHaveBeenCalled();
  });

  it('still builds workspace base graphs once the daemon owns worktree graphs', async () => {
    setDaemonOwned(['worktree_code_graph']);
    await expect(
      beginCodeGraphWorkerBuild(BASE_KEY, buildRequest).promise,
    ).resolves.toEqual({ ok: true });
    expect(mockScheduler.beginBuild).toHaveBeenCalledWith(
      BASE_KEY,
      buildRequest,
      undefined,
    );
  });
});

describe('worktree graph snapshot imports on a read utility process', () => {
  it('imports while the store is legacy', async () => {
    await expect(
      desktopCodeGraphReadWorker.importSnapshot(importParams, signal),
    ).resolves.toEqual({ ok: true, value: IMPORTED });
    expect(mockReadService.importSnapshot).toHaveBeenCalledWith({
      ...importParams,
      signal,
    });
  });

  it('refuses as a failed precondition once the daemon owns the store', async () => {
    setDaemonOwned(['worktree_code_graph']);
    await expect(
      desktopCodeGraphReadWorker.importSnapshot(importParams, signal),
    ).resolves.toEqual({
      ok: false,
      request: 'failed-precondition',
      message:
        "This worktree's code graph is written by the background service.",
    });
    expect(mockReadService.importSnapshot).not.toHaveBeenCalled();
  });
});
