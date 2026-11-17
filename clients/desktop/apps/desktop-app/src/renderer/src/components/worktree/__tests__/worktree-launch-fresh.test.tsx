/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SidebarItem,
  SingleRepoSidebarItem,
  WorktreeEffectiveOverrides,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useScriptsStore } from '@/stores/scriptsStore';
import { useWorktreeEffective } from '@/hooks/useWorktreeEffective';
import { dispatchAppAction } from '@/lib/app-actions/dispatcher';
import { hasRunScripts } from '@/components/activity/script-utils';
import {
  launchWorktreeFresh,
  resolveWorktreeLaunchEntry,
} from '../worktree-launch';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT: SingleRepoSidebarItem = {
  type: 'single-repo',
  id: 'project',
  name: 'Project',
  repoPath: '/repo',
  color: '#3B82F6',
  collapsed: false,
  order: 0,
  worktrees: [
    { id: 'changed', branchName: 'changed', createdAt: '2026-11-16T00:00:00Z' },
    { id: 'removed', branchName: 'removed', createdAt: '2026-11-16T00:00:01Z' },
  ],
  effectiveScripts: { launch: 'pnpm dev' },
};

let reads: Record<string, WorktreeEffectiveOverrides>;
let readFails: boolean;
const getWorktreeEffective = jest.fn(
  (request: {
    projectId: string;
    worktreeIds?: string[];
  }): Promise<Record<string, WorktreeEffectiveOverrides>> =>
    readFails
      ? Promise.reject(new Error('unreadable'))
      : Promise.resolve(
          Object.fromEntries(
            (request.worktreeIds ?? []).flatMap((id) =>
              reads[id] ? [[id, reads[id]]] : [],
            ),
          ),
        ),
);
const runScript = jest.fn(() =>
  Promise.resolve({
    success: true,
    exitCode: 0,
    output: '',
    timedOut: false,
    durationMs: 0,
  }),
);
const addToast = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getWorktreeEffective, runScript },
  });
});

beforeEach(() => {
  reads = {
    changed: { effectiveScripts: { launch: 'pnpm start:branch' } },
    removed: { effectiveScripts: {} },
  };
  readFails = false;
  getWorktreeEffective.mockClear();
  runScript.mockClear();
  addToast.mockClear();
  useGitHubStore.setState({ addToast });
  useScriptsStore.setState({ runs: {} });
  useProjectsStore.setState({
    projects: [{ ...PROJECT }],
    projectsLoadCount: 0,
    appliedProjectWorktreeScripts: {},
  });
});

/** Lets the store's read of the worktree land. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function launchedScripts(): unknown[] {
  return runScript.mock.calls.map((call) => (call as unknown[])[0]);
}

it("shows the project's launch state for a row never opened", () => {
  const entry = resolveWorktreeLaunchEntry(
    useProjectsStore.getState().projects[0],
    'changed',
    {},
  );
  expect(entry?.script.command).toBe('pnpm dev');
  expect(getWorktreeEffective).not.toHaveBeenCalled();
});

it("runs a branch's own changed launch command, read now", async () => {
  await launchWorktreeFresh('project', 'changed');
  expect(getWorktreeEffective).toHaveBeenCalledWith({
    projectId: 'project',
    worktreeIds: ['changed'],
  });
  expect(launchedScripts()).toEqual([
    expect.objectContaining({ worktreeId: 'changed', scriptName: 'launch' }),
  ]);
  const scripts = useScriptsStore.getState().runs['project/changed'];
  expect(Object.values(scripts ?? {}).map((run) => run.command)).toEqual([
    'pnpm start:branch',
  ]);
});

it('runs nothing for a branch that removed its launch script', async () => {
  await launchWorktreeFresh('project', 'removed');
  expect(runScript).not.toHaveBeenCalled();
  expect(addToast).toHaveBeenCalledWith(
    'This worktree has no launch command',
    'warning',
  );
});

it("runs nothing when the worktree's scripts can't be read", async () => {
  readFails = true;
  await launchWorktreeFresh('project', 'changed');
  expect(runScript).not.toHaveBeenCalled();
  expect(addToast).toHaveBeenCalledWith(
    "Couldn't read this worktree's launch command",
    'warning',
  );
});

it('keeps the selected worktree fresh across project loads', async () => {
  function Selected(): null {
    useWorktreeEffective('project', 'changed');
    return null;
  }
  const container = document.createElement('div');
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(<Selected />);
    await settle();
  });
  expect(getWorktreeEffective).toHaveBeenCalledTimes(1);
  reads.changed = { effectiveScripts: { launch: 'pnpm start:edited' } };
  await act(async () => {
    useProjectsStore.setState({ projectsLoadCount: 1 });
    await settle();
  });
  expect(getWorktreeEffective).toHaveBeenCalledTimes(2);
  const project = useProjectsStore.getState().projects[0];
  expect(
    project.type === 'cowork'
      ? undefined
      : project.worktreeEffective?.changed?.effectiveScripts?.launch,
  ).toBe('pnpm start:edited');
  act(() => root?.unmount());
});

it('starts one launch for two quick clicks while the read is pending', async () => {
  let release: () => void = () => undefined;
  getWorktreeEffective.mockImplementationOnce(
    (): Promise<Record<string, WorktreeEffectiveOverrides>> =>
      new Promise((resolve) => {
        release = (): void => resolve({ changed: reads.changed });
      }),
  );
  const first = launchWorktreeFresh('project', 'changed');
  const second = launchWorktreeFresh('project', 'changed');
  release();
  await Promise.all([first, second]);
  expect(runScript).toHaveBeenCalledTimes(1);
});

it('launches from the tunneled entry while controlling another computer', async () => {
  const api = (window as unknown as { api: Record<string, unknown> }).api;
  api.remoteControl = {
    getContext: (): { mode: 'remote' } => ({ mode: 'remote' }),
  };
  try {
    useProjectsStore.setState({
      projects: [
        {
          ...PROJECT,
          worktreeEffective: { changed: reads.changed },
        },
      ],
    });
    await launchWorktreeFresh('project', 'changed');
    expect(getWorktreeEffective).not.toHaveBeenCalled();
    expect(launchedScripts()).toEqual([
      expect.objectContaining({ worktreeId: 'changed', scriptName: 'launch' }),
    ]);
  } finally {
    delete api.remoteControl;
  }
});

it('runs a workspace lifecycle once for two quick Runs while the read is pending', async () => {
  const multi = {
    type: 'multi-repo',
    id: 'workspace',
    name: 'Workspace',
    color: '#3B82F6',
    collapsed: false,
    order: 1,
    repos: [],
    worktrees: [
      {
        id: 'changed',
        branchName: 'changed',
        createdAt: '2026-11-16T00:00:00Z',
      },
    ],
    effectiveScripts: {},
  } as unknown as SidebarItem;
  useProjectsStore.setState({ projects: [multi] });
  let release: () => void = (): void => undefined;
  getWorktreeEffective.mockImplementationOnce(
    (): Promise<Record<string, WorktreeEffectiveOverrides>> =>
      new Promise((resolve) => {
        release = (): void =>
          resolve({
            changed: { effectiveScripts: { 'before-launch': 'pnpm dev' } },
          });
      }),
  );
  const first = useProjectsStore
    .getState()
    .launchWorkspace('workspace', 'changed');
  const second = useProjectsStore
    .getState()
    .launchWorkspace('workspace', 'changed');
  await expect(second).rejects.toThrow('Project launch is already running');
  release();
  await first;
  expect(runScript).toHaveBeenCalledTimes(1);
});

it("refuses a lifecycle run when the worktree's scripts can't be read", async () => {
  const multi = {
    type: 'multi-repo',
    id: 'workspace',
    name: 'Workspace',
    color: '#3B82F6',
    collapsed: false,
    order: 1,
    repos: [],
    worktrees: [
      {
        id: 'changed',
        branchName: 'changed',
        createdAt: '2026-11-16T00:00:00Z',
      },
    ],
    effectiveScripts: { 'before-teardown': 'pnpm project-teardown' },
  } as unknown as SidebarItem;
  useProjectsStore.setState({ projects: [multi] });
  readFails = true;
  await expect(
    useProjectsStore.getState().teardownWorkspace('workspace', 'changed'),
  ).rejects.toThrow("Couldn't read this worktree's scripts");
  expect(runScript).not.toHaveBeenCalled();
});

/** Any other preload call resolves to nothing; records what was called. */
function stubApi(called: string[], name = 'api'): unknown {
  return new Proxy(() => undefined, {
    get: (_target, key) =>
      key === 'then' ? undefined : stubApi(called, `${name}.${String(key)}`),
    apply: () => {
      called.push(name);
      return Promise.resolve(undefined);
    },
  });
}

it("keeps a worktree whose teardown script can't be read", async () => {
  const called: string[] = [];
  const api = {
    getWorktreeEffective,
    runScript,
    checkWorktreeRemovalAdmission: (): Promise<{ status: 'admitted' }> =>
      Promise.resolve({ status: 'admitted' }),
  };
  const fallback = stubApi(called) as Record<string, unknown>;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy(api, {
      get: (target, key: string): unknown =>
        key in target ? target[key as keyof typeof api] : fallback[key],
    }),
  });
  try {
    reads.changed = { effectiveScripts: { teardown: 'pnpm branch-teardown' } };
    readFails = true;
    await expect(
      useProjectsStore.getState().archiveWorktree('project', 'changed'),
    ).rejects.toThrow("Couldn't read this worktree's scripts");
    expect(runScript).not.toHaveBeenCalled();
    expect(
      called.filter((name) => /archive(Workspace)?Worktree$/.test(name)),
    ).toEqual([]);
    const kept = useProjectsStore
      .getState()
      .projects.find((project) => project.id === 'project');
    expect(
      kept && kept.type !== 'cowork'
        ? kept.worktrees.map((worktree) => worktree.id)
        : [],
    ).toContain('changed');
  } finally {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getWorktreeEffective, runScript },
    });
  }
});

it("refuses to pause hooks when the worktree's hooks can't be read", async () => {
  const setWorktreePausedHookKeys = jest.fn(() => Promise.resolve());
  useProjectsStore.setState({
    hasHydratedProjects: true,
    setWorktreePausedHookKeys,
  });
  readFails = true;
  const response = await dispatchAppAction({
    requestId: 'pause-unreadable-hooks',
    source: 'assistant',
    action: {
      type: 'hook.pause',
      projectId: 'project',
      worktreeId: 'changed',
      all: true,
    },
  });
  expect(response.ok).toBe(false);
  expect(setWorktreePausedHookKeys).not.toHaveBeenCalled();
});

it('hides Launch, rather than refusing it, once a branch without a launch script is read', async () => {
  await useProjectsStore
    .getState()
    .ensureWorktreeEffective('project', ['removed']);
  const project = useProjectsStore.getState().projects[0];
  if (!project) throw new Error('missing project');
  expect(resolveWorktreeLaunchEntry(project, 'removed', {})).toBeUndefined();
  expect(
    hasRunScripts(
      useProjectsStore.getState().projects,
      'project',
      'removed',
      {},
    ),
  ).toBe(false);
  expect(resolveWorktreeLaunchEntry(project, 'changed', {})).toBeDefined();
});
