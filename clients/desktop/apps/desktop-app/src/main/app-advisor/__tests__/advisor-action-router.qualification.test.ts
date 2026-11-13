import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as DispositionsModule from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import type * as ActionCallerModule from '../action-caller';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type * as ResourceActionsModule from '../../canopy-tools/resource-actions';
import type * as ResolveWorktreeModule from '../../lib/resolve-worktree';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockDispatchResource = jest.fn<
  Promise<AppAdvisorActionResponse>,
  [{ type: string }, unknown]
>((action) =>
  Promise.resolve({
    requestId: 'resource',
    ok: true,
    result: { applied: action.type },
  }),
);
jest.mock('../../canopy-tools/resource-actions', (): object => ({
  ...jest.requireActual<typeof ResourceActionsModule>(
    '../../canopy-tools/resource-actions',
  ),
  dispatchAgentResourceAction: (
    action: { type: string },
    runtime: unknown,
  ): Promise<AppAdvisorActionResponse> => mockDispatchResource(action, runtime),
}));

jest.mock('../../lib/resolve-worktree', (): object => ({
  ...jest.requireActual<typeof ResolveWorktreeModule>(
    '../../lib/resolve-worktree',
  ),
  resolveWorktreeCwd: (projectId: string, worktreeId: string): string =>
    `/worktrees/${projectId}/${worktreeId}`,
}));

const mockPresent = jest.fn(
  (input: { requestId?: string }): Promise<AppAdvisorActionResponse> =>
    Promise.resolve({ requestId: input.requestId ?? 'present', ok: true }),
);
jest.mock('../presentation-tools', () => ({
  presentAppAdvisorAction: (input: {
    requestId?: string;
  }): Promise<AppAdvisorActionResponse> => mockPresent(input),
  boundAppAdvisorInterfaceTools: (): Promise<[]> => Promise.resolve([]),
}));

jest.mock('../../agent-actions/desktop-surface', () => ({
  executeDesktopAgentActionTool: jest.fn(),
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
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

// automation.open_editor is presentation, so it never gets a main executor;
// this file treats it as core to prove the runtime refuses to hand a core
// type to the renderer.
jest.mock(
  '@canopy/desktop-shared/lib/app-advisor-action-dispositions',
  (): object => {
    const actual = jest.requireActual<typeof DispositionsModule>(
      '@canopy/desktop-shared/lib/app-advisor-action-dispositions',
    );
    return {
      ...actual,
      appAdvisorActionDisposition: (
        type: string,
      ): ReturnType<typeof actual.appAdvisorActionDisposition> =>
        type === 'automation.open_editor'
          ? { kind: 'core', access: 'read', executor: 'automation' }
          : actual.appAdvisorActionDisposition(type),
    };
  },
);

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { APP_ADVISOR_ACTION_GRANTS } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { appAdvisorActionCaller } from '../action-caller';
import {
  APP_ADVISOR_ACTION_TEXTS,
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
  type AppAdvisorDispatchPayload,
} from '../action-router';
import { dispatchActionSchema } from '../definitions';
import {
  createAppAdvisorToolRuntime,
  type AppAdvisorToolRuntimeSurfaces,
} from '../runtime';

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;

function action(input: unknown): AppAdvisorDispatchPayload {
  return dispatchActionSchema.parse({ action: input }).action;
}

function setup(): {
  surfaces: AppAdvisorToolRuntimeSurfaces & {
    getMainWindow: jest.Mock;
    getAppAdvisorWindow: jest.Mock;
    openAppAdvisorWindow: jest.Mock;
    ensureAppAdvisorWindow: jest.Mock;
  };
  rendererAction: jest.Mock;
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
  const created = createAppAdvisorToolRuntime(surfaces, {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: APP_ADVISOR_WORKTREE_ID,
    chatId: 'advisor-chat',
  });
  const rendererAction = jest.fn<
    Promise<AppAdvisorActionResponse>,
    Parameters<typeof created.dispatchRendererAction>
  >((...args) => Promise.resolve({ requestId: args[2] ?? 'r', ok: true }));
  const runtime = { ...created, dispatchRendererAction: rendererAction };
  for (const accessor of Object.values(surfaces)) accessor.mockClear();
  return {
    surfaces,
    rendererAction,
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
  root = mkdtempSync(join(tmpdir(), 'can-4133-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  mockDispatchResource.mockClear();
  mockRequestRendererTool.mockClear();
  mockPresent.mockClear();
  mockForcedMissingGrants = null;
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor action router (CAN-4133)', () => {
  it('a core action runs with no window', async () => {
    const h = setup();

    const result = await h.route(
      action({ type: 'pipeline.create', name: 'Nightly' }),
    );

    expect(result.isError).toBe(false);
    expect(mockDispatchResource).toHaveBeenCalledTimes(1);
    // Stored definitions are not read in the synthetic Advisor workspace.
    expect(mockDispatchResource.mock.calls[0]?.[1]).toMatchObject({
      executionScope: 'directory',
      definitionScope: {},
    });
    expect(h.rendererAction).not.toHaveBeenCalled();
    for (const accessor of Object.values(h.surfaces))
      expect(accessor).not.toHaveBeenCalled();
  });

  it('a write whose grant the advisor does not hold is refused before its effect', async () => {
    const h = setup();
    mockForcedMissingGrants = ['core.pipeline.write'];

    const result = await h.route(
      action({ type: 'pipeline.create', name: 'Nightly' }),
    );

    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: {
        code: 'missing_capability',
        message: APP_ADVISOR_ACTION_TEXTS.missingGrant,
      },
    });
    expect(mockDispatchResource).not.toHaveBeenCalled();
    expect(await recordedOperations()).toBe(0);
  });

  it('the advisor caller holds exactly the section 3b grants', () => {
    const { grants } = appAdvisorActionCaller('c');
    expect(grants).toEqual([...APP_ADVISOR_ACTION_GRANTS]);
    expect(
      grants.filter((grant) =>
        [
          'core.approval.',
          'core.vault.',
          'core.client.',
          'core.workspaceRecords.',
        ].some((prefix) => grant.startsWith(prefix)),
      ),
    ).toEqual([]);
  });

  it('a repeated tool call replays the first result', async () => {
    const h = setup();
    const create = action({ type: 'pipeline.create', name: 'Nightly' });

    const first = await h.route(create);
    const second = await h.route(create);

    expect(mockDispatchResource).toHaveBeenCalledTimes(1);
    expect(second.text).toBe(first.text);
  });

  it('a workflow file outside Advisor home is read in main and sent inline', async () => {
    const h = setup();
    const yamlFilePath = join(root, 'build.yaml');
    writeFileSync(yamlFilePath, 'name: Build\n');

    const result = await h.route(
      action({ type: 'pipeline.create', yamlFilePath }),
    );

    expect(result.isError).toBe(false);
    const [sent] = mockDispatchResource.mock.calls[0] ?? [];
    expect(sent).toMatchObject({
      type: 'pipeline.create',
      rawYaml: 'name: Build\n',
    });
    expect(sent).toHaveProperty('yamlFilePath', undefined);
  });

  it('an explicit task scopes a workflow duplicate to that worktree', async () => {
    const h = setup();

    await h.route(
      action({
        type: 'pipeline.duplicate',
        pipelineId: 'project--build',
        projectId: 'proj',
        worktreeId: 'wt',
      }),
    );

    const [, runtime] = mockDispatchResource.mock.calls[0] ?? [];
    expect(runtime).toMatchObject({
      projectId: 'proj',
      worktreeId: 'wt',
      cwd: '/worktrees/proj/wt',
      executionScope: 'worktree',
      authorChat: {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat',
      },
    });
  });

  it('a stale UI revision never refuses a domain write', async () => {
    const h = setup();

    const result = await h.route(
      action({ type: 'pipeline.update', pipelineId: 'p', name: 'Renamed' }),
      { expectedUiRevision: 1 },
    );

    expect(result.isError).toBe(false);
    expect(mockDispatchResource).toHaveBeenCalledTimes(1);
    const [sent, runtime] = mockDispatchResource.mock.calls[0] ?? [];
    expect(sent).not.toHaveProperty('expectedUiRevision');
    expect(runtime).not.toHaveProperty('expectedUiRevision');
  });

  it('a stale domain revision is refused by the core operation', async () => {
    const h = setup();
    const conflict: Omit<AppAdvisorActionResponse, 'requestId'> = {
      ok: false,
      error: {
        code: 'execution_failed',
        message:
          'core.pipeline.revisionConflict: This pipeline changed since it was read.',
      },
    };
    mockDispatchResource.mockResolvedValueOnce({
      requestId: 'resource',
      ...conflict,
    });

    const result = await h.route(
      action({ type: 'pipeline.update', pipelineId: 'p', name: 'Renamed' }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toEqual({
      requestId: 'toolu_1',
      ...conflict,
    });
  });

  it('reads and presentation actions take no receipt', async () => {
    const h = setup();

    await h.route(action({ type: 'skills.list' }));
    await h.route(
      action({ type: 'navigation.go_to_page', page: 'workflows' }),
      {
        toolUseId: 'toolu_2',
      },
    );

    expect(mockDispatchResource).toHaveBeenCalledTimes(1);
    expect(mockPresent).toHaveBeenCalledTimes(1);
    expect(h.rendererAction).not.toHaveBeenCalled();
    expect(await recordedOperations()).toBe(0);
  });

  it('opening an existing chat tab stays a presentation action', async () => {
    const h = setup();
    const openTab = action({
      type: 'worktree-chat.open_tab',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat-1',
    });

    const result = await h.route(openTab, { expectedUiRevision: 3 });

    expect(result.isError).toBe(false);
    expect(mockPresent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: openTab,
        requestId: 'toolu_1',
        expectedUiRevision: 3,
      }),
    );
    expect(h.rendererAction).not.toHaveBeenCalled();
    expect(await recordedOperations()).toBe(0);

    mockRequestRendererTool.mockResolvedValueOnce({
      requestId: 'toolu_4',
      ok: true,
    });
    const created = createAppAdvisorToolRuntime(
      {
        getMainWindow: () => null,
        getAppAdvisorWindow: () => null,
        openAppAdvisorWindow: jest.fn(),
        ensureAppAdvisorWindow: jest.fn(),
      },
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat',
      },
    );
    if (openTab.type !== 'worktree-chat.open_tab')
      throw new Error('Unexpected action.');
    await created.dispatchRendererAction(openTab, 3, 'toolu_4');
    expect(mockRequestRendererTool).toHaveBeenCalledTimes(1);
  });

  it('a core type never reaches the renderer', async () => {
    const created = createAppAdvisorToolRuntime(
      {
        getMainWindow: () => null,
        getAppAdvisorWindow: () => null,
        openAppAdvisorWindow: jest.fn(),
        ensureAppAdvisorWindow: jest.fn(),
      },
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat',
      },
    );

    const open = action({ type: 'automation.open_editor', id: 'a' });
    if (open.type !== 'automation.open_editor')
      throw new Error('Unexpected action.');
    const response = await created.dispatchRendererAction(
      open,
      undefined,
      'toolu_3',
    );

    expect(response).toEqual({
      requestId: 'toolu_3',
      ok: false,
      error: {
        code: 'unsupported_action',
        message: APP_ADVISOR_ACTION_TEXTS.coreReachedRenderer(
          'automation.open_editor',
        ),
      },
    });
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });
});
