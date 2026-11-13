/**
 * CAN-6010: Electron main and the CLI list a worktree's code-graph
 * repositories the same way, so a checkout is graphed under the same ids
 * whichever host builds or reads it: the CLI's in-process build and reads,
 * the counterparts of worker.codeGraph.build and worker.codeGraph.query, use
 * the ids Electron main and the daemon use. The CLI and the core daemon agree
 * end to end in `apps/desktop-cli/src/__tests__/code-graph-daemon-cli.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorktreeCliCodeGraphRepositories } from '@canopy/desktop-shared/node/lib/worktree-cli-reads';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import { listWorkspaceWorktreeRepoEntriesFromConfig } from '../worktree-repo-entries';

let dataDir: string;
let previousDataDir: string | undefined;

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function gitRepository(directory: string): void {
  mkdirSync(directory, { recursive: true });
  execFileSync('git', ['init', '--quiet', directory]);
}

/** One project with one worktree, recorded the way the app records it. */
function project(
  id: string,
  config: WorkspaceConfigFile,
  worktreePath: string,
): void {
  writeJson(join(dataDir, 'workspaces', id, 'workspace.json'), config);
  writeJson(join(dataDir, 'workspaces', id, 'worktrees.json'), {
    version: 1,
    worktrees: [
      { id: 'main', branchName: 'main', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  });
  mkdirSync(worktreePath, { recursive: true });
}

beforeAll(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'code-graph-repo-ids-')));
  previousDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: 'single',
        name: 'Single',
        type: 'single-repo',
        color: '#93c5fd',
        collapsed: false,
        order: 0,
      },
      {
        id: 'multi',
        name: 'Multi',
        type: 'multi-repo',
        color: '#93c5fd',
        collapsed: false,
        order: 1,
      },
      {
        id: 'ordered',
        name: 'Ordered',
        type: 'multi-repo',
        color: '#93c5fd',
        collapsed: false,
        order: 2,
      },
    ],
  });
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function idsFromBothHosts(
  workspaceId: string,
  config: WorkspaceConfigFile,
  worktreePath: string,
): Promise<{ electron: string[]; cli: string[] }> {
  const electron = await listWorkspaceWorktreeRepoEntriesFromConfig(
    worktreePath,
    config,
  );
  const { listed } = await listWorktreeCliCodeGraphRepositories(
    workspaceId,
    worktreePath,
  );
  return {
    electron: electron.map((entry) => entry.repoId),
    cli: listed.map((repository) => repository.repoId),
  };
}

describe('code-graph repository ids across hosts (CAN-6010)', () => {
  it('lists a single-repo checkout with a repos/ folder as its named repositories on both hosts', async () => {
    const worktreePath = join(dataDir, 'checkouts', 'single');
    const config: WorkspaceConfigFile = {
      version: 1,
      type: 'single-repo',
      repoPath: worktreePath,
      repos: [],
    };
    project('single', config, worktreePath);
    gitRepository(worktreePath);
    gitRepository(join(worktreePath, 'repos', 'example'));

    await expect(
      idsFromBothHosts('single', config, worktreePath),
    ).resolves.toEqual({ electron: ['example'], cli: ['example'] });
  });

  it('lists a multi-repo checkout as its root and member repositories on both hosts', async () => {
    const worktreePath = join(dataDir, 'checkouts', 'multi');
    const config: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [],
    };
    project('multi', config, worktreePath);
    gitRepository(worktreePath);
    gitRepository(join(worktreePath, 'repos', 'member'));

    await expect(
      idsFromBothHosts('multi', config, worktreePath),
    ).resolves.toEqual({
      electron: ['__workspace_root__', 'member'],
      cli: ['__workspace_root__', 'member'],
    });
  });
  it('keeps the configured order for the CLI, so its implicit repository is unchanged', async () => {
    // Configured zulu then alpha; on disk readdir lists alpha first.
    const worktreePath = join(dataDir, 'checkouts', 'ordered');
    const config: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [
        {
          id: 'zulu',
          name: 'Zulu',
          repoPath: join(dataDir, 'sources', 'zulu'),
        },
        {
          id: 'alpha',
          name: 'Alpha',
          repoPath: join(dataDir, 'sources', 'alpha'),
        },
      ],
    };
    project('ordered', config, worktreePath);
    gitRepository(join(worktreePath, 'repos', 'alpha'));
    gitRepository(join(worktreePath, 'repos', 'zulu'));

    const { electron, cli } = await idsFromBothHosts(
      'ordered',
      config,
      worktreePath,
    );
    expect([...electron].sort()).toEqual([...cli].sort());
    expect(cli).toEqual(['zulu', 'alpha']);
  });
});
