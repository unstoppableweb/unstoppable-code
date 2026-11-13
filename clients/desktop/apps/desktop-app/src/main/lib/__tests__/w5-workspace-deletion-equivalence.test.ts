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
    applyWorkspaceIndexRemoval: jest.fn(actual.applyWorkspaceIndexRemoval),
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
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
/** Runs before a worker request; a throw fails that request. */
let mockArchiveIoFault:
  | ((request: ArchiveIoOperationRequest) => void)
  | undefined;
jest.mock('../../archive/archive-io-runner', () => ({
  // Replace Electron utility-process transport with the real filesystem engine.
  runArchiveIoRequest: async (
    request: ArchiveIoOperationRequest,
  ): Promise<ArchiveIoResultMap[ArchiveIoOperationType]> => {
    mockArchiveIoFault?.(request);
    return jest
      .requireActual<typeof ArchiveEngine>('../../archive/archive-io-engine')
      .executeArchiveIoRequest(request, new AbortController().signal, {
        progress: () => {},
        child: { started: () => {}, exited: () => {} },
      });
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
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import fsPromises from 'node:fs/promises';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ArchivedContainerManifest,
} from '@canopy/desktop-shared/types';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
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
import * as coworkWorkEntries from '../cowork-work-entries';
import { acquireWorkspaceDeletionLease } from '../../services/split-lock-service';
import * as atomicFile from '../atomic-file';
import {
  isInterruptedIndexRemovalDeletion,
  readDestructiveRecovery,
} from '../w5-destructive-recovery';
import {
  prepareWorkspaceBrowserRetirement,
  commitTaskBrowserRetirement,
} from '../../browser/browser-profile-lifecycle';
import { commitArchivedContainer } from '../archived-containers';
import { workspaceRootPayloadDigest } from '../archived-container-git';
import {
  getArchivedContainerDir,
  getArchivedContainersRootDir,
  getW5DestructiveLifecycleDir,
  getWorkspaceDir,
  getWorktreeDataDir,
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
  workerEntry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
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
        code: 'W5CommitLogHostError',
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
