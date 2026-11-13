import {
  promises as fs,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as fileOps from 'node:fs/promises';
import type * as DirectoryFlush from '@canopy/core-platform/directory-flush';
import { flushDirectory } from '@canopy/core-platform/directory-flush';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fileOps>('node:fs/promises');
  return {
    ...actual,
    cp: jest.fn(actual.cp),
    copyFile: jest.fn(actual.copyFile),
  };
});

jest.mock('@canopy/core-platform/directory-flush', () => {
  const actual = jest.requireActual<typeof DirectoryFlush>(
    '@canopy/core-platform/directory-flush',
  );
  return { ...actual, flushDirectory: jest.fn(actual.flushDirectory) };
});
import type { ArchivedContainerManifest } from '@canopy/desktop-shared/types';
import {
  createInitialState,
  normalizePipeline,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';
import type { ExecutionRuntime } from '@canopy/execution-engine/node/pipelines/executor/types';

jest.mock('../lib/w5-boundary-operation', () => ({
  runW5BoundaryOperation: (
    _definition: unknown,
    _decode: unknown,
    run: (commit: object) => Promise<unknown>,
  ): Promise<unknown> => run({}),
  w5ExpectedRevision: (): undefined => undefined,
}));
jest.mock('../lib/w5-composition-operation', () => ({
  checkW5CompositionRevisions: (): Promise<void> => Promise.resolve(),
  admitW5Composition: (
    _attempt: unknown,
    run: () => Promise<unknown>,
  ): Promise<unknown> => run(),
}));
jest.mock('../lib/w5-commit-log-file-store', () => ({
  W5RevisionConflictError: class extends Error {},
}));
jest.mock('../lib/archived-containers', () => ({
  readArchivedContainerManifest: jest.fn(),
  withArchivedContainerOperationLock: (
    _projectId: string,
    _containerId: string,
    run: () => Promise<unknown>,
  ): Promise<unknown> => run(),
  commitArchivedContainer: jest.fn(() => Promise.resolve()),
  purgeArchivedContainerAfterRestore: jest.fn(() => Promise.resolve(true)),
  broadcastArchivedContainersChanged: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getArchivedContainerExecutionsDir: jest.fn(),
}));
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(),
}));
jest.mock('../lib/resolve-worktree', () => ({ resolveWorktreeCwd: jest.fn() }));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceWorktrees: jest.fn(),
}));
jest.mock('../lib/plan-explore-registry', () => ({
  transferPlanExploreTargets: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../chat-search/service', () => ({
  getChatSearchService: (): object => ({
    worktreeContainerRestored: (): Promise<void> => Promise.resolve(),
  }),
}));
jest.mock('../ledger/lifecycle', () => ({
  notifyLedgerContainerRestored: jest.fn(),
  recordLedgerRestoreIntent: (): Promise<string> =>
    Promise.resolve('no_ledger'),
}));
jest.mock('../ledger/lifecycle-containers', () => ({
  archivedLedgerIncarnation: (): object => ({}),
  restoredLedgerIncarnation: (): object => ({}),
}));
jest.mock('../lib/worktree-service', () => ({
  retryDeferredTemporaryWorkspaceDeletion: (): Promise<null> =>
    Promise.resolve(null),
}));
jest.mock('../lib/archived-container-recovery', () => ({}));
jest.mock('../lib/claude-project-paths', () => ({}));
jest.mock('../lib/plan-persistence', () => ({}));
jest.mock('../lib/chat-archives', () => ({}));
jest.mock('../services/chat-state-service', () => ({}));
jest.mock('../lib/archived-container-restore-records', () => ({}));
jest.mock('../lib/workspace-source', () => ({}));
jest.mock('../lib/project-reference-repo', () => ({}));
jest.mock('../lib/workspace-reference-repo', () => ({}));
jest.mock('../lib/git', () => ({}));
jest.mock('../lib/codex-session-artifacts', () => ({}));
jest.mock('../codex/fork-thread', () => ({}));
jest.mock('../lib/cowork-work-entries', () => ({}));
jest.mock('../lib/worktree-data-cleanup', () => ({}));
jest.mock('../cost-index/lifecycle', () => ({}));
jest.mock('../lib/project-worktree-runtime', () => ({}));
jest.mock('../lib/workspace-worktree-runtime', () => ({}));
jest.mock('../lib/archived-container-git', () => ({}));

import { restoreArchivedContainer } from '../lib/archived-container-restore';
import {
  commitArchivedContainer,
  readArchivedContainerManifest,
} from '../lib/archived-containers';
import { getArchivedContainerExecutionsDir } from '../lib/paths';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';

// Test the fixture volume rather than assuming macOS/Windows case behavior.
const caseProbe = mkdtempSync(join(tmpdir(), 'archive-case-'));
let caseSensitive: boolean;
try {
  writeFileSync(join(caseProbe, 'A.ts'), 'upper');
  caseSensitive = !existsSync(join(caseProbe, 'a.ts'));
} finally {
  rmSync(caseProbe, { recursive: true, force: true });
}

describe('archived-containers:restore execution qualification', () => {
  let dir: string;
  let runtime: ExecutionRuntime;
  const id = 'execution-good';

  beforeEach(async () => {
    jest.clearAllMocks();
    const actual = jest.requireActual<typeof fileOps>('node:fs/promises');
    jest.mocked(fileOps.cp).mockImplementation(actual.cp);
    jest.mocked(fileOps.copyFile).mockImplementation(actual.copyFile);
    dir = await fs.mkdtemp(join(tmpdir(), 'archived-execution-'));
    runtime = {
      isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
      isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
      executionsDir: join(dir, 'live'),
      tempRootDir: dir,
      bundledActionsDir: dir,
      getProjectActionsDir: (repoPath: string): string => repoPath,
      getProjectPipelinesDir: (repoPath: string): string => repoPath,
    };
    const manifest: ArchivedContainerManifest = {
      version: 1,
      id: 'archive-1',
      kind: 'worktree',
      projectId: 'workspace-1',
      name: 'Archive',
      createdAt: '2026-07-01T00:00:00.000Z',
      archivedAt: '2026-07-20T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2026-07-27T00:00:00.000Z',
      chatCount: 0,
      archivedChatCount: 0,
      executionCount: 1,
      workspaceType: 'single-repo',
      executionRestorePending: true,
      restoredTo: {
        kind: 'worktree',
        id: 'restored-1',
        createdAt: '2026-07-22T00:00:00.000Z',
        restoredAt: '2026-07-22T00:00:00.000Z',
      },
    };
    jest.mocked(readArchivedContainerManifest).mockResolvedValue(manifest);
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([
      {
        id: 'restored-1',
        branchName: 'restored-branch',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
    ]);
    jest
      .mocked(getArchivedContainerExecutionsDir)
      .mockReturnValue(join(dir, 'archive'));
    jest.mocked(resolveWorktreeCwd).mockReturnValue(join(dir, 'restored'));
    jest.mocked(createElectronExecutionRuntime).mockReturnValue(runtime);
    await fs.mkdir(join(dir, 'archive', id, 'logs'), { recursive: true });
    await fs.writeFile(
      join(dir, 'archive', `${id}.json`),
      JSON.stringify({
        id,
        version: 1,
        status: 'success',
        future_field: 'keep',
      }),
    );
    await fs.writeFile(
      join(dir, 'archive', id, 'logs', 'say.log'),
      'archived log',
    );
    await fs.mkdir(runtime.executionsDir, { recursive: true });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    jest
      .mocked(flushDirectory)
      .mockImplementation(
        jest.requireActual<typeof DirectoryFlush>(
          '@canopy/core-platform/directory-flush',
        ).flushDirectory,
      );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('never replaces a live execution state an earlier restore installed', async () => {
    const state = createInitialState(
      normalizePipeline({
        name: 'Live',
        on: 'dispatch',
        jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
      }),
      {
        cwd: dir,
        pipelineId: 'live',
        runtime,
        projectId: 'workspace-1',
        worktreeId: 'restored-1',
      },
      id,
    );
    state.status = 'running';
    await saveExecutionState(state, runtime.executionsDir);
    const live = join(runtime.executionsDir, `${id}.json`);
    const document: unknown = JSON.parse(await fs.readFile(live, 'utf8'));
    if (document === null || typeof document !== 'object')
      throw new Error('Expected live state');
    await fs.writeFile(live, JSON.stringify({ ...document, marker: 'live' }));
    const bytes = await fs.readFile(live);
    await fs.mkdir(join(runtime.executionsDir, id, 'logs'), {
      recursive: true,
    });
    await fs.writeFile(
      join(runtime.executionsDir, id, 'logs', 'new.log'),
      'live log',
    );

    const result = await restoreArchivedContainer('workspace-1', 'archive-1');

    expect(result.warnings).toEqual([]);
    expect(await fs.readFile(live)).toEqual(bytes);
    expect(
      await fs.readFile(
        join(runtime.executionsDir, id, 'logs', 'new.log'),
        'utf8',
      ),
    ).toBe('live log');
    expect(
      await fs.readFile(
        join(runtime.executionsDir, id, 'logs', 'say.log'),
        'utf8',
      ),
    ).toBe('archived log');
    await expect(
      fs.access(join(dir, 'archive', `${id}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('flushes the restored artifact tree before removing the archived copy', async () => {
    const restoredLogs = join(runtime.executionsDir, id, 'logs');
    const actual = jest.requireActual<typeof DirectoryFlush>(
      '@canopy/core-platform/directory-flush',
    );
    jest
      .mocked(flushDirectory)
      .mockImplementation((directory) =>
        directory === restoredLogs
          ? Promise.reject(new Error('flush failed'))
          : actual.flushDirectory(directory),
      );

    await restoreArchivedContainer('workspace-1', 'archive-1');

    expect(
      await fs.readFile(join(dir, 'archive', id, 'logs', 'say.log'), 'utf8'),
    ).toBe('archived log');
    jest.mocked(flushDirectory).mockImplementation(actual.flushDirectory);

    await restoreArchivedContainer('workspace-1', 'archive-1');

    expect(jest.mocked(flushDirectory)).toHaveBeenCalledWith(restoredLogs);
    expect(await fs.readFile(join(restoredLogs, 'say.log'), 'utf8')).toBe(
      'archived log',
    );
    await expect(fs.access(join(dir, 'archive', id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retries an interrupted artifact copy without accepting a partial file', async () => {
    const actual = jest.requireActual<typeof fileOps>('node:fs/promises');
    const copy = actual.copyFile;
    const copyTree = actual.cp;
    let interrupted = false;
    jest
      .mocked(fileOps.copyFile)
      .mockImplementation(async (source, destination, mode) => {
        if (!interrupted && basename(String(source)) === 'say.log') {
          interrupted = true;
          await fs.writeFile(destination, 'partial');
          throw new Error('Interrupted copy');
        }
        return copy(source, destination, mode);
      });
    jest
      .mocked(fileOps.cp)
      .mockImplementation(async (source, destination, options) => {
        if (
          !interrupted &&
          basename(String(source)) === id &&
          !options?.filter
        ) {
          interrupted = true;
          await fs.mkdir(join(String(destination), 'logs'), {
            recursive: true,
          });
          await fs.writeFile(
            join(String(destination), 'logs', 'say.log'),
            'partial',
          );
          throw new Error('Interrupted copy');
        }
        return copyTree(source, destination, options);
      });
    const first = await restoreArchivedContainer('workspace-1', 'archive-1');
    expect(interrupted).toBe(true);
    expect(first.warnings.join(' ')).toContain(id);
    expect(
      await fs.readFile(join(dir, 'archive', id, 'logs', 'say.log'), 'utf8'),
    ).toBe('archived log');
    const retry = await restoreArchivedContainer('workspace-1', 'archive-1');
    expect(retry.warnings).toEqual([]);
    expect(
      await fs.readFile(
        join(runtime.executionsDir, id, 'logs', 'say.log'),
        'utf8',
      ),
    ).toBe('archived log');
    await expect(
      fs.access(join(dir, 'archive', `${id}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  (process.platform === 'win32' ? it.skip : it)(
    'restores exact POSIX artifact names and contents without aliasing directory decoys',
    async () => {
      const names = [
        '日本語 🌲.ts',
        "space and apostrophe's.ts",
        'literal\\name.ts',
        'literal/name.ts',
        'report:12.ts',
      ];
      for (const name of names) {
        const source = join(dir, 'archive', id, 'logs', name);
        await fs.mkdir(join(source, '..'), { recursive: true });
        await fs.writeFile(source, `archived:${name}`);
      }
      const result = await restoreArchivedContainer('workspace-1', 'archive-1');
      expect(result.warnings).toEqual([]);
      for (const name of names) {
        expect(
          await fs.readFile(
            join(runtime.executionsDir, id, 'logs', name),
            'utf8',
          ),
        ).toBe(`archived:${name}`);
      }
      expect(await fs.readdir(join(runtime.executionsDir, id, 'logs'))).toEqual(
        expect.arrayContaining([
          '日本語 🌲.ts',
          "space and apostrophe's.ts",
          'literal\\name.ts',
          'literal',
          'report:12.ts',
        ]),
      );
      await expect(fs.access(join(dir, 'archive', id))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        fs.access(join(dir, 'archive', `${id}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  (caseSensitive ? it : it.skip)(
    'restores both real case-neighbor artifacts without overwriting either',
    async () => {
      await fs.writeFile(join(dir, 'archive', id, 'logs', 'A.ts'), 'upper');
      await fs.writeFile(join(dir, 'archive', id, 'logs', 'a.ts'), 'lower');
      const result = await restoreArchivedContainer('workspace-1', 'archive-1');
      expect(result.warnings).toEqual([]);
      const logs = join(runtime.executionsDir, id, 'logs');
      expect(await fs.readdir(logs)).toEqual(
        expect.arrayContaining(['A.ts', 'a.ts']),
      );
      expect(await fs.readFile(join(logs, 'A.ts'), 'utf8')).toBe('upper');
      expect(await fs.readFile(join(logs, 'a.ts'), 'utf8')).toBe('lower');
      await expect(fs.access(join(dir, 'archive', id))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('restores an artifact whose valid filename is near the filesystem limit', async () => {
    const name = `${'a'.repeat(240)}.log`;
    await fs.writeFile(
      join(dir, 'archive', id, 'logs', name),
      'long-named log',
    );
    const result = await restoreArchivedContainer('workspace-1', 'archive-1');
    expect(result.warnings).toEqual([]);
    expect(
      await fs.readFile(join(runtime.executionsDir, id, 'logs', name), 'utf8'),
    ).toBe('long-named log');
    await expect(
      fs.access(join(dir, 'archive', `${id}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips an already restored artifact when staging another copy would run out of space', async () => {
    const destination = join(runtime.executionsDir, id, 'logs', 'say.log');
    await fs.mkdir(join(runtime.executionsDir, id, 'logs'), {
      recursive: true,
    });
    await fs.writeFile(destination, 'already restored log');
    const actual = jest.requireActual<typeof fileOps>('node:fs/promises');
    const copy = jest
      .mocked(fileOps.copyFile)
      .mockImplementation(async (source, target, mode) => {
        if (basename(String(source)) === 'say.log')
          throw Object.assign(new Error('No space left'), { code: 'ENOSPC' });
        return actual.copyFile(source, target, mode);
      });
    const result = await restoreArchivedContainer('workspace-1', 'archive-1');
    expect(result.warnings).toEqual([]);
    expect(await fs.readFile(destination, 'utf8')).toBe('already restored log');
    expect(copy).not.toHaveBeenCalled();
    await expect(
      fs.access(join(dir, 'archive', `${id}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains an archived artifact when its destination is a directory', async () => {
    await fs.mkdir(join(runtime.executionsDir, id, 'logs', 'say.log'), {
      recursive: true,
    });
    const result = await restoreArchivedContainer('workspace-1', 'archive-1');
    expect(result.warnings.join(' ')).toContain(id);
    expect(
      await fs.readFile(join(dir, 'archive', id, 'logs', 'say.log'), 'utf8'),
    ).toBe('archived log');
    await expect(
      fs.access(join(dir, 'archive', `${id}.json`)),
    ).resolves.toBeUndefined();
    expect(
      (
        await fs.stat(join(runtime.executionsDir, id, 'logs', 'say.log'))
      ).isDirectory(),
    ).toBe(true);
  });

  it('keeps the archive through repeated directory flush failures', async () => {
    const state = createInitialState(
      normalizePipeline({
        name: 'Archived',
        on: 'dispatch',
        jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
      }),
      {
        cwd: dir,
        pipelineId: 'archived',
        runtime,
        projectId: 'workspace-1',
        worktreeId: 'archive-1',
      },
      id,
    );
    await fs.writeFile(
      join(dir, 'archive', `${id}.json`),
      JSON.stringify(state),
    );
    jest
      .mocked(flushDirectory)
      .mockRejectedValue(new Error('Directory flush failed'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await restoreArchivedContainer('workspace-1', 'archive-1');
      expect(result.warnings.join(' ')).toContain(id);
      await expect(
        fs.access(join(dir, 'archive', `${id}.json`)),
      ).resolves.toBeUndefined();
      expect(commitArchivedContainer).toHaveBeenLastCalledWith(
        expect.objectContaining({ executionRestorePending: true }),
      );
    }
  });

  it.each(['directory', 'global', 'independent-worktree'] as const)(
    'retries a published %s target after a directory flush failure',
    async (scope) => {
      const state = createInitialState(
        normalizePipeline({
          name: 'Targeted',
          on: 'dispatch',
          jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
        }),
        {
          cwd: dir,
          pipelineId: 'targeted',
          runtime,
          projectId: 'workspace-1',
          worktreeId: 'archive-1',
          target:
            scope === 'directory'
              ? { scope: 'directory', path: dir }
              : scope === 'global'
                ? { scope: 'global' }
                : {
                    scope: 'worktree',
                    workspace_id: 'other-workspace',
                    worktree_id: 'other-worktree',
                    created: false,
                    path: dir,
                  },
        },
        id,
      );
      await fs.writeFile(
        join(dir, 'archive', `${id}.json`),
        JSON.stringify(state),
      );
      jest
        .mocked(flushDirectory)
        .mockRejectedValueOnce(new Error('Directory flush failed'));
      const first = await restoreArchivedContainer('workspace-1', 'archive-1');
      expect(first.warnings.join(' ')).toContain(id);
      const live = join(runtime.executionsDir, `${id}.json`);
      const bytes = await fs.readFile(live);
      const retry = await restoreArchivedContainer('workspace-1', 'archive-1');
      expect(retry.warnings).toEqual([]);
      expect(await fs.readFile(live)).toEqual(bytes);
      expect(
        await fs.readFile(
          join(runtime.executionsDir, id, 'logs', 'say.log'),
          'utf8',
        ),
      ).toBe('archived log');
      await expect(
        fs.access(join(dir, 'archive', `${id}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('retains the archive when live state still belongs to the archived worktree', async () => {
    const state = createInitialState(
      normalizePipeline({
        name: 'Source-bound',
        on: 'dispatch',
        jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
      }),
      {
        cwd: dir,
        pipelineId: 'source',
        runtime,
        projectId: 'workspace-1',
        worktreeId: 'archive-1',
      },
      id,
    );
    await saveExecutionState(state, runtime.executionsDir);
    const bytes = await fs.readFile(join(runtime.executionsDir, `${id}.json`));
    const result = await restoreArchivedContainer('workspace-1', 'archive-1');
    expect(result.warnings.join(' ')).toContain(id);
    expect(
      await fs.readFile(join(runtime.executionsDir, `${id}.json`)),
    ).toEqual(bytes);
    await expect(
      fs.access(join(dir, 'archive', `${id}.json`)),
    ).resolves.toBeUndefined();
    expect(commitArchivedContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionRestorePending: true }),
    );
  });

  it('keeps the archived copy when the live state cannot be read', async () => {
    await fs.mkdir(join(runtime.executionsDir, `${id}.json`));

    const result = await restoreArchivedContainer('workspace-1', 'archive-1');

    expect(result.warnings.join(' ')).toContain(id);
    await expect(
      fs.access(join(dir, 'archive', `${id}.json`)),
    ).resolves.toBeUndefined();
    expect(commitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({ executionRestorePending: true }),
    );
  });
});
