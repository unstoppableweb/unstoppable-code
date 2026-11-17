import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AppAdvisorActionResponse,
  SidebarItem,
  WorktreeData,
  WorktreeEffectiveOverrides,
} from '@canopy/desktop-shared/types';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type { AdvisorWorktreeActionHost } from '../advisor-worktree-actions';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockPresent = jest.fn(
  (input: { action: { type: string } }): Promise<AppAdvisorActionResponse> =>
    Promise.resolve({
      requestId: '',
      ok: true,
      result: { presented: input.action.type },
    }),
);
jest.mock('../presentation-tools', () => ({
  presentAppAdvisorAction: (input: {
    action: { type: string };
  }): Promise<AppAdvisorActionResponse> => mockPresent(input),
  boundAppAdvisorInterfaceTools: (): Promise<string[]> =>
    Promise.resolve(['ui.app_advisor.present']),
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
  routeRendererToolRequest: (): null => null,
}));

let mockHost: AdvisorWorktreeActionHost;
const mockHostOptions: unknown[] = [];
jest.mock('../advisor-worktree-action-host', () => ({
  mainAdvisorWorktreeActionHost: (
    options: Pick<AdvisorWorktreeActionHost, 'selectWorktree'>,
  ): AdvisorWorktreeActionHost => {
    mockHostOptions.push(options);
    return { ...mockHost, selectWorktree: options.selectWorktree };
  },
}));

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  workspaceSummary,
  worktreeSummary,
} from '@canopy/desktop-shared/lib/app-advisor-worktree-summaries';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
  type AppAdvisorDispatchPayload,
} from '../action-router';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const MOVED_WRITES = [
  'worktree.update_settings',
  'worktree.create',
  'worktree.start_ci_check_fix',
  'worktree.start_merge_conflict_resolution',
  'worktree.start_pr_comment_triage',
] as const;

const WORKTREE = {
  id: 'wt',
  branchName: 'feature',
  createdAt: '2026-11-08T00:00:00.000Z',
} as unknown as WorktreeData;
const ITEM = {
  id: 'proj',
  type: 'single-repo',
  name: 'Project',
  repoPath: '/repo',
  color: 'blue',
  worktrees: [WORKTREE],
} as unknown as SidebarItem;
const WORKTREE_EFFECTIVE = { wt: { scripts: [] } } as unknown as Record<
  string,
  WorktreeEffectiveOverrides
>;
const COWORK = {
  id: 'cowork',
  type: 'cowork',
  name: 'Cowork',
} as unknown as SidebarItem;

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let calls: Record<string, unknown[]>;
let splitLocked: boolean;
let sourceVerified: boolean;
let mainWindowOpen: boolean;

function recordingHost(): AdvisorWorktreeActionHost {
  const record =
    <T>(name: string, value: T) =>
    (request: unknown): Promise<T> => {
      (calls[name] ??= []).push(request);
      return Promise.resolve(value);
    };
  return {
    readItems: () => Promise.resolve([ITEM, COWORK]),
    readWorktreeEffective: (projectId, worktreeId) =>
      Promise.resolve(
        projectId === 'proj' ? WORKTREE_EFFECTIVE[worktreeId] : undefined,
      ),
    updateWorktree: record('updateWorktree', WORKTREE),
    setPausedHookKeys: record('setPausedHookKeys', WORKTREE),
    verifySourceStatus: (projectId, worktreeId) => {
      (calls.verifySourceStatus ??= []).push({ projectId, worktreeId });
      return Promise.resolve(sourceVerified);
    },
    createWorktree: record('createWorktree', {
      status: 'created',
      worktreeId: 'wt-new',
    }),
    isSplitLocked: () => splitLocked,
    hasMainWindow: () => mainWindowOpen,
    launchFixChat: (type, request) => {
      (calls.launchFixChat ??= []).push({ type, ...request });
      return Promise.resolve({ chatId: 'fix-chat' });
    },
    selectWorktree: () => Promise.resolve(),
  };
}

function action(input: unknown): AppAdvisorDispatchPayload {
  return dispatchActionSchema.parse({ action: input }).action;
}

function setup(): {
  surfaces: Record<string, jest.Mock>;
  route(
    input: AppAdvisorDispatchPayload,
    call?: Partial<AppAdvisorActionCall>,
  ): ReturnType<typeof routeAppAdvisorAction>;
} {
  const surfaces = {
    getMainWindow: jest.fn(() => null),
    getAppAdvisorWindow: jest.fn(() => null),
    openAppAdvisorWindow: jest.fn(),
    ensureAppAdvisorWindow: jest.fn(),
  };
  const runtime = createAppAdvisorToolRuntime(surfaces, {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: APP_ADVISOR_WORKTREE_ID,
    chatId: 'advisor-chat',
  });
  return {
    surfaces,
    route: (input, call) =>
      routeAppAdvisorAction(
        input,
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      ),
  };
}

function parsed(text: string): AppAdvisorActionResponse {
  return JSON.parse(text) as AppAdvisorActionResponse;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-5997-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  calls = {};
  splitLocked = false;
  sourceVerified = true;
  mainWindowOpen = true;
  mockHost = recordingHost();
  mockHostOptions.length = 0;
  mockPresent.mockClear();
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor worktree family in main (CAN-5997)', () => {
  it('the moved rows are core worktree-actions with their CAN-4133 grant; archive and resolve are presentation', () => {
    expect(appAdvisorActionDisposition('worktree.get_settings')).toEqual({
      kind: 'core',
      access: 'read',
      executor: 'worktree-actions',
    });
    for (const type of MOVED_WRITES)
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'write',
        executor: 'worktree-actions',
        grants: ['core.worktree.write'],
        revision: 'none',
      });
    expect(
      appAdvisorActionDisposition('worktree.resolve_branch_from_confirmation'),
    ).toEqual({ kind: 'presentation' });
  });

  it('each moved action runs in main with no window and never reaches a renderer', async () => {
    const h = setup();
    const results = [
      await h.route(
        action({
          type: 'worktree.get_settings',
          projectId: 'proj',
          worktreeId: 'wt',
        }),
      ),
      await h.route(
        action({
          type: 'worktree.update_settings',
          projectId: 'proj',
          worktreeId: 'wt',
          hidden: true,
        }),
        { toolUseId: 'toolu_2' },
      ),
      await h.route(action({ type: 'worktree.create', workspaceId: 'proj' }), {
        toolUseId: 'toolu_3',
      }),
      await h.route(
        action({
          type: 'worktree.start_ci_check_fix',
          projectId: 'proj',
          worktreeId: 'wt',
        }),
        { toolUseId: 'toolu_4' },
      ),
    ];

    for (const result of results)
      expect(parsed(result.text)).toMatchObject({ ok: true });
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
    expect(h.surfaces.ensureAppAdvisorWindow).not.toHaveBeenCalled();
    expect(h.surfaces.openAppAdvisorWindow).not.toHaveBeenCalled();
  });

  it('get_settings answers with the renderer summaries and effective overrides', async () => {
    const result = await setup().route(
      action({
        type: 'worktree.get_settings',
        projectId: 'proj',
        worktreeId: 'wt',
      }),
    );

    expect(parsed(result.text)).toMatchObject({
      ok: true,
      result: {
        // As the tool text carries them: undefined fields drop out.
        workspace: JSON.parse(
          JSON.stringify(workspaceSummary(ITEM)),
        ) as unknown,
        worktree: JSON.parse(
          JSON.stringify(worktreeSummary(WORKTREE)),
        ) as unknown,
        effectiveOverrides: { scripts: [] },
      },
    });
  });

  it('update_settings writes only the requested fields, each keyed by the tool call', async () => {
    await setup().route(
      action({
        type: 'worktree.update_settings',
        projectId: 'proj',
        worktreeId: 'wt',
        pausedHookKeys: ['lint'],
      }),
      { toolUseId: 'toolu_7' },
    );

    expect(calls.updateWorktree).toBeUndefined();
    expect(calls.setPausedHookKeys).toEqual([
      {
        projectId: 'proj',
        worktreeId: 'wt',
        pausedHookKeys: ['lint'],
        idempotencyKey: 'app-advisor-action:advisor-chat:toolu_7:paused-hooks',
      },
    ]);
  });

  it('a moved write runs once per key', async () => {
    const h = setup();
    const create = action({ type: 'worktree.create', workspaceId: 'proj' });

    const first = await h.route(create, { toolUseId: 'toolu_9' });
    const second = await h.route(create, { toolUseId: 'toolu_9' });

    expect(calls.createWorktree).toHaveLength(1);
    expect(second.text).toBe(first.text);
  });

  it('the target worktree comes from the action, not the Advisor chat', async () => {
    await setup().route(
      action({
        type: 'worktree.start_pr_comment_triage',
        projectId: 'proj',
        worktreeId: 'wt',
        repoName: 'repo',
      }),
    );

    expect(calls.launchFixChat).toEqual([
      {
        type: 'worktree.start_pr_comment_triage',
        projectId: 'proj',
        worktreeId: 'wt',
        repoName: 'repo',
      },
    ]);
    expect(mockPresent.mock.calls[0]?.[0]).toMatchObject({
      action: { type: 'worktree.select', projectId: 'proj', worktreeId: 'wt' },
    });
  });

  it('a fix start is refused while the worktree is split-locked and launches nothing', async () => {
    splitLocked = true;

    const result = await setup().route(
      action({
        type: 'worktree.start_merge_conflict_resolution',
        projectId: 'proj',
        worktreeId: 'wt',
      }),
    );

    expect(parsed(result.text)).toMatchObject({
      ok: false,
      error: {
        code: 'surface_unavailable',
        message:
          'A Split PR is in progress for this worktree; it is locked until the split finishes.',
      },
    });
    expect(calls.launchFixChat).toBeUndefined();
    expect(mockPresent).not.toHaveBeenCalled();
  });

  it('a fix start needs the main window, which shows the new chat, and launches nothing without it', async () => {
    mainWindowOpen = false;

    const result = await setup().route(
      action({
        type: 'worktree.start_ci_check_fix',
        projectId: 'proj',
        worktreeId: 'wt',
      }),
    );

    expect(parsed(result.text)).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable', retryable: true },
    });
    expect(calls.launchFixChat).toBeUndefined();
    expect(mockPresent).not.toHaveBeenCalled();
  });

  it('worktree actions refuse a Cowork project as the renderer did', async () => {
    const result = await setup().route(
      action({
        type: 'worktree.get_settings',
        projectId: 'cowork',
        worktreeId: 'entry',
      }),
    );

    expect(parsed(result.text)).toMatchObject({
      ok: false,
      error: {
        code: 'unsupported_action',
        message: 'Project cowork is a cowork project and has no git worktrees.',
      },
    });
  });

  it('create refuses a base worktree and base branch together, and an unverified source, before creating', async () => {
    const h = setup();
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'worktree.create',
          workspaceId: 'proj',
          baseWorktreeId: 'wt',
          baseBranch: 'develop',
        },
      }).success,
    ).toBe(false);
    sourceVerified = false;
    const unverified = await h.route(
      action({
        type: 'worktree.create',
        workspaceId: 'proj',
        baseWorktreeId: 'wt',
      }),
      { toolUseId: 'toolu_10' },
    );

    expect(parsed(unverified.text)).toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Fresh source worktree status could not be verified.',
      },
    });
    expect(calls.createWorktree).toBeUndefined();
  });

  it('create selects the new worktree unless select is false', async () => {
    const h = setup();
    await h.route(action({ type: 'worktree.create', workspaceId: 'proj' }), {
      toolUseId: 'toolu_11',
    });
    await h.route(
      action({ type: 'worktree.create', workspaceId: 'proj', select: false }),
      { toolUseId: 'toolu_12' },
    );

    expect(mockPresent.mock.calls.map(([input]) => input.action)).toEqual([
      { type: 'worktree.select', projectId: 'proj', worktreeId: 'wt-new' },
    ]);
    expect(calls.createWorktree?.[0]).toEqual({
      workspaceId: 'proj',
      idempotencyKey: 'app-advisor-action:advisor-chat:toolu_11:worktree',
    });
  });

  it('the branch-from answer reaches only the presentation lease', async () => {
    const h = setup();
    await h.route(
      action({
        type: 'worktree.resolve_branch_from_confirmation',
        confirmationId: 'c1',
        projectId: 'proj',
        worktreeId: 'wt',
        choice: 'cancel',
      }),
    );

    expect(mockPresent.mock.calls.map(([input]) => input.action.type)).toEqual([
      'worktree.resolve_branch_from_confirmation',
    ]);
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
    expect(calls).toEqual({});
  });
});
