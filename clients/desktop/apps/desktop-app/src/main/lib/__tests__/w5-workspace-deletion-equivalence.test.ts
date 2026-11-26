import './fixtures/w5-boundary-daemon-cleanup';
import type * as LegacyStorage from './fixtures/w5-legacy-storage';
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<typeof LegacyStorage>('./fixtures/w5-legacy-storage')
    .createLegacyW5StorageMock(),
);
import { getCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import type {
  ArchiveRecoveryReceipt,
  ArchiveRecoveryStore,
} from '@canopy/desktop-shared/node/archive-recovery-store';
import type { ArchiveRecoverySettlementPorts } from '../archive-recovery-settlement';
import type { WorktreeRecoveryResolveParams } from '@canopy/protocol/canopy-core';
import {
  CORE_WORKTREE_RECOVERY_QUERIES,
  CORE_WORKTREE_RECOVERY_INSTRUCTIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  createCanopyDispatcher,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import { createCoreWorktreeRecoveryAdapter } from '../../canopy-runtime/core-worktree-recovery-adapter';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import {
  worktreeRecoveryOfferedActions,
  type WorktreeRecoveryDescription,
  type WorktreeRecoveryOfferedAction,
} from '@canopy/protocol/remote-control/shell/worktree-recovery';
import {
  journalSchema,
  type DestructiveRecoveryRecord,
} from '@canopy/desktop-shared/node/w5-destructive-journal';
// CAN-5598: W5 deletion boundary equivalence through the real worker.
// Preserves the CAN-4961/CAN-4975 admission and atomic-removal contracts.
import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as MainProcessLogging from '../main-process-logging';
import type * as RecordDecisionPort from '../workspace-record-decision-port';
import { z } from 'zod';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
jest.mock('../workspace-record-decision-port', () => {
  const actual = jest.requireActual<typeof RecordDecisionPort>(
    '../workspace-record-decision-port',
  );
  return {
    ...actual,
    applyWorkspaceIndexRemoval: jest.fn(
      (...args: Parameters<typeof actual.applyWorkspaceIndexRemoval>) =>
        actual.applyWorkspaceIndexRemoval(...args),
    ),
  };
});
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
jest.mock('../auto-archive-teardown', () => ({
  runAutoArchiveTeardown: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() => Promise.resolve('retirement')),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalScope: jest.fn(() => Promise.resolve()),
    commitLocalScopeCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalScopeFence: jest.fn(() => Promise.resolve()),
    cancelLocalWorkspace: jest.fn(() => Promise.resolve()),
    commitLocalWorkspaceCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalWorkspaceFence: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorkspaceDocs: jest.fn(() => Promise.resolve()),
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
    worktreeContainerArchived: jest.fn(() => Promise.resolve()),
    worktreeContainerRestored: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
  notifyLedgerContainerArchived: jest.fn(),
}));
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
    interruptMatchingEntries: jest.fn(),
  })),
}));
jest.mock('../../services/desktop-structure-signal', () => ({
  scheduleDesktopStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
/** Runs before a worker request; a throw fails that request. */
let mockArchiveIoFault:
  | ((request: ArchiveIoOperationRequest) => void)
  | undefined;
/** Runs after a worker request succeeds; a throw loses its response. */
let mockArchiveIoAfter:
  | ((request: ArchiveIoOperationRequest) => void)
  | undefined;
jest.mock('../../archive/archive-io-runner', () => ({
  // Replace Electron utility-process transport with the real filesystem engine.
  runArchiveIoRequest: async (
    request: ArchiveIoOperationRequest,
  ): Promise<ArchiveIoResultMap[ArchiveIoOperationType]> => {
    mockArchiveIoFault?.(request);
    const result = await jest
      .requireActual<typeof ArchiveEngine>('../../archive/archive-io-engine')
      .executeArchiveIoRequest(request, new AbortController().signal, {
        progress: () => {},
        child: { started: () => {}, exited: () => {} },
      });
    mockArchiveIoAfter?.(request);
    return result;
  },
}));
jest.mock('../../cost-index/lifecycle', () => ({
  ...jest.requireActual<typeof CostLifecycle>('../../cost-index/lifecycle'),
  prepareEntryCostArchive: jest.fn(() => Promise.resolve()),
  finishEntryCostArchive: jest.fn(() => Promise.resolve()),
}));
jest.mock('../main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>('../main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));

import type {
  ArchiveIoOperationRequest,
  ArchiveIoResultMap,
  ArchiveIoOperationType,
} from '../../archive/archive-io-protocol';
import type * as ArchiveEngine from '../../archive/archive-io-engine';
import { execFileSync } from 'node:child_process';
import fs, {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { devNull } from 'node:os';
import fsPromises from 'node:fs/promises';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ArchivedContainerManifest,
} from '@canopy/desktop-shared/types';
import {
  W5CommitLogHost,
  W5CommitLogHostError,
} from '../../w5-commit-log/commit-log-host';
import {
  W5CommitLog,
  fingerprintW5File,
  type W5Resource,
} from '@canopy/core-runtime/node/w5/commit-log';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  readW5Revisions,
  W5RevisionConflictError,
  W5FileWriteRefusedError,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import * as directoryRemoval from '../w5-workspace-directory-removal';
import {
  WORKSPACE_MANIFEST_STORAGE,
  withStorageAdmission,
} from '../w5-storage';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import * as sidebarItems from '../sidebar-items';
import * as workspacePersistence from '../workspace-persistence';
import {
  setBeforeProjectPluginDefaultsChangeHandler,
  updateWorkspaceConfig,
} from '../workspace-persistence';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import { setDelegationActivity } from '../../agents/delegation/activity';
import * as sessionManager from '../../agents/session-manager';
import * as hostPlatform from '@canopy/core-platform/host-platform';
import * as recordedDirectoryIdentity from '@canopy/core-runtime/node/w5/recorded-directory-identity';
import * as instrumentation from '@canopy/desktop-instrumentation/electron/main';
import * as coworkWorkEntries from '../cowork-work-entries';
import { acquireWorkspaceDeletionLease } from '../../services/split-lock-service';
import * as atomicFile from '../atomic-file';
import {
  findCompletedDestructiveArchive,
  isInterruptedIndexRemovalDeletion,
  readDestructiveRecovery,
  replayJournaledTerminalRetirements,
  lifecycleJournalSlotName,
} from '../w5-destructive-recovery';
import {
  terminalPersistenceStore,
  TerminalPersistenceStore,
} from '../../terminal/persistence';
import {
  panelLayoutPersistenceStore,
  PanelLayoutPersistenceStore,
} from '../../panels/persistence';
import type { SerializablePanelLayoutFile } from '@canopy/protocol/panels';
import { TerminalRecordOutbox } from '../../terminal/record-outbox';
import {
  daemonTerminalRecordClient,
  type TerminalRecordClientPort,
} from '../../terminal/record-client';
import {
  TerminalRecordAuthority,
  TerminalRecordRepository,
} from '@canopy/core-runtime/node/terminal/record';
import {
  prepareWorkspaceBrowserRetirement,
  commitTaskBrowserRetirement,
  retireRemovedBrowserTask,
} from '../../browser/browser-profile-lifecycle';
import { setBrowserService } from '../../browser/browser-service-registry';
import { BrowserRetirementTimeoutError } from '../browser-retirement-deadline';
import { cleanupPersistedWorktreeData } from '../worktree-data-cleanup';
import * as treeRemoval from '../remove-tree-without-asar';
import * as leasedAtomicFile from '@canopy/execution-engine/node/lib/atomic-file';
import {
  captureDirectoryEffects,
  directoryEffectsAdmitted,
  drainDirectoryEffects,
  DIRECTORY_EFFECT_DRAIN_BOUND_MS,
} from '../directory-effect-admission';
import { commitArchivedContainer } from '../archived-containers';
import { workspaceRootPayloadDigest } from '../archived-container-git';
import {
  getArchivedContainerDir,
  getArchivedContainersRootDir,
  getW5DestructiveLifecycleDir,
  getW5QuarantinedLifecycleDir,
  getWorkspaceDir,
  getWorktreeDataDir,
  getWorktreeBrowserStateFilePath,
} from '../paths';
import { applyWorkspaceIndexRemoval } from '../workspace-record-decision-port';
import { recordWorkspaceCrudTelemetry } from '../desktop-telemetry';
import {
  deleteWorkspace,
  type WorkspaceDeletionRequest,
} from '../workspace-deletion';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
const originalWatcherFactory = jest
  .mocked(getAppAdvisorWatcherService)
  .getMockImplementation();
const actualPort = jest.requireActual<typeof RecordDecisionPort>(
  '../workspace-record-decision-port',
);
const decisions = jest.mocked(applyWorkspaceIndexRemoval);
const DELETE_INDEX = { kind: 'workspace.delete.index' } as const;

function startHost(
  workerEntry = join(__dirname, 'fixtures/w5-commit-log-source-worker.ts'),
): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry,
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
}

interface IndexEntry {
  id: string;
  name: string;
  type: string;
  color: string;
  collapsed: boolean;
  order: number;
}
const indexFileSchema = z.object({
  version: z.number(),
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      color: z.string(),
      collapsed: z.boolean(),
      order: z.number(),
    }),
  ),
});
function readIndex(): IndexEntry[] {
  return indexFileSchema.parse(
    JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')),
  ).workspaces;
}
function indexIds(): string[] {
  return readIndex().map((entry) => entry.id);
}

/** Adds a Cowork project with its own manifest; `a` and `b` stay indexed. */
function addCowork(id: string, config: Record<string, unknown> = {}): void {
  const entries = readIndex();
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        ...entries,
        {
          id,
          name: `Cowork ${id}`,
          type: 'cowork',
          color: '#7C3AED',
          collapsed: false,
          order: entries.length,
        },
      ],
    }),
  );
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(
    join(root, id, 'workspace.json'),
    JSON.stringify({ version: 1, type: 'cowork', repos: [], ...config }),
  );
  coworkWorkEntries.activateWorkEntryWorkspace(id);
  __resetSidebarItemsStateForTests();
}

beforeEach(() => {
  mockArchiveIoFault = undefined;
  mockArchiveIoAfter = undefined;
  resetChatStateServiceForTests();
  if (!originalWatcherFactory)
    throw new Error('Watcher fixture factory missing');
  jest
    .mocked(getAppAdvisorWatcherService)
    .mockImplementation(originalWatcherFactory);
  decisions.mockImplementation(actualPort.applyWorkspaceIndexRemoval);
  ({ dir, root, repo } = createW5BoundaryFixture(
    (createdAt) => [
      { id: 'one', branchName: 'old', createdAt },
      { id: 'two', branchName: 'second', createdAt },
    ],
    ['b'],
  ));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  startHost();
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'old',
    join(root, 'a', 'worktrees', 'one'),
  ]);
  addCowork('c');
  jest.clearAllMocks();
});
afterEach(async () => {
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

it('retains verified files-only recovery after a permission refusal and retries only its remaining quarantine', async () => {
  const checkout = join(root, 'a', 'worktrees', 'one');
  const quarantine = join(root, 'a', 'worktrees', '.one.archive-quarantine');
  const worktree = (
    await workspacePersistence.readWorkspaceWorktrees('a')
  ).find((row) => row.id === 'one');
  if (!worktree) throw new Error('Missing worktree fixture');
  const {
    prepareArchivedContainerRecovery,
    finishArchivedContainerRecovery,
    readArchivedContainerRecoveryJournal,
  } = await import('../archived-container-recovery');
  const { fsWithoutAsar } = await import('../remove-tree-without-asar');
  const { readErrorClassification } =
    await import('@canopy/protocol/app-errors/classification');
  const { destructiveFailureCode } =
    await import('../destructive-failure-context');
  writeFileSync(join(checkout, 'locked.txt'), 'retained');
  writeFileSync(join(checkout, 'ordinary.txt'), 'captured before removal');
  const recovery = await prepareArchivedContainerRecovery({
    projectId: 'a',
    worktreeId: 'one',
    worktree,
  });
  const manifest: Extract<ArchivedContainerManifest, { version: 3 }> = {
    ...archivedManifestFields('a', 'one'),
    version: 3,
    recovery,
    createdAt: worktree.createdAt,
    originalWorktree: worktree,
  };
  const filesystem = fsWithoutAsar();
  const remove = filesystem.rm;
  const refusal = Object.assign(new Error(`EPERM: ${quarantine}`), {
    code: 'EPERM',
    syscall: 'unlink',
    path: join(quarantine, 'locked.txt'),
  });
  const mockRemoval = jest
    .spyOn(filesystem, 'rm')
    .mockImplementation(async (path, options) => {
      if (path !== quarantine) return remove(path, options);
      // A failed recursive walk may already have removed ordinary files.
      await fsPromises
        .unlink(join(quarantine, 'ordinary.txt'))
        .catch((error: unknown) => {
          if (
            typeof error !== 'object' ||
            error === null ||
            !('code' in error) ||
            error.code !== 'ENOENT'
          )
            throw error;
        });
      throw refusal;
    });
  try {
    const error = await finishArchivedContainerRecovery(manifest).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({
      code: 'external.removal_not_permitted',
      path: '<removal-root>/locked.txt',
    });
    expect(String(error)).not.toContain(root);
    expect(error).not.toHaveProperty('cause');
    expect(readErrorClassification(error)?.code).toBe(
      'external.removal_not_permitted',
    );
    expect(destructiveFailureCode(error)).toBe(
      'external.removal_not_permitted',
    );
    expect(
      await readArchivedContainerRecoveryJournal('a', 'one'),
    ).toMatchObject({
      phase: 'verified',
    });
    expect(readFileSync(join(quarantine, 'locked.txt'), 'utf8')).toBe(
      'retained',
    );
    expect(existsSync(join(quarantine, 'ordinary.txt'))).toBe(false);
    await expect(
      finishArchivedContainerRecovery(manifest),
    ).rejects.toMatchObject({
      code: 'external.removal_not_permitted',
    });
  } finally {
    mockRemoval.mockRestore();
  }
  await finishArchivedContainerRecovery(manifest);
  expect(existsSync(quarantine)).toBe(false);
  expect(await readArchivedContainerRecoveryJournal('a', 'one')).toMatchObject({
    phase: 'removed',
  });
});

const panel: SerializablePanelLayoutFile = {
  version: 1,
  activeGroupId: 'g',
  mostRecentActiveGroupIds: ['g'],
  grid: {
    orientation: 0,
    width: 800,
    height: 600,
    root: {
      type: 'leaf',
      groupId: 'g',
      panels: [],
      activePanelId: null,
      size: 1,
    },
  },
};

/** A real in-process terminal record authority, always reachable. */
function inProcessTerminalRecords(dataRoot: string): TerminalRecordClientPort {
  const authority = new TerminalRecordAuthority({
    repository: new TerminalRecordRepository({
      dataRoot,
      flushDirectorySync: (): undefined => undefined,
    }),
    installDebounceMs: 1,
  });
  const reach = <T>(run: () => T): Promise<T> => Promise.resolve().then(run);
  return {
    available: () => Promise.resolve(true),
    peekAvailable: () => true,
    open: (client) => reach(() => authority.open(client)),
    historyRead: (params) => reach(() => authority.historyRead(params)),
    apply: (params) => reach(() => authority.apply(params)),
    retire: (params) => reach(() => authority.retire(params)),
    shutdown: (signal) =>
      reach(() => {
        authority.shutdown(signal);
      }),
  };
}

describe('CAN-7051 workspace terminal retirement', () => {
  beforeEach(() => {
    jest
      .spyOn(daemonTerminalRecordClient, 'available')
      .mockResolvedValue(false);
  });

  it('R9 late first drawer reads and panel saves after retirement capture do not recreate a deleted workspace', async () => {
    const remove = directoryRemoval.removeWorkspaceNonW5Children;
    const records = inProcessTerminalRecords(join(dir, 'terminal-records'));
    const seeded = new TerminalPersistenceStore({
      records,
      outbox: new TerminalRecordOutbox(() => join(dir, 'seed-outbox')),
    });
    seeded.registerLiveSession({
      id: 'seeded',
      projectId: 'b',
      worktreeId: 'late-first-read',
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/workspace',
      createdAt: 1,
    });
    seeded.appendTerminalOutput(
      'b',
      'late-first-read',
      'seeded',
      Buffer.from('kept'),
    );
    await seeded.drainAll();
    seeded.markAllLiveTerminalsExited('app-quit');
    const local = new TerminalPersistenceStore({
      records,
      outbox: new TerminalRecordOutbox(getCanopyDataDir),
    });
    jest
      .spyOn(directoryRemoval, 'removeWorkspaceNonW5Children')
      .mockImplementation(async (id) => {
        await remove(id);
        if (id !== 'b') return;
        const frozen = (await readDestructiveRecovery(id))
          ?.terminalRecordRetirement;
        const view = await local.loadWorktreeState(id, 'late-first-read');
        expect(view.terminals.map((entry) => entry.session.id)).toEqual([
          'seeded',
        ]);
        panelLayoutPersistenceStore.saveWorktreeLayout(
          id,
          'late-first-read',
          panel,
        );
        panelLayoutPersistenceStore.flushAllSync();
        await local.drainAll();
        expect(existsSync(getWorktreeDataDir(id, 'late-first-read'))).toBe(
          false,
        );
        expect(
          (await readDestructiveRecovery(id))?.terminalRecordRetirement,
        ).toEqual(frozen);
      });
    await deleteWorkspace({
      workspaceId: 'b',
      source: 'shared_container_fork',
    });
    panelLayoutPersistenceStore.flushAllSync();
    local.markAllLiveTerminalsExited('app-quit');
    expect(existsSync(getWorkspaceDir('b'))).toBe(false);
  });

  it('R9 panel saves during terminal retirement and physical worktree removal cannot resurrect metadata', async () => {
    const retire = terminalPersistenceStore.retireTerminalRecord.bind(
      terminalPersistenceStore,
    );
    jest
      .spyOn(terminalPersistenceStore, 'retireTerminalRecord')
      .mockImplementation(async (params, journal) => {
        panelLayoutPersistenceStore.saveWorktreeLayout(
          'b',
          'r9-worktree',
          panel,
        );
        return retire(params, journal);
      });
    const remove = treeRemoval.removeTreeWithoutAsar;
    let reached: () => void = () => undefined;
    const reachedRemoval = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .spyOn(treeRemoval, 'removeTreeWithoutAsar')
      .mockImplementation(async (...args) => {
        if (String(args[0]) === getWorktreeDataDir('b', 'r9-worktree')) {
          reached();
          await gate;
        }
        return remove(...args);
      });
    // The actual worktree-data remover runs, not the producer golden's removal mock.
    const cleanup = cleanupPersistedWorktreeData('b', 'r9-worktree');
    try {
      await reachedRemoval;
      panelLayoutPersistenceStore.saveWorktreeLayout('b', 'r9-worktree', panel);
      panelLayoutPersistenceStore.flushAllSync();
      // Before the remover runs, which would erase an admitted write.
      expect(
        existsSync(
          join(getWorktreeDataDir('b', 'r9-worktree'), 'panel-layout.json'),
        ),
      ).toBe(false);
      release();
      await cleanup;
      panelLayoutPersistenceStore.flushAllSync();
      expect(existsSync(getWorktreeDataDir('b', 'r9-worktree'))).toBe(false);
    } finally {
      release();
      await cleanup;
    }
  });

  it('R9 worktree cleanup waits one bound for a stalled terminal fence, which recreates nothing', async () => {
    const worktreeId = 'stalled-fence';
    const path = getWorktreeDataDir('b', worktreeId);
    const fence = join(path, 'terminal-state.json');
    const local = new TerminalPersistenceStore({
      records: inProcessTerminalRecords(join(dir, 'terminal-records')),
      outbox: new TerminalRecordOutbox(() => join(dir, 'stalled-outbox')),
    });
    let reached: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const install = leasedAtomicFile.writeFileAtomically;
    jest
      .spyOn(leasedAtomicFile, 'writeFileAtomically')
      .mockImplementation(async (...args) => {
        await install(...args);
        if (String(args[0]) === fence) {
          reached();
          await gate;
        }
      });
    let retiring = 0;
    jest
      .spyOn(terminalPersistenceStore, 'retireTerminalRecord')
      .mockImplementation((params) => {
        retiring = Date.now();
        return local.retireTerminalRecord(params);
      });
    let removing = 0;
    const remove = treeRemoval.removeTreeWithoutAsar;
    jest
      .spyOn(treeRemoval, 'removeTreeWithoutAsar')
      .mockImplementation(async (...args) => {
        if (String(args[0]) === path && removing === 0) removing = Date.now();
        return remove(...args);
      });
    local.registerLiveSession({
      id: 'stalled',
      projectId: 'b',
      worktreeId,
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/workspace',
      createdAt: 1,
    });
    const draining = local.drainAll();
    try {
      // The fence's install landed; its lease has not settled.
      await stalled;
      await cleanupPersistedWorktreeData('b', worktreeId);
      // Retirement's drain and the removal boundary's share one bound.
      expect(removing - retiring).toBeGreaterThanOrEqual(
        DIRECTORY_EFFECT_DRAIN_BOUND_MS - 10,
      );
      expect(removing - retiring).toBeLessThan(
        DIRECTORY_EFFECT_DRAIN_BOUND_MS * 1.5,
      );
      expect(existsSync(path)).toBe(false);
    } finally {
      release();
      await draining;
    }
    expect(existsSync(path)).toBe(false);
  });

  it.each(['applied', 'refused'] as const)(
    'R9 a superseding deletion that is %s releases the interrupted uncertain removal fence',
    async (retry) => {
      jest
        .spyOn(host, 'commit')
        .mockRejectedValueOnce(
          new W5CommitLogHostError('outcome-unknown', 'lost reply'),
        );
      await expect(
        deleteWorkspace({ workspaceId: 'b', source: 'shared_container_fork' }),
      ).rejects.toThrow();
      const interrupted = await readDestructiveRecovery('b');
      if (!interrupted) throw new Error('Expected an interrupted deletion');
      await expect(
        isInterruptedIndexRemovalDeletion(interrupted),
      ).resolves.toBe(true);
      const reused = getWorktreeDataDir('b', 'reused');
      // The unanswered removal keeps the project's metadata writes fenced.
      expect(directoryEffectsAdmitted(captureDirectoryEffects(reused))).toBe(
        false,
      );
      if (retry === 'refused')
        jest
          .spyOn(directoryRemoval, 'removeWorkspaceNonW5Children')
          .mockRejectedValueOnce(new Error('refused after withdrawal'));
      const superseding = deleteWorkspace({
        workspaceId: 'b',
        source: 'portal',
        supersedeInterruptedDeletion: interrupted.operationId,
      });
      if (retry === 'applied')
        await expect(superseding).resolves.toMatchObject({ removed: 'code' });
      else
        await expect(superseding).rejects.toThrow('refused after withdrawal');
      // Either answer settles the predecessor: the id's metadata is writable.
      expect(directoryEffectsAdmitted(captureDirectoryEffects(reused))).toBe(
        true,
      );
      panelLayoutPersistenceStore.saveWorktreeLayout('b', 'reused', panel);
      panelLayoutPersistenceStore.flushAllSync();
      expect(existsSync(join(reused, 'panel-layout.json'))).toBe(true);
    },
  );

  it('R9 same-ID panel reuse needs no terminal revival, while old timers stay revoked', async () => {
    const path = getWorktreeDataDir('b', 'panel-only-reuse');
    const old = new PanelLayoutPersistenceStore();
    const successor = new PanelLayoutPersistenceStore();
    const timers = jest.spyOn(global, 'setTimeout');
    try {
      old.saveWorktreeLayout('b', 'panel-only-reuse', panel);
      const oldTimer = timers.mock.calls.at(-1)?.[0];
      const scheduled = timers.mock.results.at(-1);
      if (scheduled?.type !== 'return' || typeof oldTimer !== 'function')
        throw new Error('Missing old panel timer');
      // Keep the queued write for the epoch check, but invoke its callback ourselves.
      clearTimeout(scheduled.value);
      await cleanupPersistedWorktreeData('b', 'panel-only-reuse');
      expect(existsSync(path)).toBe(false);
      mkdirSync(path, { recursive: true });
      successor.saveWorktreeLayout('b', 'panel-only-reuse', panel, false);
      successor.flushAllSync();
      const file = join(path, 'panel-layout.json');
      const bytes = readFileSync(file, 'utf8');
      const parsed: unknown = JSON.parse(bytes);
      expect(parsed).toEqual(
        expect.objectContaining({ hasUserChanges: false }),
      );
      oldTimer();
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    } finally {
      old.cancelPendingWrite('b', 'panel-only-reuse');
      successor.cancelPendingWrite('b', 'panel-only-reuse');
      timers.mockRestore();
      await drainDirectoryEffects(path);
    }
  });

  it.each(['done', 'pending'] as const)(
    'R11 workspace retirement is journaled before cleanup; an outbox failure replays only after a done removal: %s removal',
    async (completion) => {
      let intent: DestructiveRecoveryRecord['terminalRecordRetirement'];
      const prepare = directoryRemoval.removeWorkspaceNonW5Children;
      jest
        .spyOn(directoryRemoval, 'removeWorkspaceNonW5Children')
        .mockImplementation(async (id) => {
          intent = (await readDestructiveRecovery(id))
            ?.terminalRecordRetirement;
          expect(intent).toMatchObject({ projectId: 'b' });
          await prepare(id);
        });
      const activate = jest.spyOn(
        terminalPersistenceStore,
        'retirePreparedTerminalRecord',
      );
      const writing = jest
        .spyOn(TerminalRecordOutbox.prototype, 'write')
        .mockRejectedValue(new Error('outbox full'));
      await expect(
        deleteWorkspace({ workspaceId: 'b', source: 'shared_container_fork' }),
      ).resolves.toMatchObject({ removed: 'code' });
      expect(activate).toHaveBeenCalledWith(intent);
      expect(await activate.mock.results[0]?.value).toBe(false);
      const record = await readDestructiveRecovery('b');
      if (!record || !intent) throw new Error('Missing durable retirement');
      expect(record.terminalRecordRetirement).toEqual(intent);
      expect(indexIds()).not.toContain('b');
      if (completion === 'pending') {
        const removal = record.steps.find(
          (step) => step.phase === 'canonical-index-removal',
        );
        if (!removal) throw new Error('Missing removal step');
        removal.state = 'pending';
        record.state = 'recovery-required';
        writeFileSync(
          join(getW5DestructiveLifecycleDir(), lifecycleJournalSlotName('b')),
          JSON.stringify(record),
        );
      }
      writing.mockRestore();
      const replay = jest.spyOn(
        terminalPersistenceStore,
        'replayTerminalRecordRetirement',
      );
      if (completion === 'pending') {
        // Absent canonical records do not prove W5 applied this removal: only
        // the step's completion save does. Without it the intent leaks.
        expect(indexIds()).not.toContain('b');
        expect(
          (await workspacePersistence.readWorkspaceConfigDetailed('b'))
            .authority,
        ).toBe('absent');
        await replayJournaledTerminalRetirements();
        expect(replay).not.toHaveBeenCalled();
        expect(await readDestructiveRecovery('b')).toEqual(record);
        return;
      }
      await replayJournaledTerminalRetirements();
      expect(replay).toHaveBeenCalledWith(intent);
      expect(
        (await readDestructiveRecovery('b'))?.terminalRecordRetirement,
      ).toBeUndefined();
      expect(
        (await new TerminalRecordOutbox(getCanopyDataDir).read()).outbox
          .retirements,
      ).toContainEqual(intent);
    },
  );

  it('RF5 boot replays valid terminal retirements despite an unrelated unreadable journal', async () => {
    const writing = jest
      .spyOn(TerminalRecordOutbox.prototype, 'write')
      .mockRejectedValue(new Error('outbox full'));
    await deleteWorkspace({
      workspaceId: 'b',
      source: 'shared_container_fork',
    });
    const intent = (await readDestructiveRecovery('b'))
      ?.terminalRecordRetirement;
    expect(intent).toMatchObject({ projectId: 'b' });
    writing.mockRestore();
    writeFileSync(
      join(getW5DestructiveLifecycleDir(), lifecycleJournalSlotName('broken')),
      '{bad journal',
    );
    const replay = jest.spyOn(
      terminalPersistenceStore,
      'replayTerminalRecordRetirement',
    );
    const reconcile = jest.spyOn(
      terminalPersistenceStore,
      'reconcilePreparedTerminalRecordRetirements',
    );
    const { reconcileGitPendingWorktrees } =
      await import('../worktree-boot-recovery');
    await expect(reconcileGitPendingWorktrees()).rejects.toThrow();
    expect(replay).toHaveBeenCalledWith(intent);
    expect(reconcile).not.toHaveBeenCalled();
    expect(
      (await readDestructiveRecovery('b'))?.terminalRecordRetirement,
    ).toBeUndefined();
  });

  it.each(['cowork-admission', 'canonical-removal'] as const)(
    'does not activate or replay terminal retirement after refused %s',
    async (failure) => {
      const id = failure === 'cowork-admission' ? 'o' : 'b';
      if (failure === 'cowork-admission')
        addCowork(id, { externalPath: getWorkspaceDir(id) });
      else
        decisions.mockRejectedValueOnce(new Error('before canonical removal'));
      const activate = jest.spyOn(
        terminalPersistenceStore,
        'retirePreparedTerminalRecord',
      );
      const replay = jest.spyOn(
        terminalPersistenceStore,
        'replayTerminalRecordRetirement',
      );
      const cancel = jest.spyOn(
        terminalPersistenceStore,
        'cancelPreparedTerminalRecordRetirement',
      );
      const reconcile = jest.spyOn(
        terminalPersistenceStore,
        'reconcilePreparedTerminalRecordRetirements',
      );
      await expect(
        deleteWorkspace({ workspaceId: id, source: 'shared_container_fork' }),
      ).rejects.toThrow();
      const before = await readDestructiveRecovery(id);
      expect(before?.terminalRecordRetirement).toMatchObject({ projectId: id });
      expect(indexIds()).toContain(id);
      expect(activate).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledWith(before?.terminalRecordRetirement);
      await replayJournaledTerminalRetirements();
      expect(replay).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenLastCalledWith([]);
      expect(await readDestructiveRecovery(id)).toEqual(before);
      if (failure === 'canonical-removal') {
        reconcile.mockClear();
        jest
          .spyOn(sidebarItems, 'readWorkspaceIndexStoredDetailed')
          .mockRejectedValue(new Error('index unavailable'));
        await replayJournaledTerminalRetirements();
        expect(replay).not.toHaveBeenCalled();
        // A pending removal never reads the index, so the scan stays complete.
        expect(reconcile).toHaveBeenLastCalledWith([]);
        expect(await readDestructiveRecovery(id)).toEqual(before);
      }
    },
  );

  it('RF7 boot without any deletion journal releases orphan prepared discovery fences', async () => {
    const reconcile = jest.spyOn(
      terminalPersistenceStore,
      'reconcilePreparedTerminalRecordRetirements',
    );
    await replayJournaledTerminalRetirements();
    expect(reconcile).toHaveBeenCalledWith([]);
  });

  it.each(['present', 'unreadable', 'absent'] as const)(
    'does not replay a refused unindexed deletion with a %s manifest',
    async (manifest) => {
      writeFileSync(
        join(root, 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: readIndex().filter((entry) => entry.id !== 'b'),
        }),
      );
      __resetSidebarItemsStateForTests();
      decisions.mockRejectedValueOnce(new Error('before canonical removal'));
      await expect(
        deleteWorkspace({ workspaceId: 'b', source: 'shared_container_fork' }),
      ).rejects.toThrow('before canonical removal');
      const record = await readDestructiveRecovery('b');
      expect(record?.terminalRecordRetirement).toMatchObject({
        projectId: 'b',
      });
      expect(record?.steps).toContainEqual({
        phase: 'canonical-index-removal',
        state: 'pending',
        code: 'Error',
      });
      expect(indexIds()).not.toContain('b');
      const detail =
        await workspacePersistence.readWorkspaceConfigDetailed('b');
      expect(detail.authority).toBe('ok');
      // W5 refused: the canonical worktree list survives whatever the manifest reads.
      expect(existsSync(join(root, 'b', 'worktrees.json'))).toBe(true);
      if (manifest !== 'present')
        jest
          .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
          .mockResolvedValue({ ...detail, authority: manifest });
      const replay = jest.spyOn(
        terminalPersistenceStore,
        'replayTerminalRecordRetirement',
      );
      await replayJournaledTerminalRetirements();
      expect(replay).not.toHaveBeenCalled();
      expect(await readDestructiveRecovery('b')).toEqual(record);
    },
  );
});

describe('CAN-6899 live-state teardown failure', () => {
  const checkout = (): string => join(root, 'a', 'worktrees', 'one');
  /** Every entry under a directory with its kind, size and bytes. */
  const tree = (path: string): string[] => {
    const entries: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const info = lstatSync(full);
        const rel = `${prefix}${name}`;
        if (info.isDirectory()) {
          entries.push(`${rel}/`);
          walk(full, `${rel}/`);
        } else if (info.isSymbolicLink()) entries.push(`${rel} -> link`);
        else
          entries.push(
            `${rel} ${String(info.size)} ${readFileSync(full).toString('base64')}`,
          );
      }
    };
    walk(path, '');
    return entries;
  };
  /** Archive `one` the way an agent's auto-delete does, failing live state. */
  async function failLiveState(): Promise<void> {
    const { WorktreeProcessCleanupError } =
      await import('../worktree-process-cleanup');
    const { archiveSingleRepoWorktree } = await import('../worktree-service');
    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        repoPath: repo,
        archiveTrigger: 'agent',
        runAutoArchiveTeardown: () => Promise.resolve(),
        observabilityMode: 'live-service',
        liveServices: {
          cleanupLiveState: () =>
            Promise.reject(
              new WorktreeProcessCleanupError(
                'App-owned writer inspection exceeded its deadline; cleanup is incomplete.',
                'WORKTREE_WRITER_INSPECTION_INCOMPLETE',
              ),
            ),
        },
      }),
    ).rejects.toThrow('inspection exceeded its deadline');
  }
  async function journal(): Promise<DestructiveRecoveryRecord | null> {
    const { readDestructiveRecovery } =
      await import('../w5-destructive-recovery');
    return readDestructiveRecovery('a', 'one');
  }

  it('records why live state could not be torn down, and keeps the worktree', async () => {
    const before = tree(checkout());
    await failLiveState();
    expect(await journal()).toMatchObject({
      operation: 'worktree-archive',
      state: 'recovery-required',
      steps: [
        { phase: 'teardown-script', state: 'done' },
        {
          phase: 'live-state-teardown',
          state: 'pending',
          code: 'WORKTREE_WRITER_INSPECTION_INCOMPLETE',
        },
      ],
    });
    // Nothing on disk changed and the worktree is still listed.
    expect(tree(checkout())).toEqual(before);
    const { readWorkspaceWorktrees } = await import('../workspace-persistence');
    expect(
      (await readWorkspaceWorktrees('a')).some((entry) => entry.id === 'one'),
    ).toBe(true);
  });

  it('names the live-state owner that failed when it has no code of its own', async () => {
    const { cleanupLiveWorktreeState } =
      await import('../worktree-live-cleanup');
    const writerCheck = await import('../worktree-process-cleanup');
    // This computer's own processes are not under test here.
    jest
      .spyOn(writerCheck, 'captureLinuxWorktreeWriterVerification')
      .mockResolvedValue(() => Promise.resolve());
    jest
      .spyOn(sessionManager, 'destroyWorktreeSessions')
      .mockRejectedValue(
        new Error(
          'session provider 48213 in /home/someone/private would not stop',
        ),
      );
    const telemetry = jest
      .spyOn(instrumentation, 'captureDesktopInstrumentationError')
      .mockImplementation(() => undefined);
    const before = tree(checkout());
    const { archiveSingleRepoWorktree } = await import('../worktree-service');
    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        repoPath: repo,
        archiveTrigger: 'agent',
        runAutoArchiveTeardown: () => Promise.resolve(),
        observabilityMode: 'live-service',
        liveServices: { cleanupLiveState: cleanupLiveWorktreeState },
      }),
    ).rejects.toThrow();
    expect((await journal())?.steps).toEqual([
      { phase: 'teardown-script', state: 'done' },
      {
        phase: 'live-state-teardown',
        state: 'pending',
        code: 'live-state:sessions',
      },
    ]);
    expect(tree(checkout())).toEqual(before);
    // Telemetry carries the code, never the owner's raw error: no message,
    // path or process id.
    const payloads = JSON.stringify(telemetry.mock.calls);
    expect(payloads).toContain('live-state:sessions');
    expect(payloads).not.toContain('/home/someone/private');
    expect(payloads).not.toContain('would not stop');
    expect(payloads).not.toContain('48213');
  });

  it('finishes the archive on retry once live state tears down', async () => {
    await failLiveState();
    const { archiveSingleRepoWorktree } = await import('../worktree-service');
    await archiveSingleRepoWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      repoPath: repo,
      archiveTrigger: 'agent',
      runAutoArchiveTeardown: () => Promise.resolve(),
      observabilityMode: 'live-service',
      liveServices: { cleanupLiveState: () => Promise.resolve() },
    });
    const { readWorkspaceWorktrees } = await import('../workspace-persistence');
    expect(
      (await readWorkspaceWorktrees('a')).some((entry) => entry.id === 'one'),
    ).toBe(false);
    expect(existsSync(checkout())).toBe(false);
    expect((await journal())?.state ?? 'completed').toBe('completed');
  });

  it('keeps the worktree on request, closing only the journal and touching no file', async () => {
    await failLiveState();
    const record = await journal();
    if (!record) throw new Error('Missing journal');
    const before = tree(checkout());
    const dataBefore = existsSync(getWorktreeDataDir('a', 'one'))
      ? tree(getWorktreeDataDir('a', 'one'))
      : null;
    const { listWorktreeRecovery } =
      await import('../worktree-recovery-description');
    const [entry] = (
      await listWorktreeRecovery({
        workspaceId: 'a',
        operationId: record.operationId,
      })
    ).entries;
    expect(entry?.diagnosis?.verdict).toBe('keep-worktree');
    expect(entry?.actions.keepWorktree).toEqual({ eligible: true });
    expect(entry?.actions.retry).toEqual({ eligible: true });
    if (!entry?.diagnosis) throw new Error('Missing diagnosis');
    const { resolveWorktreeArchive } =
      await import('../worktree-archive-resolution');
    expect(
      await resolveWorktreeArchive({
        workspaceId: 'a',
        operationId: record.operationId,
        revision: entry.diagnosis.revision,
        action: 'keep-worktree',
      }),
    ).toMatchObject({ status: 'worktree-kept' });
    expect(tree(checkout())).toEqual(before);
    expect(
      existsSync(getWorktreeDataDir('a', 'one'))
        ? tree(getWorktreeDataDir('a', 'one'))
        : null,
    ).toEqual(dataBefore);
    const { readWorkspaceWorktrees } = await import('../workspace-persistence');
    expect(
      (await readWorkspaceWorktrees('a')).some((entry) => entry.id === 'one'),
    ).toBe(true);
    // The journal no longer blocks the worktree.
    const after = await journal();
    expect(after === null || after.operationId !== record.operationId).toBe(
      true,
    );
  });

  it('refuses to keep or retry a journal recorded for another incarnation, touching nothing', async () => {
    await failLiveState();
    const record = await journal();
    if (!record) throw new Error('Missing journal');
    // The listed worktree is not the one the journal was written for.
    for (const name of readdirSync(getW5DestructiveLifecycleDir())) {
      const path = join(getW5DestructiveLifecycleDir(), name);
      const parsed = journalSchema.parse(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      if (parsed.operationId !== record.operationId) continue;
      writeFileSync(
        path,
        JSON.stringify({ ...parsed, createdAt: '2000-01-01T00:00:00.000Z' }),
      );
    }
    const before = tree(checkout());
    const { listWorktreeRecovery } =
      await import('../worktree-recovery-description');
    const [entry] = (
      await listWorktreeRecovery({
        workspaceId: 'a',
        operationId: record.operationId,
      })
    ).entries;
    expect(entry?.actions.keepWorktree.eligible).toBe(false);
    expect(entry?.actions.retry.eligible).toBe(false);
    const { archiveSingleRepoWorktree } = await import('../worktree-service');
    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        repoPath: repo,
        observabilityMode: 'live-service',
        liveServices: { cleanupLiveState: () => Promise.resolve() },
      }),
    ).rejects.toThrow();
    expect(tree(checkout())).toEqual(before);
  });
});

describe('CAN-6899 Linux writer inspection off the main thread', () => {
  // The inspection runs on a real Worker thread against a /proc tree built
  // here; its timeouts (setTimeout) refuse rather than wait.
  const worker = join(__dirname, '..', 'linux-writer-inspection-worker.ts');
  const hungWorker = join(
    __dirname,
    'fixtures',
    'hung-linux-writer-inspection-worker.ts',
  );
  const checkout = (): string => join(root, 'a', 'worktrees', 'one');
  let proc: string;

  /** One fake process under `proc`, as Linux exposes it. */
  function fakeProcess(
    pid: number,
    options: {
      children?: readonly number[];
      cwd?: string;
      handles?: ReadonlyArray<{ target: string; writable: boolean }>;
    } = {},
  ): void {
    const base = join(proc, String(pid));
    mkdirSync(join(base, 'fd'), { recursive: true });
    mkdirSync(join(base, 'fdinfo'), { recursive: true });
    mkdirSync(join(base, 'task', String(pid)), { recursive: true });
    const fields = ['S', ...Array.from({ length: 18 }, () => '0'), String(pid)];
    writeFileSync(join(base, 'stat'), `${pid} (fake) ${fields.join(' ')}\n`);
    writeFileSync(join(base, 'cmdline'), 'fake\0');
    symlinkSync(options.cwd ?? '/', join(base, 'cwd'));
    (options.handles ?? []).forEach((handle, index) => {
      symlinkSync(handle.target, join(base, 'fd', String(index)));
      writeFileSync(
        join(base, 'fdinfo', String(index)),
        `pos:\t0\nflags:\t${handle.writable ? '0100001' : '0100000'}\n`,
      );
    });
    writeFileSync(
      join(base, 'task', String(pid), 'children'),
      (options.children ?? []).join(' '),
    );
    writeFileSync(join(base, 'task', String(pid), 'stat'), '');
  }

  /** The app's process tree: `count` agents with `handles` open files each, none in the worktree. */
  function fakeAppTree(count: number, handles: number): number[] {
    const agents = Array.from({ length: count }, (_, index) => 900_000 + index);
    fakeProcess(process.pid, { children: agents });
    for (const pid of agents)
      fakeProcess(pid, {
        cwd: '/elsewhere',
        handles: Array.from({ length: handles }, (_, index) => ({
          target: `/elsewhere/file-${index}`,
          writable: true,
        })),
      });
    return agents;
  }

  async function archiveAsAgent(): Promise<unknown> {
    const { cleanupLiveWorktreeState } =
      await import('../worktree-live-cleanup');
    const { archiveSingleRepoWorktree } = await import('../worktree-service');
    return archiveSingleRepoWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      repoPath: repo,
      archiveTrigger: 'agent',
      runAutoArchiveTeardown: () => Promise.resolve(),
      observabilityMode: 'live-service',
      liveServices: { cleanupLiveState: cleanupLiveWorktreeState },
    });
  }

  async function journalCode(): Promise<string | undefined> {
    const { readDestructiveRecovery } =
      await import('../w5-destructive-recovery');
    return (await readDestructiveRecovery('a', 'one'))?.steps.find(
      (step) => step.phase === 'live-state-teardown',
    )?.code;
  }

  beforeEach(async () => {
    proc = join(dir, 'proc');
    jest.spyOn(hostPlatform, 'hostOperatingSystem').mockReturnValue('linux');
    jest
      .spyOn(sessionManager, 'destroyWorktreeSessions')
      .mockResolvedValue(undefined);
    const { __setLinuxWriterInspectionWorkerForTests } =
      await import('../worktree-process-cleanup');
    __setLinuxWriterInspectionWorkerForTests(worker, proc);
  });
  afterEach(async () => {
    const { __setLinuxWriterInspectionWorkerForTests } =
      await import('../worktree-process-cleanup');
    __setLinuxWriterInspectionWorkerForTests(undefined);
  });

  it('removes the worktree while the main thread is blocked during the inspection and the app runs hundreds of processes', async () => {
    fakeAppTree(200, 50);
    const { startedWorkers } = jest.requireActual<typeof TsxWorkerThreads>(
      '../../ledger/__tests__/fixtures/tsx-worker-threads',
    );
    const inspections = (): number =>
      startedWorkers.filter((started) =>
        String(started.filename).includes('linux-writer-inspection-worker'),
      ).length;
    const before = inspections();
    const removal = archiveAsAgent();
    const nextTurn = (): Promise<void> =>
      new Promise((resolve) => setImmediate(resolve));
    const inspectionStarted = async (): Promise<void> => {
      if (inspections() > before) return;
      await nextTurn();
      return inspectionStarted();
    };
    // An inspection on the main thread starts no worker, and this waits out
    // the test's timeout.
    await inspectionStarted();
    // Block the main thread, while that inspection is under way, longer than
    // the old main-thread walk's deadline.
    const until = Date.now() + 2_500;
    while (Date.now() < until);
    await removal;
    expect(existsSync(checkout())).toBe(false);
  }, 20_000);

  it('keeps the worktree while an app-owned process still writes into it', async () => {
    const [agent] = fakeAppTree(3, 2);
    if (agent === undefined) throw new Error('Missing agent');
    rmSync(join(proc, String(agent)), { recursive: true, force: true });
    fakeProcess(agent, {
      cwd: '/elsewhere',
      handles: [
        { target: join(realpathSync(checkout()), 'notes.txt'), writable: true },
      ],
    });
    await expect(archiveAsAgent()).rejects.toThrow('writers are still active');
    expect(await journalCode()).toBe('WORKTREE_WRITERS_ACTIVE');
    expect(existsSync(checkout())).toBe(true);
  });

  it('keeps refusing a writer an inspection found before it failed, after the writer is reparented', async () => {
    const writer = 910_001;
    const broken = 910_002;
    fakeProcess(process.pid, { children: [broken, writer] });
    fakeProcess(writer, {
      handles: [
        { target: join(realpathSync(checkout()), 'notes.txt'), writable: true },
      ],
    });
    // A /proc entry that cannot be read: the inspection fails after it has
    // already seen the writer.
    mkdirSync(join(proc, String(broken)), { recursive: true });
    fakeProcess(broken);
    rmSync(join(proc, String(broken), 'cwd'));
    writeFileSync(join(proc, String(broken), 'cwd'), '');
    await expect(archiveAsAgent()).rejects.toThrow();
    expect(existsSync(checkout())).toBe(true);

    // The writer leaves the app's tree, and the unreadable entry is gone.
    rmSync(proc, { recursive: true, force: true });
    fakeProcess(process.pid);
    fakeProcess(writer, {
      handles: [
        { target: join(realpathSync(checkout()), 'notes.txt'), writable: true },
      ],
    });
    await expect(archiveAsAgent()).rejects.toThrow('writers are still active');
    expect(await journalCode()).toBe('WORKTREE_WRITERS_ACTIVE');
    expect(existsSync(checkout())).toBe(true);
  });

  it('refuses the removal, and keeps the worktree, when the inspection never answers', async () => {
    fakeAppTree(3, 2);
    const { __setLinuxWriterInspectionWorkerForTests } =
      await import('../worktree-process-cleanup');
    __setLinuxWriterInspectionWorkerForTests(hungWorker, proc, 500);
    await expect(archiveAsAgent()).rejects.toThrow('did not finish');
    expect(await journalCode()).toBe('WORKTREE_WRITER_INSPECTION_INCOMPLETE');
    expect(existsSync(checkout())).toBe(true);
  });
});

describe('removed worktree browser data', () => {
  describe.each([
    ['malformed', '{broken'],
    [
      'invalid-record',
      '{"version":1,"records":[{"kind":"upload","id":"retain"}]}',
    ],
  ])('%s transfer catalog', (_label, bytes) => {
    it.each(['retired', 'retirement failed', 'retirement timed out'])(
      'cleans browser state when %s',
      async (retirement) => {
        const { BrowserService } =
          await import('../../browser/browser-service');
        const service = new BrowserService({ getWindow: (): null => null });
        const scope = { projectId: 'a', worktreeId: 'one' };
        const folder = join(getWorktreeDataDir('a', 'one'), 'browser-files');
        const statePath = getWorktreeBrowserStateFilePath('a', 'one');
        mkdirSync(join(folder, 'uploads/staged'), { recursive: true });
        writeFileSync(join(folder, 'uploads/staged/file.txt'), 'staged');
        writeFileSync(join(folder, 'files.json'), bytes);
        writeFileSync(
          statePath,
          JSON.stringify({
            version: 2,
            browsers: [],
            browserOrder: [],
            activeBrowserId: null,
          }),
        );
        const retirementError = new Error('Profile retirement refused');
        if (retirement !== 'retired')
          jest
            .mocked(retireRemovedBrowserTask)
            .mockRejectedValueOnce(
              retirement === 'retirement timed out'
                ? new BrowserRetirementTimeoutError()
                : retirementError,
            );
        const remove = fsPromises.rm;
        let removedByBrowserStep = false;
        jest.spyOn(fsPromises, 'rm').mockImplementation(async (...args) => {
          if (args[0] === statePath) {
            expect(existsSync(folder)).toBe(false);
            await remove(...args);
            removedByBrowserStep = true;
          } else await remove(...args);
        });
        setBrowserService(service);
        try {
          await expect(service.taskFiles.bind(scope)).rejects.toThrow();
          const warnings = await cleanupPersistedWorktreeData('a', 'one');
          expect(removedByBrowserStep).toBe(true);
          expect(existsSync(statePath)).toBe(false);
          expect(existsSync(folder)).toBe(false);
          expect(
            warnings.filter((warning) => warning.includes('browser tab state')),
          ).toEqual(
            retirement === 'retirement failed'
              ? [
                  'Failed to remove browser tab state for this worktree: Profile retirement refused',
                ]
              : [],
          );
        } finally {
          setBrowserService(null);
          await service.shutdown();
        }
      },
    );
  });
});

function chatProjectRequest(
  workspaceId: string,
  idempotencyKey?: string,
): WorkspaceDeletionRequest {
  return {
    workspaceId,
    source: 'chat_project_delete',
    coworkProject: true,
    idempotencyKey,
  };
}
function decisionCalls(): unknown {
  return JSON.parse(JSON.stringify(decisions.mock.calls));
}
function indexCommits(commits: jest.SpyInstance): number {
  return commits.mock.calls.filter(
    ([request]: [{ files: { path: string }[] }]) =>
      request.files.some((file) => file.path.endsWith('index.json')),
  ).length;
}
function canonicalImages(): string[] {
  return ['index.json', 'a/workspace.json', 'a/worktrees.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}
function watcherSpies(): {
  cancel: jest.SpyInstance;
  commit: jest.SpyInstance;
  release: jest.SpyInstance;
} {
  const watcher = getAppAdvisorWatcherService();
  const cancel = jest.spyOn(watcher, 'cancelLocalWorkspace');
  const commit = jest.spyOn(watcher, 'commitLocalWorkspaceCancellation');
  const release = jest.spyOn(watcher, 'releaseLocalWorkspaceFence');
  jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
  return { cancel, commit, release };
}

type SharedManifestFields = Pick<
  Extract<ArchivedContainerManifest, { version: 3 }>,
  | 'id'
  | 'projectId'
  | 'kind'
  | 'name'
  | 'createdAt'
  | 'archivedAt'
  | 'retentionDays'
  | 'expiresAt'
  | 'chatCount'
  | 'archivedChatCount'
  | 'executionCount'
  | 'workspaceType'
  | 'originalWorktree'
>;

/** The fields every worktree archive manifest version shares. */
function archivedManifestFields(
  workspaceId: string,
  containerId: string,
): SharedManifestFields {
  return {
    id: containerId,
    projectId: workspaceId,
    kind: 'worktree' as const,
    name: 'Archived worktree',
    createdAt: '2099-01-01T00:00:00.000Z',
    archivedAt: '2099-01-02T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2099-01-09T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
    workspaceType: 'single-repo' as const,
    originalWorktree: {
      id: containerId,
      branchName: 'feature/archive',
      createdAt: '2099-01-01T00:00:00.000Z',
    },
  };
}

function archivedManifest(
  workspaceId: string,
  containerId: string,
): Extract<ArchivedContainerManifest, { version: 2 }> {
  return {
    ...archivedManifestFields(workspaceId, containerId),
    version: 2,
    gitState: { version: 1, diffFormatVersion: 1, repositories: [] },
    gitChanges: {
      status: 'complete',
      capturedAt: '2099-01-02T00:00:00.000Z',
      fileCount: 0,
      insertions: 0,
      deletions: 0,
      repositories: [],
    },
    pullRequestMetadata: {
      capturedAt: '2099-01-02T00:00:00.000Z',
      repositories: [],
    },
  };
}

/**
 * Plan §3.1: a version-3 archive whose Git registration cleanup still points
 * at a source repository that no longer exists. CAN-5338 points it at the
 * project's configured source instead.
 */
async function plantPendingVersion3Archive(
  referenceRepoPath = join(dir, 'missing-source'),
): Promise<void> {
  const containerId = 'pending';
  const payloadId = '00000000-0000-4000-8000-000000000003';
  const containerDir = getArchivedContainerDir('a', containerId);
  const payload = join(containerDir, 'recovery-files', payloadId);
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, 'kept.txt'), 'retained');
  const digest = await workspaceRootPayloadDigest({ rootPath: payload });
  if (digest === null) throw new Error('Expected a payload digest');
  const recovery = {
    kind: 'files-only' as const,
    source: 'partial' as const,
    digest,
    payloadId,
    gitCleanupPending: true,
  };
  const base = archivedManifestFields('a', containerId);
  await commitArchivedContainer({ ...base, version: 3, recovery });
  writeFileSync(
    join(containerDir, 'recovery.staged.json'),
    JSON.stringify({
      version: 1,
      createdAt: base.createdAt,
      phase: 'removed',
      recovery,
      // Absent repositories clear the pending flag; a missing one keeps it.
      repositories: [
        {
          referenceRepoPath,
          repositoryIdentity: null,
          relativePath: '',
          worktreePaths: [],
        },
      ],
    }),
  );
}

const strictListingCases = [
  {
    name: 'a manifest-less container',
    plant: (): void => {
      mkdirSync(join(getArchivedContainersRootDir('a'), 'gone'), {
        recursive: true,
      });
    },
    repair: (): void =>
      rmSync(join(getArchivedContainersRootDir('a'), 'gone'), {
        recursive: true,
      }),
    error: { code: 'ENOENT' },
    keyedRetry: 'recovery-required' as const,
  },
  {
    name: 'a truncated manifest',
    plant: (): void => {
      const container = join(getArchivedContainersRootDir('a'), 'truncated');
      mkdirSync(container, { recursive: true });
      writeFileSync(join(container, 'container.json'), '{"version":');
    },
    repair: (): void =>
      rmSync(join(getArchivedContainersRootDir('a'), 'truncated'), {
        recursive: true,
      }),
    error: { name: 'SyntaxError' },
    keyedRetry: 'recovery-required' as const,
  },
  {
    name: 'a version-4 manifest',
    plant: (): void => {
      const container = join(getArchivedContainersRootDir('a'), 'future');
      mkdirSync(container, { recursive: true });
      writeFileSync(
        join(container, 'container.json'),
        JSON.stringify({ ...archivedManifest('a', 'future'), version: 4 }),
      );
    },
    repair: (): void =>
      rmSync(join(getArchivedContainersRootDir('a'), 'future'), {
        recursive: true,
      }),
    error: {
      message: expect.stringContaining(
        'Invalid archived container manifest',
      ) as unknown,
    },
    keyedRetry: 'recovery-required' as const,
  },
  {
    name: 'a container with an invalid name',
    plant: (): void => {
      mkdirSync(join(getArchivedContainersRootDir('a'), 'Bad_Name'), {
        recursive: true,
      });
    },
    repair: (): void =>
      rmSync(join(getArchivedContainersRootDir('a'), 'Bad_Name'), {
        recursive: true,
      }),
    error: { name: 'IdentifierValidationError' },
    keyedRetry: 'succeeds' as const,
  },
];

/** An unreadable journal of some other operation in the shared directory. */
function plantUnreadableForeignJournal(): string {
  const journal = join(
    getW5DestructiveLifecycleDir(),
    `${'f'.repeat(64)}.json`,
  );
  mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
  writeFileSync(journal, '{truncated');
  return journal;
}

describe('GB14 code and Cowork record removal', () => {
  it.each(['a', 'c'])(
    'recovers all three %s files after a worker exits between decision and apply, without advancing twice',
    async (workspaceId) => {
      const dbPath = join(dir, 'w5', 'commit-log.sqlite');
      const indexPath = join(root, 'index.json');
      const backupPath = `${indexPath}.bak`;
      const manifestPath = join(root, workspaceId, 'workspace.json');
      const listPath = join(root, workspaceId, 'worktrees.json');
      if (workspaceId === 'c')
        writeFileSync(
          listPath,
          readFileSync(join(root, 'a', 'worktrees.json')),
        );
      const paths = [indexPath, manifestPath, listPath];
      const indexBefore = readFileSync(indexPath, 'utf8');
      const manifestBefore = readFileSync(manifestPath, 'utf8');
      const listBefore = readFileSync(listPath, 'utf8');
      const before = [indexBefore, manifestBefore, listBefore];
      expect(existsSync(backupPath)).toBe(false);
      const otherEntries = readIndex()
        .filter(({ id }) => id !== workspaceId)
        .map((entry, order) => ({ ...entry, order }));
      const otherManifest = readFileSync(
        join(root, 'b/workspace.json'),
        'utf8',
      );
      const otherList = readFileSync(join(root, 'b/worktrees.json'), 'utf8');
      const resources: W5Resource[] = [
        { kind: 'workspaces' },
        { kind: 'workspace', workspaceId },
        { kind: 'worktrees', workspaceId },
        { kind: 'worktree', workspaceId, worktreeId: 'one' },
        { kind: 'worktree', workspaceId, worktreeId: 'two' },
      ];
      await shutdownW5BoundaryHost(host, dbPath);
      startHost(join(__dirname, 'fixtures/w5-delete-decision-exit-worker.ts'));
      const commit = host.commit.bind(host);
      jest.spyOn(host, 'commit').mockImplementation(async (request) => {
        try {
          return await commit(request);
        } catch (error) {
          // Keep reconciliation from starting recovery before offline inspection.
          await host.shutdown();
          throw error;
        }
      });

      await expect(
        deleteWorkspace({ workspaceId, source: 'shared_container_fork' }),
      ).rejects.toMatchObject({ reason: 'outcome-unknown' });
      await settleDetachedWork();
      await shutdownW5BoundaryHost(host, dbPath);

      expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
      expect(existsSync(backupPath)).toBe(false);
      expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
      const interrupted = await readDestructiveRecovery(workspaceId);
      expect(interrupted?.steps.at(-1)).toEqual({
        phase: 'canonical-index-removal',
        state: 'pending',
        code: 'outcome-unknown',
      });
      const log = W5CommitLog.open(dbPath);
      let commitId: number;
      let decidedIndex: string;
      try {
        const pending = log.listPendingCommits();
        expect(pending).toHaveLength(1);
        const deletion = pending[0];
        if (!deletion) throw new Error('Expected a durable deletion decision');
        commitId = deletion.commitId;
        expect(deletion.operation).toBe('core.workspace.delete');
        const indexChange = deletion.files.find(
          ({ path }) => path === indexPath,
        );
        if (typeof indexChange?.contents !== 'string')
          throw new Error('Expected a replacement index image');
        decidedIndex = indexChange.contents;
        expect(
          indexFileSchema.parse(JSON.parse(decidedIndex)).workspaces,
        ).toEqual(otherEntries);
        expect(deletion.files).toHaveLength(4);
        expect(deletion.files).toEqual(
          expect.arrayContaining([
            {
              path: indexPath,
              contents: decidedIndex,
              previousFingerprint: fingerprintW5File(indexBefore),
            },
            {
              path: backupPath,
              contents: indexBefore,
              previousFingerprint: null,
            },
            {
              path: manifestPath,
              contents: null,
              previousFingerprint: fingerprintW5File(manifestBefore),
            },
            {
              path: listPath,
              contents: null,
              previousFingerprint: fingerprintW5File(listBefore),
            },
          ]),
        );
        expect(resources.map((resource) => log.revision(resource))).toEqual([
          1, 1, 1, 1, 1,
        ]);
        expect(log.listRecoveryRequiredCommitIds()).toEqual([]);
      } finally {
        log.close();
      }

      startHost();
      expect(await host.recoveryReport()).toMatchObject({
        applied: [commitId],
        recoveryRequired: [],
      });
      expect(readIndex()).toEqual(otherEntries);
      expect(readFileSync(indexPath, 'utf8')).toBe(decidedIndex);
      expect(readFileSync(backupPath, 'utf8')).toBe(indexBefore);
      expect(existsSync(manifestPath)).toBe(false);
      expect(existsSync(listPath)).toBe(false);
      expect(readFileSync(join(root, 'b/workspace.json'), 'utf8')).toBe(
        otherManifest,
      );
      expect(readFileSync(join(root, 'b/worktrees.json'), 'utf8')).toBe(
        otherList,
      );
      const peer = createW5CommitLogFileStore(() => host);
      const revisions = await peer.readRevisions(resources);
      expect(revisions.map(({ revision }) => revision)).toEqual([
        1, 1, 1, 1, 1,
      ]);
      const recoveredIndex = readFileSync(indexPath, 'utf8');

      await shutdownW5BoundaryHost(host, dbPath);
      startHost();
      expect(await host.recoveryReport()).toMatchObject({
        applied: [],
        recoveryRequired: [],
      });
      const restartedPeer = createW5CommitLogFileStore(() => host);
      expect(await restartedPeer.readRevisions(resources)).toEqual(revisions);
      expect(readFileSync(indexPath, 'utf8')).toBe(recoveredIndex);
      expect(readFileSync(backupPath, 'utf8')).toBe(indexBefore);
      expect(existsSync(manifestPath)).toBe(false);
      expect(existsSync(listPath)).toBe(false);
      expect(readFileSync(join(root, 'b/workspace.json'), 'utf8')).toBe(
        otherManifest,
      );
      expect(readFileSync(join(root, 'b/worktrees.json'), 'utf8')).toBe(
        otherList,
      );
    },
  );

  it.each(['a', 'c'])(
    'refuses a peer manifest edit read before %s deletion, without recovery debt',
    async (workspaceId) => {
      const peer = createW5CommitLogFileStore(() => host);
      const path = join(root, workspaceId, 'workspace.json');
      const before = await peer.read(path);
      if (before.state !== 'present') throw new Error('Expected a manifest');
      jest
        .mocked(prepareWorkspaceBrowserRetirement)
        .mockResolvedValueOnce([
          { worktreeId: 'home', operationId: 'retire-home' },
        ]);
      let peerError: unknown;
      jest
        .mocked(commitTaskBrowserRetirement)
        .mockImplementationOnce(async () => {
          // Native retirement holds the deletion immediately after its record commit.
          try {
            await withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
              peer.replace(path, '{}', WORKSPACE_MANIFEST_STORAGE, {
                operation: 'test.stale.peer.manifest',
                advance: [{ kind: 'workspace', workspaceId }],
                previousRaw: before.raw,
              }),
            );
          } catch (error) {
            peerError = error;
          }
          return false;
        });

      await expect(
        deleteWorkspace({ workspaceId, source: 'shared_container_fork' }),
      ).resolves.toMatchObject({
        removed: workspaceId === 'c' ? 'cowork' : 'code',
      });
      expect(peerError).toBeInstanceOf(W5FileWriteRefusedError);
      expect(commitTaskBrowserRetirement).toHaveBeenCalledTimes(1);
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
      expect(existsSync(join(root, workspaceId))).toBe(false);
    },
  );

  it.each(['a', 'c'])(
    'advances %s list and row revisions in the index commit and refuses a stale revision-only peer',
    async (workspaceId) => {
      // Cowork ordinarily has no canonical rows, but legacy lists can remain.
      writeFileSync(
        join(root, workspaceId, 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [
            {
              id: 'one',
              branchName: 'old',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      );
      const peer = createW5CommitLogFileStore(() => host);
      const resource = { kind: 'worktrees', workspaceId } as const;
      const [before] = await peer.readRevisions([resource]);
      if (!before) throw new Error('Expected a list revision');
      jest
        .mocked(prepareWorkspaceBrowserRetirement)
        .mockResolvedValueOnce([
          { worktreeId: 'home', operationId: 'retire-home' },
        ]);
      jest
        .mocked(commitTaskBrowserRetirement)
        .mockImplementationOnce(async () => {
          await expect(
            peer.withCommit(
              {
                operation: 'test.stale.peer.list',
                expectedRevisions: [before],
              },
              async () => {},
            ),
          ).rejects.toBeInstanceOf(W5RevisionConflictError);
          return false;
        });

      await deleteWorkspace({ workspaceId, source: 'shared_container_fork' });
      expect(commitTaskBrowserRetirement).toHaveBeenCalledTimes(1);
      const revisions = await peer.readRevisions([
        { kind: 'workspaces' },
        { kind: 'workspace', workspaceId },
        resource,
        { kind: 'worktree', workspaceId, worktreeId: 'one' },
      ]);
      expect(revisions.map(({ revision }) => revision)).toEqual([1, 1, 1, 1]);
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it.each(['b', 'c'])(
    'removes %s empty or absent list without advancing its collection',
    async (workspaceId) => {
      const peer = createW5CommitLogFileStore(() => host);
      await deleteWorkspace({ workspaceId, source: 'shared_container_fork' });
      const revisions = await peer.readRevisions([
        { kind: 'workspaces' },
        { kind: 'workspace', workspaceId },
        { kind: 'worktrees', workspaceId },
      ]);
      expect(revisions.map(({ revision }) => revision)).toEqual([1, 1, 0]);
      expect(existsSync(join(root, workspaceId))).toBe(false);
    },
  );

  it.each(['a', 'c'])(
    'keeps %s index and W5 records if non-W5 child cleanup fails',
    async (workspaceId) => {
      const path = join(root, workspaceId, 'workspace.json');
      const before = readFileSync(path, 'utf8');
      jest
        .spyOn(directoryRemoval, 'removeWorkspaceNonW5Children')
        .mockRejectedValueOnce(new Error('Child cleanup failed'));
      await expect(
        deleteWorkspace({ workspaceId, source: 'shared_container_fork' }),
      ).rejects.toThrow('Child cleanup failed');
      expect(decisions).not.toHaveBeenCalled();
      expect(indexIds()).toContain(workspaceId);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it.each(['a', 'c'])(
    'refuses %s record removal atomically when a peer advances its revision during preparation',
    async (workspaceId) => {
      const peer = createW5CommitLogFileStore(() => host);
      const manifestPath = join(root, workspaceId, 'workspace.json');
      const listPath = join(root, workspaceId, 'worktrees.json');
      if (workspaceId === 'c')
        writeFileSync(
          listPath,
          readFileSync(join(root, 'a', 'worktrees.json')),
        );
      const indexBefore = readFileSync(join(root, 'index.json'), 'utf8');
      const listBefore = readFileSync(listPath, 'utf8');
      const manifestBefore = readFileSync(manifestPath, 'utf8');
      const peerManifest = `${manifestBefore}\n`;
      const [expected] = await peer.readRevisions([
        { kind: 'workspace', workspaceId },
      ]);
      if (!expected) throw new Error('Expected a workspace revision');
      const prepare = directoryRemoval.removeWorkspaceNonW5Children;
      jest
        .spyOn(directoryRemoval, 'removeWorkspaceNonW5Children')
        .mockImplementationOnce(async (id) => {
          await prepare(id);
          await withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
            peer.replace(
              manifestPath,
              peerManifest,
              WORKSPACE_MANIFEST_STORAGE,
              {
                operation: 'test.peer.before.deletion',
                advance: [{ kind: 'workspace', workspaceId }],
                previousRaw: manifestBefore,
              },
            ),
          );
        });
      const finalRemoval = jest.spyOn(
        directoryRemoval,
        'removeWorkspaceDirectoryAfterRecordRemoval',
      );

      await expect(
        deleteWorkspace({
          workspaceId,
          source: 'shared_container_fork',
          expectedRevision: expected.revision,
        }),
      ).rejects.toBeInstanceOf(W5RevisionConflictError);

      expect(decisionCalls()).toEqual([[workspaceId, DELETE_INDEX]]);
      expect(finalRemoval).not.toHaveBeenCalled();
      expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(indexBefore);
      expect(readFileSync(manifestPath, 'utf8')).toBe(peerManifest);
      expect(readFileSync(listPath, 'utf8')).toBe(listBefore);
      const revisions = await peer.readRevisions([
        { kind: 'workspaces' },
        { kind: 'workspace', workspaceId },
        { kind: 'worktrees', workspaceId },
        { kind: 'worktree', workspaceId, worktreeId: 'one' },
        { kind: 'worktree', workspaceId, worktreeId: 'two' },
      ]);
      expect(revisions.map(({ revision }) => revision)).toEqual([
        0, 1, 0, 0, 0,
      ]);
      expect((await readDestructiveRecovery(workspaceId))?.state).toBe(
        'recovery-required',
      );
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it('keeps an interrupted code preparation eligible for explicitly confirmed superseding', async () => {
    const workspaceId = 'b';
    const payload = join(root, workspaceId, 'payload');
    writeFileSync(payload, 'non-W5 data');
    const before = ['index.json', 'b/workspace.json', 'b/worktrees.json'].map(
      (file) => readFileSync(join(root, file), 'utf8'),
    );
    const prepare = directoryRemoval.removeWorkspaceNonW5Children;
    jest
      .spyOn(directoryRemoval, 'removeWorkspaceNonW5Children')
      .mockImplementationOnce(async (id) => {
        await prepare(id);
        throw new Error('Interrupted after non-W5 preparation');
      });

    await expect(
      deleteWorkspace({ workspaceId, source: 'shared_container_fork' }),
    ).rejects.toThrow('Interrupted after non-W5 preparation');

    expect(existsSync(payload)).toBe(false);
    expect(
      ['index.json', 'b/workspace.json', 'b/worktrees.json'].map((file) =>
        readFileSync(join(root, file), 'utf8'),
      ),
    ).toEqual(before);
    expect(decisions).not.toHaveBeenCalled();
    const interrupted = await readDestructiveRecovery(workspaceId);
    if (!interrupted) throw new Error('Expected an interrupted deletion');
    expect(interrupted.steps).toEqual([
      { phase: 'canonical-index-removal', state: 'pending', code: 'Error' },
    ]);
    await expect(isInterruptedIndexRemovalDeletion(interrupted)).resolves.toBe(
      true,
    );
    await expect(
      deleteWorkspace({ workspaceId, source: 'portal' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(decisions).not.toHaveBeenCalled();

    await expect(
      deleteWorkspace({
        workspaceId,
        source: 'portal',
        supersedeInterruptedDeletion: interrupted.operationId,
      }),
    ).resolves.toMatchObject({ removed: 'code' });

    expect(decisionCalls()).toEqual([[workspaceId, DELETE_INDEX]]);
    expect(existsSync(join(root, workspaceId))).toBe(false);
    const completed = await readDestructiveRecovery(workspaceId);
    expect(completed?.state).toBe('completed');
    expect(completed?.operationId).not.toBe(interrupted.operationId);
    expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
  });

  it.each(['a', 'c'])(
    'retains a peer manifest recreated after %s record deletion instead of recursively deleting it',
    async (workspaceId) => {
      const peer = createW5CommitLogFileStore(() => host);
      const path = join(root, workspaceId, 'workspace.json');
      jest
        .mocked(prepareWorkspaceBrowserRetirement)
        .mockResolvedValueOnce([
          { worktreeId: 'home', operationId: 'retire-home' },
        ]);
      jest
        .mocked(commitTaskBrowserRetirement)
        .mockImplementationOnce(async () => {
          expect(await peer.read(path)).toEqual({ state: 'absent' });
          await withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
            peer.replace(path, '{}', WORKSPACE_MANIFEST_STORAGE, {
              operation: 'test.new.peer.manifest',
              advance: [{ kind: 'workspace', workspaceId }],
              previousRaw: null,
            }),
          );
          return false;
        });
      await deleteWorkspace({ workspaceId, source: 'shared_container_fork' });
      expect(commitTaskBrowserRetirement).toHaveBeenCalledTimes(1);
      expect(readFileSync(path, 'utf8')).toBe('{}');
      expect(indexIds()).not.toContain(workspaceId);
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it.each(['a', 'c'])(
    'respects the host filesystem when removing %s with an uppercase owning marker',
    async (workspaceId) => {
      const directory = join(root, workspaceId);
      const marker = join(directory, '.w5-incarnation');
      const uppercaseMarker = join(directory, '.W5-INCARNATION');
      const originalToken = '00000000-0000-4000-8000-000000000002';
      writeFileSync(marker, originalToken);
      // Two renames change the directory entry's spelling even on case-insensitive hosts.
      const stagedMarker = join(directory, 'rename-marker');
      renameSync(marker, stagedMarker);
      renameSync(stagedMarker, uppercaseMarker);
      expect(readdirSync(directory)).toContain('.W5-INCARNATION');
      const uppercaseResolvesCanonical = existsSync(marker);
      let ownedToken: string | undefined;
      let attempts = 0;
      const rmdir = fsPromises.rmdir;
      jest.spyOn(fsPromises, 'rmdir').mockImplementation(async (...args) => {
        if (args[0] === directory) {
          attempts += 1;
          expect(existsSync(marker)).toBe(false);
          expect(existsSync(uppercaseMarker)).toBe(!uppercaseResolvesCanonical);
        }
        return rmdir(...args);
      });
      jest
        .mocked(prepareWorkspaceBrowserRetirement)
        .mockResolvedValueOnce([
          { worktreeId: 'home', operationId: 'retire-home' },
        ]);
      jest.mocked(commitTaskBrowserRetirement).mockImplementationOnce(() => {
        expect(readdirSync(directory)).toContain('.W5-INCARNATION');
        expect(readFileSync(uppercaseMarker, 'utf8')).toBe(originalToken);
        ownedToken = readFileSync(marker, 'utf8');
        return Promise.resolve(false);
      });

      await expect(
        deleteWorkspace({ workspaceId, source: 'shared_container_fork' }),
      ).resolves.toMatchObject({
        removed: workspaceId === 'c' ? 'cowork' : 'code',
      });
      expect(commitTaskBrowserRetirement).toHaveBeenCalledTimes(1);
      expect(attempts).toBe(1);
      expect(indexIds()).not.toContain(workspaceId);
      expect(existsSync(directory)).toBe(!uppercaseResolvesCanonical);
      if (uppercaseResolvesCanonical) {
        expect(ownedToken).toBe(originalToken);
      } else {
        expect(readFileSync(uppercaseMarker, 'utf8')).toBe(originalToken);
        expect(readFileSync(marker, 'utf8')).toBe(ownedToken);
        expect(readdirSync(directory).sort()).toEqual([
          '.W5-INCARNATION',
          '.w5-incarnation',
        ]);
      }
      expect((await readDestructiveRecovery(workspaceId))?.state).toBe(
        'completed',
      );
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it.each(['a', 'c'])(
    'retains %s owning marker and its hard-link alias through final removal',
    async (workspaceId) => {
      const directory = join(root, workspaceId);
      const marker = join(directory, '.w5-incarnation');
      const alias = join(directory, 'incarnation-alias');
      const token = '00000000-0000-4000-8000-000000000002';
      writeFileSync(marker, token);
      linkSync(marker, alias);
      const original = lstatSync(marker, { bigint: true });
      expect(lstatSync(alias, { bigint: true }).ino).toBe(original.ino);
      let attempts = 0;
      const rmdir = fsPromises.rmdir;
      jest.spyOn(fsPromises, 'rmdir').mockImplementation(async (...args) => {
        if (args[0] === directory) {
          attempts += 1;
          expect(readdirSync(directory).sort()).toEqual([
            '.w5-incarnation',
            'incarnation-alias',
          ]);
        }
        return rmdir(...args);
      });

      await expect(
        deleteWorkspace({ workspaceId, source: 'shared_container_fork' }),
      ).resolves.toMatchObject({
        removed: workspaceId === 'c' ? 'cowork' : 'code',
      });
      expect(attempts).toBe(1);
      expect(indexIds()).not.toContain(workspaceId);
      for (const path of [marker, alias]) {
        expect(readFileSync(path, 'utf8')).toBe(token);
        const retained = lstatSync(path, { bigint: true });
        expect([retained.dev, retained.ino]).toEqual([
          original.dev,
          original.ino,
        ]);
      }
      expect((await readDestructiveRecovery(workspaceId))?.state).toBe(
        'completed',
      );
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it('restores the same incarnation when a late peer file makes final rmdir refuse', async () => {
    const directory = join(root, 'a');
    const marker = join(directory, '.w5-incarnation');
    let token: string | undefined;
    let attempts = 0;
    const rmdir = fsPromises.rmdir;
    jest.spyOn(fsPromises, 'rmdir').mockImplementation(async (...args) => {
      if (args[0] === directory) {
        attempts += 1;
        // The owned marker has been unlinked, but the directory is not gone yet.
        expect(existsSync(marker)).toBe(false);
        writeFileSync(join(directory, 'workspace.json'), '{}');
      }
      return rmdir(...args);
    });
    jest
      .mocked(prepareWorkspaceBrowserRetirement)
      .mockResolvedValueOnce([
        { worktreeId: 'home', operationId: 'retire-home' },
      ]);
    jest.mocked(commitTaskBrowserRetirement).mockImplementationOnce(() => {
      token = readFileSync(marker, 'utf8');
      return Promise.resolve(false);
    });

    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
    ).resolves.toMatchObject({ removed: 'code' });
    expect(attempts).toBe(1);
    expect(token).toEqual(expect.any(String));
    expect(readFileSync(marker, 'utf8')).toBe(token);
    expect(readFileSync(join(directory, 'workspace.json'), 'utf8')).toBe('{}');
    expect((await readDestructiveRecovery('a'))?.state).toBe('completed');
  });

  it('does not overwrite a peer marker installed during final rmdir', async () => {
    const directory = join(root, 'a');
    const marker = join(directory, '.w5-incarnation');
    const peerToken = '00000000-0000-4000-8000-000000000001';
    let attempts = 0;
    const rmdir = fsPromises.rmdir;
    jest.spyOn(fsPromises, 'rmdir').mockImplementation(async (...args) => {
      if (args[0] === directory) {
        attempts += 1;
        expect(existsSync(marker)).toBe(false);
        writeFileSync(marker, peerToken);
      }
      return rmdir(...args);
    });

    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(attempts).toBe(1);
    expect(readFileSync(marker, 'utf8')).toBe(peerToken);
    expect((await readDestructiveRecovery('a'))?.state).toBe(
      'recovery-required',
    );
  });

  it.each(['a', 'c'])(
    'preserves an uppercase peer marker installed during %s final rmdir',
    async (workspaceId) => {
      const directory = join(root, workspaceId);
      const marker = join(directory, '.w5-incarnation');
      const uppercaseMarker = join(directory, '.W5-INCARNATION');
      const ownedToken = '00000000-0000-4000-8000-000000000002';
      const peerToken = '00000000-0000-4000-8000-000000000001';
      writeFileSync(marker, ownedToken);
      const uppercaseResolvesCanonical = existsSync(uppercaseMarker);
      let attempts = 0;
      const rmdir = fsPromises.rmdir;
      jest.spyOn(fsPromises, 'rmdir').mockImplementation(async (...args) => {
        if (args[0] === directory) {
          attempts += 1;
          expect(existsSync(marker)).toBe(false);
          expect(existsSync(uppercaseMarker)).toBe(false);
          writeFileSync(uppercaseMarker, peerToken);
        }
        return rmdir(...args);
      });

      const deletion = deleteWorkspace({
        workspaceId,
        source: 'shared_container_fork',
      });
      if (uppercaseResolvesCanonical) {
        await expect(deletion).rejects.toMatchObject({
          reason: 'recovery-required',
        });
      } else {
        await expect(deletion).resolves.toMatchObject({
          removed: workspaceId === 'c' ? 'cowork' : 'code',
        });
      }
      expect(attempts).toBe(1);
      expect(indexIds()).not.toContain(workspaceId);
      expect(readFileSync(uppercaseMarker, 'utf8')).toBe(peerToken);
      expect(readFileSync(marker, 'utf8')).toBe(
        uppercaseResolvesCanonical ? peerToken : ownedToken,
      );
      expect(readdirSync(directory).sort()).toEqual(
        uppercaseResolvesCanonical
          ? ['.W5-INCARNATION']
          : ['.W5-INCARNATION', '.w5-incarnation'],
      );
      expect((await readDestructiveRecovery(workspaceId))?.state).toBe(
        uppercaseResolvesCanonical ? 'recovery-required' : 'completed',
      );
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it.each(['ENOTEMPTY', 'ENOENT'])(
    'refuses a directory replaced during final rmdir even when it throws %s',
    async (code) => {
      const directory = join(root, 'a');
      const peerToken = '00000000-0000-4000-8000-000000000001';
      const rmdir = fsPromises.rmdir;
      jest.spyOn(fsPromises, 'rmdir').mockImplementation(async (...args) => {
        if (args[0] === directory) {
          renameSync(directory, join(root, 'old-a'));
          mkdirSync(directory);
          writeFileSync(join(directory, '.w5-incarnation'), peerToken);
          writeFileSync(join(directory, 'workspace.json'), 'peer');
          throw Object.assign(new Error('Directory replaced'), { code });
        }
        return rmdir(...args);
      });

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
      expect(readFileSync(join(directory, '.w5-incarnation'), 'utf8')).toBe(
        peerToken,
      );
      expect(readFileSync(join(directory, 'workspace.json'), 'utf8')).toBe(
        'peer',
      );
      expect((await readDestructiveRecovery('a'))?.state).toBe(
        'recovery-required',
      );
    },
  );

  it.each(['EEXIST', 'ENOENT'])(
    'refuses failed incarnation restoration even when publication throws %s',
    async (code) => {
      const directory = join(root, 'a');
      const rmdir = fsPromises.rmdir;
      let restoring = false;
      jest.spyOn(fsPromises, 'rmdir').mockImplementation(async (...args) => {
        if (args[0] === directory) {
          restoring = true;
          writeFileSync(join(directory, 'workspace.json'), 'peer');
          jest
            .spyOn(fsPromises, 'open')
            .mockRejectedValueOnce(
              Object.assign(new Error('Cannot restore token'), { code }),
            );
        }
        return rmdir(...args);
      });

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
      expect(restoring).toBe(true);
      expect(readFileSync(join(directory, 'workspace.json'), 'utf8')).toBe(
        'peer',
      );
      expect((await readDestructiveRecovery('a'))?.state).toBe(
        'recovery-required',
      );
    },
  );

  it.each([
    ['a', 'browser'],
    ['c', 'browser'],
    ['a', 'directory'],
    ['c', 'directory'],
  ])(
    'invalidates %s removed plugin defaults after a post-commit %s failure',
    async (workspaceId, failure) => {
      const configPath = join(root, workspaceId, 'workspace.json');
      const config = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(readFileSync(configPath, 'utf8')));
      config.defaultPluginSelections = {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'm', pluginName: 'old-default' }],
      };
      writeFileSync(configPath, JSON.stringify(config));
      const { getProjectPluginDefaultsRevision } =
        await import('../../plugins/plugin-defaults-revision');
      expect(
        await workspacePersistence.readProjectPluginDefaults(workspaceId),
      ).toMatchObject({
        defaultPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [{ marketplaceId: 'm', pluginName: 'old-default' }],
        },
      });
      const before = getProjectPluginDefaultsRevision(workspaceId);
      const error = new Error('Post-commit failure');
      if (failure === 'browser') {
        jest
          .mocked(prepareWorkspaceBrowserRetirement)
          .mockResolvedValueOnce([
            { worktreeId: 'home', operationId: 'retire-home' },
          ]);
        jest.mocked(commitTaskBrowserRetirement).mockRejectedValueOnce(error);
      } else {
        jest
          .spyOn(directoryRemoval, 'removeWorkspaceDirectoryAfterRecordRemoval')
          .mockRejectedValueOnce(error);
      }

      await expect(
        deleteWorkspace({ workspaceId, source: 'shared_container_fork' }),
      ).rejects.toBe(error);
      expect(existsSync(configPath)).toBe(false);
      expect(getProjectPluginDefaultsRevision(workspaceId)).toBe(before + 1);
      expect(
        (await workspacePersistence.readProjectPluginDefaults(workspaceId))
          .defaultPluginSelections,
      ).toBeUndefined();
    },
  );

  it.each([
    ['a', 'before'],
    ['c', 'before'],
    ['a', 'after'],
    ['c', 'after'],
  ])(
    'invalidates %s defaults when the index-step completion save fails %s writing',
    async (workspaceId, point) => {
      const configPath = join(root, workspaceId, 'workspace.json');
      const config = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(readFileSync(configPath, 'utf8')));
      config.defaultPluginSelections = {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'm', pluginName: 'old-default' }],
      };
      writeFileSync(configPath, JSON.stringify(config));
      const { getProjectPluginDefaultsRevision } =
        await import('../../plugins/plugin-defaults-revision');
      expect(
        (await workspacePersistence.readProjectPluginDefaults(workspaceId))
          .defaultPluginSelections?.pluginRefs,
      ).toEqual([{ marketplaceId: 'm', pluginName: 'old-default' }]);
      const before = getProjectPluginDefaultsRevision(workspaceId);
      const write = atomicFile.writeFileAtomically;
      const error = new Error('Index-step completion save failed');
      let fired = false;
      jest
        .spyOn(atomicFile, 'writeFileAtomically')
        .mockImplementation(async (file, contents, options) => {
          const completion =
            !fired &&
            file.includes('destructive-lifecycles') &&
            typeof contents === 'string' &&
            contents.includes('"operation":"workspace-delete"') &&
            contents.includes(
              '"phase":"canonical-index-removal","state":"done"',
            );
          if (completion) {
            fired = true;
            if (point === 'after') await write(file, contents, options);
            throw error;
          }
          await write(file, contents, options);
        });

      await expect(
        deleteWorkspace({ workspaceId, source: 'shared_container_fork' }),
      ).rejects.toBe(error);
      expect(fired).toBe(true);
      expect(indexIds()).not.toContain(workspaceId);
      expect(existsSync(configPath)).toBe(false);
      expect(getProjectPluginDefaultsRevision(workspaceId)).toBe(before + 1);
      expect(
        (await workspacePersistence.readProjectPluginDefaults(workspaceId))
          .defaultPluginSelections,
      ).toBeUndefined();
      expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it('preserves an existing incarnation staging file when exclusive restoration refuses', async () => {
    const directory = join(root, 'a');
    const marker = join(directory, '.w5-incarnation');
    let staged: string | undefined;
    const rmdir = fsPromises.rmdir;
    jest.spyOn(fsPromises, 'rmdir').mockImplementation(async (...args) => {
      if (args[0] === directory) {
        expect(staged).toBeDefined();
        if (!staged) throw new Error('Expected a staging collision');
        expect(existsSync(marker)).toBe(false);
        writeFileSync(staged, 'retain peer staging evidence');
        writeFileSync(join(directory, 'workspace.json'), 'peer');
      }
      return rmdir(...args);
    });
    jest
      .mocked(prepareWorkspaceBrowserRetirement)
      .mockResolvedValueOnce([
        { worktreeId: 'home', operationId: 'retire-home' },
      ]);
    jest.mocked(commitTaskBrowserRetirement).mockImplementationOnce(() => {
      staged = `${marker}.${readFileSync(marker, 'utf8')}`;
      return Promise.resolve(false);
    });

    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    if (!staged) throw new Error('Expected the staging path');
    expect(readFileSync(staged, 'utf8')).toBe('retain peer staging evidence');
    expect(readFileSync(join(directory, 'workspace.json'), 'utf8')).toBe(
      'peer',
    );
    expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
    expect((await readDestructiveRecovery('a'))?.state).toBe(
      'recovery-required',
    );
  });

  it('refuses a replacement directory and marker before final removal', async () => {
    const directory = join(root, 'a');
    const peerToken = '00000000-0000-4000-8000-000000000001';
    jest
      .mocked(prepareWorkspaceBrowserRetirement)
      .mockResolvedValueOnce([
        { worktreeId: 'home', operationId: 'retire-home' },
      ]);
    jest.mocked(commitTaskBrowserRetirement).mockImplementationOnce(() => {
      renameSync(directory, join(root, 'old-a'));
      mkdirSync(directory);
      writeFileSync(join(directory, '.w5-incarnation'), peerToken);
      writeFileSync(join(directory, 'workspace.json'), 'peer');
      return Promise.resolve(false);
    });

    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(readFileSync(join(directory, '.w5-incarnation'), 'utf8')).toBe(
      peerToken,
    );
    expect(readFileSync(join(directory, 'workspace.json'), 'utf8')).toBe(
      'peer',
    );
    expect((await readDestructiveRecovery('a'))?.state).toBe(
      'recovery-required',
    );
  });

  it.each(['workspace.json', 'worktrees.json'])(
    'removes corrupt but readable code-project %s in the folded decision',
    async (record) => {
      writeFileSync(join(root, 'a', record), '{invalid JSON');
      __resetSidebarItemsStateForTests();
      const commits = jest.spyOn(host, 'commit');

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).resolves.toMatchObject({ removed: 'code' });

      expect(indexCommits(commits)).toBe(1);
      expect(indexIds()).toEqual(['b', 'c']);
      expect(existsSync(join(root, 'a'))).toBe(false);
      const revisions = await readW5Revisions([
        { kind: 'workspaces' },
        { kind: 'workspace', workspaceId: 'a' },
        { kind: 'worktrees', workspaceId: 'a' },
        { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' },
        { kind: 'worktree', workspaceId: 'a', worktreeId: 'two' },
      ]);
      const rowRevision = record === 'worktrees.json' ? 0 : 1;
      expect(revisions.map(({ revision }) => revision)).toEqual([
        1,
        1,
        1,
        rowRevision,
        rowRevision,
      ]);
      expect((await readDestructiveRecovery('a'))?.state).toBe('completed');
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it.each(['workspace.json', 'worktrees.json'])(
    'refuses an unreadable code-project %s before effects and releases its key',
    async (record) => {
      const path = join(root, 'a', record);
      const raw = readFileSync(path, 'utf8');
      rmSync(path);
      mkdirSync(path);
      const request: WorkspaceDeletionRequest = {
        workspaceId: 'a',
        source: 'shared_container_fork',
        idempotencyKey: 'unreadable-code',
      };
      const { cancel, release } = watcherSpies();
      cancel.mockRejectedValue(new Error('Unexpected watcher cancellation'));
      const before = readFileSync(join(root, 'index.json'), 'utf8');

      await expect(deleteWorkspace(request)).rejects.toMatchObject({
        name: 'WorkspaceDeletionRefusedError',
        reason: 'configuration-unavailable',
      });
      expect(cancel).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(decisions).not.toHaveBeenCalled();
      expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(before);
      expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
      expect(lstatSync(path).isDirectory()).toBe(true);
      expect(await readDestructiveRecovery('a')).toBe(null);
      rmSync(path, { recursive: true });
      writeFileSync(path, raw);
      cancel.mockResolvedValue(undefined);
      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
    },
  );
});

describe('W6c2 index removal decisions', () => {
  it('a code deletion applies one plain decision through the single index commit', async () => {
    const commits = jest.spyOn(host, 'commit');
    const other = readIndex().filter((entry) => entry.id !== 'a');

    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
    ).resolves.toMatchObject({ removed: 'code' });

    expect(decisionCalls()).toEqual([['a', DELETE_INDEX]]);
    await expect(decisions.mock.results[0]?.value).resolves.toBe(true);
    expect(indexCommits(commits)).toBe(1);
    expect(readIndex()).toEqual(
      other.map((entry, order) => ({ ...entry, order })),
    );
    expect(existsSync(join(root, 'a'))).toBe(false);
  });

  it('a Cowork deletion applies one decision after every session teardown, the sentinel keying included', async () => {
    const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');
    const commits = jest.spyOn(host, 'commit');
    const other = readFileSync(join(root, 'b', 'workspace.json'), 'utf8');

    await expect(deleteWorkspace(chatProjectRequest('c'))).resolves.toEqual({
      workspaceId: 'c',
      removed: 'cowork',
      cleanup: {
        archivedGitRefs: { status: 'done' },
        chatSearchRows: { status: 'done' },
        managedRepository: { status: 'skipped' },
        skillSuggestions: { status: 'done' },
      },
    });

    expect(decisionCalls()).toEqual([['c', DELETE_INDEX]]);
    expect(destroy.mock.calls).toEqual([
      ['c', 'home'],
      [STANDALONE_CHAT_PROJECT_ID, 'c'],
    ]);
    expect(Math.max(...destroy.mock.invocationCallOrder)).toBeLessThan(
      decisions.mock.invocationCallOrder[0] ?? 0,
    );
    expect(indexCommits(commits)).toBe(1);
    expect(indexIds()).toEqual(['a', 'b']);
    expect(readFileSync(join(root, 'b', 'workspace.json'), 'utf8')).toBe(other);
    expect(existsSync(join(root, 'c'))).toBe(false);
    const record = await readDestructiveRecovery('c');
    expect(record?.state).toBe('completed');
    expect(record?.steps.slice(0, 3)).toEqual([
      { phase: 'session-teardown', state: 'done' },
      { phase: 'session-teardown', state: 'done' },
      { phase: 'cowork-deletion', state: 'done' },
    ]);
    expect(jest.mocked(recordWorkspaceCrudTelemetry)).toHaveBeenCalledWith({
      action: 'delete',
      workspaceId: 'c',
      source: 'chat_project_delete',
    });
  });

  it('an unindexed id without the Cowork admission applies the decision, which finds no entry', async () => {
    await expect(
      deleteWorkspace({ workspaceId: 'zz', source: 'shared_container_fork' }),
    ).resolves.toMatchObject({ removed: 'unindexed' });

    expect(decisionCalls()).toEqual([['zz', DELETE_INDEX]]);
    await expect(decisions.mock.results[0]?.value).resolves.toBe(false);
    expect(indexIds()).toEqual(['a', 'b', 'c']);
  });

  describe('decides nothing when', () => {
    it.each([
      [
        'the project is protected',
        { workspaceId: DEFAULT_COWORK_WORKSPACE_ID, source: 'portal' } as const,
        { reason: 'protected' },
      ],
      [
        'the Cowork admission finds a code project',
        chatProjectRequest('a'),
        { reason: 'not-cowork', message: 'Chat project not found' },
      ],
      [
        'the Cowork admission finds an unindexed id',
        chatProjectRequest('zz'),
        { reason: 'not-cowork', message: 'Chat project not found' },
      ],
      [
        'a caller revision is stale',
        {
          workspaceId: 'a',
          source: 'shared_container_fork',
          expectedRevision: 99,
        } as const,
        { name: 'W5RevisionConflictError' },
      ],
    ])('%s', async (_label, request, refusal) => {
      const before = canonicalImages();
      await expect(deleteWorkspace(request)).rejects.toMatchObject(refusal);
      expect(decisions).not.toHaveBeenCalled();
      expect(canonicalImages()).toEqual(before);
      expect(indexIds()).toEqual(['a', 'b', 'c']);
    });

    it.each([
      ['the workspace keying', 'c/home/chat-a'],
      ['the sentinel keying', `${STANDALONE_CHAT_PROJECT_ID}/c/chat-a`],
    ])('a chat under %s has live delegates', async (_label, sessionKey) => {
      setDelegationActivity('w6c2-owner', sessionKey, 1);
      try {
        await expect(
          deleteWorkspace(chatProjectRequest('c')),
        ).rejects.toMatchObject({ code: 'conflict' });
      } finally {
        setDelegationActivity('w6c2-owner', sessionKey, 0);
      }
      expect(decisions).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'c', 'workspace.json'))).toBe(true);
    });

    it('a split holds the deletion lease', async () => {
      const release = acquireWorkspaceDeletionLease('c');
      try {
        await expect(deleteWorkspace(chatProjectRequest('c'))).rejects.toThrow(
          'Cannot delete a project while one of its worktrees is being split.',
        );
      } finally {
        release();
      }
      expect(decisions).not.toHaveBeenCalled();
    });

    it.each(strictListingCases)(
      'strict archive listing finds $name',
      async ({ plant, error }) => {
        plant();
        await expect(
          deleteWorkspace({
            workspaceId: 'a',
            source: 'shared_container_fork',
          }),
        ).rejects.toMatchObject(error);
        expect(decisions).not.toHaveBeenCalled();
        expect(indexIds()).toEqual(['a', 'b', 'c']);
      },
    );

    it('a version-3 archive still has Git registration cleanup pending', async () => {
      await plantPendingVersion3Archive();
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).rejects.toMatchObject({ reason: 'git-cleanup-pending' });
      expect(decisions).not.toHaveBeenCalled();
    });

    it('an unreadable journal is in the lifecycle directory', async () => {
      plantUnreadableForeignJournal();
      await expect(
        deleteWorkspace(chatProjectRequest('c')),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(decisions).not.toHaveBeenCalled();
    });
  });
});

describe('W6c2 post-effect conflict', () => {
  it('a revision advance at the Cowork index commit keeps the teardown and requires recovery', async () => {
    const retirement = jest.spyOn(
      terminalPersistenceStore,
      'retirePreparedTerminalRecord',
    );
    const [current] = await readW5Revisions([
      { kind: 'workspace', workspaceId: 'c' },
    ]);
    if (!current) throw new Error('Expected a workspace revision');
    const browser = jest.requireMock<{
      prepareWorkspaceBrowserRetirement: jest.Mock;
      abortTaskBrowserRetirement: jest.Mock;
      commitTaskBrowserRetirement: jest.Mock;
    }>('../../browser/browser-profile-lifecycle');
    browser.prepareWorkspaceBrowserRetirement.mockResolvedValueOnce([
      { worktreeId: 'home', operationId: 'retire-home' },
    ]);
    const activate = jest.spyOn(
      coworkWorkEntries,
      'activateWorkEntryWorkspace',
    );
    const { commit: commitWatchers } = watcherSpies();
    const releaseWatchers = jest.spyOn(
      getAppAdvisorWatcherService(),
      'releaseLocalWorkspaceFence',
    );
    // Removed by `cleanupPersistedWorktreeData` before the index commit.
    const homeData = getWorktreeDataDir('c', 'home');
    mkdirSync(homeData, { recursive: true });
    writeFileSync(join(homeData, 'marker.txt'), 'home data');
    const destroy = jest
      .spyOn(sessionManager, 'destroyWorktreeSessions')
      .mockImplementation(async (projectId) => {
        // A real manifest commit advances the project's revision after the
        // preflight, before the index commit.
        if (projectId === STANDALONE_CHAT_PROJECT_ID)
          await updateWorkspaceConfig('c', (config) => {
            config.defaultPluginSelections = {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [{ marketplaceId: 'm', pluginName: 'late' }],
            };
          });
      });
    const request = {
      ...chatProjectRequest('c', 'late-revision'),
      expectedRevision: current.revision,
    };

    await expect(deleteWorkspace(request)).rejects.toBeInstanceOf(
      W5RevisionConflictError,
    );

    expect(destroy).toHaveBeenCalledTimes(2);
    // Decided inside the commit scope, which then refuses to publish it.
    expect(decisionCalls()).toEqual([['c', DELETE_INDEX]]);
    expect(browser.abortTaskBrowserRetirement).toHaveBeenCalledWith(
      'retire-home',
    );
    expect(browser.commitTaskBrowserRetirement).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith('c');
    // The earlier effects stay; nothing restores them.
    expect(existsSync(homeData)).toBe(false);
    expect(jest.mocked(recordWorkspaceCrudTelemetry)).not.toHaveBeenCalled();
    expect(commitWatchers).not.toHaveBeenCalled();
    expect(releaseWatchers).toHaveBeenCalledWith('c');
    expect(indexIds()).toContain('c');
    expect(retirement).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'c', 'workspace.json'))).toBe(true);
    const record = await readDestructiveRecovery('c');
    expect(record?.state).toBe('recovery-required');
    expect(record?.steps).toEqual(
      expect.arrayContaining([
        { phase: 'session-teardown', state: 'done' },
        {
          phase: 'cowork-deletion',
          state: 'pending',
          code: 'W5RevisionConflictError',
        },
      ]),
    );
    expect(
      record?.steps.filter((step) => step.phase === 'session-teardown'),
    ).toHaveLength(2);
    // A definite W5 refusal settles as abandoned: the surviving project's
    // metadata saves are admitted again.
    expect(directoryEffectsAdmitted(captureDirectoryEffects(homeData))).toBe(
      true,
    );
    panelLayoutPersistenceStore.saveWorktreeLayout('c', 'home', panel);
    panelLayoutPersistenceStore.flushAllSync();
    expect(existsSync(join(homeData, 'panel-layout.json'))).toBe(true);
    await expect(deleteWorkspace(request)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  });
});

describe('Cowork deletion admission compatibility', () => {
  it('§3.3 an external folder overlapping the metadata refuses after the session teardown', async () => {
    addCowork('o', { externalPath: getWorkspaceDir('o') });
    const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');

    await expect(deleteWorkspace(chatProjectRequest('o'))).rejects.toThrow(
      'Refusing to delete cowork project: its metadata directory and external folder overlap.',
    );

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(decisions).not.toHaveBeenCalled();
    expect(indexIds()).toContain('o');
    expect(existsSync(join(root, 'o', 'workspace.json'))).toBe(true);
    expect(await readDestructiveRecovery('o')).toMatchObject({
      state: 'recovery-required',
      steps: [
        { phase: 'session-teardown', state: 'done' },
        { phase: 'session-teardown', state: 'done' },
        { phase: 'cowork-deletion', state: 'pending' },
      ],
    });
  });

  // CAN-4975: its unreadable `externalPath` leaves the overlap guard nothing
  // to check, so every route refuses before anything changes.
  describe.each([
    ['the chat project deletion', chatProjectRequest('o', 'unreadable-chat')],
    [
      'a Portal deletion',
      {
        workspaceId: 'o',
        source: 'portal',
        idempotencyKey: 'unreadable-portal',
      } satisfies WorkspaceDeletionRequest,
    ],
  ])(
    '§3.3 an unreadable Cowork configuration refuses %s before any effect and releases its key',
    (_label, request) => {
      it.each([
        ['truncated JSON', '{truncated'],
        ['empty file', ''],
        ['null document', 'null'],
        ['array document', '[]'],
        ['unsupported version', '{"version":2,"type":"cowork","repos":[]}'],
        ['filesystem read error', null],
      ])(
        '%s',
        async (_failure, raw) => {
          addCowork('o', { externalPath: getWorkspaceDir('o') });
          const configPath = join(root, 'o', 'workspace.json');
          if (raw === null) {
            rmSync(configPath);
            mkdirSync(configPath);
          } else writeFileSync(configPath, raw);
          __resetSidebarItemsStateForTests();
          const before = canonicalImages();
          const { cancel, commit, release } = watcherSpies();
          const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');
          // Fail at the first forbidden effect, not in unrelated downstream cleanup.
          cancel.mockRejectedValue(
            new Error('Unexpected watcher cancellation'),
          );

          await expect(deleteWorkspace(request)).rejects.toMatchObject({
            name: 'WorkspaceDeletionRefusedError',
            reason: 'configuration-unavailable',
            message:
              'Cannot delete this project while its configuration is unavailable. Reload and try again.',
          });

          expect(cancel).not.toHaveBeenCalled();
          expect(commit).not.toHaveBeenCalled();
          expect(release).not.toHaveBeenCalled();
          expect(destroy).not.toHaveBeenCalled();
          expect(decisions).not.toHaveBeenCalled();
          expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
          expect(canonicalImages()).toEqual(before);
          expect(indexIds()).toEqual(['a', 'b', 'c', 'o']);
          if (raw === null)
            expect(lstatSync(configPath).isDirectory()).toBe(true);
          else expect(readFileSync(configPath, 'utf8')).toBe(raw);
          expect(await readDestructiveRecovery('o')).toBe(null);
          // Once repaired, the released key deletes the project.
          cancel.mockResolvedValue(undefined);
          if (raw === null) rmSync(configPath, { recursive: true });
          writeFileSync(
            configPath,
            JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
          );
          __resetSidebarItemsStateForTests();
          await expect(deleteWorkspace(request)).resolves.toMatchObject({
            removed: 'cowork',
          });
          expect(decisionCalls()).toEqual([['o', DELETE_INDEX]]);
          expect(existsSync(join(root, 'o'))).toBe(false);
        },
        15_000,
      );
    },
  );

  it('§3.3 a Cowork configuration that becomes unreadable during the session teardown refuses before the Cowork deletion removes anything', async () => {
    addCowork('o', { externalPath: getWorkspaceDir('o') });
    const destroy = jest
      .spyOn(sessionManager, 'destroyWorktreeSessions')
      .mockImplementationOnce(() => {
        writeFileSync(join(root, 'o', 'workspace.json'), '{truncated');
        __resetSidebarItemsStateForTests();
        return Promise.resolve();
      });
    const prepareBrowserRetirement = jest.mocked(
      prepareWorkspaceBrowserRetirement,
    );
    prepareBrowserRetirement.mockRejectedValueOnce(
      new Error('Unexpected browser retirement'),
    );

    try {
      await expect(deleteWorkspace(chatProjectRequest('o'))).rejects.toThrow(
        'Refusing to delete cowork project: its configuration could not be read, so its external folder is unknown.',
      );
      expect(prepareBrowserRetirement).not.toHaveBeenCalled();
    } finally {
      prepareBrowserRetirement.mockReset().mockResolvedValue([]);
    }

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(decisions).not.toHaveBeenCalled();
    expect(indexIds()).toContain('o');
    expect(readFileSync(join(root, 'o', 'workspace.json'), 'utf8')).toBe(
      '{truncated',
    );
    expect(await readDestructiveRecovery('o')).toMatchObject({
      state: 'recovery-required',
      steps: [
        { phase: 'session-teardown', state: 'done' },
        { phase: 'session-teardown', state: 'done' },
        { phase: 'cowork-deletion', state: 'pending' },
      ],
    });
  }, 15_000);

  it.each(['same', 'child', 'parent'] as const)(
    '§3.3 the guarded config protects an overlapping %s folder when the sidebar reads an unreadable config',
    async (relationship) => {
      const metadataDir = getWorkspaceDir('o');
      const externalPath =
        relationship === 'child'
          ? join(metadataDir, 'external')
          : relationship === 'parent'
            ? root
            : metadataDir;
      addCowork('o', { externalPath });
      mkdirSync(externalPath, { recursive: true });
      // A sibling of metadata would survive its deletion in the parent case.
      const sentinel = join(
        relationship === 'parent' ? metadataDir : externalPath,
        'keep.txt',
      );
      writeFileSync(sentinel, 'user data');
      const configPath = join(metadataDir, 'workspace.json');
      const readConfig = workspacePersistence.readWorkspaceConfigDetailed;
      const readSidebar = sidebarItems.readAllSidebarItems;
      const projectionRead = jest.fn();
      jest
        .spyOn(sessionManager, 'destroyWorktreeSessions')
        .mockImplementationOnce(() => {
          let releaseProjection = (): void => {};
          const configRead = new Promise<void>((resolve) => {
            releaseProjection = resolve;
          });
          jest
            .spyOn(sidebarItems, 'readAllSidebarItems')
            .mockImplementationOnce(async (options) => {
              await configRead;
              const projection = await readSidebar(options);
              projectionRead(projection.items.find((item) => item.id === 'o'));
              return projection;
            });
          jest
            .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
            .mockImplementationOnce(async (id) => {
              try {
                const config = await readConfig(id);
                expect(config.authority).toBe('ok');
                expect(config.config.externalPath).toBe(externalPath);
                writeFileSync(configPath, '{truncated');
                __resetSidebarItemsStateForTests();
                return config;
              } finally {
                releaseProjection();
              }
            });
          return Promise.resolve();
        });
      const prepareBrowserRetirement = jest.mocked(
        prepareWorkspaceBrowserRetirement,
      );
      prepareBrowserRetirement.mockRejectedValueOnce(
        new Error('Unexpected browser retirement'),
      );

      try {
        await expect(deleteWorkspace(chatProjectRequest('o'))).rejects.toThrow(
          'Refusing to delete cowork project: its metadata directory and external folder overlap.',
        );
        expect(projectionRead).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'o', externalPath: undefined }),
        );
        expect(prepareBrowserRetirement).not.toHaveBeenCalled();
      } finally {
        prepareBrowserRetirement.mockReset().mockResolvedValue([]);
      }
      expect(decisions).not.toHaveBeenCalled();
      expect(indexIds()).toContain('o');
      expect(readFileSync(sentinel, 'utf8')).toBe('user data');
      expect(readFileSync(configPath, 'utf8')).toBe('{truncated');
      expect(await readDestructiveRecovery('o')).toMatchObject({
        state: 'recovery-required',
        steps: [
          { phase: 'session-teardown', state: 'done' },
          { phase: 'session-teardown', state: 'done' },
          { phase: 'cowork-deletion', state: 'pending' },
        ],
      });
    },
    15_000,
  );

  it('§3.3 a Cowork project without a configuration file still deletes', async () => {
    addCowork('o');
    rmSync(join(root, 'o', 'workspace.json'));
    __resetSidebarItemsStateForTests();

    await expect(deleteWorkspace(chatProjectRequest('o'))).resolves.toEqual(
      expect.objectContaining({ removed: 'cowork' }),
    );
    expect(decisionCalls()).toEqual([['o', DELETE_INDEX]]);
    expect(indexIds()).toEqual(['a', 'b', 'c']);
    expect(existsSync(join(root, 'o'))).toBe(false);
  });
});

describe('CAN-6478 lifecycle retention', () => {
  it('limits deleting-hold exemptions to same-project child lifecycle ancestry', async () => {
    let receipt = await cancelledResolutionForOne('project-delete', true);
    const { archiveRecoveryStore } = await import('../archive-recovery-refs');
    const store = archiveRecoveryStore();
    receipt = await store.restartCancelled(receipt);
    receipt = await store.publishRetention(receipt);
    receipt = await store.resetStaging(receipt);
    receipt = await store.withdrawJournals(receipt);
    receipt = await store.writeStage(receipt, 'completed');
    receipt = await store.beginDeletion(receipt);
    const {
      assertNoDestructiveRecovery,
      runStepFreeChildLifecycles,
      withDestructiveLifecycle,
    } = await import('../w5-destructive-recovery');
    await withDestructiveLifecycle(
      { operation: 'workspace-delete', workspaceId: 'b' },
      () =>
        runStepFreeChildLifecycles(() =>
          expect(assertNoDestructiveRecovery('a', 'one')).rejects.toThrow(
            receipt.operationId,
          ),
        ),
    );
    await withDestructiveLifecycle(
      { operation: 'workspace-delete', workspaceId: 'a' },
      async () => {
        await expect(assertNoDestructiveRecovery('a', 'one')).rejects.toThrow(
          receipt.operationId,
        );
        await runStepFreeChildLifecycles(() =>
          withDestructiveLifecycle(
            {
              operation: 'worktree-archive',
              workspaceId: 'a',
              worktreeId: 'two',
              createdAt: receipt.createdAt,
            },
            () => assertNoDestructiveRecovery('a', 'one'),
          ),
        );
      },
    );
    await expect(assertNoDestructiveRecovery('a', 'one')).rejects.toThrow(
      receipt.operationId,
    );
    expect(await store.read('a', receipt.operationId)).toEqual(receipt);
  });

  it.each([
    'completed',
    'deleting',
    'partially-deleted',
    'deleted',
    'cancelled',
    'effect-free',
    'effects',
    'conflicted',
  ] as const)(
    'portal project deletion with a listed Keep hold and sibling: %s',
    async (shape) => {
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      const extraRef = 'refs/app/archived-containers/a/one/extra';
      git('update-ref', extraRef, git('rev-parse', 'HEAD'));
      let receipt = await cancelledResolutionForOne('project-delete', true);
      const { archiveRecoveryStore, assertNoArchiveResolution } =
        await import('../archive-recovery-refs');
      const store = archiveRecoveryStore();
      if (shape !== 'cancelled')
        receipt = await store.restartCancelled(receipt);
      const completed = [
        'completed',
        'deleting',
        'partially-deleted',
        'deleted',
      ].includes(shape);
      if (completed || shape === 'effects') {
        receipt = await store.publishRetention(receipt);
        receipt = await store.resetStaging(receipt);
      }
      if (completed) {
        receipt = await store.withdrawJournals(receipt);
        receipt = await store.writeStage(receipt, 'completed');
      }
      if (['deleting', 'partially-deleted', 'deleted'].includes(shape)) {
        receipt = await store.beginDeletion(receipt);
        if (shape !== 'deleting') git('update-ref', '-d', extraRef);
        if (shape === 'deleted') {
          for (const repository of receipt.repositories)
            for (const ref of repository.refs)
              git('update-ref', '-d', ref.name);
          receipt = await store.deletePayload(receipt);
        }
      }
      if (shape === 'conflicted')
        writeFileSync(join(store.stagingPath(receipt), 'unique'), 'changed');
      const { readWorkspaceWorktrees } =
        await import('../workspace-persistence');
      expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
        'one',
        'two',
      ]);
      if (shape === 'deleting' || shape === 'partially-deleted') {
        await expect(assertNoArchiveResolution('a', 'one')).rejects.toThrow(
          receipt.operationId,
        );
        const { assertNoDestructiveRecovery, withDestructiveLifecycle } =
          await import('../w5-destructive-recovery');
        await expect(assertNoDestructiveRecovery('a', 'one')).rejects.toThrow(
          receipt.operationId,
        );
        for (const operation of [
          'worktree-archive',
          'worktree-delete',
        ] as const)
          await expect(
            withDestructiveLifecycle(
              {
                workspaceId: 'a',
                worktreeId: 'one',
                operation,
                trigger: 'project-deletion',
                createdAt: receipt.createdAt,
              },
              () =>
                Promise.reject(new Error('A trigger is not a parent lease')),
            ),
          ).rejects.toThrow(receipt.operationId);
      }
      const remainingRefs = receipt.repositories
        .flatMap((repository) => repository.refs)
        .filter(
          (ref) => git('for-each-ref', '--format=%(refname)', ref.name) !== '',
        );
      if (completed && shape !== 'deleted') {
        writeFileSync(
          join(root, 'a/worktrees/one/new-work.txt'),
          'new live work',
        );
        decisions.mockImplementation(async (...args) => {
          // Child archives must leave the original hold intact for parent settlement.
          for (const repository of receipt.repositories)
            for (const ref of repository.refs)
              if (remainingRefs.includes(ref))
                expect(git('rev-parse', ref.name)).toBe(ref.objectId);
              else
                expect(
                  git('for-each-ref', '--format=%(refname)', ref.name),
                ).toBe('');
          expect(
            readFileSync(join(store.payloadPath(receipt), 'unique'), 'utf8'),
          ).toBe('discarded staging');
          expect(
            git(
              'for-each-ref',
              '--format=%(refname)',
              'refs/app/archived-containers/a/one/__generations__/',
            ),
          ).not.toBe('');
          expect(await readWorkspaceWorktrees('a')).toEqual([]);
          return actualPort.applyWorkspaceIndexRemoval(...args);
        });
      }
      const { describePendingArchiveRecoveries } =
        await import('../archive-recovery-project-deletion');
      const discardPendingRecovery =
        shape === 'effect-free'
          ? await describePendingArchiveRecoveries('a')
          : undefined;
      const deletion = deleteWorkspace({
        workspaceId: 'a',
        source: 'portal',
        discardPendingRecovery,
      });
      if (shape === 'effects' || shape === 'conflicted') {
        await expect(deletion).rejects.toMatchObject({
          name: 'ArchiveRecoveryRefusedError',
        });
        await expect(deletion).rejects.toThrow(receipt.operationId);
        expect(
          (await readWorkspaceWorktrees('a')).map((row) => row.id),
        ).toEqual(['one', 'two']);
        expect(existsSync(join(root, 'a/worktrees/one'))).toBe(true);
        expect(git('rev-parse', extraRef)).toBe(git('rev-parse', 'HEAD'));
        return;
      }
      await expect(deletion).resolves.toMatchObject({
        removed: 'code',
        cleanup: { archivedGitRefs: { status: 'done' } },
      });
      expect(existsSync(getWorkspaceDir('a'))).toBe(false);
      if (completed) {
        expect(
          git(
            'for-each-ref',
            '--format=%(refname)',
            'refs/app/archived-containers/a/',
          ),
        ).toBe('');
        expect((await store.read('a', receipt.operationId))?.retention).toBe(
          'deleted',
        );
        expect(existsSync(store.payloadPath(receipt))).toBe(false);
        if (shape !== 'deleted')
          expect(
            (await readDestructiveRecovery('a'))?.archiveRecoveryCleanup,
          ).toContainEqual({
            operationId: receipt.operationId,
            revision: receipt.revision,
            done: true,
          });
      } else expect(await store.read('a', receipt.operationId)).toBeNull();
    },
  );

  async function cancelledResolutionForOne(
    owner?: 'archive' | 'delete' | 'project-delete',
    withRef = false,
  ): Promise<ArchiveRecoveryReceipt> {
    const { randomUUID, createHash } = await import('node:crypto');
    const { archiveRecoveryStore } = await import('../archive-recovery-refs');
    const { readArchiveJournalOperations } =
      await import('../stranded-archive-journals');
    const { readWorkspaceWorktrees } = await import('../workspace-persistence');
    const row = (await readWorkspaceWorktrees('a')).find(
      (entry) => entry.id === 'one',
    );
    if (!row) throw new Error('Missing row');
    const checkout = join(root, 'a/worktrees/one');
    const identity = (path: string): string => {
      const info = lstatSync(path);
      return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    };
    const record = {
      version: 1,
      operationId: randomUUID(),
      operation: 'worktree-archive',
      workspaceId: 'a',
      worktreeId: 'one',
      createdAt: row.createdAt,
      state: 'recovery-required',
      directoryIdentity: identity(getWorkspaceDir('a')),
      ...(owner === 'project-delete'
        ? { parentOperation: 'workspace-delete' }
        : {}),
      steps:
        owner === 'archive' || owner === 'delete'
          ? [{ phase: 'retained-payload-capture', state: 'pending' }]
          : [{ phase: 'git-capture', state: 'failed' }],
      ownedPaths: [{ path: checkout, identity: identity(checkout) }],
    };
    const name = `${createHash('sha256')
      .update(JSON.stringify(['a', 'one']))
      .digest('hex')}.json`;
    mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
    writeFileSync(
      join(getW5DestructiveLifecycleDir(), name),
      JSON.stringify(record),
    );
    const operation = (await readArchiveJournalOperations('a')).operations.find(
      (entry) => entry.record.operationId === record.operationId,
    );
    if (!operation) throw new Error('Missing source');
    const store = archiveRecoveryStore();
    if (withRef) {
      const oid = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      execFileSync('git', [
        '-C',
        repo,
        'update-ref',
        'refs/app/archived-containers/a/one/__single_repo__',
        oid,
      ]);
    }
    mkdirSync(store.stagingPath({ workspaceId: 'a', worktreeId: 'one' }), {
      recursive: true,
    });
    writeFileSync(
      join(
        store.stagingPath({ workspaceId: 'a', worktreeId: 'one' }),
        'unique',
      ),
      'discarded staging',
    );
    return store.cancel(
      await store.prepare({
        workspaceId: 'a',
        worktreeId: 'one',
        operationId: record.operationId,
        action: 'keep-worktree',
        createdAt: row.createdAt,
        revision: operation.revision,
        sourceRecord: operation.record,
        copies: operation.sources,
        repositories: await (
          await import('../archived-container-git')
        ).inspectArchiveRecoveryRepositories({
          workspaceId: 'a',
          containerId: 'one',
          workspaceType: 'single-repo',
        }),
        capture: withRef ? 'unpublished' : 'none',
      }),
    );
  }

  it.each([
    'prepared',
    'retention-intent',
    'retained',
    'reset-intent',
    'moved',
    'changed-ref',
  ] as const)(
    'confirmed project deletion cancels only proven effect-free resolution: %s',
    async (shape) => {
      const cancelled = await cancelledResolutionForOne('project-delete', true);
      const { archiveRecoveryStore } = await import('../archive-recovery-refs');
      const store = archiveRecoveryStore();
      let receipt = await store.restartCancelled(cancelled);
      if (shape === 'retention-intent')
        receipt = await store.writeStage(receipt, shape);
      if (['retained', 'reset-intent', 'moved'].includes(shape))
        receipt = await store.publishRetention(receipt);
      if (shape === 'reset-intent' || shape === 'moved')
        receipt = await store.writeStage(receipt, 'reset-intent');
      if (shape === 'moved')
        renameSync(store.stagingPath(receipt), store.payloadPath(receipt));
      if (shape === 'changed-ref') {
        execFileSync('git', [
          '-C',
          repo,
          'update-ref',
          '-d',
          'refs/app/archived-containers/a/one/__single_repo__',
        ]);
      }
      const { describePendingArchiveRecoveries } =
        await import('../archive-recovery-project-deletion');
      const discardPendingRecovery = await describePendingArchiveRecoveries(
        'a',
      ).catch(() => undefined);
      const deletion = deleteWorkspace({
        workspaceId: 'a',
        source: 'portal',
        discardPendingRecovery,
      });
      if (shape === 'moved' || shape === 'changed-ref') {
        await expect(deletion).rejects.toMatchObject({
          name: 'ArchiveRecoveryRefusedError',
        });
        await expect(deletion).rejects.toThrow(receipt.operationId);
        await expect(store.read('a', receipt.operationId)).resolves.toEqual(
          receipt,
        );
        expect(existsSync(join(getWorkspaceDir('a'), 'workspace.json'))).toBe(
          true,
        );
      } else {
        await expect(deletion).resolves.toMatchObject({ removed: 'code' });
        expect(await store.read('a', receipt.operationId)).toBeNull();
        expect(existsSync(getWorkspaceDir('a'))).toBe(false);
      }
    },
  );

  it.each(['effect-free', 'unresumable'] as const)(
    'refuses %s pending recovery whose same-slot row discard remains fenced',
    async (shape) => {
      const original = await cancelledResolutionForOne(undefined, true);
      const { archiveRecoveryStore } = await import('../archive-recovery-refs');
      const { describeProjectDeletionDiscard } =
        await import('../project-deletion-discard');
      const { describeWorktreeDiscard } = await import('../worktree-discard');
      const store = archiveRecoveryStore();
      let receipt = await store.restartCancelled(original);
      if (shape === 'unresumable') {
        receipt = await store.publishRetention(receipt);
        receipt = await store.resetStaging(receipt);
      }
      execFileSync('git', [
        '-C',
        repo,
        'worktree',
        'remove',
        '--force',
        join(root, 'a/worktrees/one'),
      ]);
      for (const copy of shape === 'unresumable' ? receipt.copies : []) {
        const record = journalSchema.parse(JSON.parse(copy.contents));
        record.steps.push({ phase: 'checkout-removal', state: 'done' });
        writeFileSync(
          join(getW5DestructiveLifecycleDir(), copy.name),
          JSON.stringify(record),
        );
      }
      expect((await describeWorktreeDiscard('a', 'one')).status).toBe(
        'discardable',
      );
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toThrow(receipt.operationId);
      await expect(
        describeProjectDeletionDiscard('a', { retainedArchives: true }),
      ).resolves.toMatchObject({ status: 'refused', items: [] });
      expect(await store.read('a', receipt.operationId)).toEqual(receipt);
      expect(existsSync(store.payloadPath(receipt))).toBe(
        shape === 'unresumable',
      );
      expect(existsSync(store.stagingPath(receipt))).toBe(
        shape === 'effect-free',
      );
      expect(indexIds()).toContain('a');
    },
  );

  it('requires a fresh explicit confirmation before cancelling an effect-free resolution', async () => {
    const original = await cancelledResolutionForOne('project-delete', true);
    const { archiveRecoveryStore } = await import('../archive-recovery-refs');
    const store = archiveRecoveryStore();
    const receipt = await store.restartCancelled(original);
    const { describeProjectDeletionDiscard } =
      await import('../project-deletion-discard');
    const described = await describeProjectDeletionDiscard('a');
    expect(described.pendingRecovery).toHaveLength(1);
    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
    ).rejects.toThrow(receipt.operationId);
    expect(await store.read('a', receipt.operationId)).toEqual(receipt);
    await store.publishRetention(receipt);
    await expect(
      deleteWorkspace({
        workspaceId: 'a',
        source: 'portal',
        discardPendingRecovery: described.pendingRecovery,
      }),
    ).rejects.toThrow();
    expect(
      (await store.read('a', receipt.operationId))?.cancelled,
    ).toBeUndefined();
    const fresh = await describeProjectDeletionDiscard('a');
    await expect(
      deleteWorkspace({
        workspaceId: 'a',
        source: 'portal',
        discardPendingRecovery: fresh.pendingRecovery,
      }),
    ).resolves.toMatchObject({ removed: 'code' });
  });

  it.each(['before', 'after'] as const)(
    'confirmed unresumable hold is discarded only after canonical removal: %s',
    async (timing) => {
      const original = await cancelledResolutionForOne('project-delete', true);
      const { archiveRecoveryStore } = await import('../archive-recovery-refs');
      const store = archiveRecoveryStore();
      let receipt = await store.restartCancelled(original);
      receipt = await store.publishRetention(receipt);
      receipt = await store.resetStaging(receipt);
      // Lost source copies make withdrawal impossible, but the exact owned payload remains.
      for (const copy of receipt.copies)
        rmSync(join(getW5DestructiveLifecycleDir(), copy.name));
      const { describePendingArchiveRecoveries } =
        await import('../archive-recovery-project-deletion');
      const discardPendingRecovery =
        await describePendingArchiveRecoveries('a');
      expect(discardPendingRecovery).toHaveLength(1);
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toThrow(receipt.operationId);
      expect(existsSync(store.payloadPath(receipt))).toBe(true);
      const originalRemove = decisions.getMockImplementation();
      if (!originalRemove) throw new Error('Missing removal port');
      decisions.mockImplementation(async (...args) => {
        expect(existsSync(store.payloadPath(receipt))).toBe(true);
        if (timing === 'before') throw new Error('before canonical removal');
        return originalRemove(...args);
      });
      try {
        const deletion = deleteWorkspace({
          workspaceId: 'a',
          source: 'portal',
          discardPendingRecovery,
        });
        if (timing === 'before')
          await expect(deletion).rejects.toThrow('before canonical removal');
        else await expect(deletion).resolves.toMatchObject({ removed: 'code' });
      } finally {
        decisions.mockImplementation(originalRemove);
      }
      expect(indexIds().includes('a')).toBe(timing === 'before');
      expect(existsSync(store.payloadPath(receipt))).toBe(timing === 'before');
      expect((await store.read('a', receipt.operationId))?.retention).toBe(
        timing === 'before' ? undefined : 'deleted',
      );
      if (timing === 'before') {
        const { describeProjectDeletionDiscard } =
          await import('../project-deletion-discard');
        const retry = await describeProjectDeletionDiscard('a', {
          retainedArchives: true,
        });
        expect(retry.status).toBe('discardable');
        expect(retry.pendingRecovery).toHaveLength(1);
        expect(retry.interruptedDeletion?.operationId).toEqual(
          expect.any(String),
        );
        await expect(
          deleteWorkspace({
            workspaceId: 'a',
            source: 'portal',
            discardPendingRecovery: retry.pendingRecovery,
            supersedeInterruptedDeletion:
              retry.interruptedDeletion?.operationId,
          }),
        ).resolves.toMatchObject({ removed: 'code' });
        expect(indexIds()).not.toContain('a');
        expect(existsSync(store.payloadPath(receipt))).toBe(false);
      }
    },
  );

  it('replays confirmed pending-recovery cleanup after losing its tombstone acknowledgement', async () => {
    const original = await cancelledResolutionForOne('project-delete', true);
    const { archiveRecoveryStore } = await import('../archive-recovery-refs');
    const { ArchiveRecoveryStore } =
      await import('@canopy/desktop-shared/node/archive-recovery-store');
    const store = archiveRecoveryStore();
    let receipt = await store.restartCancelled(original);
    receipt = await store.publishRetention(receipt);
    receipt = await store.resetStaging(receipt);
    for (const copy of receipt.copies)
      rmSync(join(getW5DestructiveLifecycleDir(), copy.name));
    const { describePendingArchiveRecoveries } =
      await import('../archive-recovery-project-deletion');
    const discardPendingRecovery = await describePendingArchiveRecoveries('a');
    const fault = jest.spyOn(ArchiveRecoveryStore.prototype, 'deletePayload');
    const remove = fault.getMockImplementation();
    if (!remove) throw new Error('Missing payload deletion');
    fault.mockImplementationOnce(async function (
      this: ArchiveRecoveryStore,
      selected,
    ) {
      await remove.call(this, selected);
      throw new Error('lost pending discard acknowledgement');
    });
    try {
      await expect(
        deleteWorkspace({
          workspaceId: 'a',
          source: 'portal',
          discardPendingRecovery,
        }),
      ).resolves.toMatchObject({ removed: 'code' });
    } finally {
      fault.mockRestore();
    }
    expect(indexIds()).not.toContain('a');
    expect((await store.read('a', receipt.operationId))?.retention).toBe(
      'deleted',
    );
    const parent = await readDestructiveRecovery('a');
    if (!parent) throw new Error('Missing pending-recovery parent');
    const { settleWorkspaceArchiveRecoveryCleanup } =
      await import('../workspace-deletion');
    await settleWorkspaceArchiveRecoveryCleanup(parent);
    await settleWorkspaceArchiveRecoveryCleanup(parent);
    expect(
      (await readDestructiveRecovery('a'))?.archiveRecoveryCleanup?.every(
        (member) => member.done,
      ),
    ).toBe(true);
  });

  it('project deletion stops on lost cancellation acknowledgement and retries the durable cancellation', async () => {
    const cancelled = await cancelledResolutionForOne('project-delete', true);
    const { archiveRecoveryStore } = await import('../archive-recovery-refs');
    const store = archiveRecoveryStore();
    const receipt = await store.restartCancelled(cancelled);
    const { ArchiveRecoveryStore } =
      await import('@canopy/desktop-shared/node/archive-recovery-store');
    const fault = jest.spyOn(ArchiveRecoveryStore.prototype, 'cancel');
    const cancel = fault.getMockImplementation();
    if (!cancel) throw new Error('Missing cancellation implementation');
    fault.mockImplementationOnce(async function (
      this: ArchiveRecoveryStore,
      selected,
    ) {
      await cancel.call(this, selected);
      throw new Error('lost cancellation acknowledgement');
    });
    const { describePendingArchiveRecoveries } =
      await import('../archive-recovery-project-deletion');
    const discardPendingRecovery = await describePendingArchiveRecoveries('a');
    try {
      const deletion = deleteWorkspace({
        workspaceId: 'a',
        source: 'portal',
        discardPendingRecovery,
        idempotencyKey: 'q26-cancellation-retry',
      });
      await expect(deletion).rejects.toMatchObject({
        name: 'ArchiveRecoveryRefusedError',
      });
      await expect(deletion).rejects.toThrow(receipt.operationId);
    } finally {
      fault.mockRestore();
    }
    expect(existsSync(join(getWorkspaceDir('a'), 'workspace.json'))).toBe(true);
    expect((await store.read('a', receipt.operationId))?.cancelled).toBe(true);
    await expect(
      deleteWorkspace({
        workspaceId: 'a',
        source: 'portal',
        idempotencyKey: 'q26-cancellation-retry',
      }),
    ).resolves.toMatchObject({ removed: 'code' });
    expect(await store.read('a', receipt.operationId)).toBeNull();
  });

  it.each(['archive', 'delete', 'project-delete'] as const)(
    '%s completion settles cancelled predecessor receipts through the lifecycle writer',
    async (owner) => {
      const receipt = await cancelledResolutionForOne(owner);
      if (owner === 'archive') {
        await (
          await import('../worktree-service')
        ).archiveSingleRepoWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          repoPath: repo,
        });
      } else if (owner === 'delete') {
        await (
          await import('../worktree-archive')
        ).deleteWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
          repoPath: repo,
        });
      } else {
        await deleteWorkspace({ workspaceId: 'a', source: 'portal' });
      }
      expect(
        await (await import('../archive-recovery-refs'))
          .archiveRecoveryStore()
          .read('a', receipt.operationId),
      ).toBeNull();
    },
  );

  it.each(['archive', 'delete', 'discard'] as const)(
    '%s settles cancellation after repeated interrupted Delete takeovers',
    async (owner) => {
      const receipt = await cancelledResolutionForOne('delete', true);
      const { withDestructiveLifecycle, destructiveStep } =
        await import('../w5-destructive-recovery');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          withDestructiveLifecycle(
            {
              operation: 'worktree-delete',
              workspaceId: 'a',
              worktreeId: 'one',
              createdAt: receipt.createdAt,
              readCreatedAt: () => Promise.resolve(receipt.createdAt),
            },
            () =>
              destructiveStep('checkout-removal', () =>
                Promise.reject(new Error('interrupted checkout removal')),
              ),
          ),
        ).rejects.toThrow('interrupted checkout removal');
        expect(
          (await readDestructiveRecovery('a', 'one'))?.supersedesArchives,
        ).toContain(receipt.operationId);
      }
      if (owner === 'discard') {
        await expect(
          withDestructiveLifecycle(
            {
              operation: 'worktree-delete',
              workspaceId: 'a',
              worktreeId: 'one',
              createdAt: receipt.createdAt,
              readCreatedAt: () => Promise.resolve(receipt.createdAt),
            },
            async () => {
              await destructiveStep('checkout-removal', () => {
                execFileSync('git', [
                  '-C',
                  repo,
                  'worktree',
                  'remove',
                  join(root, 'a/worktrees/one'),
                ]);
                return Promise.resolve();
              });
              await destructiveStep('branch-deletion', () =>
                Promise.reject(new Error('interrupted after checkout removal')),
              );
            },
          ),
        ).rejects.toThrow('interrupted after checkout removal');
        const { describeWorktreeDiscard, discardWorktree } =
          await import('../worktree-discard');
        const description = await describeWorktreeDiscard('a', 'one');
        const result = await discardWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        });
        expect(result).toMatchObject({ status: 'discarded' });
      } else if (owner === 'archive') {
        await (
          await import('../worktree-service')
        ).archiveSingleRepoWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          repoPath: repo,
        });
      } else {
        await (
          await import('../worktree-archive')
        ).deleteWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
          repoPath: repo,
        });
      }
      const { archiveRecoveryStore, isArchiveRecoveryRefHeld } =
        await import('../archive-recovery-refs');
      expect(
        await archiveRecoveryStore().read('a', receipt.operationId),
      ).toBeNull();
      expect(
        await isArchiveRecoveryRefHeld(
          repo,
          'refs/app/archived-containers/a/one/__single_repo__',
        ),
      ).toBe(false);
      const { freezeInternalRootArchiveRecovery } =
        await import('@canopy/desktop-shared/node/internal-root-migration/archive-recovery');
      await expect(
        freezeInternalRootArchiveRecovery(getCanopyDataDir()),
      ).resolves.toBeDefined();
    },
  );

  it.each([2, 3] as const)(
    'v%s Finish settles cancellation after archive progress consumed its sources',
    async (version) => {
      const receipt = await cancelledResolutionForOne();
      const manifest = archivedManifest('a', 'one');
      manifest.createdAt = receipt.createdAt;
      const oid = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      manifest.gitState.repositories.push({
        repoId: '__single_repo__',
        repoName: 'repo',
        relativePath: '.',
        referenceRepoPath: repo,
        comparisonBaseCommit: oid,
        headCommit: oid,
        indexSnapshotCommit: oid,
        worktreeSnapshotCommit: oid,
        snapshotRef: 'refs/app/archived-containers/a/one/__single_repo__',
      });
      if (
        manifest.gitChanges.status !== 'complete' ||
        !manifest.pullRequestMetadata
      )
        throw new Error('Missing capture metadata');
      manifest.gitChanges.repositories.push({
        repoId: '__single_repo__',
        repoName: 'repo',
        fileCount: 0,
        insertions: 0,
        deletions: 0,
      });
      manifest.pullRequestMetadata.repositories.push({
        repoId: '__single_repo__',
        repoName: 'repo',
        status: 'complete',
        pullRequest: null,
      });
      if (!manifest.originalWorktree) throw new Error('Missing original row');
      manifest.originalWorktree.createdAt = receipt.createdAt;
      if (version === 2) await commitArchivedContainer(manifest);
      else {
        const payloadId = '00000000-0000-4000-8000-000000000003';
        const payload = join(
          getArchivedContainerDir('a', 'one'),
          'recovery-files',
          payloadId,
        );
        mkdirSync(payload, { recursive: true });
        writeFileSync(join(payload, 'kept.txt'), 'preserved by Finish');
        const digest = await workspaceRootPayloadDigest({ rootPath: payload });
        if (!digest) throw new Error('Missing payload digest');
        await commitArchivedContainer({
          ...archivedManifestFields('a', 'one'),
          createdAt: receipt.createdAt,
          originalWorktree: manifest.originalWorktree,
          version: 3,
          recovery: {
            kind: 'files-only',
            source: 'partial',
            digest,
            payloadId,
            gitCleanupPending: false,
          },
        });
      }
      execFileSync('git', [
        '-C',
        repo,
        'worktree',
        'remove',
        join(root, 'a/worktrees/one'),
      ]);
      const phases =
        version === 2
          ? [
              'git-worktree-removal',
              'quarantine-directory-removal',
              'pipeline-cleanup',
              'retained-manifest-commit',
              'git-capture-completion',
            ]
          : [
              'retained-git-cleanup',
              'pipeline-cleanup',
              'retained-manifest-commit',
            ];
      const progressed = {
        ...receipt.sourceRecord,
        steps: phases.map((phase) => ({ phase, state: 'done' })),
      };
      for (const copy of receipt.copies)
        writeFileSync(
          join(getW5DestructiveLifecycleDir(), copy.name),
          JSON.stringify(progressed),
        );
      const { listWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const diagnosis = (
        await listWorktreeRecovery({
          workspaceId: 'a',
          operationId: receipt.operationId,
        })
      ).entries[0]?.diagnosis;
      expect(diagnosis?.verdict).toBe('finish-tail');
      if (!diagnosis) throw new Error('Missing Finish diagnosis');
      expect(
        await (
          await import('../worktree-recovery-finish')
        ).finishWorktreeRecovery({
          workspaceId: 'a',
          operationId: receipt.operationId,
          revision: diagnosis.revision,
        }),
      ).toMatchObject({ status: 'finished' });
      expect(
        await (await import('../archive-recovery-refs'))
          .archiveRecoveryStore()
          .read('a', receipt.operationId),
      ).toBeNull();
      expect(
        existsSync(join(getArchivedContainerDir('a', 'one'), 'container.json')),
      ).toBe(true);
    },
  );

  it.each(['keep-worktree', 'release'] as const)(
    'Discard settles cancellation before relocation and a later %s on the recreated slot',
    async (action) => {
      const { archiveRecoveryStore, isArchiveRecoveryRefHeld } =
        await import('../archive-recovery-refs');
      const { describeWorktreeDiscard, discardWorktree } =
        await import('../worktree-discard');
      const { freezeInternalRootArchiveRecovery } =
        await import('@canopy/desktop-shared/node/internal-root-migration/archive-recovery');
      const { listWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const { resolveWorktreeArchive } =
        await import('../worktree-archive-resolution');
      const receipt = await cancelledResolutionForOne(undefined, true);
      const description = await describeWorktreeDiscard('a', 'one');
      const result = await discardWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        confirmation: description.confirmation,
        source: 'desktop-ui',
      });
      expect(result).toMatchObject({ status: 'discarded' });
      const store = archiveRecoveryStore();
      expect(await store.read('a', receipt.operationId)).toBeNull();
      await expect(
        freezeInternalRootArchiveRecovery(getCanopyDataDir()),
      ).resolves.toBeDefined();
      expect(
        await isArchiveRecoveryRefHeld(
          repo,
          'refs/app/archived-containers/a/one/__single_repo__',
        ),
      ).toBe(false);
      await (
        await import('../archived-container-git')
      ).reconcileArchivedGitRefsForWorkspace('a');
      expect(
        execFileSync(
          'git',
          [
            '-C',
            repo,
            'for-each-ref',
            '--format=%(refname)',
            'refs/app/archived-containers/a/one',
          ],
          { encoding: 'utf8' },
        ).trim(),
      ).toBe('');
      const checkout = join(root, 'a/worktrees/one');
      execFileSync('git', [
        '-C',
        repo,
        'worktree',
        'add',
        '-b',
        'recreated',
        checkout,
        'HEAD',
      ]);
      const rows = await workspacePersistence.readWorkspaceWorktrees('a');
      await workspacePersistence.writeWorkspaceWorktrees('a', [
        ...rows,
        {
          id: 'one',
          branchName: 'recreated',
          createdAt: '2026-11-13T10:00:00.000Z',
        },
      ]);
      const next = await cancelledResolutionForOne();
      if (action === 'release') {
        execFileSync('git', ['-C', repo, 'worktree', 'remove', checkout]);
        await workspacePersistence.removeWorkspaceWorktrees(
          'a',
          (entry) => entry.id === 'one',
        );
      }
      const diagnosis = (
        await listWorktreeRecovery({
          workspaceId: 'a',
          operationId: next.operationId,
        })
      ).entries[0]?.diagnosis;
      if (!diagnosis) throw new Error('Missing recreated diagnosis');
      expect(
        await resolveWorktreeArchive({
          workspaceId: 'a',
          operationId: next.operationId,
          revision: diagnosis.revision,
          action,
        }),
      ).toMatchObject({
        status: action === 'release' ? 'attempt-withdrawn' : 'worktree-kept',
      });
    },
  );

  it.each([false, true])(
    'retained refs survive absent-archive-root reconciliation and release (aliased common directory: %s), even after the saved checkout is gone',
    async (aliased) => {
      const { randomUUID } = await import('node:crypto');
      const { archiveRecoveryStore, archiveRecoveryRepositoryIdentity } =
        await import('../archive-recovery-refs');
      const { getGitCommonDir } = await import('../git');
      const {
        reconcileArchivedGitRefsForWorkspace,
        deleteArchivedContainerSnapshotRef,
      } = await import('../archived-container-git');
      const checkout = join(root, 'a', 'worktrees', 'one');
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      const canonicalCommonDir = await getGitCommonDir(checkout);
      const commonDir = aliased
        ? join(root, 'common-dir-alias')
        : canonicalCommonDir;
      if (aliased) {
        const { symlink } = await import('node:fs/promises');
        await symlink(canonicalCommonDir, commonDir, 'junction');
      }
      const oid = git('rev-parse', 'HEAD');
      const ref = 'refs/app/archived-containers/a/one/__single_repo__';
      const orphan = 'refs/app/archived-containers/a/orphan/__single_repo__';
      git('update-ref', ref, oid);
      git('update-ref', orphan, oid);
      await archiveRecoveryStore().prepare({
        workspaceId: 'a',
        worktreeId: 'one',
        operationId: randomUUID(),
        action: 'release',
        createdAt: '2026-11-01T00:00:00.000Z',
        revision: 'a'.repeat(64),
        sourceRecord: {},
        copies: [],
        capture: 'unpublished',
        repositories: [
          {
            repoId: '__single_repo__',
            referenceRepoPath: checkout,
            commonDir,
            identity: await archiveRecoveryRepositoryIdentity(commonDir),
            refs: [{ name: ref, objectId: oid }],
          },
        ],
      });
      expect(existsSync(getArchivedContainersRootDir('a'))).toBe(false);
      await deleteArchivedContainerSnapshotRef({
        repoPath: repo,
        refName: ref,
        expectedCommit: oid,
      });
      expect(git('rev-parse', ref)).toBe(oid);
      await reconcileArchivedGitRefsForWorkspace('a');
      expect(git('for-each-ref', '--format=%(objectname)', ref)).toBe(oid);
      expect(git('for-each-ref', '--format=%(refname)', orphan)).toBe('');
      git('worktree', 'remove', checkout);
      await reconcileArchivedGitRefsForWorkspace('a');
      expect(git('rev-parse', ref)).toBe(oid);
    },
  );

  it('Keep then edit then ordinary Archive does not resurrect or release old refs', async () => {
    const { randomUUID, createHash } = await import('node:crypto');
    const { archiveRecoveryStore } = await import('../archive-recovery-refs');
    const { resolveWorktreeArchive } =
      await import('../worktree-archive-resolution');
    const { listWorktreeRecovery } =
      await import('../worktree-recovery-description');
    const { archiveSingleRepoWorktree } = await import('../worktree-service');
    const { reconcileArchivedGitRefsForWorkspace } =
      await import('../archived-container-git');
    const { readWorkspaceWorktrees } = await import('../workspace-persistence');
    const row = (await readWorkspaceWorktrees('a')).find(
      (entry) => entry.id === 'one',
    );
    if (!row) throw new Error('Missing row');
    const checkout = join(root, 'a', 'worktrees', 'one');
    const identity = (path: string): string => {
      const info = lstatSync(path);
      return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    };
    const operationId = randomUUID();
    const record = {
      version: 1,
      operationId,
      operation: 'worktree-archive',
      workspaceId: 'a',
      worktreeId: 'one',
      createdAt: row.createdAt,
      state: 'recovery-required',
      directoryIdentity: identity(getWorkspaceDir('a')),
      steps: [{ phase: 'git-capture', state: 'failed' }],
      ownedPaths: [{ path: checkout, identity: identity(checkout) }],
    };
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const oldRef = 'refs/app/archived-containers/a/one/__single_repo__';
    const oid = git('rev-parse', 'HEAD');
    git('update-ref', oldRef, oid);
    mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
    const copies = [
      `${createHash('sha256')
        .update(JSON.stringify(['a', 'one']))
        .digest('hex')}.json`,
      `${operationId}.json`,
    ];
    for (const copy of copies)
      writeFileSync(
        join(getW5DestructiveLifecycleDir(), copy),
        JSON.stringify(record),
      );
    const diagnosis = (
      await listWorktreeRecovery({ workspaceId: 'a', operationId })
    ).entries[0]?.diagnosis;
    expect(diagnosis?.verdict).toBe('keep-worktree');
    if (!diagnosis) throw new Error('Missing diagnosis');
    expect(
      await resolveWorktreeArchive({
        workspaceId: 'a',
        operationId,
        revision: diagnosis.revision,
        action: 'keep-worktree',
      }),
    ).toMatchObject({ status: 'worktree-kept' });
    writeFileSync(join(checkout, 'after-keep.txt'), 'new unique file');
    await archiveSingleRepoWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      repoPath: repo,
    });
    expect(
      (await readWorkspaceWorktrees('a')).some((entry) => entry.id === 'one'),
    ).toBe(false);
    expect(existsSync(checkout)).toBe(false);
    const { isArchivedContainerManifest } =
      await import('@canopy/desktop-shared/lib/archived-container-contracts');
    const manifest: unknown = JSON.parse(
      readFileSync(
        join(getArchivedContainerDir('a', 'one'), 'container.json'),
        'utf8',
      ),
    );
    if (!isArchivedContainerManifest(manifest) || manifest.version !== 2)
      throw new Error('Missing valid v2 archive');
    expect(manifest.gitState.repositories[0]?.snapshotRef).not.toBe(oldRef);
    expect(git('rev-parse', oldRef)).toBe(oid);
    await reconcileArchivedGitRefsForWorkspace('a');
    expect(git('rev-parse', oldRef)).toBe(oid);
    expect((await archiveRecoveryStore().read('a', operationId))?.stage).toBe(
      'completed',
    );
    for (const copy of copies)
      if (existsSync(join(getW5DestructiveLifecycleDir(), copy)))
        expect(
          journalSchema.parse(
            JSON.parse(
              readFileSync(join(getW5DestructiveLifecycleDir(), copy), 'utf8'),
            ),
          ).operationId,
        ).not.toBe(operationId);
  });
  it.each(['none', 'before-publication', 'after-publication'] as const)(
    'cancelled Keep is atomically replaced by Release after %s interruption',
    async (interruption) => {
      const { randomUUID, createHash } = await import('node:crypto');
      const { archiveRecoveryStore } = await import('../archive-recovery-refs');
      const { resolveWorktreeArchive } =
        await import('../worktree-archive-resolution');
      const { listWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const { readWorkspaceWorktrees } =
        await import('../workspace-persistence');
      const row = (await readWorkspaceWorktrees('a')).find(
        (entry) => entry.id === 'one',
      );
      if (!row) throw new Error('Missing row');
      const checkout = join(root, 'a', 'worktrees', 'one');
      const identity = (path: string): string => {
        const info = lstatSync(path);
        return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      };
      const operationId = randomUUID();
      const record = {
        version: 1,
        operationId,
        operation: 'worktree-archive',
        workspaceId: 'a',
        worktreeId: 'one',
        createdAt: row.createdAt,
        state: 'recovery-required',
        directoryIdentity: identity(getWorkspaceDir('a')),
        steps: [{ phase: 'git-capture', state: 'failed' }],
        ownedPaths: [{ path: checkout, identity: identity(checkout) }],
      };
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      const oldRef = 'refs/app/archived-containers/a/one/__single_repo__';
      const oid = git('rev-parse', 'HEAD');
      git('update-ref', oldRef, oid);
      mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
      const copies = [
        `${createHash('sha256')
          .update(JSON.stringify(['a', 'one']))
          .digest('hex')}.json`,
        `${operationId}.json`,
      ];
      for (const copy of copies)
        writeFileSync(
          join(getW5DestructiveLifecycleDir(), copy),
          JSON.stringify(record),
        );
      const diagnosis = (
        await listWorktreeRecovery({ workspaceId: 'a', operationId })
      ).entries[0]?.diagnosis;
      expect(diagnosis?.verdict).toBe('keep-worktree');
      if (!diagnosis) throw new Error('Missing diagnosis');
      const { readArchiveJournalOperations } =
        await import('../stranded-archive-journals');
      const { inspectArchiveRecoveryRepositories } =
        await import('../archived-container-git');
      const operation = (
        await readArchiveJournalOperations('a')
      ).operations.find((entry) => entry.record.operationId === operationId);
      if (!operation) throw new Error('No operation');
      const store = archiveRecoveryStore();
      mkdirSync(store.stagingPath({ workspaceId: 'a', worktreeId: 'one' }), {
        recursive: true,
      });
      writeFileSync(
        join(
          store.stagingPath({ workspaceId: 'a', worktreeId: 'one' }),
          'unique',
        ),
        'retained',
      );
      const receipt = await store.prepare({
        workspaceId: 'a',
        worktreeId: 'one',
        operationId,
        action: 'keep-worktree',
        revision: diagnosis.revision,
        createdAt: row.createdAt,
        copies: operation.sources,
        sourceRecord: operation.record,
        repositories: await inspectArchiveRecoveryRepositories({
          workspaceId: 'a',
          containerId: 'one',
          workspaceType: 'single-repo',
        }),
        capture: 'unpublished',
      });
      const cancelled = await store.cancel(receipt);
      expect(
        await resolveWorktreeArchive({
          workspaceId: 'a',
          operationId,
          revision: diagnosis.revision,
          action: 'release',
        }),
      ).toMatchObject({ status: 'refused' });
      expect(await store.read('a', operationId)).toEqual(cancelled);
      expect(git('rev-parse', oldRef)).toBe(oid);
      git('worktree', 'remove', checkout);
      await workspacePersistence.removeWorkspaceWorktrees(
        'a',
        (entry) => entry.id === 'one',
      );
      const release = (
        await listWorktreeRecovery({ workspaceId: 'a', operationId })
      ).entries[0]?.diagnosis;
      expect(release?.verdict).toBe('release');
      if (!release) throw new Error('No release diagnosis');
      const request: WorktreeRecoveryResolveParams = {
        workspaceId: 'a',
        operationId,
        revision: release.revision,
        action: 'release',
      };
      if (interruption !== 'none') {
        const durability =
          await import('@canopy/execution-engine/node/lib/atomic-file');
        const original = durability.writeFileAtomically;
        const path = join(store.directory(cancelled), 'receipt.json');
        let injected = false;
        const publication = jest
          .spyOn(durability, 'writeFileAtomically')
          .mockImplementation(async (target, contents, options) => {
            if (target === path && !injected) {
              injected = true;
              if (interruption === 'after-publication')
                await original(target, contents, options);
              throw new Error('interrupted replacement');
            }
            return original(target, contents, options);
          });
        try {
          expect(await resolveWorktreeArchive(request)).toMatchObject({
            status:
              interruption === 'before-publication' ? 'refused' : 'interrupted',
          });
          expect(injected).toBe(true);
        } finally {
          publication.mockRestore();
        }
        const saved = await store.read('a', operationId);
        if (interruption === 'before-publication')
          expect(saved).toEqual(cancelled);
        else {
          expect(saved).toMatchObject({ action: 'release', stage: 'prepared' });
          expect(saved?.cancelled).toBeUndefined();
        }
        const { isArchiveRecoveryRefHeld } =
          await import('../archive-recovery-refs');
        expect(await isArchiveRecoveryRefHeld(repo, oldRef)).toBe(true);
        expect(git('rev-parse', oldRef)).toBe(oid);
        expect(
          readFileSync(join(store.stagingPath(cancelled), 'unique'), 'utf8'),
        ).toBe('retained');
        for (const copy of copies)
          expect(
            readFileSync(join(getW5DestructiveLifecycleDir(), copy), 'utf8'),
          ).toBe(JSON.stringify(record));
      }
      expect(await resolveWorktreeArchive(request)).toMatchObject({
        status: 'attempt-withdrawn',
      });
      expect((await store.read('a', operationId))?.action).toBe('release');
      expect(git('rev-parse', oldRef)).toBe(oid);
      expect(
        readFileSync(join(store.payloadPath(receipt), 'unique'), 'utf8'),
      ).toBe('retained');
    },
  );
  async function completedRecoveryHold(
    name = 'held',
    withRef = true,
  ): Promise<{
    store: ArchiveRecoveryStore;
    receipt: ArchiveRecoveryReceipt;
    deletion: WorktreeRecoveryResolveParams;
    git: (...args: string[]) => string;
    ref: string;
    oid: string;
    commonDir: string;
  }> {
    const { randomUUID } = await import('node:crypto');
    const { archiveRecoveryStore, archiveRecoveryRepositoryIdentity } =
      await import('../archive-recovery-refs');
    const store = archiveRecoveryStore();
    const operationId = randomUUID();
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const commonDir = git('rev-parse', '--absolute-git-dir');
    const ref = `refs/app/archived-containers/a/${name}/__single_repo__`;
    const oid = git('rev-parse', 'HEAD');
    if (withRef) git('update-ref', ref, oid);
    const record = {
      version: 1,
      operationId,
      operation: 'worktree-archive',
      workspaceId: 'a',
      worktreeId: name,
      createdAt: '2026-11-01T00:00:00.000Z',
      directoryIdentity: null,
      state: 'recovery-required',
      steps: [],
      ownedPaths: [],
    };
    const contents = JSON.stringify(record);
    const copy = {
      name: operationId + '.json',
      contents,
      digest: (await import('node:crypto'))
        .createHash('sha256')
        .update(contents)
        .digest('hex'),
    };
    mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
    writeFileSync(join(getW5DestructiveLifecycleDir(), copy.name), contents);
    const input = {
      workspaceId: 'a',
      worktreeId: name,
      operationId,
      action: 'release' as const,
      revision: 'a'.repeat(64),
      createdAt: record.createdAt,
      sourceRecord: record,
      copies: [copy],
      repositories: [
        {
          repoId: '__single_repo__',
          referenceRepoPath: repo,
          commonDir,
          identity: await archiveRecoveryRepositoryIdentity(commonDir),
          refs: withRef ? [{ name: ref, objectId: oid }] : [],
        },
      ],
      capture: 'unpublished' as const,
    };
    mkdirSync(store.stagingPath(input), { recursive: true });
    writeFileSync(join(store.stagingPath(input), 'unique'), 'retained');
    let receipt = await store.prepare(input);
    receipt = await store.publishRetention(receipt);
    receipt = await store.resetStaging(receipt);
    receipt = await store.withdrawJournals(receipt);
    receipt = await store.writeStage(receipt, 'completed');
    const deletion = {
      workspaceId: 'a',
      operationId,
      revision: input.revision,
      action: 'delete-hold' as const,
    };
    return { store, receipt, deletion, git, ref, oid, commonDir };
  }

  it.each([
    'retention-intent',
    'retained',
    'reset-intent',
    'staging-reset',
    'withdrawal-intent',
    'withdrawn',
    'completed',
  ] as const)(
    'settles from published evidence around every %s intent or acknowledgement',
    async (stage) => {
      for (const timing of ['before', 'after']) {
        const { store, receipt } = await completedRecoveryHold(
          `held-${timing}`,
        );
        const { renameSync } = await import('node:fs');
        renameSync(store.payloadPath(receipt), store.stagingPath(receipt));
        for (const copy of receipt.copies)
          renameSync(
            join(store.directory(receipt), 'journals', copy.name),
            join(getW5DestructiveLifecycleDir(), copy.name),
          );
        const prepared = { ...receipt, stage: 'prepared' as const };
        writeFileSync(
          join(store.directory(receipt), 'receipt.json'),
          JSON.stringify(prepared),
        );
        const { settleArchiveRecovery } =
          await import('../archive-recovery-settlement');
        const ports: ArchiveRecoverySettlementPorts = {
          store,
          admitResolution: jest.fn(async () => {}),
          admitDeletion: async () => {},
          qualifyRefs: async () => {},
          deleteRefs: async () => {},
          withdraw: (selected: typeof receipt) =>
            store.withdrawJournals(selected),
        };
        const original = store.writeStage.bind(store);
        let interrupted = false;
        const fault = jest
          .spyOn(store, 'writeStage')
          .mockImplementation(async (selected, target) => {
            if (target === stage && !interrupted && timing === 'before') {
              interrupted = true;
              throw new Error('before intent/ack');
            }
            const updated = await original(selected, target);
            if (target === stage && !interrupted && timing === 'after') {
              interrupted = true;
              throw new Error('after intent/ack');
            }
            return updated;
          });
        try {
          await expect(
            settleArchiveRecovery(prepared, 'resolve', ports),
          ).rejects.toThrow();
        } finally {
          fault.mockRestore();
        }
        const saved = await store.read('a', receipt.operationId);
        if (!saved) throw new Error('Missing recovery intent');
        const completed = await settleArchiveRecovery(saved, 'resolve', ports);
        expect(completed.stage).toBe('completed');
        expect((await store.inspect(completed)).copies).toEqual(['retired']);
        expect(
          readFileSync(join(store.payloadPath(completed), 'unique'), 'utf8'),
        ).toBe('retained');
        expect(
          await settleArchiveRecovery(completed, 'resolve', ports),
        ).toEqual(completed);
      }
    },
  );

  it('cancellation clears only the resolution fence, scopes same-slot fences, and preserves source-journal admission', async () => {
    const { store, receipt, git, ref, oid } = await completedRecoveryHold();
    const { assertNoArchiveResolution } =
      await import('../archive-recovery-refs');
    const { assertNoDestructiveRecovery } =
      await import('../w5-destructive-recovery');
    const { renameSync } = await import('node:fs');
    renameSync(store.payloadPath(receipt), store.stagingPath(receipt));
    const copy = receipt.copies[0];
    if (!copy) throw new Error('No source copy');
    renameSync(
      join(store.directory(receipt), 'journals', copy.name),
      join(getW5DestructiveLifecycleDir(), copy.name),
    );
    const retained = { ...receipt, stage: 'retained' as const };
    writeFileSync(
      join(store.directory(receipt), 'receipt.json'),
      JSON.stringify(retained),
    );
    await expect(assertNoArchiveResolution('a', 'held')).rejects.toThrow(
      receipt.operationId,
    );
    await expect(
      assertNoArchiveResolution('a', 'sibling'),
    ).resolves.toBeUndefined();
    await expect(assertNoArchiveResolution('a')).rejects.toThrow(
      receipt.operationId,
    );
    await (
      await import('../archived-container-git')
    ).qualifyArchiveRecoveryRefDeletion(retained);
    await store.cancel(retained);
    const { deleteArchivedContainerSnapshotRef } =
      await import('../archived-container-git');
    await deleteArchivedContainerSnapshotRef({
      repoPath: repo,
      refName: ref,
      expectedCommit: oid,
    });
    expect(git('rev-parse', ref)).toBe(oid);
    await expect(
      assertNoArchiveResolution('a', 'held'),
    ).resolves.toBeUndefined();
    await expect(assertNoArchiveResolution('a')).resolves.toBeUndefined();
    expect(
      readFileSync(join(getW5DestructiveLifecycleDir(), copy.name), 'utf8'),
    ).toBe(copy.contents);
    await expect(
      assertNoDestructiveRecovery('a', 'held'),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    writeFileSync(
      join(getW5DestructiveLifecycleDir(), copy.name),
      JSON.stringify({ ...receipt.sourceRecord, state: 'completed' }),
    );
    await deleteArchivedContainerSnapshotRef({
      repoPath: repo,
      refName: ref,
      expectedCommit: oid,
    });
    expect(git('for-each-ref', '--format=%(refname)', ref)).toBe('');
  });

  it.each([
    'missing-checkout',
    'zero-refs',
    'moved-ref',
    'changed-common-dir',
    'corrupt-co-owner',
    'lock-failure',
  ])(
    'delete-hold qualifies before intent and replays by common directory: %s',
    async (shape) => {
      const { store, receipt, deletion, git, ref, oid, commonDir } =
        await completedRecoveryHold('held', shape !== 'zero-refs');
      const { resolveWorktreeArchive } =
        await import('../worktree-archive-resolution');
      if (
        shape === 'missing-checkout' ||
        shape === 'zero-refs' ||
        shape === 'changed-common-dir'
      ) {
        const projected = {
          ...receipt,
          repositories: receipt.repositories.map((repository) => ({
            ...repository,
            referenceRepoPath: join(root, 'missing-checkout'),
            ...(shape === 'zero-refs'
              ? { commonDir: join(root, 'missing-git') }
              : {}),
            ...(shape === 'changed-common-dir'
              ? { identity: 'previous-incarnation' }
              : {}),
          })),
        };
        writeFileSync(
          join(store.directory(receipt), 'receipt.json'),
          JSON.stringify(projected),
        );
      }
      if (shape === 'moved-ref') {
        git(
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '--allow-empty',
          '-m',
          'moved',
        );
        git('update-ref', ref, git('rev-parse', 'HEAD'));
      }
      if (shape === 'corrupt-co-owner') {
        const coOwner = await completedRecoveryHold('held');
        writeFileSync(
          join(store.directory(coOwner.receipt), 'receipt.json'),
          JSON.stringify({
            ...coOwner.receipt,
            repositories: coOwner.receipt.repositories.map((repository) => ({
              ...repository,
              identity: 'replaced-co-owner',
            })),
          }),
        );
      }
      const lock = join(commonDir, ref + '.lock');
      if (shape === 'lock-failure') {
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(lock, 'locked');
      }
      const result = await resolveWorktreeArchive(deletion);
      if (
        shape === 'moved-ref' ||
        shape === 'changed-common-dir' ||
        shape === 'corrupt-co-owner'
      ) {
        expect(result).toMatchObject({ status: 'refused' });
        expect(
          (await store.read('a', receipt.operationId))?.retention,
        ).toBeUndefined();
        await expect(
          deleteWorkspace({
            workspaceId: 'a',
            source: 'shared_container_fork',
          }),
        ).resolves.toMatchObject({ removed: 'code' });
        expect(
          (await store.read('a', receipt.operationId))?.retention,
        ).not.toBe('deleted');
      } else if (shape === 'lock-failure') {
        expect(result).toMatchObject({ status: 'interrupted' });
        expect((await store.read('a', receipt.operationId))?.retention).toBe(
          'deleting',
        );
        expect(git('rev-parse', ref)).toBe(oid);
        rmSync(lock);
        expect(await resolveWorktreeArchive(deletion)).toMatchObject({
          status: 'hold-deleted',
        });
      } else expect(result).toMatchObject({ status: 'hold-deleted' });
    },
  );

  it('delete-hold preserves co-owners and resumes partial ref and payload deletion', async () => {
    const owner = await completedRecoveryHold('held-shared');
    const coOwner = await completedRecoveryHold('held-shared');
    const { resolveWorktreeArchive } =
      await import('../worktree-archive-resolution');
    expect(await resolveWorktreeArchive(owner.deletion)).toMatchObject({
      status: 'hold-deleted',
    });
    expect(owner.git('rev-parse', owner.ref)).toBe(owner.oid);
    const { qualifyArchiveRecoveryRefDeletion } =
      await import('../archived-container-git');
    await qualifyArchiveRecoveryRefDeletion(coOwner.receipt);
    const intent = await coOwner.store.beginDeletion(coOwner.receipt);
    coOwner.git('update-ref', '-d', coOwner.ref, coOwner.oid);
    rmSync(join(coOwner.store.payloadPath(intent), 'unique'));
    expect(await resolveWorktreeArchive(coOwner.deletion)).toMatchObject({
      status: 'hold-deleted',
    });
    expect(owner.git('for-each-ref', '--format=%(refname)', owner.ref)).toBe(
      '',
    );
    expect(existsSync(coOwner.store.payloadPath(intent))).toBe(false);
  });

  it('completed-hold handoff survives committed parent removal and cleanup acknowledgement loss for multiple holds', async () => {
    const first = await completedRecoveryHold('held-one');
    const second = await completedRecoveryHold('held-two');
    const { ArchiveRecoveryStore } =
      await import('@canopy/desktop-shared/node/archive-recovery-store');
    const original = jest.spyOn(
      ArchiveRecoveryStore.prototype,
      'deletePayload',
    );
    const deletePayload = original.getMockImplementation();
    if (!deletePayload)
      throw new Error('Missing payload deletion implementation');
    const fault = original.mockImplementationOnce(async function (
      this: InstanceType<typeof ArchiveRecoveryStore>,
      receipt,
    ) {
      await deletePayload.call(this, receipt);
      throw new Error('lost tombstone acknowledgement');
    });
    try {
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).resolves.toMatchObject({ removed: 'code' });
    } finally {
      fault.mockRestore();
    }
    expect(existsSync(join(getWorkspaceDir('a'), 'workspace.json'))).toBe(
      false,
    );
    const parent = await readDestructiveRecovery('a');
    if (!parent) throw new Error('No durable cleanup handoff');
    expect(parent.archiveRecoveryCleanup).toHaveLength(2);
    expect(parent.archiveRecoveryCleanup?.every((entry) => entry.done)).toBe(
      false,
    );
    const { settleWorkspaceArchiveRecoveryCleanup } =
      await import('../workspace-deletion');
    await settleWorkspaceArchiveRecoveryCleanup(parent);
    await settleWorkspaceArchiveRecoveryCleanup(parent);
    for (const hold of [first, second]) {
      expect(
        (await hold.store.read('a', hold.receipt.operationId))?.retention,
      ).toBe('deleted');
      expect(hold.git('for-each-ref', '--format=%(refname)', hold.ref)).toBe(
        '',
      );
    }
    expect(
      (await readDestructiveRecovery('a'))?.archiveRecoveryCleanup?.every(
        (entry) => entry.done,
      ),
    ).toBe(true);
    expect((await readDestructiveRecovery('a'))?.cleanupRequired).toBe(false);
  });

  it('parent cleanup settles independent holds despite a conflicting earlier member', async () => {
    const holds = [
      await completedRecoveryHold('held-first'),
      await completedRecoveryHold('held-second'),
    ].sort((a, b) =>
      a.receipt.operationId.localeCompare(b.receipt.operationId),
    );
    const [conflict, safe] = holds;
    if (!conflict || !safe) throw new Error('Missing holds');
    writeFileSync(
      join(conflict.store.directory(conflict.receipt), 'receipt.json'),
      JSON.stringify({
        ...conflict.receipt,
        repositories: conflict.receipt.repositories.map((repo) => ({
          ...repo,
          identity: 'replaced',
        })),
      }),
    );
    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
    ).resolves.toMatchObject({ removed: 'code' });
    expect(
      (await safe.store.read('a', safe.receipt.operationId))?.retention,
    ).toBe('deleted');
    expect(
      (await conflict.store.read('a', conflict.receipt.operationId))?.retention,
    ).toBeUndefined();
    expect((await readDestructiveRecovery('a'))?.cleanupRequired).toBe(true);
  });

  it('replays parent cleanup after interruption between redundant cleanup acknowledgements', async () => {
    const hold = await completedRecoveryHold();
    const { ArchiveRecoveryStore } =
      await import('@canopy/desktop-shared/node/archive-recovery-store');
    const pause = jest
      .spyOn(ArchiveRecoveryStore.prototype, 'deletePayload')
      .mockRejectedValueOnce(new Error('cleanup paused'));
    try {
      await deleteWorkspace({
        workspaceId: 'a',
        source: 'shared_container_fork',
      });
    } finally {
      pause.mockRestore();
    }
    const parent = await readDestructiveRecovery('a');
    if (!parent) throw new Error('No parent');
    const duplicate = join(
      getW5DestructiveLifecycleDir(),
      parent.operationId + '.json',
    );
    writeFileSync(duplicate, JSON.stringify(parent));
    const atomic =
      await import('@canopy/execution-engine/node/lib/atomic-file');
    const write = atomic.writeFileAtomically;
    let injected = false;
    const fault = jest
      .spyOn(atomic, 'writeFileAtomically')
      .mockImplementation(async (path, data, options) => {
        await write(path, data, options);
        if (
          !injected &&
          dirname(path) === getW5DestructiveLifecycleDir() &&
          String(data).includes('"done":true')
        ) {
          injected = true;
          throw new Error('lost redundant acknowledgement');
        }
      });
    const { settleWorkspaceArchiveRecoveryCleanup } =
      await import('../workspace-deletion');
    try {
      await expect(
        settleWorkspaceArchiveRecoveryCleanup(parent),
      ).rejects.toMatchObject({
        failures: [
          {
            operationId: hold.receipt.operationId,
            error: new Error('lost redundant acknowledgement'),
          },
        ],
      });
    } finally {
      fault.mockRestore();
    }
    expect(injected).toBe(true);
    await settleWorkspaceArchiveRecoveryCleanup(parent);
    await settleWorkspaceArchiveRecoveryCleanup(parent);
    expect(
      (await hold.store.read('a', hold.receipt.operationId))?.retention,
    ).toBe('deleted');
    const { readdirSync } = await import('node:fs');
    for (const name of readdirSync(getW5DestructiveLifecycleDir()).map((name) =>
      join(getW5DestructiveLifecycleDir(), name),
    )) {
      const record = journalSchema.parse(
        JSON.parse(readFileSync(name, 'utf8')),
      );
      if (record.operationId === parent.operationId)
        expect(
          record.archiveRecoveryCleanup?.every((member) => member.done),
        ).toBe(true);
    }
  });

  it.each([
    { state: 'recovery-required', pending: false, cleanupRequired: false },
    { state: 'recovery-required', pending: true, cleanupRequired: false },
    { state: 'completed', pending: false, cleanupRequired: false },
    { state: 'completed', pending: false, cleanupRequired: true },
  ])(
    'new resolution diagnosis uses authoritative parent pending classification: $state, pending=$pending, cleanup=$cleanupRequired',
    async ({ state, pending, cleanupRequired }) => {
      const { store, receipt, git, ref, oid } = await completedRecoveryHold();
      const { renameSync } = await import('node:fs');
      const { randomUUID } = await import('node:crypto');
      const { readDirectoryStatIdentity, readBlockingDestructiveRecoveries } =
        await import('../w5-destructive-recovery');
      const identity = await readDirectoryStatIdentity(getWorkspaceDir('a'));
      const source = { ...receipt.sourceRecord, directoryIdentity: identity };
      renameSync(store.payloadPath(receipt), store.stagingPath(receipt));
      for (const copy of receipt.copies)
        writeFileSync(
          join(getW5DestructiveLifecycleDir(), copy.name),
          JSON.stringify(source),
        );
      rmSync(store.directory(receipt), { recursive: true });
      const parentId = randomUUID();
      writeFileSync(
        join(getW5DestructiveLifecycleDir(), parentId + '.json'),
        JSON.stringify({
          version: 1,
          operationId: parentId,
          operation: 'workspace-delete',
          workspaceId: 'a',
          state,
          cleanupRequired,
          directoryIdentity: identity,
          ownedPaths: [],
          steps: pending
            ? [{ phase: 'workspace-directory-removal', state: 'pending' }]
            : [],
        }),
      );
      expect(
        (await readBlockingDestructiveRecoveries('a')).some(
          (record) => record.operationId === parentId,
        ),
      ).toBe(pending);
      const { listWorktreeRecovery, describeWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const diagnosis = (
        await listWorktreeRecovery({
          workspaceId: 'a',
          operationId: receipt.operationId,
        })
      ).entries[0]?.diagnosis;
      expect(diagnosis?.verdict).toBe(pending ? 'refused' : 'release');
      if (!diagnosis) throw new Error('No diagnosis');
      const standalone = await describeWorktreeRecovery(
        {
          workspaceId: 'a',
          worktreeId: receipt.worktreeId,
          expectedCreatedAt: receipt.createdAt,
          intent: 'archive',
          operationId: receipt.operationId,
        },
        undefined,
      );
      expect(standalone.diagnosis?.verdict).toBe(diagnosis.verdict);
      const { resolveWorktreeArchive } =
        await import('../worktree-archive-resolution');
      if (!pending) {
        // A refresh's cached offer must not admit writes after a blocker appears.
        const path = join(getW5DestructiveLifecycleDir(), parentId + '.json');
        const original = readFileSync(path, 'utf8');
        const parent = journalSchema.parse(JSON.parse(original));
        writeFileSync(
          path,
          JSON.stringify({
            ...parent,
            state: 'recovery-required',
            steps: [{ phase: 'workspace-directory-removal', state: 'pending' }],
          }),
        );
        expect(
          await resolveWorktreeArchive({
            workspaceId: 'a',
            operationId: receipt.operationId,
            revision: diagnosis.revision,
            action: 'release',
          }),
        ).toMatchObject({ status: 'refused' });
        expect(await store.read('a', receipt.operationId)).toBeNull();
        for (const copy of receipt.copies)
          expect(
            readFileSync(
              join(getW5DestructiveLifecycleDir(), copy.name),
              'utf8',
            ),
          ).toBe(JSON.stringify(source));
        expect(git('rev-parse', ref)).toBe(oid);
        writeFileSync(path, original);
      }
      expect(
        await resolveWorktreeArchive({
          workspaceId: 'a',
          operationId: receipt.operationId,
          revision: diagnosis.revision,
          action: 'release',
        }),
      ).toMatchObject({ status: pending ? 'refused' : 'attempt-withdrawn' });
      expect(git('rev-parse', ref)).toBe(oid);
    },
  );

  it.each(['before', 'after'] as const)(
    'adopted hold preserves or settles across canonical-removal %s effect',
    async (timing) => {
      const hold = await completedRecoveryHold();
      const atomic =
        await import('@canopy/execution-engine/node/lib/atomic-file');
      const original = atomic.writeFileAtomically;
      let injected = false;
      const fault = jest
        .spyOn(atomic, 'writeFileAtomically')
        .mockImplementation(async (path, data, options) => {
          const record =
            dirname(path) === getW5DestructiveLifecycleDir()
              ? journalSchema.safeParse(JSON.parse(String(data)))
              : null;
          const removal = record?.success
            ? record.data.steps.find(
                (step) => step.phase === 'canonical-index-removal',
              )
            : null;
          const hit =
            !injected &&
            removal?.state === (timing === 'before' ? 'pending' : 'done');
          if (hit && timing === 'before') {
            injected = true;
            throw new Error('canonical fault');
          }
          await original(path, data, options);
          if (hit) {
            injected = true;
            throw new Error('canonical fault');
          }
        });
      try {
        await expect(
          deleteWorkspace({
            workspaceId: 'a',
            source: 'shared_container_fork',
          }),
        ).rejects.toThrow();
      } finally {
        fault.mockRestore();
      }
      expect(injected).toBe(true);
      const parent = await readDestructiveRecovery('a');
      if (!parent) throw new Error('No handoff');
      const { settleWorkspaceArchiveRecoveryCleanup } =
        await import('../workspace-deletion');
      await settleWorkspaceArchiveRecoveryCleanup(parent);
      await settleWorkspaceArchiveRecoveryCleanup(parent);
      const saved = await hold.store.read('a', hold.receipt.operationId);
      expect(saved?.retention).toBe(
        timing === 'before' ? undefined : 'deleted',
      );
      expect(indexIds().includes('a')).toBe(timing === 'before');
      if (timing === 'before')
        expect(hold.git('rev-parse', hold.ref)).toBe(hold.oid);
    },
  );

  it('terminal receipt acknowledgement and tombstone replay need no original project resources', async () => {
    const { store, receipt, deletion } = await completedRecoveryHold();
    const { settleArchiveRecovery } =
      await import('../archive-recovery-settlement');
    const impossible = jest.fn(() => {
      throw new Error('obsolete admission');
    });
    const ports = {
      store,
      admitResolution: impossible,
      admitDeletion: impossible,
      qualifyRefs: impossible,
      deleteRefs: impossible,
      withdraw: impossible,
    };
    const withdrawn = { ...receipt, stage: 'withdrawn' as const };
    writeFileSync(
      join(store.directory(receipt), 'receipt.json'),
      JSON.stringify(withdrawn),
    );
    rmSync(store.payloadPath(receipt), { recursive: true });
    expect(
      (await settleArchiveRecovery(withdrawn, 'resolve', ports)).stage,
    ).toBe('completed');
    const deleted = { ...receipt, retention: 'deleted' as const };
    writeFileSync(
      join(store.directory(receipt), 'receipt.json'),
      JSON.stringify(deleted),
    );
    const { resolveWorktreeArchive } =
      await import('../worktree-archive-resolution');
    mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
    writeFileSync(join(getW5DestructiveLifecycleDir(), 'bad.json'), '{bad');
    expect(await resolveWorktreeArchive(deletion)).toMatchObject({
      status: 'hold-deleted',
    });
    expect(impossible).not.toHaveBeenCalled();
  });

  it('project deletion discards completed holds after commit without a new fence', async () => {
    const { randomUUID, createHash } = await import('node:crypto');
    const { archiveRecoveryStore, archiveRecoveryRepositoryIdentity } =
      await import('../archive-recovery-refs');
    const store = archiveRecoveryStore();
    const operationId = randomUUID();
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const oid = git('rev-parse', 'HEAD');
    const ref = 'refs/app/archived-containers/a/held/__single_repo__';
    git('update-ref', ref, oid);
    const commonDir = git('rev-parse', '--absolute-git-dir');
    const record = {
      version: 1,
      operationId,
      operation: 'worktree-archive',
      workspaceId: 'a',
      worktreeId: 'held',
      createdAt: '2026-11-01T00:00:00.000Z',
      directoryIdentity: null,
      state: 'recovery-required',
      steps: [],
      ownedPaths: [],
    };
    const contents = JSON.stringify(record);
    const copy = {
      name: operationId + '.json',
      contents,
      digest: createHash('sha256').update(contents).digest('hex'),
    };
    mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
    writeFileSync(join(getW5DestructiveLifecycleDir(), copy.name), contents);
    const input = {
      workspaceId: 'a',
      worktreeId: 'held',
      operationId,
      action: 'release' as const,
      revision: 'a'.repeat(64),
      createdAt: record.createdAt,
      sourceRecord: record,
      copies: [copy],
      repositories: [
        {
          repoId: '__single_repo__',
          referenceRepoPath: repo,
          commonDir,
          identity: await archiveRecoveryRepositoryIdentity(commonDir),
          refs: [{ name: ref, objectId: oid }],
        },
      ],
      capture: 'unpublished' as const,
    };
    mkdirSync(store.stagingPath(input), { recursive: true });
    writeFileSync(join(store.stagingPath(input), 'unique'), 'retained');
    let receipt = await store.prepare(input);
    receipt = await store.publishRetention(receipt);
    receipt = await store.resetStaging(receipt);
    receipt = await store.withdrawJournals(receipt);
    receipt = await store.writeStage(receipt, 'completed');
    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
    ).resolves.toMatchObject({ removed: 'code' });
    expect((await store.read('a', operationId))?.retention).toBe('deleted');
    expect(existsSync(store.payloadPath(receipt))).toBe(false);
    expect(git('for-each-ref', '--format=%(refname)', ref)).toBe('');
  });

  describe('CAN-7013 unverifiable migrated archive', () => {
    const A1_STEPS = [
      { phase: 'teardown-script', state: 'done' },
      { phase: 'live-state-teardown', state: 'done' },
      { phase: 'retained-payload-capture', state: 'failed' },
    ];
    async function strandUnverifiable(
      steps: unknown[] = A1_STEPS,
      replaced?: 'project' | 'data-dir' | 'verified-project',
    ): Promise<Awaited<ReturnType<typeof completedRecoveryHold>>> {
      const hold = await completedRecoveryHold();
      const { renameSync } = await import('node:fs');
      const { readDirectoryStatIdentity, lifecycleJournalSlotName } =
        await import('../w5-destructive-recovery');
      const { getWorkspaceWorktreeDir, getWorktreeDataDir } =
        await import('../paths');
      const identity = await readDirectoryStatIdentity(getWorkspaceDir('a'));
      // As migrated: project, gone checkout and present data dir are all unverifiable.
      const metadata = getWorktreeDataDir('a', 'held');
      mkdirSync(metadata, { recursive: true });
      const source = {
        ...hold.receipt.sourceRecord,
        // A verified identity that no longer matches is a replaced path, not a migrated one.
        directoryIdentity:
          replaced === 'project'
            ? '1:2:3'
            : replaced === 'verified-project'
              ? identity
              : `unverifiable:${identity}`,
        steps,
        ownedPaths: [
          {
            path: getWorkspaceWorktreeDir('a', 'held'),
            identity: 'unverifiable:1:2:3',
          },
          {
            path: metadata,
            identity:
              replaced === 'data-dir'
                ? '1:2:3'
                : `unverifiable:${await readDirectoryStatIdentity(metadata)}`,
          },
        ],
      };
      renameSync(
        hold.store.payloadPath(hold.receipt),
        hold.store.stagingPath(hold.receipt),
      );
      for (const copy of hold.receipt.copies)
        writeFileSync(
          join(getW5DestructiveLifecycleDir(), copy.name),
          JSON.stringify(source),
        );
      writeFileSync(
        join(
          getW5DestructiveLifecycleDir(),
          lifecycleJournalSlotName('a', 'held'),
        ),
        JSON.stringify(source),
      );
      rmSync(hold.store.directory(hold.receipt), { recursive: true });
      return hold;
    }
    async function diagnose(
      operationId: string,
    ): Promise<NonNullable<WorktreeRecoveryDescription['diagnosis']>> {
      const { listWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const diagnosis = (
        await listWorktreeRecovery({ workspaceId: 'a', operationId })
      ).entries[0]?.diagnosis;
      if (!diagnosis) throw new Error('No diagnosis');
      return diagnosis;
    }

    async function publishCapture(
      shape: 'manifest' | 'git-staging',
      receipt: ArchiveRecoveryReceipt,
    ): Promise<void> {
      const {
        getArchivedContainerManifestPath,
        getArchivedContainerGitStateStagedPath,
      } = await import('../paths');
      if (shape === 'manifest')
        writeFileSync(
          getArchivedContainerManifestPath('a', 'held'),
          JSON.stringify({
            version: 3,
            kind: 'worktree',
            id: 'held',
            projectId: 'a',
            name: 'Archive',
            createdAt: receipt.createdAt,
            archivedAt: receipt.createdAt,
            retentionDays: 30,
            expiresAt: '2026-12-01T00:00:00.000Z',
            chatCount: 0,
            archivedChatCount: 0,
            executionCount: 0,
            workspaceType: 'single-repo',
            originalWorktree: {
              id: 'held',
              branchName: 'feature/x',
              createdAt: receipt.createdAt,
            },
            recovery: {
              kind: 'files-only',
              source: 'absent',
              digest: '0'.repeat(64),
              payloadId: receipt.operationId,
            },
          }),
        );
      else
        writeFileSync(
          getArchivedContainerGitStateStagedPath('a', 'held'),
          JSON.stringify({ version: 1, status: 'capturing', repositories: [] }),
        );
    }

    it.each([
      ['A1 failed payload capture', A1_STEPS],
      ['no steps', []],
    ])(
      'releases an unlisted pre-Git-capture archive (%s); delete-hold re-qualifies on its own',
      async (_name, steps) => {
        const { receipt, store, git, ref, oid } =
          await strandUnverifiable(steps);
        const diagnosis = await diagnose(receipt.operationId);
        expect(diagnosis).toMatchObject({
          verdict: 'release',
          check: 'pre-quarantine-row-and-checkout-absent',
        });
        expect(await offeredActions(receipt.operationId)).toEqual(['release']);
        const { resolveWorktreeArchive } =
          await import('../worktree-archive-resolution');
        expect(
          await resolveWorktreeArchive({
            workspaceId: 'a',
            operationId: receipt.operationId,
            revision: diagnosis.revision,
            action: 'release',
          }),
        ).toMatchObject({ status: 'attempt-withdrawn' });
        expect(git('rev-parse', ref)).toBe(oid);
        const held = await store.read('a', receipt.operationId);
        if (!held) throw new Error('No hold');
        expect(
          readFileSync(join(store.payloadPath(held), 'unique'), 'utf8'),
        ).toBe('retained');
        expect(
          await resolveWorktreeArchive({
            workspaceId: 'a',
            operationId: receipt.operationId,
            revision: held.revision,
            action: 'delete-hold',
          }),
        ).toMatchObject({ status: 'hold-deleted' });
        expect(git('for-each-ref', '--format=%(refname)', ref)).toBe('');
        expect(existsSync(store.payloadPath(held))).toBe(false);
      },
    );

    it.each([
      'git-capture-step',
      'checkout',
      'quarantine',
      'manifest',
      'git-staging',
      'replaced-verified-project',
      'replaced-verified-data-dir',
      // The data-dir exemption is only for an unverifiable project.
      'verified-project-unverifiable-data-dir',
    ] as const)('keeps refusing Release when %s', async (shape) => {
      const { receipt, git, ref, oid, store } = await strandUnverifiable(
        shape === 'git-capture-step'
          ? [...A1_STEPS, { phase: 'git-capture', state: 'pending' }]
          : A1_STEPS,
        shape === 'replaced-verified-project'
          ? 'project'
          : shape === 'replaced-verified-data-dir'
            ? 'data-dir'
            : shape === 'verified-project-unverifiable-data-dir'
              ? 'verified-project'
              : undefined,
      );
      const { getWorkspaceWorktreeDir } = await import('../paths');
      const checkout = getWorkspaceWorktreeDir('a', 'held');
      if (shape === 'checkout') mkdirSync(checkout, { recursive: true });
      if (shape === 'quarantine')
        mkdirSync(join(dirname(checkout), '.held.archive-quarantine'), {
          recursive: true,
        });
      if (shape === 'manifest' || shape === 'git-staging')
        await publishCapture(shape, receipt);
      const diagnosis = await diagnose(receipt.operationId);
      expect(diagnosis).toMatchObject({
        verdict: 'refused',
        check: 'identity-unverified',
      });
      // q-31 a: these same-kind two-copy variants are excluded until CAN-7284.
      expect(
        await offeredActions(receipt.operationId, [
          { copies: 2, check: 'identity-unverified' },
        ]),
      ).toEqual([]);
      const { resolveWorktreeArchive } =
        await import('../worktree-archive-resolution');
      expect(
        await resolveWorktreeArchive({
          workspaceId: 'a',
          operationId: receipt.operationId,
          revision: diagnosis.revision,
          action: 'release',
        }),
      ).toMatchObject({ status: 'refused' });
      expect(await store.read('a', receipt.operationId)).toBeNull();
      expect(git('rev-parse', ref)).toBe(oid);
    });

    it.each(['manifest', 'git-staging'] as const)(
      'a resumed Release re-admits capture absence before its retention intent (%s)',
      async (shape) => {
        const { receipt, store, git, ref, oid } = await strandUnverifiable();
        const diagnosis = await diagnose(receipt.operationId);
        expect(diagnosis.verdict).toBe('release');
        const { readArchiveJournalOperations } =
          await import('../stranded-archive-journals');
        const { inspectArchiveRecoveryRepositories } =
          await import('../archived-container-git');
        const operation = (
          await readArchiveJournalOperations('a')
        ).operations.find(
          (entry) => entry.record.operationId === receipt.operationId,
        );
        if (!operation) throw new Error('No source journal');
        // An interrupted Release leaves this receipt; resumption skips the diagnosis.
        await store.prepare({
          workspaceId: 'a',
          worktreeId: 'held',
          operationId: receipt.operationId,
          action: 'release',
          revision: diagnosis.revision,
          createdAt: receipt.createdAt,
          copies: operation.sources,
          sourceRecord: operation.record,
          repositories: await inspectArchiveRecoveryRepositories({
            workspaceId: 'a',
            containerId: 'held',
            workspaceType: 'single-repo',
          }),
          capture: 'unpublished',
        });
        await publishCapture(shape, receipt);
        const { resolveWorktreeArchive } =
          await import('../worktree-archive-resolution');
        expect(
          await resolveWorktreeArchive({
            workspaceId: 'a',
            operationId: receipt.operationId,
            revision: diagnosis.revision,
            action: 'release',
          }),
        ).toMatchObject({ status: 'refused' });
        expect((await store.read('a', receipt.operationId))?.stage).toBe(
          'prepared',
        );
        expect(
          readFileSync(join(store.stagingPath(receipt), 'unique'), 'utf8'),
        ).toBe('retained');
        expect(git('rev-parse', ref)).toBe(oid);
      },
    );

    it('delete-hold refuses a retained ref outside its archive namespace', async () => {
      const { store, receipt, git, oid } = await completedRecoveryHold();
      const foreign = 'refs/app/archived-containers/a/other/__single_repo__';
      git('update-ref', foreign, oid);
      const tampered = {
        ...receipt,
        repositories: receipt.repositories.map((repository) => ({
          ...repository,
          refs: [{ name: foreign, objectId: oid }],
        })),
      };
      writeFileSync(
        join(store.directory(receipt), 'receipt.json'),
        JSON.stringify(tampered),
      );
      const { resolveWorktreeArchive } =
        await import('../worktree-archive-resolution');
      expect(
        await resolveWorktreeArchive({
          workspaceId: 'a',
          operationId: receipt.operationId,
          revision: receipt.revision,
          action: 'delete-hold',
        }),
      ).toMatchObject({ status: 'refused' });
      expect(git('rev-parse', foreign)).toBe(oid);
      expect((await store.read('a', receipt.operationId))?.retention).toBe(
        undefined,
      );
    });
  });

  // CAN-7014: what the shared dialog offers, on a host that has every action.
  const RECOVERY_HOST = { canResolve: true, canSetAside: true } as const;
  const RECOVERY_USER: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'archive-recovery-golden',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['core.worktree.read', 'core.worktree.write'],
  };

  function recoveryRuntime(): CanopyDispatcher<
    typeof CORE_WORKTREE_RECOVERY_QUERIES,
    Pick<
      typeof CORE_WORKTREE_RECOVERY_INSTRUCTIONS,
      'core.worktree.recovery.setAside'
    >,
    Record<never, never>
  > {
    const adapter = createCoreWorktreeRecoveryAdapter();
    const list = adapter.queries?.['core.worktree.recovery.list'];
    const setAside = adapter.instructions?.['core.worktree.recovery.setAside'];
    if (!list || !setAside)
      throw new Error('Recovery adapter is not installed');
    return createCanopyDispatcher({
      profile: 'core',
      definitions: {
        queries: CORE_WORKTREE_RECOVERY_QUERIES,
        instructions: {
          'core.worktree.recovery.setAside':
            CORE_WORKTREE_RECOVERY_INSTRUCTIONS[
              'core.worktree.recovery.setAside'
            ],
        },
        streams: {},
      },
      handlers: {
        queries: { 'core.worktree.recovery.list': list },
        instructions: { 'core.worktree.recovery.setAside': setAside },
        streams: {},
      },
    });
  }

  async function assertOfferedActionsAdmitted(
    entry: WorktreeRecoveryDescription,
  ): Promise<void> {
    const actions = worktreeRecoveryOfferedActions(entry, RECOVERY_HOST);
    const { readArchiveJournalOperations } =
      await import('../stranded-archive-journals');
    const scan = await readArchiveJournalOperations('a');
    const operation = scan.operations.find(
      (candidate) =>
        candidate.record.operationId === entry.diagnosis?.operationId,
    );
    if (!operation || !entry.diagnosis || !operation.record.worktreeId)
      throw new Error('No exact action admission target');
    const worktreeId = operation.record.worktreeId;
    const { assertNoArchiveResolution } =
      await import('../archive-recovery-refs');
    // Run the writers' read-only admission, not a second assertion of their offers.
    for (const action of actions) {
      switch (action) {
        case 'keep-worktree':
        case 'release': {
          const { archiveRecoveryStore } =
            await import('../archive-recovery-refs');
          const { readArchiveResolutionPreparation } =
            await import('../worktree-archive-resolution-admission');
          await archiveRecoveryStore().assertWorkspaceNormalizable('a');
          await readArchiveResolutionPreparation(operation, action);
          break;
        }
        case 'finish': {
          await assertNoArchiveResolution('a', worktreeId);
          const { readAdmittedFinishOperation } =
            await import('../worktree-recovery-finish');
          await readAdmittedFinishOperation({
            workspaceId: 'a',
            operationId: operation.record.operationId,
            revision: entry.diagnosis.revision,
          });
          break;
        }
        case 'retry': {
          await assertNoArchiveResolution('a', worktreeId);
          const {
            canAdmitInterruptedArchive,
            readBlockingDestructiveRecoveries,
            readDestructiveRecovery,
          } = await import('../w5-destructive-recovery');
          const { findWorktreeArchiveSourceRefusal } =
            await import('../worktree-service');
          const { assertWorktreeRemovalAdmitted } =
            await import('../worktree-discard-admission');
          assertWorktreeRemovalAdmitted(
            'a',
            worktreeId,
            'archiving the worktree',
          );
          if (!operation.record.createdAt) throw new Error('No incarnation');
          const config =
            await workspacePersistence.readWorkspaceConfigDetailed('a');
          if (config.authority !== 'ok' || config.config.type === 'cowork')
            throw new Error('No archive source configuration');
          expect(
            await findWorktreeArchiveSourceRefusal(
              'a',
              [worktreeId],
              config.config.type,
            ),
          ).toBeUndefined();
          expect(await readDestructiveRecovery('a', worktreeId)).toEqual(
            operation.record,
          );
          expect(
            (
              await readBlockingDestructiveRecoveries('a', worktreeId, true)
            ).filter(
              (record) => record.operationId !== operation.record.operationId,
            ),
          ).toEqual([]);
          expect(
            await canAdmitInterruptedArchive(operation.record, {
              operation: 'worktree-archive',
              worktreeId,
              createdAt: operation.record.createdAt,
            }),
          ).toBe(true);
          break;
        }
        case 'discard': {
          await assertNoArchiveResolution('a', worktreeId);
          const { describeWorktreeDiscard } =
            await import('../worktree-discard');
          const { assertWorktreeDiscardAdmitted } =
            await import('../worktree-discard-admission');
          assertWorktreeDiscardAdmitted('a', worktreeId);
          expect(
            await describeWorktreeDiscard('a', worktreeId, {
              includeRecoveryDiagnosis: false,
              recovery: {
                intent: 'archive',
                expectedCreatedAt: operation.record.createdAt ?? null,
                operationId: operation.record.operationId,
              },
            }),
          ).toMatchObject({ status: 'discardable' });
          break;
        }
        case 'set-aside': {
          const { setAsideAction } =
            await import('../worktree-recovery-description');
          expect(
            await setAsideAction(
              { workspaceId: 'a', worktreeId },
              operation,
              scan.operations,
            ),
          ).toEqual({ eligible: true });
          break;
        }
      }
    }
  }

  /** Exercises the query adapter and checks each offered action's writer admission. */
  async function offeredActions(
    operationId: string,
    buttonlessMultiCopyExceptions: readonly {
      copies: number;
      check: string;
    }[] = [],
  ): Promise<WorktreeRecoveryOfferedAction[]> {
    const runtime = recoveryRuntime();
    const listed = await runtime
      .query(
        'core.worktree.recovery.list',
        { workspaceId: 'a' },
        { caller: RECOVERY_USER },
      )
      .finally(() => runtime.shutdown());
    expect(listed.check).toBe('ok');
    // q-31 a / CAN-7284: list each multi-copy exception; any new buttonless
    // shape, including a single-copy entry, still fails this invariant.
    expect(
      listed.entries
        .filter(
          (entry) =>
            worktreeRecoveryOfferedActions(entry, RECOVERY_HOST).length === 0,
        )
        .map((entry) => ({
          copies: entry.diagnosis?.copies ?? 0,
          check: entry.diagnosis?.check ?? entry.check,
        })),
    ).toEqual(buttonlessMultiCopyExceptions);
    expect(
      buttonlessMultiCopyExceptions.every((entry) => entry.copies > 1),
    ).toBe(true);
    for (const entry of listed.entries)
      await assertOfferedActionsAdmitted(entry);
    const entry = listed.entries.find(
      (candidate) => candidate.diagnosis?.operationId === operationId,
    );
    if (!entry) throw new Error('The seeded record is not listed');
    return worktreeRecoveryOfferedActions(entry, RECOVERY_HOST);
  }

  describe('CAN-7014 every single-copy archive recovery entry offers a button (multi-copy exclusions: CAN-7284)', () => {
    const statIdentity = (path: string): string => {
      const info = lstatSync(path);
      return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    };
    const drifted = (identity: string): string => {
      const [device, ...rest] = identity.split(':');
      return [String(Number(device) + 1), ...rest].join(':');
    };
    const checkout = (): string => join(root, 'a', 'worktrees', 'one');
    const PRE_GIT_CAPTURE = [
      { phase: 'teardown-script', state: 'done' },
      { phase: 'live-state-teardown', state: 'done' },
      { phase: 'retained-payload-capture', state: 'failed' },
    ];
    // worktreeRecoveryFixture.mjs's default: no owned paths, failed Git capture.
    const SEEDER_DEFAULT_STEPS = [
      { phase: 'live-state-teardown', state: 'done' },
      { phase: 'retained-payload-capture', state: 'done' },
      { phase: 'git-capture', state: 'failed' },
    ];
    const SET_ASIDE_STEPS = [
      ...SEEDER_DEFAULT_STEPS.slice(0, 2),
      { phase: 'git-capture', state: 'done' },
      { phase: 'checkout-quarantine', state: 'done' },
      { phase: 'git-worktree-removal', state: 'failed' },
    ];

    function retentionManifest(
      containerId: string,
      oid: string,
    ): Extract<ArchivedContainerManifest, { version: 2 }> {
      const manifest = archivedManifest('a', containerId);
      manifest.gitState.repositories.push({
        repoId: '__single_repo__',
        repoName: 'repo',
        relativePath: '.',
        referenceRepoPath: repo,
        comparisonBaseCommit: oid,
        headCommit: oid,
        indexSnapshotCommit: oid,
        worktreeSnapshotCommit: oid,
        snapshotRef: `refs/app/archived-containers/a/${containerId}/__single_repo__`,
      });
      if (
        manifest.gitChanges.status !== 'complete' ||
        !manifest.pullRequestMetadata
      )
        throw new Error('Missing capture metadata');
      manifest.gitChanges.repositories.push({
        repoId: '__single_repo__',
        repoName: 'repo',
        fileCount: 0,
        insertions: 0,
        deletions: 0,
      });
      manifest.pullRequestMetadata.repositories.push({
        repoId: '__single_repo__',
        repoName: 'repo',
        status: 'complete',
        pullRequest: null,
      });
      return manifest;
    }

    async function strand(
      overrides: Record<string, unknown> = {},
    ): Promise<{ operationId: string; copies: Map<string, string> }> {
      const { randomUUID } = await import('node:crypto');
      const { lifecycleJournalSlotName } =
        await import('../w5-destructive-recovery');
      const row = (await workspacePersistence.readWorkspaceWorktrees('a')).find(
        (entry) => entry.id === 'one',
      );
      const operationId = randomUUID();
      const contents = JSON.stringify({
        version: 1,
        operationId,
        operation: 'worktree-archive',
        workspaceId: 'a',
        worktreeId: 'one',
        createdAt: row?.createdAt ?? '2026-11-01T00:00:00.000Z',
        state: 'recovery-required',
        directoryIdentity: statIdentity(getWorkspaceDir('a')),
        steps: [{ phase: 'git-capture', state: 'failed' }],
        ownedPaths: existsSync(checkout())
          ? [{ path: checkout(), identity: statIdentity(checkout()) }]
          : [],
        ...overrides,
      });
      mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
      const copies = new Map<string, string>();
      const name = lifecycleJournalSlotName('a', 'one');
      writeFileSync(join(getW5DestructiveLifecycleDir(), name), contents);
      copies.set(name, contents);
      return { operationId, copies };
    }

    async function removeOne(): Promise<void> {
      execFileSync('git', ['-C', repo, 'worktree', 'remove', checkout()]);
      await workspacePersistence.removeWorkspaceWorktrees(
        'a',
        (entry) => entry.id === 'one',
      );
    }

    async function strandFinish(
      state = 'recovery-required',
    ): Promise<{ operationId: string; copies: Map<string, string> }> {
      const row = (await workspacePersistence.readWorkspaceWorktrees('a')).find(
        (entry) => entry.id === 'one',
      );
      if (!row) throw new Error('No original row');
      await removeOne();
      const oid = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      const manifest = retentionManifest('one', oid);
      execFileSync('git', [
        '-C',
        repo,
        'update-ref',
        'refs/app/archived-containers/a/one/__single_repo__',
        oid,
      ]);
      manifest.createdAt = row.createdAt;
      manifest.originalWorktree = row;
      const directory = getArchivedContainerDir('a', 'one');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'container.json'),
        JSON.stringify(manifest),
      );
      const { readArchivedContainerManifestIncludingExpired } =
        await import('../archived-containers');
      expect(
        await readArchivedContainerManifestIncludingExpired('a', 'one'),
      ).toEqual(manifest);
      return strand({
        state,
        ...(state === 'completed' ? { cleanupRequired: true } : {}),
        createdAt: row.createdAt,
        ownedPaths: [],
        steps: [
          ...[
            'git-worktree-removal',
            'quarantine-directory-removal',
            'pipeline-cleanup',
            'retained-manifest-commit',
            'git-capture-completion',
          ].map((phase) => ({ phase, state: 'done' })),
          { phase: 'canonical-row-removal', state: 'failed' },
          ...(state === 'completed'
            ? [{ phase: 'turn-diff-cleanup', state: 'failed' }]
            : []),
        ],
      });
    }

    it.each([
      'keep-worktree',
      'release',
      'finish',
      'retry',
      'discard',
      'set-aside',
    ])(
      'offered actions pass their writer admission (%s fixture)',
      async (action) => {
        if (action === 'release' || action === 'set-aside') await removeOne();
        const { operationId, copies } =
          action === 'finish'
            ? await strandFinish()
            : await strand({
                ...(action === 'retry'
                  ? {
                      steps: [
                        ...PRE_GIT_CAPTURE.slice(0, -1),
                        { phase: 'retained-payload-capture', state: 'pending' },
                      ],
                    }
                  : {}),
                ...(action === 'discard' ? { ownedPaths: [] } : {}),
                ...(action === 'set-aside' ? { steps: SET_ASIDE_STEPS } : {}),
              });
        expect(await offeredActions(operationId)).toContain(action);
        if (action !== 'set-aside') return;
        const before = canonicalImages();
        const runtime = recoveryRuntime();
        try {
          const listed = await runtime.query(
            'core.worktree.recovery.list',
            { workspaceId: 'a', operationId },
            { caller: RECOVERY_USER },
          );
          expect(listed.check).toBe('ok');
          const entry = listed.entries[0];
          if (!entry?.diagnosis) throw new Error('No diagnosis');
          expect(worktreeRecoveryOfferedActions(entry, RECOVERY_HOST)).toEqual([
            'set-aside',
          ]);
          const result = await runtime.instruction(
            'core.worktree.recovery.setAside',
            {
              workspaceId: 'a',
              operationId,
              revision: entry.diagnosis.revision,
            },
            { caller: RECOVERY_USER },
          );
          expect(result).toMatchObject({ status: 'set-aside', operationId });
          if (result.status !== 'set-aside')
            throw new Error('Set aside refused');
          expect(copies.size).toBe(1);
          expect(result.quarantinedNames).toHaveLength(1);
          expect(result.putBackCopies).toHaveLength(1);
          for (const [name, contents] of copies) {
            const moved = result.putBackCopies.find(
              (copy) => copy.originalName === name,
            );
            if (!moved) throw new Error('No quarantined copy');
            expect(result.quarantinedNames).toContain(moved.quarantinedName);
            expect(existsSync(join(getW5DestructiveLifecycleDir(), name))).toBe(
              false,
            );
            expect(
              readFileSync(
                join(getW5QuarantinedLifecycleDir(), moved.quarantinedName),
              ),
            ).toEqual(Buffer.from(contents));
          }
          expect(canonicalImages()).toEqual(before);
        } finally {
          await runtime.shutdown();
        }
      },
    );

    it.each(['active', 'recovery-required', 'completed'])(
      'a readable blocking receipt withdraws Finish, not Set aside (%s)',
      async (state) => {
        const { operationId, copies } = await strandFinish(state);
        expect(await offeredActions(operationId)).toEqual(['finish']);
        const { archiveRecoveryStore, assertNoArchiveResolution } =
          await import('../archive-recovery-refs');
        const { randomUUID } = await import('node:crypto');
        const store = archiveRecoveryStore();
        const receipt = await store.prepare({
          workspaceId: 'a',
          worktreeId: 'one',
          operationId: randomUUID(),
          action: 'release',
          revision: 'a'.repeat(64),
          createdAt: '2026-11-01T00:00:00.000Z',
          copies: [],
          sourceRecord: {},
          repositories: [],
          capture: 'none',
        });
        await expect(assertNoArchiveResolution('a', 'one')).rejects.toThrow();
        const { listWorktreeRecovery } =
          await import('../worktree-recovery-description');
        const { finishWorktreeRecovery } =
          await import('../worktree-recovery-finish');
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        const listed = await listWorktreeRecovery({
          workspaceId: 'a',
          operationId,
        });
        expect(listed.check).toBe('ok');
        const entry = listed.entries[0];
        if (!entry?.diagnosis) throw new Error('No diagnosis');
        expect(entry.diagnosis.check).toBe('resolution-pending');
        expect(await offeredActions(operationId)).toEqual(['set-aside']);
        const request = {
          workspaceId: 'a',
          operationId,
          revision: entry.diagnosis.revision,
        };
        const before = canonicalImages();
        expect(await finishWorktreeRecovery(request)).toMatchObject({
          status: 'refused',
        });
        for (const [name, contents] of copies)
          expect(
            readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
          ).toBe(contents);
        expect(await setAsideWorktreeRecovery(request)).toMatchObject({
          status: 'set-aside',
          operationId,
        });
        expect(canonicalImages()).toEqual(before);
        expect(await store.read('a', receipt.operationId)).toEqual(receipt);
      },
    );

    it.each(['active', 'recovery-required', 'completed'])(
      'an unreadable sibling receipt withdraws Finish, not Set aside (%s)',
      async (state) => {
        const { operationId, copies } = await strandFinish(state);
        expect(await offeredActions(operationId)).toEqual(['finish']);
        const { archiveRecoveryStore } =
          await import('../archive-recovery-refs');
        const { randomUUID } = await import('node:crypto');
        const unrelated = archiveRecoveryStore().directory({
          workspaceId: 'a',
          operationId: randomUUID(),
        });
        mkdirSync(unrelated, { recursive: true });
        writeFileSync(join(unrelated, 'receipt.json'), '{');
        const { listWorktreeRecovery } =
          await import('../worktree-recovery-description');
        const { finishWorktreeRecovery } =
          await import('../worktree-recovery-finish');
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        const manifestFile = join(
          getArchivedContainerDir('a', 'one'),
          'container.json',
        );
        const manifestBefore = readFileSync(manifestFile);
        const before = canonicalImages();
        const listed = await listWorktreeRecovery({
          workspaceId: 'a',
          operationId,
        });
        expect(listed.check).toBe('ok');
        expect(listed.unreadableEvidence).toBe('receipts');
        const entry = listed.entries[0];
        if (!entry?.diagnosis) throw new Error('No diagnosis');
        expect(worktreeRecoveryOfferedActions(entry, RECOVERY_HOST)).toEqual([
          'set-aside',
        ]);
        await assertOfferedActionsAdmitted(entry);
        const request = {
          workspaceId: 'a',
          operationId,
          revision: entry.diagnosis.revision,
        };
        expect(await finishWorktreeRecovery(request)).toMatchObject({
          status: 'refused',
        });
        for (const [name, contents] of copies)
          expect(
            readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
          ).toBe(contents);
        expect(await setAsideWorktreeRecovery(request)).toMatchObject({
          status: 'set-aside',
          operationId,
        });
        expect(canonicalImages()).toEqual(before);
        expect(readFileSync(manifestFile)).toEqual(manifestBefore);
        expect(readFileSync(join(unrelated, 'receipt.json'), 'utf8')).toBe('{');
      },
    );

    it.each(
      ['active', 'recovery-required'].flatMap((state) =>
        ['retry', 'discard'].map((action) => ({ state, action })),
      ),
    )(
      'an unreadable sibling receipt withdraws Retry and Discard ($state, $action)',
      async ({ state, action }) => {
        const { operationId } = await strand({
          state,
          ...(action === 'retry'
            ? {
                steps: [
                  { phase: 'teardown-script', state: 'done' },
                  { phase: 'live-state-teardown', state: 'pending' },
                ],
              }
            : { ownedPaths: [] }),
        });
        expect(await offeredActions(operationId)).toContain(action);
        const { archiveRecoveryStore, assertNoArchiveResolution } =
          await import('../archive-recovery-refs');
        const { randomUUID } = await import('node:crypto');
        const unrelated = archiveRecoveryStore().directory({
          workspaceId: 'a',
          operationId: randomUUID(),
        });
        mkdirSync(unrelated, { recursive: true });
        writeFileSync(join(unrelated, 'receipt.json'), '{');
        // Both writers run this read-only gate before taking over the journal.
        await expect(assertNoArchiveResolution('a', 'one')).rejects.toThrow();
        const runtime = recoveryRuntime();
        const listed = await runtime
          .query(
            'core.worktree.recovery.list',
            { workspaceId: 'a', operationId },
            { caller: RECOVERY_USER },
          )
          .finally(() => runtime.shutdown());
        expect(listed.check).toBe('ok');
        expect(listed.unreadableEvidence).toBe('receipts');
        const entry = listed.entries[0];
        if (!entry?.diagnosis) throw new Error('No diagnosis');
        expect(worktreeRecoveryOfferedActions(entry, RECOVERY_HOST)).toEqual([
          'set-aside',
        ]);
        await assertOfferedActionsAdmitted(entry);
        const images = canonicalImages();
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        expect(
          await setAsideWorktreeRecovery({
            workspaceId: 'a',
            operationId,
            revision: entry.diagnosis.revision,
          }),
        ).toMatchObject({ status: 'set-aside', operationId });
        expect(canonicalImages()).toEqual(images);
        expect(existsSync(checkout())).toBe(true);
        expect(readFileSync(join(unrelated, 'receipt.json'), 'utf8')).toBe('{');
      },
    );

    it('an unreadable source repository withdraws Release before publication', async () => {
      await removeOne();
      const { operationId } = await strand({ steps: PRE_GIT_CAPTURE });
      expect(await offeredActions(operationId)).toEqual(['release']);
      const { archiveRecoveryStore } = await import('../archive-recovery-refs');
      const store = archiveRecoveryStore();
      const config = join(root, 'a', 'workspace.json');
      const contents = JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: join(dir, 'missing-repo'),
        repos: [],
      });
      writeFileSync(config, contents);
      const { listWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const listed = await listWorktreeRecovery({
        workspaceId: 'a',
        operationId,
      });
      const entry = listed.entries[0];
      if (!entry?.diagnosis) throw new Error('No diagnosis');
      expect(entry.diagnosis.check).toBe('resolution-not-admitted');
      expect(await offeredActions(operationId)).toEqual(['set-aside']);
      expect(await store.read('a', operationId)).toBeNull();
      expect(readFileSync(config, 'utf8')).toBe(contents);
    });

    it('Keep: the listed, verified live checkout', async () => {
      const { operationId } = await strand();
      expect(await offeredActions(operationId)).toContain('keep-worktree');
    });

    it.each(
      (['keep-worktree', 'release'] as const).flatMap((action) =>
        [false, true].map((cancelled) => ({ action, cancelled })),
      ),
    )(
      'passive $action offers never open payloads (cancelled: $cancelled)',
      async ({ action, cancelled }) => {
        if (action === 'release') await removeOne();
        const { operationId } = await strand();
        const { archiveRecoveryStore } =
          await import('../archive-recovery-refs');
        const journals = await import('../stranded-archive-journals');
        const { readArchiveJournalOperations } = journals;
        const { readArchiveResolutionPreparation } =
          await import('../worktree-archive-resolution-admission');
        const { archiveRecoveryDigest } =
          await import('@canopy/desktop-shared/node/archive-recovery-store');
        const { resolveWorktreeArchive } =
          await import('../worktree-archive-resolution');
        const store = archiveRecoveryStore();
        const staged = getArchivedContainerDir('a', 'one');
        const payload = join(staged, 'files', 'saved.bin');
        const contents = Buffer.alloc(128 * 1024 + 7, 0xa5);
        mkdirSync(dirname(payload), { recursive: true });
        writeFileSync(payload, contents);
        if (cancelled) {
          const operation = (
            await readArchiveJournalOperations('a')
          ).operations.find(
            (entry) => entry.record.operationId === operationId,
          );
          if (!operation) throw new Error('No source journal');
          await store.cancel(
            await store.prepare(
              await readArchiveResolutionPreparation(operation, action),
            ),
          );
        }
        const read = jest.spyOn(fsPromises, 'readFile');
        const open = jest.spyOn(fsPromises, 'open');
        const stream = jest.spyOn(fs, 'createReadStream');
        const syncRead = jest.spyOn(fs, 'readFileSync');
        const syncOpen = jest.spyOn(fs, 'openSync');
        const journalScan = jest.spyOn(
          journals,
          'readArchiveJournalOperations',
        );
        const runtime = recoveryRuntime();
        try {
          const listed = await runtime.query(
            'core.worktree.recovery.list',
            { workspaceId: 'a' },
            { caller: RECOVERY_USER },
          );
          const entry = listed.entries[0];
          if (!entry?.diagnosis) throw new Error('No diagnosis');
          // A listed live checkout can also be discarded; Keep is not exclusive.
          expect(worktreeRecoveryOfferedActions(entry, RECOVERY_HOST)).toEqual(
            action === 'keep-worktree' ? [action, 'discard'] : [action],
          );
          expect(journalScan).toHaveBeenCalledTimes(1);
          expect(read.mock.calls.filter(([path]) => path === payload)).toEqual(
            [],
          );
          expect(open.mock.calls.filter(([path]) => path === payload)).toEqual(
            [],
          );
          expect(
            stream.mock.calls.filter(([path]) => path === payload),
          ).toEqual([]);
          expect(
            syncRead.mock.calls.filter(([path]) => path === payload),
          ).toEqual([]);
          expect(
            syncOpen.mock.calls.filter(([path]) => path === payload),
          ).toEqual([]);
          // Execution must still read and hash the exact staged bytes.
          expect(
            await resolveWorktreeArchive({
              workspaceId: 'a',
              operationId,
              revision: entry.diagnosis.revision,
              action,
            }),
          ).toMatchObject({
            status:
              action === 'keep-worktree'
                ? 'worktree-kept'
                : 'attempt-withdrawn',
          });
          expect(
            open.mock.calls.filter(([path]) => path === payload).length,
          ).toBeGreaterThan(0);
          expect(
            (await store.read('a', operationId))?.staging?.entries,
          ).toContainEqual({
            path: 'files/saved.bin',
            kind: 'file',
            size: contents.length,
            digest: archiveRecoveryDigest(contents),
          });
        } finally {
          await runtime.shutdown();
          read.mockRestore();
          open.mockRestore();
          stream.mockRestore();
          syncRead.mockRestore();
          syncOpen.mockRestore();
          journalScan.mockRestore();
        }
      },
    );

    it('Check again and Set aside recover from same-size cancelled-payload drift', async () => {
      await removeOne();
      const { operationId } = await strand();
      const { archiveRecoveryStore } = await import('../archive-recovery-refs');
      const { readArchiveJournalOperations } =
        await import('../stranded-archive-journals');
      const { readArchiveResolutionPreparation } =
        await import('../worktree-archive-resolution-admission');
      const { resolveWorktreeArchive } =
        await import('../worktree-archive-resolution');
      const { describeWorktreeDiscard } = await import('../worktree-discard');
      const store = archiveRecoveryStore();
      const payload = join(getArchivedContainerDir('a', 'one'), 'saved.bin');
      mkdirSync(dirname(payload), { recursive: true });
      writeFileSync(payload, 'original');
      const operation = (
        await readArchiveJournalOperations('a')
      ).operations.find((entry) => entry.record.operationId === operationId);
      if (!operation) throw new Error('No source journal');
      const cancelled = await store.cancel(
        await store.prepare(
          await readArchiveResolutionPreparation(operation, 'release'),
        ),
      );
      writeFileSync(payload, 'replaced');
      const runtime = recoveryRuntime();
      try {
        const listed = await runtime.query(
          'core.worktree.recovery.list',
          { workspaceId: 'a', operationId },
          { caller: RECOVERY_USER },
        );
        const entry = listed.entries[0];
        if (!entry?.diagnosis) throw new Error('No diagnosis');
        // Passive lists remain metadata-only, even for a named operation.
        expect(worktreeRecoveryOfferedActions(entry, RECOVERY_HOST)).toEqual([
          'release',
        ]);
        expect(
          await resolveWorktreeArchive({
            workspaceId: 'a',
            operationId,
            revision: entry.diagnosis.revision,
            action: 'release',
          }),
        ).toMatchObject({ status: 'refused' });
        expect(await store.read('a', operationId)).toEqual(cancelled);
        expect(readFileSync(payload, 'utf8')).toBe('replaced');
        writeFileSync(payload, 'different length');
        const changed = await runtime.query(
          'core.worktree.recovery.list',
          { workspaceId: 'a', operationId },
          { caller: RECOVERY_USER },
        );
        expect(changed.entries[0]?.diagnosis?.verdict).not.toBe('release');
        writeFileSync(payload, 'replaced');
        // The dialog's Check again command inspects only this entry exactly.
        const checked = await describeWorktreeDiscard('a', 'one', {
          recovery: {
            intent: 'archive',
            expectedCreatedAt: operation.record.createdAt ?? null,
            operationId,
          },
        });
        const recovery = checked.recovery;
        if (!recovery?.diagnosis) throw new Error('No rechecked diagnosis');
        expect(worktreeRecoveryOfferedActions(recovery, RECOVERY_HOST)).toEqual(
          ['set-aside'],
        );
        expect(recovery.diagnosis.revision).toBe(entry.diagnosis.revision);
        for (const copy of operation.sources)
          expect(
            readFileSync(
              join(getW5DestructiveLifecycleDir(), copy.name),
              'utf8',
            ),
          ).toBe(copy.contents);
        const before = canonicalImages();
        const result = await runtime.instruction(
          'core.worktree.recovery.setAside',
          {
            workspaceId: 'a',
            operationId,
            revision: recovery.diagnosis.revision,
          },
          { caller: RECOVERY_USER },
        );
        expect(result).toMatchObject({ status: 'set-aside', operationId });
        if (result.status !== 'set-aside') throw new Error('Set aside refused');
        const [quarantinedName] = result.quarantinedNames;
        const [source] = operation.sources;
        if (!quarantinedName || !source) throw new Error('No quarantined copy');
        expect(
          readFileSync(
            join(getW5QuarantinedLifecycleDir(), quarantinedName),
            'utf8',
          ),
        ).toBe(source.contents);
        expect(
          existsSync(join(getW5DestructiveLifecycleDir(), source.name)),
        ).toBe(false);
        expect(canonicalImages()).toEqual(before);
        expect(await store.read('a', operationId)).toEqual(cancelled);
        expect(readFileSync(payload, 'utf8')).toBe('replaced');
      } finally {
        await runtime.shutdown();
      }
    });

    it.each(['recovery-required', 'active'])(
      'Release: row and checkout absent before Git capture (%s)',
      async (state) => {
        await removeOne();
        const { operationId } = await strand({ state, steps: PRE_GIT_CAPTURE });
        expect(await offeredActions(operationId)).toEqual(['release']);
        const { listWorktreeRecovery } =
          await import('../worktree-recovery-description');
        const { resolveWorktreeArchive } =
          await import('../worktree-archive-resolution');
        const review = (
          await listWorktreeRecovery({ workspaceId: 'a', operationId })
        ).entries[0]?.diagnosis;
        if (!review) throw new Error('No diagnosis');
        expect(
          await resolveWorktreeArchive({
            workspaceId: 'a',
            operationId,
            revision: review.revision,
            action: 'release',
          }),
        ).toMatchObject({ status: 'attempt-withdrawn' });
      },
    );

    it.each(
      ['active', 'recovery-required'].flatMap((state) =>
        ['release', 'keep-worktree'].flatMap((action) =>
          ['malformed', 'not-a-file', 'artifact'].map((shape) => ({
            state,
            action,
            shape,
          })),
        ),
      ),
    )(
      'receipt normalization gates $action for $state ($shape)',
      async ({ state, action, shape }) => {
        if (action === 'release') await removeOne();
        const { operationId, copies } = await strand({ state });
        const { listWorktreeRecovery } =
          await import('../worktree-recovery-description');
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        const { archiveRecoveryStore } =
          await import('../archive-recovery-refs');
        const { randomUUID } = await import('node:crypto');
        const store = archiveRecoveryStore();
        // The same record offers Keep/Release while the workspace is readable.
        const before = (
          await listWorktreeRecovery({ workspaceId: 'a', operationId })
        ).entries[0];
        expect(before?.diagnosis?.verdict).toBe(action);
        if (!before) throw new Error('No recovery entry');
        expect(worktreeRecoveryOfferedActions(before, RECOVERY_HOST)).toEqual([
          action,
        ]);
        const unrelatedId = randomUUID();
        const unrelated = store.directory({
          workspaceId: 'a',
          operationId: unrelatedId,
        });
        mkdirSync(unrelated, { recursive: true });
        const evidence = join(
          unrelated,
          shape === 'artifact' ? 'unknown' : 'receipt.json',
        );
        if (shape === 'not-a-file') mkdirSync(evidence);
        else writeFileSync(evidence, '{');
        const images = canonicalImages();
        const runtime = recoveryRuntime();
        const listed = await runtime
          .query(
            'core.worktree.recovery.list',
            { workspaceId: 'a', operationId },
            { caller: RECOVERY_USER },
          )
          .finally(() => runtime.shutdown());
        expect(listed.check).toBe('ok');
        expect(listed.unreadableEvidence).toBe('receipts');
        const entry = listed.entries[0];
        if (!entry?.diagnosis) throw new Error('No diagnosis');
        expect(entry.destination.kind).toBe('recovery');
        expect(entry.diagnosis.verdict).not.toBe(action);
        expect(entry.diagnosis.check).toBe('recovery-receipts-unreadable');
        const offered = worktreeRecoveryOfferedActions(entry, RECOVERY_HOST);
        expect(offered).not.toContain(action);
        expect(offered.length).toBeGreaterThan(0);
        // A description must not normalize or rewrite any journal or receipt.
        for (const [name, contents] of copies)
          expect(
            readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
          ).toBe(contents);
        expect(await store.read('a', operationId)).toBeNull();
        if (action === 'release') {
          expect(offered).toEqual(['set-aside']);
          expect(
            await setAsideWorktreeRecovery({
              workspaceId: 'a',
              operationId,
              revision: entry.diagnosis.revision,
            }),
          ).toMatchObject({ status: 'set-aside', operationId });
        }
        expect(canonicalImages()).toEqual(images);
        expect(readdirSync(unrelated)).toEqual([
          shape === 'artifact' ? 'unknown' : 'receipt.json',
        ]);
        if (shape === 'not-a-file')
          expect(lstatSync(evidence).isDirectory()).toBe(true);
        else expect(readFileSync(evidence, 'utf8')).toBe('{');
      },
    );

    it('workspace receipt admission is shared only within each recovery list', async () => {
      await removeOne();
      const { copies } = await strand({ state: 'active' });
      const [contents] = copies.values();
      if (!contents) throw new Error('No source journal');
      const source = journalSchema.parse(JSON.parse(contents));
      const { randomUUID } = await import('node:crypto');
      const { lifecycleJournalSlotName } =
        await import('../w5-destructive-recovery');
      // Match a real large attention list, without creating more checkouts.
      for (let index = 1; index < 38; index += 1) {
        const worktreeId = `absent-${index}`;
        writeFileSync(
          join(
            getW5DestructiveLifecycleDir(),
            lifecycleJournalSlotName('a', worktreeId),
          ),
          JSON.stringify({
            ...source,
            operationId: randomUUID(),
            worktreeId,
          }),
        );
      }
      const { ArchiveRecoveryStore: Store } =
        await import('@canopy/desktop-shared/node/archive-recovery-store');
      const { archiveRecoveryStore } = await import('../archive-recovery-refs');
      const { describeWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const archivedGit = await import('../archived-container-git');
      const recoveryRefs = await import('../archive-recovery-refs');
      const unrelated = archiveRecoveryStore().directory({
        workspaceId: 'a',
        operationId: randomUUID(),
      });
      const runtime = recoveryRuntime();
      const preflight = jest.spyOn(
        Store.prototype,
        'assertWorkspaceNormalizable',
      );
      const receiptScan = jest.spyOn(recoveryRefs, 'readArchiveRecoveryHolds');
      const repositories = jest.spyOn(
        archivedGit,
        'inspectArchiveRecoveryRepositories',
      );
      const journalRead = jest.spyOn(fsPromises, 'readFile');
      const journalFiles = readdirSync(getW5DestructiveLifecycleDir()).filter(
        (name) => name.endsWith('.json'),
      );
      try {
        for (const damaged of [false, true, false]) {
          if (damaged) {
            mkdirSync(unrelated, { recursive: true });
            writeFileSync(join(unrelated, 'receipt.json'), '{');
          } else rmSync(unrelated, { recursive: true, force: true });
          preflight.mockClear();
          receiptScan.mockClear();
          repositories.mockClear();
          journalRead.mockClear();
          const listed = await runtime.query(
            'core.worktree.recovery.list',
            { workspaceId: 'a' },
            { caller: RECOVERY_USER },
          );
          expect(listed.check).toBe('ok');
          expect(listed.unreadableEvidence).toBe(
            damaged ? 'receipts' : undefined,
          );
          expect(listed.entries).toHaveLength(38);
          for (const entry of listed.entries) {
            expect(entry.diagnosis?.check).toBe(
              damaged
                ? 'recovery-receipts-unreadable'
                : 'pre-quarantine-row-and-checkout-absent',
            );
            expect(
              worktreeRecoveryOfferedActions(entry, RECOVERY_HOST),
            ).toEqual([damaged ? 'set-aside' : 'release']);
          }
          // Bound workspace-wide I/O, including a failed inspection, per call.
          expect(preflight).toHaveBeenCalledTimes(1);
          expect(receiptScan).toHaveBeenCalledTimes(1);
          // Ref namespaces differ per worktree; inspect each candidate only once.
          expect(repositories).toHaveBeenCalledTimes(damaged ? 0 : 38);
          // Two reads for validated journal bytes, one for blocking evidence;
          // neither scan may grow with the number of offered resolutions.
          const journalReads = journalRead.mock.calls.filter(
            ([path]) =>
              typeof path === 'string' &&
              dirname(path) === getW5DestructiveLifecycleDir(),
          ).length;
          expect(journalReads).toBeGreaterThanOrEqual(journalFiles.length);
          expect(journalReads).toBeLessThanOrEqual(3 * journalFiles.length);
        }
        // Standalone descriptions must inspect afresh as well.
        preflight.mockClear();
        mkdirSync(unrelated, { recursive: true });
        writeFileSync(join(unrelated, 'receipt.json'), '{');
        const described = await describeWorktreeRecovery(
          {
            workspaceId: 'a',
            worktreeId: 'one',
            expectedCreatedAt: source.createdAt ?? null,
            intent: 'archive',
            operationId: source.operationId,
          },
          undefined,
        );
        expect(described.diagnosis?.check).toBe('recovery-receipts-unreadable');
        expect(
          worktreeRecoveryOfferedActions(described, RECOVERY_HOST),
        ).toEqual(['set-aside']);
        expect(preflight).toHaveBeenCalledTimes(1);
      } finally {
        preflight.mockRestore();
        receiptScan.mockRestore();
        repositories.mockRestore();
        journalRead.mockRestore();
        await runtime.shutdown();
      }
    });

    it('an unverifiable listed checkout still offers its eligible Discard', async () => {
      const { operationId } = await strand({
        directoryIdentity: `unverifiable:${statIdentity(getWorkspaceDir('a'))}`,
        ownedPaths: [
          {
            path: checkout(),
            identity: `unverifiable:${statIdentity(checkout())}`,
          },
        ],
      });
      expect(await offeredActions(operationId)).toEqual(['discard']);
    });

    it('a crashed `active` archive reads as recovery-required (q-26 2a)', async () => {
      const { operationId } = await strand({
        state: 'active',
        steps: [
          { phase: 'teardown-script', state: 'done' },
          { phase: 'live-state-teardown', state: 'pending' },
        ],
      });
      expect(await offeredActions(operationId)).toEqual(
        expect.arrayContaining(['keep-worktree', 'retry']),
      );
      expect(await offeredActions(operationId)).not.toContain('set-aside');
      // Keep executes on the crashed journal and stops it blocking the worktree.
      const { listWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const { resolveWorktreeArchive } =
        await import('../worktree-archive-resolution');
      const review = (
        await listWorktreeRecovery({ workspaceId: 'a', operationId })
      ).entries[0]?.diagnosis;
      if (!review) throw new Error('No diagnosis');
      expect(
        await resolveWorktreeArchive({
          workspaceId: 'a',
          operationId,
          revision: review.revision,
          action: 'keep-worktree',
        }),
      ).toMatchObject({ status: 'worktree-kept' });
      const { readBlockingDestructiveRecoveries } =
        await import('../w5-destructive-recovery');
      expect(await readBlockingDestructiveRecoveries('a', 'one')).toEqual([]);
    });

    it("the Electron seeder's default shape offers Discard, not Set aside", async () => {
      const { operationId, copies } = await strand({
        steps: SEEDER_DEFAULT_STEPS,
        ownedPaths: [],
      });
      expect(await offeredActions(operationId)).toEqual(['discard']);
      const { readArchiveJournalOperations } =
        await import('../stranded-archive-journals');
      const { setAsideWorktreeRecovery } =
        await import('../worktree-recovery-set-aside');
      const review = (await readArchiveJournalOperations('a')).operations.find(
        (entry) => entry.record.operationId === operationId,
      );
      if (!review) throw new Error('No diagnosis');
      expect(
        await setAsideWorktreeRecovery({
          workspaceId: 'a',
          operationId,
          revision: review.revision,
        }),
      ).toEqual({ status: 'refused', operationId, check: 'not-eligible' });
      for (const [name, contents] of copies)
        expect(
          readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
        ).toBe(contents);
    });

    it('live delegates leave Set aside available instead of a busy Discard', async () => {
      const { operationId } = await strand({
        steps: SEEDER_DEFAULT_STEPS,
        ownedPaths: [],
      });
      const { describeWorktreeDiscard, discardWorktree } =
        await import('../worktree-discard');
      const { describeWorktreeRecovery, listWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const { setAsideWorktreeRecovery } =
        await import('../worktree-recovery-set-aside');
      const discard = await describeWorktreeDiscard('a', 'one');
      expect(discard.status).toBe('discardable');
      expect(await offeredActions(operationId)).toEqual(['discard']);
      const before = canonicalImages();
      setDelegationActivity('can7014-busy', 'a/one/chat-a', 1);
      try {
        expect(await offeredActions(operationId)).toEqual(['set-aside']);
        const described = await describeWorktreeRecovery(
          {
            workspaceId: 'a',
            worktreeId: 'one',
            expectedCreatedAt: discard.createdAt,
            intent: 'archive',
            operationId,
          },
          discard,
        );
        expect(described.actions.discard.eligible).toBe(false);
        expect(
          worktreeRecoveryOfferedActions(described, RECOVERY_HOST),
        ).toEqual(['set-aside']);
        // A confirmation obtained before delegates started still refuses.
        expect(
          await discardWorktree({
            workspaceId: 'a',
            worktreeId: 'one',
            confirmation: discard.confirmation,
            source: 'desktop-ui',
          }),
        ).toMatchObject({ status: 'refused', reason: 'busy' });
        setDelegationActivity('can7014-busy', 'a/one/chat-a', 0);
        expect(await offeredActions(operationId)).toEqual(['discard']);
        setDelegationActivity('can7014-busy', 'a/one/chat-a', 1);
        expect(await offeredActions(operationId)).toEqual(['set-aside']);
        const review = (
          await listWorktreeRecovery({ workspaceId: 'a', operationId })
        ).entries[0]?.diagnosis;
        if (!review) throw new Error('No diagnosis');
        expect(
          await setAsideWorktreeRecovery({
            workspaceId: 'a',
            operationId,
            revision: review.revision,
          }),
        ).toMatchObject({ status: 'set-aside', operationId });
        expect(canonicalImages()).toEqual(before);
        expect(existsSync(checkout())).toBe(true);
      } finally {
        setDelegationActivity('can7014-busy', 'a/one/chat-a', 0);
      }
    });

    it('rechecks the reviewed copy before moving it', async () => {
      await removeOne();
      const { operationId, copies } = await strand({ steps: SET_ASIDE_STEPS });
      expect(await offeredActions(operationId)).toEqual(['set-aside']);
      const { readArchiveJournalOperations } =
        await import('../stranded-archive-journals');
      const { setAsideWorktreeRecovery } =
        await import('../worktree-recovery-set-aside');
      const recovery = await import('../w5-destructive-recovery');
      const review = (await readArchiveJournalOperations('a')).operations.find(
        (entry) => entry.record.operationId === operationId,
      );
      if (!review || review.sources.length !== 1)
        throw new Error('Expected one reviewed copy');
      const copy = review.sources[0];
      if (!copy) throw new Error('No copy');
      const changed = `${copy.contents}\n`;
      const exclusive = recovery.withExclusiveLifecycleJournalAccess;
      const lock = jest
        .spyOn(recovery, 'withExclusiveLifecycleJournalAccess')
        .mockImplementationOnce((work) =>
          exclusive(async () => {
            // Same parsed record, different reviewed bytes, just before the exclusive scan.
            writeFileSync(
              join(getW5DestructiveLifecycleDir(), copy.name),
              changed,
            );
            return work();
          }),
        );
      try {
        expect(
          await setAsideWorktreeRecovery({
            workspaceId: 'a',
            operationId,
            revision: review.revision,
          }),
        ).toEqual({
          status: 'refused',
          operationId,
          check: 'revision-changed',
        });
        for (const [name, contents] of copies)
          expect(
            readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
          ).toBe(name === copy.name ? changed : contents);
        expect(existsSync(getW5QuarantinedLifecycleDir())).toBe(false);
      } finally {
        lock.mockRestore();
      }
    });

    it('Set aside is independent of an unrelated unreadable receipt', async () => {
      await removeOne();
      const { operationId } = await strand({ steps: SET_ASIDE_STEPS });
      const { readArchiveJournalOperations } =
        await import('../stranded-archive-journals');
      const { setAsideWorktreeRecovery } =
        await import('../worktree-recovery-set-aside');
      const { archiveRecoveryStore } = await import('../archive-recovery-refs');
      const { randomUUID } = await import('node:crypto');
      const review = (await readArchiveJournalOperations('a')).operations[0];
      if (!review) throw new Error('No review');
      const unrelated = archiveRecoveryStore().directory({
        workspaceId: 'a',
        operationId: randomUUID(),
      });
      mkdirSync(unrelated, { recursive: true });
      writeFileSync(join(unrelated, 'receipt.json'), '{');
      expect(
        await setAsideWorktreeRecovery({
          workspaceId: 'a',
          operationId,
          revision: review.revision,
        }),
      ).toMatchObject({ status: 'set-aside' });
      expect(readFileSync(join(unrelated, 'receipt.json'), 'utf8')).toBe('{');
    });

    it.each(['malformed', 'not-a-file'])(
      'receipt read failures do not send the project to unreadable journal review (%s)',
      async (shape) => {
        const { operationId } = await strand();
        const { archiveRecoveryStore } =
          await import('../archive-recovery-refs');
        const selected = archiveRecoveryStore().directory({
          workspaceId: 'a',
          operationId,
        });
        mkdirSync(selected, { recursive: true });
        if (shape === 'malformed')
          writeFileSync(join(selected, 'receipt.json'), '{');
        else mkdirSync(join(selected, 'receipt.json'));
        const runtime = recoveryRuntime();
        try {
          const listed = await runtime.query(
            'core.worktree.recovery.list',
            { workspaceId: 'a' },
            { caller: RECOVERY_USER },
          );
          expect(listed.check).toBe('ok');
          expect(listed.unreadableEvidence).toBe('receipts');
          const selectedEntry = listed.entries.find(
            (entry) => entry.diagnosis?.operationId === operationId,
          );
          expect(selectedEntry?.diagnosis?.verdict).not.toBe('keep-worktree');
          expect(selectedEntry?.actions.setAside?.eligible).toBe(false);
          writeFileSync(
            join(getW5DestructiveLifecycleDir(), `${operationId}.json`),
            '{',
          );
          const unreadable = await runtime.query(
            'core.worktree.recovery.list',
            { workspaceId: 'a' },
            { caller: RECOVERY_USER },
          );
          expect(unreadable.check).toBe('journal-evidence-unreadable');
        } finally {
          await runtime.shutdown();
        }
      },
    );

    it.each([undefined, false, true])(
      'exact-ID description excludes only settled completed records (debt: %s)',
      async (cleanupRequired) => {
        await removeOne();
        const { operationId } = await strand({
          state: 'completed',
          cleanupRequired,
        });
        const { describeWorktreeRecovery } =
          await import('../worktree-recovery-description');
        const description = await describeWorktreeRecovery(
          {
            workspaceId: 'a',
            worktreeId: 'one',
            expectedCreatedAt: null,
            intent: 'archive',
            operationId,
          },
          undefined,
        );
        expect(description.actions.setAside?.eligible).toBe(
          cleanupRequired === true,
        );
      },
    );

    it('Set aside keeps an expired archive and its Git snapshots through retention sweeps', async () => {
      await removeOne();
      const { operationId, copies } = await strand({ steps: SET_ASIDE_STEPS });
      const { listWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const { setAsideWorktreeRecovery } =
        await import('../worktree-recovery-set-aside');
      const { purgeExpiredArchivedContainersForWorkspace } =
        await import('../archived-container-retention');
      const { hasUnresolvedDestructiveRecovery } =
        await import('../w5-destructive-recovery');
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      const oid = git('rev-parse', 'HEAD');
      const ref = 'refs/app/archived-containers/a/one/__single_repo__';
      git('update-ref', ref, oid);
      await commitArchivedContainer(retentionManifest('one', oid));
      const saved = join(getArchivedContainerDir('a', 'one'), 'saved.txt');
      writeFileSync(saved, 'saved work');
      const now = Date.parse('2100-01-01T00:00:00.000Z');
      expect(await purgeExpiredArchivedContainersForWorkspace('a', now)).toBe(
        0,
      );
      const review = (
        await listWorktreeRecovery({ workspaceId: 'a', operationId })
      ).entries[0]?.diagnosis;
      if (!review) throw new Error('No diagnosis');
      const result = await setAsideWorktreeRecovery({
        workspaceId: 'a',
        operationId,
        revision: review.revision,
      });
      expect(result.status).toBe('set-aside');
      if (result.status !== 'set-aside') throw new Error('Not set aside');
      expect(await purgeExpiredArchivedContainersForWorkspace('a', now)).toBe(
        0,
      );
      expect(readFileSync(saved, 'utf8')).toBe('saved work');
      expect(git('rev-parse', ref)).toBe(oid);
      expect(await hasUnresolvedDestructiveRecovery('a', 'other')).toBe(false);
      expect(await hasUnresolvedDestructiveRecovery('other', 'one')).toBe(
        false,
      );
      // A damaged hold must refuse purge, not quietly lose its protection.
      const heldName = result.quarantinedNames[0];
      if (!heldName) throw new Error('No quarantined record');
      const heldPath = join(getW5QuarantinedLifecycleDir(), heldName);
      const heldBytes = readFileSync(heldPath);
      writeFileSync(heldPath, '{');
      expect(await purgeExpiredArchivedContainersForWorkspace('a', now)).toBe(
        0,
      );
      expect(git('rev-parse', ref)).toBe(oid);
      writeFileSync(heldPath, heldBytes);
      // Put-back restores the original recovery fence; only settlement releases it.
      expect(result.putBackCopies).toHaveLength(1);
      for (const [name] of copies) {
        const moved = result.putBackCopies.find(
          (entry) => entry.originalName === name,
        );
        if (!moved) throw new Error('A journal copy mapping was lost');
        renameSync(
          join(getW5QuarantinedLifecycleDir(), moved.quarantinedName),
          join(getW5DestructiveLifecycleDir(), moved.originalName),
        );
      }
      expect(await hasUnresolvedDestructiveRecovery('a', 'one')).toBe(true);
      expect(await purgeExpiredArchivedContainersForWorkspace('a', now)).toBe(
        0,
      );
      for (const [name, contents] of copies) {
        const record: unknown = JSON.parse(contents);
        if (typeof record !== 'object' || record === null)
          throw new Error('No record');
        writeFileSync(
          join(getW5DestructiveLifecycleDir(), name),
          JSON.stringify({
            ...record,
            state: 'completed',
            cleanupRequired: false,
          }),
        );
      }
      // CAN-5335 unreadable quarantine entries are not retention holds.
      writeFileSync(
        join(getW5QuarantinedLifecycleDir(), 'unreadable-record.json'),
        '{',
      );
      expect(await hasUnresolvedDestructiveRecovery('a', 'one')).toBe(false);
      expect(await purgeExpiredArchivedContainersForWorkspace('a', now)).toBe(
        1,
      );
      expect(existsSync(saved)).toBe(false);
      expect(git('for-each-ref', '--format=%(refname)', ref)).toBe('');
    });

    it.each(['malformed', 'empty', 'not-a-file', 'symlink'] as const)(
      'a %s Set aside hold protects only its project/worktree',
      async (shape) => {
        await removeOne();
        const { operationId } = await strand({ steps: SET_ASIDE_STEPS });
        const { listWorktreeRecovery } =
          await import('../worktree-recovery-description');
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        const { hasUnresolvedDestructiveRecovery } =
          await import('../w5-destructive-recovery');
        const review = (
          await listWorktreeRecovery({ workspaceId: 'a', operationId })
        ).entries[0]?.diagnosis;
        if (!review) throw new Error('No diagnosis');
        const result = await setAsideWorktreeRecovery({
          workspaceId: 'a',
          operationId,
          revision: review.revision,
        });
        if (result.status !== 'set-aside') throw new Error('Not set aside');
        const heldName = result.quarantinedNames[0];
        if (!heldName) throw new Error('No quarantined record');
        // The damaged entry alone must hold retention; there is no sibling copy.
        expect(result.quarantinedNames).toHaveLength(1);
        const heldPath = join(getW5QuarantinedLifecycleDir(), heldName);
        rmSync(heldPath);
        if (shape === 'not-a-file') mkdirSync(heldPath);
        else if (shape === 'symlink')
          symlinkSync(join(root, 'missing-hold'), heldPath);
        else writeFileSync(heldPath, shape === 'empty' ? '' : '{');
        expect(readdirSync(getW5QuarantinedLifecycleDir())).toEqual([heldName]);
        expect(await hasUnresolvedDestructiveRecovery('a', 'one')).toBe(true);
        expect(await hasUnresolvedDestructiveRecovery('a')).toBe(true);
        expect(await hasUnresolvedDestructiveRecovery('a', 'other')).toBe(
          false,
        );
        expect(await hasUnresolvedDestructiveRecovery('other', 'one')).toBe(
          false,
        );
        expect(await hasUnresolvedDestructiveRecovery('other')).toBe(false);
        const { purgeExpiredArchivedContainersForWorkspace } =
          await import('../archived-container-retention');
        const { reconcileArchivedGitRefsForWorkspace } =
          await import('../archived-container-git');
        const git = (...args: string[]): string =>
          execFileSync('git', ['-C', repo, ...args], {
            encoding: 'utf8',
          }).trim();
        const oid = git('rev-parse', 'HEAD');
        await commitArchivedContainer(retentionManifest('one', oid));
        await commitArchivedContainer(retentionManifest('other', oid));
        const saved = join(getArchivedContainerDir('a', 'one'), 'saved.txt');
        writeFileSync(saved, 'saved work');
        const heldRef = 'refs/app/archived-containers/a/one/__single_repo__';
        const unpublishedRef = 'refs/app/archived-containers/a/one/unpublished';
        const otherRef = 'refs/app/archived-containers/a/other/__single_repo__';
        git('update-ref', heldRef, oid);
        git('update-ref', unpublishedRef, oid);
        git('update-ref', otherRef, oid);
        expect(
          await purgeExpiredArchivedContainersForWorkspace(
            'a',
            Date.parse('2100-01-01T00:00:00.000Z'),
          ),
        ).toBe(1);
        expect(readFileSync(saved, 'utf8')).toBe('saved work');
        expect(existsSync(getArchivedContainerDir('a', 'other'))).toBe(false);
        await reconcileArchivedGitRefsForWorkspace('a');
        expect(git('for-each-ref', '--format=%(objectname)', heldRef)).toBe(
          oid,
        );
        // No manifest or descriptor protects this ref; only the damaged hold does.
        expect(
          git('for-each-ref', '--format=%(objectname)', unpublishedRef),
        ).toBe(oid);
        expect(git('for-each-ref', '--format=%(objectname)', otherRef)).toBe(
          '',
        );
        expect(
          result.quarantinedNames.every((name) => name.length <= 255),
        ).toBe(true);
      },
    );

    it.each(['quarantine', 'journal'])(
      'Set aside reports the moved mapping after a failed %s flush',
      async (folder) => {
        await removeOne();
        const { operationId, copies } = await strand({
          steps: SET_ASIDE_STEPS,
        });
        const { listWorktreeRecovery } =
          await import('../worktree-recovery-description');
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        const review = (
          await listWorktreeRecovery({ workspaceId: 'a', operationId })
        ).entries[0]?.diagnosis;
        if (!review) throw new Error('No diagnosis');
        const open = fsPromises.open;
        const rename = fsPromises.rename;
        let moved = false;
        const flushDirectory =
          folder === 'quarantine'
            ? getW5QuarantinedLifecycleDir()
            : getW5DestructiveLifecycleDir();
        const renameSpy = jest
          .spyOn(fsPromises, 'rename')
          .mockImplementation(async (...args) => {
            await rename(...args);
            if (
              typeof args[0] === 'string' &&
              dirname(args[0]) === getW5DestructiveLifecycleDir()
            )
              moved = true;
          });
        const openSpy = jest
          .spyOn(fsPromises, 'open')
          .mockImplementation(async (...args) => {
            if (moved && args[0] === flushDirectory)
              throw Object.assign(new Error('Injected post-rename flush'), {
                code: 'EIO',
              });
            return open(...args);
          });
        try {
          const result = await setAsideWorktreeRecovery({
            workspaceId: 'a',
            operationId,
            revision: review.revision,
          });
          const [quarantinedName] = readdirSync(getW5QuarantinedLifecycleDir());
          const [originalName, contents] = [...copies][0] ?? [];
          if (!quarantinedName || !originalName || !contents)
            throw new Error('No moved journal');
          expect(result).toEqual({
            status: 'interrupted',
            operationId,
            check: 'unconfirmed',
            moved: {
              originalName,
              quarantinedName,
              journalLocationLabel: '<data>/w5/destructive-lifecycles',
              quarantineLocationLabel: '<data>/w5/quarantined-lifecycles',
            },
          });
          expect(
            existsSync(join(getW5DestructiveLifecycleDir(), originalName)),
          ).toBe(false);
          expect(
            readFileSync(
              join(getW5QuarantinedLifecycleDir(), quarantinedName),
              'utf8',
            ),
          ).toBe(contents);
        } finally {
          openSpy.mockRestore();
          renameSpy.mockRestore();
        }
      },
    );

    it('a crash-left Set aside reservation holds only its subject until authorized cleanup', async () => {
      await removeOne();
      const { copies } = await strand({ steps: SET_ASIDE_STEPS });
      const [name, contents] = [...copies][0] ?? [];
      if (!name || !contents) throw new Error('No source copy');
      const { setAsideReadableLifecycleJournalFile } =
        await import('../w5-lifecycle-journal-quarantine');
      const {
        withExclusiveLifecycleJournalAccess,
        hasUnresolvedDestructiveRecovery,
      } = await import('../w5-destructive-recovery');
      const write = fsPromises.writeFile;
      const interrupted = jest
        .spyOn(fsPromises, 'writeFile')
        .mockImplementationOnce(async (...args) => {
          await write(...args);
          throw new Error('Injected interruption after destination claim');
        });
      try {
        await expect(
          withExclusiveLifecycleJournalAccess(() =>
            setAsideReadableLifecycleJournalFile(name, Buffer.from(contents), {
              renamed: false,
            }),
          ),
        ).rejects.toMatchObject({
          reason: 'unconfirmed',
          reservationName: expect.stringContaining('set-aside-') as unknown,
        });
      } finally {
        interrupted.mockRestore();
      }
      const leftovers = readdirSync(getW5QuarantinedLifecycleDir());
      expect(leftovers).toHaveLength(1);
      const placeholder = leftovers[0];
      if (!placeholder) throw new Error('No reserved destination');
      expect(
        readFileSync(join(getW5QuarantinedLifecycleDir(), placeholder)),
      ).toEqual(Buffer.alloc(0));
      for (const [sourceName, sourceContents] of copies) {
        expect(
          readFileSync(
            join(getW5DestructiveLifecycleDir(), sourceName),
            'utf8',
          ),
        ).toBe(sourceContents);
        writeFileSync(
          join(getW5DestructiveLifecycleDir(), sourceName),
          JSON.stringify({
            ...journalSchema.parse(JSON.parse(sourceContents)),
            state: 'completed',
            cleanupRequired: false,
          }),
        );
      }
      // An empty reservation is indistinguishable from a truncated held journal.
      expect(await hasUnresolvedDestructiveRecovery('a', 'one')).toBe(true);
      expect(await hasUnresolvedDestructiveRecovery('a', 'other')).toBe(false);
      expect(await hasUnresolvedDestructiveRecovery('other')).toBe(false);
      // Simulate authorized offline removal after proving the live copy settled.
      rmSync(join(getW5QuarantinedLifecycleDir(), placeholder));
      expect(await hasUnresolvedDestructiveRecovery('a', 'one')).toBe(false);
    });

    it('unknown unscoped Set aside evidence still fails retention closed', async () => {
      const { hasUnresolvedDestructiveRecovery } =
        await import('../w5-destructive-recovery');
      mkdirSync(getW5QuarantinedLifecycleDir(), { recursive: true });
      for (const name of [
        'set-aside-unscoped.json',
        `set-aside-${'a'.repeat(64)}-unknown.json`,
      ]) {
        const path = join(getW5QuarantinedLifecycleDir(), name);
        writeFileSync(path, '{');
        expect(await hasUnresolvedDestructiveRecovery('a', 'one')).toBe(true);
        expect(await hasUnresolvedDestructiveRecovery('other')).toBe(true);
        rmSync(path);
      }
    });

    it('Set aside preserves unpublished Git snapshots during retention reconciliation', async () => {
      await removeOne();
      const { operationId } = await strand({ steps: SET_ASIDE_STEPS });
      const { listWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const { setAsideWorktreeRecovery } =
        await import('../worktree-recovery-set-aside');
      const { reconcileArchivedGitRefsForWorkspace } =
        await import('../archived-container-git');
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      const oid = git('rev-parse', 'HEAD');
      const ref = 'refs/app/archived-containers/a/one/__single_repo__';
      git('update-ref', ref, oid);
      await reconcileArchivedGitRefsForWorkspace('a');
      expect(git('for-each-ref', '--format=%(objectname)', ref)).toBe(oid);
      const review = (
        await listWorktreeRecovery({ workspaceId: 'a', operationId })
      ).entries[0]?.diagnosis;
      if (!review) throw new Error('No diagnosis');
      expect(
        await setAsideWorktreeRecovery({
          workspaceId: 'a',
          operationId,
          revision: review.revision,
        }),
      ).toMatchObject({ status: 'set-aside' });
      const unrelated = 'refs/app/archived-containers/a/other/__single_repo__';
      git('update-ref', unrelated, oid);
      await reconcileArchivedGitRefsForWorkspace('a');
      expect(git('for-each-ref', '--format=%(objectname)', ref)).toBe(oid);
      expect(git('for-each-ref', '--format=%(objectname)', unrelated)).toBe('');
    });

    it('an unreadable selected receipt refuses without misclassifying journal evidence', async () => {
      await removeOne();
      const { operationId, copies } = await strand({ steps: SET_ASIDE_STEPS });
      const { readArchiveJournalOperations } =
        await import('../stranded-archive-journals');
      const { setAsideWorktreeRecovery } =
        await import('../worktree-recovery-set-aside');
      const { archiveRecoveryStore } = await import('../archive-recovery-refs');
      const review = (await readArchiveJournalOperations('a')).operations[0];
      if (!review) throw new Error('No review');
      const selected = archiveRecoveryStore().directory({
        workspaceId: 'a',
        operationId,
      });
      mkdirSync(selected, { recursive: true });
      writeFileSync(join(selected, 'receipt.json'), '{');
      expect(
        await setAsideWorktreeRecovery({
          workspaceId: 'a',
          operationId,
          revision: review.revision,
        }),
      ).toEqual({ status: 'refused', operationId, check: 'not-eligible' });
      for (const [name, contents] of copies)
        expect(
          readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
        ).toBe(contents);
    });

    it.each(['before review', 'preflight', 'before rename'])(
      'rejects raw-byte drift with identical decoded UTF-8 (%s)',
      async (when) => {
        await removeOne();
        const { operationId, copies } = await strand({
          steps: SET_ASIDE_STEPS,
          outcome: 'RAW_BYTE_MARKER',
        });
        const raw = (contents: string, byte: number): Buffer => {
          const [before, after] = contents.split('RAW_BYTE_MARKER');
          if (before === undefined || after === undefined)
            throw new Error('No marker');
          return Buffer.concat([
            Buffer.from(before),
            Buffer.from([byte]),
            Buffer.from(after),
          ]);
        };
        const [name, contents] =
          [...copies].sort(([a], [b]) => a.localeCompare(b))[0] ?? [];
        if (!name || !contents) throw new Error('No copy');
        const path = join(getW5DestructiveLifecycleDir(), name);
        const original = raw(contents, 0x80);
        const changed = raw(contents, 0x81);
        expect(original.toString('utf8')).toBe(changed.toString('utf8'));
        writeFileSync(path, original);
        const { readArchiveJournalOperations } =
          await import('../stranded-archive-journals');
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        const recovery = await import('../w5-destructive-recovery');
        const quarantine = await import('../w5-lifecycle-journal-quarantine');
        const review = (await readArchiveJournalOperations('a')).operations[0];
        if (!review) throw new Error('No review');
        let restore = (): void => {};
        if (when === 'before review') writeFileSync(path, changed);
        else if (when === 'preflight') {
          const exclusive = recovery.withExclusiveLifecycleJournalAccess;
          const spy = jest
            .spyOn(recovery, 'withExclusiveLifecycleJournalAccess')
            .mockImplementationOnce((work) =>
              exclusive(async () => {
                writeFileSync(path, changed);
                return work();
              }),
            );
          restore = (): void => spy.mockRestore();
        } else {
          const move = quarantine.setAsideReadableLifecycleJournalFile;
          const spy = jest
            .spyOn(quarantine, 'setAsideReadableLifecycleJournalFile')
            .mockImplementationOnce((...args) => {
              writeFileSync(path, changed);
              return move(...args);
            });
          restore = (): void => spy.mockRestore();
        }
        try {
          expect(
            await setAsideWorktreeRecovery({
              workspaceId: 'a',
              operationId,
              revision: review.revision,
            }),
          ).toEqual({
            status: 'refused',
            operationId,
            check: 'revision-changed',
          });
          expect(readFileSync(path)).toEqual(changed);
          for (const [otherName, otherContents] of copies)
            if (otherName !== name)
              expect(
                readFileSync(
                  join(getW5DestructiveLifecycleDir(), otherName),
                  'utf8',
                ),
              ).toBe(otherContents);
        } finally {
          restore();
        }
      },
    );

    it.each([
      'identity stat',
      'reservation stat',
      'rename',
      'cleanup unlink',
      'cleanup sync EIO',
      'cleanup sync ENOENT',
      'replacement',
    ])(
      'a caught reservation failure cleans only its own placeholder or reports it (%s)',
      async (failure) => {
        await removeOne();
        const { operationId, copies } = await strand({
          steps: SET_ASIDE_STEPS,
        });
        const { readArchiveJournalOperations } =
          await import('../stranded-archive-journals');
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        const review = (await readArchiveJournalOperations('a')).operations[0];
        if (!review) throw new Error('No review');
        const write = fsPromises.writeFile;
        const stat = fsPromises.lstat;
        const unlink = fsPromises.unlink;
        const rename = fsPromises.rename;
        const open = fsPromises.open;
        let reserved: string | null = null;
        let failed = false;
        let removed = false;
        const injected = Object.assign(
          new Error('Injected reservation failure'),
          { code: 'EIO' },
        );
        const writeSpy = jest
          .spyOn(fsPromises, 'writeFile')
          .mockImplementation(async (...args) => {
            await write(...args);
            if (
              typeof args[0] === 'string' &&
              dirname(args[0]) === getW5QuarantinedLifecycleDir()
            )
              reserved = args[0];
          });
        const statSpy = jest
          .spyOn(fsPromises, 'lstat')
          .mockImplementation(async (...args) => {
            if (
              reserved &&
              !failed &&
              ((failure === 'reservation stat' && args[0] === reserved) ||
                (failure !== 'reservation stat' &&
                  typeof args[0] === 'string' &&
                  dirname(args[0]) === getW5DestructiveLifecycleDir()))
            ) {
              failed = true;
              if (failure === 'replacement') {
                const replacement = join(
                  getW5QuarantinedLifecycleDir(),
                  'replacement.tmp',
                );
                writeFileSync(replacement, 'replacement stays');
                renameSync(replacement, reserved);
              }
              if (failure !== 'rename') throw injected;
            }
            return stat(...args);
          });
        const unlinkSpy = jest
          .spyOn(fsPromises, 'unlink')
          .mockImplementation(async (...args) => {
            if (failure === 'cleanup unlink' && args[0] === reserved)
              throw injected;
            await unlink(...args);
            if (args[0] === reserved) removed = true;
          });
        const openSpy = jest
          .spyOn(fsPromises, 'open')
          .mockImplementation(async (...args) => {
            if (
              removed &&
              failure.startsWith('cleanup sync') &&
              args[0] === getW5QuarantinedLifecycleDir()
            )
              throw Object.assign(new Error('Injected cleanup sync failure'), {
                code: failure === 'cleanup sync ENOENT' ? 'ENOENT' : 'EIO',
              });
            return open(...args);
          });
        const renameSpy = jest
          .spyOn(fsPromises, 'rename')
          .mockImplementation(async (...args) => {
            if (failure === 'rename' && args[1] === reserved) throw injected;
            return rename(...args);
          });
        try {
          const result = await setAsideWorktreeRecovery({
            workspaceId: 'a',
            operationId,
            revision: review.revision,
          });
          expect(failed).toBe(true);
          const leftovers = readdirSync(getW5QuarantinedLifecycleDir());
          if (failure === 'identity stat' || failure === 'rename') {
            expect(result.status).toBe('refused');
            expect(leftovers).toEqual([]);
          } else {
            expect(leftovers).toHaveLength(
              failure.startsWith('cleanup sync') ? 0 : 1,
            );
            expect(result).toMatchObject({
              status: 'interrupted',
              check: 'unconfirmed',
              reservation: {
                quarantinedName: expect.stringContaining(
                  'set-aside-',
                ) as unknown,
                quarantineLocationLabel: '<data>/w5/quarantined-lifecycles',
              },
            });
            if (result.status !== 'interrupted' || !result.reservation)
              throw new Error('Missing reservation report');
            expect(
              join(
                getW5QuarantinedLifecycleDir(),
                result.reservation.quarantinedName,
              ),
            ).toBe(reserved);
            if (failure === 'replacement')
              expect(
                readFileSync(
                  join(getW5QuarantinedLifecycleDir(), leftovers[0] ?? ''),
                  'utf8',
                ),
              ).toBe('replacement stays');
          }
          for (const [name, contents] of copies)
            expect(
              readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
            ).toBe(contents);
        } finally {
          writeSpy.mockRestore();
          statSpy.mockRestore();
          unlinkSpy.mockRestore();
          renameSpy.mockRestore();
          openSpy.mockRestore();
        }
      },
    );

    it.each(['before rename', 'after rename', 'after rename identity stat'])(
      'a failed final evidence check leaves the journal in place and no placeholder (%s)',
      async (when) => {
        await removeOne();
        const { copies } = await strand({ steps: SET_ASIDE_STEPS });
        const [name, contents] = [...copies][0] ?? [];
        if (!name || !contents) throw new Error('No copy');
        const source = join(getW5DestructiveLifecycleDir(), name);
        const fs = fsPromises;
        const quarantine = await import('../w5-lifecycle-journal-quarantine');
        const write = fs.writeFile;
        const rename = fs.rename;
        const read = jest.spyOn(fs, 'readFile');
        const stat = jest.spyOn(fs, 'lstat');
        const failRead = (): void => {
          const error = new Error('Injected final evidence check failure');
          if (when === 'after rename identity stat')
            stat.mockRejectedValueOnce(error);
          else read.mockRejectedValueOnce(error);
        };
        const writeSpy = jest
          .spyOn(fs, 'writeFile')
          .mockImplementationOnce(async (...args) => {
            await write(...args);
            if (when === 'before rename') failRead();
          });
        const renameSpy = jest
          .spyOn(fs, 'rename')
          .mockImplementationOnce(async (...args) => {
            await rename(...args);
            if (when.startsWith('after rename')) failRead();
          });
        const progress = { renamed: false };
        try {
          await expect(
            quarantine.setAsideReadableLifecycleJournalFile(
              name,
              Buffer.from(contents),
              progress,
            ),
          ).rejects.toThrow();
          expect(existsSync(source)).toBe(true);
          expect(readFileSync(source, 'utf8')).toBe(contents);
          expect(progress.renamed).toBe(false);
          expect(readdirSync(getW5QuarantinedLifecycleDir())).toEqual([]);
        } finally {
          writeSpy.mockRestore();
          renameSpy.mockRestore();
          read.mockRestore();
          stat.mockRestore();
        }
      },
    );

    it.each(['valid UTF-8', 'invalid UTF-8'])(
      'preserves the receipt text contract and moves exact reviewed bytes (%s)',
      async (encoding) => {
        await removeOne();
        const { operationId, copies } = await strand({
          steps: SET_ASIDE_STEPS,
          outcome: '日本語🦦',
        });
        const expected = new Map<string, Buffer>();
        for (const [name, contents] of copies) {
          const [before, after] = contents.split('日本語🦦');
          if (before === undefined || after === undefined)
            throw new Error('No marker');
          // Keep the invalid sequence inside a JSON string, which remains readable.
          const persisted =
            encoding === 'valid UTF-8'
              ? Buffer.from(contents)
              : Buffer.concat([
                  Buffer.from(before),
                  Buffer.from([0x80]),
                  Buffer.from(after),
                ]);
          writeFileSync(join(getW5DestructiveLifecycleDir(), name), persisted);
          expected.set(name, persisted);
        }
        const { createHash } = await import('node:crypto');
        const { readArchiveJournalOperations } =
          await import('../stranded-archive-journals');
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        const review = (await readArchiveJournalOperations('a')).operations[0];
        if (!review) throw new Error('No review');
        const legacy = createHash('sha256');
        for (const source of review.sources) {
          legacy
            .update(source.name)
            .update('\0')
            .update(source.contents)
            .update('\0');
          expect(source.digest).toBe(
            createHash('sha256').update(source.contents).digest('hex'),
          );
        }
        if (encoding === 'valid UTF-8')
          expect(review.revision).toBe(legacy.digest('hex'));
        else expect(review.revision).not.toBe(legacy.digest('hex'));
        const result = await setAsideWorktreeRecovery({
          workspaceId: 'a',
          operationId,
          revision: review.revision,
        });
        if (result.status !== 'set-aside')
          throw new Error(`Not set aside: ${result.status}`);
        for (const [name, bytes] of expected) {
          const destination = result.quarantinedNames.find((entry) =>
            entry.endsWith(`-${name}`),
          );
          if (!destination) throw new Error('Lost copy');
          expect(
            readFileSync(join(getW5QuarantinedLifecycleDir(), destination)),
          ).toEqual(bytes);
        }
      },
    );

    it('a drifted device keeps Keep where device drift is tolerated and offers Set aside elsewhere', async () => {
      const recorded = [
        statIdentity(getWorkspaceDir('a')),
        statIdentity(checkout()),
      ];
      const { operationId } = await strand({
        directoryIdentity: drifted(recorded[0] ?? ''),
        ownedPaths: [
          { path: checkout(), identity: drifted(recorded[1] ?? '') },
        ],
      });
      // CAN-7638: macOS, and Linux with a recorded birth time, accept a
      // device-only difference; Windows and birth-time-less Linux stay exact.
      const tolerated =
        process.platform === 'darwin' ||
        (process.platform === 'linux' &&
          recorded.every((identity) => Number(identity.split(':')[2]) !== 0));
      expect(await offeredActions(operationId)).toEqual(
        tolerated ? ['keep-worktree', 'discard'] : ['set-aside'],
      );
    });

    it('a drifted device under the device-exact rule offers only Set aside on every runner', async () => {
      // Jest runs on Linux and macOS, which both tolerate drift; apply the
      // Windows rule so the Set aside fallback stays covered.
      const matches =
        recordedDirectoryIdentity.matchesRecordedDirectoryIdentity;
      const exact = jest
        .spyOn(recordedDirectoryIdentity, 'matchesRecordedDirectoryIdentity')
        .mockImplementation((recorded, live) =>
          matches(recorded, live, 'win32'),
        );
      const { operationId } = await strand({
        directoryIdentity: drifted(statIdentity(getWorkspaceDir('a'))),
        ownedPaths: [
          { path: checkout(), identity: drifted(statIdentity(checkout())) },
        ],
      });
      expect(await offeredActions(operationId)).toEqual(['set-aside']);
      expect(exact).toHaveBeenCalled();
    });

    it('an unlisted archive past Git capture offers only Set aside, and moves it aside bytes unchanged', async () => {
      await removeOne();
      const { operationId, copies } = await strand({
        steps: SET_ASIDE_STEPS,
      });
      expect(await offeredActions(operationId)).toEqual(['set-aside']);
      const { listWorktreeRecovery } =
        await import('../worktree-recovery-description');
      const { setAsideWorktreeRecovery } =
        await import('../worktree-recovery-set-aside');
      const { readBlockingDestructiveRecoveries } =
        await import('../w5-destructive-recovery');
      const review = (
        await listWorktreeRecovery({ workspaceId: 'a', operationId })
      ).entries[0]?.diagnosis;
      if (!review) throw new Error('No diagnosis');
      expect(
        (await readBlockingDestructiveRecoveries('a', 'one')).map(
          (entry) => entry.operationId,
        ),
      ).toContain(operationId);

      // A stale review moves nothing.
      expect(
        await setAsideWorktreeRecovery({
          workspaceId: 'a',
          operationId,
          revision: '0'.repeat(64),
        }),
      ).toEqual({ status: 'refused', operationId, check: 'revision-changed' });
      // An unfinished Keep/Release on the same copies keeps them in place.
      const { archiveRecoveryStore } = await import('../archive-recovery-refs');
      const { readArchiveJournalOperations } =
        await import('../stranded-archive-journals');
      const source = (await readArchiveJournalOperations('a')).operations.find(
        (entry) => entry.record.operationId === operationId,
      );
      if (!source) throw new Error('No source journal');
      const store = archiveRecoveryStore();
      const receipt = await store.prepare({
        workspaceId: 'a',
        worktreeId: 'one',
        operationId,
        action: 'release',
        revision: review.revision,
        createdAt: source.record.createdAt ?? '',
        copies: source.sources,
        sourceRecord: source.record,
        repositories: [],
        capture: 'none',
      });
      expect(
        (await listWorktreeRecovery({ workspaceId: 'a', operationId }))
          .entries[0]?.actions.setAside,
      ).toEqual({ eligible: false, reason: 'not-admitted' });
      expect(
        await setAsideWorktreeRecovery({
          workspaceId: 'a',
          operationId,
          revision: review.revision,
        }),
      ).toEqual({
        status: 'refused',
        operationId,
        check: 'resolution-pending',
      });
      rmSync(store.directory(receipt), { recursive: true });
      // A live owner keeps its journal.
      const recovery = await import('../w5-destructive-recovery');
      const owned = jest
        .spyOn(recovery, 'isDestructiveRecoveryOwnerless')
        .mockReturnValue(false);
      expect(
        await setAsideWorktreeRecovery({
          workspaceId: 'a',
          operationId,
          revision: review.revision,
        }),
      ).toEqual({ status: 'refused', operationId, check: 'not-eligible' });
      owned.mockRestore();
      for (const [name, contents] of copies)
        expect(
          readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
        ).toBe(contents);

      const runtime = recoveryRuntime();
      const result = await runtime
        .instruction(
          'core.worktree.recovery.setAside',
          { workspaceId: 'a', operationId, revision: review.revision },
          { caller: RECOVERY_USER },
        )
        .finally(() => runtime.shutdown());
      expect(result).toMatchObject({
        status: 'set-aside',
        operationId,
        quarantineLocationLabel: '<data>/w5/quarantined-lifecycles',
        journalLocationLabel: '<data>/w5/destructive-lifecycles',
      });
      if (result.status !== 'set-aside') throw new Error('Not set aside');
      expect(result.quarantinedNames).toHaveLength(copies.size);
      expect(result.putBackCopies).toHaveLength(copies.size);
      const quarantined = readdirSync(getW5QuarantinedLifecycleDir());
      expect(quarantined.sort()).toEqual([...result.quarantinedNames].sort());
      for (const [name, contents] of copies) {
        expect(existsSync(join(getW5DestructiveLifecycleDir(), name))).toBe(
          false,
        );
        const moved = quarantined.find((entry) => entry.endsWith(`-${name}`));
        if (!moved) throw new Error(`${name} was not quarantined`);
        expect(result.putBackCopies).toContainEqual({
          originalName: name,
          quarantinedName: moved,
        });
        // Bytes unchanged and a single link: nothing a scanner refuses on.
        const path = join(getW5QuarantinedLifecycleDir(), moved);
        expect(readFileSync(path, 'utf8')).toBe(contents);
        expect(lstatSync(path).nlink).toBe(1);
      }
      expect(
        (await listWorktreeRecovery({ workspaceId: 'a' })).entries.some(
          (entry) => entry.diagnosis?.operationId === operationId,
        ),
      ).toBe(false);
      expect(await readBlockingDestructiveRecoveries('a', 'one')).toEqual([]);
      // Replaying the same review finds nothing left to move.
      expect(
        await setAsideWorktreeRecovery({
          workspaceId: 'a',
          operationId,
          revision: review.revision,
        }),
      ).toEqual({ status: 'refused', operationId, check: 'revision-changed' });
    });

    // These are the explicit exceptions to the every-entry invariant (q-31 a).
    // CAN-7284 owns multi-copy Set aside, including mixed archive/delete copies.
    it.each([
      { shape: 'consistent archive copies', check: 'quarantine-unqualified' },
      {
        shape: 'conflicting archive copies',
        check: 'conflicting-journal-copies',
      },
      {
        shape: 'mixed archive/delete copies',
        check: 'conflicting-journal-copies',
      },
      {
        shape: 'settled/unfinished archive copies',
        check: 'conflicting-journal-copies',
      },
    ])(
      'excludes $shape: no Set aside offer or execution',
      async ({ shape, check }) => {
        await removeOne();
        const { operationId, copies } = await strand({
          steps: SET_ASIDE_STEPS,
        });
        const original = [...copies.values()][0];
        if (!original) throw new Error('No original journal');
        const contents = JSON.stringify({
          ...journalSchema.parse(JSON.parse(original)),
          ...(shape === 'conflicting archive copies'
            ? { outcome: 'different' }
            : {}),
          ...(shape === 'mixed archive/delete copies'
            ? { operation: 'worktree-delete' }
            : {}),
          ...(shape === 'settled/unfinished archive copies'
            ? { state: 'completed', cleanupRequired: false }
            : {}),
        });
        const historyName = `${operationId}.json`;
        writeFileSync(
          join(getW5DestructiveLifecycleDir(), historyName),
          contents,
        );
        copies.set(historyName, contents);
        expect(
          await offeredActions(operationId, [{ copies: 2, check }]),
        ).toEqual([]);
        const { readArchiveJournalOperations } =
          await import('../stranded-archive-journals');
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        const quarantine = await import('../w5-lifecycle-journal-quarantine');
        const review = (
          await readArchiveJournalOperations('a')
        ).operations.find((entry) => entry.record.operationId === operationId);
        if (!review) throw new Error('No diagnosis');
        expect(review.copies).toBe(2);
        expect(review.consistent).toBe(shape === 'consistent archive copies');
        const move = jest.spyOn(
          quarantine,
          'setAsideReadableLifecycleJournalFile',
        );
        try {
          expect(
            await setAsideWorktreeRecovery({
              workspaceId: 'a',
              operationId,
              revision: review.revision,
            }),
          ).toEqual({
            status: 'refused',
            operationId,
            check: 'not-eligible',
          });
          expect(move).not.toHaveBeenCalled();
        } finally {
          move.mockRestore();
        }
        for (const [name, bytes] of copies)
          expect(
            readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
          ).toBe(bytes);
        expect(existsSync(getW5QuarantinedLifecycleDir())).toBe(false);
      },
    );

    it.each([
      { when: 'before review', operation: 'worktree-archive' },
      { when: 'before review', operation: 'worktree-delete' },
      { when: 'under exclusive access', operation: 'worktree-archive' },
      { when: 'under exclusive access', operation: 'worktree-delete' },
    ])(
      'a second $operation copy appearing $when refuses without moving either copy',
      async ({ when, operation }) => {
        await removeOne();
        const { operationId, copies } = await strand({
          steps: SET_ASIDE_STEPS,
        });
        expect(await offeredActions(operationId)).toEqual(['set-aside']);
        const { readArchiveJournalOperations } =
          await import('../stranded-archive-journals');
        const { setAsideWorktreeRecovery } =
          await import('../worktree-recovery-set-aside');
        const recovery = await import('../w5-destructive-recovery');
        const review = (await readArchiveJournalOperations('a')).operations[0];
        const contents = [...copies.values()][0];
        if (!review || !contents) throw new Error('No review');
        const appearedContents = JSON.stringify({
          ...journalSchema.parse(JSON.parse(contents)),
          operation,
        });
        const history = join(
          getW5DestructiveLifecycleDir(),
          `${operationId}.json`,
        );
        const exclusive = recovery.withExclusiveLifecycleJournalAccess;
        const lock = jest.spyOn(
          recovery,
          'withExclusiveLifecycleJournalAccess',
        );
        if (when === 'before review') writeFileSync(history, appearedContents);
        else
          lock.mockImplementationOnce((work) =>
            exclusive(async () => {
              writeFileSync(history, appearedContents);
              return work();
            }),
          );
        try {
          expect(
            await setAsideWorktreeRecovery({
              workspaceId: 'a',
              operationId,
              revision: review.revision,
            }),
          ).toEqual({
            status: 'refused',
            operationId,
            check: 'revision-changed',
          });
          expect(readFileSync(history, 'utf8')).toBe(appearedContents);
          for (const [name, bytes] of copies)
            expect(
              readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
            ).toBe(bytes);
          expect(existsSync(getW5QuarantinedLifecycleDir())).toBe(false);
        } finally {
          lock.mockRestore();
        }
      },
    );

    it.each(['pre-Git-capture with files', 'completed'])(
      'Set aside executes for %s without touching working files',
      async (shape) => {
        const kept = join(checkout(), 'kept.txt');
        if (shape === 'completed') await removeOne();
        else writeFileSync(kept, 'working files stay');
        const { operationId, copies } = await strand(
          shape === 'completed'
            ? { state: 'completed', cleanupRequired: true }
            : {
                steps: PRE_GIT_CAPTURE,
                ownedPaths: [{ path: checkout(), identity: '1:2:3' }],
              },
        );
        expect(await offeredActions(operationId)).toEqual(['set-aside']);
        const runtime = recoveryRuntime();
        const rename = jest.spyOn(fsPromises, 'rename');
        try {
          const listed = await runtime.query(
            'core.worktree.recovery.list',
            { workspaceId: 'a', operationId },
            { caller: RECOVERY_USER },
          );
          const diagnosis = listed.entries[0]?.diagnosis;
          if (!diagnosis) throw new Error('No reviewed journal');
          const result = await runtime.instruction(
            'core.worktree.recovery.setAside',
            { workspaceId: 'a', operationId, revision: diagnosis.revision },
            { caller: RECOVERY_USER },
          );
          expect(result.status).toBe('set-aside');
          if (result.status !== 'set-aside') throw new Error('Not set aside');
          expect(
            rename.mock.calls.filter(
              ([source, destination]) =>
                typeof source === 'string' &&
                dirname(source) === getW5DestructiveLifecycleDir() &&
                typeof destination === 'string' &&
                dirname(destination) === getW5QuarantinedLifecycleDir(),
            ),
          ).toHaveLength(1);
          for (const [name, contents] of copies) {
            const moved = result.quarantinedNames.find((entry) =>
              entry.endsWith(`-${name}`),
            );
            if (!moved) throw new Error('A journal copy was lost');
            expect(
              readFileSync(join(getW5QuarantinedLifecycleDir(), moved), 'utf8'),
            ).toBe(contents);
          }
          expect(
            (
              await runtime.query(
                'core.worktree.recovery.list',
                { workspaceId: 'a', operationId },
                { caller: RECOVERY_USER },
              )
            ).entries,
          ).toEqual([]);
          if (shape !== 'completed')
            expect(readFileSync(kept, 'utf8')).toBe('working files stay');
        } finally {
          rename.mockRestore();
          await runtime.shutdown();
        }
      },
    );
  });
});

describe('CAN-6776 Git snapshot refusals', () => {
  const checkout = (): string => join(root, 'a', 'worktrees', 'one');
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-C',
        cwd,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'protocol.file.allow=always',
        ...args,
      ],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        // An installed Git LFS's `filter.lfs.process` would outrank the
        // fixture's own LFS clean and smudge commands.
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    ).trim();
  /** Every file below `path` with its bytes, skipping Git metadata. */
  const files = (path: string): Record<string, string> => {
    const entries: Record<string, string> = {};
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir).sort()) {
        if (name === '.git') continue;
        const full = join(dir, name);
        const rel = `${prefix}${name}`;
        if (lstatSync(full).isDirectory()) walk(full, `${rel}/`);
        else entries[rel] = readFileSync(full).toString('base64');
      }
    };
    walk(path, '');
    return entries;
  };
  const encoded = (text: string): string =>
    Buffer.from(text, 'utf8').toString('base64');
  async function archive(): Promise<{ warnings: string[] }> {
    const { archiveSingleRepoWorktree } = await import('../worktree-service');
    return archiveSingleRepoWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      repoPath: repo,
    });
  }
  async function readManifest(): Promise<ArchivedContainerManifest> {
    const { isArchivedContainerManifest } =
      await import('@canopy/desktop-shared/lib/archived-container-contracts');
    const value: unknown = JSON.parse(
      readFileSync(
        join(getArchivedContainerDir('a', 'one'), 'container.json'),
        'utf8',
      ),
    );
    if (!isArchivedContainerManifest(value))
      throw new Error('Invalid archive manifest');
    return value;
  }
  async function restore(): Promise<{ path: string; warnings: string[] }> {
    const { restoreArchivedContainer } =
      await import('../archived-container-restore');
    const restored = await restoreArchivedContainer('a', 'one');
    if (!restored.restoredWorktreeId)
      throw new Error('Restore created no worktree');
    return {
      path: join(root, 'a', 'worktrees', restored.restoredWorktreeId),
      warnings: restored.warnings,
    };
  }
  async function journal(): Promise<DestructiveRecoveryRecord | null> {
    return readDestructiveRecovery('a', 'one');
  }
  /** The saved completion record, which a missing journal never satisfies. */
  async function completedArchive(): Promise<DestructiveRecoveryRecord> {
    const completed = await findCompletedDestructiveArchive('a', 'one');
    if (!completed) throw new Error('No completed archive record');
    return completed;
  }
  /** Committed transforming attributes; LFS drivers are left unconfigured. */
  function commitTransformingAttributes(): void {
    writeFileSync(
      join(checkout(), '.gitattributes'),
      '* text=auto eol=lf\n*.bin filter=lfs diff=lfs merge=lfs -text\n',
    );
    writeFileSync(join(checkout(), 'crlf.txt'), 'one\r\ntwo\r\n');
    writeFileSync(join(checkout(), 'asset.bin'), 'payload-1');
    git(checkout(), '-c', 'filter.lfs.clean=cat', 'add', '-A');
    git(checkout(), '-c', 'filter.lfs.clean=cat', 'commit', '-q', '-m', 'eol');
  }
  /** From here on, any LFS filter Git runs in the repository fails it. */
  function failLfsFilters(): void {
    git(repo, 'config', 'filter.lfs.required', 'true');
    // Repository config outranks an installed Git LFS's process driver.
    git(repo, 'config', 'filter.lfs.process', 'false');
    git(repo, 'config', 'filter.lfs.clean', 'false');
    git(repo, 'config', 'filter.lfs.smudge', 'false');
  }
  /** A fake installed Git that reports `version` and runs the real one. */
  function useGitVersionForCapture(version: string): void {
    const wrapper = join(dir, 'old-git');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi\nexec git "$@"\n`,
      { mode: 0o755 },
    );
    mockArchiveIoFault = (request): void => {
      if (request.type === 'capture-git')
        request.input.git.executable = wrapper;
    };
  }

  it('archives transforming attributes losslessly and restores every byte without running their filters', async () => {
    commitTransformingAttributes();
    // Stat-clean CRLF bytes whose index blob is the normalized LF form.
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(checkout(), 'crlf.txt'), past, past);
    git(checkout(), '-c', 'filter.lfs.clean=cat', 'update-index', '--refresh');
    // Staged and unstaged changes, a same-sized LFS edit, untracked bytes.
    writeFileSync(join(checkout(), 'staged.txt'), 'staged\r\n');
    git(checkout(), '-c', 'filter.lfs.clean=cat', 'add', 'staged.txt');
    writeFileSync(join(checkout(), 'staged.txt'), 'staged edit\r\n');
    writeFileSync(join(checkout(), 'asset.bin'), 'payload-2');
    writeFileSync(join(checkout(), 'notes.txt'), 'notes\r\n');
    failLfsFilters();
    const before = files(checkout());
    const index = git(checkout(), 'ls-files', '-s');
    expect(before['crlf.txt']).toBe(encoded('one\r\ntwo\r\n'));

    await archive();
    expect(existsSync(checkout())).toBe(false);
    const archived = await readManifest();
    if (archived.version !== 2) throw new Error('Expected a Git archive');
    // Builds before CAN-6776 accept only version 1 and so refuse to restore
    // it with the repository's attributes.
    expect(archived.gitState.version).toBe(2);
    const [repository] = archived.gitState.repositories;
    expect(repository?.attributePolicy).toBe('ignore-in-tree-attributes');
    if (!repository) throw new Error('Missing archived repository');
    expect(
      git(
        repo,
        'cat-file',
        'blob',
        `${repository.worktreeSnapshotCommit}:crlf.txt`,
      ),
    ).toBe('one\r\ntwo');

    const restored = await restore();
    expect(files(restored.path)).toEqual(before);
    expect(git(restored.path, 'ls-files', '-s')).toBe(index);
    // Still at the archived commit, the kept branch is reused.
    expect(git(restored.path, 'symbolic-ref', '--short', 'HEAD')).toBe('old');
    expect(restored.warnings.join('\n')).not.toContain('could not be reused');
  });

  it('keeps Git-state version 1 for an archive without an attribute policy', async () => {
    writeFileSync(join(checkout(), 'notes.txt'), 'notes\n');
    await archive();
    const archived = await readManifest();
    if (archived.version !== 2) throw new Error('Expected a Git archive');
    expect(archived.gitState.version).toBe(1);
    expect(archived.gitState.repositories[0]?.attributePolicy).toBeUndefined();
  });

  it('restores at the archived commit on a new branch, every byte intact, when the kept branch has advanced', async () => {
    // A clean checkout whose CRLF bytes sit over the normalized LF index blob.
    commitTransformingAttributes();
    const before = files(checkout());
    expect(before['crlf.txt']).toBe(encoded('one\r\ntwo\r\n'));
    const index = git(checkout(), 'ls-files', '-s');
    await archive();
    const archived = await readManifest();
    if (archived.version !== 2) throw new Error('Expected a Git archive');
    const [repository] = archived.gitState.repositories;
    if (!repository) throw new Error('Missing archived repository');
    expect(repository.attributePolicy).toBe('ignore-in-tree-attributes');
    // The kept branch then edits the same line of that file.
    const advance = join(dir, 'advance');
    git(repo, 'worktree', 'add', '-q', advance, 'old');
    writeFileSync(join(advance, 'crlf.txt'), 'one\ntwo later\n');
    git(advance, 'commit', '-q', '-am', 'later');
    git(repo, 'worktree', 'remove', '--force', advance);
    const branchTip = git(repo, 'rev-parse', 'refs/heads/old');

    const restored = await restore();
    expect(files(restored.path)).toEqual(before);
    expect(git(restored.path, 'ls-files', '-s')).toBe(index);
    expect(git(restored.path, 'symbolic-ref', '--short', 'HEAD')).toBe('old-2');
    expect(git(restored.path, 'rev-parse', 'HEAD')).toBe(repository.headCommit);
    expect(git(repo, 'rev-parse', 'refs/heads/old')).toBe(branchTip);
    expect(restored.warnings).toContain(
      'Local branch "old" could not be reused because it has new commits since this worktree was archived; restored as "old-2" to preserve the existing branch.',
    );
  });

  it('refuses and rolls back a restore whose kept branch moves after the branch check, keeping the branch and the archive', async () => {
    commitTransformingAttributes();
    const before = files(checkout());
    await archive();
    const snapshot = await import('../git-tree-snapshot');
    const reconstruct = snapshot.restoreIndexAndWorkingTreeSnapshot;
    let movedTip = '';
    // The branch gains a commit once the reused destination is checked out.
    const race = jest
      .spyOn(snapshot, 'restoreIndexAndWorkingTreeSnapshot')
      .mockImplementation(async (args) => {
        const head = git(args.repoPath, 'rev-parse', 'HEAD');
        movedTip = git(
          args.repoPath,
          'commit-tree',
          `${head}^{tree}`,
          '-p',
          head,
          '-m',
          'later',
        );
        git(args.repoPath, 'update-ref', 'HEAD', movedTip, head);
        return reconstruct(args);
      });
    const { readWorkspaceWorktrees } = await import('../workspace-persistence');
    const rows = async (): Promise<string[]> =>
      (await readWorkspaceWorktrees('a')).map((entry) => entry.id).sort();
    const tracked = await rows();
    const worktrees = readdirSync(join(root, 'a', 'worktrees')).sort();
    const registered = git(repo, 'worktree', 'list', '--porcelain');
    try {
      await expect(restore()).rejects.toMatchObject({
        code: 'GIT_CAPTURE_TRANSFORMING_ATTRIBUTE',
      });
    } finally {
      race.mockRestore();
    }
    expect(movedTip).not.toBe('');
    expect(git(repo, 'rev-parse', 'refs/heads/old')).toBe(movedTip);
    expect(await rows()).toEqual(tracked);
    expect(readdirSync(join(root, 'a', 'worktrees')).sort()).toEqual(worktrees);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(registered);
    expect((await readManifest()).restoredTo).toBeUndefined();

    const restored = await restore();
    expect(files(restored.path)).toEqual(before);
    expect(git(restored.path, 'symbolic-ref', '--short', 'HEAD')).toBe('old-2');
  });

  it('refuses a restore before reserving its destination when an external filter now applies to a path the project default gained', async () => {
    commitTransformingAttributes();
    writeFileSync(join(checkout(), 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    const before = files(checkout());
    await archive();
    // With the archived branch gone and the recorded base rewritten, the
    // destination starts from the project default: a history with a path no
    // snapshot has.
    git(repo, 'branch', '-D', 'old');
    git(repo, 'checkout', '-q', '--orphan', 'rewritten');
    writeFileSync(join(repo, 'later.dat'), 'later');
    git(repo, 'add', 'later.dat');
    git(repo, 'commit', '-q', '-m', 'later');
    git(repo, 'branch', '-D', 'main');
    git(repo, 'branch', '-m', 'main');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(
      join(repo, '.git', 'info', 'attributes'),
      'later.dat filter=lfs\n',
    );
    failLfsFilters();
    const { readWorkspaceWorktrees } = await import('../workspace-persistence');
    const rows = async (): Promise<string[]> =>
      (await readWorkspaceWorktrees('a')).map((entry) => entry.id).sort();
    const tracked = await rows();
    const worktrees = readdirSync(join(root, 'a', 'worktrees')).sort();
    const registered = git(repo, 'worktree', 'list', '--porcelain');
    const branches = git(repo, 'for-each-ref', 'refs/heads');

    await expect(restore()).rejects.toMatchObject({
      code: 'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
    });
    expect(await rows()).toEqual(tracked);
    expect(readdirSync(join(root, 'a', 'worktrees')).sort()).toEqual(worktrees);
    expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(registered);
    expect(git(repo, 'for-each-ref', 'refs/heads')).toBe(branches);
    expect((await readManifest()).restoredTo).toBeUndefined();

    rmSync(join(repo, '.git', 'info', 'attributes'));
    const after = files((await restore()).path);
    for (const [path, bytes] of Object.entries(before))
      expect([path, after[path]]).toEqual([path, bytes]);
  });

  it('starts a restore from the base branch its check read when that branch is named like another commit', async () => {
    commitTransformingAttributes();
    const before = files(checkout());
    // A commit with a path an external filter transforms, and a base branch
    // named after its id that points at main instead.
    const other = join(dir, 'other');
    git(repo, 'worktree', 'add', '-q', '-b', 'elsewhere', other, 'main');
    writeFileSync(join(other, 'later.dat'), 'later');
    git(other, 'add', 'later.dat');
    git(other, 'commit', '-q', '-m', 'elsewhere');
    git(repo, 'worktree', 'remove', '--force', other);
    const elsewhere = git(repo, 'rev-parse', 'refs/heads/elsewhere');
    git(repo, 'branch', elsewhere, 'main');
    await workspacePersistence.updateWorkspaceWorktree('a', 'one', (row) => ({
      ...row,
      trackedBaseBranch: elsewhere,
    }));
    await archive();
    const archived = await readManifest();
    if (archived.version !== 2) throw new Error('Expected a Git archive');
    expect(archived.gitState.repositories[0]).toMatchObject({
      attributePolicy: 'ignore-in-tree-attributes',
      comparisonBaseBranch: elsewhere,
      baseBranchCommit: git(repo, 'rev-parse', 'refs/heads/main'),
    });
    // The kept branch is gone, so the destination starts from that base.
    git(repo, 'branch', '-D', 'old');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(
      join(repo, '.git', 'info', 'attributes'),
      'later.dat filter=lfs\n',
    );
    failLfsFilters();

    const restored = await restore();
    expect(files(restored.path)).toEqual(before);
    const row = (await workspacePersistence.readWorkspaceWorktrees('a')).find(
      (entry) => restored.path.endsWith(entry.id),
    );
    expect(row?.trackedBaseBranch).toBe(elsewhere);
  });

  /**
   * A submodule whose only change is an untracked file its config hides, in
   * the submodule itself or, with `nested`, in a submodule of it.
   */
  function addSubmoduleHidingUntrackedFile(nested = false): void {
    const library = join(dir, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(join(library, 'lib.txt'), 'lib\n');
    git(library, 'add', 'lib.txt');
    if (nested) {
      const inner = join(dir, 'inner');
      mkdirSync(inner);
      git(inner, 'init', '-q', '-b', 'main');
      writeFileSync(join(inner, 'inner.txt'), 'inner\n');
      git(inner, 'add', 'inner.txt');
      git(inner, 'commit', '-q', '-m', 'inner');
      git(library, 'submodule', 'add', '-q', inner, 'inner');
    }
    git(library, 'commit', '-q', '-m', 'lib');
    git(checkout(), 'submodule', 'add', '-q', library, 'vendor/lib');
    git(checkout(), 'submodule', 'update', '-q', '--init', '--recursive');
    git(checkout(), 'commit', '-q', '-m', 'submodule');
    const submodule = join(checkout(), 'vendor', 'lib');
    const hiding = nested ? join(submodule, 'inner') : submodule;
    git(hiding, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(hiding, 'private-name-hidden.txt'), 'only copy\n');
    expect(git(submodule, 'status', '--porcelain')).toBe('');
    expect(
      git(
        checkout(),
        'status',
        '--porcelain',
        '--ignore-submodules=none',
        '-uno',
      ),
    ).toBe('');
  }

  it.each([
    [
      'conflicts',
      'GIT_CAPTURE_CONFLICTS',
      (): void => {
        writeFileSync(join(checkout(), 'shared.txt'), 'base\n');
        git(checkout(), 'add', 'shared.txt');
        git(checkout(), 'commit', '-q', '-m', 'base');
        git(checkout(), 'branch', 'other');
        writeFileSync(join(checkout(), 'shared.txt'), 'ours\n');
        git(checkout(), 'commit', '-qam', 'ours');
        git(checkout(), 'checkout', '-q', 'other');
        writeFileSync(join(checkout(), 'shared.txt'), 'theirs\n');
        git(checkout(), 'commit', '-qam', 'theirs');
        git(checkout(), 'checkout', '-q', 'old');
        expect(() => git(checkout(), 'merge', '-q', 'other')).toThrow();
      },
    ],
    [
      'intent-to-add',
      'GIT_CAPTURE_INTENT_TO_ADD',
      (): void => {
        writeFileSync(join(checkout(), 'later.txt'), 'later\n');
        git(checkout(), 'add', '-N', 'later.txt');
      },
    ],
    [
      'a dirty submodule',
      'GIT_CAPTURE_DIRTY_SUBMODULE',
      (): void => {
        const library = join(dir, 'library');
        mkdirSync(library);
        git(library, 'init', '-q', '-b', 'main');
        writeFileSync(join(library, 'lib.txt'), 'lib\n');
        git(library, 'add', 'lib.txt');
        git(library, 'commit', '-q', '-m', 'lib');
        git(checkout(), 'submodule', 'add', '-q', library, 'vendor/lib');
        git(checkout(), 'commit', '-q', '-m', 'submodule');
        writeFileSync(join(checkout(), 'vendor', 'lib', 'lib.txt'), 'dirty\n');
      },
    ],
    [
      'an untracked file in a submodule',
      'GIT_CAPTURE_DIRTY_SUBMODULE',
      (): void => {
        const library = join(dir, 'library');
        mkdirSync(library);
        git(library, 'init', '-q', '-b', 'main');
        writeFileSync(join(library, 'lib.txt'), 'lib\n');
        git(library, 'add', 'lib.txt');
        git(library, 'commit', '-q', '-m', 'lib');
        git(checkout(), 'submodule', 'add', '-q', library, 'vendor/lib');
        git(checkout(), 'commit', '-q', '-m', 'submodule');
        writeFileSync(
          join(checkout(), 'vendor', 'lib', 'private-name-untracked.txt'),
          'only copy\n',
        );
      },
    ],
    [
      'an untracked file in a submodule whose config hides untracked files',
      'GIT_CAPTURE_DIRTY_SUBMODULE',
      (): void => addSubmoduleHidingUntrackedFile(),
    ],
    [
      'an untracked file in a submodule whose config hides untracked files, under in-tree transforming attributes',
      'GIT_CAPTURE_DIRTY_SUBMODULE',
      (): void => {
        commitTransformingAttributes();
        addSubmoduleHidingUntrackedFile();
      },
    ],
    [
      'an untracked file in a nested submodule whose config hides untracked files, under in-tree transforming attributes',
      'GIT_CAPTURE_DIRTY_SUBMODULE',
      (): void => {
        commitTransformingAttributes();
        addSubmoduleHidingUntrackedFile(true);
      },
    ],
    [
      'a submodule edit only its own filter shows, under in-tree transforming attributes',
      'GIT_CAPTURE_DIRTY_SUBMODULE',
      (): void => {
        // A size-preserving filter, so Git must rehash the edit to see it.
        const rot13 = 'tr a-zA-Z n-za-mN-ZA-M';
        const library = join(dir, 'library');
        mkdirSync(library);
        git(library, 'init', '-q', '-b', 'main');
        writeFileSync(join(library, '.gitattributes'), '*.dat filter=rot13\n');
        writeFileSync(join(library, 'lib.dat'), 'hello\n');
        git(library, '-c', `filter.rot13.clean=${rot13}`, 'add', '-A');
        git(library, 'commit', '-q', '-m', 'lib');
        commitTransformingAttributes();
        git(
          checkout(),
          '-c',
          `filter.rot13.smudge=${rot13}`,
          'submodule',
          'add',
          '-q',
          library,
          'vendor/lib',
        );
        git(checkout(), 'commit', '-q', '-m', 'submodule');
        const submodule = join(checkout(), 'vendor', 'lib');
        git(submodule, 'config', 'filter.rot13.clean', rot13);
        git(submodule, 'config', 'filter.rot13.smudge', rot13);
        // Raw bytes equal to the stored blob, with a new mtime: dirty only
        // through the submodule's own filter.
        writeFileSync(join(submodule, 'lib.dat'), 'uryyb\n');
        const past = new Date('2020-01-01T00:00:00Z');
        utimesSync(join(submodule, 'lib.dat'), past, past);
        expect(git(submodule, 'status', '--porcelain')).toBe('M lib.dat');
        // A recursive status under the outer repository's attribute source
        // misses it.
        expect(
          execFileSync(
            'git',
            [
              'status',
              '--porcelain',
              '--ignore-submodules=none',
              '-uno',
              '--',
              'vendor/lib',
            ],
            {
              cwd: checkout(),
              encoding: 'utf8',
              env: {
                ...process.env,
                GIT_ATTR_SOURCE: git(
                  checkout(),
                  'hash-object',
                  '-t',
                  'tree',
                  devNull,
                ),
                GIT_OPTIONAL_LOCKS: '0',
              },
            },
          ),
        ).toBe('');
        failLfsFilters();
      },
    ],
    [
      'an untracked nested repository',
      'GIT_CAPTURE_NESTED_REPOSITORY',
      (): void => {
        mkdirSync(join(checkout(), 'private-name-nested'));
        git(join(checkout(), 'private-name-nested'), 'init', '-q');
        writeFileSync(
          join(checkout(), 'private-name-nested', 'inner.txt'),
          'inner\n',
        );
      },
    ],
    [
      'an embedded repository containing outer files',
      'GIT_CAPTURE_NESTED_REPOSITORY',
      (): void => {
        mkdirSync(join(checkout(), 'private-name-embedded'));
        writeFileSync(
          join(checkout(), 'private-name-embedded', 'outer.txt'),
          'outer\n',
        );
        git(checkout(), 'add', 'private-name-embedded/outer.txt');
        git(checkout(), 'commit', '-q', '-m', 'outer');
        git(join(checkout(), 'private-name-embedded'), 'init', '-q');
      },
    ],
    [
      'an external transforming attribute',
      'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
      (): void => {
        writeFileSync(
          join(checkout(), 'private-name-external.txt'),
          'external\r\n',
        );
        mkdirSync(join(repo, '.git', 'info'), { recursive: true });
        writeFileSync(join(repo, '.git', 'info', 'attributes'), '* text\n');
      },
    ],
    [
      'a same-sized edit under an external filter whose required clean fails',
      'GIT_CAPTURE_EXTERNAL_TRANSFORMING_ATTRIBUTE',
      (): void => {
        writeFileSync(join(checkout(), 'private-name.bin'), 'size-1');
        git(checkout(), 'add', 'private-name.bin');
        git(checkout(), 'commit', '-q', '-m', 'blob');
        writeFileSync(join(checkout(), 'private-name.bin'), 'size-2');
        mkdirSync(join(repo, '.git', 'info'), { recursive: true });
        writeFileSync(
          join(repo, '.git', 'info', 'attributes'),
          '*.bin filter=lfs\n',
        );
        failLfsFilters();
      },
    ],
    [
      'in-tree transforming attributes on Git older than 2.41',
      'GIT_CAPTURE_TRANSFORMING_ATTRIBUTE',
      (): void => {
        commitTransformingAttributes();
        failLfsFilters();
        writeFileSync(join(checkout(), 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
        useGitVersionForCapture('2.40.1 (Apple Git-143)');
      },
    ],
  ])(
    'archives files only, keeping the branch, for %s',
    async (_name, code, arrange) => {
      arrange();
      const before = files(checkout());
      const branchTip = git(repo, 'rev-parse', 'refs/heads/old');
      const logged = jest.mocked(
        (await import('../main-process-logging')).logMainProcessWarn,
      );

      const archived = await archive();
      expect(archived.warnings).toContain(
        'Recovered remaining files without Git history or staging. Branches were preserved.',
      );
      expect(existsSync(checkout())).toBe(false);
      expect(git(repo, 'rev-parse', 'refs/heads/old')).toBe(branchTip);
      const manifest = await readManifest();
      if (manifest.version !== 3) throw new Error('Expected files-only');
      expect(manifest.recovery.kind).toBe('files-only');
      expect((await completedArchive()).state).toBe('completed');
      // The local log names the refusal without a repository path.
      const refusal = logged.mock.calls.find(
        ([message]) =>
          message ===
          'Worktree archive Git capture refused; retaining files only',
      );
      expect(refusal?.[1]).toMatchObject({ code });
      expect(JSON.stringify(refusal?.[1])).not.toMatch(
        /private-name|\.gitattributes|crlf\.txt|later\.txt|\/private\/|\/tmp\//,
      );
      mockArchiveIoFault = undefined;

      const restored = await restore();
      expect(restored.warnings).toContain(
        'Restored the remaining files. Git history and staging are not restored automatically; saved Git metadata is kept separately.',
      );
      const after = files(restored.path);
      for (const [path, bytes] of Object.entries(before))
        expect([path, after[path]]).toEqual([path, bytes]);
    },
  );

  it('retries an archive an earlier build left stopped in its Git capture', async () => {
    commitTransformingAttributes();
    writeFileSync(join(checkout(), 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    const before = files(checkout());
    // The capture published its descriptor, then the archive failed the way
    // a refusal did before CAN-6776: a plain error with no snapshot code.
    mockArchiveIoAfter = (request): void => {
      if (request.type === 'capture-git')
        throw new Error(
          'Cannot archive a worktree with a transforming Git attribute "text": crlf.txt',
        );
    };
    await expect(archive()).rejects.toThrow('transforming Git attribute');
    mockArchiveIoAfter = undefined;
    const stuck = await journal();
    expect(stuck?.state).toBe('recovery-required');
    expect(stuck?.steps.at(-1)).toMatchObject({
      phase: 'git-capture',
      state: 'pending',
    });
    // A raw failure is never taken as a refusal: nothing was archived.
    expect(files(checkout())).toEqual(before);
    expect(
      existsSync(join(getArchivedContainerDir('a', 'one'), 'container.json')),
    ).toBe(false);
    if (!stuck) throw new Error('Missing journal');
    const { listWorktreeRecovery } =
      await import('../worktree-recovery-description');
    const [entry] = (
      await listWorktreeRecovery({
        workspaceId: 'a',
        operationId: stuck.operationId,
      })
    ).entries;
    expect(entry?.actions.retry).toEqual({ eligible: true });
    // A capture that keeps failing keeps its discard escape hatch.
    const { describeWorktreeDiscard } = await import('../worktree-discard');
    expect((await describeWorktreeDiscard('a', 'one')).status).toBe(
      'discardable',
    );

    await archive();
    expect(existsSync(checkout())).toBe(false);
    const archived = await readManifest();
    if (archived.version !== 2) throw new Error('Expected a Git archive');
    expect(archived.gitState.repositories[0]?.attributePolicy).toBe(
      'ignore-in-tree-attributes',
    );
    expect((await completedArchive()).supersedesArchives).toContain(
      stuck.operationId,
    );
    expect(files((await restore()).path)).toEqual(before);
  });

  it('finishes files only on retry when an earlier build stopped on a refusal that still applies', async () => {
    writeFileSync(join(checkout(), 'later.txt'), 'later\n');
    git(checkout(), 'add', '-N', 'later.txt');
    const before = files(checkout());
    const branchTip = git(repo, 'rev-parse', 'refs/heads/old');
    // Builds before CAN-6776 failed the archive on this refusal.
    mockArchiveIoFault = (request): void => {
      if (request.type === 'capture-git')
        throw new Error(
          'Cannot archive files marked intent-to-add. Stage or unstage them first.',
        );
    };
    await expect(archive()).rejects.toThrow('intent-to-add');
    mockArchiveIoFault = undefined;
    const stuck = await journal();
    expect(stuck?.steps.at(-1)).toMatchObject({
      phase: 'git-capture',
      state: 'pending',
    });
    if (!stuck) throw new Error('Missing journal');

    const archived = await archive();
    expect(archived.warnings).toContain(
      'Recovered remaining files without Git history or staging. Branches were preserved.',
    );
    const manifest = await readManifest();
    if (manifest.version !== 3) throw new Error('Expected files-only');
    expect(git(repo, 'rev-parse', 'refs/heads/old')).toBe(branchTip);
    expect((await completedArchive()).supersedesArchives).toContain(
      stuck.operationId,
    );
    const after = files((await restore()).path);
    for (const [path, bytes] of Object.entries(before))
      expect([path, after[path]]).toEqual([path, bytes]);
  });

  it('finishes files only on retry when a crash stopped the archive in its Git capture', async () => {
    writeFileSync(join(checkout(), 'later.txt'), 'later\n');
    git(checkout(), 'add', '-N', 'later.txt');
    mockArchiveIoFault = (request): void => {
      if (request.type === 'capture-git') throw new Error('capture failed');
    };
    await expect(archive()).rejects.toThrow('capture failed');
    mockArchiveIoFault = undefined;
    const stuck = await journal();
    if (!stuck) throw new Error('Missing journal');
    // A crash leaves the journal `active` with no running owner.
    for (const name of readdirSync(getW5DestructiveLifecycleDir())) {
      const path = join(getW5DestructiveLifecycleDir(), name);
      const parsed = journalSchema.parse(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      if (parsed.operationId === stuck.operationId)
        writeFileSync(path, JSON.stringify({ ...parsed, state: 'active' }));
    }

    const archived = await archive();
    expect(archived.warnings).toContain(
      'Recovered remaining files without Git history or staging. Branches were preserved.',
    );
    const manifest = await readManifest();
    if (manifest.version !== 3) throw new Error('Expected files-only');
    expect((await completedArchive()).supersedesArchives).toContain(
      stuck.operationId,
    );
  });

  it('keeps refusing a stopped capture to a delete that retains no archive', async () => {
    mockArchiveIoFault = (request): void => {
      if (request.type === 'capture-git') throw new Error('capture failed');
    };
    await expect(archive()).rejects.toThrow('capture failed');
    mockArchiveIoFault = undefined;
    const stuck = await journal();
    const before = files(checkout());
    const branchTip = git(repo, 'rev-parse', 'refs/heads/old');
    const { archiveSingleRepoWorktree } = await import('../worktree-service');

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        repoPath: repo,
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow('needs manual recovery');
    expect(files(checkout())).toEqual(before);
    expect(git(repo, 'rev-parse', 'refs/heads/old')).toBe(branchTip);
    expect(await journal()).toEqual(stuck);
  });

  it('reuses a ready capture on retry by revalidating it under its recorded attribute policy', async () => {
    commitTransformingAttributes();
    writeFileSync(join(checkout(), 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    // The capture completed, then its response was lost.
    mockArchiveIoAfter = (request): void => {
      if (request.type === 'complete-git-capture')
        throw new Error('lost response');
    };
    await expect(archive()).rejects.toThrow('lost response');
    mockArchiveIoAfter = undefined;
    const { getArchivedContainerGitStateStagedPath } = await import('../paths');
    const staged = z
      .object({
        version: z.number(),
        status: z.string(),
        repositories: z.array(
          z.object({ snapshotRef: z.string(), attributePolicy: z.string() }),
        ),
      })
      .parse(
        JSON.parse(
          readFileSync(
            getArchivedContainerGitStateStagedPath('a', 'one'),
            'utf8',
          ),
        ),
      );
    expect(staged.status).toBe('ready');
    // An earlier build that resumed this descriptor would publish it as a
    // version 1 archive; at version 2 it refuses the descriptor instead.
    expect(staged.version).toBe(2);

    await archive();
    const archived = await readManifest();
    if (archived.version !== 2) throw new Error('Expected a Git archive');
    expect(archived.gitState.repositories[0]).toMatchObject({
      snapshotRef: staged.repositories[0]?.snapshotRef,
      attributePolicy: 'ignore-in-tree-attributes',
    });
  });

  it('refuses to retry a stopped capture recorded for another incarnation', async () => {
    mockArchiveIoFault = (request): void => {
      if (request.type === 'capture-git') throw new Error('capture failed');
    };
    await expect(archive()).rejects.toThrow('capture failed');
    mockArchiveIoFault = undefined;
    const stuck = await journal();
    if (!stuck) throw new Error('Missing journal');
    for (const name of readdirSync(getW5DestructiveLifecycleDir())) {
      const path = join(getW5DestructiveLifecycleDir(), name);
      const parsed = journalSchema.parse(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      if (parsed.operationId !== stuck.operationId) continue;
      writeFileSync(
        path,
        JSON.stringify({ ...parsed, createdAt: '2000-01-01T00:00:00.000Z' }),
      );
    }
    const before = files(checkout());
    await expect(archive()).rejects.toThrow();
    expect(files(checkout())).toEqual(before);
    expect(
      existsSync(join(getArchivedContainerDir('a', 'one'), 'container.json')),
    ).toBe(false);
  });
});
