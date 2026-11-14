import type * as TestHost from '../../w5-routed-writes/__tests__/fixtures/w5-test-commit-log-host';
import type * as CoreStorage from '@canopy/core-runtime/storage';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TestHost
    >('../../w5-routed-writes/__tests__/fixtures/w5-test-commit-log-host')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  return {
    ...actual,
    STORAGE_OWNERSHIP: actual.STORAGE_OWNERSHIP.map((row) =>
      ['workspace_index', 'workspace_manifest', 'worktree_list'].includes(
        row.id,
      )
        ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
        : row,
    ),
  };
});
import type { CreateWorktreeServiceOptions } from '../worktree-service';
import type { WorktreeData, ArchiveWorktreeResponse } from '../../../types';
import { startW5ServiceAdapter } from '../../w5-routed-writes/__tests__/fixtures/w5-service-adapter';
let routed: Awaited<ReturnType<typeof startW5ServiceAdapter>>;
const createSingleRepoWorktree = (
  options: CreateWorktreeServiceOptions,
): Promise<WorktreeData> => routed.createWorktree(options);
const createMultiRepoWorktree = createSingleRepoWorktree;
const archiveSingleRepoWorktree = (options: {
  workspaceId: string;
  worktreeId: string;
}): Promise<ArchiveWorktreeResponse> => routed.deleteWorktree(options);
const archiveMultiRepoWorktree = archiveSingleRepoWorktree;
import { DatabaseSync } from 'node:sqlite';
import * as deleteGate from '@canopy/core-platform/w5-process-file-lock';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import * as corePlatform from '@canopy/core-platform';
import * as cliReads from '../worktree-cli-reads';
import * as processLocks from '@canopy/execution-engine/node/w5-host-cohort/process-file-lock';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { leaveW5RootPresenceSync } from '../../w5-root-presence';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '../../../types';
import {
  ensureAgentsMdSymlinkOrCopy,
  listWorktreeCliRepoEntries,
  listWorktreePipelineExecutions,
} from '../worktree-service';
import { BrowserProfileRepository } from '../../browser-profiles/repository';
import { resolveBrowserTaskOwner } from '../../browser-profiles/owners';
import { BrowserProfileError } from '../../../browser-profile-error';
import { randomUUID } from 'node:crypto';
import {
  createInitialState,
  normalizePipeline,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';

function including(values: unknown[]): unknown {
  return expect.arrayContaining(values);
}
function containing(value: Record<string, unknown>): unknown {
  return expect.objectContaining(value);
}

function observeDurableRecovery(): () => Awaited<
  ReturnType<typeof routed.durableState>
> {
  let captured: Awaited<ReturnType<typeof routed.durableState>> | undefined;
  const mark = routed.transport.markReservationRecoveryRequired.bind(
    routed.transport,
  );
  jest
    .spyOn(routed.transport, 'markReservationRecoveryRequired')
    .mockImplementation(async (input) => {
      await mark(input);
      captured = await routed.durableState();
    });
  return () => {
    if (!captured)
      throw new Error(
        'No independently observed durable recovery mark before rejection',
      );
    expect(captured.reservations).toHaveLength(1);
    expect(captured.reservations[0]?.state).toBe('recovery-required');
    return captured;
  };
}

function pendingOwner(
  dataDir: string,
  workspaceId: string,
  worktreeId: string,
): string {
  const value: unknown = readWorktrees(dataDir, workspaceId);
  if (!isRecord(value) || !Array.isArray(value.worktrees))
    throw new Error('Invalid worktree list');
  const row: unknown = value.worktrees.find(
    (entry: unknown) => isRecord(entry) && entry.id === worktreeId,
  );
  if (
    !isRecord(row) ||
    !isRecord(row.creation) ||
    typeof row.creation.operationId !== 'string'
  )
    throw new Error('Missing retained creation owner');
  return row.creation.operationId;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'hello\n', 'utf8');
  runGit(repoPath, ['add', 'README.md']);
  runGit(repoPath, ['commit', '-m', 'initial']);
}

function currentBranch(repoPath: string): string {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();
}

function writeWorkspaceIndex(
  dataDir: string,
  entries: Array<{
    id: string;
    name: string;
    type: 'single-repo' | 'multi-repo';
  }>,
): void {
  const workspacesDir = path.join(dataDir, 'workspaces');
  fs.mkdirSync(workspacesDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspacesDir, 'index.json'),
    JSON.stringify(
      {
        version: 1,
        workspaces: entries.map((entry, index) => ({
          ...entry,
          color: '#0284c7',
          collapsed: false,
          order: index,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
}

function writeWorkspaceConfig(
  dataDir: string,
  workspaceId: string,
  config: Record<string, unknown>,
): void {
  const workspaceDir = path.join(dataDir, 'workspaces', workspaceId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'workspace.json'),
    JSON.stringify({ version: 1, ...config }, null, 2),
    'utf8',
  );
}

function readWorktrees(dataDir: string, workspaceId: string): unknown {
  const filePath = path.join(
    dataDir,
    'workspaces',
    workspaceId,
    'worktrees.json',
  );
  if (!fs.existsSync(filePath)) {
    return { version: 1, worktrees: [] };
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('desktop-shared node worktree service', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-worktree-service-'),
    );
    process.env.CANOPY_DATA_DIR = path.join(tempDir, 'data');
    routed = await startW5ServiceAdapter(process.env.CANOPY_DATA_DIR ?? '');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await routed.close();
    leaveW5RootPresenceSync();
    await Promise.resolve();
    jest.restoreAllMocks();
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not delete a competing creator checkout when Git refuses the candidate path', async () => {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    const winnerPath = path.join(
      dataDir,
      'workspaces',
      'single',
      'worktrees',
      'contended',
    );
    fs.mkdirSync(winnerPath, { recursive: true });
    fs.writeFileSync(
      path.join(winnerPath, 'winner.txt'),
      'owned by another invocation',
    );
    await expect(
      createSingleRepoWorktree({
        workspaceId: 'single',
        branchName: 'contended',
      }),
    ).rejects.toThrow();
    expect(fs.readFileSync(path.join(winnerPath, 'winner.txt'), 'utf8')).toBe(
      'owned by another invocation',
    );
  });

  it('keeps two concurrent CLI creates that read the same original list', async () => {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    const actual = cliReads.runGit;
    let arrived = 0;
    let release = (): void => undefined;
    const bothCreated = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(cliReads, 'runGit').mockImplementation(async (args, cwd) => {
      const output = await actual(args, cwd);
      if (args[0] === 'worktree' && args[1] === 'add') {
        if (++arrived === 2) release();
        await bothCreated;
      }
      return output;
    });
    await Promise.all(
      ['first', 'second'].map((branchName) =>
        createSingleRepoWorktree({
          workspaceId: 'single',
          branchName,
          seedPanelLayoutMode: false,
        }),
      ),
    );
    const result = await cliReads.readWorktrees('single');
    expect(result.map((row) => row.id).sort()).toEqual(['first', 'second']);
  });

  it.each(['single', 'multi-source', 'multi-member'] as const)(
    'reports uncertain effects when the first Git add fails after creating a checkout: %s',
    async (mode) => {
      const repoPath = path.join(tempDir, 'repo');
      initRepo(repoPath);
      const dataDir = process.env.CANOPY_DATA_DIR ?? '';
      writeWorkspaceIndex(dataDir, [
        {
          id: 'partial',
          name: 'Partial',
          type: mode === 'single' ? 'single-repo' : 'multi-repo',
        },
      ]);
      writeWorkspaceConfig(
        dataDir,
        'partial',
        mode === 'single'
          ? { type: 'single-repo', repoPath, repos: [] }
          : {
              type: 'multi-repo',
              repos:
                mode === 'multi-member'
                  ? [{ id: 'repo', name: 'Repo', repoPath }]
                  : [],
              ...(mode === 'multi-source' ? { sourceRepoPath: repoPath } : {}),
            },
      );
      const primary = new Error('Git hook failed after checkout creation');
      const actual = cliReads.runGit;
      let attemptedPath = '';
      jest.spyOn(cliReads, 'runGit').mockImplementation(async (args, cwd) => {
        const output = await actual(args, cwd);
        if (args[0] === 'worktree' && args[1] === 'add') {
          attemptedPath = args[4] ?? '';
          throw primary;
        }
        return output;
      });
      const create =
        mode === 'single' ? createSingleRepoWorktree : createMultiRepoWorktree;
      const durable = observeDurableRecovery();
      const error: unknown = await create({
        workspaceId: 'partial',
        branchName: 'candidate',
        seedPanelLayoutMode: false,
      }).catch((caught: unknown) => caught);
      expect(error).toBe(primary);
      const state = durable();
      expect(state.reservations[0]).toMatchObject({
        operation: 'core.worktree.create',
        diagnostics: {
          workspaceId: 'partial',
          ownedPaths: including([attemptedPath]),
        },
      });
      expect(pendingOwner(dataDir, 'partial', 'candidate')).toBe(
        state.reservations[0]?.reservationId,
      );
      expect(fs.existsSync(path.join(attemptedPath, 'README.md'))).toBe(true);
      expect(readWorktrees(dataDir, 'partial')).toMatchObject({
        version: 1,
        worktrees: [
          {
            id: 'candidate',
            creation: { operationId: state.reservations[0]?.reservationId },
            setupPhase: 'git-pending',
          },
        ],
      });
    },
  );

  it('retains a peer replacement when routed creation fails for the same candidate ID', async () => {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    const file = path.join(dataDir, 'workspaces/single/worktrees.json');
    const winner = {
      id: 'candidate',
      branchName: 'winner',
      createdAt: 'later',
      cliCreationToken: 'other-invocation',
    };

    const metadata = path.join(
      dataDir,
      'workspaces/single/worktree-data/candidate',
    );
    fs.mkdirSync(metadata, { recursive: true });
    fs.writeFileSync(path.join(metadata, 'winner.txt'), 'keep');
    const primary = new Error('Git failed after a peer replaced the candidate');
    const actualGit = cliReads.runGit;
    const durable = observeDurableRecovery();
    jest.spyOn(cliReads, 'runGit').mockImplementation(async (args, cwd) => {
      const output = await actualGit(args, cwd);
      if (args[0] === 'worktree' && args[1] === 'add') {
        fs.writeFileSync(
          file,
          JSON.stringify({ version: 1, worktrees: [winner] }),
        );
        throw primary;
      }
      return output;
    });
    await expect(
      createSingleRepoWorktree({
        workspaceId: 'single',
        branchName: 'candidate',
        seedPanelLayoutMode: false,
      }),
    ).rejects.toBe(primary);
    expect(durable().reservations[0]).toMatchObject({
      operation: 'core.worktree.create',
      diagnostics: { workspaceId: 'single' },
    });
    expect(readWorktrees(dataDir, 'single')).toEqual({
      version: 1,
      worktrees: [winner],
    });
    expect(fs.readFileSync(path.join(metadata, 'winner.txt'), 'utf8')).toBe(
      'keep',
    );
  });

  it.each(['single', 'multi'] as const)(
    'reports partial archive effects if metadata locking fails after Git removal: %s',
    async (mode) => {
      const repoPath = path.join(tempDir, 'repo');
      initRepo(repoPath);
      const dataDir = process.env.CANOPY_DATA_DIR ?? '';
      writeWorkspaceIndex(dataDir, [
        {
          id: 'archive',
          name: 'Archive',
          type: mode === 'single' ? 'single-repo' : 'multi-repo',
        },
      ]);
      writeWorkspaceConfig(
        dataDir,
        'archive',
        mode === 'single'
          ? { type: 'single-repo', repoPath, repos: [] }
          : {
              type: 'multi-repo',
              repos: [{ id: 'repo', name: 'Repo', repoPath }],
            },
      );
      const create =
        mode === 'single' ? createSingleRepoWorktree : createMultiRepoWorktree;
      await create({
        workspaceId: 'archive',
        branchName: 'candidate',
        seedPanelLayoutMode: false,
      });
      const listPath = path.join(dataDir, 'workspaces/archive/worktrees.json');
      const before = fs.readFileSync(listPath, 'utf8');
      const primary = new processLocks.W5ProcessFileLockTimeoutError(listPath);
      const commit = routed.transport.commit.bind(routed.transport);
      jest
        .spyOn(routed.transport, 'commit')
        .mockImplementation(async (request) => {
          if (request.operation === 'internal.cli.worktree.delete.remove')
            throw primary;
          return commit(request);
        });
      const durable = observeDurableRecovery();
      const acquire = deleteGate.acquireW5DesktopDeleteGate;
      let latchObservedBeforeRejection = false;
      jest
        .spyOn(deleteGate, 'acquireW5DesktopDeleteGate')
        .mockImplementation(async (...args) => {
          const gate = await acquire(...args);
          return {
            ...gate,
            close: (): void => {
              gate.close();
              if (args[1] === 'delete') {
                const db = new DatabaseSync(
                  path.join(dataDir, 'runtime/locks/desktop-delete.sqlite'),
                  { readOnly: true },
                );
                try {
                  expect(
                    db.prepare('SELECT reservation_id FROM deletion_hold').get()
                      ?.reservation_id,
                  ).toBe(durable().reservations[0]?.reservationId);
                  latchObservedBeforeRejection = true;
                } finally {
                  db.close();
                }
              }
            },
          };
        });
      const gitCalls = jest.spyOn(cliReads, 'runGit');
      const archive =
        mode === 'single'
          ? archiveSingleRepoWorktree
          : archiveMultiRepoWorktree;
      await expect(
        archive({ workspaceId: 'archive', worktreeId: 'candidate' }),
      ).rejects.toBe(primary);
      expect(latchObservedBeforeRejection).toBe(true);
      expect(durable().reservations[0]).toMatchObject({
        operation: 'core.worktree.delete',
        state: 'recovery-required',
      });
      expect(
        fs.existsSync(
          path.join(dataDir, 'workspaces/archive/worktrees/candidate'),
        ),
      ).toBe(false);
      expect(fs.readFileSync(listPath, 'utf8')).toBe(before);
      expect(
        gitCalls.mock.calls.filter(
          ([args]) => args[0] === 'worktree' && args[1] === 'remove',
        ),
      ).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'keeps a peer list edit made during Git, including unknown data (Git fails: %s)',
    async (failGit) => {
      const repoPath = path.join(tempDir, 'repo');
      initRepo(repoPath);
      const dataDir = process.env.CANOPY_DATA_DIR ?? '';
      writeWorkspaceIndex(dataDir, [
        { id: 'single', name: 'Single', type: 'single-repo' },
      ]);
      writeWorkspaceConfig(dataDir, 'single', {
        type: 'single-repo',
        repoPath,
      });
      const listPath = path.join(dataDir, 'workspaces/single/worktrees.json');
      const git = cliReads.runGit;
      jest.spyOn(cliReads, 'runGit').mockImplementation(async (args, cwd) => {
        const result = await git(args, cwd);
        if (args[0] === 'worktree' && args[1] === 'add') {
          const previous: unknown = fs.existsSync(listPath)
            ? JSON.parse(fs.readFileSync(listPath, 'utf8'))
            : { version: 1, worktrees: [] };
          if (!isRecord(previous) || !Array.isArray(previous.worktrees))
            throw new Error('Invalid worktree document');
          const previousRows: unknown[] = previous.worktrees;
          fs.writeFileSync(
            listPath,
            JSON.stringify({
              ...previous,
              futureDocumentField: 'keep',
              worktrees: [
                ...previousRows,
                {
                  id: 'peer',
                  branchName: 'peer',
                  createdAt: '2026-01-01',
                  futureRowField: { keep: true },
                },
              ],
            }),
          );
          if (failGit) throw new Error('Git failed after peer edit');
        }
        return result;
      });
      const creation = createSingleRepoWorktree({
        workspaceId: 'single',
        branchName: 'new',
      });
      if (failGit)
        await expect(creation).rejects.toThrow('Git failed after peer edit');
      else await creation;
      const expectedPeer: unknown = including([
        {
          id: 'peer',
          branchName: 'peer',
          createdAt: '2026-01-01',
          futureRowField: { keep: true },
        },
      ]);
      expect(readWorktrees(dataDir, 'single')).toMatchObject({
        futureDocumentField: 'keep',
        worktrees: expectedPeer,
      });
    },
  );

  it('journals browser retirement after CLI owner removal without an Electron runtime', async () => {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    const task = await createSingleRepoWorktree({
      workspaceId: 'single',
      branchName: 'browser-retirement',
      baseBranch: currentBranch(repoPath),
    });
    const owner = await resolveBrowserTaskOwner(dataDir, 'single', task.id);
    if (!owner) throw new Error('Expected registered CLI task');
    const profiles = new BrowserProfileRepository(
      path.join(dataDir, 'browser-profiles'),
    );
    const profile = await profiles.ensureTask(
      owner.scope,
      owner.createdAt,
      randomUUID(),
    );
    await archiveSingleRepoWorktree({
      workspaceId: 'single',
      worktreeId: task.id,
    });
    expect(
      await resolveBrowserTaskOwner(dataDir, 'single', task.id),
    ).toBeNull();
    expect(await profiles.getTask(owner.scope)).toMatchObject({
      lifecycle: 'retired',
    });
    expect(await profiles.getCleanupJobs()).toEqual([
      containing({
        profileId: profile.profileId,
        storageGeneration: profile.storageGeneration,
        status: 'pending',
      }),
    ]);
  });

  it.each(['prepareRetirement', 'commitRetirement'] as const)(
    'archives a CLI worktree when browser profile %s fails',
    async (method) => {
      const repoPath = path.join(tempDir, 'repo');
      initRepo(repoPath);
      const dataDir = process.env.CANOPY_DATA_DIR ?? '';
      writeWorkspaceIndex(dataDir, [
        { id: 'single', name: 'Single', type: 'single-repo' },
      ]);
      writeWorkspaceConfig(dataDir, 'single', {
        type: 'single-repo',
        repoPath,
        repos: [],
      });
      const task = await createSingleRepoWorktree({
        workspaceId: 'single',
        branchName: `browser-${method}`,
        baseBranch: currentBranch(repoPath),
      });
      const owner = await resolveBrowserTaskOwner(dataDir, 'single', task.id);
      if (!owner) throw new Error('Expected registered CLI task');
      await new BrowserProfileRepository(
        path.join(dataDir, 'browser-profiles'),
      ).ensureTask(owner.scope, owner.createdAt, randomUUID());
      jest
        .spyOn(BrowserProfileRepository.prototype, method)
        .mockRejectedValueOnce(
          new BrowserProfileError(
            'storage_unavailable',
            'Browser profile metadata is in use by another process.',
          ),
        );

      const response = await archiveSingleRepoWorktree({
        workspaceId: 'single',
        worktreeId: task.id,
      });

      expect(response.success).toBe(true);
      expect(
        await resolveBrowserTaskOwner(dataDir, 'single', task.id),
      ).toBeNull();
      expect(response.warnings).toEqual([
        expect.stringMatching(/browser data/i),
        'Any remaining chats, summaries and observability sidecars need desktop reconciliation the next time the app starts.',
      ]);
    },
  );

  describe('instruction alias platform selection', () => {
    const filePorts = jest.requireActual<typeof FsPromises>('node:fs/promises');

    beforeEach(() => {
      jest.spyOn(filePorts, 'rm').mockResolvedValue(undefined);
      jest.spyOn(filePorts, 'symlink').mockResolvedValue(undefined);
      jest.spyOn(filePorts, 'link').mockResolvedValue(undefined);
      jest.spyOn(filePorts, 'copyFile').mockResolvedValue(undefined);
    });

    it('selects the default host platform at each invocation', async () => {
      const selectPlatform = jest
        .spyOn(corePlatform, 'hostPlatformOperatingSystem')
        .mockReturnValue('win32');
      const agentsPath = path.join(tempDir, 'AGENTS.md');

      await ensureAgentsMdSymlinkOrCopy(tempDir);

      expect(filePorts.symlink).not.toHaveBeenCalled();
      expect(filePorts.link).toHaveBeenCalledWith(
        path.join(tempDir, 'CLAUDE.md'),
        agentsPath,
      );
      selectPlatform.mockReturnValue('darwin');

      await ensureAgentsMdSymlinkOrCopy(tempDir);

      expect(selectPlatform).toHaveBeenCalledTimes(2);
      expect(filePorts.symlink).toHaveBeenCalledWith('CLAUDE.md', agentsPath);
      expect(filePorts.link).toHaveBeenCalledTimes(1);
      expect(filePorts.copyFile).not.toHaveBeenCalled();
    });

    it('propagates host selection failure before changing instruction files', async () => {
      const failure = new corePlatform.PlatformServicesError(
        'unsupported_platform',
        'Unsupported test host',
      );
      jest
        .spyOn(corePlatform, 'hostPlatformOperatingSystem')
        .mockImplementation(() => {
          throw failure;
        });

      await expect(ensureAgentsMdSymlinkOrCopy(tempDir)).rejects.toBe(failure);

      expect(filePorts.rm).not.toHaveBeenCalled();
      expect(filePorts.symlink).not.toHaveBeenCalled();
      expect(filePorts.link).not.toHaveBeenCalled();
      expect(filePorts.copyFile).not.toHaveBeenCalled();
    });

    it.each(['win32', 'darwin', 'linux'] as const)(
      'bypasses host selection with an explicit %s platform',
      async (platform) => {
        const selectPlatform = jest
          .spyOn(corePlatform, 'hostPlatformOperatingSystem')
          .mockImplementation(() => {
            throw new Error('Host selection must not run');
          });

        await ensureAgentsMdSymlinkOrCopy(tempDir, platform);

        expect(selectPlatform).not.toHaveBeenCalled();
        expect(filePorts.rm).toHaveBeenCalledWith(
          path.join(tempDir, 'AGENTS.md'),
          { recursive: true, force: true },
        );
        expect(filePorts.symlink).toHaveBeenCalledTimes(
          platform === 'win32' ? 0 : 1,
        );
        expect(filePorts.link).toHaveBeenCalledTimes(
          platform === 'win32' ? 1 : 0,
        );
      },
    );
  });

  it('mirrors AGENTS.md without a symlink on Windows', async () => {
    const worktreeRoot = path.join(tempDir, 'windows-instructions');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeRoot, 'CLAUDE.md'),
      'current instructions\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(worktreeRoot, 'AGENTS.md'),
      'stale instructions\n',
      'utf8',
    );

    await ensureAgentsMdSymlinkOrCopy(worktreeRoot, 'win32');

    const agentsPath = path.join(worktreeRoot, 'AGENTS.md');
    expect(fs.lstatSync(agentsPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(agentsPath, 'utf8')).toBe(
      fs.readFileSync(path.join(worktreeRoot, 'CLAUDE.md'), 'utf8'),
    );
  });

  it('retains the owned record and durable recovery evidence when single-repo git setup fails', async () => {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    fs.writeFileSync(
      path.join(dataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: { workspaceDefaultLayoutMode: 'minimal' },
      }),
      'utf8',
    );

    const durable = observeDurableRecovery();
    await expect(
      createSingleRepoWorktree({
        workspaceId: 'single',
        branchName: 'feature',
        baseBranch: 'missing-base',
      }),
    ).rejects.toThrow();

    const state = durable();
    expect(pendingOwner(dataDir, 'single', 'feature')).toBe(
      state.reservations[0]?.reservationId,
    );
    expect(readWorktrees(dataDir, 'single')).toMatchObject({
      worktrees: [{ id: 'feature', setupPhase: 'git-pending' }],
    });
  });

  it('creates a single-repo worktree from an explicitly targeted remote base branch', async () => {
    const repoPath = path.join(tempDir, 'repo');
    const remotePath = path.join(tempDir, 'remote.git');
    initRepo(repoPath);
    runGit(tempDir, ['init', '--bare', remotePath]);
    runGit(repoPath, ['remote', 'add', 'origin', remotePath]);
    runGit(repoPath, ['branch', 'release/next']);
    runGit(repoPath, ['push', 'origin', 'release/next']);
    runGit(repoPath, ['branch', '-D', 'release/next']);
    runGit(repoPath, ['fetch', 'origin']);

    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });

    const result = await createSingleRepoWorktree({
      workspaceId: 'single',
      branchName: 'feature-from-remote',
      baseBranch: 'origin/release/next',
    });

    expect(result).toMatchObject({
      branchName: 'feature-from-remote',
      trackedBaseBranch: 'origin/release/next',
    });
    expect(
      execFileSync('git', ['rev-parse', 'feature-from-remote'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim(),
    ).toBe(
      execFileSync('git', ['rev-parse', 'origin/release/next'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim(),
    );
  });

  it('preserves restored files-only provenance when adding a sibling worktree at the top', async () => {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    fs.writeFileSync(
      path.join(dataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: { workspaceDefaultLayoutMode: 'minimal' },
      }),
      'utf8',
    );
    const workspaceDir = path.join(dataDir, 'workspaces', 'single');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const restoredDir = path.join(workspaceDir, 'worktrees', 'existing');
    fs.mkdirSync(restoredDir, { recursive: true });
    fs.writeFileSync(path.join(restoredDir, 'restored.txt'), 'restored');
    expect(fs.existsSync(path.join(restoredDir, '.git'))).toBe(false);
    fs.writeFileSync(
      path.join(workspaceDir, 'worktrees.json'),
      JSON.stringify(
        {
          version: 1,
          worktrees: [
            {
              id: 'existing',
              branchName: 'existing',
              createdAt: '2026-01-01T00:00:00.000Z',
              label: 'Existing label',
              restoredFromFilesOnlyArchiveId: 'files-only-archive',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    await createSingleRepoWorktree({
      workspaceId: 'single',
      branchName: 'new-branch',
      baseBranch: currentBranch(repoPath),
    });

    // New worktrees lead the manual order, matching the desktop app.
    expect(readWorktrees(dataDir, 'single')).toMatchObject({
      worktrees: [
        {
          id: 'new-branch',
          branchName: 'new-branch',
        },
        {
          id: 'existing',
          label: 'Existing label',
          restoredFromFilesOnlyArchiveId: 'files-only-archive',
        },
      ],
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            dataDir,
            'workspaces',
            'single',
            'worktree-data',
            'new-branch',
            'panel-layout-mode.json',
          ),
          'utf8',
        ),
      ),
    ).toEqual({ version: 1, mode: 'minimal' });
  });

  it('logs a failed seed without failing shared Node worktree creation', async () => {
    const repoPath = path.join(tempDir, 'seed-failure-repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'seed-failure', name: 'Seed Failure', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'seed-failure', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    const blockedModeDir = path.join(
      dataDir,
      'workspaces',
      'seed-failure',
      'worktree-data',
      'blocked-seed',
    );
    fs.mkdirSync(path.dirname(blockedModeDir), { recursive: true });
    fs.writeFileSync(blockedModeDir, 'not a directory', 'utf8');
    const warning = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      await expect(
        createSingleRepoWorktree({
          workspaceId: 'seed-failure',
          branchName: 'blocked-seed',
          baseBranch: currentBranch(repoPath),
        }),
      ).resolves.toMatchObject({ id: 'blocked-seed' });
      expect(warning).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Failed to seed worktree panel layout mode \(workspaceId=seed-failure, worktreeId=blocked-seed\): .+\n$/,
        ),
      );
      expect(readWorktrees(dataDir, 'seed-failure')).toMatchObject({
        worktrees: [{ id: 'blocked-seed' }],
      });
    } finally {
      warning.mockRestore();
    }
  });

  it('does not seed the fixed App Advisor worktree', async () => {
    const repoPath = path.join(tempDir, 'app-advisor-repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      {
        id: APP_ADVISOR_PROJECT_ID,
        name: 'App Advisor',
        type: 'single-repo',
      },
    ]);
    writeWorkspaceConfig(dataDir, APP_ADVISOR_PROJECT_ID, {
      type: 'single-repo',
      repoPath,
      repos: [],
    });

    await createSingleRepoWorktree({
      workspaceId: APP_ADVISOR_PROJECT_ID,
      branchName: APP_ADVISOR_WORKTREE_ID,
      baseBranch: currentBranch(repoPath),
    });

    expect(
      fs.existsSync(
        path.join(
          dataDir,
          'workspaces',
          APP_ADVISOR_PROJECT_ID,
          'worktree-data',
          APP_ADVISOR_WORKTREE_ID,
          'panel-layout-mode.json',
        ),
      ),
    ).toBe(false);
  });

  it('preserves persisted PR labels when normalizing worktree metadata', async () => {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    const workspaceDir = path.join(dataDir, 'workspaces', 'single');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'worktrees.json'),
      JSON.stringify(
        {
          version: 1,
          worktrees: [
            {
              id: 'existing',
              branchName: 'existing',
              createdAt: '2026-01-01T00:00:00.000Z',
              lastKnownPrStatus: {
                repos: [
                  {
                    repoId: 'repo',
                    repoName: 'Repo',
                    status: {
                      prNumber: 123,
                      prUrl: 'https://github.com/example/repo/pull/123',
                      state: 'open',
                      title: 'Add labels',
                      checkStatus: 'passing',
                      checkDetails: [],
                      reviewStatus: 'approved',
                      reviewers: [],
                      labels: [
                        {
                          name: 'bug',
                          color: 'd73a4a',
                          description: 'Broken behavior',
                        },
                        {
                          name: 'missing-color',
                          color: '',
                          description: null,
                        },
                        {
                          name: '',
                          color: '0e8a16',
                          description: null,
                        },
                      ],
                      hasConflicts: false,
                      commentCount: 0,
                      updatedAt: '2026-01-01T00:00:00.000Z',
                    },
                  },
                ],
                lastCheckedAt: '2026-01-01T00:00:00.000Z',
              },
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    await createSingleRepoWorktree({
      workspaceId: 'single',
      branchName: 'new-branch',
      baseBranch: currentBranch(repoPath),
    });

    expect(readWorktrees(dataDir, 'single')).toMatchObject({
      worktrees: [
        { id: 'new-branch' },
        {
          id: 'existing',
          lastKnownPrStatus: {
            repos: [
              {
                status: {
                  labels: [
                    {
                      name: 'bug',
                      color: 'd73a4a',
                      description: 'Broken behavior',
                    },
                    {
                      name: 'missing-color',
                      color: '',
                      description: null,
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it('preserves persisted merge queue state when normalizing worktree metadata', async () => {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    const status = (
      prNumber: number,
      mergeQueue: unknown,
    ): Record<string, unknown> => ({
      repoId: `repo-${prNumber}`,
      repoName: `Repo ${prNumber}`,
      status: {
        prNumber,
        prUrl: `https://github.com/example/repo/pull/${prNumber}`,
        state: 'open',
        title: 'Queued',
        checkStatus: 'passing',
        checkDetails: [],
        reviewStatus: 'approved',
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-01-01T00:00:00.000Z',
        mergeQueue,
      },
    });
    const workspaceDir = path.join(dataDir, 'workspaces', 'single');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'existing',
            branchName: 'existing',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastKnownPrStatus: {
              repos: [
                status(1, { required: true, inQueue: true, position: 2 }),
                status(2, { required: true, inQueue: false }),
                status(3, { required: 'yes', inQueue: true }),
                status(4, {
                  required: true,
                  inQueue: true,
                  position: 1,
                  phase: 'awaiting_checks',
                }),
                status(5, {
                  required: true,
                  inQueue: true,
                  position: 1,
                  phase: 'some_future_phase',
                }),
                status(6, { required: true, inQueue: false, phase: 'queued' }),
                status(7, { required: true, inQueue: true, phase: 7 }),
                status(8, { required: true, inQueue: true, phase: 'locked' }),
                status(9, { required: true }),
                status(10, { inQueue: true, position: 2 }),
                status(11, {}),
              ],
              lastCheckedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      }),
      'utf8',
    );

    await createSingleRepoWorktree({
      workspaceId: 'single',
      branchName: 'new-branch',
      baseBranch: currentBranch(repoPath),
    });

    const withoutMergeQueue: unknown = expect.not.objectContaining({
      mergeQueue: expect.anything() as unknown,
    });
    expect(readWorktrees(dataDir, 'single')).toMatchObject({
      worktrees: [
        { id: 'new-branch' },
        {
          id: 'existing',
          lastKnownPrStatus: {
            repos: [
              {
                status: {
                  mergeQueue: { required: true, inQueue: true, position: 2 },
                },
              },
              {
                status: {
                  mergeQueue: { required: true, inQueue: false },
                },
              },
              { status: withoutMergeQueue },
              {
                status: {
                  mergeQueue: {
                    required: true,
                    inQueue: true,
                    position: 1,
                    phase: 'awaiting_checks',
                  },
                },
              },
              {
                status: {
                  mergeQueue: {
                    required: true,
                    inQueue: true,
                    position: 1,
                    phase: 'unknown',
                  },
                },
              },
              {
                status: {
                  mergeQueue: { required: true, inQueue: false },
                },
              },
              {
                status: {
                  mergeQueue: { required: true, inQueue: true },
                },
              },
              {
                status: {
                  mergeQueue: {
                    required: true,
                    inQueue: true,
                    phase: 'locked',
                  },
                },
              },
              { status: { mergeQueue: { required: true } } },
              { status: { mergeQueue: { inQueue: true, position: 2 } } },
              { status: withoutMergeQueue },
            ],
          },
        },
      ],
    });
    // Older snapshots, non-queued entries, and non-string phases carry no phase.
    const withoutPhase: unknown = expect.not.objectContaining({
      phase: expect.anything() as unknown,
    });
    expect(readWorktrees(dataDir, 'single')).toMatchObject({
      worktrees: [
        { id: 'new-branch' },
        {
          id: 'existing',
          lastKnownPrStatus: {
            repos: [
              { status: { mergeQueue: withoutPhase } },
              { status: { mergeQueue: withoutPhase } },
              { status: withoutMergeQueue },
              {},
              {},
              { status: { mergeQueue: withoutPhase } },
              { status: { mergeQueue: withoutPhase } },
              {},
              { status: { mergeQueue: withoutPhase } },
              { status: { mergeQueue: withoutPhase } },
              { status: withoutMergeQueue },
            ],
          },
        },
      ],
    });
  });

  it('preserves persisted check execution states when normalizing worktree metadata', async () => {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    const workspaceDir = path.join(dataDir, 'workspaces', 'single');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'worktrees.json'),
      JSON.stringify(
        {
          version: 1,
          worktrees: [
            {
              id: 'existing',
              branchName: 'existing',
              createdAt: '2026-01-01T00:00:00.000Z',
              lastKnownPrStatus: {
                repos: [
                  {
                    repoId: 'repo',
                    repoName: 'Repo',
                    status: {
                      prNumber: 123,
                      prUrl: 'https://github.com/example/repo/pull/123',
                      state: 'open',
                      title: 'Checks',
                      checkStatus: 'failing',
                      checkDetails: [
                        {
                          name: 'build',
                          status: 'pending',
                          executionState: 'running',
                          detailsUrl: 'https://example.com/build',
                        },
                        {
                          name: 'e2e',
                          status: 'failing',
                          executionState: 'timed_out',
                          detailsUrl: null,
                        },
                        { name: 'legacy', status: 'passing', detailsUrl: null },
                        {
                          name: 'newer-state',
                          status: 'neutral',
                          executionState: 'mystery',
                          detailsUrl: null,
                        },
                        {
                          name: 'malformed-state',
                          status: 'failing',
                          executionState: 7,
                          detailsUrl: null,
                        },
                      ],
                      reviewStatus: 'none',
                      reviewers: [],
                      hasConflicts: false,
                      commentCount: 0,
                      updatedAt: '2026-01-01T00:00:00.000Z',
                    },
                  },
                ],
                lastCheckedAt: '2026-01-01T00:00:00.000Z',
              },
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    await createSingleRepoWorktree({
      workspaceId: 'single',
      branchName: 'new-branch',
      baseBranch: currentBranch(repoPath),
    });

    const persisted = readWorktrees(dataDir, 'single');
    // Known states survive the rewrite; an unknown or malformed optional
    // state is dropped without discarding its otherwise valid row.
    expect(persisted).toMatchObject({
      worktrees: [
        { id: 'new-branch' },
        {
          id: 'existing',
          lastKnownPrStatus: {
            repos: [
              {
                status: {
                  checkDetails: [
                    { name: 'build', executionState: 'running' },
                    { name: 'e2e', executionState: 'timed_out' },
                    { name: 'legacy', status: 'passing' },
                    { name: 'newer-state', status: 'neutral' },
                    { name: 'malformed-state', status: 'failing' },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('mystery');
    expect(serialized).not.toContain('"executionState":7');
    expect(serialized.match(/"executionState"/g)).toHaveLength(2);
  });

  it('creates and repairs the source-backed project root worktree', async () => {
    const sourceRepoPath = path.join(tempDir, 'source');
    const childRepoPath = path.join(tempDir, 'child');
    initRepo(sourceRepoPath);
    initRepo(childRepoPath);
    fs.writeFileSync(
      path.join(sourceRepoPath, 'canopy.json'),
      JSON.stringify(
        {
          version: 1,
          repos: [{ id: 'child', name: 'Child', url: childRepoPath }],
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(sourceRepoPath, '.gitignore'),
      'node_modules/\n',
    );
    fs.writeFileSync(path.join(sourceRepoPath, 'CLAUDE.md'), 'instructions\n');
    runGit(sourceRepoPath, ['add', 'canopy.json', '.gitignore', 'CLAUDE.md']);
    runGit(sourceRepoPath, ['commit', '-m', 'project metadata']);

    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'multi', name: 'Multi', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'multi', {
      type: 'multi-repo',
      sourceRepoPath,
      repos: [{ id: 'child', name: 'Child', repoPath: childRepoPath }],
    });

    const created = await createMultiRepoWorktree({
      workspaceId: 'multi',
      branchName: 'feature',
      repairWorkspaceRoot: true,
      restoreClaudeMd: true,
    });

    const rootPath = path.join(
      dataDir,
      'workspaces',
      'multi',
      'worktrees',
      created.id,
    );
    const childPath = path.join(rootPath, 'repos', 'child');
    expect(fs.existsSync(path.join(rootPath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(childPath, '.git'))).toBe(true);
    const repairedGitignore = fs.readFileSync(
      path.join(rootPath, '.gitignore'),
      'utf8',
    );
    expect(repairedGitignore).toContain('node_modules/');
    expect(repairedGitignore).toContain('repos/');
    expect(fs.existsSync(path.join(rootPath, 'AGENTS.md'))).toBe(true);
    expect(fs.readFileSync(path.join(rootPath, 'AGENTS.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(rootPath, 'CLAUDE.md'), 'utf8'),
    );
    expect(readWorktrees(dataDir, 'multi')).toMatchObject({
      worktrees: [{ id: created.id, branchName: 'feature' }],
    });
  });

  it.each([
    'standalone',
    'equal copies',
    'reverse alias',
    'reverse alias copy fallback',
    'independent files',
  ])('restores %s from source during CLI root repair', async (layout) => {
    const sourceRepoPath = path.join(tempDir, 'source');
    const childRepoPath = path.join(tempDir, 'child');
    initRepo(sourceRepoPath);
    initRepo(childRepoPath);
    fs.writeFileSync(
      path.join(sourceRepoPath, 'canopy.json'),
      JSON.stringify(
        {
          version: 1,
          repos: [{ id: 'child', name: 'Child', url: childRepoPath }],
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(sourceRepoPath, '.gitignore'),
      'node_modules/\n',
    );
    fs.writeFileSync(
      path.join(sourceRepoPath, 'AGENTS.md'),
      'canonical guidance\n',
    );
    if (layout.startsWith('reverse alias')) {
      fs.symlinkSync('AGENTS.md', path.join(sourceRepoPath, 'CLAUDE.md'));
    } else if (layout !== 'standalone') {
      fs.writeFileSync(
        path.join(sourceRepoPath, 'CLAUDE.md'),
        layout === 'independent files'
          ? 'Claude-specific guidance\n'
          : 'canonical guidance\n',
      );
    }
    // Instructions are local source edits, absent from the checked-out commit.
    runGit(sourceRepoPath, ['add', 'canopy.json', '.gitignore']);
    runGit(sourceRepoPath, ['commit', '-m', 'project metadata']);

    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'multi', name: 'Multi', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'multi', {
      type: 'multi-repo',
      sourceRepoPath,
      repos: [{ id: 'child', name: 'Child', repoPath: childRepoPath }],
    });

    if (layout === 'reverse alias copy fallback') {
      jest
        .spyOn(
          jest.requireActual<typeof FsPromises>('node:fs/promises'),
          'symlink',
        )
        .mockRejectedValueOnce(
          Object.assign(new Error('symlink not permitted'), { code: 'EPERM' }),
        );
    }
    const created = await createMultiRepoWorktree({
      workspaceId: 'multi',
      branchName: 'feature',
      repairWorkspaceRoot: true,
      restoreClaudeMd: true,
    });

    const rootPath = path.join(
      dataDir,
      'workspaces',
      'multi',
      'worktrees',
      created.id,
    );
    const childPath = path.join(rootPath, 'repos', 'child');
    expect(fs.existsSync(path.join(rootPath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(childPath, '.git'))).toBe(true);
    const repairedGitignore = fs.readFileSync(
      path.join(rootPath, '.gitignore'),
      'utf8',
    );
    expect(repairedGitignore).toContain('node_modules/');
    expect(repairedGitignore).toContain('repos/');
    expect(fs.existsSync(path.join(rootPath, 'AGENTS.md'))).toBe(true);
    expect(fs.readFileSync(path.join(rootPath, 'AGENTS.md'), 'utf8')).toBe(
      'canonical guidance\n',
    );
    expect(
      fs.lstatSync(path.join(rootPath, 'AGENTS.md')).isSymbolicLink(),
    ).toBe(false);
    if (layout === 'standalone') {
      expect(fs.existsSync(path.join(rootPath, 'CLAUDE.md'))).toBe(false);
    } else {
      expect(fs.existsSync(path.join(rootPath, 'CLAUDE.md'))).toBe(true);
      expect(fs.readFileSync(path.join(rootPath, 'CLAUDE.md'), 'utf8')).toBe(
        layout === 'independent files'
          ? 'Claude-specific guidance\n'
          : 'canonical guidance\n',
      );
      expect(
        fs.lstatSync(path.join(rootPath, 'CLAUDE.md')).isSymbolicLink(),
      ).toBe(layout === 'reverse alias' && process.platform !== 'win32');
    }
    expect(readWorktrees(dataDir, 'multi')).toMatchObject({
      worktrees: [{ id: created.id, branchName: 'feature' }],
    });
  });

  it.each([
    ['AGENTS.md', 'directory', false, true],
    ['AGENTS.md', 'nested link', false, true],
    ['AGENTS.md', 'external link', false, true],
    ['CLAUDE.md', 'directory', false, true],
    ['CLAUDE.md', 'external link', false, true],
    ['AGENTS.md', 'directory', true, true],
    ['AGENTS.md', 'nested link', true, true],
    ['AGENTS.md', 'external link', true, true],
    ['CLAUDE.md', 'directory', true, true],
    ['CLAUDE.md', 'external link', true, true],
    ['AGENTS.md', 'directory', true, false],
    ['AGENTS.md', 'external link', true, false],
  ] as const)(
    'keeps unsupported %s %s non-blocking (repair=%s, tracked=%s)',
    async (name, layout, repair, tracked) => {
      const sourceRepoPath = path.join(tempDir, 'source');
      const childRepoPath = path.join(tempDir, 'child');
      initRepo(sourceRepoPath);
      initRepo(childRepoPath);
      fs.writeFileSync(
        path.join(sourceRepoPath, 'canopy.json'),
        JSON.stringify({
          version: 1,
          repos: [{ id: 'child', name: 'Child', url: childRepoPath }],
        }),
      );
      fs.writeFileSync(
        path.join(sourceRepoPath, '.gitignore'),
        repair ? 'node_modules/\n' : 'repos/\n',
      );
      const instructionPath = path.join(sourceRepoPath, name);
      const outside = path.join(tempDir, 'outside.md');
      fs.writeFileSync(outside, 'Do not change external guidance\n');
      if (layout === 'directory') {
        fs.mkdirSync(instructionPath);
        fs.writeFileSync(
          path.join(instructionPath, 'rules.md'),
          'Keep directory guidance\n',
        );
      } else {
        fs.mkdirSync(path.join(sourceRepoPath, 'docs'));
        fs.writeFileSync(
          path.join(sourceRepoPath, 'docs', 'rules.md'),
          'Keep nested guidance\n',
        );
        fs.symlinkSync(
          layout === 'nested link' ? 'docs/rules.md' : outside,
          instructionPath,
        );
      }
      runGit(sourceRepoPath, ['add', 'canopy.json', '.gitignore']);
      if (tracked)
        runGit(sourceRepoPath, [
          'add',
          name,
          ...(layout === 'directory' ? [] : ['docs']),
        ]);
      runGit(sourceRepoPath, [
        'commit',
        '-m',
        'unsupported instruction layout',
      ]);
      const dataDir = process.env.CANOPY_DATA_DIR ?? '';
      writeWorkspaceIndex(dataDir, [
        { id: 'multi', name: 'Multi', type: 'multi-repo' },
      ]);
      writeWorkspaceConfig(dataDir, 'multi', {
        type: 'multi-repo',
        sourceRepoPath,
        repos: [{ id: 'child', name: 'Child', repoPath: childRepoPath }],
      });
      const created = await createMultiRepoWorktree({
        workspaceId: 'multi',
        branchName: 'feature',
        repairWorkspaceRoot: repair,
        restoreClaudeMd: true,
      });
      const root = path.join(
        dataDir,
        'workspaces',
        'multi',
        'worktrees',
        created.id,
      );
      expect(fs.existsSync(path.join(root, '.git'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'repos', 'child', '.git'))).toBe(
        true,
      );
      expect(readWorktrees(dataDir, 'multi')).toMatchObject({
        worktrees: [{ id: created.id }],
      });
      if (tracked) {
        if (layout === 'directory')
          expect(
            fs.readFileSync(path.join(root, name, 'rules.md'), 'utf8'),
          ).toBe('Keep directory guidance\n');
        else
          expect(fs.readlinkSync(path.join(root, name))).toBe(
            layout === 'nested link' ? 'docs/rules.md' : outside,
          );
      } else {
        expect(fs.existsSync(path.join(root, name))).toBe(false);
      }
      expect(fs.readFileSync(outside, 'utf8')).toBe(
        'Do not change external guidance\n',
      );
      if (repair)
        expect(
          fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
        ).toContain('repos/');
    },
  );

  it('rejects source-backed root worktrees with invalid canopy manifests', async () => {
    const sourceRepoPath = path.join(tempDir, 'invalid-source');
    initRepo(sourceRepoPath);
    fs.writeFileSync(
      path.join(sourceRepoPath, 'canopy.json'),
      JSON.stringify({ repos: [] }, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(sourceRepoPath, '.gitignore'), 'repos/\n');
    runGit(sourceRepoPath, ['add', 'canopy.json', '.gitignore']);
    runGit(sourceRepoPath, ['commit', '-m', 'invalid project metadata']);

    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'invalid-multi', name: 'Invalid Multi', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'invalid-multi', {
      type: 'multi-repo',
      sourceRepoPath,
      repos: [],
    });

    await expect(
      createMultiRepoWorktree({
        workspaceId: 'invalid-multi',
        branchName: 'feature',
        repairWorkspaceRoot: true,
      }),
    ).rejects.toThrow('canopy.json version must be 1');
    expect(readWorktrees(dataDir, 'invalid-multi')).toEqual({
      version: 1,
      worktrees: [],
    });
  });

  it('applies strict canopy manifest validation to source-root repair', async () => {
    const sourceRepoPath = path.join(tempDir, 'strict-source');
    initRepo(sourceRepoPath);
    fs.writeFileSync(
      path.join(sourceRepoPath, 'canopy.json'),
      JSON.stringify(
        {
          version: 1,
          repos: [
            { id: 'child', name: 'Child', url: 'https://example.com/a.git' },
            {
              id: 'child',
              name: 'Duplicate',
              url: 'https://example.com/b.git',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(path.join(sourceRepoPath, '.gitignore'), 'repos/\n');
    runGit(sourceRepoPath, ['add', 'canopy.json', '.gitignore']);
    runGit(sourceRepoPath, ['commit', '-m', 'duplicate project metadata']);

    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'strict-multi', name: 'Strict Multi', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'strict-multi', {
      type: 'multi-repo',
      sourceRepoPath,
      repos: [],
    });

    await expect(
      createMultiRepoWorktree({
        workspaceId: 'strict-multi',
        branchName: 'feature',
        repairWorkspaceRoot: true,
      }),
    ).rejects.toThrow('duplicate repo id "child"');
    expect(readWorktrees(dataDir, 'strict-multi')).toEqual({
      version: 1,
      worktrees: [],
    });
  });

  it('persists tracked base branches for CLI multi-repo worktrees', async () => {
    const sourceRepoPath = path.join(tempDir, 'tracked-source');
    const childRepoPath = path.join(tempDir, 'tracked-child');
    initRepo(sourceRepoPath);
    initRepo(childRepoPath);
    fs.writeFileSync(
      path.join(sourceRepoPath, 'canopy.json'),
      JSON.stringify(
        {
          version: 1,
          repos: [{ id: 'child', name: 'Child', url: childRepoPath }],
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(path.join(sourceRepoPath, '.gitignore'), 'repos/\n');
    runGit(sourceRepoPath, ['add', 'canopy.json', '.gitignore']);
    runGit(sourceRepoPath, ['commit', '-m', 'project metadata']);
    const baseBranch = currentBranch(sourceRepoPath);

    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'tracked-multi', name: 'Tracked Multi', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'tracked-multi', {
      type: 'multi-repo',
      sourceRepoPath,
      repos: [{ id: 'child', name: 'Child', repoPath: childRepoPath }],
    });
    fs.writeFileSync(
      path.join(dataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: { workspaceDefaultLayoutMode: 'unsupported' },
      }),
      'utf8',
    );

    fs.mkdirSync(path.join(dataDir, 'workspaces', 'tracked-multi'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dataDir, 'workspaces', 'tracked-multi', 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'existing',
            branchName: 'existing',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );

    const created = await createMultiRepoWorktree({
      workspaceId: 'tracked-multi',
      branchName: 'feature',
      baseBranch,
    });

    expect(created.trackedRepoBaseBranches).toEqual({
      [WORKSPACE_ROOT_REPO_ID]: baseBranch,
      child: baseBranch,
    });
    // New worktrees lead the manual order, matching the desktop app.
    expect(readWorktrees(dataDir, 'tracked-multi')).toMatchObject({
      worktrees: [
        {
          id: created.id,
          trackedRepoBaseBranches: {
            [WORKSPACE_ROOT_REPO_ID]: baseBranch,
            child: baseBranch,
          },
        },
        { id: 'existing' },
      ],
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            dataDir,
            'workspaces',
            'tracked-multi',
            'worktree-data',
            created.id,
            'panel-layout-mode.json',
          ),
          'utf8',
        ),
      ),
    ).toEqual({ version: 1, mode: 'advanced' });
  });

  it('preserves metadata on existing worktree rows when writing updates', async () => {
    const repoPath = path.join(tempDir, 'metadata-repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'metadata', name: 'Metadata', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'metadata', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    fs.writeFileSync(
      path.join(dataDir, 'workspaces', 'metadata', 'worktrees.json'),
      JSON.stringify(
        {
          version: 1,
          worktrees: [
            {
              id: 'existing',
              branchName: 'existing',
              createdAt: '2026-01-01T00:00:00.000Z',
              pinned: true,
              lastTouchedAt: '2026-09-15T12:00:00.000Z',
              branchPromptSent: true,
              branchGroupingOverride: 'ungroup',
              branchGroupingParentWorktreeId: 'merged-parent',
              trackedRepoBaseBranches: { repo: 'main' },
              seenPipelineExecutionIds: ['exec-1'],
              discovery: {
                slashCommands: [{ name: 'review', description: 'Review' }],
                mcpServers: [{ name: 'canopy', status: 'connected' }],
                discoveredAt: '2026-01-01T00:00:00.000Z',
                providerType: 'claude',
              },
              lastKnownPrStatus: {
                repos: [
                  {
                    repoId: 'repo',
                    repoName: 'Repo',
                    status: null,
                  },
                ],
                lastCheckedAt: '2026-01-01T00:00:00.000Z',
              },
              pausedHookKeys: ['hook-1'],
              healthIssue: {
                status: 'broken',
                code: 'git-error',
                message: 'Git failed',
                checkedAt: '2026-01-01T00:00:00.000Z',
                worktreePath: repoPath,
              },
              hidden: true,
              setupPhase: 'git-ready',
              includedRepoIds: [],
              splitRecoveryRequired: true,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    await createSingleRepoWorktree({
      workspaceId: 'metadata',
      branchName: 'new-worktree',
    });

    expect(readWorktrees(dataDir, 'metadata')).toMatchObject({
      worktrees: [
        { id: 'new-worktree' },
        {
          id: 'existing',
          pinned: true,
          lastTouchedAt: '2026-09-15T12:00:00.000Z',
          branchPromptSent: true,
          branchGroupingOverride: 'ungroup',
          branchGroupingParentWorktreeId: 'merged-parent',
          trackedRepoBaseBranches: { repo: 'main' },
          seenPipelineExecutionIds: ['exec-1'],
          discovery: {
            slashCommands: [{ name: 'review', description: 'Review' }],
            mcpServers: [{ name: 'canopy', status: 'connected' }],
            discoveredAt: '2026-01-01T00:00:00.000Z',
            providerType: 'claude',
          },
          lastKnownPrStatus: {
            repos: [{ repoId: 'repo', repoName: 'Repo', status: null }],
            lastCheckedAt: '2026-01-01T00:00:00.000Z',
          },
          pausedHookKeys: ['hook-1'],
          healthIssue: {
            status: 'broken',
            code: 'git-error',
            message: 'Git failed',
            checkedAt: '2026-01-01T00:00:00.000Z',
            worktreePath: repoPath,
          },
          hidden: true,
          setupPhase: 'git-ready',
          includedRepoIds: [],
          splitRecoveryRequired: true,
        },
      ],
    });
  });

  it('listWorktreeCliRepoEntries returns no entries for a single-repo project', async () => {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'single', name: 'Single', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'single', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });

    await expect(
      listWorktreeCliRepoEntries('single', 'any-worktree'),
    ).resolves.toEqual([]);
  });

  it('listWorktreeCliRepoEntries enumerates a source-backed multi-repo project with the workspace-root entry first', async () => {
    const sourceRepoPath = path.join(tempDir, 'entries-source');
    const childRepoPath = path.join(tempDir, 'entries-child');
    initRepo(sourceRepoPath);
    initRepo(childRepoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'multi-entries', name: 'Multi Entries', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'multi-entries', {
      type: 'multi-repo',
      sourceRepoPath,
      repos: [{ id: 'child', name: 'Child', repoPath: childRepoPath }],
    });
    const childWorktreePath = path.join(
      dataDir,
      'workspaces',
      'multi-entries',
      'worktrees',
      'wt-entries',
      'repos',
      'child',
    );
    fs.mkdirSync(childWorktreePath, { recursive: true });

    const entries = await listWorktreeCliRepoEntries(
      'multi-entries',
      'wt-entries',
    );

    expect(entries).toEqual([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: 'Project root',
        repoPath: path.join(
          dataDir,
          'workspaces',
          'multi-entries',
          'worktrees',
          'wt-entries',
        ),
      },
      {
        repoId: 'child',
        repoName: 'Child',
        repoPath: childWorktreePath,
      },
    ]);
  });

  it('listWorktreeCliRepoEntries omits the workspace-root entry when a non-source-backed worktree root is not a git repo', async () => {
    const childRepoPath = path.join(tempDir, 'no-source-child');
    initRepo(childRepoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'multi-no-source', name: 'Multi No Source', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'multi-no-source', {
      type: 'multi-repo',
      repos: [{ id: 'child', name: 'Child', repoPath: childRepoPath }],
    });
    const childWorktreePath = path.join(
      dataDir,
      'workspaces',
      'multi-no-source',
      'worktrees',
      'wt-no-source',
      'repos',
      'child',
    );
    fs.mkdirSync(childWorktreePath, { recursive: true });

    const entries = await listWorktreeCliRepoEntries(
      'multi-no-source',
      'wt-no-source',
    );

    expect(entries).toEqual([
      {
        repoId: 'child',
        repoName: 'Child',
        repoPath: childWorktreePath,
      },
    ]);
  });

  it('listWorktreeCliRepoEntries includes the workspace-root entry when a non-source-backed worktree root is itself a git repo', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'multi-git-root', name: 'Multi Git Root', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'multi-git-root', {
      type: 'multi-repo',
      repos: [],
    });
    const worktreeRootPath = path.join(
      dataDir,
      'workspaces',
      'multi-git-root',
      'worktrees',
      'wt-git-root',
    );
    initRepo(worktreeRootPath);

    const entries = await listWorktreeCliRepoEntries(
      'multi-git-root',
      'wt-git-root',
    );

    expect(entries).toEqual([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: 'Project root',
        repoPath: worktreeRootPath,
      },
    ]);
  });

  it('listWorktreeCliRepoEntries skips config repos whose worktree checkout is missing on disk', async () => {
    const sourceRepoPath = path.join(tempDir, 'skip-source');
    const presentRepoPath = path.join(tempDir, 'skip-present');
    const missingRepoPath = path.join(tempDir, 'skip-missing');
    initRepo(sourceRepoPath);
    initRepo(presentRepoPath);
    initRepo(missingRepoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'multi-skip', name: 'Multi Skip', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'multi-skip', {
      type: 'multi-repo',
      sourceRepoPath,
      repos: [
        { id: 'present', name: 'Present', repoPath: presentRepoPath },
        { id: 'missing', name: 'Missing', repoPath: missingRepoPath },
      ],
    });
    const presentWorktreePath = path.join(
      dataDir,
      'workspaces',
      'multi-skip',
      'worktrees',
      'wt-skip',
      'repos',
      'present',
    );
    fs.mkdirSync(presentWorktreePath, { recursive: true });
    // Deliberately no on-disk dir for the "missing" repo's checkout.

    const entries = await listWorktreeCliRepoEntries('multi-skip', 'wt-skip');

    expect(entries).toEqual([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: 'Project root',
        repoPath: path.join(
          dataDir,
          'workspaces',
          'multi-skip',
          'worktrees',
          'wt-skip',
        ),
      },
      {
        repoId: 'present',
        repoName: 'Present',
        repoPath: presentWorktreePath,
      },
    ]);
  });

  it('lists only executions for the requested worktree before pagination', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const executionsDir = path.join(dataDir, 'pipeline-executions');
    const runtime = {
      executionsDir,
      tempRootDir: path.join(tempDir, 'tmp'),
      bundledActionsDir: path.join(tempDir, 'actions'),
      getProjectActionsDir: (repoPath: string): string => repoPath,
      getProjectPipelinesDir: (repoPath: string): string => repoPath,
      // Pipeline fixtures do not enforce an org model policy.
      isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
      isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    };
    const normalized = normalizePipeline({
      name: 'Scoped',
      on: 'dispatch',
      jobs: { build: { steps: [{ id: 'ok', run: 'echo ok' }] } },
    });
    const matching = createInitialState(
      normalized,
      { cwd: tempDir, pipelineId: 'scoped', runtime },
      'matching',
    );
    matching.project_id = 'workspace-a';
    matching.worktree_id = 'worktree-a';
    matching.status = 'success';
    const other = createInitialState(
      normalized,
      { cwd: tempDir, pipelineId: 'scoped', runtime },
      'other',
    );
    other.project_id = 'workspace-b';
    other.worktree_id = 'worktree-b';
    other.status = 'success';
    await saveExecutionState(other, executionsDir);
    await saveExecutionState(matching, executionsDir);

    await expect(
      listWorktreePipelineExecutions({
        workspaceId: 'workspace-a',
        worktreeId: 'worktree-a',
        limit: 1,
      }),
    ).resolves.toEqual([
      { id: 'matching', pipelineName: 'Scoped', status: 'success' },
    ]);
  });

  it('records durable recovery before returning its primary failure without removing owned effects', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const repos = ['repo-a', 'repo-b'].map((id) => {
      const repoPath = path.join(tempDir, id);
      initRepo(repoPath);
      return { id, name: id, repoPath };
    });
    writeWorkspaceIndex(dataDir, [
      { id: 'ws', name: 'WS', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'ws', { type: 'multi-repo', repos });
    const worktreeDir = path.join(dataDir, 'workspaces/ws/worktrees/wt');
    const primary = new Error('repo-a Git failed after checkout creation');
    const fsPromises =
      jest.requireActual<typeof FsPromises>('node:fs/promises');
    const rm = jest.spyOn(fsPromises, 'rm');
    const git = cliReads.runGit;
    let failed = false;
    const afterFailure: string[][] = [];
    jest.spyOn(cliReads, 'runGit').mockImplementation(async (args, cwd) => {
      if (failed) afterFailure.push(args);
      const output = await git(args, cwd);
      if (args[0] === 'worktree' && args[1] === 'add') {
        failed = true;
        throw primary;
      }
      return output;
    });
    const durable = observeDurableRecovery();
    await expect(
      createMultiRepoWorktree({
        workspaceId: 'ws',
        branchName: 'wt',
        seedPanelLayoutMode: false,
      }),
    ).rejects.toBe(primary);
    const state = durable();
    expect(fs.existsSync(worktreeDir)).toBe(true);
    expect(
      fs.readFileSync(path.join(worktreeDir, 'repos/repo-a/README.md'), 'utf8'),
    ).toBe('hello\n');
    expect(pendingOwner(dataDir, 'ws', 'wt')).toBe(
      state.reservations[0]?.reservationId,
    );
    expect(state.reservations[0]).toMatchObject({
      operation: 'core.worktree.create',
      diagnostics: {
        workspaceId: 'ws',
        ownedPaths: including([
          path.join(worktreeDir, 'repos/repo-a'),
          path.join(worktreeDir, 'repos/repo-b'),
        ]),
      },
    });
    expect(rm).not.toHaveBeenCalled();
    expect(afterFailure).toEqual([]);
    expect(readWorktrees(dataDir, 'ws')).toMatchObject({
      worktrees: [
        {
          id: 'wt',
          creation: { operationId: state.reservations[0]?.reservationId },
        },
      ],
    });
  });

  it('refuses unowned checkout adoption without removing its files', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    writeWorkspaceIndex(dataDir, [
      { id: 'ws', name: 'WS', type: 'single-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'ws', {
      type: 'single-repo',
      repoPath,
      repos: [],
    });
    const worktreeDir = path.join(dataDir, 'workspaces/ws/worktrees/wt');
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, 'winner.txt'), 'winner');
    const fsPromises =
      jest.requireActual<typeof FsPromises>('node:fs/promises');
    const remove = jest.spyOn(fsPromises, 'rm');
    const durable = observeDurableRecovery();
    await expect(
      createSingleRepoWorktree({
        workspaceId: 'ws',
        branchName: 'wt',
        seedPanelLayoutMode: false,
      }),
    ).rejects.toThrow();
    expect(fs.readFileSync(path.join(worktreeDir, 'winner.txt'), 'utf8')).toBe(
      'winner',
    );
    expect(remove).not.toHaveBeenCalled();
    const state = durable();
    expect(pendingOwner(dataDir, 'ws', 'wt')).toBe(
      state.reservations[0]?.reservationId,
    );
  });

  it('preserves uncertain multi-repo effects and the primary Git error', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    writeWorkspaceIndex(dataDir, [
      { id: 'ws', name: 'WS', type: 'multi-repo' },
    ]);
    writeWorkspaceConfig(dataDir, 'ws', {
      type: 'multi-repo',
      repos: [
        {
          id: 'missing',
          name: 'Missing',
          repoPath: path.join(tempDir, 'missing-repo'),
        },
      ],
    });
    const worktreeDir = path.join(dataDir, 'workspaces/ws/worktrees/feature');
    const actualGit = cliReads.runGit;
    let primary: unknown;
    jest.spyOn(cliReads, 'runGit').mockImplementation(async (...args) => {
      try {
        return await actualGit(...args);
      } catch (error) {
        primary = error;
        throw error;
      }
    });
    const durable = observeDurableRecovery();
    const error: unknown = await createMultiRepoWorktree({
      workspaceId: 'ws',
      branchName: 'feature',
    }).catch((failure: unknown) => failure);
    expect(primary).toBeDefined();
    expect(error).toBe(primary);
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect(durable().reservations[0]).toMatchObject({
      operation: 'core.worktree.create',
      diagnostics: { ownedPaths: [path.join(worktreeDir, 'repos/missing')] },
    });
    expect(fs.existsSync(worktreeDir)).toBe(true);
  });
});
