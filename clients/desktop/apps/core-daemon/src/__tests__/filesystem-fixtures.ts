import { execFile } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as paths from 'node:path';
import { promisify } from 'node:util';
import {
  createFileIndexingMatchPolicy,
  hostPlatformOperatingSystem,
} from '@canopy/core-platform';
import {
  createDirectoryReadPreferenceSource,
  createReadOnlyDirectoryInputs,
  type GitIgnoreCheckRequest,
  type GitIgnoredListingRequest,
  type GitIgnoreHostPort,
  type ReadOnlyDirectoryInputs,
} from '@canopy/core-runtime/node';
import {
  createRecordedWorkerGitHosts,
  GitRepositoryReadError,
  type GitRepositoryReader,
  type GitRepositoryWritePort,
  type RecordedWorkerGitHosts,
} from '@canopy/core-runtime/node/git';
import { CANOPY_IN_PROCESS_WORKER_TARGET_ID } from '@canopy/protocol/canopy-core';

export const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const binding = (organizationId: string): Record<string, unknown> => ({
  type: 'organization',
  organizationId,
  projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  bindingGeneration: 0,
});

export const SCOPES = {
  single: { workspaceId: 'single', worktreeId: 'task' },
  multi: { workspaceId: 'multi', worktreeId: 'task' },
  cowork: { workspaceId: 'cowork' },
  teamA: { workspaceId: 'team-a', worktreeId: 'task' },
  teamB: { workspaceId: 'team-b', worktreeId: 'task' },
  malformed: { workspaceId: 'malformed', worktreeId: 'task' },
} as const;

async function json(
  dataRoot: string,
  relative: string,
  document: unknown,
): Promise<void> {
  const target = paths.join(dataRoot, relative);
  await mkdir(paths.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(document));
}

async function file(
  dataRoot: string,
  relative: string,
  content = '',
): Promise<void> {
  const target = paths.join(dataRoot, relative);
  await mkdir(paths.dirname(target), { recursive: true });
  await writeFile(target, content);
}

export function worktreeHome(dataRoot: string, workspaceId: string): string {
  return paths.join(dataRoot, 'workspaces', workspaceId, 'worktrees', 'task');
}

/**
 * Real tracking records: single-repo, multi-repo and Cowork, plus Personal,
 * two organization owners and one malformed owner, with a custom index policy.
 */
export async function seedFilesystemRecords(dataRoot: string): Promise<void> {
  const tracked: [string, string][] = [
    ['single', 'single-repo'],
    ['multi', 'multi-repo'],
    ['cowork', 'cowork'],
    ['team-a', 'single-repo'],
    ['team-b', 'single-repo'],
    ['malformed', 'single-repo'],
  ];
  await json(dataRoot, 'workspaces/index.json', {
    version: 1,
    workspaces: tracked.map(([id, type]) => ({
      id,
      name: id,
      type,
      color: '#fff',
    })),
  });
  const owners: Record<string, unknown> = {
    'team-a': binding(TEAM_A.toUpperCase()),
    'team-b': binding(TEAM_B),
    malformed: { type: 'organization', organizationId: 'team-a' },
  };
  for (const [id, type] of tracked) {
    await json(dataRoot, `workspaces/${id}/workspace.json`, {
      version: 1,
      type,
      ...(type === 'multi-repo'
        ? {
            sourceRepoPath: '/source',
            repos: [{ id: 'api', name: 'API', repoPath: '/untrusted' }],
          }
        : { repos: [] }),
      ...(owners[id] !== undefined && { owner: owners[id] }),
    });
    if (type === 'cowork') continue;
    await json(dataRoot, `workspaces/${id}/worktrees.json`, {
      version: 1,
      worktrees: [{ id: 'task', branchName: 'topic', createdAt: 'now' }],
    });
    await file(dataRoot, `workspaces/${id}/worktrees/task/README.md`, id);
  }
  const single = 'workspaces/single/worktrees/task';
  await file(dataRoot, `${single}/b.txt`);
  await file(dataRoot, `${single}/A.txt`);
  await file(dataRoot, `${single}/dist/out.js`);
  await file(dataRoot, `${single}/src/index.ts`);
  await file(dataRoot, `${single}/.git/HEAD`);
  await file(dataRoot, `${single}-outside/secret`, 'private');
  await symlink(
    paths.join(dataRoot, `${single}/src`),
    paths.join(dataRoot, `${single}/inside`),
    'dir',
  );
  await symlink(
    paths.join(dataRoot, `${single}-outside`),
    paths.join(dataRoot, `${single}/escape`),
    'dir',
  );
  await file(dataRoot, 'workspaces/single/attachments/task/image.png', 'png');
  await file(dataRoot, 'workspaces/multi/worktrees/task/repos/api/index.ts');
  await file(dataRoot, 'workspaces/cowork/home/doc.md');
  await file(dataRoot, 'workspaces/cowork/home/.canopy/notes/note.md');
  await mkdir(paths.join(dataRoot, 'workspaces/cowork/home/.canopy/prompts'), {
    recursive: true,
  });
  await writeFile(
    paths.join(dataRoot, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        fileIndexing: {
          disabledBuiltinGlobIds: [],
          customGlobs: [{ id: 'dist', pattern: 'dist/**', enabled: true }],
        },
        gitExecutablePath: '',
      },
    }),
  );
}

/**
 * This process's environment without `GIT_*`, so a test run from a Git hook
 * never points Git at the enclosing repository.
 */
export function gitFreeEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

/**
 * Makes the single worktree a real Git repository: `dist/` and `*.log` are
 * ignored, and `node_modules` is excluded only by the built-in index policy.
 */
export async function initGitRepository(dataRoot: string): Promise<string> {
  const home = worktreeHome(dataRoot, 'single');
  await rm(paths.join(home, '.git'), { recursive: true, force: true });
  await promisify(execFile)('git', ['init', '--quiet', home], {
    env: gitFreeEnvironment(),
  });
  await writeFile(paths.join(home, '.gitignore'), 'dist/\n*.log\n');
  await writeFile(paths.join(home, 'debug.log'), '');
  await file(dataRoot, 'workspaces/single/worktrees/task/node_modules/x/i.js');
  return home;
}

export type FakeGit = GitIgnoreHostPort & {
  readonly requests: GitIgnoreCheckRequest[];
  readonly listings: GitIgnoredListingRequest[];
};

/** A Git ignore port for tests only; production composes the real host. */
export function fakeGit(
  behavior: (request: GitIgnoreCheckRequest) => Promise<Set<string>> = () =>
    Promise.resolve(new Set(['dist'])),
  listing: (request: GitIgnoredListingRequest) => Promise<string[]> = () =>
    Promise.resolve(['dist/']),
): FakeGit {
  const requests: GitIgnoreCheckRequest[] = [];
  const listings: GitIgnoredListingRequest[] = [];
  return {
    requests,
    listings,
    checkIgnoredPaths: (request): Promise<Set<string>> => {
      requests.push(request);
      return behavior(request);
    },
    listIgnoredPathEntries: (request): Promise<string[]> => {
      listings.push(request);
      return listing(request);
    },
  };
}

export function directoryInputsFor(
  dataRoot: string,
  git: GitIgnoreHostPort,
): ReadOnlyDirectoryInputs {
  return createReadOnlyDirectoryInputs({
    preferences: createDirectoryReadPreferenceSource({
      canonicalDataRoot: dataRoot,
      paths,
    }),
    matchPolicy: createFileIndexingMatchPolicy(hostPlatformOperatingSystem()),
    git,
  });
}

/** Resolves once the request is aborted, rejecting with its reason. */
export function untilAborted(request: GitIgnoreCheckRequest): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      const reason: unknown = request.signal.reason;
      reject(reason instanceof Error ? reason : new Error('Aborted.'));
    };
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
  });
}

/** A repository reader for graphs whose tests run no Git query. */
export const UNAVAILABLE_GIT_READER: GitRepositoryReader = {
  read: () => Promise.reject(new GitRepositoryReadError('git_unavailable')),
  selectExecutable: () =>
    Promise.reject(new GitRepositoryReadError('git_unavailable')),
};

/** The daemon's recorded `worker.git` hosts over `dataRoot`'s records. */
export function gitHostsFor(
  dataRoot: string,
  authorityId: string,
  git: GitRepositoryReader = UNAVAILABLE_GIT_READER,
  writes?: GitRepositoryWritePort,
): RecordedWorkerGitHosts {
  return createRecordedWorkerGitHosts({
    dataRoot,
    authorityId,
    recordsTargetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
    os: process.platform,
    arch: process.arch,
    git,
    ...(writes && { writes }),
  });
}
