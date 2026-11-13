import type * as SidebarModule from '../../lib/sidebar-items';
import type * as W5FileStoreModule from '../../lib/w5-commit-log-file-store';
import {
  CoreWorkspaceSchema,
  CoreWorktreeSchema,
  hasHostAbsolutePath,
  type CanopyQueryParams,
} from '@canopy/protocol/canopy-core';
import type {
  SidebarItemsFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  createCoreWorkspaceAdapter,
  createCoreWorkspaceReadSnapshots,
  type CoreWorkspaceReadServices,
} from '../core-workspace-adapter';
import { DEFAULT_ACTIVITY_SECTION_ORDER } from '@canopy/desktop-shared/constants/activity';
import { CORE_READ_SNAPSHOT_LIMITS } from '@canopy/core-runtime/node/workspace/core-workspace-read-snapshots';
import { sanitizeRemoteUrl } from '../../lib/plan-share-repos';
import type { W5ReadViewOutcome } from '../../lib/w5-read-view';
import type { W5CaptureResult } from '../../w5-commit-log/commit-log-worker-contract';

const caller = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'local-desktop',
  interfaceKind: 'test' as const,
  grants: ['core.workspace.read' as const, 'core.worktree.read' as const],
};

const worktree: WorktreeData = {
  id: 'wt-1',
  branchName: 'feature',
  createdAt: '2026-09-01T00:00:00Z',
  trackedBaseBranch: null,
};

function fixture(
  kind: 'single-repo' | 'multi-repo' | 'cowork',
): SidebarItemsFile {
  const common = {
    id: 'ws-1',
    name: 'Workspace',
    color: 'blue',
    collapsed: false,
    order: 0,
  };
  if (kind === 'cowork')
    return {
      version: 1,
      items: [
        {
          ...common,
          type: 'cowork',
          externalPath: '/secret/home',
          archivedContainerCount: 2,
        },
      ],
    };
  if (kind === 'multi-repo')
    return {
      version: 1,
      items: [
        {
          ...common,
          type: 'multi-repo',
          sourceRepoPath: '/secret/source',
          repos: [
            {
              id: 'repo-1',
              name: 'Repo',
              repoPath: '/secret/repo',
              manifestUrl: 'https://example.com/repo.git',
            },
          ],
          worktrees: [worktree],
          archivedContainerCount: 2,
        },
      ],
    };
  return {
    version: 1,
    items: [
      {
        ...common,
        type: 'single-repo',
        repoPath: '/secret/repo',
        worktrees: [worktree],
      },
    ],
  };
}

function makeRuntime(
  sidebar: SidebarItemsFile,
  persistedWorktrees: WorktreeData[] = sidebar.items[0]?.type === 'cowork'
    ? []
    : [worktree],
): {
  runtime: DesktopCanopyDispatcher;
  reads: {
    readAllSidebarItems: jest.Mock;
    readWorkspaceWorktrees: jest.Mock;
    readWorkspaceConfig: jest.Mock;
    readEffectiveWorkspaceConfig: jest.Mock;
    readWorkspaceIndexEntry: jest.Mock;
  };
} {
  const readAllSidebarItems = jest.fn().mockResolvedValue(sidebar);
  const readWorkspaceWorktrees = jest
    .fn()
    .mockResolvedValue(persistedWorktrees);
  const readWorkspaceConfig = jest
    .fn()
    .mockResolvedValue({ version: 1, type: 'multi-repo', repos: [] });
  const readEffectiveWorkspaceConfig = jest.fn().mockResolvedValue({
    repos: [{ id: 'repo-1', manifestUrl: 'https://example.com/repo.git' }],
  });
  const readWorkspaceIndexEntry = jest.fn().mockResolvedValue({
    id: 'ws-1',
    name: 'Workspace',
    type: sidebar.items[0]?.type,
  });
  return {
    runtime: createDesktopRuntime({
      workspaceServices: {
        readAllSidebarItems,
        readWorkspaceWorktrees,
        readWorkspaceConfig,
        readEffectiveWorkspaceConfig,
        readWorkspaceIndexEntry,
      },
    }),
    reads: {
      readAllSidebarItems,
      readWorkspaceWorktrees,
      readWorkspaceConfig,
      readEffectiveWorkspaceConfig,
      readWorkspaceIndexEntry,
    },
  };
}

function withManifestUrl(manifestUrl: string): SidebarItemsFile {
  const sidebar = fixture('multi-repo');
  if (sidebar.items[0]?.type !== 'multi-repo') throw new Error('fixture');
  sidebar.items[0].repos[0].manifestUrl = manifestUrl;
  return sidebar;
}

const HOST_PATH_SPELLINGS = [
  'FILE:///Users/alice/repo',
  'File://localhost/Users/alice/repo',
  'file:/Users/alice/repo',
  '\\Users\\alice\\repo',
  '\\\\server\\share\\repo',
  'C:\\Users\\alice\\repo',
  'c:/Users/alice/repo',
];

describe('core workspace read projections', () => {
  test('legacy projections report the authority of the read that produced them', async () => {
    const sidebar = fixture('multi-repo');
    const config = {
      version: 1 as const,
      type: 'multi-repo' as const,
      repos: [],
    };
    const readAllSidebarItems = jest.fn();
    const readWorkspaceWorktrees = jest.fn();
    const readWorkspaceConfig = jest.fn();
    const runtime = createDesktopRuntime({
      workspaceServices: {
        readAllSidebarItems,
        readWorkspaceWorktrees,
        readWorkspaceConfig,
        readEffectiveWorkspaceConfig: jest
          .fn()
          .mockResolvedValue({ repos: [] }),
        readWorkspaceIndexEntry: jest.fn().mockResolvedValue({
          id: 'ws-1',
          name: 'Workspace',
          type: 'multi-repo',
        }),
        readAllSidebarItemsSnapshot: jest.fn().mockResolvedValue({
          file: sidebar,
          authority: 'partial',
          indexAuthority: 'ok',
          indexedWorkspaceIds: ['ws-1'],
          workspaceReads: new Map([['ws-1', { worktrees: 'unreadable' }]]),
        }),
        readWorkspaceConfigDetailed: jest.fn().mockResolvedValue({
          config,
          authority: 'unreadable',
          ownerMalformed: true,
        }),
        readWorkspaceWorktreesDetailed: jest.fn().mockResolvedValue({
          worktrees: [worktree],
          authority: 'unreadable',
        }),
      },
    });

    const listed = await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    const got = await runtime.queryWorkspaceGetForLegacyIpc(
      { workspaceId: 'ws-1' },
      { caller },
    );
    const worktrees = await runtime.queryWorktreeListForLegacyIpc(
      { scope: { workspaceId: 'ws-1' } },
      { caller },
    );
    const allWorktrees = await runtime.queryWorktreeListForLegacyIpc(
      {},
      { caller },
    );

    // The index read alone stays separate from the aggregate, so one
    // unreadable project manifest cannot hide the whole inventory.
    expect(listed).toMatchObject({
      legacyResult: sidebar,
      legacyAuthority: { authority: 'partial', indexAuthority: 'ok' },
    });
    expect(got).toMatchObject({
      legacyResult: config,
      legacyAuthority: { authority: 'unreadable', ownerMalformed: true },
    });
    expect(worktrees).toMatchObject({
      legacyResult: [worktree],
      legacyAuthority: { authority: 'unreadable' },
    });
    expect(allWorktrees).toMatchObject({
      legacyResult: sidebar,
      legacyAuthority: {
        authority: 'partial',
        worktreePreserveWorkspaceIds: ['ws-1'],
      },
    });
    // The authority comes from the same read as the content.
    expect(readAllSidebarItems).not.toHaveBeenCalled();
    expect(readWorkspaceConfig).not.toHaveBeenCalled();
    expect(readWorkspaceWorktrees).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test('legacy projections omit authority when only plain reads exist', async () => {
    const { runtime } = makeRuntime(fixture('single-repo'));
    const listed = await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    expect(listed).not.toHaveProperty('legacyAuthority');
    await runtime.shutdown();
  });

  test.each(['single-repo', 'multi-repo', 'cowork'] as const)(
    '%s list preserves the exact sidebar read',
    async (kind) => {
      const sidebar = fixture(kind);
      const { runtime, reads } = makeRuntime(sidebar);
      const { canonicalResult, legacyResult } =
        await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
      expect(legacyResult).toBe(sidebar);
      expect(reads.readAllSidebarItems).toHaveBeenCalledTimes(1);
      expect(canonicalResult?.items[0]).toMatchObject({
        workspaceId: 'ws-1',
        kind: kind === 'cowork' ? 'cowork' : 'git',
      });
      expect(JSON.stringify(canonicalResult)).not.toContain('/secret/');
      await runtime.shutdown();
    },
  );

  test('workspace get uses source-backed overlay and captures its config', async () => {
    const { runtime, reads } = makeRuntime(fixture('multi-repo'));
    const { canonicalResult, legacyResult } =
      await runtime.queryWorkspaceGetForLegacyIpc(
        { workspaceId: 'ws-1' },
        { caller },
      );
    expect(legacyResult).toEqual({ version: 1, type: 'multi-repo', repos: [] });
    expect(reads.readWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(reads.readEffectiveWorkspaceConfig).toHaveBeenCalledWith(
      'ws-1',
      legacyResult,
    );
    expect(canonicalResult?.repositorySources).toEqual([
      { repoId: 'repo-1', remoteUrl: 'https://example.com/repo.git' },
    ]);
    expect(JSON.stringify(canonicalResult)).not.toContain('/secret/');
    await runtime.shutdown();
  });

  test.each(['/tmp/repo.git', 'file:///tmp/repo.git', 'C:\\repo.git'])(
    'workspace list preserves a local manifest locator %s in the legacy result',
    async (manifestUrl) => {
      const sidebar = fixture('multi-repo');
      if (sidebar.items[0]?.type !== 'multi-repo') throw new Error('fixture');
      sidebar.items[0].repos[0].manifestUrl = manifestUrl;
      const { runtime } = makeRuntime(sidebar);
      const { canonicalResult, legacyResult } =
        await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
      expect(legacyResult).toBe(sidebar);
      expect(canonicalResult?.items[0].repositorySources).toEqual([]);
      await runtime.shutdown();
    },
  );

  test('long manifest locators preserve list and get legacy reads', async () => {
    const manifestUrl = `https://example.com/${'x'.repeat(5_000)}`;
    const sidebar = fixture('multi-repo');
    if (sidebar.items[0]?.type !== 'multi-repo') throw new Error('fixture');
    sidebar.items[0].repos[0].manifestUrl = manifestUrl;
    const { runtime, reads } = makeRuntime(sidebar);
    reads.readEffectiveWorkspaceConfig.mockResolvedValue({
      repos: [{ id: 'repo-1', manifestUrl }],
    });
    const listed = await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    const got = await runtime.queryWorkspaceGetForLegacyIpc(
      { workspaceId: 'ws-1' },
      { caller },
    );
    expect(listed.legacyResult).toBe(sidebar);
    expect(listed.canonicalResult?.items[0].repositorySources).toEqual([]);
    expect(got.legacyResult).toEqual({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    expect(got.canonicalResult?.repositorySources).toEqual([]);
    await runtime.shutdown();
  });

  test('organization scope only lists workspaces owned by that organization', async () => {
    const sidebar = fixture('single-repo');
    const other = fixture('single-repo').items[0];
    other.id = 'ws-2';
    sidebar.items[0].owner = {
      type: 'organization',
      organizationId: 'org-1',
      projectId: 'project-1',
      instanceId: 'instance-1',
      bindingGeneration: 1,
    };
    other.owner = {
      type: 'organization',
      organizationId: 'org-2',
      projectId: 'project-2',
      instanceId: 'instance-2',
      bindingGeneration: 1,
    };
    sidebar.items.push(other);
    const { runtime } = makeRuntime(sidebar);
    const result = await runtime.query(
      'core.workspace.list',
      {
        scope: { organizationId: 'org-1' },
      },
      { caller },
    );
    expect(result.items.map((item) => item.workspaceId)).toEqual(['ws-1']);
    await runtime.shutdown();
  });

  test('workspace get rejects conflicting workspace and organization scope', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.query(
        'core.workspace.get',
        {
          workspaceId: 'ws-1',
          scope: { workspaceId: 'ws-2' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found' },
    });
    reads.readWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repos: [],
    });
    await expect(
      runtime.query(
        'core.workspace.get',
        {
          workspaceId: 'ws-1',
          scope: { organizationId: 'org-1' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found' },
    });
    await runtime.shutdown();
  });

  test('workspace reads reject unrelated scope dimensions', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.query(
        'core.workspace.list',
        {
          scope: { chatId: 'chat-1' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
    expect(reads.readAllSidebarItems).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test.each(['/tmp/repo.git', 'file:///tmp/repo.git', 'C:\\repo.git'])(
    'workspace get preserves a local manifest locator %s in the legacy result',
    async (manifestUrl) => {
      const { runtime, reads } = makeRuntime(fixture('multi-repo'));
      reads.readEffectiveWorkspaceConfig.mockResolvedValue({
        repos: [{ id: 'repo-1', manifestUrl }],
      });
      const { canonicalResult, legacyResult } =
        await runtime.queryWorkspaceGetForLegacyIpc(
          { workspaceId: 'ws-1' },
          { caller },
        );
      expect(legacyResult).toEqual({
        version: 1,
        type: 'multi-repo',
        repos: [],
      });
      expect(canonicalResult?.repositorySources).toEqual([]);
      await runtime.shutdown();
    },
  );

  test.each(['/tmp', 'file://notes', 'N'.repeat(300)])(
    'workspace list accepts the existing display name %s',
    async (name) => {
      const sidebar = fixture('single-repo');
      sidebar.items[0].name = name;
      const { runtime } = makeRuntime(sidebar);
      const { canonicalResult, legacyResult } =
        await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
      expect(legacyResult).toBe(sidebar);
      expect(canonicalResult?.items[0].name).toBe(name);
      await runtime.shutdown();
    },
  );
  test('worktree list and get retain the exact persisted rows', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    const listed = await runtime.queryWorktreeListForLegacyIpc(
      { scope: { workspaceId: 'ws-1' } },
      { caller },
    );
    const got = await runtime.queryWorktreeGetForLegacyIpc(
      { scope: { workspaceId: 'ws-1' }, worktreeId: 'wt-1' },
      { caller },
    );
    expect(listed.legacyResult).toEqual([worktree]);
    expect(got.legacyResult).toBe(worktree);
    expect(listed.canonicalResult?.items[0]).toMatchObject({
      baseBranch: null,
      createdAt: worktree.createdAt,
      state: 'ready',
    });
    expect(JSON.stringify(got.canonicalResult)).not.toContain('/secret/');
    expect(reads.readWorkspaceWorktrees).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });

  test.each(['single-repo', 'multi-repo', 'cowork'] as const)(
    'worktree projections preserve %s sidebar and scoped reads',
    async (kind) => {
      const sidebar = fixture(kind);
      const { runtime, reads } = makeRuntime(sidebar);
      const unscoped = await runtime.queryWorktreeListForLegacyIpc(
        {},
        { caller },
      );
      const scoped = await runtime.queryWorktreeListForLegacyIpc(
        { scope: { workspaceId: 'ws-1' } },
        { caller },
      );
      expect(unscoped.legacyResult).toBe(sidebar);
      expect(scoped.legacyResult).toEqual(kind === 'cowork' ? [] : [worktree]);
      expect(unscoped.canonicalResult?.items).toHaveLength(
        kind === 'cowork' ? 0 : 1,
      );
      expect(JSON.stringify(unscoped.canonicalResult)).not.toContain(
        '/secret/',
      );
      expect(reads.readAllSidebarItems).toHaveBeenCalledTimes(1);
      expect(reads.readWorkspaceWorktrees).toHaveBeenCalledTimes(1);
      await runtime.shutdown();
    },
  );

  test('scoped missing worktree does not read another workspace', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.queryWorktreeGetForLegacyIpc(
        { scope: { workspaceId: 'ws-1' }, worktreeId: 'other' },
        { caller },
      ),
    ).rejects.toThrow();
    expect(reads.readAllSidebarItems).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test('scoped worktree reads reject traversal and unknown workspace IDs before disk access', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    for (const workspaceId of ['../outside', 'ws-2']) {
      if (workspaceId === 'ws-2') {
        reads.readWorkspaceIndexEntry.mockResolvedValue(null);
      }
      await expect(
        runtime.query(
          'core.worktree.list',
          {
            scope: { workspaceId },
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
      await expect(
        runtime.query(
          'core.worktree.get',
          {
            scope: { workspaceId },
            worktreeId: 'wt-1',
          },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    }
    expect(reads.readWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(reads.readWorkspaceConfig).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test('worktree list applies organization and worktree scope', async () => {
    const sidebar = fixture('single-repo');
    const item = sidebar.items[0];
    if (item.type !== 'single-repo') throw new Error('Fixture mismatch');
    item.owner = {
      type: 'organization',
      organizationId: 'org-1',
      projectId: 'project-1',
      instanceId: 'instance-1',
      bindingGeneration: 1,
    };
    item.worktrees.push({ ...worktree, id: 'wt-2' });
    const { runtime, reads } = makeRuntime(sidebar, item.worktrees);
    reads.readWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      owner: item.owner,
      repos: [],
    });

    const matching = await runtime.query(
      'core.worktree.list',
      {
        scope: { organizationId: 'org-1', worktreeId: 'wt-2' },
      },
      { caller },
    );
    expect(matching.items.map((entry) => entry.worktreeId)).toEqual(['wt-2']);

    const mismatched = await runtime.query(
      'core.worktree.list',
      {
        scope: { workspaceId: 'ws-1', organizationId: 'org-2' },
      },
      { caller },
    );
    expect(mismatched.items).toEqual([]);
    await runtime.shutdown();
  });

  test('worktree get rejects conflicting scope and unsupported dimensions', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.query(
        'core.worktree.get',
        {
          worktreeId: 'wt-1',
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-2' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    await expect(
      runtime.query(
        'core.worktree.get',
        {
          worktreeId: 'wt-1',
          scope: { workspaceId: 'ws-1', organizationId: 'org-1' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    await expect(
      runtime.query(
        'core.worktree.list',
        {
          scope: { repoId: 'repo-1' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
    expect(reads.readWorkspaceWorktrees).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test('preserves date-only createdAt in scoped and unscoped reads', async () => {
    const historical: WorktreeData = {
      ...worktree,
      createdAt: '2026-01-01',
    };
    const sidebar = fixture('single-repo');
    const item = sidebar.items[0];
    if (item?.type !== 'single-repo') throw new Error('Fixture mismatch');
    item.worktrees = [historical];
    const { runtime } = makeRuntime(sidebar, [historical]);
    const unscoped = await runtime.queryWorktreeListForLegacyIpc(
      {},
      { caller },
    );
    const scoped = await runtime.queryWorktreeGetForLegacyIpc(
      { scope: { workspaceId: 'ws-1' }, worktreeId: historical.id },
      { caller },
    );
    expect(unscoped.canonicalResult?.items[0]?.createdAt).toBe('2026-01-01');
    expect(scoped.canonicalResult?.createdAt).toBe('2026-01-01');
    expect(scoped.legacyResult).toBe(historical);
    await runtime.shutdown();
  });

  test.each(['/fix', 'C:\\notes', 'file://notes', 'x'.repeat(300)])(
    'worktree display name %s remains readable',
    async (label) => {
      const sidebar = fixture('single-repo');
      const item = sidebar.items[0];
      if (item?.type !== 'single-repo') throw new Error('Fixture mismatch');
      item.worktrees = [{ ...worktree, label }];
      const { runtime } = makeRuntime(sidebar, item.worktrees);
      const listed = await runtime.queryWorktreeListForLegacyIpc(
        {},
        { caller },
      );
      expect(listed.canonicalResult?.items[0]?.name).toBe(label);
      expect(listed.legacyResult).toBe(sidebar);
      await runtime.shutdown();
    },
  );

  test('invalid canonical worktree rows fail the dispatcher op but keep legacy reads', async () => {
    const row: WorktreeData = { ...worktree, branchName: 'b'.repeat(513) };
    const sidebar = fixture('single-repo');
    const item = sidebar.items[0];
    if (item?.type !== 'single-repo') throw new Error('Fixture mismatch');
    item.worktrees = [row];
    const { runtime } = makeRuntime(sidebar, [row]);
    await expect(
      runtime.query('core.worktree.list', {}, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    const listed = await runtime.queryWorktreeListForLegacyIpc({}, { caller });
    const scoped = await runtime.queryWorktreeListForLegacyIpc(
      { scope: { workspaceId: 'ws-1' } },
      { caller },
    );
    const got = await runtime.queryWorktreeGetForLegacyIpc(
      { worktreeId: row.id },
      { caller },
    );
    expect(listed).toEqual({ canonicalResult: null, legacyResult: sidebar });
    expect(listed.legacyResult).toBe(sidebar);
    expect(scoped).toEqual({ canonicalResult: null, legacyResult: [row] });
    expect(got.canonicalResult).toBeNull();
    expect(got.legacyResult).toBe(row);
    await runtime.shutdown();
  });

  test.each([
    ['creating', { setupPhase: 'git-pending' }],
    [
      'error',
      {
        healthIssue: {
          status: 'broken',
          code: 'git-error',
          message: 'Failed',
          checkedAt: worktree.createdAt,
          worktreePath: '/secret/worktree',
        },
      },
    ],
  ] as const)(
    'projects %s from persisted worktree health',
    async (state, changes) => {
      const row: WorktreeData = { ...worktree, ...changes };
      const { runtime } = makeRuntime(fixture('single-repo'), [row]);
      const got = await runtime.queryWorktreeGetForLegacyIpc(
        { scope: { workspaceId: 'ws-1' }, worktreeId: row.id },
        { caller },
      );
      expect(got.canonicalResult?.state).toBe(state);
      await runtime.shutdown();
    },
  );

  test('unscoped get rejects duplicate workspace-local worktree IDs', async () => {
    const first = fixture('single-repo');
    const sidebar: SidebarItemsFile = {
      version: 1,
      items: [
        ...first.items,
        ...first.items.map((item) => ({ ...item, id: 'ws-2' })),
      ],
    };
    const { runtime } = makeRuntime(sidebar);
    await expect(
      runtime.queryWorktreeGetForLegacyIpc({ worktreeId: 'wt-1' }, { caller }),
    ).rejects.toThrow('Workspace scope required');
    await runtime.shutdown();
  });

  test('serialization rejects host paths in canonical extension data', () => {
    expect(
      CoreWorkspaceSchema.safeParse({
        workspaceId: 'ws-1',
        name: 'Workspace',
        kind: 'git',
        repositorySources: [],
        settings: { localPath: '/secret/repo' },
      }).success,
    ).toBe(false);
    expect(
      CoreWorktreeSchema.safeParse({
        worktreeId: 'wt-1',
        workspaceId: 'ws-1',
        name: 'feature',
        state: 'ready',
        baseBranch: null,
        branch: 'feature',
        createdAt: worktree.createdAt,
        hostPath: 'C:\\secret\\repo',
      }).success,
    ).toBe(false);
  });

  test('foreign target selection fails closed', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.query(
        'core.workspace.list',
        { scope: { targetId: 'remote' } },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(reads.readAllSidebarItems).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test.each([
    [
      'https://user:token@github.com/org/repo.git?token=abc#frag',
      'https://github.com/org/repo.git',
    ],
    [
      'ssh://deploy:secret@example.com/org/repo.git',
      'ssh://example.com/org/repo.git',
    ],
    ['git@github.com:org/repo.git', 'git@github.com:org/repo.git'],
  ])(
    'list and get strip credentials from remote %s',
    async (manifestUrl, remoteUrl) => {
      const sidebar = withManifestUrl(manifestUrl);
      const { runtime, reads } = makeRuntime(sidebar);
      reads.readEffectiveWorkspaceConfig.mockResolvedValue({
        repos: [{ id: 'repo-1', manifestUrl }],
      });
      const listed = await runtime.queryWorkspaceListForLegacyIpc(
        {},
        { caller },
      );
      const got = await runtime.queryWorkspaceGetForLegacyIpc(
        { workspaceId: 'ws-1' },
        { caller },
      );
      expect(listed.legacyResult).toBe(sidebar);
      expect(sanitizeRemoteUrl(manifestUrl)).toBe(remoteUrl);
      expect(listed.canonicalResult?.items[0].repositorySources).toEqual([
        { repoId: 'repo-1', remoteUrl },
      ]);
      expect(got.canonicalResult?.repositorySources).toEqual([
        { repoId: 'repo-1', remoteUrl },
      ]);
      await runtime.shutdown();
    },
  );

  test('credential-only scp remotes are omitted from the canonical result', async () => {
    const sidebar = withManifestUrl('deploy@example.com:org/repo.git');
    const { runtime } = makeRuntime(sidebar);
    const { canonicalResult, legacyResult } =
      await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    expect(legacyResult).toBe(sidebar);
    expect(canonicalResult?.items[0].repositorySources).toEqual([]);
    await runtime.shutdown();
  });

  test.each(HOST_PATH_SPELLINGS)(
    'host path spelling %s is detected and kept out of canonical results',
    async (manifestUrl) => {
      expect(hasHostAbsolutePath(manifestUrl)).toBe(true);
      expect(
        CoreWorkspaceSchema.safeParse({
          workspaceId: 'ws-1',
          name: 'Workspace',
          kind: 'git',
          repositorySources: [{ repoId: 'repo-1', remoteUrl: manifestUrl }],
          settings: {},
        }).success,
      ).toBe(false);
      const sidebar = withManifestUrl(manifestUrl);
      const { runtime } = makeRuntime(sidebar);
      const { canonicalResult, legacyResult } =
        await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
      expect(legacyResult).toBe(sidebar);
      expect(canonicalResult?.items[0].repositorySources).toEqual([]);
      await runtime.shutdown();
    },
  );

  test.each(HOST_PATH_SPELLINGS)(
    'workspace id spelled as host path %s is rejected before any read',
    async (workspaceId) => {
      const { runtime, reads } = makeRuntime(fixture('single-repo'));
      await expect(
        runtime.query('core.workspace.get', { workspaceId }, { caller }),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      await expect(
        runtime.query(
          'core.workspace.list',
          { scope: { workspaceId } },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      expect(reads.readWorkspaceIndexEntry).not.toHaveBeenCalled();
      expect(reads.readWorkspaceConfig).not.toHaveBeenCalled();
      expect(reads.readAllSidebarItems).not.toHaveBeenCalled();
      await runtime.shutdown();
    },
  );

  test('overlong repo ids fail the dispatcher op but keep legacy reads', async () => {
    const repoId = 'r'.repeat(513);
    const sidebar = fixture('multi-repo');
    if (sidebar.items[0]?.type !== 'multi-repo') throw new Error('fixture');
    sidebar.items[0].repos[0].id = repoId;
    const { runtime, reads } = makeRuntime(sidebar);
    reads.readEffectiveWorkspaceConfig.mockResolvedValue({
      repos: [{ id: repoId, manifestUrl: 'https://example.com/repo.git' }],
    });
    await expect(
      runtime.query('core.workspace.list', {}, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(
      runtime.query('core.workspace.get', { workspaceId: 'ws-1' }, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    const listed = await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    const got = await runtime.queryWorkspaceGetForLegacyIpc(
      { workspaceId: 'ws-1' },
      { caller },
    );
    expect(listed).toEqual({ canonicalResult: null, legacyResult: sidebar });
    expect(listed.legacyResult).toBe(sidebar);
    expect(got).toEqual({
      canonicalResult: null,
      legacyResult: { version: 1, type: 'multi-repo', repos: [] },
    });
    await runtime.shutdown();
  });

  test('legacy helpers still surface grant failures', async () => {
    const { runtime, reads } = makeRuntime(fixture('single-repo'));
    await expect(
      runtime.queryWorkspaceListForLegacyIpc(
        {},
        { caller: { ...caller, grants: [] } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(reads.readAllSidebarItems).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test.each([undefined, '/tmp/repo.git'])(
    'overlong repo ids fail the dispatcher op even without a publishable remote (%s)',
    async (manifestUrl) => {
      const repoId = 'r'.repeat(513);
      const sidebar = fixture('multi-repo');
      if (sidebar.items[0]?.type !== 'multi-repo') throw new Error('fixture');
      sidebar.items[0].repos[0].id = repoId;
      sidebar.items[0].repos[0].manifestUrl = manifestUrl;
      const { runtime, reads } = makeRuntime(sidebar);
      reads.readEffectiveWorkspaceConfig.mockResolvedValue({
        repos: [{ id: repoId, manifestUrl }],
      });
      await expect(
        runtime.query('core.workspace.list', {}, { caller }),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      await expect(
        runtime.query(
          'core.workspace.get',
          { workspaceId: 'ws-1' },
          { caller },
        ),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      await runtime.shutdown();
    },
  );

  test('a failing source-backed overlay keeps the legacy get read', async () => {
    const { runtime, reads } = makeRuntime(fixture('multi-repo'));
    reads.readEffectiveWorkspaceConfig.mockRejectedValue(
      new Error('malformed source manifest'),
    );
    await expect(
      runtime.query('core.workspace.get', { workspaceId: 'ws-1' }, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    await expect(
      runtime.queryWorkspaceGetForLegacyIpc(
        { workspaceId: 'ws-1' },
        { caller },
      ),
    ).resolves.toEqual({
      canonicalResult: null,
      legacyResult: { version: 1, type: 'multi-repo', repos: [] },
    });
    await runtime.shutdown();
  });

  test('a legacy config read failure still surfaces through the get helper', async () => {
    const { runtime, reads } = makeRuntime(fixture('multi-repo'));
    const failure = new Error('config unreadable');
    reads.readWorkspaceConfig.mockRejectedValue(failure);
    await expect(
      runtime.queryWorkspaceGetForLegacyIpc(
        { workspaceId: 'ws-1' },
        { caller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    expect(reads.readEffectiveWorkspaceConfig).not.toHaveBeenCalled();
    await runtime.shutdown();
  });
});

describe('typed workspace fields (CAN-5373)', () => {
  type Kind = 'single-repo' | 'multi-repo' | 'cowork';
  const indexFields = {
    color: '#7C3AED',
    collapsed: true,
    pinned: true,
    // The index read keeps repeated ids.
    activitySectionOrder: ['cost', 'summary', 'cost', 'notes'],
  };
  const manifestFields = {
    itemSortMode: 'last-updated',
    alwaysShow: false,
    startPage: { kind: 'file', repoId: 'repo-1', path: 'docs/README.md' },
  };
  const stored = {
    color: '#7C3AED',
    pinned: true,
    collapsed: true,
    activitySectionOrder: ['cost', 'summary', 'notes'],
    itemSortMode: 'last-updated',
    alwaysShow: false,
    startPage: { kind: 'file', repoId: 'repo-1', path: 'docs/README.md' },
  };
  const MANIFEST_KEYS = ['itemSortMode', 'alwaysShow', 'startPage'];

  function typedRuntime(
    kind: Kind,
    {
      index = indexFields,
      manifest = manifestFields,
      manifestAuthority = 'ok',
      reportsWorkspaceReads = true,
    }: {
      index?: Record<string, unknown>;
      manifest?: Record<string, unknown>;
      manifestAuthority?: 'ok' | 'absent' | 'unreadable';
      reportsWorkspaceReads?: boolean;
    } = {},
  ): DesktopCanopyDispatcher {
    const item = { ...fixture(kind).items[0], ...index, ...manifest };
    const config = { version: 1, type: kind, repos: [], ...manifest };
    return createDesktopRuntime({
      workspaceServices: {
        readAllSidebarItems: jest.fn(),
        readWorkspaceWorktrees: jest.fn(),
        readWorkspaceConfig: jest.fn(),
        readEffectiveWorkspaceConfig: jest
          .fn()
          .mockResolvedValue({ repos: [] }),
        readWorkspaceIndexEntry: jest.fn().mockResolvedValue({
          id: 'ws-1',
          name: 'Workspace',
          type: kind,
          order: 0,
          ...index,
        }),
        readAllSidebarItemsSnapshot: jest.fn().mockResolvedValue({
          file: { version: 1, items: [item] },
          authority: manifestAuthority,
          indexAuthority: 'ok',
          indexedWorkspaceIds: ['ws-1'],
          ...(reportsWorkspaceReads
            ? {
                workspaceReads: new Map([
                  ['ws-1', { manifest: manifestAuthority, worktrees: 'ok' }],
                ]),
              }
            : {}),
        }),
        readWorkspaceConfigDetailed: jest.fn().mockResolvedValue({
          config,
          authority: manifestAuthority,
          ownerMalformed: false,
        }),
        readWorkspaceWorktreesDetailed: jest
          .fn()
          .mockResolvedValue({ worktrees: [], authority: 'ok' }),
      },
    });
  }

  async function bothReads(
    runtime: DesktopCanopyDispatcher,
  ): Promise<Record<string, unknown>[]> {
    const listed = await runtime.query('core.workspace.list', {}, { caller });
    const got = await runtime.query(
      'core.workspace.get',
      { workspaceId: 'ws-1' },
      { caller },
    );
    await runtime.shutdown();
    if (!listed.items[0]) throw new Error('workspace not listed');
    return [listed.items[0], got];
  }

  test.each(['single-repo', 'multi-repo'] as const)(
    '%s list and get carry the stored update patch fields',
    async (kind) => {
      for (const result of await bothReads(typedRuntime(kind))) {
        expect(result).toMatchObject({ ...stored, settings: {} });
        expect(CoreWorkspaceSchema.safeParse(result).success).toBe(true);
      }
    },
  );

  test.each([
    ['no override', undefined, { kind: 'inherit' }],
    ['a disabled start page', null, null],
    [
      'a URL',
      { kind: 'url', url: 'https://example.com/start' },
      { kind: 'url', url: 'https://example.com/start' },
    ],
    [
      'a file without a repository',
      { kind: 'file', path: 'README.md' },
      { kind: 'file', path: 'README.md' },
    ],
  ])('projects %s as the start page edit', async (_label, startPage, read) => {
    const manifest = { ...manifestFields, startPage };
    for (const result of await bothReads(
      typedRuntime('multi-repo', { manifest }),
    ))
      expect(result.startPage).toEqual(read);
  });

  test('Cowork omits the section order and start page it never keeps', async () => {
    const results = await bothReads(
      typedRuntime('cowork', { index: { ...indexFields, pinned: undefined } }),
    );
    for (const result of results) {
      expect(result).toMatchObject({
        kind: 'cowork',
        color: '#7C3AED',
        pinned: false,
        collapsed: true,
        itemSortMode: 'last-updated',
        alwaysShow: false,
      });
      expect(result).not.toHaveProperty('activitySectionOrder');
      expect(result).not.toHaveProperty('startPage');
    }
  });

  test.each(['absent', 'unreadable'] as const)(
    'an %s manifest withholds its fields instead of reporting defaults',
    async (manifestAuthority) => {
      for (const result of await bothReads(
        typedRuntime('multi-repo', { manifestAuthority }),
      )) {
        for (const key of MANIFEST_KEYS) expect(result).not.toHaveProperty(key);
        expect(result).toMatchObject({
          color: '#7C3AED',
          pinned: true,
          collapsed: true,
          activitySectionOrder: ['cost', 'summary', 'notes'],
        });
      }
    },
  );

  test('a listing that reports no authority for a manifest withholds its fields', async () => {
    const runtime = typedRuntime('multi-repo', {
      reportsWorkspaceReads: false,
    });
    const listed = await runtime.query('core.workspace.list', {}, { caller });
    await runtime.shutdown();
    for (const key of MANIFEST_KEYS)
      expect(listed.items[0]).not.toHaveProperty(key);
    expect(listed.items[0]).toHaveProperty('pinned', true);
  });

  test('every activity section the desktop keeps reads back as stored', async () => {
    const order = [...DEFAULT_ACTIVITY_SECTION_ORDER].reverse();
    for (const result of await bothReads(
      typedRuntime('single-repo', {
        index: { ...indexFields, activitySectionOrder: order },
      }),
    ))
      expect(result.activitySectionOrder).toEqual(order);
  });

  test('a git workspace without a saved order reads the empty default order', async () => {
    for (const result of await bothReads(
      typedRuntime('single-repo', {
        index: { ...indexFields, activitySectionOrder: undefined },
      }),
    ))
      expect(result.activitySectionOrder).toEqual([]);
  });

  test('an unset Always show stays unset', async () => {
    const manifest = { ...manifestFields, alwaysShow: undefined };
    for (const result of await bothReads(
      typedRuntime('multi-repo', { manifest }),
    ))
      expect(result).not.toHaveProperty('alwaysShow');
  });

  test.each([
    ['color', { color: 'blue' }, {}],
    ['color', { color: '#7C3AE' }, {}],
    ['collapsed', { collapsed: 'yes' }, {}],
    ['itemSortMode', {}, { itemSortMode: 'alphabetical' }],
    ['alwaysShow', {}, { alwaysShow: 'yes' }],
    ['startPage', {}, { startPage: { kind: 'file', path: '/etc/passwd' } }],
    ['startPage', {}, { startPage: { kind: 'file', path: '../outside' } }],
    ['startPage', {}, { startPage: { kind: 'file', path: '   ' } }],
    [
      'startPage',
      {},
      { startPage: { kind: 'file', repoId: 'a/b', path: 'README.md' } },
    ],
    ['startPage', {}, { startPage: { kind: 'url', url: 'javascript:x' } }],
    ['startPage', {}, { startPage: { kind: 'url', url: 'HTTPS://x.test' } }],
    [
      'startPage',
      {},
      { startPage: { kind: 'url', url: 'https://x.test/a b' } },
    ],
    [
      'startPage',
      {},
      { startPage: { kind: 'url', url: 'https://x', extra: 1 } },
    ],
    // Valid for the desktop's path rule, but a host path spelling.
    ['startPage', {}, { startPage: { kind: 'file', path: 'file:notes.md' } }],
    // Valid for the desktop's URL rule; the schema would read it trimmed.
    [
      'startPage',
      {},
      { startPage: { kind: 'url', url: ' https://x.test/start\t' } },
    ],
  ])(
    'omits a stored %s outside the patch schema without failing the read',
    async (field, index, manifest) => {
      const results = await bothReads(
        typedRuntime('multi-repo', {
          index: { ...indexFields, ...index },
          manifest: { ...manifestFields, ...manifest },
        }),
      );
      for (const result of results) {
        expect(result).not.toHaveProperty(field);
        expect(result).toHaveProperty('pinned', true);
      }
    },
  );

  test('plain reads project their manifest as read', async () => {
    const { runtime } = makeRuntime(fixture('multi-repo'));
    const [listed, got] = await bothReads(runtime);
    // The fixture's index color `blue` is not a hex color.
    for (const result of [listed, got]) {
      expect(result).not.toHaveProperty('color');
      expect(result).not.toHaveProperty('alwaysShow');
      expect(result).toMatchObject({
        pinned: false,
        activitySectionOrder: [],
        startPage: { kind: 'inherit' },
      });
    }
  });
});

describe('core workspace reads over one W5 read view (CAN-5318)', () => {
  const capture: W5CaptureResult = {
    files: [],
    discovery: 'complete',
    log: {
      commitId: 3,
      retainedCommits: 3,
      unresolvedCommits: 0,
      schemaVersion: 2,
      revisions: {},
      files: [],
      chains: [],
      resourceRevisionEligibility: 'unproven',
    },
  };
  const notCaptured = { status: 'unverified', reason: 'not-captured' };
  const second: WorktreeData = { ...worktree, id: 'wt-2' };

  function viewRuntime(
    outcome: W5ReadViewOutcome = {
      status: 'captured',
      capture,
      uncapturedReads: [],
    },
  ): DesktopCanopyDispatcher {
    const sidebar = fixture('multi-repo');
    const item = sidebar.items[0];
    if (item?.type !== 'multi-repo') throw new Error('fixture');
    item.worktrees = [worktree, second];
    return createDesktopRuntime({
      workspaceServices: {
        readAllSidebarItems: jest.fn(),
        readWorkspaceWorktrees: jest.fn(),
        readWorkspaceConfig: jest.fn().mockResolvedValue({
          version: 1,
          type: 'multi-repo',
          repos: [],
          owner: { kind: 'organization', organizationId: 'org-1' },
        }),
        readEffectiveWorkspaceConfig: jest
          .fn()
          .mockResolvedValue({ repos: [] }),
        readWorkspaceIndexEntry: jest.fn().mockResolvedValue({
          id: 'ws-1',
          name: 'Workspace',
          type: 'multi-repo',
        }),
        // One project's list lowers the aggregate, not the index.
        readAllSidebarItemsSnapshot: jest.fn().mockResolvedValue({
          file: sidebar,
          authority: 'partial',
          indexAuthority: 'ok',
          indexedWorkspaceIds: ['ws-1'],
          workspaceReads: new Map([
            ['ws-1', { manifest: 'ok', worktrees: 'partial' }],
          ]),
        }),
        readWorkspaceConfigDetailed: jest.fn().mockResolvedValue({
          config: {
            version: 1,
            type: 'multi-repo',
            repos: [],
            sourceRepoPath: '/secret/source',
          },
          authority: 'ok',
          ownerMalformed: false,
        }),
        readWorkspaceWorktreesDetailed: jest.fn().mockResolvedValue({
          worktrees: [worktree, second],
          authority: 'ok',
          recentlyRemovedWorktreeIds: ['wt-gone'],
        }),
        readView: (_request, work) => work(outcome),
      },
    });
  }

  test('keeps workspace and worktree-list completeness apart from the aggregate authority', async () => {
    const runtime = viewRuntime();
    const workspaces = await runtime.queryWorkspaceListForLegacyIpc(
      {},
      { caller },
    );
    expect(workspaces.legacyAuthority).toMatchObject({
      authority: 'partial',
      provenance: {
        result: { completeness: 'complete', filters: [] },
        resources: [
          { resource: { kind: 'workspaces' }, completeness: 'complete' },
          {
            resource: { kind: 'workspace', workspaceId: 'ws-1' },
            completeness: 'complete',
            external: ['repositorySources'],
          },
        ],
      },
    });
    const worktrees = await runtime.queryWorktreeListForLegacyIpc(
      {},
      { caller },
    );
    expect(worktrees.legacyAuthority?.provenance).toMatchObject({
      result: { completeness: 'partial', filters: ['unreadable-entries'] },
      resources: [
        {
          resource: { kind: 'worktrees', workspaceId: 'ws-1' },
          completeness: 'partial',
          filters: ['unreadable-entries'],
        },
        { resource: { worktreeId: 'wt-1' }, completeness: 'complete' },
        { resource: { worktreeId: 'wt-2' }, completeness: 'complete' },
      ],
    });
    const got = await runtime.queryWorkspaceGetForLegacyIpc(
      { workspaceId: 'ws-1' },
      { caller },
    );
    expect(got.legacyAuthority?.provenance?.resources).toEqual([
      {
        resource: { kind: 'workspace', workspaceId: 'ws-1' },
        completeness: 'complete',
        filters: [],
        external: ['repositorySources'],
        eligibility: notCaptured,
      },
    ]);
    await runtime.shutdown();
  });

  test('records scope, organization, removal and page filtering explicitly', async () => {
    const runtime = viewRuntime();
    const listed = await runtime.queryWorktreeListForLegacyIpc(
      { scope: { workspaceId: 'ws-1' }, pageSize: 1 },
      { caller },
    );
    expect(listed.canonicalResult?.nextCursor).toMatch(/^[\w-]{32}$/);
    // Removal filtering keeps the list's authority and is named instead.
    expect(listed.legacyAuthority).toMatchObject({ authority: 'ok' });
    // Paging a pinned listing filters the result, not the collection.
    expect(listed.legacyAuthority?.provenance?.result.filters).toEqual([
      'recently-removed',
      'page',
    ]);
    expect(listed.legacyAuthority?.provenance?.resources[0]).toEqual({
      resource: { kind: 'worktrees', workspaceId: 'ws-1' },
      completeness: 'partial',
      filters: ['recently-removed'],
      external: [],
      eligibility: notCaptured,
    });
    const filtered = await runtime.queryWorktreeListForLegacyIpc(
      {
        scope: {
          workspaceId: 'ws-1',
          worktreeId: 'wt-2',
          organizationId: 'org-1',
        },
      },
      { caller },
    );
    expect(
      filtered.canonicalResult?.items.map((row) => row.worktreeId),
    ).toEqual(['wt-2']);
    expect(filtered.legacyAuthority?.provenance?.result.filters).toEqual([
      'worktree-scope',
      'organization',
      'recently-removed',
    ]);
    const workspaces = await runtime.queryWorkspaceListForLegacyIpc(
      { scope: { organizationId: 'org-2' } },
      { caller },
    );
    expect(workspaces.legacyAuthority?.provenance?.resources).toEqual([
      expect.objectContaining({
        resource: { kind: 'workspaces' },
        completeness: 'partial',
        filters: ['organization'],
      }),
    ]);
    await runtime.shutdown();
  });

  test('an uncaptured read labels nothing and says why', async () => {
    const runtime = viewRuntime({
      status: 'uncaptured',
      reason: 'unsupported-platform',
    });
    const listed = await runtime.queryWorkspaceListForLegacyIpc({}, { caller });
    expect(listed.legacyAuthority?.provenance).toMatchObject({
      position: { status: 'uncaptured', reason: 'unsupported-platform' },
      files: [],
    });
    expect(
      listed.legacyAuthority?.provenance?.resources.map(
        (resource) => resource.eligibility,
      ),
    ).toEqual([notCaptured, notCaptured]);
    // A live fallback publishes no revision of any kind.
    expect(listed.canonicalResult).not.toHaveProperty('collectionRevision');
    expect(listed.canonicalResult?.items[0]).not.toHaveProperty('revision');
    await runtime.shutdown();
  });
});

describe('list continuation over pinned snapshots (CAN-5319)', () => {
  const base = fixture('multi-repo').items[0];
  function workspaceItem(
    id: string,
    name = id,
    manifestUrl = `https://example.com/${id}.git`,
  ): SidebarItemsFile['items'][number] {
    if (base?.type !== 'multi-repo') throw new Error('fixture');
    return {
      ...base,
      id,
      name,
      repos: [
        { id: `${id}-repo`, name, repoPath: '/secret/repo', manifestUrl },
      ],
    };
  }
  const row = (id: string, branchName = id): WorktreeData => ({
    ...worktree,
    id,
    branchName,
  });
  const refused = (kind: string): { payload: { kind: string } } => ({
    payload: { kind },
  });
  let sidebar: SidebarItemsFile;
  let rows: WorktreeData[];
  const reads = {
    readAllSidebarItemsSnapshot: jest.fn(),
    readWorkspaceWorktreesDetailed: jest.fn(),
  };
  const services = (): CoreWorkspaceReadServices => ({
    readAllSidebarItems: jest.fn(),
    readWorkspaceWorktrees: jest.fn(),
    readWorkspaceConfig: jest.fn(),
    readEffectiveWorkspaceConfig: jest.fn().mockResolvedValue({ repos: [] }),
    readWorkspaceIndexEntry: jest
      .fn()
      .mockResolvedValue({ id: 'ws-1', name: 'Workspace', type: 'multi-repo' }),
    ...reads,
  });
  beforeEach(() => {
    sidebar = {
      version: 1,
      items: ['ws-1', 'ws-2', 'ws-3'].map((id) => workspaceItem(id)),
    };
    rows = ['wt-1', 'wt-2', 'wt-3'].map((id) => row(id));
    reads.readAllSidebarItemsSnapshot.mockReset().mockImplementation(() =>
      Promise.resolve({
        file: sidebar,
        authority: 'ok',
        indexAuthority: 'ok',
      }),
    );
    reads.readWorkspaceWorktreesDetailed
      .mockReset()
      .mockImplementation(() =>
        Promise.resolve({ worktrees: rows, authority: 'ok' }),
      );
  });
  function cursorOf(result: { nextCursor: string | null } | null): string {
    if (!result?.nextCursor) throw new Error('expected a continuation');
    return result.nextCursor;
  }

  test('serves later pages from the first page whatever changes between them', async () => {
    const runtime = createDesktopRuntime({ workspaceServices: services() });
    const first = await runtime.query(
      'core.workspace.list',
      { pageSize: 1 },
      { caller },
    );
    expect(first.items.map((item) => item.workspaceId)).toEqual(['ws-1']);
    const second = cursorOf(first);
    // Insert, remove, reorder, rename and a source-overlay change at once.
    sidebar = {
      version: 1,
      items: [
        workspaceItem('ws-0'),
        workspaceItem('ws-2', 'Renamed', 'https://example.com/moved.git'),
        workspaceItem('ws-1'),
      ],
    };
    const page = await runtime.query(
      'core.workspace.list',
      { pageSize: 1, cursor: second },
      { caller },
    );
    expect(page.items).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-2',
        name: 'ws-2',
        repositorySources: [
          { repoId: 'ws-2-repo', remoteUrl: 'https://example.com/ws-2.git' },
        ],
      }),
    ]);
    // A replay serves the same page and names the same next page.
    await expect(
      runtime.query(
        'core.workspace.list',
        { pageSize: 1, cursor: second },
        { caller },
      ),
    ).resolves.toEqual(page);
    const last = await runtime.query(
      'core.workspace.list',
      { pageSize: 1, cursor: cursorOf(page) },
      { caller },
    );
    expect(last).toEqual({
      items: [expect.objectContaining({ workspaceId: 'ws-3' })],
      nextCursor: null,
    });
    expect(reads.readAllSidebarItemsSnapshot).toHaveBeenCalledTimes(1);
    const fresh = await runtime.query(
      'core.workspace.list',
      { pageSize: 5 },
      { caller },
    );
    expect(fresh.items.map((item) => item.name)).toEqual([
      'ws-0',
      'Renamed',
      'ws-1',
    ]);
    await runtime.shutdown();
  });

  test('pins a scoped worktree list across row changes', async () => {
    const runtime = createDesktopRuntime({ workspaceServices: services() });
    const scope = { workspaceId: 'ws-1' };
    const first = await runtime.query(
      'core.worktree.list',
      { scope, pageSize: 2 },
      { caller },
    );
    rows = [row('wt-0'), row('wt-3', 'renamed'), row('wt-1')];
    const page = await runtime.query(
      'core.worktree.list',
      { scope, pageSize: 2, cursor: cursorOf(first) },
      { caller },
    );
    expect(page).toEqual({
      items: [expect.objectContaining({ worktreeId: 'wt-3', branch: 'wt-3' })],
      nextCursor: null,
    });
    expect(reads.readWorkspaceWorktreesDetailed).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });

  test('legacy wrappers republish the pinned legacy capture and its authority', async () => {
    const runtime = createDesktopRuntime({ workspaceServices: services() });
    const original = structuredClone(sidebar);
    const first = await runtime.queryWorkspaceListForLegacyIpc(
      { pageSize: 1 },
      { caller },
    );
    sidebar = { version: 1, items: [workspaceItem('ws-9')] };
    const next = await runtime.queryWorkspaceListForLegacyIpc(
      { pageSize: 1, cursor: cursorOf(first.canonicalResult) },
      { caller },
    );
    expect(next.legacyResult).toEqual(original);
    expect(next.legacyResult).not.toBe(first.legacyResult);
    expect(next.legacyAuthority).toEqual(first.legacyAuthority);
    expect(next.canonicalResult?.items.map((item) => item.workspaceId)).toEqual(
      ['ws-2'],
    );

    const scoped = await runtime.queryWorktreeListForLegacyIpc(
      { scope: { workspaceId: 'ws-1' }, pageSize: 1 },
      { caller },
    );
    const originalRows = structuredClone(rows);
    rows = [];
    const scopedNext = await runtime.queryWorktreeListForLegacyIpc(
      {
        scope: { workspaceId: 'ws-1' },
        pageSize: 1,
        cursor: cursorOf(scoped.canonicalResult),
      },
      { caller },
    );
    expect(scopedNext.legacyResult).toEqual(originalRows);
    expect(scopedNext.legacyAuthority).toEqual(scoped.legacyAuthority);
    await runtime.shutdown();
  });

  test('refused cursors reach legacy callers instead of a legacy fallback', async () => {
    const runtime = createDesktopRuntime({ workspaceServices: services() });
    const first = await runtime.query(
      'core.workspace.list',
      { pageSize: 1 },
      { caller },
    );
    reads.readAllSidebarItemsSnapshot.mockClear();
    const cursor = cursorOf(first);
    const cases: [CanopyQueryParams<'core.workspace.list'>, string][] = [
      // An old numeric offset is refused, never read as a fresh offset.
      [{ pageSize: 1, cursor: '1' }, 'invalid_argument'],
      [{ pageSize: 1, cursor: 'not-a-cursor' }, 'invalid_argument'],
      [{ pageSize: 1, cursor: 'A'.repeat(32) }, 'failed_precondition'],
      [{ pageSize: 2, cursor }, 'invalid_argument'],
      [
        { pageSize: 1, cursor, scope: { organizationId: 'org-1' } },
        'invalid_argument',
      ],
    ];
    for (const [params, kind] of cases) {
      await expect(
        runtime.query('core.workspace.list', params, { caller }),
      ).rejects.toMatchObject(refused(kind));
      await expect(
        runtime.queryWorkspaceListForLegacyIpc(params, { caller }),
      ).rejects.toMatchObject(refused(kind));
    }
    // Another operation's cursor is another listing.
    await expect(
      runtime.queryWorktreeListForLegacyIpc(
        { pageSize: 1, cursor },
        { caller },
      ),
    ).rejects.toMatchObject(refused('invalid_argument'));
    expect(reads.readAllSidebarItemsSnapshot).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  test('rechecks grants and the caller on every page', async () => {
    const runtime = createDesktopRuntime({ workspaceServices: services() });
    const cursor = cursorOf(
      await runtime.query('core.workspace.list', { pageSize: 1 }, { caller }),
    );
    await expect(
      runtime.query(
        'core.workspace.list',
        { pageSize: 1, cursor },
        { caller: { ...caller, grants: [] } },
      ),
    ).rejects.toMatchObject(refused('permission_denied'));
    await expect(
      runtime.queryWorkspaceListForLegacyIpc(
        { pageSize: 1, cursor },
        { caller: { ...caller, clientInstanceId: 'another-client' } },
      ),
    ).rejects.toMatchObject(refused('failed_precondition'));
    await expect(
      runtime.query('core.workspace.list', { pageSize: 1, cursor }, { caller }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ workspaceId: 'ws-2' })],
    });
    await runtime.shutdown();
  });

  test('a cursor ends with the runtime that issued it', async () => {
    const issuing = createDesktopRuntime({ workspaceServices: services() });
    const cursor = cursorOf(
      await issuing.query('core.workspace.list', { pageSize: 1 }, { caller }),
    );
    await issuing.shutdown();
    const restarted = createDesktopRuntime({ workspaceServices: services() });
    await expect(
      restarted.query(
        'core.workspace.list',
        { pageSize: 1, cursor },
        { caller },
      ),
    ).rejects.toMatchObject(refused('failed_precondition'));
    await restarted.shutdown();
  });

  test('a listing too large to retain fails, but keeps the legacy read', async () => {
    const runtime = createDesktopRuntime({
      workspaceServices: services(),
      workspaceReadSnapshotLimits: {
        ...CORE_READ_SNAPSHOT_LIMITS,
        maxBytes: 1,
      },
    });
    await expect(
      runtime.query('core.workspace.list', { pageSize: 1 }, { caller }),
    ).rejects.toMatchObject(refused('resource_exhausted'));
    const legacy = await runtime.queryWorkspaceListForLegacyIpc(
      { pageSize: 1 },
      { caller },
    );
    expect(legacy).toMatchObject({ canonicalResult: null });
    expect(legacy.legacyResult).toBe(sidebar);
    // A single page retains nothing, so it is never refused.
    await expect(
      runtime.query('core.workspace.list', { pageSize: 3 }, { caller }),
    ).resolves.toMatchObject({ nextCursor: null });
    await runtime.shutdown();
  });

  test('an evicted listing is refused, never rebuilt from live reads', async () => {
    const adapter = createCoreWorkspaceAdapter(
      services(),
      undefined,
      createCoreWorkspaceReadSnapshots({
        ...CORE_READ_SNAPSHOT_LIMITS,
        maxSnapshots: 1,
      }),
    );
    const first = await adapter['core.workspace.list'](
      { pageSize: 1 },
      undefined,
    );
    await adapter['core.worktree.list'](
      { scope: { workspaceId: 'ws-1' }, pageSize: 1 },
      undefined,
    );
    reads.readAllSidebarItemsSnapshot.mockClear();
    await expect(
      adapter['core.workspace.list'](
        { pageSize: 1, cursor: cursorOf(first) },
        undefined,
      ),
    ).rejects.toMatchObject(refused('failed_precondition'));
    expect(reads.readAllSidebarItemsSnapshot).not.toHaveBeenCalled();
  });
});

describe('unreadable workspace index (CAN-5565)', () => {
  const realSidebar = jest.requireActual<typeof SidebarModule>(
    '../../lib/sidebar-items',
  );
  const fileStore = jest.requireActual<typeof W5FileStoreModule>(
    '../../lib/w5-commit-log-file-store',
  );
  let indexState: 'unreadable' | 'absent';
  let runtime: DesktopCanopyDispatcher;

  beforeEach(() => {
    indexState = 'unreadable';
    fileStore.__setDesktopW5FileStoreForTests({
      read: () => Promise.resolve({ state: indexState }),
      replace: () => Promise.reject(new Error('Read must not write')),
      remove: () => Promise.reject(new Error('Read must not write')),
    });
    runtime = createDesktopRuntime({
      workspaceServices: {
        ...makeRuntime(fixture('single-repo')).reads,
        readWorkspaceIndexEntry: realSidebar.readWorkspaceIndexEntry,
        readWorkspaceIndexEntryDetailed:
          realSidebar.readWorkspaceIndexEntryDetailed,
      },
    });
  });

  afterEach(() => fileStore.__setDesktopW5FileStoreForTests(undefined));

  it.each([
    'core.workspace.get',
    'core.worktree.list',
    'core.worktree.get',
  ] as const)(
    '%s refuses an unreadable index instead of proving absence',
    async (operation) => {
      const params = {
        scope: { workspaceId: 'ws-1' },
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
      };
      // Each operation's schema rejects unrelated keys.
      const read =
        operation === 'core.workspace.get'
          ? runtime.query(
              operation,
              { workspaceId: params.workspaceId },
              { caller },
            )
          : operation === 'core.worktree.list'
            ? runtime.query(operation, { scope: params.scope }, { caller })
            : runtime.query(
                operation,
                { scope: params.scope, worktreeId: params.worktreeId },
                { caller },
              );
      await expect(read).rejects.toMatchObject({
        payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
      });
    },
  );

  it('still reports not found for an authoritatively absent index', async () => {
    indexState = 'absent';
    await expect(
      runtime.query('core.workspace.get', { workspaceId: 'ws-1' }, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
  });
});
