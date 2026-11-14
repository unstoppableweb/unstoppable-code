import { installRoutedW5GoldenStore } from '../lib/__tests__/fixtures/w5-routed-golden-store';
// core.workspace.sourceChanges.apply CAN-4063 admission table: recreated for the CAN-5940 source-change slice.
import { execFileSync } from 'node:child_process';
import type * as W5Storage from '../lib/w5-storage';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mockOrder: string[] = [];
let mockAllowed = true;
jest.mock('../lib/w5-storage', () => {
  const actual = jest.requireActual<typeof W5Storage>('../lib/w5-storage');
  return {
    ...actual,
    withStorageAdmission: <T>(
      targets: Parameters<typeof actual.withStorageAdmission>[0],
      run: () => Promise<T>,
    ): Promise<T> => {
      mockOrder.push('admission');
      if (!mockAllowed) return Promise.reject(new Error('admission refused'));
      return actual.withStorageAdmission(targets, run);
    },
  };
});
jest.mock('../lib/project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../lib/workspace-worktree-runtime', () => ({
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
  startWorkspaceRepoSetupAndDiscovery: jest.fn(),
}));
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { applySourceChanges } from '../lib/workspace-source-changes';
import * as git from '../lib/git';
import * as w5Store from '../lib/w5-commit-log-file-store';
import type { SourceChangeGit } from '../canopy-runtime/worker-git-worktree-adapter';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
let root: string;
let saved: NodeJS.ProcessEnv;
function json(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function command(path: string, args: string[]): void {
  execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
}
let closeW5Store: (() => Promise<void>) | undefined;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'source-w5-')));
  saved = { ...process.env };
  process.env.CANOPY_DATA_DIR = join(root, 'data');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  mockOrder.length = 0;
  mockAllowed = true;
  closeW5Store = await installRoutedW5GoldenStore();
});
afterEach(async () => {
  await closeW5Store?.();
  await settleDetachedWork();
  Object.assign(process.env, saved);
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  jest.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
it.each(['project', 'workspace'] as const)(
  'CAN-4063 %s source apply refuses admission before touching its injected Git port',
  async (kind) => {
    const createWorktree = jest.fn(() => Promise.resolve('topic'));
    const injected: SourceChangeGit = {
      createWorktree,
      removeWorktree: jest.fn(),
      bestEffortPruneWorktrees: jest.fn(),
    };
    mockAllowed = false;
    const target = { mode: 'new' as const, existingWorktreeIds: [] };
    const result =
      kind === 'project'
        ? applySourceChanges({
            kind,
            source: 'project_settings',
            request: { projectId: 'workspace', target },
            getWindow: () => null,
            git: injected,
          })
        : applySourceChanges({
            kind,
            source: 'workspace_settings',
            request: { workspaceId: 'workspace', target },
            getWindow: () => null,
            git: injected,
          });
    await expect(result).rejects.toThrow('admission refused');
    expect(mockOrder).toEqual(['admission']);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(injected.removeWorktree).not.toHaveBeenCalled();
    expect(injected.bestEffortPruneWorktrees).not.toHaveBeenCalled();
  },
);
it.each(['project', 'workspace'] as const)(
  'CAN-4063 %s source apply admits before creating a target through the injected port',
  async (kind) => {
    const source = join(root, 'repo');
    mkdirSync(source);
    command(source, ['init', '-qb', 'main']);
    command(source, ['config', 'user.name', 'Golden']);
    command(source, ['config', 'user.email', 'golden@example.com']);
    json(join(source, 'canopy.json'), { version: 1, repos: [] });
    writeFileSync(join(source, '.gitignore'), 'repos/\n');
    command(source, ['add', '.']);
    command(source, ['commit', '-qm', 'initial']);
    const type = kind === 'project' ? 'single-repo' : 'multi-repo';
    registerWorkspaceTypes(new Map([['workspace', type]]));
    json(join(root, 'data/workspaces/index.json'), {
      version: 1,
      workspaces: [{ id: 'workspace', name: 'Workspace', type }],
    });
    json(join(root, 'data/workspaces/workspace/workspace.json'), {
      version: 1,
      type,
      ...(kind === 'project'
        ? { repoPath: source }
        : { sourceRepoPath: source }),
      repos: [],
    });
    json(join(root, 'data/workspaces/workspace/worktrees.json'), {
      version: 1,
      worktrees: [],
    });
    const createWorktree = jest.fn(
      async (...args: Parameters<typeof git.createWorktree>) => {
        mockOrder.push('git');
        return git.createWorktree(...args);
      },
    );
    const injected: SourceChangeGit = {
      createWorktree,
      removeWorktree: git.removeWorktree,
      bestEffortPruneWorktrees: git.bestEffortPruneWorktrees,
    };
    const target = { mode: 'new' as const, existingWorktreeIds: [] };
    const response =
      kind === 'project'
        ? await applySourceChanges({
            kind,
            source: 'project_settings',
            request: { projectId: 'workspace', target },
            getWindow: () => null,
            git: injected,
          })
        : await applySourceChanges({
            kind,
            source: 'workspace_settings',
            request: { workspaceId: 'workspace', target },
            getWindow: () => null,
            git: injected,
          });
    expect(response.createdWorktree).toBe(true);
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(mockOrder[0]).toBe('admission');
    expect(mockOrder.indexOf('git')).toBeGreaterThan(0);
  },
);

it.each(['project', 'workspace'] as const)(
  'CAN-4063 keyed %s source apply refuses wire admission before storage admission or Git',
  async (kind) => {
    const createWorktree = jest.fn(() => Promise.resolve('topic'));
    const removeWorktree = jest.fn();
    const bestEffortPruneWorktrees = jest.fn();
    const injected: SourceChangeGit = {
      createWorktree,
      removeWorktree,
      bestEffortPruneWorktrees,
    };
    const reserve = jest.fn(() => Promise.resolve());
    jest.spyOn(w5Store, 'getW5ReceiptStore').mockReturnValue({
      lookupReceipt: () => Promise.resolve({ status: 'none' }),
      reserve,
      releaseReservation: () => Promise.resolve(),
      markReservationRecoveryRequired: () => Promise.resolve(),
    });
    const wireCall = {
      caller: 'daemon:local-desktop-user:source-changes',
      admit: (): Promise<void> => {
        mockOrder.push('wire-admission');
        return Promise.reject(new Error('wire admission refused'));
      },
    };
    const target = { mode: 'new' as const, existingWorktreeIds: [] };
    const result =
      kind === 'project'
        ? applySourceChanges({
            kind,
            source: 'project_settings',
            request: { projectId: 'workspace', target },
            getWindow: () => null,
            git: injected,
            idempotencyKey: 'review-key',
            wireCall,
          })
        : applySourceChanges({
            kind,
            source: 'workspace_settings',
            request: { workspaceId: 'workspace', target },
            getWindow: () => null,
            git: injected,
            idempotencyKey: 'review-key',
            wireCall,
          });
    await expect(result).rejects.toThrow('wire admission refused');
    expect(mockOrder).toEqual(['wire-admission']);
    expect(reserve).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(bestEffortPruneWorktrees).not.toHaveBeenCalled();
  },
);
