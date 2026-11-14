import { isArchivedContainerManifest } from '@canopy/desktop-shared/lib/archived-container-contracts';
import { isRecord } from '../type-guards';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  startPolling,
  stopPolling,
  stopTracking,
  getForegroundWorktreeKey,
  setForegroundWorktree,
} from '../github-poller';
import { installW5StoreSide } from './fixtures/w5-store-sides';
import { installRoutedW5GoldenStore } from './fixtures/w5-routed-golden-store';
import type * as WorkerTerminalModule from '../../terminal/worker-terminal';
import type * as RoutedWorkerTerminalModule from '../../terminal/routed-worker-terminal';
import type * as PortalEventBusModule from '../../portal/portal-event-bus';

// Keep the real worker, PTY and cwd resolver; isolate host accounting and shell
// configuration from the developer's environment.
jest.mock('../../terminal/worker-terminal', () => {
  const actual = jest.requireActual<typeof WorkerTerminalModule>(
    '../../terminal/worker-terminal',
  );
  const { RoutedWorkerTerminal } = jest.requireActual<
    typeof RoutedWorkerTerminalModule
  >('../../terminal/routed-worker-terminal');
  return {
    ...actual,
    workerTerminal: new RoutedWorkerTerminal(
      actual.createDesktopTerminalEngine({
        host: {
          environment: {
            base: () => ({
              PATH: '/usr/bin:/bin',
              HOME: process.env.TMPDIR ?? '/tmp',
              ENV: '',
            }),
            worktree: () => ({}),
            variable: () => undefined,
          },
          resources: { register: () => ({ unregister: (): void => {} }) },
        },
      }),
    ),
  };
});
import type * as IdentityTestHost from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-test-commit-log-host';
import type { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import type { W5CommitLogFileStore } from '../w5-commit-log-file-store';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof IdentityTestHost
    >('@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-test-commit-log-host')
    .createTsxWorkerThreads(),
);
// CAN-3810: round trips through the worktree creation boundary with real Git
// and the real workspace persistence on a temporary data dir. Each create is
// read back from `worktrees.json`: the persisted row, projected to the typed
// creation record, must equal the outcome the boundary returned, and the Git
// checkout must match the requested branch.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
  createPortalEvent: jest.requireActual<typeof PortalEventBusModule>(
    '../../portal/portal-event-bus',
  ).createPortalEvent,
}));
jest.mock('../code-graph-eager-seed', () => ({
  eagerSeedNewWorktreeCodeGraph: jest.fn(() => Promise.resolve()),
}));

import { executeArchiveIoRequest } from '../../archive/archive-io-engine';
import {
  captureArchivedContainerGitState,
  setArchivedContainerGitIoExecutorForTests,
} from '../archived-container-git';
import { markWorkspaceTargetRemovalPending } from '../workspace-target-exclusion';
import { realpathSync } from 'node:fs';
import { canonicalizePossiblyMissingPath } from '../worktree-registration-removal';
import { registerWorkspaceTypes } from '../workspace-registry';
import { spawnTerminalForRenderer } from '../../services/terminal-service';
import * as terminalService from '../../services/terminal-service';
import { handlePortalTerminalOpen } from '../../portal/adapters/terminal-adapter';
import type { PortalAdapterContext } from '../../portal/adapters/types';
import {
  beginWorktreeGitSetup,
  endWorktreeGitSetup,
} from '../worktree-git-setup';
import {
  workerTerminal,
  desktopTerminalShells,
} from '../../terminal/worker-terminal';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import * as worktreeGit from '../git';
import { createGitBranch } from '@canopy/core-runtime/node/git';
import path from 'node:path';
import { AutomationsService } from '../../automations/service';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type WorktreeData,
  type WorkspaceConfigFile,
  type WorkspaceReadinessIssue,
  type PortalCommandEnvelope,
  type TerminalSession,
  type TerminalSpawnRequest,
} from '@canopy/desktop-shared/types';
import {
  getSidebarItemGroupsFilePath,
  getArchivedContainerManifestPath,
  getW5DestructiveLifecycleDir,
  getWorkspaceConfigPath,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreesFilePath,
  getWorktreeDir,
} from '../paths';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
  setWorktreeRegistryReconciler,
  writeWorkspaceWorktrees,
} from '../workspace-persistence';
import { W5AuthorityUnreachableError } from '../w5-file-store';
import {
  inspectWorktreeCreationRecovery,
  repairOrphanedWorktreeRegistration,
} from '../worktree-create-recovery';
import { initializeSidebarItemGroups } from '../../services/sidebar-item-groups-service';
import {
  clearCachedGitExecutablePath,
  detectGitExecutableShared,
  setCachedGitExecutablePath,
} from '../git-executable';
import {
  createWorktreeFromSelection,
  projectWorktreeCreationRecord,
  type WorktreeCreationRecord,
} from '../worktree-creation';

const TEST_TIMEOUT_MS = 60_000;
const SINGLE = 'single';
const MULTI = 'multi';

function terminalOpenCommand(
  request: TerminalSpawnRequest,
): PortalCommandEnvelope<TerminalSpawnRequest> {
  return {
    id: `open-${request.worktreeId}`,
    sequence: 1,
    type: 'portal.terminal.open',
    createdAt: new Date().toISOString(),
    expiresAt: null,
    payload: request,
  };
}

function spawnTerminalForPortal(
  request: TerminalSpawnRequest,
): Promise<TerminalSession> {
  return new Promise((resolve, reject) => {
    handlePortalTerminalOpen(terminalOpenCommand(request), {
      getWindow: () => null,
      canMutateResources: () => true,
      enqueueEvent: () => {},
      complete: () => {
        const session = workerTerminal
          .list()
          .find(
            (entry) =>
              entry.projectId === request.projectId &&
              entry.worktreeId === request.worktreeId,
          );
        if (session) resolve(session);
        else reject(new Error('Portal completed without a terminal'));
      },
      fail: (_command, code, message) => {
        reject(new Error(`${code}: ${message}`));
      },
    });
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function registeredWorktrees(repo: string): Promise<string[]> {
  return Promise.all(
    git(repo, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) =>
        canonicalizePossiblyMissingPath(line.slice('worktree '.length)),
      ),
  );
}

/** A clone of a bare origin with `main` and `develop`, both pushed. */
function createRepository(root: string, name: string): string {
  const origin = path.join(root, `${name}.git`);
  const work = path.join(root, name);
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  git(work, ['config', 'user.name', 'Canopy Test']);
  git(work, ['config', 'user.email', 'test@canopy.example']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['config', 'branch.autoSetupMerge', 'true']);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: work });
  execFileSync('sh', ['-c', 'echo base > README.md'], { cwd: work });
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'base']);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  git(work, ['branch', 'develop']);
  git(work, ['push', '-q', 'origin', 'develop']);
  return work;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function persistedRow(
  workspaceId: string,
  worktreeId: string,
): Promise<WorktreeData> {
  const rows = await readWorkspaceWorktrees(workspaceId);
  const row = rows.find((entry) => entry.id === worktreeId);
  if (!row) throw new Error(`No persisted row for ${worktreeId}`);
  return row;
}

async function expectRecordPersisted(
  workspaceId: string,
  record: WorktreeCreationRecord,
): Promise<void> {
  expect(
    projectWorktreeCreationRecord(
      await persistedRow(workspaceId, record.worktreeId),
    ),
  ).toEqual(record);
}

describe('worktree creation boundary round trips (real git and fs)', () => {
  let root: string;
  let originalDataDir: string | undefined;
  let singleRepo: string;
  let apiRepo: string;
  let webRepo: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'canopy-worktree-create-'));
    const repos = path.join(root, 'repos');
    await mkdir(repos, { recursive: true });
    singleRepo = createRepository(repos, 'app');
    apiRepo = createRepository(repos, 'api');
    webRepo = createRepository(repos, 'web');
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  let closeW5Store: (() => Promise<void>) | undefined;
  let repairCommitFailure: Error | undefined;
  let afterRepairDecision: (() => Promise<void>) | undefined;
  let repairDecisions: number;

  async function startupOrphan(list: 'absent' | 'empty' = 'empty'): Promise<{
    config: WorkspaceConfigFile;
    recovery: NonNullable<WorkspaceReadinessIssue['recovery']>;
  }> {
    if (list === 'empty') await writeWorkspaceWorktrees(SINGLE, []);
    const checkout = getWorktreeDir(SINGLE, 'startup-repair');
    await mkdir(path.dirname(checkout), { recursive: true });
    git(singleRepo, [
      'worktree',
      'add',
      '-b',
      `repair-${path.basename(process.env.CANOPY_DATA_DIR ?? '')}`,
      checkout,
      'main',
    ]);
    await rm(checkout, { recursive: true });
    const config = await readWorkspaceConfig(SINGLE);
    const issues = await inspectWorktreeCreationRecovery(SINGLE, config);
    const recovery = issues.find(
      (entry) => entry.recovery?.phase === 'orphan-checkout',
    )?.recovery;
    if (!recovery) throw new Error('Missing orphan recovery evidence');
    return { config, recovery };
  }

  beforeEach(async () => {
    originalDataDir = process.env.CANOPY_DATA_DIR;
    const dataDir = await mkdtemp(path.join(root, 'data-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeJson(getWorkspaceIndexFilePath(), {
      version: 1,
      workspaces: [
        {
          id: SINGLE,
          name: 'App',
          type: 'single-repo',
          color: 'blue',
          collapsed: false,
          order: 0,
        },
        {
          id: MULTI,
          name: 'Stack',
          type: 'multi-repo',
          color: 'green',
          collapsed: false,
          order: 1,
        },
      ],
    });
    await writeJson(getWorkspaceConfigPath(SINGLE), {
      version: 1,
      type: 'single-repo',
      repoPath: singleRepo,
    });
    await writeJson(getWorkspaceConfigPath(MULTI), {
      version: 1,
      type: 'multi-repo',
      repos: [
        { id: 'api', name: 'api', repoPath: apiRepo },
        { id: 'web', name: 'web', repoPath: webRepo },
      ],
    });
    repairCommitFailure = undefined;
    afterRepairDecision = undefined;
    repairDecisions = 0;
    closeW5Store = await installRoutedW5GoldenStore({
      wrapTransport: (transport) => ({
        ...transport,
        commit: async (request): ReturnType<typeof transport.commit> => {
          if (
            request.operation !==
            'internal.worktree.recovery.repair-registration'
          )
            return transport.commit(request);
          repairDecisions += 1;
          if (repairCommitFailure) throw repairCommitFailure;
          const result = await transport.commit(request);
          await afterRepairDecision?.();
          return result;
        },
      }),
    });
  });

  afterEach(async () => {
    await closeW5Store?.();
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
  });

  async function portalArchiveFixture(count: number): Promise<{
    projectId: string;
    command: PortalCommandEnvelope<unknown>;
    context: PortalAdapterContext;
    complete: jest.Mock<void, [PortalCommandEnvelope<unknown>, unknown]>;
    fail: jest.Mock<void, unknown[]>;
  }> {
    const { createCoworkWorkspace } = await import('../cowork-workspace-crud');
    const { getWorkspaceChatHistoryMetaFilePath } = await import('../paths');
    const project = await createCoworkWorkspace('Retained chats');
    for (let i = 0; i < count; i++) {
      const id = `legacy-${String(i).padStart(3, '0')}`;
      await writeJson(getWorkspaceChatHistoryMetaFilePath(project.id, id), {
        id,
        title: id,
        archived: true,
        createdAt: '2026-11-01T00:00:00.000Z',
        archivedAt: '2026-11-02T00:00:00.000Z',
        description: '',
      });
    }
    const complete = jest.fn<void, [PortalCommandEnvelope<unknown>, unknown]>();
    const fail = jest.fn<void, unknown[]>();
    return {
      projectId: project.id,
      command: {
        id: 'archive-read',
        sequence: 1,
        type: 'portal.workspace.archived_work_entries.list',
        target: { workspaceLocalId: project.id },
        payload: { projectLocalId: project.id },
        createdAt: '2026-11-01T00:00:00.000Z',
        expiresAt: null,
      },
      context: {
        sessionId: 'archive-read-session',
        getWindow: () => null,
        enqueueEvent: () => {},
        canArchiveStandaloneChats: () => true,
        complete,
        fail,
      },
      complete,
      fail,
    };
  }

  it.each([false, true])(
    'Portal archive reads leave every persisted workspace file unchanged (migrated=%s)',
    async (migrated) => {
      const { handlePortalArchivedWorkEntriesList } =
        await import('../../portal/adapters/standalone-chat-adapter');
      const fixture = await portalArchiveFixture(1);
      const { workspacePersistenceTestExports } =
        await import('../workspace-persistence');
      // A stale row still exists on disk after removal, which an ordinary sidebar
      // read would clean up. The archive query must leave it alone.
      await writeJson(getWorkspaceWorktreesFilePath(SINGLE), {
        version: 1,
        worktrees: [
          {
            id: 'removed-row',
            branchName: 'main',
            createdAt: '2026-11-01T00:00:00.000Z',
          },
        ],
      });
      workspacePersistenceTestExports.markWorktreeRecentlyRemoved(
        SINGLE,
        'removed-row',
        '2026-11-01T00:00:00.000Z',
      );
      async function snapshot(dir: string): Promise<Record<string, string>> {
        const files: Record<string, string> = {};
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) Object.assign(files, await snapshot(file));
          else if (entry.isFile()) files[file] = await readFile(file, 'base64');
        }
        return files;
      }
      if (migrated) {
        const { writeChatArchivesFile } = await import('../chat-archives');
        await writeChatArchivesFile(fixture.projectId, 'home', {
          version: 1,
          archived: [
            {
              archivedAt: '2026-11-02T00:00:00.000Z',
              turnCount: 0,
              tab: {
                id: 'canonical-archive',
                title: 'Canonical archive',
                createdAt: '2026-11-01T00:00:00.000Z',
                messages: [],
              },
            },
          ],
        });
      }
      const before = await snapshot(process.env.CANOPY_DATA_DIR ?? '');
      await handlePortalArchivedWorkEntriesList(
        fixture.command,
        fixture.context,
      );
      expect(fixture.fail).not.toHaveBeenCalled();
      const result = fixture.complete.mock.calls[0]?.[1];
      if (!isRecord(result)) throw new Error('Archive reply is missing');
      expect(result.nextOffset).toBeNull();
      expect(result.items).toContainEqual(
        expect.objectContaining({ id: 'legacy-000', legacyChat: true }),
      );
      if (migrated)
        expect(result.items).toContainEqual(
          expect.objectContaining({ id: 'canonical-archive' }),
        );
      expect(await snapshot(process.env.CANOPY_DATA_DIR ?? '')).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Portal returns the entire bounded archive before a concurrent purge can shift pages',
    async () => {
      const { handlePortalArchivedWorkEntriesList } =
        await import('../../portal/adapters/standalone-chat-adapter');
      const { getWorkspaceChatHistoryDir } = await import('../paths');
      const fixture = await portalArchiveFixture(65);
      await handlePortalArchivedWorkEntriesList(
        fixture.command,
        fixture.context,
      );
      expect(fixture.fail).not.toHaveBeenCalled();
      const result = fixture.complete.mock.calls[0]?.[1];
      if (!isRecord(result)) throw new Error('Archive reply is missing');
      expect(result?.items).toHaveLength(65);
      expect(result?.nextOffset).toBeNull();
      await rm(getWorkspaceChatHistoryDir(fixture.projectId, 'legacy-000'), {
        recursive: true,
      });
      for (let i = 0; i < 65; i++)
        expect(result.items).toContainEqual(
          expect.objectContaining({
            id: `legacy-${String(i).padStart(3, '0')}`,
          }),
        );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'enrolls a newly created worktree in PR polling without a sidebar sync',
    async () => {
      startPolling(() => null);
      stopPolling();
      const { record } = await createWorktreeFromSelection({
        workspaceId: SINGLE,
        workspaceKind: 'single-repo',
        branch: { kind: 'new', branchName: 'feature/poller-enrollment' },
        base: { kind: 'repository-default' },
      });
      try {
        await settleDetachedWork();
        setForegroundWorktree(SINGLE, record.worktreeId);
        expect(getForegroundWorktreeKey()).toBe(
          `${SINGLE}/${record.worktreeId}`,
        );
      } finally {
        stopTracking(SINGLE, record.worktreeId);
        stopPolling();
        await settleDetachedWork();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'captures the configured archive base and pinned refs while removal is pending',
    async () => {
      const { record } = await createWorktreeFromSelection({
        workspaceId: SINGLE,
        workspaceKind: 'single-repo',
        branch: { kind: 'new', branchName: 'feature/archive-base' },
        base: { kind: 'branch', baseBranch: 'develop' },
      });
      const row = await persistedRow(SINGLE, record.worktreeId);
      const release = markWorkspaceTargetRemovalPending(
        SINGLE,
        record.worktreeId,
      );
      setArchivedContainerGitIoExecutorForTests((request, signal) =>
        executeArchiveIoRequest(
          request,
          signal ?? new AbortController().signal,
          {
            progress: () => {},
            child: { started: () => {}, exited: () => {} },
          },
        ),
      );
      try {
        const captured = await captureArchivedContainerGitState({
          workspaceId: SINGLE,
          containerId: record.worktreeId,
          workspaceType: 'single-repo',
          worktreePath: getWorktreeDir(SINGLE, record.worktreeId),
          persistedWorktree: row,
        });
        expect(
          isArchivedContainerManifest({
            version: 2,
            kind: 'worktree',
            id: row.id,
            projectId: SINGLE,
            workspaceType: 'single-repo',
            name: 'Archived worktree',
            createdAt: row.createdAt,
            archivedAt: '2026-11-02T00:00:00.000Z',
            retentionDays: 30,
            expiresAt: '2099-12-01T00:00:00.000Z',
            chatCount: 0,
            archivedChatCount: 0,
            executionCount: 0,
            originalWorktree: row,
            ...captured,
          }),
        ).toBe(true);
        const repository = captured.gitState.repositories[0];
        expect(repository).toMatchObject({
          comparisonBaseBranch: 'develop',
          baseBranchCommit: git(singleRepo, ['rev-parse', 'develop']),
        });
        expect(repository?.snapshotRef).toBeTruthy();
        if (!repository) throw new Error('Missing archive repository');
        expect(
          git(repository.referenceRepoPath, [
            'rev-parse',
            `${repository.snapshotRef}^{commit}`,
          ]),
        ).toBe(repository.worktreeSnapshotCommit);
      } finally {
        release();
        setArchivedContainerGitIoExecutorForTests();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'repairs an absent unowned startup registration while preserving a quarantined archive and both branches',
    async () => {
      const { rename } = await import('node:fs/promises');
      const { reconcileGitPendingWorktrees } =
        await import('../worktree-boot-recovery');
      await writeWorkspaceWorktrees(SINGLE, []);
      const orphan = getWorktreeDir(SINGLE, 'startup-orphan');
      const held = getWorktreeDir(SINGLE, 'startup-held');
      await mkdir(path.dirname(orphan), { recursive: true });
      git(singleRepo, [
        'worktree',
        'add',
        '-b',
        `orphan-${path.basename(process.env.CANOPY_DATA_DIR ?? '')}`,
        orphan,
        'main',
      ]);
      git(singleRepo, [
        'worktree',
        'add',
        '-b',
        `held-${path.basename(process.env.CANOPY_DATA_DIR ?? '')}`,
        held,
        'main',
      ]);
      const orphanBranch = git(orphan, ['branch', '--show-current']);
      const heldBranch = git(held, ['branch', '--show-current']);
      const quarantine = path.join(
        path.dirname(held),
        '.startup-held.archive-quarantine',
      );
      await rename(held, quarantine);
      const canonicalOrphan = await canonicalizePossiblyMissingPath(orphan);
      const canonicalHeld = await canonicalizePossiblyMissingPath(held);
      const registeredBefore = await registeredWorktrees(singleRepo);
      expect(registeredBefore).toContain(canonicalOrphan);
      await rm(orphan, { recursive: true });
      const workspaces = await import('../workspace-service');
      const listed = await workspaces.listWorkspaceItems();
      const onlySingle = jest
        .spyOn(workspaces, 'listWorkspaceItems')
        .mockResolvedValue(
          listed
            .filter((entry) => entry.id === SINGLE)
            .map((entry) => ({ ...entry, worktrees: [] })),
        );
      try {
        await reconcileGitPendingWorktrees();
      } finally {
        onlySingle.mockRestore();
      }
      const registeredAfter = await registeredWorktrees(singleRepo);
      expect(registeredAfter).not.toContain(canonicalOrphan);
      expect(registeredAfter).toContain(canonicalHeld);
      expect(git(singleRepo, ['branch', '--list', orphanBranch])).toContain(
        orphanBranch,
      );
      expect(git(singleRepo, ['branch', '--list', heldBranch])).toContain(
        heldBranch,
      );
      expect(
        await readFile(path.join(quarantine, 'README.md'), 'utf8'),
      ).toContain('base');
    },
    TEST_TIMEOUT_MS,
  );
  it.each(['absent', 'empty'] as const)(
    'fences a %s list through the authority before startup Git repair without changing its bytes',
    async (list) => {
      const { config, recovery } = await startupOrphan(list);
      const listPath = getWorkspaceWorktreesFilePath(SINGLE);
      const before =
        list === 'absent' ? null : await readFile(listPath, 'utf8');
      expect(
        await repairOrphanedWorktreeRegistration(SINGLE, config, recovery),
      ).toBe(true);
      expect(repairDecisions).toBe(1);
      expect(await registeredWorktrees(singleRepo)).not.toContain(
        await canonicalizePossiblyMissingPath(recovery.checkoutPath),
      );
      if (before === null)
        await expect(readFile(listPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      else expect(await readFile(listPath, 'utf8')).toBe(before);
      expect(
        git(singleRepo, ['branch', '--list', recovery.branchName]),
      ).toContain(recovery.branchName);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    'listed',
    'partial',
    'unreadable',
    'checkout',
    'pending',
    'archive-manifest',
    'journal',
  ] as const)(
    'keeps an absent registration with %s ownership or incomplete evidence',
    async (owner) => {
      const { config, recovery } = await startupOrphan();
      let release = (): void => {};
      switch (owner) {
        case 'listed':
          await writeWorkspaceWorktrees(SINGLE, [
            {
              id: 'startup-repair',
              branchName: recovery.branchName,
              createdAt: new Date().toISOString(),
            },
          ]);
          break;
        case 'partial':
          await writeJson(getWorkspaceWorktreesFilePath(SINGLE), {
            version: 1,
            worktrees: [{ id: 'unreadable-row' }],
          });
          break;
        case 'unreadable':
          await writeFile(getWorkspaceWorktreesFilePath(SINGLE), '{');
          break;
        case 'checkout':
          await mkdir(recovery.checkoutPath);
          break;
        case 'pending':
          release = markWorkspaceTargetRemovalPending(SINGLE, 'startup-repair');
          break;
        case 'archive-manifest':
          await writeJson(
            getArchivedContainerManifestPath(SINGLE, 'startup-repair'),
            {},
          );
          break;
        case 'journal':
          await mkdir(getW5DestructiveLifecycleDir(), { recursive: true });
          await writeFile(
            path.join(
              getW5DestructiveLifecycleDir(),
              '00000000-0000-0000-0000-000000000000.json',
            ),
            '{',
          );
          break;
      }
      try {
        const repair = repairOrphanedWorktreeRegistration(
          SINGLE,
          config,
          recovery,
        );
        if (owner === 'journal') await expect(repair).rejects.toThrow();
        else expect(await repair).toBe(false);
        expect(repairDecisions).toBe(0);
        expect(await registeredWorktrees(singleRepo)).toContain(
          await canonicalizePossiblyMissingPath(recovery.checkoutPath),
        );
        expect(
          git(singleRepo, ['branch', '--list', recovery.branchName]),
        ).toContain(recovery.branchName);
      } finally {
        release();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not remove a registration when daemon admission fails after readable inspection',
    async () => {
      const { config, recovery } = await startupOrphan();
      repairCommitFailure = new W5AuthorityUnreachableError(
        'refused',
        'connect',
      );
      await expect(
        repairOrphanedWorktreeRegistration(SINGLE, config, recovery),
      ).rejects.toBe(repairCommitFailure);
      expect(repairDecisions).toBe(1);
      expect(await registeredWorktrees(singleRepo)).toContain(
        await canonicalizePossiblyMissingPath(recovery.checkoutPath),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it.each(['pending', 'checkout', 'quarantine'] as const)(
    'rechecks %s exclusion after the daemon decision and before removing a registration',
    async (owner) => {
      const { config, recovery } = await startupOrphan();
      let release = (): void => {};
      afterRepairDecision = async (): Promise<void> => {
        if (owner === 'pending')
          release = markWorkspaceTargetRemovalPending(SINGLE, 'startup-repair');
        else
          await mkdir(
            owner === 'checkout'
              ? recovery.checkoutPath
              : path.join(
                  path.dirname(recovery.checkoutPath),
                  '.startup-repair.archive-quarantine',
                ),
          );
      };
      try {
        expect(
          await repairOrphanedWorktreeRegistration(SINGLE, config, recovery),
        ).toBe(false);
        expect(repairDecisions).toBe(1);
        expect(await registeredWorktrees(singleRepo)).toContain(
          await canonicalizePossiblyMissingPath(recovery.checkoutPath),
        );
      } finally {
        release();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps both registrations when the inspected repository alias is retargeted after the daemon decision',
    async () => {
      await writeWorkspaceWorktrees(MULTI, []);
      const checkout = getWorkspaceWorktreeRepoDir(
        MULTI,
        'startup-repair',
        'api',
      );
      await mkdir(path.dirname(checkout), { recursive: true });
      const branch = `rebound-${path.basename(process.env.CANOPY_DATA_DIR ?? '')}`;
      for (const repository of [apiRepo, webRepo]) {
        git(repository, ['worktree', 'add', '-b', branch, checkout, 'main']);
        await rm(checkout, { recursive: true });
      }
      const alias = path.join(path.dirname(checkout), 'reference-alias');
      await symlink(apiRepo, alias, 'junction');
      const config: WorkspaceConfigFile = {
        version: 1,
        type: 'multi-repo',
        repos: [{ id: 'api', name: 'api', repoPath: alias }],
      };
      const recovery = (
        await inspectWorktreeCreationRecovery(MULTI, config)
      ).find((entry) => entry.recovery?.phase === 'orphan-checkout')?.recovery;
      if (!recovery) throw new Error('Missing aliased orphan evidence');
      expect(recovery.repositoryPath).toBe(alias);
      afterRepairDecision = async (): Promise<void> => {
        await rm(alias);
        await symlink(webRepo, alias, 'junction');
      };
      expect(
        await repairOrphanedWorktreeRegistration(MULTI, config, recovery),
      ).toBe(false);
      expect(repairDecisions).toBe(1);
      for (const repository of [apiRepo, webRepo]) {
        expect(await registeredWorktrees(repository)).toContain(
          await canonicalizePossiblyMissingPath(checkout),
        );
        expect(git(repository, ['branch', '--list', branch])).toContain(branch);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps changed registration identity when another repository retains matching orphan evidence',
    async () => {
      const { recovery } = await startupOrphan();
      git(apiRepo, [
        'worktree',
        'add',
        '-b',
        recovery.branchName,
        recovery.checkoutPath,
        'main',
      ]);
      await rm(recovery.checkoutPath, { recursive: true });
      const config: WorkspaceConfigFile = {
        version: 1,
        type: 'multi-repo',
        repos: [
          { id: 'app', name: 'app', repoPath: singleRepo },
          { id: 'api', name: 'api', repoPath: apiRepo },
        ],
      };
      const entries = path.join(
        await worktreeGit.getGitCommonDir(singleRepo),
        'worktrees',
      );
      let registration: string | undefined;
      for (const entry of await readdir(entries)) {
        const candidate = path.join(entries, entry);
        if (
          (await readFile(path.join(candidate, 'HEAD'), 'utf8')).trim() ===
          `ref: refs/heads/${recovery.branchName}`
        )
          registration = candidate;
      }
      if (!registration) throw new Error('Missing source registration');
      const selectedRegistration = registration;
      const nextBranch = `${recovery.branchName}-replacement`;
      git(singleRepo, ['branch', nextBranch, 'main']);
      afterRepairDecision = (): Promise<void> => {
        git(singleRepo, [
          '--git-dir',
          selectedRegistration,
          'symbolic-ref',
          'HEAD',
          `refs/heads/${nextBranch}`,
        ]);
        return Promise.resolve();
      };
      expect(
        await repairOrphanedWorktreeRegistration(SINGLE, config, recovery),
      ).toBe(false);
      expect(repairDecisions).toBe(1);
      for (const repository of [singleRepo, apiRepo])
        expect(await registeredWorktrees(repository)).toContain(
          await canonicalizePossiblyMissingPath(recovery.checkoutPath),
        );
      expect(
        await readFile(path.join(selectedRegistration, 'HEAD'), 'utf8'),
      ).toBe(`ref: refs/heads/${nextBranch}\n`);
    },
    TEST_TIMEOUT_MS,
  );

  (process.platform === 'win32' ? it.skip : it).each([
    ['single-repo', SINGLE, undefined, 'renderer'],
    ['multi-repo', MULTI, 'api', 'renderer'],
    ['single-repo', SINGLE, undefined, 'Portal'],
    ['multi-repo', MULTI, 'api', 'Portal'],
  ] as const)(
    'opens the first terminal in a completed %s checkout (%s, %s) through %s after deferred creation',
    async (workspaceKind, workspaceId, selectedRepoId, entryPoint) => {
      // The sidebar normally populates this registry before opening a terminal.
      registerWorkspaceTypes(new Map([[workspaceId, workspaceKind]]));
      const createWorktree = worktreeGit.createWorktree;
      let releaseCheckout: () => void = () => {};
      const checkoutGate = new Promise<void>((resolve) => {
        releaseCheckout = resolve;
      });
      let enteredCheckout: () => void = () => {};
      const checkoutStarted = new Promise<void>((resolve) => {
        enteredCheckout = resolve;
      });
      const gitSpy = jest
        .spyOn(worktreeGit, 'createWorktree')
        .mockImplementation(async (...args) => {
          enteredCheckout();
          await checkoutGate;
          return createWorktree(...args);
        });
      const shellSpy = jest
        .spyOn(desktopTerminalShells, 'profile')
        .mockReturnValue({
          shell: '/bin/sh',
          args: ['-f'],
          shellBasename: 'sh',
        });
      let settle: () => void = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let output = '';
      let exited: (code: number | null) => void = () => {};
      const exit = new Promise<number | null>((resolve) => {
        exited = resolve;
      });
      const unsubscribe = workerTerminal.addEventListener((event) => {
        if (event.type === 'output')
          output += Buffer.from(event.payload.data).toString('utf8');
        if (event.type === 'exit') exited(event.payload.exitCode);
      });
      try {
        const outcome = await createWorktreeFromSelection({
          workspaceId,
          workspaceKind,
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
          deferGitSetup: true,
          onGitSetupSettled: settle,
        });
        if (outcome.status !== 'created') throw new Error('Expected a create');
        const { record } = outcome;
        expect(record.setupPhase).toBe('git-pending');
        await checkoutStarted;
        const spawn =
          entryPoint === 'Portal'
            ? spawnTerminalForPortal
            : spawnTerminalForRenderer;
        const firstTerminal = spawn({
          projectId: workspaceId,
          selectedRepoId,
          worktreeId: record.worktreeId,
          cols: 80,
          rows: 24,
          terminalProfileId: 'bash',
        });
        let finished = false;
        void firstTerminal.then(
          () => {
            finished = true;
          },
          () => {
            finished = true;
          },
        );
        // Advance one event-loop turn, not a timing-dependent sleep: the
        // checkout remains behind a barrier while terminal admission runs.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(finished).toBe(false);
        releaseCheckout();
        const session = await firstTerminal;
        workerTerminal.write(
          session.id,
          "printf '\nCANOPY_CWD='; pwd -P; test -f README.md; exit $?\r",
        );
        const exitCode = await exit;
        const expectedCwd = selectedRepoId
          ? getWorkspaceWorktreeRepoDir(
              workspaceId,
              record.worktreeId,
              selectedRepoId,
            )
          : getWorktreeDir(workspaceId, record.worktreeId);
        expect(output).toContain(`CANOPY_CWD=${realpathSync(expectedCwd)}\r\n`);
        expect(exitCode).toBe(0);
      } finally {
        releaseCheckout();
        await settled;
        workerTerminal.killAll();
        registerWorkspaceTypes(new Map());
        unsubscribe();
        shellSpy.mockRestore();
        gitSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.each(['teardown', 'session replacement'] as const)(
    'allows queued %s while a Portal terminal waits for worktree readiness',
    async (nextCommand) => {
      registerWorkspaceTypes(new Map([[SINGLE, 'single-repo']]));
      const { record } = await createWorktreeFromSelection({
        workspaceId: SINGLE,
        workspaceKind: 'single-repo',
        branch: { kind: 'default' },
        base: { kind: 'repository-default' },
      });
      // A real checkout makes stale admission observable: if the old session
      // is admitted after readiness, the real worker can create a PTY here.
      const settleSetup = beginWorktreeGitSetup(SINGLE, record.worktreeId);
      let sessionActive = true;
      const complete = jest.fn();
      const fail = jest.fn();
      const enqueueEvent = jest.fn();
      const context: PortalAdapterContext = {
        sessionId: 'original-session',
        getWindow: () => null,
        canMutateResources: () => sessionActive,
        // Match the processor's event sink: an ended session discards late
        // deltas and receipts, even when its deferred operation has settled.
        enqueueEvent: (event) => {
          if (sessionActive) enqueueEvent(event);
        },
        complete: (open, result) => {
          if (sessionActive) complete(open, result);
        },
        fail: (...args) => {
          if (sessionActive) fail(...args);
        },
      };
      const command = terminalOpenCommand({
        projectId: SINGLE,
        worktreeId: record.worktreeId,
        cols: 80,
        rows: 24,
        terminalProfileId: 'bash',
      });
      const shellSpy = jest
        .spyOn(desktopTerminalShells, 'profile')
        .mockReturnValue({
          shell: '/bin/sh',
          args: ['-f'],
          shellBasename: 'sh',
        });
      const createSpy = jest.spyOn(workerTerminal, 'create');
      const spawn = terminalService.spawnTerminalAfterShellPrewarm;
      let finishedOpening: () => void = () => {};
      const openSettled = new Promise<void>((resolve) => {
        finishedOpening = resolve;
      });
      // Observe completion without replacing readiness, admission or PTY
      // execution; a stale adapter intentionally emits no receipt to await.
      const spawnSpy = jest
        .spyOn(terminalService, 'spawnTerminalAfterShellPrewarm')
        .mockImplementation(async (...args) => {
          try {
            return await spawn(...args);
          } finally {
            finishedOpening();
          }
        });
      let nextCommandRan = false;
      // Match the Portal processor's serial await: detachment must happen
      // inside the production adapter, not in this command queue.
      const serial = Promise.resolve()
        .then(() => handlePortalTerminalOpen(command, context))
        .then(() => {
          nextCommandRan = true;
          if (nextCommand === 'teardown') {
            endWorktreeGitSetup(SINGLE, record.worktreeId);
          } else {
            sessionActive = false;
            settleSetup('ready');
          }
        });
      try {
        // An event-loop turn, not a timed sleep: an inline-awaiting adapter
        // cannot run the queued command while the readiness barrier is held.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(nextCommandRan).toBe(true);
        await serial;
        await openSettled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(complete).not.toHaveBeenCalled();
        expect(enqueueEvent).not.toHaveBeenCalled();
        if (nextCommand === 'teardown') {
          expect(fail).toHaveBeenCalledTimes(1);
          expect(fail).toHaveBeenCalledWith(
            command,
            'invalid_target',
            expect.stringContaining('cancelled'),
            false,
          );
        } else {
          expect(fail).not.toHaveBeenCalled();
        }
        expect(createSpy).not.toHaveBeenCalled();
        expect(workerTerminal.list()).toEqual([]);
      } finally {
        endWorktreeGitSetup(SINGLE, record.worktreeId);
        await serial;
        await openSettled;
        workerTerminal.killAll();
        registerWorkspaceTypes(new Map());
        spawnSpy.mockRestore();
        createSpy.mockRestore();
        shellSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Uses real Git and filesystem effects; native Linux acceptance still runs
  // separately. An explicit missing selection must not use system Git instead.
  (process.platform === 'win32' ? it.skip : it).each(['x64', 'arm64'])(
    'settles unavailable Git and creates on retry after restoring the same selected path (%s)',
    async (arch) => {
      const originalPlatform = process.platform;
      const originalArch = process.arch;
      const originalPublished = process.env.CANOPY_GIT_EXECUTABLE;
      const originalPath = process.env.PATH;
      const selected = path.join(root, `selected-${arch}`, 'git');
      await mkdir(path.dirname(selected), { recursive: true });
      try {
        Object.defineProperty(process, 'platform', {
          value: 'linux',
          configurable: true,
        });
        Object.defineProperty(process, 'arch', {
          value: arch,
          configurable: true,
        });
        await setCachedGitExecutablePath(selected);
        const unavailable = await detectGitExecutableShared({ force: true });
        expect(unavailable.status).toMatchObject({
          required: true,
          ready: false,
        });
        await expect(
          createWorktreeFromSelection({
            workspaceId: SINGLE,
            workspaceKind: 'single-repo',
            branch: { kind: 'default' },
            base: { kind: 'repository-default' },
          }),
        ).rejects.toThrow('Selected Git executable cannot be used');
        expect(await readWorkspaceWorktrees(SINGLE)).toEqual([]);

        await symlink('/usr/bin/git', selected);
        // The next ordinary creation must re-probe: no separate recheck,
        // environment change or app restart is needed after repairing Git.
        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        });
        const ready = await detectGitExecutableShared();
        expect(ready.status).toMatchObject({ ready: true, path: selected });
        expect(record.setupPhase).toBe('git-ready');
        await expectRecordPersisted(SINGLE, record);
        expect(
          git(getWorktreeDir(SINGLE, record.worktreeId), [
            'branch',
            '--show-current',
          ]),
        ).toBe(record.branchName);
        expect(process.env.PATH).toBe(originalPath);
      } finally {
        await clearCachedGitExecutablePath();
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
        Object.defineProperty(process, 'arch', {
          value: originalArch,
          configurable: true,
        });
        if (originalPublished === undefined)
          delete process.env.CANOPY_GIT_EXECUTABLE;
        else process.env.CANOPY_GIT_EXECUTABLE = originalPublished;
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ['single-repo', SINGLE, 'creation'],
    ['multi-repo', MULTI, 'creation'],
    ['single-repo', SINGLE, 'automation'],
    ['multi-repo', MULTI, 'automation'],
    ['single-repo', SINGLE, 'automation after storage recovery'],
    ['multi-repo', MULTI, 'automation after storage recovery'],
  ] as const)(
    'keeps real %s checkouts in %s when W5 becomes unreadable during %s setup',
    async (workspaceKind, workspaceId, caller) => {
      const createWorktree = worktreeGit.createWorktree;
      const checkouts: { path: string; branch: string }[] = [];
      let readableList: string | undefined;
      let corruptStorage: Promise<void> | undefined;
      let snapshotReads = 0;
      let releaseCheckouts: () => void = () => {};
      const bothCheckouts = new Promise<void>((resolve) => {
        releaseCheckouts = resolve;
      });
      let releaseCorruption: () => void = () => {};
      const firstCorruption = new Promise<void>((resolve) => {
        releaseCorruption = resolve;
      });
      // Force the competing-read window in the multi-repo recovery case:
      // a second snapshot read sees the first corruption, never valid storage.
      const readSnapshot = async (): Promise<string> => {
        const read = ++snapshotReads;
        if (
          workspaceKind === 'multi-repo' &&
          caller === 'automation after storage recovery'
        ) {
          if (read === 1) await bothCheckouts;
          else await firstCorruption;
        }
        return readFile(getWorkspaceWorktreesFilePath(workspaceId), 'utf8');
      };
      let storageRecovered = false;
      let storageFailed: () => void = () => {};
      const unreadable = new Promise<void>((resolve) => {
        storageFailed = resolve;
      });
      const gitSpy = jest
        .spyOn(worktreeGit, 'createWorktree')
        .mockImplementation(async (...args): Promise<string> => {
          const branch = await createWorktree(...args).catch(
            (error: unknown): never => {
              releaseCheckouts();
              throw error;
            },
          );
          checkouts.push({ path: args[1], branch });
          if (checkouts.length === 2) releaseCheckouts();
          // Assign before awaiting so every child shares one snapshot and fault.
          await (corruptStorage ??= (async (): Promise<void> => {
            readableList = await readSnapshot();
            await writeFile(
              getWorkspaceWorktreesFilePath(workspaceId),
              '{broken',
            );
            releaseCorruption();
            storageFailed();
          })());
          return branch;
        });
      const failures: string[] = [];
      let settle: (outcome: string) => void = () => {};
      const settled = new Promise<string>((resolve) => {
        settle = resolve;
      });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        if (caller !== 'creation') {
          const service = new AutomationsService();
          service.configure({
            getMainWindow: () => null,
            ensureAppAdvisorWindow: () =>
              Promise.resolve({ open: false, focused: false }),
            sendAppAdvisorWindowCommand: () => {},
          });
          if (caller === 'automation after storage recovery') {
            const dispose = service['disposeFailedReadyWorktree'].bind(service);
            service['disposeFailedReadyWorktree'] = async (
              ...args
            ): Promise<void> => {
              if (readableList === undefined)
                throw new Error('No saved W5 list');
              await writeFile(
                getWorkspaceWorktreesFilePath(workspaceId),
                readableList,
              );
              const restoredList = await readWorkspaceWorktreesDetailed(
                workspaceId,
                { persistRemovalCleanup: false },
              );
              storageRecovered = restoredList.authority === 'ok';
              expect(storageRecovered).toBe(true);
              return dispose(...args);
            };
          }
          const ready = service['createReadyWorktree']({
            type: 'worktree_prompt',
            workspaceId,
            prompt: 'Implement',
          });
          void ready.catch(() => undefined);
          await Promise.race([
            unreadable,
            ready.then(() => {
              throw new Error('Storage failure was not injected');
            }),
          ]);
          await expect(
            Promise.race([
              ready,
              new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(
                  () => reject(new Error('Setup did not fail promptly')),
                  5000,
                );
              }),
            ]),
          ).rejects.toThrow(/storage.*unreadable/i);
          if (caller === 'automation after storage recovery') {
            // Disposal errors are swallowed by createReadyWorktree.
            expect(storageRecovered).toBe(true);
          }
        } else {
          await createWorktreeFromSelection({
            workspaceId,
            workspaceKind,
            branch: { kind: 'new', branchName: 'feature/unreadable-setup' },
            base: { kind: 'repository-default' },
            deferGitSetup: true,
            onGitFailed: (event) => failures.push(event.error),
            onGitSetupSettled: (event) => settle(event.outcome),
          });
          await expect(settled).resolves.toBe('failed');
          expect(failures).toEqual([
            expect.stringMatching(/storage.*unreadable/i),
          ]);
        }
        expect(checkouts).toHaveLength(workspaceKind === 'multi-repo' ? 2 : 1);
        for (const checkout of checkouts) {
          expect(git(checkout.path, ['branch', '--show-current'])).toBe(
            checkout.branch,
          );
          expect(
            await readFile(path.join(checkout.path, 'README.md'), 'utf8'),
          ).toBe('base\n');
        }
      } finally {
        releaseCheckouts();
        releaseCorruption();
        if (deadline) clearTimeout(deadline);
        gitSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  describe('single-repository', () => {
    it(
      'creates the default branch from the repository default',
      async () => {
        const outcome = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        });

        const { record } = outcome;
        expect(record.worktreeId).toMatch(/^[a-z-]+$/);
        // The default branch is `<worktree id>-<epoch ms>`.
        expect(record.branchName).toMatch(
          new RegExp(`^${record.worktreeId}-\\d+$`),
        );
        expect(record).toEqual({
          worktreeId: record.worktreeId,
          branchName: record.branchName,
          createdAt: record.createdAt,
          setupPhase: 'git-ready',
          trackedBaseBranch: null,
          trackedRepoBaseBranches: {},
          includedRepoIds: null,
        });
        await expectRecordPersisted(SINGLE, record);
        expect(
          git(getWorktreeDir(SINGLE, record.worktreeId), [
            'branch',
            '--show-current',
          ]),
        ).toBe(record.branchName);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'creates a new branch from a base branch and tracks it',
      async () => {
        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'new', branchName: ' feature/new ' },
          base: { kind: 'branch', baseBranch: 'develop' },
        });

        expect(record).toMatchObject({
          branchName: 'feature/new',
          trackedBaseBranch: 'develop',
          setupPhase: 'git-ready',
        });
        await expectRecordPersisted(SINGLE, record);
        const checkout = getWorktreeDir(SINGLE, record.worktreeId);
        expect(git(checkout, ['branch', '--show-current'])).toBe('feature/new');
        expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(
          git(singleRepo, ['rev-parse', 'develop']),
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'fetches the Home default when the branch is missing from local and cached refs',
      async () => {
        const baseBranch = 'remote-default-only';
        const expectedCommit = git(singleRepo, [
          'rev-parse',
          'refs/heads/develop',
        ]);
        git(singleRepo, [
          'push',
          'origin',
          `refs/heads/develop:refs/heads/${baseBranch}`,
        ]);
        git(singleRepo, [
          'update-ref',
          '-d',
          `refs/remotes/origin/${baseBranch}`,
        ]);
        try {
          const { record } = await createWorktreeFromSelection({
            workspaceId: SINGLE,
            workspaceKind: 'single-repo',
            branch: { kind: 'new', branchName: 'feature/from-remote-default' },
            base: { kind: 'branch', baseBranch },
          });
          expect(record.trackedBaseBranch).toBe(baseBranch);
          expect(
            git(getWorktreeDir(SINGLE, record.worktreeId), [
              'rev-parse',
              'HEAD',
            ]),
          ).toBe(expectedCommit);
        } finally {
          git(singleRepo, ['push', 'origin', '--delete', baseBranch]);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it.each([
      [
        'remote branch shadowed by a tag',
        'refs/remotes/origin/develop',
        'develop',
      ],
      ['local branch shadowed by a tag', 'refs/heads/develop', 'develop'],
      [
        'local branch named like an origin ref',
        'refs/heads/origin/develop',
        'origin/develop',
      ],
    ])(
      'creates from the exact %s',
      async (_case, baseBranch, trackedBaseBranch) => {
        const otherCommit = git(singleRepo, [
          'commit-tree',
          'main^{tree}',
          '-m',
          'Distinct collision commit',
        ]);
        git(singleRepo, ['tag', '-f', 'develop', otherCommit]);
        git(singleRepo, ['tag', '-f', 'origin/develop', otherCommit]);
        git(singleRepo, [
          'update-ref',
          'refs/heads/origin/develop',
          otherCommit,
        ]);
        try {
          const expectedCommit = git(singleRepo, ['rev-parse', baseBranch]);
          const { record } = await createWorktreeFromSelection({
            workspaceId: SINGLE,
            workspaceKind: 'single-repo',
            branch: {
              kind: 'new',
              branchName: `feature/from-${baseBranch.replace(/\//g, '-')}`,
            },
            base: { kind: 'branch', baseBranch },
            baseBranchIsQualified: true,
          });
          expect(record.trackedBaseBranch).toBe(trackedBaseBranch);
          const checkout = getWorktreeDir(SINGLE, record.worktreeId);
          expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(expectedCommit);
          if (baseBranch === 'refs/remotes/origin/develop') {
            expect(
              git(checkout, [
                'rev-parse',
                '--symbolic-full-name',
                '@{upstream}',
              ]),
            ).toBe(baseBranch);
          }
        } finally {
          git(singleRepo, ['tag', '-d', 'develop', 'origin/develop']);
          git(singleRepo, ['update-ref', '-d', 'refs/heads/origin/develop']);
        }
      },
      TEST_TIMEOUT_MS,
    );

    (process.platform === 'win32' ? it.skip : it).each([
      ['worktree', 'failed-command'],
      ['worktree', 'ref-advanced'],
      ['branch-info', 'failed-command'],
      ['branch-info', 'ref-advanced'],
    ] as const)(
      'reports retained Git state after native creation and a concurrent advance (%s, %s)',
      async (operation, outcome) => {
        const branch = `tracking-race-${operation}-${outcome}`;
        const ref = `refs/heads/${branch}`;
        const target = path.join(root, branch);
        const executable = path.join(root, `${branch}-git`);
        const marker = path.join(root, `${branch}-advanced`);
        const before = git(singleRepo, [
          'rev-parse',
          'refs/remotes/origin/develop',
        ]);
        const originalHead = git(singleRepo, ['symbolic-ref', 'HEAD']);
        const advanced = git(singleRepo, [
          'commit-tree',
          'main^{tree}',
          '-p',
          before,
          '-m',
          'Advance during tracking',
        ]);
        const previous = process.env.CANOPY_GIT_EXECUTABLE;
        const configPattern = `^branch\\.${branch}\\.`;
        git(singleRepo, [
          'config',
          `branch.${branch}.description`,
          'Keep this description',
        ]);
        git(singleRepo, [
          'config',
          `branch.${branch}.remote`,
          'previous-remote',
        ]);
        git(singleRepo, [
          'config',
          '--add',
          `branch.${branch}.merge`,
          'refs/heads/previous-base',
        ]);
        git(singleRepo, [
          'config',
          '--add',
          `branch.${branch}.merge`,
          'refs/heads/second-base',
        ]);
        await writeFile(
          executable,
          `#!/bin/sh
case " $* " in
  *" branch ${branch} refs/remotes/origin/develop "*|*" worktree add -b ${branch} "*)
    if [ ! -f '${marker}' ]; then
      touch '${marker}'
      git "$@" || exit 16
      if [ '${operation}' = 'worktree' ]; then
        printf '%s\n' 'Keep these new files' > '${target}/keep-during-create.txt'
      fi
      git update-ref '${ref}' '${advanced}' '${before}' || exit 18
      if [ '${outcome}' = 'failed-command' ]; then exit 17; fi
      exit 0
    fi
    ;;
esac
exec git "$@"
`,
          { mode: 0o700 },
        );
        process.env.CANOPY_GIT_EXECUTABLE = executable;
        try {
          const create =
            operation === 'worktree'
              ? worktreeGit.createWorktreeFromStartPoint(
                  singleRepo,
                  target,
                  branch,
                  `${before}^{commit}`,
                  {
                    trackingRef: 'refs/remotes/origin/develop',
                  },
                )
              : createGitBranch(
                  worktreeGit.gitBranchWritePort(singleRepo),
                  branch,
                  'develop',
                  {
                    baseBranch: { branch: 'develop', remote: true },
                  },
                );
          const failure = await create.catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          const expectedHead = operation === 'worktree' ? ref : originalHead;
          const message = failure instanceof Error ? failure.message : '';
          expect(message).toContain('Branch exists.');
          expect(message).toContain(
            `HEAD is on "${expectedHead.slice('refs/heads/'.length)}".`,
          );
          expect(message).toContain('Upstream is configured.');
          if (operation === 'worktree') {
            expect(message).toContain('Worktree exists.');
            expect(
              await readFile(
                path.join(target, 'keep-during-create.txt'),
                'utf8',
              ),
            ).toBe('Keep these new files\n');
          }
          expect(
            git(singleRepo, ['for-each-ref', '--format=%(objectname)', ref]),
          ).toBe(advanced);
          expect(
            git(singleRepo, ['config', '--get-regexp', configPattern]),
          ).toContain('Keep this description');
          expect(git(singleRepo, ['config', `branch.${branch}.remote`])).toBe(
            'origin',
          );
          expect(
            git(singleRepo, ['config', '--get-all', `branch.${branch}.merge`]),
          ).toBe(
            'refs/heads/previous-base\nrefs/heads/second-base\nrefs/heads/develop',
          );
          expect(git(singleRepo, ['symbolic-ref', 'HEAD'])).toBe(originalHead);
          if (operation === 'worktree') {
            expect(git(target, ['symbolic-ref', 'HEAD'])).toBe(ref);
            expect(
              git(singleRepo, ['worktree', 'list', '--porcelain']),
            ).toContain(target);
          }
        } finally {
          if (previous === undefined) delete process.env.CANOPY_GIT_EXECUTABLE;
          else process.env.CANOPY_GIT_EXECUTABLE = previous;
          if (
            operation === 'worktree' &&
            git(singleRepo, ['worktree', 'list', '--porcelain']).includes(
              target,
            )
          )
            git(singleRepo, ['worktree', 'remove', '--force', target]);
          git(singleRepo, ['update-ref', '-d', ref]);
          git(singleRepo, ['config', '--remove-section', `branch.${branch}`]);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preserves Git upstream and rebase policy for an explicit remote branch',
      async () => {
        git(singleRepo, ['config', 'branch.autoSetupRebase', 'remote']);
        try {
          const { record } = await createWorktreeFromSelection({
            workspaceId: SINGLE,
            workspaceKind: 'single-repo',
            branch: { kind: 'new', branchName: 'feature/remote-rebase' },
            base: { kind: 'branch', baseBranch: 'remote:develop' },
          });
          const checkout = getWorktreeDir(SINGLE, record.worktreeId);
          expect(
            git(checkout, ['rev-parse', '--symbolic-full-name', '@{upstream}']),
          ).toBe('refs/remotes/origin/develop');
          expect(
            git(checkout, ['config', 'branch.feature/remote-rebase.rebase']),
          ).toBe('true');
        } finally {
          git(singleRepo, ['config', '--unset', 'branch.autoSetupRebase']);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'creates from a literal refs-prefixed branch name on legacy and Portal paths',
      async () => {
        const branchName = 'refs/heads/develop';
        const fullRef = `refs/heads/${branchName}`;
        const commit = git(singleRepo, [
          'commit-tree',
          'main^{tree}',
          '-m',
          'Literal branch commit',
        ]);
        git(singleRepo, ['update-ref', fullRef, commit]);
        try {
          const ordinaryCommit = git(singleRepo, ['rev-parse', 'develop']);
          const cases = [
            {
              name: 'legacy',
              baseBranch: branchName,
              expectedBranch: branchName,
              expectedCommit: commit,
            },
            {
              name: 'portal-literal',
              baseBranch: fullRef,
              expectedBranch: branchName,
              expectedCommit: commit,
            },
            {
              name: 'portal-ordinary',
              baseBranch: branchName,
              expectedBranch: 'develop',
              expectedCommit: ordinaryCommit,
            },
          ];
          for (const {
            name,
            baseBranch,
            expectedBranch,
            expectedCommit,
          } of cases) {
            const { record } = await createWorktreeFromSelection({
              workspaceId: SINGLE,
              workspaceKind: 'single-repo',
              branch: { kind: 'new', branchName: `feature/from-${name}` },
              base: { kind: 'branch', baseBranch },
              ...(name !== 'legacy' ? { baseBranchIsQualified: true } : {}),
            });
            expect(record.trackedBaseBranch).toBe(expectedBranch);
            expect(
              git(getWorktreeDir(SINGLE, record.worktreeId), [
                'rev-parse',
                'HEAD',
              ]),
            ).toBe(expectedCommit);
          }
        } finally {
          git(singleRepo, ['update-ref', '-d', fullRef]);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'checks out an existing branch and still tracks a base branch',
      async () => {
        git(singleRepo, ['branch', 'feature/existing', 'main']);

        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'existing', branchName: 'feature/existing' },
          base: { kind: 'branch', baseBranch: 'main' },
        });

        expect(record).toMatchObject({
          branchName: 'feature/existing',
          trackedBaseBranch: 'main',
        });
        await expectRecordPersisted(SINGLE, record);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'creates a suggested branch that does not exist yet',
      async () => {
        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'suggested', branchName: 'feature/suggested' },
          base: { kind: 'repository-default' },
        });

        expect(record.branchName).toBe('feature/suggested');
        await expectRecordPersisted(SINGLE, record);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "tracks a base worktree's current branch",
      async () => {
        const base = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'new', branchName: 'feature/base' },
          base: { kind: 'repository-default' },
        });

        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'worktree', baseWorktreeId: base.record.worktreeId },
        });

        expect(record.trackedBaseBranch).toBe('feature/base');
        await expectRecordPersisted(SINGLE, record);
        const rows = await readWorkspaceWorktrees(SINGLE);
        // New worktrees lead the manual order.
        expect(rows.map((row) => row.id)).toEqual([
          record.worktreeId,
          base.record.worktreeId,
        ]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'returns the git-pending reservation and promotes it after deferred setup',
      async () => {
        let settled: (outcome: string) => void = () => {};
        const setupSettled = new Promise<string>((resolve) => {
          settled = resolve;
        });

        const { record } = await createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'new', branchName: 'feature/deferred' },
          base: { kind: 'branch', baseBranch: 'main' },
          deferGitSetup: true,
          onGitSetupSettled: (event) => settled(event.outcome),
        });

        expect(record).toMatchObject({
          branchName: 'feature/deferred',
          setupPhase: 'git-pending',
          trackedBaseBranch: 'main',
        });
        const reserved = projectWorktreeCreationRecord(
          await persistedRow(SINGLE, record.worktreeId),
        );
        // The row may already be promoted when Git setup is fast; every other
        // field is fixed at reservation.
        expect({ ...reserved, setupPhase: 'git-pending' }).toEqual(record);

        await expect(setupSettled).resolves.toBe('ready');
        await expectRecordPersisted(SINGLE, {
          ...record,
          setupPhase: 'git-ready',
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'files the new worktree in the requested sidebar group',
      async () => {
        initializeSidebarItemGroups();
        try {
          const existing = await createWorktreeFromSelection({
            workspaceId: SINGLE,
            workspaceKind: 'single-repo',
            branch: { kind: 'default' },
            base: { kind: 'repository-default' },
          });
          const group = {
            id: 'grp-review',
            name: 'Review',
            color: 'neutral',
            collapsed: false,
            memberIds: [existing.record.worktreeId],
          };
          await writeJson(getSidebarItemGroupsFilePath(SINGLE), {
            version: 1,
            groups: [group],
          });

          const { record } = await createWorktreeFromSelection({
            workspaceId: SINGLE,
            workspaceKind: 'single-repo',
            branch: { kind: 'default' },
            base: { kind: 'repository-default' },
            sidebarItemGroupId: 'grp-review',
          });

          await expectRecordPersisted(SINGLE, record);
          const groups: unknown = JSON.parse(
            await readFile(getSidebarItemGroupsFilePath(SINGLE), 'utf8'),
          );
          expect(groups).toEqual({
            version: 1,
            groups: [
              {
                ...group,
                memberIds: [existing.record.worktreeId, record.worktreeId],
              },
            ],
          });
        } finally {
          setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
            Promise.resolve({ rows: next }),
          );
        }
      },
      TEST_TIMEOUT_MS,
    );

    it('refuses a per-repository base before reserving anything', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: SINGLE,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'per-repository', baseBranches: { app: 'main' } },
        }),
      ).rejects.toMatchObject({
        reason: 'invalid-selection',
        message:
          'baseBranchesByRepo is only supported for multi-repository projects',
      });
      expect(await readWorkspaceWorktrees(SINGLE)).toEqual([]);
    });

    it('refuses a workspace of the other kind with the existing message', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        }),
      ).rejects.toMatchObject({
        reason: 'unsupported-workspace',
        message: `Project ${MULTI} is not a single-repo project`,
      });
      expect(await readWorkspaceWorktrees(MULTI)).toEqual([]);
    });

    it('denies the read-only shared-container scope before reading it', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          workspaceKind: 'single-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        }),
      ).rejects.toMatchObject({
        reason: 'read-only-scope',
        message: 'Shared-container recipient workspaces are read-only',
      });
    });
  });

  describe('multi-repository', () => {
    it(
      'persists per-repository bases',
      async () => {
        const outcome = await createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'new', branchName: 'feature/stack' },
          base: {
            kind: 'per-repository',
            baseBranches: { api: 'main', web: 'develop' },
          },
        });

        if (outcome.status !== 'created') throw new Error('Expected a create');
        expect(outcome.record).toMatchObject({
          branchName: 'feature/stack',
          setupPhase: 'git-ready',
          trackedBaseBranch: null,
          trackedRepoBaseBranches: { api: 'main', web: 'develop' },
          includedRepoIds: null,
        });
        await expectRecordPersisted(MULTI, outcome.record);
        for (const [repoId, repoPath, base] of [
          ['api', apiRepo, 'main'],
          ['web', webRepo, 'develop'],
        ]) {
          const checkout = getWorkspaceWorktreeRepoDir(
            MULTI,
            outcome.record.worktreeId,
            repoId,
          );
          expect(git(checkout, ['branch', '--show-current'])).toBe(
            'feature/stack',
          );
          expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(
            git(repoPath, ['rev-parse', base]),
          );
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'resolves one base branch for every repository',
      async () => {
        const outcome = await createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'default' },
          base: { kind: 'branch', baseBranch: 'develop' },
        });

        if (outcome.status !== 'created') throw new Error('Expected a create');
        expect(outcome.record.trackedRepoBaseBranches).toEqual({
          api: 'develop',
          web: 'develop',
        });
        await expectRecordPersisted(MULTI, outcome.record);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'scopes the checkout to the included repositories',
      async () => {
        const outcome = await createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
          includedRepoIds: ['web'],
        });

        if (outcome.status !== 'created') throw new Error('Expected a create');
        expect(outcome.record.includedRepoIds).toEqual(['web']);
        await expectRecordPersisted(MULTI, outcome.record);
        const repos = await readdir(
          path.dirname(
            getWorkspaceWorktreeRepoDir(
              MULTI,
              outcome.record.worktreeId,
              'web',
            ),
          ),
        );
        expect(repos).toEqual(['web']);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "tracks a base worktree's per-repository branches",
      async () => {
        const base = await createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'new', branchName: 'feature/stack-base' },
          base: { kind: 'repository-default' },
        });
        if (base.status !== 'created') throw new Error('Expected a create');

        const outcome = await createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'default' },
          base: { kind: 'worktree', baseWorktreeId: base.record.worktreeId },
        });

        if (outcome.status !== 'created') throw new Error('Expected a create');
        expect(outcome.record.trackedRepoBaseBranches).toEqual({
          api: 'feature/stack-base',
          web: 'feature/stack-base',
        });
        await expectRecordPersisted(MULTI, outcome.record);
      },
      TEST_TIMEOUT_MS,
    );

    it('refuses an unknown included repository before reserving', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
          includedRepoIds: ['docs'],
        }),
      ).rejects.toMatchObject({
        reason: 'invalid-repository-selection',
        message:
          'Cannot create worktree: included repo docs is not in the project.',
      });
      expect(await readWorkspaceWorktrees(MULTI)).toEqual([]);
    });

    it('refuses a suggested branch without a source repository', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: MULTI,
          workspaceKind: 'multi-repo',
          branch: { kind: 'suggested', branchName: 'feature/x' },
          base: { kind: 'repository-default' },
        }),
      ).rejects.toMatchObject({
        reason: 'invalid-selection',
        message: `Project ${MULTI} has no source repository; suggestedBranch requires a source-backed multi-repo project`,
      });
      expect(await readWorkspaceWorktrees(MULTI)).toEqual([]);
    });

    it('keeps the existing error for an absent workspace', async () => {
      await expect(
        createWorktreeFromSelection({
          workspaceId: 'missing',
          workspaceKind: 'multi-repo',
          branch: { kind: 'default' },
          base: { kind: 'repository-default' },
        }),
      ).rejects.toThrow('Project missing not found');
    });
  });
});

const describeIdentityHost =
  process.platform === 'win32' ? describe.skip : describe;
describeIdentityHost(
  'CAN-5757 desktop workspace identity reservation compatibility',
  () => {
    it(
      'supplies an exclusive claim while worktree reservations naming that workspace remain valid',
      async () => {
        const desktopStore = await import('../w5-commit-log-file-store');
        const { reserveWorkspaceCreation } =
          await import('../w5-workspace-creation-commit');
        const { startW5TestCommitLogHost } =
          await import('@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-test-commit-log-host');
        const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-identity-'));
        const root = path.join(dir, 'workspaces');
        const host = startW5TestCommitLogHost({
          root,
          logDirectory: path.join(dir, 'w5'),
        });
        const store = desktopStore.createW5CommitLogFileStore(() => host);
        const identity = jest
          .spyOn(desktopStore, 'getW5IdentityStore')
          .mockReturnValue(store);
        try {
          const reservation = await reserveWorkspaceCreation('project', []);
          await expect(
            store.reserve({
              reservationId: 'rival',
              operation: 'core.workspace.create',
              workspaceIdentity: 'project',
            }),
          ).rejects.toMatchObject({ reason: 'identity-conflict' });
          await expect(
            store.reserve({
              reservationId: 'worktree',
              operation: 'core.worktree.create',
              diagnostics: { workspaceId: 'project' },
            }),
          ).resolves.toBeUndefined();
          await reservation.run(() => Promise.resolve());
          await reservation.releaseRemoved();
          await expect(
            store.reserve({
              reservationId: 'after-release',
              operation: 'core.workspace.create',
              workspaceIdentity: 'project',
            }),
          ).resolves.toBeUndefined();
        } finally {
          identity.mockRestore();
          await host.shutdown();
          await rm(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
describeIdentityHost('desktop creation claim qualification', () => {
  let dir: string;
  let originalDataDir: string | undefined;
  let host: W5CommitLogHost;
  let store: W5CommitLogFileStore;
  let closeStoreSide: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    const desktopStore = await import('../w5-commit-log-file-store');
    const { startW5TestCommitLogHost } =
      await import('@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-test-commit-log-host');
    dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-qualification-'));
    originalDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = dir;
    host = startW5TestCommitLogHost({
      root: path.dirname(getWorkspaceIndexFilePath()),
      logDirectory: path.join(dir, 'w5'),
    });
    closeStoreSide = await installW5StoreSide('daemon', {
      host,
      root: path.dirname(getWorkspaceIndexFilePath()),
      setDaemonOwned: () => undefined,
    });
    const installed = desktopStore.getW5IdentityStore();
    if (!installed) throw new Error('Missing routed identity store');
    store = installed;
  });
  afterEach(async () => {
    await closeStoreSide?.();
    const desktopStore = await import('../w5-commit-log-file-store');
    desktopStore.__setDesktopW5FileStoreForTests(undefined);
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await host.shutdown();
    await rm(dir, { recursive: true, force: true });
  });
  it.each([
    {
      name: 'con',
      id: 'con-2',
      title:
        'desktop workspace con is created and indexed with a safe allocated ID',
    },
    {
      name: 'a'.repeat(128),
      id: 'a'.repeat(128),
      title: `creates desktop workspace ${'a'.repeat(128)} through the commit log`,
    },
    {
      name: 'a'.repeat(129),
      id: 'a'.repeat(128),
      title: `desktop workspace ${'a'.repeat(129)} is created and indexed with a safe allocated ID`,
    },
  ])(
    '$title',
    async ({ name, id }) => {
      const { createAndPersistNewMultiRepoWorkspace } =
        await import('../workspace-service');
      const result = await createAndPersistNewMultiRepoWorkspace(name);
      expect(result.id).toBe(id);
      if (id !== name) expect(result.name).toBe(name);
      const index: unknown = JSON.parse(
        await readFile(getWorkspaceIndexFilePath(), 'utf8'),
      );
      expect(index).toHaveProperty(
        'workspaces',
        expect.arrayContaining([
          expect.objectContaining(id === name ? { id } : { id, name }),
        ]),
      );
      expect(
        JSON.parse(await readFile(getWorkspaceConfigPath(id), 'utf8')),
      ).toMatchObject({ type: 'multi-repo' });
      expect(await store.readReservations()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
  it(
    'reclaims an owned orphan manifest with an existing worktree list',
    async () => {
      const { registerBoundMultiRepoWorkspace } =
        await import('../workspace-service');
      const owner = {
        type: 'organization' as const,
        organizationId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
        instanceId: '33333333-3333-4333-8333-333333333333',
        bindingGeneration: 1,
      };
      const source = path.join(dir, 'source');
      await mkdir(source, { recursive: true });
      await writeJson(getWorkspaceConfigPath('owned'), {
        version: 1,
        type: 'multi-repo',
        repos: [],
        sourceRepoPath: source,
        owner,
        unknown: { retained: true },
      });
      await writeJson(getWorkspaceWorktreesFilePath('owned'), {
        version: 1,
        worktrees: [],
        unknown: 'retained',
      });
      const result = await registerBoundMultiRepoWorkspace({
        path: source,
        localWorkspaceId: 'owned',
        owner: { ...owner, bindingGeneration: 2 },
        name: 'Owned',
        repositories: [
          {
            repository: {
              provider: 'github',
              host: 'github.com',
              owner: 'example',
              name: 'repo',
              providerRepoId: null,
              defaultBranch: 'main',
              verification: 'VERIFIED',
            },
            relativePath: 'repos/repo',
            validated: true,
          },
        ],
      });
      expect(result.owner?.bindingGeneration).toBe(2);
      expect(
        JSON.parse(await readFile(getWorkspaceConfigPath('owned'), 'utf8')),
      ).toMatchObject({
        owner: { bindingGeneration: 2 },
        unknown: { retained: true },
      });
      expect(
        JSON.parse(
          await readFile(getWorkspaceWorktreesFilePath('owned'), 'utf8'),
        ),
      ).toMatchObject({ unknown: 'retained' });
      expect(await store.readReservations()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
