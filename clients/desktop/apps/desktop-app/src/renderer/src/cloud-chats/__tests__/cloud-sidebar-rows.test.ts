/** @jest-environment jsdom */
import './jsdom-globals';
import type { CanopyCapabilities, SessionViewModel } from '@canopy/app-core';
import { appendCloudSidebarRows } from '../append-cloud-sidebar-rows';
import { batchActionAvailability } from '@canopy/ui-app/code/shell/sidebar-selection-menu-items';
import { cloudSidebarRowCapabilities } from '../cloud-sidebar-capabilities';
import { routeSidebarReorder } from '../route-sidebar-reorder';
import { shouldPrefetchWorktreeChat } from '../cloud-sidebar-intent';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

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
