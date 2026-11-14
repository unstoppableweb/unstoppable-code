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
import { startW5ServiceAdapter } from '../../w5-routed-writes/__tests__/fixtures/w5-service-adapter';
let routed: Awaited<ReturnType<typeof startW5ServiceAdapter>>;
async function createAndPersistNewMultiRepoWorkspace(
  name: string,
): Promise<MultiRepoSidebarItem> {
  const item = await routed.createWorkspace({ kind: 'multi', name });
  if (item.type !== 'multi-repo')
    throw new Error('Expected multi-repo workspace');
  return item;
}
const createNewSingleRepoWorkspace = (name: string): Promise<SidebarItem> =>
  routed.createWorkspace({ kind: 'single', name });
const importWorkspaceFromRepoPath = (repoPath: string): Promise<SidebarItem> =>
  routed.createWorkspace({ kind: 'import', repoPath });
import type * as FsPromises from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { leaveW5RootPresenceSync } from '../../w5-root-presence';
import { getWorkspaceItem, toWorkspaceCliRecord } from '../workspace-service';
import type {
  CoworkSidebarItem,
  MultiRepoSidebarItem,
  SidebarItem,
} from '../../../types';

function runGit(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
}

function createCommittedRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.name', 'Canopy Test']);
  runGit(repoPath, ['config', 'user.email', 'canopy-test@example.invalid']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test\n', 'utf8');
  runGit(repoPath, ['add', 'README.md']);
  runGit(repoPath, ['commit', '-m', 'Initial commit']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('desktop-shared node project service', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-ws-'));
    process.env.CANOPY_DATA_DIR = path.join(tempDir, 'data');
    routed = await startW5ServiceAdapter(process.env.CANOPY_DATA_DIR ?? '');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await routed.close();
    leaveW5RootPresenceSync();
    await Promise.resolve();
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['tree/linked/pstack', 'blob/linked/pstack/README.md'])(
    'clones the default branch and preserves the explicit destination for %s',
    async (suffix) => {
      const source = path.join(tempDir, 'source');
      createCommittedRepo(source);
      runGit(source, ['branch', '-M', 'default-main']);
      fs.mkdirSync(path.join(source, 'pstack'));
      fs.writeFileSync(
        path.join(source, 'pstack', 'README.md'),
        'default branch',
      );
      runGit(source, ['add', '.']);
      runGit(source, ['commit', '-m', 'Default contents']);
      runGit(source, ['checkout', '-b', 'linked']);
      fs.writeFileSync(path.join(source, 'README.md'), 'linked ref');
      runGit(source, ['commit', '-am', 'Different linked ref']);
      runGit(source, ['checkout', 'default-main']);
      const config = path.join(tempDir, 'gitconfig');
      const trace = path.join(tempDir, 'git-trace');
      execFileSync('git', [
        'config',
        '--file',
        config,
        `url.${source}.insteadOf`,
        'https://github.com/cursor/plugins',
      ]);
      const destination = path.join(tempDir, 'custom explicit destination');
      // A real child receives an isolated Git environment; Jest virtualizes process.env.
      const endpoint = path.join(tempDir, 's');
      await routed.harness.listen(endpoint);
      const { stdout: output } = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          path.resolve(
            __dirname,
            '../../w5-routed-writes/__tests__/fixtures/w5-workspace-remote-client.ts',
          ),
          endpoint,
          `https://github.com/cursor/plugins/${suffix}`,
          destination,
          process.env.CANOPY_DATA_DIR ?? '',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: config,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_COUNT: '0',
            GIT_TRACE: trace,
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      );
      const workspace: unknown = JSON.parse(output);
      expect(workspace).toMatchObject({
        name: 'custom explicit destination',
        repoPath: destination,
      });
      expect(fs.readFileSync(path.join(destination, 'README.md'), 'utf8')).toBe(
        '# Test\n',
      );
      expect(
        fs.readFileSync(path.join(destination, 'pstack', 'README.md'), 'utf8'),
      ).toBe('default branch');
      expect(
        execFileSync('git', ['branch', '--show-current'], {
          cwd: destination,
          encoding: 'utf8',
        }).trim(),
      ).toBe('default-main');
      const commands = fs.readFileSync(trace, 'utf8');
      expect(commands).toContain('clone -- https://github.com/cursor/plugins ');
      expect(commands).not.toContain(
        `https://github.com/cursor/plugins/${suffix}`,
      );
    },
  );

  it('preserves existing activity section order when persisting a new project', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const workspacesDir = path.join(dataDir, 'workspaces');
    fs.mkdirSync(path.join(workspacesDir, 'existing'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacesDir, 'index.json'),
      JSON.stringify(
        {
          version: 1,
          workspaces: [
            {
              id: 'existing',
              name: 'Existing',
              type: 'multi-repo',
              color: '#0284c7',
              collapsed: false,
              order: 0,
              activitySectionOrder: [
                'todo',
                'memory',
                'cost',
                'summary',
                'pipeline-runs',
              ],
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspacesDir, 'existing', 'workspace.json'),
      JSON.stringify({ version: 1, type: 'multi-repo', repos: [] }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspacesDir, 'existing', 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: [] }, null, 2),
      'utf8',
    );

    await createAndPersistNewMultiRepoWorkspace('New Workspace');

    const persisted: unknown = JSON.parse(
      fs.readFileSync(path.join(workspacesDir, 'index.json'), 'utf8'),
    );
    expect(persisted).toMatchObject({
      workspaces: [
        {
          id: 'existing',
          activitySectionOrder: [
            'todo',
            'memory',
            'cost',
            'summary',
            'pipeline-runs',
          ],
        },
        {
          id: 'new-workspace',
        },
      ],
    });
  });

  it('keeps index entries whose config fails to load when persisting a new project (CAN-3329)', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const workspacesDir = path.join(dataDir, 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspacesDir, 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'unloadable',
            name: 'Unloadable',
            type: 'single-repo',
            color: '#0284c7',
            collapsed: false,
            order: 0,
          },
        ],
      }),
      'utf8',
    );

    await createAndPersistNewMultiRepoWorkspace('New Workspace');

    const persisted: unknown = JSON.parse(
      fs.readFileSync(path.join(workspacesDir, 'index.json'), 'utf8'),
    );
    expect(persisted).toMatchObject({
      workspaces: [{ id: 'unloadable' }, { id: 'new-workspace' }],
    });
  });

  it('backs up the previous index before a CLI create rewrites it (CAN-3329)', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const indexPath = path.join(dataDir, 'workspaces', 'index.json');
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const previous = JSON.stringify({
      version: 1,
      workspaces: [
        {
          id: 'existing',
          name: 'Existing',
          type: 'multi-repo',
          color: '#0284c7',
          collapsed: false,
          order: 0,
        },
      ],
    });
    fs.writeFileSync(indexPath, previous, 'utf8');

    await createAndPersistNewMultiRepoWorkspace('New Workspace');

    expect(fs.readFileSync(`${indexPath}.bak`, 'utf8')).toBe(previous);
  });

  it('never reuses the id of an index entry whose config fails to load (CAN-3329)', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const workspacesDir = path.join(dataDir, 'workspaces');
    fs.mkdirSync(workspacesDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspacesDir, 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'new-workspace',
            name: 'Unloadable',
            type: 'single-repo',
            color: '#0284c7',
            collapsed: false,
            order: 0,
          },
        ],
      }),
      'utf8',
    );

    const created =
      await createAndPersistNewMultiRepoWorkspace('New Workspace');

    expect(created.id).toBe('new-workspace-2');
    const persisted: unknown = JSON.parse(
      fs.readFileSync(path.join(workspacesDir, 'index.json'), 'utf8'),
    );
    expect(persisted).toMatchObject({
      workspaces: [{ id: 'new-workspace' }, { id: 'new-workspace-2' }],
    });
  });

  it('refuses to persist a new project over an unreadable index (CAN-3329)', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const indexPath = path.join(dataDir, 'workspaces', 'index.json');
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, '{"version": 1, "work', 'utf8');

    await expect(
      createAndPersistNewMultiRepoWorkspace('New Workspace'),
    ).rejects.toThrow(/project list could not be read/i);
    expect(fs.readFileSync(indexPath, 'utf8')).toBe('{"version": 1, "work');
    expect(fs.existsSync(path.join(dataDir, 'repos', 'new-workspace'))).toBe(
      false,
    );
  });

  it.each([true, false])(
    'refuses to persist a new project over a partially parsed index with valid entries: %s (CAN-3329)',
    async (hasValidEntry) => {
      const dataDir = process.env.CANOPY_DATA_DIR ?? '';
      const indexPath = path.join(dataDir, 'workspaces', 'index.json');
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      const previous = JSON.stringify({
        version: 1,
        workspaces: [
          ...(hasValidEntry
            ? [
                {
                  id: 'existing',
                  name: 'Existing',
                  type: 'multi-repo',
                  color: '#0284c7',
                  order: 0,
                },
              ]
            : []),
          { id: 'invalid', name: 'Invalid' },
        ],
      });
      fs.writeFileSync(indexPath, previous, 'utf8');

      await expect(
        createAndPersistNewMultiRepoWorkspace('New Workspace'),
      ).rejects.toThrow(/project list could not be read completely/i);
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(previous);
      expect(
        fs.existsSync(path.join(dataDir, 'workspaces', 'new-workspace')),
      ).toBe(false);
      expect(fs.existsSync(path.join(dataDir, 'repos', 'new-workspace'))).toBe(
        false,
      );
    },
  );

  (process.platform === 'win32' ? it.skip : it)(
    'retains the source repo and durable recovery evidence when publication fails (CAN-3799)',
    async () => {
      const dataDir = process.env.CANOPY_DATA_DIR ?? '';
      const workspacesDir = path.join(dataDir, 'workspaces');
      fs.mkdirSync(workspacesDir, { recursive: true });
      const indexPath = path.join(workspacesDir, 'index.json');
      const previous = JSON.stringify({ version: 1, workspaces: [] });
      fs.writeFileSync(indexPath, previous, 'utf8');
      const sourceRepoPath = path.join(dataDir, 'repos', 'new-workspace');
      const fsPromises =
        jest.requireActual<typeof FsPromises>('node:fs/promises');
      const actualMkdir = fsPromises.mkdir;
      let primary: unknown;
      const afterFailure: string[] = [];
      const mkdir = jest
        .spyOn(fsPromises, 'mkdir')
        .mockImplementation(async (target, options) => {
          if (
            primary !== undefined &&
            String(target).startsWith(sourceRepoPath)
          )
            afterFailure.push(`mkdir:${String(target)}`);
          try {
            return await actualMkdir(target, options);
          } catch (error) {
            primary = error;
            throw error;
          }
        });
      const actualRm = fsPromises.rm;
      const remove = jest
        .spyOn(fsPromises, 'rm')
        .mockImplementation(async (target, options) => {
          if (
            primary !== undefined &&
            String(target).startsWith(sourceRepoPath)
          )
            afterFailure.push(`rm:${String(target)}`);
          await actualRm(target, options);
        });
      fs.chmodSync(workspacesDir, 0o500);
      try {
        let recordedBeforeRejection = false;
        const mark = routed.transport.markReservationRecoveryRequired.bind(
          routed.transport,
        );
        jest
          .spyOn(routed.transport, 'markReservationRecoveryRequired')
          .mockImplementation(async (input) => {
            await mark(input);
            const containingSource: unknown = expect.arrayContaining([
              sourceRepoPath,
            ]);
            const repository: unknown = expect.objectContaining({
              role: 'source',
              path: sourceRepoPath,
              owned: true,
              status: 'completed',
            });
            const containingRepository: unknown = expect.arrayContaining([
              repository,
            ]);
            expect((await routed.durableState()).reservations).toMatchObject([
              {
                operation: 'core.workspace.create',
                state: 'recovery-required',
                diagnostics: {
                  workspaceId: 'new-workspace',
                  ownedPaths: containingSource,
                  repositories: containingRepository,
                },
              },
            ]);
            recordedBeforeRejection = true;
          });
        const error: unknown = await createAndPersistNewMultiRepoWorkspace(
          'New Workspace',
        ).catch((failure: unknown) => failure);
        expect(recordedBeforeRejection).toBe(true);
        expect(primary).toBeDefined();
        expect(error).toBe(primary);
        expect(error).toMatchObject({ code: 'EACCES' });
        expect(fs.existsSync(path.join(sourceRepoPath, '.git'))).toBe(true);
        expect(fs.readFileSync(indexPath, 'utf8')).toBe(previous);
        expect(
          fs.existsSync(
            path.join(workspacesDir, 'new-workspace', 'workspace.json'),
          ),
        ).toBe(false);
        expect(
          fs.existsSync(
            path.join(workspacesDir, 'new-workspace', 'worktrees.json'),
          ),
        ).toBe(false);
        await routed.host.shutdown();
        expect(afterFailure).toEqual([]);
        expect(fs.existsSync(path.join(sourceRepoPath, '.git'))).toBe(true);
      } finally {
        fs.chmodSync(workspacesDir, 0o700);
        mkdir.mockRestore();
        remove.mockRestore();
      }
    },
  );

  it('allocates around occupied metadata without partial or orphaned state (CAN-3799)', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const occupied = path.join(
      dataDir,
      'workspaces',
      'new-workspace',
      'worktrees.json',
    );
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, 'evidence'), 'keep');
    const created =
      await createAndPersistNewMultiRepoWorkspace('New Workspace');
    expect(created.id).toBe('new-workspace-2');
    expect(fs.readFileSync(path.join(occupied, 'evidence'), 'utf8')).toBe(
      'keep',
    );
    expect(fs.readdirSync(path.dirname(occupied))).toEqual(['worktrees.json']);
    const sourceRepoPath = path.join(dataDir, 'repos', 'new-workspace');
    expect(fs.existsSync(path.join(sourceRepoPath, '.git'))).toBe(true);
    const config: unknown = JSON.parse(
      fs.readFileSync(
        path.join(dataDir, 'workspaces', created.id, 'workspace.json'),
        'utf8',
      ),
    );
    expect(config).toMatchObject({ sourceRepoPath });
    const index: unknown = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'workspaces/index.json'), 'utf8'),
    );
    expect(index).toMatchObject({
      workspaces: [{ id: created.id, type: 'multi-repo' }],
    });
    if (!isRecord(index) || !Array.isArray(index.workspaces))
      throw new Error('Invalid index');
    expect(index.workspaces).toHaveLength(1);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(dataDir, 'workspaces', created.id, 'worktrees.json'),
          'utf8',
        ),
      ),
    ).toEqual({ version: 1, worktrees: [] });
    expect((await routed.durableState()).reservations).toEqual([]);
  });

  (process.platform === 'win32' ? it.skip : it)(
    'reserves the next source repo path when the preferred one is a dangling symlink (CAN-3799)',
    async () => {
      const dataDir = process.env.CANOPY_DATA_DIR ?? '';
      const reposDir = path.join(dataDir, 'repos');
      fs.mkdirSync(reposDir, { recursive: true });
      fs.symlinkSync(
        path.join(tempDir, 'gone'),
        path.join(reposDir, 'new-workspace'),
      );

      const created =
        await createAndPersistNewMultiRepoWorkspace('New Workspace');

      expect(created.sourceRepoPath).toBe(
        path.join(reposDir, 'new-workspace-2'),
      );
      expect(
        fs.lstatSync(path.join(reposDir, 'new-workspace')).isSymbolicLink(),
      ).toBe(true);
    },
    15_000,
  );

  it('preserves existing sidebar pins when persisting a new project', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const workspacesDir = path.join(dataDir, 'workspaces');
    fs.mkdirSync(path.join(workspacesDir, 'pinned-existing'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workspacesDir, 'index.json'),
      JSON.stringify(
        {
          version: 1,
          workspaces: [
            {
              id: 'pinned-existing',
              name: 'Pinned Existing',
              type: 'multi-repo',
              color: '#0284c7',
              collapsed: false,
              order: 0,
              pinned: true,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspacesDir, 'pinned-existing', 'workspace.json'),
      JSON.stringify({ version: 1, type: 'multi-repo', repos: [] }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspacesDir, 'pinned-existing', 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: [] }, null, 2),
      'utf8',
    );

    await createAndPersistNewMultiRepoWorkspace('New Workspace');

    const persisted: unknown = JSON.parse(
      fs.readFileSync(path.join(workspacesDir, 'index.json'), 'utf8'),
    );
    expect(persisted).toMatchObject({
      workspaces: [
        { id: 'pinned-existing', pinned: true },
        { id: 'new-workspace' },
      ],
    });
  });

  it('imports canopy.json repo manifests as source-backed multi-repo projects', async () => {
    const sourceRepoPath = path.join(tempDir, 'source');
    const childRepoPath = path.join(tempDir, 'child');
    createCommittedRepo(sourceRepoPath);
    createCommittedRepo(childRepoPath);
    fs.writeFileSync(
      path.join(sourceRepoPath, 'canopy.json'),
      JSON.stringify(
        {
          version: 1,
          repos: [
            {
              id: 'child',
              name: 'Child',
              url: childRepoPath,
              scripts: { setup: 'npm install' },
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    runGit(sourceRepoPath, ['add', 'canopy.json']);
    runGit(sourceRepoPath, ['commit', '-m', 'Add project manifest']);

    const imported = await importWorkspaceFromRepoPath(sourceRepoPath);

    expect(imported).toMatchObject({
      type: 'multi-repo',
      sourceRepoPath,
      repos: [
        {
          id: 'child',
          name: 'Child',
          source: 'manifest',
          manifestUrl: childRepoPath,
          scripts: { setup: 'npm install' },
        },
      ],
    });
    if (imported.type !== 'multi-repo') {
      throw new Error('Expected multi-repo import');
    }
    const childRepo = imported.repos.find((repo) => repo.id === 'child');
    if (!childRepo) {
      throw new Error('Expected imported child repo');
    }
    expect(fs.existsSync(path.join(childRepo.repoPath, '.git'))).toBe(true);
  });

  it('overlays source-backed projects with the current canopy.json manifest', async () => {
    const sourceRepoPath = path.join(tempDir, 'overlay-source');
    const repoAPath = path.join(tempDir, 'repo-a');
    const repoBPath = path.join(tempDir, 'repo-b');
    const localRepoPath = path.join(tempDir, 'local-repo');
    createCommittedRepo(sourceRepoPath);
    createCommittedRepo(repoAPath);
    createCommittedRepo(repoBPath);
    createCommittedRepo(localRepoPath);
    fs.writeFileSync(
      path.join(sourceRepoPath, 'canopy.json'),
      JSON.stringify(
        {
          version: 1,
          repos: [
            { id: 'repo-a', name: 'Repo A', url: repoAPath },
            { id: 'repo-b', name: 'Repo B', url: repoBPath },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    runGit(sourceRepoPath, ['add', 'canopy.json']);
    runGit(sourceRepoPath, ['commit', '-m', 'Add project manifest']);

    const imported = await importWorkspaceFromRepoPath(sourceRepoPath);
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const configPath = path.join(
      dataDir,
      'workspaces',
      imported.id,
      'workspace.json',
    );
    const rawConfig: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!isRecord(rawConfig)) {
      throw new Error('Expected project config object');
    }
    const repos = rawConfig.repos;
    if (!Array.isArray(repos)) {
      throw new Error('Expected project repos array');
    }
    repos.push({
      id: 'local',
      name: 'Local',
      repoPath: localRepoPath,
      source: 'local',
    });
    rawConfig.suppressedRepoIds = ['repo-b'];
    fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf8');

    await expect(getWorkspaceItem(imported.id)).resolves.toMatchObject({
      repos: [{ id: 'repo-a' }, { id: 'local' }],
    });

    rawConfig.suppressedRepoIds = [];
    fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(sourceRepoPath, 'canopy.json'),
      JSON.stringify(
        {
          version: 1,
          repos: [{ id: 'repo-b', name: 'Repo B', url: repoBPath }],
        },
        null,
        2,
      ),
      'utf8',
    );

    await expect(getWorkspaceItem(imported.id)).resolves.toMatchObject({
      repos: [{ id: 'repo-b' }, { id: 'local' }],
    });
  }, 120_000);

  it('preserves persisted worktree branch grouping overrides', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const workspacesDir = path.join(dataDir, 'workspaces');
    fs.mkdirSync(path.join(workspacesDir, 'workspace'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacesDir, 'index.json'),
      JSON.stringify(
        {
          version: 1,
          workspaces: [
            {
              id: 'workspace',
              name: 'Workspace',
              type: 'single-repo',
              color: '#0284c7',
              collapsed: false,
              order: 0,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspacesDir, 'workspace', 'workspace.json'),
      JSON.stringify(
        { version: 1, type: 'single-repo', repoPath: '/repo', repos: [] },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspacesDir, 'workspace', 'worktrees.json'),
      JSON.stringify(
        {
          version: 1,
          worktrees: [
            {
              id: 'child',
              branchName: 'feature',
              createdAt: '2026-01-01T00:00:00.000Z',
              label: 'Custom label',
              branchGroupingOverride: 'group',
              branchGroupingParentWorktreeId: 'merged-parent',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    await expect(getWorkspaceItem('workspace')).resolves.toMatchObject({
      worktrees: [
        {
          id: 'child',
          label: 'Custom label',
          branchGroupingOverride: 'group',
          branchGroupingParentWorktreeId: 'merged-parent',
        },
      ],
    });
  });

  it('imports a non-git folder as an external cowork project', async () => {
    const folderPath = path.join(tempDir, 'plain-folder');
    fs.mkdirSync(folderPath, { recursive: true });

    const imported = await importWorkspaceFromRepoPath(folderPath);

    expect(imported).toMatchObject({
      type: 'cowork',
      name: 'plain-folder',
      externalPath: fs.realpathSync(folderPath),
    });

    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const indexPath = path.join(dataDir, 'workspaces', 'index.json');
    const index: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!isRecord(index) || !Array.isArray(index.workspaces)) {
      throw new Error('Expected project index');
    }
    expect(index.workspaces).toMatchObject([
      { id: imported.id, type: 'cowork' },
    ]);

    const configPath = path.join(
      dataDir,
      'workspaces',
      imported.id,
      'workspace.json',
    );
    const config: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config).toMatchObject({
      type: 'cowork',
      externalPath: fs.realpathSync(folderPath),
    });
    expect(
      fs.existsSync(
        path.join(dataDir, 'workspaces', imported.id, 'worktrees.json'),
      ),
    ).toBe(false);

    await expect(getWorkspaceItem(imported.id)).resolves.toMatchObject({
      type: 'cowork',
      externalPath: fs.realpathSync(folderPath),
    });
  });

  it('serializes managed cowork project CLI rootPath as the working home directory', () => {
    const item: CoworkSidebarItem = {
      type: 'cowork',
      id: 'managed-cowork',
      name: 'Managed Cowork',
      color: '#0284c7',
      collapsed: false,
      order: 0,
    };

    expect(toWorkspaceCliRecord(item)).toMatchObject({
      id: 'managed-cowork',
      type: 'cowork',
      rootPath: path.join(
        process.env.CANOPY_DATA_DIR ?? '',
        'workspaces',
        'managed-cowork',
        'home',
      ),
      repoCount: 0,
      worktreeCount: 0,
      repos: [],
      worktrees: [],
    });
  });

  it('serializes external cowork project CLI rootPath as the attached folder', () => {
    const externalPath = path.join(tempDir, 'attached-folder');
    const item: CoworkSidebarItem = {
      type: 'cowork',
      id: 'external-cowork',
      name: 'External Cowork',
      color: '#0284c7',
      collapsed: false,
      order: 0,
      externalPath,
    };

    expect(toWorkspaceCliRecord(item)).toMatchObject({
      id: 'external-cowork',
      type: 'cowork',
      rootPath: externalPath,
      repoCount: 0,
      worktreeCount: 0,
      repos: [],
      worktrees: [],
    });
  });

  it('rejects importing a folder already tracked as a project', async () => {
    const folderPath = path.join(tempDir, 'duplicate-folder');
    fs.mkdirSync(folderPath, { recursive: true });

    await importWorkspaceFromRepoPath(folderPath);

    await expect(importWorkspaceFromRepoPath(folderPath)).rejects.toThrow(
      /already tracked as a project/,
    );
  });

  it.each([
    [
      'a folder that does not exist',
      (missingPath: string): string => missingPath,
    ],
    [
      'a symlink to a folder that does not exist',
      (missingPath: string): string => {
        const linkPath = path.join(tempDir, 'dangling-link');
        fs.symlinkSync(missingPath, linkPath);
        return linkPath;
      },
    ],
  ])(
    'rejects importing %s without registering or creating it (CAN-3799)',
    async (_label, toImportPath) => {
      const missingPath = path.join(tempDir, 'does-not-exist');
      const importPath = toImportPath(missingPath);

      await expect(importWorkspaceFromRepoPath(importPath)).rejects.toThrow(
        `Couldn't add the folder because it doesn't exist: ${importPath}. Choose an existing folder.`,
      );

      const dataDir = process.env.CANOPY_DATA_DIR ?? '';
      expect(fs.readdirSync(path.join(dataDir, 'workspaces'))).toEqual([]);
      expect(await routed.durableState()).toEqual({
        commitId: 0,
        reservations: [],
      });
      expect(fs.existsSync(missingPath)).toBe(false);
    },
  );

  it('rejects importing a regular file without registering it (CAN-3799)', async () => {
    const filePath = path.join(tempDir, 'notes.txt');
    fs.writeFileSync(filePath, 'notes\n', 'utf8');

    await expect(importWorkspaceFromRepoPath(filePath)).rejects.toThrow(
      `Couldn't add the folder because it isn't a folder: ${filePath}. Choose a folder.`,
    );

    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    expect(fs.readdirSync(path.join(dataDir, 'workspaces'))).toEqual([]);
    expect(await routed.durableState()).toEqual({
      commitId: 0,
      reservations: [],
    });
  });

  it('rejects importing a folder nested inside the app data directory', async () => {
    const dataDir = process.env.CANOPY_DATA_DIR ?? '';
    const nestedFolder = path.join(dataDir, 'nested-folder');
    fs.mkdirSync(nestedFolder, { recursive: true });

    await expect(importWorkspaceFromRepoPath(nestedFolder)).rejects.toThrow(
      /inside the app data directory/,
    );
  });

  it('rejects importing a folder that contains an existing project root', async () => {
    const repoPath = path.join(tempDir, 'parent', 'child-repo');
    createCommittedRepo(repoPath);
    await importWorkspaceFromRepoPath(repoPath);

    const parentFolder = path.join(tempDir, 'parent');
    await expect(importWorkspaceFromRepoPath(parentFolder)).rejects.toThrow(
      /contains an existing project/,
    );
  });

  it('bootstraps new single-repo projects with an initial canopy.json commit', async () => {
    const workspace = await createNewSingleRepoWorkspace('Fresh Repo');
    if (workspace.type !== 'single-repo') {
      throw new Error('Expected single-repo project');
    }

    expect(fs.existsSync(path.join(workspace.repoPath, 'canopy.json'))).toBe(
      true,
    );
    expect(() =>
      execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: workspace.repoPath,
        stdio: 'ignore',
      }),
    ).not.toThrow();
    expect(() =>
      execFileSync('git', ['config', '--local', '--get', 'user.name'], {
        cwd: workspace.repoPath,
        stdio: 'ignore',
      }),
    ).toThrow();
  });
});
