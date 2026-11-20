/** @jest-environment jsdom */
import './jsdom-globals';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { CoreCoworkInvoker } from '@canopy/app-state/core-cowork';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  createCloudSidebarTask,
  useCloudCoworkSidebar,
  type CloudCoworkSidebarModel,
} from '../useCloudCoworkSidebar';
// eslint-disable-next-line no-restricted-imports
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';
import type { CanopyCapabilities, SessionViewModel } from '@canopy/app-core';
import { appendCloudSidebarRows } from '../append-cloud-sidebar-rows';
import { batchActionAvailability } from '@canopy/ui-app/code/shell/sidebar-selection-menu-items';
import { cloudSidebarRowCapabilities } from '../cloud-sidebar-capabilities';
import { routeSidebarReorder } from '../route-sidebar-reorder';
import {
  shouldPrefetchWorktreeChat,
  sidebarRowPrefetchTarget,
} from '../cloud-sidebar-intent';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { CoreCoworkOutcomeUnknownError } from '@canopy/app-state/core-cowork';
import type { CanopyCoreRelayApi } from '../../../../shared/canopy-core-relay';
import {
  archiveCloudTask,
  CLOUD_TASK_ARCHIVE_FAILED,
  cloudTaskArchiveFailure,
  deleteCloudTask,
} from '../archive-cloud-task';
import { cloudCoworkStore } from '../cloud-cowork-store';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  loadWebCoreServedOperations,
  readWebCoreServedOperationsOnline,
  resetWebCoreServedOperations,
  retryWebCoreServedOperations,
  webCoreServedOperationsFailed,
  webCoreServedOperationsKnown,
  webCoreServesTaskDelete,
} from '@/lib/web-core-served-operations';

const DESKTOP: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: true,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
  workspaceReordering: true,
  worktreeReordering: true,
  itemGrouping: true,
  worktreePinning: true,
  workspaceSettings: 'full',
  workspaceRemoval: 'archive',
  worktreeRemoval: 'archive',
  worktreeRetention: 'archive-or-delete',
  workspaceMoveToOrganization: true,
  worktreeCreation: true,
  worktreeMetadata: true,
  projectDeletionDiscard: true,
  worktreeDiscard: true,
};

/** Reads a manifest that lists `core.chat.delete` as served (CAN-7052). */
async function serveTaskDelete(): Promise<void> {
  resetWebCoreServedOperations();
  const relay = {
    invoke: jest.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          runtime: {
            runtimeId: 'web-core',
            hostId: 'web',
            authorityId: null,
            profile: 'core',
            daemonEpoch: 'e1',
            protocolVersions: [1],
            state: 'ready',
          },
          operations: [
            {
              name: 'core.chat.delete',
              kind: 'instruction',
              version: 1,
              placement: 'core-only',
              requiredGrants: ['core.chat.write'],
              available: true,
            },
          ],
          generatedAt: '2026-11-17T10:00:00.000Z',
        },
      }),
    ),
  };
  loadWebCoreServedOperations(() => relay);
  // The read settles with its reply, then lands one tick later.
  await relay.invoke.mock.results[0]?.value;
  await Promise.resolve();
}

/** A local single-repo project with one worktree, as the projects store holds it. */
const LOCAL_PROJECT: SingleRepoSidebarItem = {
  type: 'single-repo',
  id: 'local-p',
  name: 'Local',
  repoPath: '/repo',
  color: '#3B82F6',
  collapsed: false,
  order: 0,
  worktrees: [],
};
const LOCAL_WORKTREE = {
  id: 'wt-1',
  branchName: 'feature',
  createdAt: '2026-11-17T00:00:00Z',
};

describe('cloud projects in the shared desktop sidebar (CAN-6099)', () => {
  it('appends cloud projects after every local project, in their own order', () => {
    const local: Pick<SessionViewModel, 'workspaces' | 'worktrees'> = {
      workspaces: [
        { localId: 'local-a', name: 'A', type: 'cowork', order: 3 },
        { localId: 'local-b', name: 'B', type: 'single-repo', order: 7 },
      ],
      worktrees: [
        { localId: 'wt', workspaceLocalId: 'local-b', branch: 'main' },
      ],
    };
    const merged = appendCloudSidebarRows(local, {
      workspaces: [
        { localId: 'web-core:p1', name: 'P1', type: 'cowork', order: 0 },
        { localId: 'web-core:p2', name: 'P2', type: 'cowork', order: 1 },
      ],
      worktrees: [
        {
          localId: 'web-core:t1',
          workspaceLocalId: 'web-core:p1',
          branch: 'cloud',
        },
      ],
    });
    expect(
      merged.workspaces.map((workspace) => [
        workspace.localId,
        workspace.order,
      ]),
    ).toEqual([
      ['local-a', 3],
      ['local-b', 7],
      ['web-core:p1', 8],
      ['web-core:p2', 9],
    ]);
    expect(merged.worktrees.map((worktree) => worktree.localId)).toEqual([
      'wt',
      'web-core:t1',
    ]);
  });

  it('withholds every local affordance from a cloud row', () => {
    for (const kind of ['cowork', 'git', 'task'] as const) {
      expect(cloudSidebarRowCapabilities(DESKTOP, kind)).toMatchObject({
        localExecution: false,
        terminalPty: false,
        fileSystemAccess: 'none',
        worktreeReordering: false,
        itemGrouping: false,
        worktreePinning: false,
        workspaceMoveToOrganization: false,
        worktreeMetadata: false,
        projectDeletionDiscard: false,
        worktreeDiscard: false,
      });
    }
    expect(cloudSidebarRowCapabilities(DESKTOP, 'cowork')).toMatchObject({
      worktreeCreation: true,
      workspaceReordering: true,
    });
    expect(cloudSidebarRowCapabilities(DESKTOP, 'git')).toMatchObject({
      workspaceReordering: true,
    });
    expect(cloudSidebarRowCapabilities(DESKTOP, 'task')).toMatchObject({
      workspaceReordering: false,
      workspaceSettings: false,
      workspaceRemoval: false,
      // A task archives through the web core, which keeps it restorable
      // (CAN-6511); a project's rows never remove a worktree.
      worktreeRemoval: 'archive',
    });
    for (const kind of ['cowork', 'git'] as const)
      expect(cloudSidebarRowCapabilities(DESKTOP, kind)).toMatchObject({
        worktreeRemoval: false,
      });
    // A cloud task is never deleted from here, alone or in a selection
    // (CAN-6511).
    const task = cloudSidebarRowCapabilities(DESKTOP, 'task');
    expect(task).not.toHaveProperty('worktreeRetention');
    const selected = batchActionAvailability(
      [
        { removal: task.worktreeRemoval, retention: task.worktreeRetention },
        { removal: task.worktreeRemoval, retention: task.worktreeRetention },
      ],
      { singular: 'task', plural: 'tasks' },
    );
    expect(selected.archive).toMatchObject({ enabled: true, count: 2 });
    expect(selected.delete).toMatchObject({ enabled: false, offered: false });
    // A project's settings are its name, colour and delete to Trash.
    for (const kind of ['cowork', 'git'] as const)
      expect(cloudSidebarRowCapabilities(DESKTOP, kind)).toMatchObject({
        workspaceSettings: 'details',
        workspaceRemoval: 'delete',
      });
    expect(cloudSidebarRowCapabilities(DESKTOP, 'cowork')).not.toHaveProperty(
      'workspaceContents',
    );
    expect(cloudSidebarRowCapabilities(DESKTOP, 'git')).toMatchObject({
      worktreeCreation: false,
      workspaceContents: false,
    });
  });

  it('a cloud task offers Delete beside Archive only while the web core serves it, and no project row does (CAN-7052)', () => {
    // Archive only: the web core doesn't serve the delete, or cloud chats
    // are offline.
    for (const options of [{}, { taskDelete: false }]) {
      const task = cloudSidebarRowCapabilities(DESKTOP, 'task', options);
      expect(task).not.toHaveProperty('worktreeRetention');
      expect(task.worktreeRemoval).toBe('archive');
      const selected = batchActionAvailability(
        [{ removal: task.worktreeRemoval, retention: task.worktreeRetention }],
        { singular: 'task', plural: 'tasks' },
      );
      expect(selected.delete).toMatchObject({ enabled: false, offered: false });
    }
    // Served: Archive and Delete, alone and in a selection.
    const task = cloudSidebarRowCapabilities(DESKTOP, 'task', {
      taskDelete: true,
    });
    expect(task).toMatchObject({
      worktreeRemoval: 'archive',
      worktreeRetention: 'archive-or-delete',
    });
    const selected = batchActionAvailability(
      [
        { removal: task.worktreeRemoval, retention: task.worktreeRetention },
        { removal: task.worktreeRemoval, retention: task.worktreeRetention },
      ],
      { singular: 'task', plural: 'tasks' },
    );
    expect(selected.archive).toMatchObject({ enabled: true, count: 2 });
    expect(selected.delete).toMatchObject({ enabled: true, count: 2 });
    // A project's rows never take the task's Delete.
    for (const kind of ['cowork', 'git'] as const)
      expect(
        cloudSidebarRowCapabilities(DESKTOP, kind, { taskDelete: true }),
      ).not.toHaveProperty('worktreeRetention');
  });

  it('deleting a cloud task sends nothing unless the web core serves it, and then deletes it to the Trash (CAN-7052)', async () => {
    const deleteTask = jest.fn((): Promise<void> => Promise.resolve());
    const archiveTask = jest.fn((): Promise<void> => Promise.resolve());
    // The project's More row re-reads its archived tasks after a removal.
    const listArchivedTasks = jest.fn(() => Promise.resolve([]));
    cloudCoworkStore.setState({ deleteTask, archiveTask, listArchivedTasks });
    resetWebCoreServedOperations();

    // No manifest read, or one that doesn't list the delete: refused here.
    await expect(deleteCloudTask('web-core:p1', 'web-core:t1')).rejects.toThrow(
      'Deleting a cloud task is not available.',
    );
    expect(deleteTask).not.toHaveBeenCalled();
    // A local id is never sent either.
    await expect(deleteCloudTask('local', 'entry')).rejects.toThrow(
      'Not a cloud task.',
    );

    await serveTaskDelete();
    expect(webCoreServesTaskDelete()).toBe(true);

    await deleteCloudTask('web-core:p1', 'web-core:t1');
    expect(deleteTask).toHaveBeenCalledWith('p1', 't1');
    expect(archiveTask).not.toHaveBeenCalled();
    resetWebCoreServedOperations();
  });

  it("an archive that may have landed, which no listing settled, says it couldn't confirm it, never that it failed, and keeps the task open (CAN-7196)", async () => {
    const unknown = new CoreCoworkOutcomeUnknownError(
      "Couldn't confirm the task was archived. The list will show where it stands.",
    );
    const archiveTask = jest.fn((): Promise<void> => Promise.reject(unknown));
    const listArchivedTasks = jest.fn(() => Promise.resolve([]));
    cloudCoworkStore.setState({ archiveTask, listArchivedTasks });

    const failure = await archiveCloudTask('web-core:p1', 'web-core:t1').catch(
      (error: unknown) => error,
    );
    expect(failure).toBe(unknown);
    expect(archiveTask).toHaveBeenCalledTimes(1);
    // Not left as if archived: the archived list isn't read for it.
    expect(listArchivedTasks).not.toHaveBeenCalled();
    expect(cloudTaskArchiveFailure(failure)).toBe(
      "Couldn't confirm the task was archived. The list will show where it stands.",
    );
    // A refusal still says it wasn't archived.
    expect(cloudTaskArchiveFailure(new Error('Refused.'))).toBe(
      CLOUD_TASK_ARCHIVE_FAILED,
    );
  });

  it('a cloud task is deleted only from the sidebar host (CAN-7052)', () => {
    // The store defines deleteTask, the helper defines deleteCloudTask and
    // calls it once, and only the shared sidebar host's cloud branches call
    // the helper. No other desktop module or shared package names either;
    // the web's own golden checks its sources (chat-delete.test.ts).
    const root = path.resolve(__dirname, '../../../../../../..');
    const sourceFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
          return /^(__|node_modules$|out$|dist$|generated$)/.test(entry.name)
            ? []
            : sourceFiles(full);
        return /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [full] : [];
      });
    const sourceDirs = [
      path.join(root, 'apps/desktop-app/src'),
      ...readdirSync(path.join(root, 'packages'))
        .map((name) => path.join(root, 'packages', name, 'src'))
        .filter((dir) => existsSync(dir)),
    ];
    const naming = (pattern: RegExp): string[] =>
      sourceDirs
        .flatMap(sourceFiles)
        .filter((file) => pattern.test(readFileSync(file, 'utf8')))
        .map((file) => path.relative(root, file))
        .sort();
    const HELPER =
      'apps/desktop-app/src/renderer/src/cloud-chats/archive-cloud-task.ts';
    const HOST =
      'apps/desktop-app/src/renderer/src/components/sidebar/DesktopSharedSidebarHost.tsx';
    expect(naming(/\b(deleteTask|deleteCloudTask)\b/)).toEqual([
      HELPER,
      HOST,
      'packages/app-state/src/core-cowork/create-core-cowork-store.ts',
    ]);
    const helper = readFileSync(path.join(root, HELPER), 'utf8');
    expect(helper.match(/\bdeleteCloudTask\b/g)).toHaveLength(1);
    expect(helper.match(/\.deleteTask\(/g)).toHaveLength(1);
    // Only the host tells a row it may delete, from the cloud hook's flag.
    expect(naming(/\btaskDelete\s*:/)).toEqual([
      'apps/desktop-app/src/renderer/src/cloud-chats/useCloudCoworkSidebar.ts',
      HOST,
    ]);
  });

  it("a local row's menu keeps exactly develop's items: only cloud rows take Delete from the cloud allowlist (CAN-7052)", () => {
    // The host filters a row's menu inline (DesktopSharedSidebarHost.tsx):
    // a store worktree keeps every item, another local row keeps only the
    // non-store keys, and only a web core row reads the cloud keys. These are
    // develop's lines byte for byte; part 1b adds 'delete' to the cloud keys
    // alone.
    const root = path.resolve(__dirname, '../../../../../../..');
    const host = readFileSync(
      path.join(
        root,
        'apps/desktop-app/src/renderer/src/components/sidebar/DesktopSharedSidebarHost.tsx',
      ),
      'utf8',
    );
    expect(host).toContain(
      [
        'const NON_STORE_ROW_MENU_KEYS: ReadonlySet<string> = new Set([',
        "  'branch-info',",
        "  'debug-info',",
        ']);',
      ].join('\n'),
    );
    expect(host).toContain(
      [
        '          const kept = isWebCoreScope(workspace.localId)',
        '            ? CLOUD_ROW_MENU_KEYS',
        '            : NON_STORE_ROW_MENU_KEYS;',
        '          const items = isStoreWorktree(workspace.localId, worktree.localId)',
        '            ? incomingItems',
        '            : incomingItems.filter((item) => kept.has(item.key));',
      ].join('\n'),
    );
    const cloudKeys =
      /const CLOUD_ROW_MENU_KEYS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\);/.exec(
        host,
      )?.[1];
    expect(cloudKeys?.match(/'[a-z-]+'/g)).toEqual(["'archive'", "'delete'"]);
    expect(cloudKeys).toContain('...NON_STORE_ROW_MENU_KEYS');
  });

  it('a batch removal sends each row to its own authority: a cloud task to the web core, a local worktree to the local store exactly as before (CAN-7052)', async () => {
    const deleteTask = jest.fn((): Promise<void> => Promise.resolve());
    const archiveTask = jest.fn((): Promise<void> => Promise.resolve());
    const listArchivedTasks = jest.fn(() => Promise.resolve([]));
    cloudCoworkStore.setState({ deleteTask, archiveTask, listArchivedTasks });
    const archiveWorktree = jest.fn((): Promise<void> => Promise.resolve());
    useProjectsStore.setState({
      projects: [{ ...LOCAL_PROJECT, worktrees: [LOCAL_WORKTREE] }],
      archiveWorktree,
    });
    const { removeDesktopWorktreeInBatch } =
      await import('@/components/sidebar/DesktopSharedSidebarHost');
    await serveTaskDelete();

    // A mixed selection, Delete then Archive: the local row takes the local
    // store's own options for each mode, unchanged; the cloud task takes
    // the web core; neither reaches the other's.
    for (const mode of ['delete', 'archive'] as const) {
      await removeDesktopWorktreeInBatch('local-p', 'wt-1', { mode });
      await removeDesktopWorktreeInBatch('web-core:p1', 'web-core:t1', {
        mode,
      });
    }
    expect(archiveWorktree.mock.calls).toEqual([
      [
        'local-p',
        'wt-1',
        {
          deleteBranch: false,
          expectedBranchName: 'feature',
          deleteWithoutRetentionIfMissing: true,
        },
      ],
      [
        'local-p',
        'wt-1',
        {
          deleteBranch: false,
          expectedBranchName: 'feature',
          lockAfterArchive: true,
        },
      ],
    ]);
    expect(deleteTask.mock.calls).toEqual([['p1', 't1']]);
    expect(archiveTask.mock.calls).toEqual([['p1', 't1']]);

    // Without the manifest's delete, a cloud row's Delete sends nothing,
    // while a local row's still deletes as before.
    resetWebCoreServedOperations();
    await expect(
      removeDesktopWorktreeInBatch('web-core:p1', 'web-core:t1', {
        mode: 'delete',
      }),
    ).rejects.toThrow('Deleting a cloud task is not available.');
    expect(deleteTask).toHaveBeenCalledTimes(1);
    await removeDesktopWorktreeInBatch('local-p', 'wt-1', { mode: 'delete' });
    expect(archiveWorktree).toHaveBeenCalledTimes(3);
  });

  it('a cloud task opens through the same work-entry seam as a local one', () => {
    const openLocal = jest.fn(() => Promise.resolve());
    useStandaloneChatStore.setState({ openWorkEntryFromSidebar: openLocal });

    openCoworkWorkEntryFromSidebar('web-core:p1', 'web-core:t1');
    expect(openLocal).toHaveBeenCalledWith('web-core:p1', 'web-core:t1');

    openCoworkWorkEntryFromSidebar('local-project', 'entry-1');
    expect(openLocal).toHaveBeenCalledWith('local-project', 'entry-1');
  });

  it('hovering a cloud task never warms the local chat store (CAN-6099)', () => {
    const snapshotCloudRows = new Set(['legacy-ws/legacy-wt']);
    expect(
      shouldPrefetchWorktreeChat(
        'web-core:p1',
        'web-core:t1',
        snapshotCloudRows,
      ),
    ).toBe(false);
    expect(
      shouldPrefetchWorktreeChat('legacy-ws', 'legacy-wt', snapshotCloudRows),
    ).toBe(false);
    expect(
      shouldPrefetchWorktreeChat('local-a', 'wt-1', snapshotCloudRows),
    ).toBe(true);
  });

  it('hovering a web core task reads it ahead through the web core alone, never the local chat store (CAN-6774)', () => {
    const snapshotCloudRows = new Set(['legacy-ws/legacy-wt']);
    expect(
      sidebarRowPrefetchTarget('web-core:p1', 'web-core:t1', snapshotCloudRows),
    ).toEqual({
      kind: 'cloudTask',
      projectId: 'web-core:p1',
      worktreeId: 'web-core:t1',
    });
    // A cloud row the web core does not name reads nothing ahead.
    expect(
      sidebarRowPrefetchTarget('legacy-ws', 'legacy-wt', snapshotCloudRows),
    ).toBeNull();
    expect(
      sidebarRowPrefetchTarget('local-a', 'wt-1', snapshotCloudRows),
    ).toEqual({ kind: 'worktree', projectId: 'local-a', worktreeId: 'wt-1' });
  });

  it('a project drop reaches only its own authority (CAN-6099)', () => {
    const local = jest.fn();
    const cloud = jest.fn();
    routeSidebarReorder('local-a', 'local-b', { local, cloud });
    routeSidebarReorder('web-core:p1', 'web-core:p2', { local, cloud });
    // Across authorities nothing moves, so no id reaches the other side.
    routeSidebarReorder('local-a', 'web-core:p2', { local, cloud });
    routeSidebarReorder('web-core:p1', 'local-b', { local, cloud });
    expect(local.mock.calls).toEqual([['local-a', 'local-b']]);
    expect(cloud.mock.calls).toEqual([['web-core:p1', 'web-core:p2']]);
  });

  it('a collapsed cloud project stays collapsed after a restart (CAN-6099)', async () => {
    window.localStorage.clear();
    const first = await import('../useCloudCoworkSidebar');
    first.useCloudProjectCollapse.getState().setCollapsed('web-core:p1', true);
    first.useCloudProjectCollapse.getState().setCollapsed('web-core:p2', true);
    first.useCloudProjectCollapse.getState().setCollapsed('web-core:p2', false);

    jest.resetModules();
    const restarted = await import('../useCloudCoworkSidebar');
    expect(restarted.useCloudProjectCollapse.getState().collapsed).toEqual({
      'web-core:p1': true,
    });
  });
});

describe('the offline cloud list (CAN-6374)', () => {
  const ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const PERSONAL_PROJECT = '11111111-1111-4111-8111-111111111111';
  const ORG_PROJECT = '22222222-2222-4222-8222-222222222222';
  const ORG_TASK = '22222222-0000-4000-8000-000000000000';

  /** Set to hold the next project listing until `landListing` runs. */
  let holdListing = false;
  let landListing = (): void => undefined;
  /** Delivers one task stream frame to the open stream. */
  let deliver: (value: unknown) => void = () => undefined;
  let sequence = 0;

  /** A web core listing a Personal project and an organization's, one task each. */
  const invoker: CoreCoworkInvoker = {
    request: (method, params) => {
      if (method === 'core.workspace.list') {
        const listing = {
          ok: true as const,
          value: {
            items: [
              [PERSONAL_PROJECT, null],
              [ORG_PROJECT, ORG],
            ].map(([workspaceId, ownerOrganizationId]) => ({
              workspaceId,
              name: workspaceId === ORG_PROJECT ? 'Org project' : 'Personal',
              kind: 'cowork',
              ownerOrganizationId,
              revision: 1,
              repositorySources: [],
              settings: {},
            })),
            nextCursor: null,
          },
        };
        if (!holdListing) return Promise.resolve(listing);
        holdListing = false;
        return new Promise((resolve) => {
          landListing = (): void => resolve(listing);
        });
      }
      const workspaceId = JSON.stringify(params).includes(ORG_PROJECT)
        ? ORG_PROJECT
        : PERSONAL_PROJECT;
      return Promise.resolve({
        ok: true,
        value: {
          items: [
            {
              workspaceId,
              worktreeId: `${workspaceId.slice(0, 8)}-0000-4000-8000-000000000000`,
              title: workspaceId === ORG_PROJECT ? 'Org task' : 'Personal task',
              state: 'idle',
              updatedAt: '2026-11-18T10:00:00Z',
              revision: 1,
            },
          ],
          nextCursor: null,
        },
      });
    },
    openStream: () =>
      Promise.resolve({
        next: () =>
          new Promise((resolve) => {
            deliver = (value): void => resolve({ done: false, value });
          }),
        close: () => Promise.resolve(),
      }),
  };

  let model: CloudCoworkSidebarModel = { status: 'disabled' };
  function Probe(): null {
    model = useCloudCoworkSidebar();
    return null;
  }
  /** The kept rows' titles, as the host appends them to the shared list. */
  const titles = (): string[] =>
    'rows' in model
      ? [
          ...model.rows.workspaces.map((row) => row.name),
          ...model.rows.worktrees.map((row) => row.label ?? ''),
        ]
      : [];
  const orgTitles = (): string[] =>
    titles().filter((title) => title.startsWith('Org '));
  const settle = async (fn: () => unknown, waitMs = 0): Promise<void> => {
    await act(async () => {
      void fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
    });
  };

  it('losing an organization drops its kept rows, whenever its listing lands, and commands still fail', async () => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    useFeatureFlagsStore.setState({
      isEnabled: (key) =>
        key === CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key ||
        key === CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    });
    const { applyBroadcast } = useWorkspaceContextStore.getState();
    const start = useWorkspaceContextStore.getState().state;
    let revision = start.revision;
    // Main moves a member out of an organization they left (`departed`).
    const join = (): void =>
      applyBroadcast({
        ...start,
        revision: (revision += 1),
        context: { kind: 'organization', organizationId: ORG },
        organizations: [{ id: ORG, name: 'Org', role: 'MEMBER' }],
        reason: 'organizations',
      });
    const leave = (): void =>
      applyBroadcast({
        ...start,
        revision: (revision += 1),
        context: { kind: 'personal' },
        organizations: [],
        reason: 'departed',
      });
    const goOffline = (): void =>
      cloudCoworkStore.getState().disconnect('offline');

    join();
    const root = createRoot(document.createElement('div'));
    await settle(() => root.render(createElement(Probe)));
    await settle(() => cloudCoworkStore.getState().connect(invoker));
    expect(model.status).toBe('online');
    await settle(goOffline);
    expect(model.status).toBe('offline');
    expect(orgTitles()).toEqual(['Org project', 'Org task']);

    // Lost while offline.
    await settle(leave);
    expect(model.status).toBe('offline');
    expect(orgTitles()).toEqual([]);
    await expect(
      createCloudSidebarTask(`web-core:${ORG_PROJECT}`),
    ).rejects.toThrow('Cloud chats are offline.');

    // Lost while online, then the web core re-reads the organization's tasks.
    await settle(join);
    await settle(() => cloudCoworkStore.getState().connect(invoker));
    await settle(leave);
    const before = cloudCoworkStore.getState().listed;
    await settle(
      () =>
        deliver({
          kind: 'item',
          cursor: { daemonEpoch: 'e1', sequence: (sequence += 1) },
          item: {
            kind: 'task',
            workspaceId: ORG_PROJECT,
            worktreeId: ORG_TASK,
            batchId: 'b1',
          },
        }),
      300,
    );
    expect(cloudCoworkStore.getState().listed).not.toBe(before);
    await settle(goOffline);
    expect(orgTitles()).toEqual([]);

    // A listing already in flight when the organization is lost lands later.
    await settle(join);
    holdListing = true;
    await settle(() => cloudCoworkStore.getState().connect(invoker));
    await settle(leave);
    await settle(() => landListing());
    expect(model.status).toBe('online');
    await settle(goOffline);
    expect(orgTitles()).toEqual([]);
    expect(titles()).toEqual(['Personal', 'Personal task']);
    await settle(() => root.unmount());
  });
});

/** One manifest reply: listing `core.chat.delete` or not, refused, or a rejection. */
type ManifestAnswer = 'delete' | 'none' | 'refuse' | 'reject';

function manifestReply(answer: ManifestAnswer): Promise<unknown> {
  if (answer === 'reject') return Promise.reject(new Error('relay gone'));
  if (answer === 'refuse')
    return Promise.resolve({
      ok: false as const,
      error: {
        kind: 'unavailable',
        message: 'The web core is unavailable.',
        retry: { kind: 'never' },
      },
    });
  return Promise.resolve({
    ok: true as const,
    value: {
      runtime: {
        runtimeId: 'web-core',
        hostId: 'web',
        authorityId: null,
        profile: 'core',
        daemonEpoch: 'e1',
        protocolVersions: [1],
        state: 'ready',
      },
      operations:
        answer === 'delete'
          ? [
              {
                name: 'core.chat.delete',
                kind: 'instruction',
                version: 1,
                placement: 'core-only',
                requiredGrants: ['core.chat.write'],
                available: true,
              },
            ]
          : [],
      generatedAt: '2026-11-20T04:00:00.000Z',
    },
  });
}

/**
 * A relay answering each manifest read with the next answer; `hold` keeps
 * that read's reply until `release` is called with an answer.
 */
/** A fake relay's handle: its relay, the invoke spy, and the held-reply release. */
interface ManifestRelay {
  readonly relay: () => CanopyCoreRelayApi;
  readonly invoke: jest.Mock<Promise<unknown>, []>;
  readonly release: (answer: ManifestAnswer) => void;
}

function manifestRelay(answers: (ManifestAnswer | 'hold')[]): ManifestRelay {
  const pending: ((answer: ManifestAnswer) => void)[] = [];
  const invoke = jest.fn((): Promise<unknown> => {
    const answer = answers.shift() ?? 'none';
    if (answer !== 'hold') return manifestReply(answer);
    return new Promise((resolve, reject) => {
      pending.push((late) => {
        manifestReply(late).then(resolve, reject);
      });
    });
  });
  const api = { invoke } as unknown as CanopyCoreRelayApi;
  return {
    relay: (): CanopyCoreRelayApi => api,
    invoke,
    release: (answer: ManifestAnswer): void => pending.shift()?.(answer),
  };
}

/** Lets a read's reply settle and land. */
async function settleRead(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

function switchAccount(): void {
  act(() => {
    useWorkspaceContextStore.setState((state) => ({
      accountEpoch: state.accountEpoch + 1,
    }));
  });
}

describe('a failed web core manifest read (CAN-7464)', () => {
  beforeEach(() => {
    resetWebCoreServedOperations();
  });
  afterAll(() => {
    resetWebCoreServedOperations();
  });

  for (const answer of ['refuse', 'reject'] as const)
    it(`reports a ${answer === 'refuse' ? 'refused' : 'rejected'} read as failed, not loading, and doesn't read it again on its own`, async () => {
      const { relay, invoke } = manifestRelay([answer]);
      loadWebCoreServedOperations(relay);
      await settleRead();
      expect(webCoreServedOperationsFailed()).toBe(true);
      expect(webCoreServedOperationsKnown()).toBe(false);
      expect(webCoreServesTaskDelete()).toBe(false);
      // Every capability read asks for the manifest; a failed one isn't read.
      for (let render = 0; render < 3; render += 1)
        loadWebCoreServedOperations(relay);
      await settleRead();
      expect(invoke).toHaveBeenCalledTimes(1);
    });

  it('retries only a failed read: two retries in one tick read once, and a read in flight or landed is left as it is', async () => {
    const { relay, invoke } = manifestRelay(['refuse', 'hold']);
    loadWebCoreServedOperations(relay);
    await settleRead();
    retryWebCoreServedOperations(relay);
    retryWebCoreServedOperations(relay);
    expect(invoke).toHaveBeenCalledTimes(2);
    // In flight: nothing.
    retryWebCoreServedOperations(relay);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('reads a failed manifest again on Try again, and a later success clears the failure (task delete)', async () => {
    const { relay, invoke } = manifestRelay(['refuse', 'delete']);
    loadWebCoreServedOperations(relay);
    await settleRead();
    expect(webCoreServesTaskDelete()).toBe(false);
    retryWebCoreServedOperations(relay);
    await settleRead();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(webCoreServedOperationsFailed()).toBe(false);
    expect(webCoreServesTaskDelete()).toBe(true);
    // Landed: Try again does nothing.
    retryWebCoreServedOperations(relay);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('reads a failed manifest again when cloud chats come back online, and the sidebar reads it that way (task delete)', async () => {
    const { relay, invoke } = manifestRelay(['refuse', 'delete']);
    readWebCoreServedOperationsOnline(relay);
    await settleRead();
    expect(webCoreServedOperationsFailed()).toBe(true);
    readWebCoreServedOperationsOnline(relay);
    await settleRead();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(webCoreServesTaskDelete()).toBe(true);
    // Online again with a landed read: nothing.
    readWebCoreServedOperationsOnline(relay);
    expect(invoke).toHaveBeenCalledTimes(2);
    // The sidebar's online effect is this read.
    const sidebar = readFileSync(
      path.resolve(__dirname, '../useCloudCoworkSidebar.ts'),
      'utf8',
    );
    expect(sidebar).toMatch(
      /if \(online\) readWebCoreServedOperationsOnline\(\);/,
    );
    expect(sidebar).not.toMatch(/\bloadWebCoreServedOperations\b/);
  });

  it('drops a reply that lands after a reset', async () => {
    const { relay, release } = manifestRelay(['hold']);
    loadWebCoreServedOperations(relay);
    resetWebCoreServedOperations();
    release('delete');
    await settleRead();
    expect(webCoreServesTaskDelete()).toBe(false);
    expect(webCoreServedOperationsKnown()).toBe(false);
    expect(webCoreServedOperationsFailed()).toBe(false);
  });

  for (const [label, first, second] of [
    ['serves more', 'none', 'delete'],
    ['serves less', 'delete', 'none'],
  ] as const)
    it(`turns every manifest-gated feature off on an account switch until the new account's read lands, then follows it when that account ${label}`, async () => {
      const { relay, invoke } = manifestRelay([first, second]);
      loadWebCoreServedOperations(relay);
      await settleRead();
      expect(webCoreServesTaskDelete()).toBe(first === 'delete');
      switchAccount();
      // Nothing of the first account's answer, and nothing read yet.
      expect(webCoreServesTaskDelete()).toBe(false);
      expect(webCoreServedOperationsKnown()).toBe(false);
      expect(invoke).toHaveBeenCalledTimes(1);
      // The next capability read asks the new account's web core.
      loadWebCoreServedOperations(relay);
      await settleRead();
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(webCoreServesTaskDelete()).toBe(second === 'delete');
    });

  it("drops the old account's reply that lands after an account switch", async () => {
    const { relay, release } = manifestRelay(['hold']);
    loadWebCoreServedOperations(relay);
    switchAccount();
    release('delete');
    await settleRead();
    expect(webCoreServesTaskDelete()).toBe(false);
    expect(webCoreServedOperationsKnown()).toBe(false);
  });

  it('reads again after an account switch from a failed read, with no Try again', async () => {
    const { relay, invoke } = manifestRelay(['refuse', 'delete']);
    loadWebCoreServedOperations(relay);
    await settleRead();
    expect(webCoreServedOperationsFailed()).toBe(true);
    switchAccount();
    expect(webCoreServedOperationsFailed()).toBe(false);
    loadWebCoreServedOperations(relay);
    await settleRead();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(webCoreServesTaskDelete()).toBe(true);
  });
});
