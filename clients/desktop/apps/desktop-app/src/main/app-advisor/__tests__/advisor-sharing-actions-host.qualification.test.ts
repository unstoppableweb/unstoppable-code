jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockInstructions: Array<{
  name: string;
  params: unknown;
  options: unknown;
}> = [];
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    instruction: (name: string, params: unknown, options: unknown): object => {
      mockInstructions.push({ name, params, options });
      return Promise.resolve({
        commandId: 'k',
        revision: 4,
        outcome: 'applied',
      });
    },
  }),
}));

jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceScopingContext: (): object => ({
    kind: 'organization',
    organizationId: 'org-selected',
  }),
  // As while the organization-projects rollout is off: no memberships.
  getWorkspaceContextService: (): object => ({
    getState: (): object => ({ organizations: [] }),
  }),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<object> =>
    Promise.resolve({
      organizations: [{ id: 'org-selected' }, { id: 'org-other' }],
    }),
}));

jest.mock('../../lib/plan-persistence', () => ({
  getTrackedPlan: (
    projectId: string,
    worktreeId: string,
    planId: string,
  ): Promise<object | null> =>
    Promise.resolve(
      planId === 'plan-1'
        ? { id: planId }
        : planId === 'plan-shared'
          ? { id: planId, share: { remoteId: 'remote-1' } }
          : null,
    ),
}));

const mockOwnerCalls: unknown[] = [];
jest.mock('../../ipc/agent-models', () => ({
  importSharedAgentForWindow: (request: unknown): object => {
    mockOwnerCalls.push(['import', request]);
    return Promise.resolve({ id: 'local' });
  },
  deleteSharedAgentForWindow: (request: unknown): object => {
    mockOwnerCalls.push(['delete', request]);
    return Promise.resolve();
  },
  publishAgentPublicShareForWindow: (agentId: string): object => {
    mockOwnerCalls.push(['publish', agentId]);
    return Promise.resolve({ externalId: 'pub' });
  },
  revokeAgentPublicShareForWindow: (agentId: string): object => {
    mockOwnerCalls.push(['revoke', agentId]);
    return Promise.resolve();
  },
}));
jest.mock('../../ipc/plans', () => ({
  shareTrackedPlanForWindow: (request: unknown): object => {
    mockOwnerCalls.push(['plan', request]);
    return Promise.resolve({ ok: true, value: null });
  },
  unshareTrackedPlanForWindow: (request: unknown): object => {
    mockOwnerCalls.push(['unsharePlan', request]);
    return Promise.resolve({ ok: true, value: null });
  },
}));
jest.mock('../../ipc/runs', () => ({
  shareRunForWindow: (request: unknown): object => {
    mockOwnerCalls.push(['shareRun', request]);
    return Promise.resolve({ ok: true, value: { externalId: 'r' } });
  },
  unshareRunForWindow: (request: unknown): object => {
    mockOwnerCalls.push(['unshareRun', request]);
    return Promise.resolve({ unshared: true });
  },
}));

jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    getCompatibilityArchives: (request: {
      projectId: string;
      worktreeId: string;
    }): Promise<object> =>
      Promise.resolve({
        version: 1,
        archived:
          request.projectId === 'proj' && request.worktreeId === 'wt'
            ? [{ tab: { id: 'chat-archived' }, archivedAt: 'x', turnCount: 1 }]
            : [],
      }),
  }),
}));

const mockWindowSends: unknown[] = [];
jest.mock('../../lib/web-contents-send', () => ({
  sendToWebContents: (_contents: unknown, channel: string): void => {
    mockWindowSends.push(channel);
  },
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { RequestPersonAnswers } from '../../lib/ask-user-outcomes';
import { mainAdvisorSharingActionHost } from '../advisor-sharing-actions-host';

const TARGET = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' };
let mockAnswers: RequestPersonAnswers;

function host(): ReturnType<typeof mainAdvisorSharingActionHost> {
  return mainAdvisorSharingActionHost({
    chatId: 'advisor-chat',
    idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:sharing',
    getWindow: () => ({ isDestroyed: () => false, webContents: {} }) as never,
    readTabs: () =>
      Promise.resolve({
        activeTabId: 'chat-1',
        tabs: [{ id: 'chat-1' }],
      } as never),
    requestUserAnswers: (questions) => mockAnswers(questions),
  });
}

beforeEach(() => {
  mockInstructions.length = 0;
  mockOwnerCalls.length = 0;
  mockWindowSends.length = 0;
});

describe('App Advisor sharing action host (CAN-6003)', () => {
  it("patches only the run's chat sharedRun through core.chat.update with only core.chat.write", async () => {
    await host().setSharedRunMarker(TARGET, null);
    expect(mockInstructions).toHaveLength(1);
    expect(mockInstructions[0]).toMatchObject({
      name: 'core.chat.update',
      params: {
        projectId: 'proj',
        worktreeId: 'wt',
        action: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { sharedRun: null },
        },
      },
      options: {
        caller: {
          clientInstanceId: 'agent-action:advisor-chat',
          grants: ['core.chat.write'],
        },
      },
    });
  });

  it("reads the window's selected organization and the account's own memberships, even while the organization-projects rollout hides them", async () => {
    const h = host();
    expect(h.selectedOrganizationId()).toBe('org-selected');
    expect([...(await h.memberOrganizationIds())].sort()).toEqual([
      'org-other',
      'org-selected',
    ]);
  });

  it('finds plans and chats, live or archived, only in the named worktree', async () => {
    const h = host();
    await expect(h.planExists('proj', 'wt', 'plan-1')).resolves.toBe(true);
    await expect(h.planExists('proj', 'wt', 'plan-x')).resolves.toBe(false);
    await expect(h.planShared('proj', 'wt', 'plan-shared')).resolves.toBe(true);
    await expect(h.planShared('proj', 'wt', 'plan-1')).resolves.toBe(false);
    await expect(h.planShared('proj', 'wt', 'plan-x')).resolves.toBe(false);
    await expect(h.readChat(TARGET)).resolves.toEqual({ id: 'chat-1' });
    await expect(
      h.readChat({ ...TARGET, chatId: 'other' }),
    ).resolves.toBeNull();
    // An archived chat of the worktree is reported as archived, not missing.
    await expect(
      h.readChat({ ...TARGET, chatId: 'chat-archived' }),
    ).resolves.toEqual({ archived: true });
    await expect(
      h.readChat({
        ...TARGET,
        worktreeId: 'wt-other',
        chatId: 'chat-archived',
      }),
    ).resolves.toBeNull();
  });

  it("confirms a public link only on a person's answer", async () => {
    mockAnswers = (): ReturnType<RequestPersonAnswers> =>
      Promise.resolve([
        { selectedOptions: ['Publish public link'], answeredBy: 'person' },
      ]);
    await expect(host().confirmPublicShare('agent-1')).resolves.toBe(
      'confirmed',
    );
    mockAnswers = (): ReturnType<RequestPersonAnswers> =>
      Promise.resolve([
        { selectedOptions: ['Publish public link'], answeredBy: 'agent' },
      ]);
    await expect(host().confirmPublicShare('agent-1')).resolves.toBe(
      'no_person',
    );
  });

  it("shares, publishes and unshares through the window's agents:import-shared, agents:public-share:publish, tracked-plans:unshare and runs:unshare owners, and announces agent changes", async () => {
    const h = host();
    const plan = { projectId: 'proj', worktreeId: 'wt', planId: 'plan-shared' };
    await h.importSharedAgent('agent-1');
    await h.publishAgentPublicShare('agent-1');
    await h.unsharePlan(plan);
    await h.unshareRun(TARGET);
    h.announceAgentsChanged();

    expect(mockOwnerCalls).toEqual([
      ['import', { agentId: 'agent-1', installMissing: true }],
      ['publish', 'agent-1'],
      ['unsharePlan', plan],
      ['unshareRun', TARGET],
    ]);
    expect(mockWindowSends).toEqual([IPC_CHANNELS.agentsChanged]);
  });
});
