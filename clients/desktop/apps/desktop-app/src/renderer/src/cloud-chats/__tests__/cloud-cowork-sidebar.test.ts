import type {
  CoreCoworkProject,
  CoreCoworkTask,
} from '@canopy/app-state/core-cowork';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  listCloudChatsForAdvisor,
  openCloudChatForAdvisor,
} from '../cloud-chat-advisor-actions';
import { useCloudChatSelection } from '../cloud-chat-selection';
import {
  cloudCoworkStore,
  cloudProjectsForContext,
} from '../useCloudCoworkSidebar';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const project = (
  workspaceId: string,
  ownerOrganizationId: string | null,
  kind: CoreCoworkProject['kind'] = 'cowork',
): CoreCoworkProject => ({
  key: `web-core:${workspaceId}`,
  workspaceId,
  name: workspaceId,
  kind,
  ownerOrganizationId,
});

const PROJECTS: CoreCoworkProject[] = [
  project('personal', null),
  project('ours', ORG),
  project('theirs', OTHER_ORG),
];
const TASKS: Record<string, readonly CoreCoworkTask[]> = {
  'web-core:ours': [
    {
      key: 'web-core:ours:task-1',
      workspaceId: 'ours',
      worktreeId: 'task-1',
      title: 'Plan',
      state: 'running',
      updatedAt: '2026-11-07T10:00:00Z',
    },
  ],
};

describe('cloud cowork sidebar rows', () => {
  it('projects of another organization are hidden', () => {
    const inOrg = cloudProjectsForContext(PROJECTS, TASKS, {
      kind: 'organization',
      organizationId: ORG,
    });
    expect(inOrg.map((row) => row.workspaceId)).toEqual(['ours']);
    expect(inOrg[0]).toMatchObject({
      cloud: true,
      entries: [{ key: 'web-core:ours:task-1', title: 'Plan', working: true }],
    });

    const personal = cloudProjectsForContext(PROJECTS, TASKS, {
      kind: 'personal',
    });
    expect(personal.map((row) => row.workspaceId)).toEqual(['personal']);
  });

  it('without a scoping context every project shows, as local rows do (CAN-6100)', () => {
    const all = cloudProjectsForContext(PROJECTS, TASKS, undefined);
    expect(all.map((row) => row.workspaceId)).toEqual([
      'personal',
      'ours',
      'theirs',
    ]);
  });

  it('a repository project is listed in its context with no entries (CAN-6100)', () => {
    const rows = cloudProjectsForContext(
      [...PROJECTS, project('repo', ORG.toUpperCase(), 'git')],
      TASKS,
      { kind: 'organization', organizationId: ORG },
    );
    expect(rows.map((row) => [row.workspaceId, row.kind])).toEqual([
      ['ours', 'cowork'],
      ['repo', 'git'],
    ]);
    expect(rows[1]?.entries).toEqual([]);
  });

  it('an archived task leaves the sidebar', () => {
    const archived: CoreCoworkTask = {
      key: 'web-core:ours:task-2',
      workspaceId: 'ours',
      worktreeId: 'task-2',
      title: 'Done and archived',
      state: 'archived',
      updatedAt: '2026-11-07T11:00:00Z',
    };
    const [row] = cloudProjectsForContext(
      PROJECTS,
      { 'web-core:ours': [archived, ...(TASKS['web-core:ours'] ?? [])] },
      { kind: 'organization', organizationId: ORG },
    );
    expect(row?.entries.map((entry) => entry.title)).toEqual(['Plan']);
  });
});

describe('App Advisor reads and opens the cloud chats the sidebar shows (CAN-5974)', () => {
  const setFlag = (on: boolean): void =>
    useFeatureFlagsStore.setState({
      isEnabled: (key) =>
        key === CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key ||
        (on && key === CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key),
    });

  beforeEach(() => {
    setFlag(true);
    useWorkspaceContextStore.setState((store) => ({
      hydrated: true,
      state: {
        ...store.state,
        context: { kind: 'organization', organizationId: ORG },
      },
    }));
    cloudCoworkStore.setState({
      status: 'online',
      projects: PROJECTS,
      tasksByProject: TASKS,
    });
    useCloudChatSelection.setState({ selectedChatKey: null });
  });

  it("lists the selected context's chats as ids and titles, and opens only those", () => {
    expect(listCloudChatsForAdvisor()).toEqual({
      ok: true,
      result: {
        chats: [
          {
            chatId: 'task-1',
            projectId: 'ours',
            projectName: 'ours',
            title: 'Plan',
          },
        ],
      },
    });

    expect(openCloudChatForAdvisor('task-elsewhere')).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(useCloudChatSelection.getState().selectedChatKey).toBeNull();

    expect(openCloudChatForAdvisor('task-1')).toEqual({
      ok: true,
      result: { chatId: 'task-1', projectId: 'ours', title: 'Plan' },
    });
    expect(useCloudChatSelection.getState().selectedChatKey).toBe(
      'web-core:task-1',
    );
  });

  it('answers unavailable while cloud chats are off or offline', () => {
    cloudCoworkStore.setState({ status: 'offline' });
    expect(listCloudChatsForAdvisor()).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(openCloudChatForAdvisor('task-1')).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });

    cloudCoworkStore.setState({ status: 'online' });
    setFlag(false);
    expect(listCloudChatsForAdvisor()).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(useCloudChatSelection.getState().selectedChatKey).toBeNull();
  });
});
