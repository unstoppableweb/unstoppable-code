// CAN-7302: desktop startup recovery does not wait for pipeline install
// recovery, and every install still does. It drives the real install-intents
// module over a temporary data root and holds install recovery on its first
// read of the intents directory, the observable stand-in for a rollback that
// hangs. The interrupted-work scan and the chat services are stubs. It asserts
// observable behaviour only: whether startup recovery and an install settle,
// what startup recovery reports, and the warning a failed recovery logs.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as InstallIntents from '../../pipelines/pipeline-install-intents';
import type * as InterruptedWorkRecovery from '../interrupted-work-recovery';

interface Held {
  release: () => void;
  fail: (error: Error) => void;
}

interface MockState {
  root: string;
  /** Set to hold install recovery's first read of the intents directory. */
  holdIntentsRead: boolean;
  held: Held | null;
  intentsReads: number;
  /** Set to hold the next read of the intents row's owner record. */
  holdOwnerRead: boolean;
  ownerHeld: { release: (record: string | null) => void } | null;
  ownerReads: number;
  scanErrors: string[];
  warnings: string[];
}

const mockState: MockState = {
  root: '',
  holdIntentsRead: false,
  held: null,
  intentsReads: 0,
  holdOwnerRead: false,
  ownerHeld: null,
  ownerReads: 0,
  scanErrors: [],
  warnings: [],
};

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const absent = (): Error =>
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    ...actual,
    // The intents row's owner record (CAN-7690) is served here like the
    // intents directory: absent by default, holdable. Other reads are real.
    readFile: (
      ...args: Parameters<typeof actual.readFile>
    ): Promise<unknown> => {
      const [path] = args;
      if (
        typeof path !== 'string' ||
        path !==
          `${mockState.root}/storage-records/pipeline_install_intents/owner-flip.json`
      )
        return actual.readFile(...args);
      mockState.ownerReads += 1;
      if (!mockState.holdOwnerRead) return Promise.reject(absent());
      mockState.holdOwnerRead = false;
      return new Promise((resolve, reject) => {
        mockState.ownerHeld = {
          release: (record): void => {
            if (record === null) reject(absent());
            else resolve(record);
          },
        };
      });
    },
    readdir: (...args: Parameters<typeof actual.readdir>): Promise<unknown> => {
      if (String(args[0]) !== `${mockState.root}/intents`)
        return actual.readdir(...args);
      mockState.intentsReads += 1;
      if (!mockState.holdIntentsRead) return actual.readdir(...args);
      return new Promise((resolve, reject) => {
        mockState.held = {
          release: (): void => {
            actual.readdir(...args).then(resolve, reject);
          },
          fail: (error): void => reject(error),
        };
      });
    },
  };
});
jest.mock('../paths', () => ({
  getDataDir: (): string => mockState.root,
  getPipelineInstallIntentsDir: (): string => `${mockState.root}/intents`,
  getPipelinePackageInstallStorePath: (): string =>
    `${mockState.root}/installs.json`,
  getPipelineAssetsDir: (id: string): string =>
    `${mockState.root}/pipeline-data/${id}/assets`,
  getPipelineAssetsManifestPath: (id: string): string =>
    `${mockState.root}/pipeline-data/${id}/assets.json`,
  getWorkspacesRootDir: (): string => `${mockState.root}/workspaces`,
  getAppWorkspacesRootDir: (): string => `${mockState.root}/app-workspaces`,
}));
jest.mock('../main-process-logging', () => ({
  logMainProcessWarn: (message: string): void => {
    mockState.warnings.push(message);
  },
  logMainProcessError: (): void => undefined,
}));
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (): unknown => {
      const listeners = new Map<string, (value: unknown) => void>();
      return {
        once: (event: string, listener: (value: unknown) => void): void => {
          listeners.set(event, listener);
        },
        postMessage: (): void => {
          void Promise.resolve().then(() =>
            listeners.get('message')?.({
              result: {
                pipelineIds: [],
                daemonCommitHookIds: [],
                errors: [...mockState.scanErrors],
                chatScopes: [],
              },
            }),
          );
        },
        kill: (): void => undefined,
      };
    },
  },
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): { getState: () => Promise<void> } => ({
    getState: (): Promise<void> => Promise.resolve(),
  }),
}));
jest.mock('../../services/chat-queue-service', () => ({
  getChatQueueService: (): { holdDrainsForStartup: () => void } => ({
    holdDrainsForStartup: (): void => undefined,
  }),
}));
jest.mock('@canopy/execution-engine/pipelines/store', () => ({
  ...jest.requireActual<object>('@canopy/execution-engine/pipelines/store'),
  reconcileStoredPipelineIndex: (): { ok: true } => ({ ok: true }),
}));
jest.mock('../../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: (): { executionsDir: string } => ({
    executionsDir: `${mockState.root}/executions`,
  }),
}));
jest.mock('../../pipelines/pipeline-owner-fence', () => ({
  configureDesktopPipelineOwnerFence: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../pipelines/pipeline-worker-dispatch', () => ({
  sweepOrphanedPipelinesThroughLocalWorker: (): Promise<[]> =>
    Promise.resolve([]),
}));
jest.mock('../../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemLocalUninstall: (): void => undefined,
}));
jest.mock('../../pipelines/pipeline-local-metadata-store', () => ({
  deleteUserPipelineLocalMetadata: (): void => undefined,
}));

const HOUR = 60 * 60 * 1000;
const RECOVERY_WARNING = '[pipeline-install] Install recovery did not finish';
/** An install intent: what `beginPipelineInstallIntent` resolves to. */
const anIntent: unknown = expect.objectContaining({
  finish: expect.any(Function) as unknown,
});

interface Loaded {
  startup: typeof InterruptedWorkRecovery;
  installs: typeof InstallIntents;
}

/** A fresh process: install recovery runs once per process. */
async function launch(): Promise<Loaded> {
  let loaded: Loaded | undefined;
  await jest.isolateModulesAsync(async () => {
    const installs = await import('../../pipelines/pipeline-install-intents');
    const startup = await import('../interrupted-work-recovery');
    loaded = { installs, startup };
  });
  if (!loaded) throw new Error('the startup modules did not load');
  return loaded;
}

interface Tracked<T> {
  settled: () => boolean;
  promise: Promise<T>;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  let done = false;
  const settle = (): void => {
    done = true;
  };
  promise.then(settle, settle);
  return { settled: () => done, promise };
}

async function elapse(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  mockState.root = await mkdtemp(join(tmpdir(), 'canopy-startup-installs-'));
  mockState.holdIntentsRead = false;
  mockState.held = null;
  mockState.intentsReads = 0;
  mockState.holdOwnerRead = false;
  mockState.ownerHeld = null;
  mockState.ownerReads = 0;
  mockState.scanErrors = [];
  mockState.warnings = [];
});

afterEach(async () => {
  mockState.held?.release();
  mockState.ownerHeld?.release(null);
  jest.useRealTimers();
  await rm(mockState.root, { recursive: true, force: true });
});

describe('desktop startup recovery and pipeline install recovery (CAN-7302)', () => {
  it('startup recovery finishes while an install rollback hangs, and it still started the rollback', async () => {
    mockState.holdIntentsRead = true;
    const { startup } = await launch();
    const recovered = track(startup.recoverInterruptedWorkAtStartup());
    await elapse(HOUR);
    expect(mockState.intentsReads).toBe(1);
    expect(recovered.settled()).toBe(true);
    await expect(recovered.promise).resolves.toBeUndefined();
  });

  it('an install still waits for the hanging rollback, and starts once it finishes', async () => {
    mockState.holdIntentsRead = true;
    const { startup, installs } = await launch();
    void startup.recoverInterruptedWorkAtStartup();
    await elapse(0);
    const install = track(installs.beginPipelineInstallIntent('shared'));
    await elapse(HOUR);
    expect(install.settled()).toBe(false);
    mockState.held?.release();
    await elapse(0);
    await expect(install.promise).resolves.toEqual(anIntent);
  });

  it('a failed install recovery leaves startup recovery unchanged, logs it, and lets the install proceed', async () => {
    mockState.holdIntentsRead = true;
    const { startup, installs } = await launch();
    const recovered = track(startup.recoverInterruptedWorkAtStartup());
    await elapse(0);
    mockState.held?.fail(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    await elapse(0);
    await expect(recovered.promise).resolves.toBeUndefined();
    await expect(
      installs.beginPipelineInstallIntent('shared'),
    ).resolves.toEqual(anIntent);
    expect(mockState.warnings).toContain(RECOVERY_WARNING);
  });

  it("startup recovery still reports the scan's own errors", async () => {
    mockState.scanErrors = ['Chat workspace-1/worktree-1: unreadable'];
    const { startup } = await launch();
    await expect(startup.recoverInterruptedWorkAtStartup()).rejects.toThrow(
      'Chat workspace-1/worktree-1: unreadable',
    );
  });

  it('install recovery starts no rollback before the owner check answers, and a record naming the daemon fences the interrupted install, writing nothing (CAN-7690)', async () => {
    const first = await launch();
    const intent = await first.installs.beginPipelineInstallIntent('shared');
    await intent.noteDefinition({
      definitionId: 'half-installed',
      change: 'linked',
      contentHash: 'a'.repeat(64),
    });
    // The process exits here, its intent still on disk.
    const intents = `${mockState.root}/intents`;
    const before = await readdir(intents);
    expect(before.filter((name) => name.endsWith('.json'))).toHaveLength(1);
    const bytes = await Promise.all(
      before.map((name) => readFile(join(intents, name))),
    );
    mockState.intentsReads = 0;
    mockState.holdOwnerRead = true;
    const { startup, installs } = await launch();
    const recovered = track(startup.recoverInterruptedWorkAtStartup());
    await elapse(HOUR);
    // Held owner check: the intents are not read and nothing is rolled back.
    expect(mockState.ownerHeld).not.toBeNull();
    expect(mockState.intentsReads).toBe(0);
    expect(recovered.settled()).toBe(true);
    mockState.ownerHeld?.release(
      JSON.stringify({
        namespaceId: 'pipeline_install_intents',
        fromOwner: 'legacy',
        toOwner: 'daemon',
        workPackage: 'W6',
        backupRecord: `storage-records/pipeline_install_intents/namespace-backup.json#sha256:${'a'.repeat(64)}`,
        flippedAt: '2026-11-24T10:00:00.000Z',
      }),
    );
    mockState.ownerHeld = null;
    await elapse(0);
    await expect(
      installs.pipelineDefinitionRecoveryRefusal('half-installed'),
    ).resolves.toMatchObject({ errorCode: 'pipeline_definition_unconfirmed' });
    const after = await readdir(intents);
    expect(after).toEqual(before);
    await expect(
      Promise.all(after.map((name) => readFile(join(intents, name)))),
    ).resolves.toEqual(bytes);
  });
});
