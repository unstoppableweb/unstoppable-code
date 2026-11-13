import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AppAdvisorActionResponse,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type { AdvisorAutomationSharingHost } from '../advisor-automation-sharing-actions';

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

let mockHost: AdvisorAutomationSharingHost;
jest.mock('../advisor-automation-sharing-actions-host', () => ({
  mainAdvisorAutomationSharingHost: (): AdvisorAutomationSharingHost =>
    mockHost,
}));

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { routeAppAdvisorAction } from '../action-router';
import { ADVISOR_AUTOMATION_SHARING_ACTION_TYPES } from '../advisor-automation-sharing-actions';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let hosted: string[];
let published: unknown[];
let activities: ScheduledActivity[];
let selected: string | undefined;

function activity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'auto-1',
    name: 'Morning summary',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: {
      type: 'app_advisor_prompt',
      prompt: 'Summarize what changed overnight.',
    },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

const DETAIL = {
  id: 'shared-1',
  contentHash: 'server-hash',
  shareScope: 'team',
  automation: { description: 'Kept description' },
};

function recordingHost(): AdvisorAutomationSharingHost {
  return {
    selectedOrganizationId: () => selected,
    memberOrganizationIds: () => Promise.resolve(new Set(['org-1'])),
    list: () => Promise.resolve({ activities, runs: [] } as never),
    getShared: (id) => {
      hosted.push(`getShared ${id}`);
      return Promise.resolve(DETAIL as never);
    },
    listShared: () => {
      hosted.push('listShared');
      return Promise.resolve({ automations: [], nextCursor: null } as never);
    },
    createShared: (request) => {
      hosted.push('createShared');
      published.push(request);
      return Promise.resolve({ ok: true, value: DETAIL } as never);
    },
    updateShared: (request) => {
      hosted.push('updateShared');
      published.push(request);
      return Promise.resolve({ ok: true, value: DETAIL } as never);
    },
    deleteShared: (request) => {
      hosted.push(`deleteShared ${request.automationId}`);
      return Promise.resolve();
    },
    accountCapabilities: () => Promise.resolve([]),
    pipelines: {} as never,
  };
}

function setup(): {
  route(input: unknown): Promise<AppAdvisorActionResponse>;
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
  let calls = 0;
  return {
    route: async (input) => {
      calls += 1;
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: `toolu_${calls}` },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-6003b-automations-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  hosted = [];
  published = [];
  activities = [activity()];
  selected = undefined;
  mockHost = recordingHost();
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor automation sharing in main (CAN-6003 part B)', () => {
  it('runs as core automation-sharing actions', () => {
    for (const type of ADVISOR_AUTOMATION_SHARING_ACTION_TYPES)
      expect(appAdvisorActionDisposition(type)).toMatchObject({
        kind: 'core',
        executor: 'automation-sharing',
      });
  });

  it("S8: keeps the window's refusals before any hosted call", async () => {
    const h = setup();
    const cases: Array<[ScheduledActivity, string]> = [
      [
        activity({
          installedFrom: { capabilityPackage: { digest: 'd' } },
        } as never),
        'packaged capabilities',
      ],
      [
        activity({
          dependencies: { pipelines: [{ id: 'p1' }] },
        } as never),
        'may run local pipelines',
      ],
      [activity(), 'A first automation share requires shareScope'],
    ];
    for (const [entry, message] of cases) {
      activities = [entry];
      await expect(
        h.route({ type: 'automation.share', id: 'auto-1' }),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining(message) as unknown },
      });
    }
    activities = [];
    await expect(
      h.route({
        type: 'automation.share',
        id: 'auto-1',
        shareScope: 'team',
        teamId: 't1',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(hosted).toEqual([]);
  });

  it('targets an organization by the part A rules: a forged one is refused before any hosted call', async () => {
    const h = setup();
    await expect(
      h.route({
        type: 'automation.share',
        id: 'auto-1',
        shareScope: 'organization',
        organizationId: 'org-forged',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_target' } });
    await expect(
      h.route({
        type: 'automation.share',
        id: 'auto-1',
        shareScope: 'organization',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(hosted).toEqual([]);
    selected = 'org-1';
    await expect(
      h.route({
        type: 'automation.share',
        id: 'auto-1',
        shareScope: 'organization',
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { id: 'shared-1', contentHash: 'server-hash' },
    });
    expect(published).toEqual([
      expect.objectContaining({
        activityId: 'auto-1',
        shareScope: 'organization',
        organizationId: 'org-1',
      }),
    ]);
  });

  it("S8: a re-share sends the server's current hash and keeps the owner and description", async () => {
    const h = setup();
    activities = [
      activity({
        remote: {
          remoteId: 'shared-1',
          contentHash: 'stale-local-hash',
          shareScope: 'team',
          sharedAt: '2026-11-02T00:00:00.000Z',
        },
      }),
    ];
    await expect(
      h.route({ type: 'automation.share', id: 'auto-1' }),
    ).resolves.toMatchObject({ ok: true });
    expect(hosted).toEqual(['getShared shared-1', 'updateShared']);
    expect(published).toEqual([
      expect.objectContaining({
        automationId: 'shared-1',
        expectedContentHash: 'server-hash',
        automation: expect.objectContaining({
          description: 'Kept description',
        }) as unknown,
      }),
    ]);
    expect(published[0]).not.toHaveProperty('shareScope');
  });

  it("lists, reads and unshares through the window's owners", async () => {
    const h = setup();
    await expect(
      h.route({ type: 'automation.list_shared', query: 'summary' }),
    ).resolves.toMatchObject({ ok: true, result: { automations: [] } });
    await expect(
      h.route({ type: 'automation.read_shared', automationId: 'shared-1' }),
    ).resolves.toMatchObject({ ok: true, result: { id: 'shared-1' } });
    await expect(
      h.route({ type: 'automation.unshare', automationId: 'shared-1' }),
    ).resolves.toMatchObject({
      ok: true,
      result: { automationId: 'shared-1' },
    });
    expect(hosted).toEqual([
      'listShared',
      'getShared shared-1',
      'deleteShared shared-1',
    ]);
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });
});
