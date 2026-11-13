import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AppAdvisorActionResponse,
  SharedRunMetadata,
} from '@canopy/desktop-shared/types';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type { AdvisorSharingActionHost } from '../advisor-sharing-actions';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
  routeRendererToolRequest: (): null => null,
}));

let mockHost: AdvisorSharingActionHost;
jest.mock('../advisor-sharing-actions-host', () => ({
  mainAdvisorSharingActionHost: (): AdvisorSharingActionHost => mockHost,
}));

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
} from '../action-router';
import { ADVISOR_SHARING_ACTION_TYPES } from '../advisor-sharing-actions';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const PRIOR_RUN = { externalId: 'run-1' } as SharedRunMetadata;
const TARGET = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' };

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let calls: Record<string, unknown[]>;
let selectedOrganization: string | undefined;
let confirmation: 'confirmed' | 'declined' | 'no_person';
let unshareFails: boolean;

function recordingHost(): AdvisorSharingActionHost {
  const record =
    (name: string) =>
    (value: unknown): void => {
      (calls[name] ??= []).push(value);
    };
  return {
    selectedOrganizationId: () => selectedOrganization,
    memberOrganizationIds: () => Promise.resolve(new Set(['org-member'])),
    planExists: (projectId, worktreeId, planId) =>
      Promise.resolve(
        projectId === 'proj' &&
          worktreeId === 'wt' &&
          (planId === 'plan-1' || planId === 'plan-unshared'),
      ),
    planShared: (projectId, worktreeId, planId) =>
      Promise.resolve(
        projectId === 'proj' && worktreeId === 'wt' && planId === 'plan-1',
      ),
    readChat: (target) =>
      Promise.resolve(
        target.chatId === 'chat-1'
          ? { sharedRun: PRIOR_RUN }
          : target.chatId === 'chat-archived'
            ? { archived: true }
            : null,
      ),
    importSharedAgent: (agentId) => {
      record('import')(agentId);
      return Promise.resolve({ id: 'local-agent' });
    },
    deleteSharedAgent: (agentId) => {
      record('deleteShared')(agentId);
      return Promise.resolve();
    },
    publishAgentPublicShare: (agentId) => {
      record('publish')(agentId);
      return Promise.resolve({
        externalId: 'pub-1',
        pinnedContentHash: 'h',
        upToDate: true,
        sharePath: '/a/pub-1',
        createdAt: 't',
        updatedAt: 't',
      });
    },
    revokeAgentPublicShare: (agentId) => {
      record('revoke')(agentId);
      return Promise.resolve();
    },
    announceAgentsChanged: () => record('announce')(true),
    confirmPublicShare: (agentId) => {
      record('confirm')(agentId);
      return Promise.resolve(confirmation);
    },
    sharePlan: (request) => {
      record('sharePlan')(request);
      return Promise.resolve({
        ok: true,
        value: {
          id: 'plan-1',
          share: { remoteId: 'r1', syncStatus: 'synced', shareScope: 'team' },
        },
      });
    },
    unsharePlan: (request) => {
      record('unsharePlan')(request);
      return Promise.resolve({ ok: true, value: { id: request.planId } });
    },
    shareRun: (request) => {
      record('shareRun')(request);
      return Promise.resolve({ ok: true, value: { externalId: 'run-2' } });
    },
    unshareRun: (target) => {
      record('unshareRun')(target);
      return unshareFails
        ? Promise.reject(new Error('Cloud unavailable'))
        : Promise.resolve({ unshared: true });
    },
    setSharedRunMarker: (target, sharedRun) => {
      record('marker')({ target, sharedRun });
      return Promise.resolve();
    },
  };
}

function setup(): {
  route(
    input: unknown,
    call?: Partial<AppAdvisorActionCall>,
  ): Promise<AppAdvisorActionResponse>;
} {
  const runtime = createAppAdvisorToolRuntime(
    {
      getMainWindow: jest.fn(() => null),
      getAppAdvisorWindow: jest.fn(() => null),
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    },
    {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
  );
  return {
    route: async (input, call) => {
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-6003-sharing-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  calls = {};
  selectedOrganization = 'org-member';
  confirmation = 'confirmed';
  unshareFails = false;
  mockHost = recordingHost();
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor sharing actions in main (CAN-6003)', () => {
  it('eight are core sharing writes; runs.unshare also carries core.chat.write; the shared-container rows are presentation', () => {
    expect(ADVISOR_SHARING_ACTION_TYPES).toHaveLength(8);
    for (const type of ADVISOR_SHARING_ACTION_TYPES)
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'write',
        executor: 'sharing',
        grants:
          type === 'runs.unshare'
            ? ['core.chat.write', 'core.sharing.write']
            : ['core.sharing.write'],
        revision: 'none',
      });
    for (const type of [
      'shared-containers.revoke_recipient',
      'shared-containers.retry_received',
    ])
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'presentation',
      });
  });

  it("an organization the user isn't a member of is refused before any hosted call", async () => {
    const h = setup();
    await expect(
      h.route(
        {
          type: 'plan.share',
          ...TARGET,
          planId: 'plan-1',
          shareScope: 'organization',
          organizationId: 'org-forged',
        },
        { toolUseId: 'a' },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_target' } });
    await expect(
      h.route(
        {
          type: 'runs.share',
          ...TARGET,
          shareScope: 'organization',
          organizationId: 'org-forged',
        },
        { toolUseId: 'b' },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_target' } });
    expect(calls.sharePlan).toBeUndefined();
    expect(calls.shareRun).toBeUndefined();
  });

  it('an explicit organization the account belongs to is shared to, with none selected (as while the organization-projects rollout is off)', async () => {
    selectedOrganization = undefined;
    await expect(
      setup().route({
        type: 'plan.share',
        ...TARGET,
        planId: 'plan-1',
        shareScope: 'organization',
        organizationId: 'org-member',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(calls.sharePlan).toMatchObject([{ organizationId: 'org-member' }]);
  });

  it("an organization share uses the window's selected organization, and refuses with none selected", async () => {
    const h = setup();
    await h.route(
      {
        type: 'plan.share',
        ...TARGET,
        planId: 'plan-1',
        shareScope: 'organization',
      },
      { toolUseId: 'a' },
    );
    expect(calls.sharePlan).toEqual([
      expect.objectContaining({ organizationId: 'org-member' }),
    ]);
    selectedOrganization = undefined;
    await expect(
      h.route(
        { type: 'runs.share', ...TARGET, shareScope: 'organization' },
        { toolUseId: 'b' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(calls.shareRun).toBeUndefined();
  });

  it('a share only targets a plan or chat of the named worktree', async () => {
    const h = setup();
    await expect(
      h.route(
        {
          type: 'plan.share',
          ...TARGET,
          worktreeId: 'other-wt',
          planId: 'plan-1',
          shareScope: 'team',
          teamId: 'team-1',
        },
        { toolUseId: 'a' },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    await expect(
      h.route(
        {
          type: 'runs.share',
          ...TARGET,
          chatId: 'someone-else',
          shareScope: 'team',
          teamId: 'team-1',
        },
        { toolUseId: 'b' },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(calls.sharePlan).toBeUndefined();
    expect(calls.shareRun).toBeUndefined();
  });

  it("a public agent link publishes only on a person's answer; revoking asks no one", async () => {
    const h = setup();
    confirmation = 'no_person';
    await expect(
      h.route(
        { type: 'agents.publish_public_share', agentId: 'agent-1' },
        { toolUseId: 'a' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    confirmation = 'declined';
    await expect(
      h.route(
        { type: 'agents.publish_public_share', agentId: 'agent-1' },
        { toolUseId: 'b' },
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(calls.publish).toBeUndefined();

    confirmation = 'confirmed';
    await expect(
      h.route(
        { type: 'agents.publish_public_share', agentId: 'agent-1' },
        { toolUseId: 'c' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { publicShare: { externalId: 'pub-1' } },
    });
    await h.route(
      { type: 'agents.revoke_public_share', agentId: 'agent-1' },
      { toolUseId: 'd' },
    );
    expect(calls.publish).toEqual(['agent-1']);
    expect(calls.revoke).toEqual(['agent-1']);
    expect(calls.confirm).toHaveLength(3);
    expect(calls.announce).toHaveLength(2);
  });

  it("unsharing a run clears only that chat's sharedRun, then deletes the hosted grant", async () => {
    await expect(
      setup().route({ type: 'runs.unshare', ...TARGET }),
    ).resolves.toMatchObject({ ok: true, result: { unshared: true } });
    expect(calls.marker).toEqual([{ target: TARGET, sharedRun: null }]);
    expect(calls.unshareRun).toEqual([TARGET]);
  });

  it('stopping sharing a plan deletes it only for a shared plan of the named worktree (CAN-5904)', async () => {
    const h = setup();
    const plan = { projectId: 'proj', worktreeId: 'wt' };
    await expect(
      h.route(
        { type: 'plan.unshare', ...plan, planId: 'plan-1' },
        { toolUseId: 'unshare-plan' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { planId: 'plan-1', unshared: true },
    });
    await expect(
      h.route(
        { type: 'plan.unshare', ...plan, planId: 'plan-unshared' },
        { toolUseId: 'unshare-unshared' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: { planId: 'plan-unshared', unshared: false },
    });
    await expect(
      h.route(
        {
          type: 'plan.unshare',
          ...plan,
          worktreeId: 'other-wt',
          planId: 'plan-1',
        },
        { toolUseId: 'unshare-missing' },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(calls.unsharePlan).toEqual([{ ...plan, planId: 'plan-1' }]);
  });

  it('a failed hosted delete restores the run as it was shared', async () => {
    unshareFails = true;
    await expect(
      setup().route({ type: 'runs.unshare', ...TARGET }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed' },
    });
    expect(calls.marker).toEqual([
      { target: TARGET, sharedRun: null },
      { target: TARGET, sharedRun: PRIOR_RUN },
    ]);
  });

  it('a retried delete or import acts once', async () => {
    const h = setup();
    for (const input of [
      { type: 'agents.delete_shared', agentId: 'agent-1' },
      { type: 'agents.import_shared', agentId: 'agent-1' },
    ]) {
      const first = await h.route(input, { toolUseId: `retry-${input.type}` });
      const second = await h.route(input, { toolUseId: `retry-${input.type}` });
      expect(second).toEqual(first);
    }
    expect(calls.deleteShared).toEqual(['agent-1']);
    expect(calls.import).toEqual(['agent-1']);
  });

  it('an archived chat is refused for share and unshare, saying how to get there, with no hosted call or marker write (CAN-6068)', async () => {
    const h = setup();
    for (const [toolUseId, action] of [
      [
        'a',
        {
          type: 'runs.share',
          ...TARGET,
          chatId: 'chat-archived',
          shareScope: 'organization',
        },
      ],
      ['b', { type: 'runs.unshare', ...TARGET, chatId: 'chat-archived' }],
    ] as const)
      await expect(h.route(action, { toolUseId })).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'invalid_target',
          message:
            'This chat is archived. Restore it, then share or unshare its run.',
        },
      });
    expect(calls.shareRun).toBeUndefined();
    expect(calls.unshareRun).toBeUndefined();
    expect(calls.marker).toBeUndefined();
  });

  it('a shared-container revoke with no window lease is refused and revokes nothing', async () => {
    await expect(
      setup().route(
        {
          type: 'shared-containers.revoke_recipient',
          containerId: 'c1',
          recipientId: 'u1',
        },
        { context: { interfaceTools: [] } },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });
});
