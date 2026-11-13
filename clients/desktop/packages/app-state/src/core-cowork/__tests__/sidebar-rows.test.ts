import type {
  CoreCoworkProject,
  CoreCoworkTask,
} from '../create-core-cowork-store';
import {
  CORE_COWORK_TASK_BRANCH,
  coreCoworkSidebarRows,
} from '../sidebar-rows';

const ORG = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const scopeId = (id: string): string => `web-core:${id}`;

const project = (
  workspaceId: string,
  kind: CoreCoworkProject['kind'],
  ownerOrganizationId: string | null,
): CoreCoworkProject => ({
  key: `web-core:${workspaceId}`,
  workspaceId,
  name: workspaceId,
  kind,
  ownerOrganizationId,
});

const task = (
  workspaceId: string,
  worktreeId: string,
  state: string,
): CoreCoworkTask => ({
  key: `web-core:${workspaceId}:${worktreeId}`,
  workspaceId,
  worktreeId,
  title: `Task ${worktreeId}`,
  state,
  updatedAt: '2026-11-10T10:00:00Z',
});

describe('cloud projects as shared sidebar rows (CAN-6099)', () => {
  it('projects tree rows the way the web does, with authority-qualified ids', () => {
    const rows = coreCoworkSidebarRows(
      [project('research', 'cowork', null), project('shop', 'git', ORG)],
      {
        'web-core:research': [
          task('research', 'wt-1', 'running'),
          task('research', 'wt-2', 'awaiting_user'),
          task('research', 'wt-3', 'archived'),
        ],
        'web-core:shop': [task('shop', 'wt-9', 'idle')],
      },
      { scopeId, collapsed: { 'web-core:research': true } },
    );

    expect(rows.workspaces).toEqual([
      expect.objectContaining({
        localId: 'web-core:research',
        type: 'cowork',
        layout: 'tree',
        backend: 'cloud',
        order: 0,
        collapsed: true,
      }),
      expect.objectContaining({
        localId: 'web-core:shop',
        type: 'single-repo',
        layout: 'tree',
        backend: 'cloud',
        owner: {
          type: 'cloud-organization',
          organizationId: ORG.toLowerCase(),
        },
        order: 1,
        collapsed: false,
      }),
    ]);
    expect(rows.workspaces[0]).not.toHaveProperty('owner');

    // Live cowork tasks only; a repository project never gets task rows.
    expect(rows.worktrees).toEqual([
      expect.objectContaining({
        localId: 'web-core:wt-1',
        workspaceLocalId: 'web-core:research',
        branch: CORE_COWORK_TASK_BRANCH,
        backend: 'cloud',
        label: 'Task wt-1',
        isStreaming: true,
      }),
      expect.objectContaining({
        localId: 'web-core:wt-2',
        awaitingApproval: true,
      }),
    ]);
    expect(rows.worktrees[1]).not.toHaveProperty('isStreaming');
  });
});
