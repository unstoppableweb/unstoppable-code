jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

/**
 * One recording backend behind both the window's preload APIs and Electron
 * main's owners, so the same workflow read through either port can be
 * compared.
 */
const mockCalls: string[] = [];
const PIPELINE = {
  name: 'Nightly',
  scope: ['project'],
  jobs: { build: { steps: [{ id: 'echo', run: 'echo hi' }] } },
};
const mockProjects = [
  { id: 'single', type: 'single-repo', repoPath: '/repos/single' },
  {
    id: 'multi',
    type: 'multi-repo',
    sourceRepoPath: '/repos/multi-source',
    repos: [{ id: 'web', repoPath: '/repos/multi/web' }],
    worktrees: [{ id: 'w1' }],
  },
  { id: 'cowork', type: 'cowork' },
];
const mockBackend = {
  list: (): Promise<object> => {
    mockCalls.push('pipelines.list');
    return Promise.resolve({
      success: true,
      data: [{ id: 'nightly', source: 'user', name: 'Nightly' }],
    });
  },
  get: (request: unknown): Promise<object> => {
    mockCalls.push(`pipelines.get ${JSON.stringify(request)}`);
    return Promise.resolve({ success: true, data: { content: PIPELINE } });
  },
  getShared: (request: unknown): Promise<object> => {
    mockCalls.push(`pipelines.getShared ${JSON.stringify(request)}`);
    return Promise.resolve({ success: false, error: 'Not shared.' });
  },
  discoverProject: (cwd: string): Promise<object> => {
    mockCalls.push(`pipelines.discoverProject ${cwd}`);
    return Promise.resolve({
      success: true,
      data: [
        {
          id: 'nightly',
          source: 'project',
          filename: 'nightly.yaml',
          filePath: `${cwd}/.canopy/pipelines/nightly.yaml`,
        },
      ],
    });
  },
  getWorktreePath: (request: unknown): Promise<string> => {
    mockCalls.push(`api.getWorktreePath ${JSON.stringify(request)}`);
    return Promise.resolve('/worktrees/w1');
  },
  loadProjects: (): Promise<object> => {
    mockCalls.push('api.loadProjects');
    return Promise.resolve({ items: mockProjects });
  },
  getWorkspaceSettingsData: (request: unknown): Promise<object> => {
    mockCalls.push(`api.getWorkspaceSettingsData ${JSON.stringify(request)}`);
    return Promise.resolve({ referenceRepoPath: '/repos/multi-reference' });
  },
  resolvePin: (request: unknown): Promise<object> => {
    mockCalls.push(`automations.resolvePin ${JSON.stringify(request)}`);
    return Promise.resolve({
      installPin: { contentHash: 'pin' },
      rawPipeline:
        'name: Shared nightly\non: dispatch\nscope: [global]\njobs:\n  build:\n    steps:\n      - id: echo\n        run: echo hi\n',
    });
  },
};

jest.mock('../../pipelines/pipeline-handlers', () => ({
  listPipelinesForCaller: (): Promise<object> => mockBackend.list(),
  getPipelineForCaller: (request: unknown): Promise<object> =>
    mockBackend.get(request),
  getSharedPipelineForCaller: (request: unknown): Promise<object> =>
    mockBackend.getShared(request),
  discoverProjectPipelinesForCaller: (cwd: string): Promise<object> =>
    mockBackend.discoverProject(cwd),
}));
jest.mock('../../ipc/open-in', () => ({
  getWorktreePathForCaller: (request: unknown): Promise<string> =>
    mockBackend.getWorktreePath(request),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<object> => mockBackend.loadProjects(),
}));
jest.mock('../../ipc/workspaces', () => ({
  readWorkspaceSettingsDataForCaller: (request: unknown): Promise<object> =>
    mockBackend.getWorkspaceSettingsData(request),
}));
jest.mock('../../ipc/automations', () => ({
  resolveSharedPipelinePinForCaller: (request: unknown): Promise<object> =>
    mockBackend.resolvePin(request),
}));

import {
  resolveAutomationPipelineScopes,
  resolveSessionTargetKind,
} from '@canopy/desktop-shared/lib/automation-share/automation-targets';
import { loadAutomationPipelineDocument } from '@canopy/desktop-shared/lib/automation-share/pipeline-document';
import type { PipelineReadPort } from '@canopy/desktop-shared/lib/automation-share/port';
import type { AutomationAction } from '@canopy/desktop-shared/types';
import { mainPipelineReadPort } from '../pipeline-read-port';

type PipelineAction = Extract<AutomationAction, { type: 'worktree_pipeline' }>;

/** The window's preload APIs over the same backend. */
const windowPort = {
  pipelines: {
    list: () => mockBackend.list(),
    get: (request: unknown) => mockBackend.get(request),
    getShared: (request: unknown) => mockBackend.getShared(request),
    discoverProject: (cwd: string) => mockBackend.discoverProject(cwd),
  },
  api: {
    getWorktreePath: (request: unknown) => mockBackend.getWorktreePath(request),
    loadProjects: () => mockBackend.loadProjects(),
    getWorkspaceSettingsData: (request: unknown) =>
      mockBackend.getWorkspaceSettingsData(request),
    automations: {
      resolveSharedPipelineInstallPin: (request: unknown) =>
        mockBackend.resolvePin(request),
    },
  },
} as never as PipelineReadPort;

const PIPELINE_ACTIONS: Record<string, PipelineAction> = {
  user: {
    type: 'worktree_pipeline',
    pipelineId: 'nightly',
    pipelineSource: 'user',
  },
  bundled: { type: 'worktree_pipeline', pipelineId: 'nightly' },
  'project, base worktree': {
    type: 'worktree_pipeline',
    pipelineId: 'nightly',
    pipelineSource: 'project',
    workspaceId: 'multi',
    baseWorktreeId: 'w1',
    repoId: 'web',
  },
  'project, single-repo folder': {
    type: 'worktree_pipeline',
    pipelineId: 'nightly',
    pipelineSource: 'project',
    workspaceId: 'single',
    target: { kind: 'project' },
  },
  'project, multi-repo reference': {
    type: 'worktree_pipeline',
    pipelineId: 'nightly',
    pipelineSource: 'project',
    workspaceId: 'multi',
    target: { kind: 'new_worktree' },
  },
  'project, cowork root': {
    type: 'worktree_pipeline',
    pipelineId: 'nightly',
    pipelineSource: 'project',
    workspaceId: 'cowork',
    target: { kind: 'project' },
  },
  'project, missing project': {
    type: 'worktree_pipeline',
    pipelineId: 'nightly',
    pipelineSource: 'project',
    workspaceId: 'gone',
    target: { kind: 'project' },
  },
  shared: {
    type: 'worktree_pipeline',
    pipelineId: 'nightly',
    pipelineSource: 'shared',
    sharedPipeline: { serverId: 's', remoteId: 'remote-1' },
  },
};

async function readWith(
  port: PipelineReadPort,
  read: (port: PipelineReadPort) => Promise<unknown>,
): Promise<{ calls: string[]; result: unknown }> {
  mockCalls.length = 0;
  const result = await read(port);
  return { calls: [...mockCalls], result };
}

describe("reading an automation's workflow in main (CAN-6003 part B)", () => {
  it.each(Object.entries(PIPELINE_ACTIONS))(
    'resolves the same scopes through either port: %s',
    async (_label, action) => {
      const read = (port: PipelineReadPort): Promise<unknown> =>
        resolveAutomationPipelineScopes(port, action);
      const viaWindow = await readWith(windowPort, read);
      const viaMain = await readWith(mainPipelineReadPort, read);
      expect(viaMain).toEqual(viaWindow);
      expect(viaWindow.calls.length).toBeGreaterThan(0);
    },
  );

  it('loads the same document and checkout through either port', async () => {
    const action = PIPELINE_ACTIONS['project, base worktree'];
    const read = (port: PipelineReadPort): Promise<unknown> =>
      loadAutomationPipelineDocument(port, action);
    const viaWindow = await readWith(windowPort, read);
    await expect(readWith(mainPipelineReadPort, read)).resolves.toEqual(
      viaWindow,
    );
    expect(viaWindow.result).toMatchObject({
      data: { content: PIPELINE },
      worktree: { projectId: 'multi', worktreeId: 'w1', repoId: 'web' },
    });
  });

  it('resolves the shared workflow from its install pin', async () => {
    await expect(
      resolveAutomationPipelineScopes(
        mainPipelineReadPort,
        PIPELINE_ACTIONS.shared,
      ),
    ).resolves.toEqual({ status: 'resolved', scopes: ['global'] });
  });

  it.each([
    ['cowork', 'cowork'],
    ['multi', 'multi-repo'],
    ['gone', undefined],
  ])(
    "resolves a session prompt's project kind the same way: %s",
    async (workspaceId, kind) => {
      const read = (port: PipelineReadPort): Promise<unknown> =>
        resolveSessionTargetKind(port, {
          type: 'worktree_session_prompt',
          workspaceId,
          worktreeId: 'w1',
          chatId: 'c1',
          prompt: 'Summarize.',
        } as never);
      const viaWindow = await readWith(windowPort, read);
      await expect(readWith(mainPipelineReadPort, read)).resolves.toEqual(
        viaWindow,
      );
      expect(viaWindow.result).toBe(kind);
    },
  );

  it('lists the projects the window lists: retired temporary workspaces are hidden', async () => {
    mockProjects.push({
      id: 'retired',
      type: 'multi-repo',
      temporary: true,
      repos: [],
      worktrees: [],
    } as never);
    try {
      const { items } = await mainPipelineReadPort.api.loadProjects();
      expect(items.map((item) => item.id)).toEqual([
        'single',
        'multi',
        'cowork',
      ]);
    } finally {
      mockProjects.pop();
    }
  });
});
