import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  startPolling,
  stopPolling,
  stopTracking,
  getForegroundWorktreeKey,
  setForegroundWorktree,
} from '../github-poller';
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
import path from 'node:path';
import { AutomationsService } from '../../automations/service';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type WorktreeData,
  type PortalCommandEnvelope,
  type TerminalSession,
  type TerminalSpawnRequest,
} from '@canopy/desktop-shared/types';
import {
  getSidebarItemGroupsFilePath,
  getWorkspaceConfigPath,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreesFilePath,
  getWorktreeDir,
} from '../paths';
import {
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
  setWorktreeRegistryReconciler,
} from '../workspace-persistence';
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

/** A clone of a bare origin with `main` and `develop`, both pushed. */
function createRepository(root: string, name: string): string {
  const origin = path.join(root, `${name}.git`);
  const work = path.join(root, name);
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  git(work, ['config', 'user.name', 'Canopy Test']);
  git(work, ['config', 'user.email', 'test@canopy.example']);
  git(work, ['config', 'commit.gpgsign', 'false']);
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
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
  });

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
      await writeJson(getWorkspaceWorktreesFilePath(SINGLE), {
        version: 1,
        worktrees: [],
      });
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
      const registeredBefore = git(singleRepo, [
        'worktree',
        'list',
        '--porcelain',
      ]);
      expect(registeredBefore).toContain(orphan);
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
      const registeredAfter = git(singleRepo, [
        'worktree',
        'list',
        '--porcelain',
      ]);
      expect(registeredAfter).not.toContain(`worktree ${orphan}\n`);
      expect(registeredAfter).toContain(`worktree ${held}\n`);
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
    store = desktopStore.createW5CommitLogFileStore(() => host);
    desktopStore.__setDesktopW5FileStoreForTests(store);
  });
  afterEach(async () => {
    const desktopStore = await import('../w5-commit-log-file-store');
    desktopStore.__setDesktopW5FileStoreForTests(undefined);
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await host.shutdown();
    await rm(dir, { recursive: true, force: true });
  });
  it.each(['con', 'a'.repeat(128), 'a'.repeat(129)])(
    'creates desktop workspace %s through the commit log',
    async (name) => {
      const { createAndPersistNewMultiRepoWorkspace } =
        await import('../workspace-service');
      const result = await createAndPersistNewMultiRepoWorkspace(name);
      expect(result.id).toBe(name);
      const index: unknown = JSON.parse(
        await readFile(getWorkspaceIndexFilePath(), 'utf8'),
      );
      expect(index).toHaveProperty(
        'workspaces',
        expect.arrayContaining([expect.objectContaining({ id: name })]),
      );
      expect(
        JSON.parse(await readFile(getWorkspaceConfigPath(name), 'utf8')),
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
