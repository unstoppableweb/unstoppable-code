// Multi-repo worktrees give a Google (Antigravity) chat every repository, not
// only the selected one (CHAT-06). The worktree's other repositories become
// the session's `additionalDirectories` when the runtime's ACP initialization
// advertises the capability; otherwise none are sent, because the ACP client
// refuses directories the runtime did not advertise. Relative or missing repository paths are dropped
// rather than failing the turn. A break hides the other repositories from the
// model or stops multi-repo chats from opening.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InitializeResponse } from '@agentclientprotocol/sdk';
import {
  acpSupportsAdditionalDirectories,
  additionalDirectoriesParam,
} from '@canopy/desktop-shared/node/acp/capabilities';
import type { WorktreeRepoEntry } from '../../lib/worktree-repo-entries';

const mockRepoEntries = new Map<string, WorktreeRepoEntry[]>();
jest.mock('../../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: (
    workspaceId: string,
  ): Promise<WorktreeRepoEntry[]> =>
    Promise.resolve(mockRepoEntries.get(workspaceId) ?? []),
}));

import { registerWorkspaceTypes } from '../../lib/workspace-registry';
import { antigravityAdditionalDirectories } from '../workspace-directories';

let root: string;
let repoA: string;
let repoB: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'antigravity-dirs-'));
  repoA = join(root, 'repos', 'a');
  repoB = join(root, 'repos', 'b');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  registerWorkspaceTypes(
    new Map([
      ['multi', 'multi-repo'],
      ['single', 'single-repo'],
    ]),
  );
  mockRepoEntries.clear();
  mockRepoEntries.set('multi', [
    { repoId: 'a', repoName: 'A', repoPath: repoA },
    { repoId: 'b', repoName: 'B', repoPath: repoB },
  ]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  registerWorkspaceTypes(new Map());
});

function initialization(advertised: boolean): InitializeResponse {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      sessionCapabilities: advertised ? { additionalDirectories: {} } : {},
    },
  };
}

describe('Antigravity additional workspace directories (CHAT-06)', () => {
  it('forwards the other repositories of a multi-repo worktree', async () => {
    const directories = await antigravityAdditionalDirectories({
      projectId: 'multi',
      worktreeId: 'wt',
      cwd: repoA,
    });
    expect(directories).toEqual([repoB]);

    const supported = acpSupportsAdditionalDirectories(initialization(true));
    expect(supported).toBe(true);
    expect(additionalDirectoriesParam(directories, supported)).toEqual({
      additionalDirectories: [repoB],
    });
  });

  it('sends the workspace root repository when a child repository is the cwd', async () => {
    mockRepoEntries.set('multi', [
      { repoId: '__root__', repoName: 'Root', repoPath: root },
      { repoId: 'a', repoName: 'A', repoPath: repoA },
      { repoId: 'b', repoName: 'B', repoPath: repoB },
    ]);
    await expect(
      antigravityAdditionalDirectories({
        projectId: 'multi',
        worktreeId: 'wt',
        cwd: repoA,
      }),
    ).resolves.toEqual([root, repoB]);
    // From the root, every repository is already reachable inside the cwd.
    await expect(
      antigravityAdditionalDirectories({
        projectId: 'multi',
        worktreeId: 'wt',
        cwd: root,
      }),
    ).resolves.toEqual([]);
  });

  it('sends nothing for a single-repo worktree', async () => {
    mockRepoEntries.set('single', [
      { repoId: 'a', repoName: 'A', repoPath: repoA },
      { repoId: 'b', repoName: 'B', repoPath: repoB },
    ]);
    await expect(
      antigravityAdditionalDirectories({
        projectId: 'single',
        worktreeId: 'wt',
        cwd: repoA,
      }),
    ).resolves.toEqual([]);
  });

  it('omits relative and missing repository paths', async () => {
    mockRepoEntries.set('multi', [
      { repoId: 'a', repoName: 'A', repoPath: repoA },
      { repoId: 'rel', repoName: 'Rel', repoPath: join('repos', 'b') },
      {
        repoId: 'gone',
        repoName: 'Gone',
        repoPath: join(root, 'repos', 'gone'),
      },
      { repoId: 'b', repoName: 'B', repoPath: repoB },
    ]);
    await expect(
      antigravityAdditionalDirectories({
        projectId: 'multi',
        worktreeId: 'wt',
        cwd: repoA,
      }),
    ).resolves.toEqual([repoB]);
  });

  it('sends no directories when the runtime lacks the capability', async () => {
    const directories = await antigravityAdditionalDirectories({
      projectId: 'multi',
      worktreeId: 'wt',
      cwd: repoA,
    });
    expect(directories).toEqual([repoB]);

    // The ACP client refuses a session that sends directories the runtime
    // did not advertise, so omitting them is what keeps the session opening.
    const supported = acpSupportsAdditionalDirectories(initialization(false));
    expect(supported).toBe(false);
    expect(additionalDirectoriesParam(directories, supported)).toEqual({});
  });
});
