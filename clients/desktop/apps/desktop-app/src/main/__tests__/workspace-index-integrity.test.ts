import type * as LegacyStorage from '../lib/__tests__/fixtures/w5-legacy-storage';
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<
      typeof LegacyStorage
    >('../lib/__tests__/fixtures/w5-legacy-storage')
    .createLegacyW5StorageMock(),
);
// CAN-3329: a degraded read of the workspace index must never turn into a
// destructive rewrite. The index cases run real sidebar/Cowork CRUD against
// temporary storage; the cleanup cases also run the real commit-log worker.
// Fault injection models truncated reads and failed or unanswered writes.
import type * as FsPromises from 'node:fs/promises';
import type * as TsxWorkerThreads from '../ledger/__tests__/fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

let mockTruncateNextIndexRead = false;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    readFile: jest.fn(
      async (...args: Parameters<typeof actual.readFile>): Promise<unknown> => {
        const [target] = args;
        if (
          mockTruncateNextIndexRead &&
          typeof target === 'string' &&
          target.endsWith('index.json')
        ) {
          mockTruncateNextIndexRead = false;
          return '{"version": 1, "workspa';
        }
        return actual.readFile(...args);
      },
    ),
  };
});

const mockRecordAppDiagnostic = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({}));
jest.mock('../pipelines/execution-runtime', () => ({}));
jest.mock('../ledger/lifecycle', () => ({}));

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  type CoworkSidebarItem,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { listCoworkWorkspacesAsChatProjects } from '../lib/cowork-workspace-crud';
import { getWorkspaceIndexFilePath } from '../lib/paths';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  setWorkspaceActivitySectionOrder,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import { reorderWorkspaces } from '../lib/workspace-metadata';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { W5CommitRequest } from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitLogHost } from '../w5-commit-log/commit-log-host';
import {
  __setDesktopW5FileStoreForTests,
  createW5CommitLogFileStore,
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../lib/w5-commit-log-file-store';
import { nodeW5FileStore } from '../lib/w5-file-store';
import {
  WORKSPACE_MANIFEST_STORAGE,
  withStorageAdmission,
} from '../lib/w5-storage';
import { discardCoworkWorkspaceRecord } from '../lib/cowork-workspace-records';
import { removeSplitCreatedWorkspace } from '../lib/split-temporary-workspace-records';
import { cleanupCompositionDestination } from '../lib/workspace-composition-records';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import * as worktreeDataCleanup from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import * as git from '../lib/git';
import * as instructions from '../lib/instruction-files';
import {
  createOrReuseTemporaryWorkspaceFromRepos,
  createOrReuseTemporaryWorkspaceFromWorkspaces,
} from '../lib/adhoc-multi-repo-workspaces';

function coworkItem(id: string, order: number): CoworkSidebarItem {
  return {
    id,
    name: `Project ${id}`,
    type: 'cowork',
    color: '#7C3AED',
    collapsed: false,
    order,
    cowork: { createdAt: '2026-09-01T00:00:00.000Z' },
  };
}

async function readIndexIdsAt(filePath: string): Promise<string[]> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('workspaces' in parsed) ||
    !Array.isArray(parsed.workspaces)
  ) {
    throw new Error(`Expected a workspace index at ${filePath}`);
  }
  return parsed.workspaces.map((entry: { id: string }) => entry.id);
}

async function readIndexIds(): Promise<string[]> {
  return readIndexIdsAt(getWorkspaceIndexFilePath());
}

interface IndexDocument {
  [key: string]: unknown;
  workspaces: Array<Record<string, unknown>>;
}

async function readIndexDocument(): Promise<IndexDocument> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceIndexFilePath(), 'utf8'),
  );
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('workspaces' in parsed) ||
    !Array.isArray(parsed.workspaces)
  ) {
    throw new Error('Expected a workspace index');
  }
  const workspaces: Array<Record<string, unknown>> = parsed.workspaces.filter(
    (entry: unknown): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null,
  );
  return { ...parsed, workspaces };
}

/** An entry this version cannot read, as a newer app could write. */
const FUTURE_ENTRY = {
  id: 'future',
  name: 'Future',
  type: 'notebook',
  color: '#000000',
  collapsed: false,
  order: 3,
};

/** Adds fields and an entry this version does not know (CAN-3800). */
async function addUnknownIndexData(): Promise<void> {
  const index = await readIndexDocument();
  await writeFile(
    getWorkspaceIndexFilePath(),
    JSON.stringify(
      {
        ...index,
        futureTopLevel: { enabled: true },
        workspaces: [
          ...index.workspaces.map((entry) =>
            entry.id === 'alpha'
              ? { ...entry, futureField: 'kept', pinned: true }
              : entry,
          ),
          FUTURE_ENTRY,
        ],
      },
      null,
      2,
    ),
  );
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(15_000);

describe('workspace index integrity (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  const projects: SidebarItem[] = ['alpha', 'beta', 'gamma'].map((id, order) =>
    coworkItem(id, order),
  );

  beforeEach(async () => {
    jest.clearAllMocks();
    __resetSidebarItemsStateForTests();
    mockTruncateNextIndexRead = false;
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-index-integrity-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems(projects);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('does not provision the default project from a mid-write index read', async () => {
    mockTruncateNextIndexRead = true;

    await listCoworkWorkspacesAsChatProjects();

    expect(await readIndexIds()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('provisions the default project without dropping existing projects', async () => {
    const projectsList = await listCoworkWorkspacesAsChatProjects();

    expect(projectsList.map((project) => project.id)).toContain(
      DEFAULT_COWORK_WORKSPACE_ID,
    );
    expect(await readIndexIds()).toEqual([
      'alpha',
      'beta',
      'gamma',
      DEFAULT_COWORK_WORKSPACE_ID,
    ]);
  });

  it('refuses a partial rewrite over an unreadable index and logs it', async () => {
    await writeFile(getWorkspaceIndexFilePath(), '{"version": 1, "work');

    await expect(
      writeAllSidebarItems([coworkItem('delta', 0)]),
    ).rejects.toThrow(/workspace index/i);

    expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(
      '{"version": 1, "work',
    );
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workspace_index_write_refused' }),
    );
  });

  it('keeps a backup of the previous index before each rewrite', async () => {
    await writeAllSidebarItems([...projects, coworkItem('delta', 3)]);

    expect(await readIndexIdsAt(`${getWorkspaceIndexFilePath()}.bak`)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('never drops entries when a full save races the default-project listing', async () => {
    const saved = (await readAllSidebarItems()).items;

    for (let round = 0; round < 25; round += 1) {
      await Promise.all([
        writeAllSidebarItems(saved, { preserveUnmentionedWorkspaceIds: true }),
        listCoworkWorkspacesAsChatProjects(),
        writeAllSidebarItems(saved, { preserveUnmentionedWorkspaceIds: true }),
      ]);
      expect(await readIndexIds()).toEqual(
        expect.arrayContaining(['alpha', 'beta', 'gamma']),
      );
    }
  }, 120_000);

  describe('unknown index data (CAN-3800)', () => {
    beforeEach(addUnknownIndexData);

    it('keeps unknown fields and unreadable entries through a full save', async () => {
      await writeAllSidebarItems(
        projects.map((project) =>
          project.id === 'alpha' ? { ...project, collapsed: true } : project,
        ),
      );

      const index = await readIndexDocument();
      expect(index.futureTopLevel).toEqual({ enabled: true });
      const alpha = index.workspaces.find((entry) => entry.id === 'alpha');
      expect(alpha).toMatchObject({ collapsed: true, futureField: 'kept' });
      // The save carried no pin: a deliberate clear of a known field.
      expect(alpha).not.toHaveProperty('pinned');
      expect(index.workspaces).toContainEqual(FUTURE_ENTRY);
    });

    it('keeps an unreadable entry when setting the activity order', async () => {
      expect(
        await setWorkspaceActivitySectionOrder('beta', ['plans', 'summary']),
      ).toBe(true);

      const index = await readIndexDocument();
      expect(
        index.workspaces.find((entry) => entry.id === 'beta'),
      ).toMatchObject({ activitySectionOrder: ['plans', 'summary'] });
      expect(index.workspaces).toContainEqual(FUTURE_ENTRY);
      expect(
        index.workspaces.find((entry) => entry.id === 'alpha'),
      ).toMatchObject({ futureField: 'kept', pinned: true });
    });

    it('keeps an unreadable entry when reordering visible projects', async () => {
      expect(
        await reorderWorkspaces({
          visibleWorkspaceIds: ['alpha', 'beta', 'gamma'],
          activeWorkspaceId: 'gamma',
          overWorkspaceId: 'alpha',
        }),
      ).toEqual({ workspaceIds: ['gamma', 'alpha', 'beta'] });

      expect(await readIndexIds()).toEqual([
        'gamma',
        'alpha',
        'beta',
        'future',
      ]);
      expect(
        (await readIndexDocument()).workspaces.find(
          (entry) => entry.id === 'alpha',
        ),
      ).toMatchObject({ futureField: 'kept' });
    });
  });
});

// CAN-5599: cleanup is part of the persisted index/manifest/list contract.
// A second store shares the real worker, not the deleting store's read cache.
describe('workspace cleanup persistence integrity', () => {
  const sites = ['discard', 'split', 'composition'] as const;
  type Site = (typeof sites)[number];
  const owner = {
    type: 'organization',
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    bindingGeneration: 2,
  } as const;
  let dir: string;
  let root: string;
  let originalDataDir: string | undefined;
  let host: W5CommitLogHost;
  let commits: W5CommitRequest[];

  function seed(file: string, value: unknown): void {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }
  function bytes(file: string): string {
    return readFileSync(path.join(root, file), 'utf8');
  }
  function index(ids: readonly string[]): void {
    seed('index.json', {
      version: 1,
      future: { retained: true },
      workspaces: ids.map((id, order) => coworkItem(id, order)),
    });
  }
  function prepare(site: Site): void {
    index(site === 'discard' ? ['other'] : ['a', 'other']);
    seed('a/workspace.json', {
      version: 1,
      type: 'cowork',
      repos: [],
      owner,
    });
    seed('a/worktrees.json', { version: 1, worktrees: [] });
    seed('other/workspace.json', { sentinel: 'other manifest' });
    seed('other/worktrees.json', { sentinel: 'other list' });
  }
  async function cleanup(site: Site): Promise<void> {
    if (site === 'discard') {
      await discardCoworkWorkspaceRecord({
        source: 'org_cowork_discard',
        workspaceId: 'a',
        projectId: owner.projectId,
      });
    } else if (site === 'split') {
      await removeSplitCreatedWorkspace({
        source: 'temporary_split',
        workspaceId: 'a',
        worktreeIds: [],
        containsRollbackData: () => Promise.resolve(false),
      });
    } else {
      await cleanupCompositionDestination({
        source: 'workspace_combine',
        workspaceId: 'a',
      });
    }
  }
  function revision(): Promise<number> {
    return host.revision({ kind: 'workspace', workspaceId: 'a' });
  }
  function expectRecordsPresent(): void {
    expect(existsSync(path.join(root, 'a/workspace.json'))).toBe(true);
    expect(existsSync(path.join(root, 'a/worktrees.json'))).toBe(true);
  }
  function expectRecordsAbsent(): void {
    expect(existsSync(path.join(root, 'a/workspace.json'))).toBe(false);
    expect(existsSync(path.join(root, 'a/worktrees.json'))).toBe(false);
  }

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'w5-cleanup-')));
    root = path.join(dir, 'data/workspaces');
    mkdirSync(root, { recursive: true });
    originalDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = path.join(dir, 'data');
    __resetSidebarItemsStateForTests();
    mockTruncateNextIndexRead = false;
    jest.clearAllMocks();
    host = new W5CommitLogHost({
      root,
      dbPath: path.join(dir, 'w5/commit-log.sqlite'),
      workerEntry: path.join(
        __dirname,
        '../lib/__tests__/fixtures/w5-commit-log-source-worker.ts',
      ),
    });
    commits = [];
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementation(async (request) => {
      const result = await commit(request);
      commits.push(request);
      return result;
    });
    __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  });
  afterEach(async () => {
    await settleDetachedWork();
    __setDesktopW5FileStoreForTests(nodeW5FileStore);
    await host.shutdown();
    jest.restoreAllMocks();
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(sites)(
    '%s removes records durably and refuses a peer edit captured before deletion',
    async (site) => {
      prepare(site);
      seed('a/child', 'non-W5 child');
      const peer = createW5CommitLogFileStore(() => host);
      const target = path.join(root, 'a/workspace.json');
      const before = await peer.read(target);
      if (before.state !== 'present') throw new Error('Expected manifest');
      await cleanup(site);
      expect(existsSync(path.join(root, 'a'))).toBe(false);
      expect(await revision()).toBe(site === 'composition' ? 2 : 1);
      expect(await host.revision({ kind: 'workspaces' })).toBe(
        site === 'discard' ? 0 : 1,
      );
      await expect(
        withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
          peer.replace(target, '{}', WORKSPACE_MANIFEST_STORAGE, {
            operation: 'test.stale.peer',
            advance: [{ kind: 'workspace', workspaceId: 'a' }],
            previousRaw: before.raw,
          }),
        ),
      ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
      await expect(
        peer.withCommit(
          {
            operation: 'test.stale.revision',
            expectedRevisions: [
              {
                resource: { kind: 'workspace', workspaceId: 'a' },
                revision: 0,
              },
            ],
          },
          async () => {},
        ),
      ).rejects.toBeInstanceOf(W5RevisionConflictError);
      expectRecordsAbsent();
      expect(bytes('other/workspace.json')).toContain('other manifest');
      expect(bytes('other/worktrees.json')).toContain('other list');
      expect(bytes('index.json')).toContain('retained');
      expect(await readIndexIds()).toEqual(['other']);
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it.each(['discard', 'composition'] as const)(
    '%s fences revision-only peer edits to removed list rows',
    async (site) => {
      prepare(site);
      seed('a/worktrees.json', {
        version: 1,
        worktrees: [
          {
            id: 'entry',
            createdAt: '2026-11-01T00:00:00Z',
            branchName: 'topic',
          },
        ],
      });
      const peer = createW5CommitLogFileStore(() => host);
      const resource = { kind: 'worktrees', workspaceId: 'a' } as const;
      const [captured] = await peer.readRevisions([resource]);
      if (!captured) throw new Error('Expected list revision');
      const before = captured.revision;
      await cleanup(site);
      expect(await host.revision(resource)).toBe(before + 1);
      expect(
        await host.revision({
          kind: 'worktree',
          workspaceId: 'a',
          worktreeId: 'entry',
        }),
      ).toBe(1);
      await expect(
        peer.withCommit(
          {
            operation: 'test.stale.list',
            expectedRevisions: [{ resource, revision: before }],
          },
          async () => {},
        ),
      ).rejects.toBeInstanceOf(W5RevisionConflictError);
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it.each([
    { site: 'discard', record: 'worktrees.json' },
    { site: 'composition', record: 'worktrees.json' },
    { site: 'composition', record: 'workspace.json' },
    { site: 'split', record: 'workspace.json' },
  ] as const)(
    '$site removes readable corrupt $record without a new preflight',
    async ({ site, record }) => {
      prepare(site);
      seed(`a/${record}`, '{broken');
      await cleanup(site);
      expectRecordsAbsent();
      expect(await revision()).toBe(site === 'composition' ? 2 : 1);
      expect(await host.revision({ kind: 'worktrees', workspaceId: 'a' })).toBe(
        record === 'worktrees.json' ? 1 : 0,
      );
      expect(
        await host.revision({
          kind: 'worktree',
          workspaceId: 'a',
          worktreeId: 'entry',
        }),
      ).toBe(0);
    },
  );

  it('core.workspace.create discard boundary removes matching staging even before an index exists', async () => {
    prepare('discard');
    rmSync(path.join(root, 'index.json'));
    await cleanup('discard');
    expectRecordsAbsent();
    expect(await revision()).toBe(1);
    expect(await host.revision({ kind: 'workspaces' })).toBe(0);
    expect(existsSync(path.join(root, 'other/workspace.json'))).toBe(true);
  });

  it.each(sites)(
    '%s retains a peer-created manifest after the deletion commit',
    async (site) => {
      prepare(site);
      const peer = createW5CommitLogFileStore(() => host);
      const target = path.join(root, 'a/workspace.json');
      const fs = jest.requireMock<typeof FsPromises>('node:fs/promises');
      const removeDirectory = fs.rmdir;
      jest
        .spyOn(fs, 'rmdir')
        .mockImplementationOnce(async (directory, options) => {
          const missing = await peer.read(target);
          if (missing.state !== 'absent')
            throw new Error('Expected removed manifest');
          await withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
            peer.replace(
              target,
              '{"peer":"kept"}',
              WORKSPACE_MANIFEST_STORAGE,
              {
                operation: 'test.peer.recreate',
                advance: [{ kind: 'workspace', workspaceId: 'a' }],
                previousRaw: null,
              },
            ),
          );
          return removeDirectory(directory, options);
        });
      await cleanup(site);
      expect(bytes('a/workspace.json')).toBe('{"peer":"kept"}');
      expect(existsSync(path.join(root, 'a'))).toBe(true);
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it.each(sites)(
    '%s preserves records when Q2(b) child preparation fails',
    async (site) => {
      prepare(site);
      seed('a/busy-child', 'keep');
      const manifest = bytes('a/workspace.json');
      const list = bytes('a/worktrees.json');
      const fs = jest.requireMock<typeof FsPromises>('node:fs/promises');
      const remove = fs.rm;
      const busy = Object.assign(new Error('busy child'), { code: 'EBUSY' });
      jest.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
        if (target === path.join(root, 'a/busy-child')) throw busy;
        return remove(target, options);
      });
      if (site === 'composition')
        await expect(cleanup(site)).resolves.toBeUndefined();
      else await expect(cleanup(site)).rejects.toBe(busy);
      expect(bytes('a/busy-child')).toBe('keep');
      expect(bytes('a/workspace.json')).toBe(manifest);
      expect(bytes('a/worktrees.json')).toBe(list);
      expect(await revision()).toBe(site === 'composition' ? 1 : 0);
      expect(commits).toHaveLength(site === 'composition' ? 1 : 0);
      expect(await readIndexIds()).toEqual(
        site === 'composition' || site === 'discard'
          ? ['other']
          : ['a', 'other'],
      );
    },
  );

  it.each(sites)(
    '%s never runs the final remover after a refused records commit',
    async (site) => {
      prepare(site);
      seed('a/child', 'removed before commit');
      const manifest = bytes('a/workspace.json');
      const list = bytes('a/worktrees.json');
      const commit = jest.spyOn(host, 'commit').getMockImplementation();
      if (!commit) throw new Error('Expected worker commit binding');
      const refusal = new Error('records refused');
      jest.spyOn(host, 'commit').mockImplementation(async (request) => {
        if (request.files.some((file) => file.contents === null)) {
          expect(existsSync(path.join(root, 'a/child'))).toBe(false);
          throw refusal;
        }
        return commit(request);
      });
      const fs = jest.requireMock<typeof FsPromises>('node:fs/promises');
      const rmdir = jest.spyOn(fs, 'rmdir');
      if (site === 'composition')
        await expect(cleanup(site)).resolves.toBeUndefined();
      else await expect(cleanup(site)).rejects.toBe(refusal);
      expect(rmdir).not.toHaveBeenCalled();
      expect(bytes('a/workspace.json')).toBe(manifest);
      expect(bytes('a/worktrees.json')).toBe(list);
      expect(await revision()).toBe(site === 'composition' ? 1 : 0);
      expect(await readIndexIds()).toEqual(
        site === 'split' ? ['a', 'other'] : ['other'],
      );
    },
  );

  it.each(sites)(
    '%s leaves committed records removed when final rmdir fails',
    async (site) => {
      prepare(site);
      const fs = jest.requireMock<typeof FsPromises>('node:fs/promises');
      const busy = Object.assign(new Error('busy directory'), {
        code: 'EBUSY',
      });
      jest.spyOn(fs, 'rmdir').mockRejectedValueOnce(busy);
      if (site === 'composition')
        await expect(cleanup(site)).resolves.toBeUndefined();
      else await expect(cleanup(site)).rejects.toBe(busy);
      expectRecordsAbsent();
      expect(existsSync(path.join(root, 'a'))).toBe(true);
      expect(await revision()).toBe(site === 'composition' ? 2 : 1);
      expect(await readIndexIds()).toEqual(['other']);
      if (site === 'split') {
        expect(notifyPortalStructureChanged).toHaveBeenCalled();
        expect(schedulePortalStructuralSync).toHaveBeenCalled();
      }
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it.each([null, new Error('persisted data busy')])(
    'split publishes its durable index before rethrowing post-apply data failure (%s)',
    async (failure) => {
      prepare('split');
      jest
        .spyOn(worktreeDataCleanup, 'removePersistedWorktreeDataDirectory')
        .mockRejectedValueOnce(failure);
      await expect(
        removeSplitCreatedWorkspace({
          source: 'temporary_split',
          workspaceId: 'a',
          worktreeIds: ['entry'],
          containsRollbackData: () => Promise.resolve(false),
        }),
      ).rejects.toBe(failure);
      expectRecordsAbsent();
      expect(await revision()).toBe(1);
      expect(await readIndexIds()).toEqual(['other']);
      expect(notifyPortalStructureChanged).toHaveBeenCalled();
      expect(schedulePortalStructuralSync).toHaveBeenCalled();
      expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    },
  );

  it('cleanup shared by core.workspace.composition.combine removes records after a separate refused index cleanup', async () => {
    prepare('composition');
    seed('index.json', '{broken');
    await cleanup('composition');
    expect(bytes('index.json')).toBe('{broken');
    expect(existsSync(path.join(root, 'a'))).toBe(false);
    expect(await revision()).toBe(1);
    expect(await host.revision({ kind: 'workspaces' })).toBe(0);
  });

  it.each(['rows', 'rollback', 'missing', 'corrupt', 'partial'] as const)(
    'core.workspace.composition.split cleanup retains a nonempty or non-authoritative destination (%s)',
    async (state) => {
      prepare('split');
      if (state === 'rows')
        seed('a/worktrees.json', {
          version: 1,
          worktrees: [
            {
              id: 'entry',
              createdAt: '2026-11-01T00:00:00Z',
              branchName: 'topic',
            },
          ],
        });
      if (state === 'missing') rmSync(path.join(root, 'a/worktrees.json'));
      if (state === 'corrupt') seed('a/worktrees.json', '{broken');
      if (state === 'partial')
        seed('a/worktrees.json', {
          version: 1,
          worktrees: [{ id: 'future', futureVersion: 2 }],
        });
      seed('a/child', 'untouched');
      const listBefore = state === 'missing' ? null : bytes('a/worktrees.json');
      const cleanupSplit = removeSplitCreatedWorkspace({
        source: 'temporary_split',
        workspaceId: 'a',
        worktreeIds: [],
        containsRollbackData: () => Promise.resolve(state === 'rollback'),
      });
      if (state === 'missing' || state === 'corrupt' || state === 'partial')
        await expect(cleanupSplit).rejects.toThrow();
      else await expect(cleanupSplit).resolves.toBe(false);
      expect(existsSync(path.join(root, 'a/workspace.json'))).toBe(true);
      expect(bytes('a/child')).toBe('untouched');
      if (listBefore === null)
        expect(existsSync(path.join(root, 'a/worktrees.json'))).toBe(false);
      else expect(bytes('a/worktrees.json')).toBe(listBefore);
      expect(await readIndexIds()).toEqual(['a', 'other']);
      expect(await revision()).toBe(0);
      expect(commits).toEqual([]);
    },
  );

  it('failed temporary creation fences its old records through both selection routes at every failure stage', async () => {
    seed('index.json', {
      version: 1,
      workspaces: ['a', 'b'].map((id, order) => ({
        id,
        name: id.toUpperCase(),
        type: 'single-repo',
        color: '#123456',
        collapsed: false,
        order,
      })),
    });
    for (const id of ['a', 'b']) {
      const repoPath = path.join(dir, 'repos', id);
      mkdirSync(repoPath, { recursive: true });
      seed(`${id}/workspace.json`, {
        version: 1,
        type: 'single-repo',
        repoPath,
        repos: [],
      });
      seed(`${id}/worktrees.json`, { version: 1, worktrees: [] });
    }
    jest.spyOn(git, 'getRemoteUrl').mockResolvedValue(null);
    const peer = createW5CommitLogFileStore(() => host);
    const commitSpy = jest.spyOn(host, 'commit');
    const commit = commitSpy.getMockImplementation();
    if (!commit) throw new Error('Expected worker commit binding');
    for (const route of ['repositories', 'workspaces'] as const) {
      for (const stage of [
        'records-before',
        'records-after',
        'instructions',
        'agents',
        'index-before',
        'index-after',
      ] as const) {
        const revisionBefore = await host.revision({
          kind: 'workspace',
          workspaceId: 'a-b',
        });
        const restoreStageMocks: Array<() => void> = [];
        try {
          const target = path.join(root, 'a-b/workspace.json');
          const captured: { value?: Awaited<ReturnType<typeof peer.read>> } =
            {};
          let failed = false;
          commitSpy.mockImplementation(async (request) => {
            const creating = request.files.some(
              (file) => file.path === target && file.contents !== null,
            );
            const publishing = request.files.some(
              (file) => file.path === path.join(root, 'index.json'),
            );
            const shouldFail =
              !failed &&
              (stage.startsWith('records')
                ? creating
                : stage.startsWith('index')
                  ? publishing
                  : false);
            if (shouldFail && stage.endsWith('before')) {
              failed = true;
              throw new Error('create unavailable');
            }
            const result = await commit(request);
            if (creating) captured.value = await peer.read(target);
            if (shouldFail && stage.endsWith('after')) {
              failed = true;
              throw new Error('create answer lost');
            }
            return result;
          });
          if (stage === 'instructions') {
            const fs = jest.requireMock<typeof FsPromises>('node:fs/promises');
            const write = fs.writeFile;
            const writeSpy = jest
              .spyOn(fs, 'writeFile')
              .mockImplementation((...args) =>
                typeof args[0] === 'string' && args[0].endsWith('CLAUDE.md')
                  ? Promise.reject(new Error('instructions unavailable'))
                  : write(...args),
              );
            restoreStageMocks.push(() => writeSpy.mockRestore());
          }
          if (stage === 'agents') {
            const agentsSpy = jest
              .spyOn(instructions, 'ensureAgentsMdSymlink')
              .mockRejectedValueOnce(new Error('instructions unavailable'));
            restoreStageMocks.push(() => agentsSpy.mockRestore());
          }
          const select =
            route === 'repositories'
              ? createOrReuseTemporaryWorkspaceFromRepos(
                  ['a', 'b'].map((id) => ({
                    name: id.toUpperCase(),
                    path: path.join(dir, 'repos', id),
                  })),
                )
              : createOrReuseTemporaryWorkspaceFromWorkspaces(['b', 'a']);
          await expect(select).rejects.toThrow(/unavailable|answer lost/);
          expect(existsSync(path.join(root, 'a-b'))).toBe(false);
          expect(await readIndexIds()).toEqual(['a', 'b']);
          for (const id of ['a', 'b']) {
            expect(bytes(`${id}/workspace.json`)).toContain('single-repo');
            expect(bytes(`${id}/worktrees.json`)).toContain('worktrees');
          }
          expect({
            route,
            stage,
            revisionDelta:
              (await host.revision({ kind: 'workspace', workspaceId: 'a-b' })) -
              revisionBefore,
          }).toEqual({
            route,
            stage,
            revisionDelta:
              stage === 'records-before' ? 0 : stage === 'index-after' ? 4 : 2,
          });
          if (captured.value?.state === 'present') {
            const previousRaw = captured.value.raw;
            await expect(
              withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () =>
                peer.replace(target, '{}', WORKSPACE_MANIFEST_STORAGE, {
                  operation: 'test.failed-create.stale-peer',
                  advance: [{ kind: 'workspace', workspaceId: 'a-b' }],
                  previousRaw,
                }),
              ),
            ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
          } else expect(stage).toBe('records-before');
          expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
        } catch (error) {
          throw new Error(`Temporary create ${route}/${stage}`, {
            cause: error,
          });
        } finally {
          for (const restore of restoreStageMocks.reverse()) restore();
          commitSpy.mockImplementation(commit);
        }
      }
    }
  });

  it('discard keeps attached folders, published workspaces and differently owned staging', async () => {
    prepare('discard');
    const attached = path.join(dir, 'attached');
    mkdirSync(attached);
    writeFileSync(path.join(attached, 'sentinel'), 'user data');
    seed('a/workspace.json', {
      version: 1,
      type: 'cowork',
      repos: [],
      externalPath: attached,
      owner,
    });
    index(['a', 'other']);
    await cleanup('discard');
    expectRecordsPresent();
    index(['other']);
    seed('a/workspace.json', {
      version: 1,
      type: 'cowork',
      repos: [],
      owner: { ...owner, projectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    });
    await cleanup('discard');
    expectRecordsPresent();
    seed('a/workspace.json', {
      version: 1,
      type: 'cowork',
      repos: [],
      externalPath: attached,
      owner,
    });
    await cleanup('discard');
    expect(existsSync(path.join(root, 'a'))).toBe(false);
    expect(readFileSync(path.join(attached, 'sentinel'), 'utf8')).toBe(
      'user data',
    );
    expect(await revision()).toBe(1);
  });
});
