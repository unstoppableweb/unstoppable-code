import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import type { BrowserWindow } from 'electron';
import type * as ActionCallerModule from '../action-caller';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type * as HooksServiceModule from '../../services/hooks-service';
import type * as WorktreeActionsModule from '../../canopy-tools/worktree-actions';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockDispatchWorktreeAction = jest.fn<
  Promise<AppAdvisorActionResponse>,
  [{ action: { type: string } }, Record<string, unknown>]
>((input) =>
  Promise.resolve({
    requestId: '',
    ok: true,
    result: { applied: input.action.type },
  }),
);
jest.mock('../../canopy-tools/worktree-actions', () => ({
  dispatchWorktreeAction: (
    input: { action: { type: string } },
    runtime: Record<string, unknown>,
  ): Promise<AppAdvisorActionResponse> =>
    mockDispatchWorktreeAction(input, runtime),
}));

// The in-process boundary of core.worktree.hooks.setPaused; the store write
// itself is recorded instead of performed.
const mockSetWorktreeHooksPaused = jest.fn(
  (request: { workspaceId: string; worktreeId: string }) =>
    Promise.resolve({
      worktree: { id: request.worktreeId },
      pausedHookKeys: ['lint'],
      changed: true,
    }),
);
jest.mock('../../services/hooks-service', (): object => {
  const actual = jest.requireActual<typeof HooksServiceModule>(
    '../../services/hooks-service',
  );
  return {
    ...actual,
    listHooks: (): Promise<{ hookKey: string }[]> =>
      Promise.resolve([{ hookKey: 'lint' }]),
    changeWorktreeHookPause: (
      input: Parameters<typeof actual.changeWorktreeHookPause>[0],
    ): ReturnType<typeof actual.changeWorktreeHookPause> =>
      actual.changeWorktreeHookPause(
        input,
        mockSetWorktreeHooksPaused as unknown as Parameters<
          typeof actual.changeWorktreeHookPause
        >[1],
      ),
  };
});

const mockSetBaseBranchForAgent = jest.fn(
  (input: {
    target: { projectId: string; worktreeId: string };
    chatId: string;
    baseBranch: string;
    toolUseId?: string;
  }): Promise<AppAdvisorActionResponse> =>
    Promise.resolve({
      requestId: input.toolUseId ?? '',
      ok: true,
      result: { ...input.target, baseBranch: input.baseBranch },
    }),
);
jest.mock('../../canopy-tools/set-base-branch-runtime', () => ({
  setWorktreeBaseBranchForAgent: (
    input: Parameters<typeof mockSetBaseBranchForAgent>[0],
  ): Promise<AppAdvisorActionResponse> => mockSetBaseBranchForAgent(input),
}));

jest.mock('../../lib/workspace-registry', (): object => ({
  ...jest.requireActual<object>('../../lib/workspace-registry'),
  isCoworkWorkspace: (projectId: string): boolean => projectId === 'cowork',
}));

// The advisor chat's canonical tab exists in the app; its question waits
// commit their turn pause there (CAN-5827).
jest.mock('../../services/chat-state-service', (): object => ({
  getChatStateService: (): object => ({
    commitTurnPause: (): Promise<void> => Promise.resolve(),
  }),
}));

jest.mock('../presentation-tools', () => ({
  presentAppAdvisorAction: jest.fn(),
  boundAppAdvisorInterfaceTools: (): Promise<[]> => Promise.resolve([]),
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
  routeRendererToolRequest: (): null => null,
}));

let mockForcedMissingGrants: string[] | null = null;
jest.mock('../action-caller', (): object => {
  const actual =
    jest.requireActual<typeof ActionCallerModule>('../action-caller');
  return {
    ...actual,
    missingAppAdvisorGrants: (
      ...args: Parameters<typeof actual.missingAppAdvisorGrants>
    ): string[] =>
      mockForcedMissingGrants ?? actual.missingAppAdvisorGrants(...args),
  };
});

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_ACTION_TEXTS,
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
  type AppAdvisorDispatchPayload,
} from '../action-router';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const MOVED = ['hook.pause', 'hook.resume', 'tracked-plan.import'] as const;

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;

function action(input: unknown): AppAdvisorDispatchPayload {
  return dispatchActionSchema.parse({ action: input }).action;
}

function setup(window: unknown = null): {
  surfaces: Record<string, jest.Mock>;
  runtime: ReturnType<typeof createAppAdvisorToolRuntime>;
  route(
    input: AppAdvisorDispatchPayload,
    call?: Partial<AppAdvisorActionCall>,
  ): ReturnType<typeof routeAppAdvisorAction>;
} {
  const surfaces = {
    getMainWindow: jest.fn(() => null),
    getAppAdvisorWindow: jest.fn(() => window as BrowserWindow | null),
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
    runtime,
    route: (input, call) =>
      routeAppAdvisorAction(
        input,
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      ),
  };
}

async function recordedOperations(): Promise<number> {
  const { items } = await operations.list({
    kinds: ['core.appAdvisor.action.run'],
    limit: 10,
  });
  return items.length;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-5829-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  mockDispatchWorktreeAction.mockClear();
  mockSetBaseBranchForAgent.mockClear();
  mockSetWorktreeHooksPaused.mockClear();
  mockRequestRendererTool.mockClear();
  mockForcedMissingGrants = null;
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor worktree actions in main (CAN-5829)', () => {
  it('each moved action is a core write with its CAN-4133 grant', () => {
    expect(MOVED.map((type) => appAdvisorActionDisposition(type))).toEqual([
      expect.objectContaining({
        kind: 'core',
        access: 'write',
        executor: 'worktree-actions',
        grants: ['core.worktree.write'],
      }),
      expect.objectContaining({
        kind: 'core',
        access: 'write',
        executor: 'worktree-actions',
        grants: ['core.worktree.write'],
      }),
      expect.objectContaining({
        kind: 'core',
        access: 'write',
        executor: 'worktree-actions',
        grants: ['core.workspace.write'],
      }),
    ]);
  });

  it('each moved action runs in main with no window and never reaches a renderer', async () => {
    const h = setup();

    const pause = await h.route(
      action({
        type: 'hook.pause',
        projectId: 'proj',
        worktreeId: 'wt',
        all: true,
      }),
    );
    const resume = await h.route(
      action({
        type: 'hook.resume',
        projectId: 'proj',
        worktreeId: 'wt',
        hookKey: 'lint',
      }),
      { toolUseId: 'toolu_2' },
    );
    const imported = await h.route(
      action({
        type: 'tracked-plan.import',
        projectId: 'proj',
        worktreeId: 'wt',
        filePath: 'docs/plan.md',
        repoId: 'repo',
      }),
      { toolUseId: 'toolu_3' },
    );

    for (const result of [pause, resume, imported])
      expect(JSON.parse(result.text)).toMatchObject({ ok: true });
    expect(
      mockDispatchWorktreeAction.mock.calls.map(([input]) => input),
    ).toEqual([
      { action: { type: 'hook.pause', all: true } },
      { action: { type: 'hook.resume', hookKey: 'lint' } },
      {
        action: {
          type: 'tracked-plan.import',
          filePath: 'docs/plan.md',
          repoId: 'repo',
        },
      },
    ]);
    expect(mockDispatchWorktreeAction.mock.calls[2]?.[1]).toMatchObject({
      projectId: 'proj',
      worktreeId: 'wt',
      planInitiationSource: 'app_advisor',
    });
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
    expect(h.surfaces.ensureAppAdvisorWindow).not.toHaveBeenCalled();
    expect(h.surfaces.openAppAdvisorWindow).not.toHaveBeenCalled();
    expect(await recordedOperations()).toBe(3);
  });

  it('the target worktree comes from the action, not the Advisor chat', async () => {
    const h = setup();

    await h.route(
      action({
        type: 'hook.pause',
        projectId: 'proj',
        worktreeId: 'wt',
        hookKey: 'lint',
      }),
    );

    const [, runtime] = mockDispatchWorktreeAction.mock.calls[0] ?? [];
    expect(runtime).toMatchObject({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'advisor-chat',
      executionScope: 'worktree',
    });
  });

  it('a hook pause reaches core.worktree.hooks.setPaused for the target worktree', async () => {
    const actual = jest.requireActual<typeof WorktreeActionsModule>(
      '../../canopy-tools/worktree-actions',
    );
    mockDispatchWorktreeAction.mockImplementationOnce((input, runtime) =>
      actual.dispatchWorktreeAction(
        input as Parameters<typeof actual.dispatchWorktreeAction>[0],
        runtime as unknown as Parameters<
          typeof actual.dispatchWorktreeAction
        >[1],
      ),
    );
    const h = setup();

    const result = await h.route(
      action({
        type: 'hook.pause',
        projectId: 'proj',
        worktreeId: 'wt',
        hookKey: 'lint',
      }),
    );

    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      result: { projectId: 'proj', worktreeId: 'wt', pausedHookKeys: ['lint'] },
    });
    expect(mockSetWorktreeHooksPaused).toHaveBeenCalledWith({
      workspaceId: 'proj',
      worktreeId: 'wt',
      change: { kind: 'pause', hookKeys: ['lint'] },
      source: 'app_advisor',
    });
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it('a refused worktree-list write reports a typed hook error, never an internal one (CAN-5680)', async () => {
    const actual = jest.requireActual<typeof WorktreeActionsModule>(
      '../../canopy-tools/worktree-actions',
    );
    mockDispatchWorktreeAction.mockImplementation((input, runtime) =>
      actual.dispatchWorktreeAction(
        input as Parameters<typeof actual.dispatchWorktreeAction>[0],
        runtime as unknown as Parameters<
          typeof actual.dispatchWorktreeAction
        >[1],
      ),
    );
    const h = setup();
    const pause = async (
      type: 'hook.pause' | 'hook.resume',
      key: string,
    ): Promise<unknown> => {
      const routed = await h.route(
        action({ type, projectId: 'proj', worktreeId: 'wt', hookKey: 'lint' }),
        { toolUseId: key },
      );
      const parsed: unknown = JSON.parse(routed.text);
      return parsed;
    };

    mockSetWorktreeHooksPaused.mockRejectedValueOnce(
      new W5CommitRefusedError(
        'unapplied-change',
        'An earlier change (commit 84426, w5.worktree_list.write) to worktrees.json has not finished saving.',
        { commitId: 84426, operation: 'w5.worktree_list.write' },
      ),
    );
    const wedged = await pause('hook.pause', 'toolu_wedged');
    expect(wedged).toMatchObject({
      ok: false,
      error: { code: 'execution_failed' },
    });
    expect(JSON.stringify(wedged)).toContain('commit 84426');

    mockSetWorktreeHooksPaused.mockRejectedValueOnce(
      new W5CommitRefusedError(
        'in-progress',
        'This request is still in progress.',
      ),
    );
    expect(await pause('hook.resume', 'toolu_busy')).toMatchObject({
      ok: false,
      error: { code: 'in_progress', retryable: true },
    });
    mockDispatchWorktreeAction.mockReset();
  });

  it('a moved write runs once per key', async () => {
    const h = setup();
    const pause = action({
      type: 'hook.pause',
      projectId: 'proj',
      worktreeId: 'wt',
      all: true,
    });

    const first = await h.route(pause);
    const second = await h.route(pause);

    expect(mockDispatchWorktreeAction).toHaveBeenCalledTimes(1);
    expect(second.text).toBe(first.text);
  });

  it('a moved write checks its grant before its effect', async () => {
    const h = setup();
    mockForcedMissingGrants = ['core.worktree.write'];

    const result = await h.route(
      action({
        type: 'hook.pause',
        projectId: 'proj',
        worktreeId: 'wt',
        all: true,
      }),
    );

    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: {
        code: 'missing_capability',
        message: APP_ADVISOR_ACTION_TEXTS.missingGrant,
      },
    });
    expect(mockDispatchWorktreeAction).not.toHaveBeenCalled();
    expect(await recordedOperations()).toBe(0);
  });

  it('hooks in a Cowork project are refused as the renderer refused them', async () => {
    const h = setup();

    const result = await h.route(
      action({
        type: 'hook.pause',
        projectId: 'cowork',
        worktreeId: 'entry',
        all: true,
      }),
    );

    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: {
        code: 'unsupported_action',
        message: 'Project cowork is a cowork project and has no git worktrees.',
      },
    });
    expect(mockDispatchWorktreeAction).not.toHaveBeenCalled();
  });

  it('worktree.set_base_branch runs in main once per key, for the action target, with no window (CAN-6024)', async () => {
    expect(appAdvisorActionDisposition('worktree.set_base_branch')).toEqual(
      expect.objectContaining({
        kind: 'core',
        access: 'write',
        executor: 'worktree-actions',
        grants: ['core.worktree.write'],
      }),
    );
    const h = setup();
    const change = action({
      type: 'worktree.set_base_branch',
      projectId: 'proj',
      worktreeId: 'wt',
      baseBranch: 'develop',
    });

    const first = await h.route(change, { toolUseId: 'toolu_7' });
    const second = await h.route(change, { toolUseId: 'toolu_7' });

    expect(JSON.parse(first.text)).toMatchObject({
      ok: true,
      result: { projectId: 'proj', worktreeId: 'wt', baseBranch: 'develop' },
    });
    expect(second.text).toBe(first.text);
    expect(mockSetBaseBranchForAgent).toHaveBeenCalledTimes(1);
    expect(mockSetBaseBranchForAgent.mock.calls[0]?.[0]).toMatchObject({
      target: { projectId: 'proj', worktreeId: 'wt' },
      chatId: 'advisor-chat',
      baseBranch: 'develop',
      toolUseId: 'toolu_7',
    });
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
    expect(h.surfaces.ensureAppAdvisorWindow).not.toHaveBeenCalled();
  });

  it.each([
    ['an external agent through the Portal', true, 'agent'],
    ['a person', false, 'person'],
  ] as const)(
    'an advisor question answered by %s reaches the tool marked as such (CAN-6024)',
    async (_label, agentOriginated, answeredBy) => {
      const actual = jest.requireActual<typeof AppAdvisorIpcModule>(
        '../../ipc/app-advisor',
      );
      mockRequestRendererTool.mockImplementation(
        (...args: Parameters<typeof actual.requestAppAdvisorRendererTool>) =>
          actual.requestAppAdvisorRendererTool(...args),
      );
      const send = jest.fn();
      const window = {
        isDestroyed: (): boolean => false,
        webContents: {
          isDestroyed: (): boolean => false,
          isCrashed: (): boolean => false,
          mainFrame: { isDestroyed: (): boolean => false, detached: false },
          send,
        },
      };
      const h = setup(window);

      const answers = h.runtime.requestUserAnswers([
        { question: 'Update the PR?', options: ['Yes', 'No'] },
      ]);
      let requestId: string | undefined;
      for (let attempt = 0; attempt < 50 && !requestId; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        const request = send.mock.calls
          .flatMap((call: unknown[]) => call)
          .find(
            (arg: unknown): arg is { kind: string; requestId: string } =>
              typeof arg === 'object' &&
              arg !== null &&
              (arg as { kind?: unknown }).kind === 'ask_user_question',
          );
        requestId = request?.requestId;
      }
      expect(requestId).toBeDefined();
      expect(
        actual.completeAppAdvisorAskUserRequest(
          requestId ?? '',
          'advisor-chat',
          { question: 'Update the PR?', selectedOptions: ['Yes'] },
          { agentOriginated },
        ),
      ).toBe(true);

      await expect(answers).resolves.toEqual([
        expect.objectContaining({ selectedOptions: ['Yes'], answeredBy }),
      ]);
      mockRequestRendererTool.mockReset();
    },
  );

  it('a failed plan import answers its error and imports nothing', async () => {
    const h = setup();
    mockDispatchWorktreeAction.mockRejectedValueOnce(
      new Error('Plan import path must stay inside the worktree.'),
    );

    const result = await h.route(
      action({
        type: 'tracked-plan.import',
        projectId: 'proj',
        worktreeId: 'wt',
        filePath: '../outside.md',
        repoId: 'repo',
      }),
    );

    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Plan import path must stay inside the worktree.',
      },
    });
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });
});
