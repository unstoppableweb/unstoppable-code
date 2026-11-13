import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConfigGetResult,
  ConfigWritableNamespace,
} from '@canopy/protocol/canopy-core';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import type {
  AppAdvisorActionResponse,
  LaunchAtLoginSetResult,
} from '@canopy/desktop-shared/types';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type { PersonConfirmation } from '../advisor-records-actions';
import type {
  AdvisorConfigUpdate,
  AdvisorSettingsActionHost,
} from '../advisor-settings-actions';

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

let mockHost: AdvisorSettingsActionHost;
jest.mock('../advisor-settings-actions-host', () => ({
  mainAdvisorSettingsActionHost: (): AdvisorSettingsActionHost => mockHost,
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
import { ADVISOR_SETTINGS_ACTION_TYPES } from '../advisor-settings-actions';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const ADVISOR_CHAT = 'advisor-chat';

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;

type Values = Record<ConfigWritableNamespace, Record<string, unknown>>;
let values: Values;
let revisions: Record<ConfigWritableNamespace, number>;
let updates: AdvisorConfigUpdate[];
let questions: string[];
let answer: PersonConfirmation;
let launch: LaunchAtLoginSetResult;

function initialValues(): Values {
  return {
    agent: {
      claudeMaxTurns: DEFAULT_PREFERENCES.claudeMaxTurns,
      handoffSummaryModel: DEFAULT_PREFERENCES.handoffSummaryModel,
      handoffSummaryThinkingLevel:
        DEFAULT_PREFERENCES.handoffSummaryThinkingLevel,
      managedDelegationMode: 'explicit-only',
      managedDelegationMaxDepth: 2,
    },
    memory: {
      enabled: true,
      model: DEFAULT_PREFERENCES.localMemoryModel,
      thinkingLevel: DEFAULT_PREFERENCES.localMemoryThinkingLevel,
      modelSetByUser: false,
    },
    ledger: { agentRecordingEnabled: true },
    profile: { role: null, roleDetail: null, skillSuggestionsEnabled: true },
    navigation: { mode: 'code' },
    appAdvisor: { archiveRetentionDays: 30, autoArchiveDays: 14 },
    accountProxy: {
      routeClaude: true,
      routeCodex: true,
      keepChatOnOneAccount: true,
    },
  };
}

function document(namespace: ConfigWritableNamespace): ConfigGetResult {
  return {
    namespace,
    scope: {},
    revision: revisions[namespace],
    value: JSON.parse(JSON.stringify(values[namespace])) as never,
    enforcedPaths: [],
  };
}

function recordingHost(): AdvisorSettingsActionHost {
  return {
    read: (namespace) => Promise.resolve(document(namespace)),
    update: (update) => {
      updates.push(update);
      values[update.namespace] = {
        ...values[update.namespace],
        ...update.patch,
      };
      revisions[update.namespace] += 1;
      return Promise.resolve(document(update.namespace));
    },
    setLaunchAtLogin: () => Promise.resolve(launch),
    accountProxyStatus: () =>
      Promise.resolve({ available: true, running: false }),
    confirm: (question) => {
      questions.push(question);
      return Promise.resolve(answer);
    },
  };
}

function setup(): {
  route(input: unknown, toolUseId?: string): Promise<AppAdvisorActionResponse>;
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
      chatId: ADVISOR_CHAT,
    },
  );
  let calls = 0;
  return {
    route: async (input, toolUseId) => {
      calls += 1;
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: toolUseId ?? `toolu_${calls}` },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-6004-settings-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  values = initialValues();
  revisions = {
    agent: 1,
    memory: 1,
    ledger: 1,
    profile: 1,
    navigation: 1,
    appAdvisor: 1,
    accountProxy: 1,
  };
  updates = [];
  questions = [];
  answer = 'confirmed';
  launch = {
    ok: true,
    status: {
      platform: 'darwin',
      supported: true,
      enabled: true,
      pendingApproval: false,
    },
  };
  mockHost = recordingHost();
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor settings actions in main (CAN-6004)', () => {
  it('runs as core settings actions; the personal catalog stays with its hosted service', () => {
    for (const type of ADVISOR_SETTINGS_ACTION_TYPES) {
      const disposition = appAdvisorActionDisposition(type);
      expect(disposition).toMatchObject({ kind: 'core', executor: 'settings' });
      if (disposition?.kind === 'core' && disposition.access === 'write')
        expect(disposition.grants).toEqual(['core.config.write']);
    }
    expect(appAdvisorActionDisposition('settings.personalCatalog.set')).toEqual(
      { kind: 'legacy', access: 'write', grants: ['core.config.write'] },
    );
  });

  it('reads and writes at the revision it read, with no window, and a retried call writes once', async () => {
    const h = setup();
    await expect(
      h.route({ type: 'settings.get_claude_max_turns' }),
    ).resolves.toMatchObject({
      ok: true,
      result: { claudeMaxTurns: DEFAULT_PREFERENCES.claudeMaxTurns },
    });
    const input = { type: 'settings.set_claude_max_turns', maxTurns: 40 };
    const first = await h.route(input, 'toolu_retry');
    const retried = await h.route(input, 'toolu_retry');
    expect(first).toMatchObject({ ok: true, result: { claudeMaxTurns: 40 } });
    expect(retried).toEqual(first);
    expect(updates).toEqual([
      {
        namespace: 'agent',
        expectedRevision: 1,
        patch: { claudeMaxTurns: 40 },
      },
    ]);
    await h.route({ type: 'settings.set_navigation_mode', mode: 'work' });
    await h.route({
      type: 'settings.set_profile_role',
      role: 'other',
      roleDetail: 'Sculptor',
    });
    expect(updates.slice(1)).toEqual([
      { namespace: 'navigation', expectedRevision: 1, patch: { mode: 'work' } },
      {
        namespace: 'profile',
        expectedRevision: 1,
        patch: { role: 'other', roleDetail: 'Sculptor' },
      },
    ]);
    expect(questions).toEqual([]);
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it('C1: asks a person before delegation widens, and not before it narrows', async () => {
    const h = setup();
    await h.route({
      type: 'settings.set_managed_delegation_mode',
      mode: 'off',
    });
    await h.route({
      type: 'settings.set_managed_delegation_max_depth',
      maxDepth: 1,
    });
    expect(questions).toEqual([]);
    answer = 'declined';
    await expect(
      h.route({
        type: 'settings.set_managed_delegation_mode',
        mode: 'proactive',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'authorization_conflict' },
    });
    answer = 'no_person';
    await expect(
      h.route({
        type: 'settings.set_managed_delegation_max_depth',
        maxDepth: 4,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'authorization_conflict',
        message: 'Only a person can confirm this, and nobody did.',
      },
    });
    expect(questions).toHaveLength(2);
    expect(questions[1]).toContain('up to 4 levels deep');
    expect(updates.map((update) => update.patch)).toEqual([
      { managedDelegationMode: 'off' },
      { managedDelegationMaxDepth: 1 },
    ]);
    answer = 'confirmed';
    await expect(
      h.route({
        type: 'settings.set_managed_delegation_mode',
        mode: 'proactive',
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        managedDelegationMode: 'proactive',
        revocationIncomplete: false,
      },
    });
  });

  it('C2: asks a person before the account proxy routes traffic differently', async () => {
    const h = setup();
    answer = 'declined';
    await expect(
      h.route({ type: 'account_proxy.set_routing', codex: false }),
    ).resolves.toMatchObject({ ok: false });
    expect(questions).toEqual([
      'Change where the account proxy sends your provider traffic and credentials?\n- Route Codex through the proxy: off',
    ]);
    expect(updates).toEqual([]);
    answer = 'confirmed';
    await expect(
      h.route({ type: 'account_proxy.set_routing', codex: false }),
    ).resolves.toEqual({
      ok: true,
      result: { accountProxyRouteCodex: false },
      requestId: expect.any(String) as unknown,
    });
    expect(updates).toEqual([
      {
        namespace: 'accountProxy',
        expectedRevision: 1,
        patch: { routeCodex: false },
      },
    ]);
  });

  it('C3: asks a person before recording stops or archived chats are deleted sooner', async () => {
    const h = setup();
    answer = 'declined';
    for (const input of [
      { type: 'settings.set_local_memory_enabled', enabled: false },
      { type: 'settings.set_ledger_agent_recording_enabled', enabled: false },
      { type: 'app_advisor.update_settings', archiveRetentionDays: 7 },
      { type: 'app_advisor.update_settings', autoArchiveDays: 3 },
    ])
      await expect(h.route(input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'authorization_conflict' },
      });
    expect(questions).toHaveLength(4);
    expect(updates).toEqual([]);
    // Keeping things longer, or recording again, needs no one.
    for (const input of [
      { type: 'settings.set_local_memory_enabled', enabled: true },
      { type: 'app_advisor.update_settings', archiveRetentionDays: 90 },
      { type: 'app_advisor.update_settings', autoArchiveDays: null },
    ])
      await expect(h.route(input)).resolves.toMatchObject({ ok: true });
    expect(questions).toHaveLength(4);
    expect(updates.map((update) => update.namespace)).toEqual([
      'memory',
      'appAdvisor',
      'appAdvisor',
    ]);
  });

  it('C3: a retention that kept chats forever asks before it deletes any', async () => {
    const h = setup();
    answer = 'declined';
    for (const kept of [null, 0]) {
      values.appAdvisor = { archiveRetentionDays: kept, autoArchiveDays: null };
      await expect(
        h.route({
          type: 'app_advisor.update_settings',
          archiveRetentionDays: 30,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'authorization_conflict' },
      });
    }
    expect(questions).toEqual([
      expect.stringContaining('deleted after 30 days instead of kept'),
      expect.stringContaining('deleted after 30 days instead of kept'),
    ]);
    expect(updates).toEqual([]);
    // Unsetting it keeps chats forever for the purge, but the archive sweep
    // reads it as its shorter default window, so it asks too.
    values.appAdvisor = { archiveRetentionDays: 30, autoArchiveDays: null };
    await expect(
      h.route({
        type: 'app_advisor.update_settings',
        archiveRetentionDays: null,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(questions).toHaveLength(3);
  });

  it("sets launch at sign-in through main's service and reports what the system kept", async () => {
    const h = setup();
    await expect(
      h.route({ type: 'settings.set_launch_at_login', enabled: true }),
    ).resolves.toMatchObject({
      ok: true,
      result: { launchAtLogin: { enabled: true, pendingApproval: false } },
    });
    launch = {
      ok: false,
      reason: 'refused',
      status: {
        platform: 'darwin',
        supported: true,
        enabled: false,
        pendingApproval: true,
      },
    };
    await expect(
      h.route({ type: 'settings.set_launch_at_login', enabled: false }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message:
          'The system kept launch at sign-in on while it waits for approval in System Settings.',
      },
    });
    await expect(
      h.route({ type: 'account_proxy.status' }),
    ).resolves.toMatchObject({
      ok: true,
      result: { value: { available: true, running: false } },
    });
  });
});
