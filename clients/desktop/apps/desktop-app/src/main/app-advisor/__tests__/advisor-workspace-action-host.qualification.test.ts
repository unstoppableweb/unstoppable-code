jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockQueries: unknown[][] = [];
const mockInstruction = jest.fn();
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    query: (operation: string, ...rest: unknown[]): Promise<object> => {
      mockQueries.push([operation, ...rest]);
      if (operation === 'core.plan.list')
        // The second record isn't a tracked plan, so the list leaves it out.
        return Promise.resolve({ plans: [mockPlan, { id: 'not-a-plan' }] });
      if (operation === 'core.plan.get')
        return Promise.resolve({ plan: mockPlan });
      return Promise.resolve({ content: '# Project rules' });
    },
    instruction: (...args: unknown[]): unknown => mockInstruction(...args),
  }),
}));

let mockCowork = false;
jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: (): boolean => mockCowork,
}));

const mockPlan = {
  id: 'p',
  projectId: 'proj',
  worktreeId: 'w',
  source: 'claude',
  title: 'Plan',
  content: '# Plan',
  reviewStatus: 'pending',
  createdAt: '2026-11-23T00:00:00.000Z',
  updatedAt: '2026-11-23T00:00:00.000Z',
  latestRevisionNumber: 1,
  revisions: [],
  linkedExecutionIds: [],
};

let mockOrgProjectsEnabled = true;
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    isEnabled: (): boolean => mockOrgProjectsEnabled,
  }),
}));

const mockCatalogLists: unknown[] = [];
jest.mock('../../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: (): object => ({
    list: (
      context: unknown,
    ): Promise<{ projects: Array<{ id: string }>; stale: boolean }> => {
      mockCatalogLists.push(context);
      return Promise.resolve({ projects: [{ id: 'op-1' }], stale: false });
    },
  }),
}));

const mockSends: unknown[][] = [];
jest.mock('../../lib/window-send', () => ({
  sendToAllWindows: (...args: unknown[]): void => {
    mockSends.push(args);
  },
}));

const mockContextInitialize = jest.fn(() => Promise.resolve());
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): object => ({
    initialize: (): Promise<void> => mockContextInitialize(),
    getState: (): object => ({
      context: { kind: 'organization', organizationId: 'org-1' },
      revision: 3,
      organizations: [],
    }),
  }),
}));

import {
  CORE_WORKSPACE_INSTRUCTIONS_GRANTS,
  PLAN_GRANTS,
} from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { mainAdvisorWorkspaceActionHost } from '../advisor-workspace-action-host';

const ORG = { kind: 'organization', organizationId: 'org-1' } as const;

beforeEach(() => {
  mockQueries.length = 0;
  mockInstruction.mockClear();
  mockCatalogLists.length = 0;
  mockSends.length = 0;
  mockContextInitialize.mockClear();
  mockCowork = false;
  mockOrgProjectsEnabled = true;
});

describe('App Advisor workspace action host (CAN-5998)', () => {
  it('reads CLAUDE.md through core.workspace.instructions.get as the Advisor chat, with only the read grant', async () => {
    const content = await mainAdvisorWorkspaceActionHost({
      chatId: 'advisor-chat',
    }).readInstructions('proj');

    expect(content).toBe('# Project rules');
    expect(mockQueries).toEqual([
      [
        'core.workspace.instructions.get',
        { workspaceId: 'proj' },
        {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'agent-action:advisor-chat',
            authorityId: 'local-desktop',
            interfaceKind: 'mcp',
            grants: [CORE_WORKSPACE_INSTRUCTIONS_GRANTS.read],
          },
        },
      ],
    ]);
    expect(mockInstruction).not.toHaveBeenCalled();
  });

  it('refuses an invalid project id before dispatching the read', async () => {
    await expect(
      mainAdvisorWorkspaceActionHost({ chatId: 'c' }).readInstructions('../x'),
    ).rejects.toThrow();
    expect(mockQueries).toEqual([]);
  });

  it('lists no tracked plans for a Cowork project, as the window does', async () => {
    const host = mainAdvisorWorkspaceActionHost({ chatId: 'c' });
    mockCowork = true;
    await expect(
      host.listTrackedPlans({ projectId: 'cowork', worktreeId: 'w' }),
    ).resolves.toEqual([]);
    expect(mockQueries).toEqual([]);
  });

  it('lists and reads tracked plans through core.plan.list and core.plan.get as the Advisor chat, with only the read grant (CAN-4165)', async () => {
    const host = mainAdvisorWorkspaceActionHost({ chatId: 'advisor-chat' });
    const caller = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'agent-action:advisor-chat',
      authorityId: 'local-desktop',
      interfaceKind: 'mcp',
      grants: [PLAN_GRANTS.read],
    };
    const scope = { projectId: 'proj', worktreeId: 'w' };

    await expect(host.listTrackedPlans(scope)).resolves.toEqual([mockPlan]);
    await expect(
      host.readTrackedPlan({ ...scope, planId: 'p' }),
    ).resolves.toEqual(mockPlan);
    expect(mockQueries).toEqual([
      ['core.plan.list', { scope }, { caller }],
      ['core.plan.get', { scope, planId: 'p' }, { caller }],
    ]);
    expect(mockInstruction).not.toHaveBeenCalled();

    await expect(
      host.listTrackedPlans({ projectId: '../x', worktreeId: 'w' }),
    ).rejects.toThrow();
    await expect(
      host.readTrackedPlan({ ...scope, planId: '../x' }),
    ).rejects.toThrow();
    expect(mockQueries).toHaveLength(2);
  });

  it('reads the selected organization from main and answers the disabled catalog while the feature is off', async () => {
    const host = mainAdvisorWorkspaceActionHost({ chatId: 'c' });
    await expect(host.readWorkspaceContext()).resolves.toMatchObject({
      context: ORG,
    });
    expect(mockContextInitialize).toHaveBeenCalledTimes(1);

    await expect(host.listOrgProjects(ORG)).resolves.toMatchObject({
      projects: [{ id: 'op-1' }],
    });
    mockOrgProjectsEnabled = false;
    await expect(host.listOrgProjects(ORG)).resolves.toEqual({
      context: 'org:org-1',
      revision: '',
      projects: [],
      fetchedAt: new Date(0).toISOString(),
      stale: true,
      error: 'unavailable',
    });
    expect(mockCatalogLists).toHaveLength(1);
  });

  it('announces a project reload to every window, which reloads its worktrees', () => {
    mainAdvisorWorkspaceActionHost({ chatId: 'c' }).announceWorktrees('proj');

    expect(mockSends).toEqual([
      [IPC_CHANNELS.workspaceWorktreesUpdated, { workspaceId: 'proj' }],
    ]);
  });
});
