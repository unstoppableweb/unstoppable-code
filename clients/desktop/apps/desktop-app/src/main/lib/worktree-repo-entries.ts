import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { CodeGraphRepositoryInput } from '@canopy/desktop-shared/types/code-graph';
import {
  codeGraphBuildRepositories,
  listCodeGraphWorktreeRepositories,
} from '@canopy/code-graph/host/worktree-repositories';
import { isGitRepo } from './git';
import { readWorkspaceConfig } from './workspace-persistence';

export interface WorktreeRepoEntry {
  repoId: string;
  repoName: string;
  repoPath: string;
}

interface WorkspaceRepoEntries {
  config: WorkspaceConfigFile;
  entries: WorktreeRepoEntry[];
}

/** Reads one workspace's normalized manifest. */
export type WorkspaceConfigReader = (
  workspaceId: string,
) => Promise<WorkspaceConfigFile>;

async function loadWorkspaceWorktreeRepoEntries(
  workspaceId: string,
  worktreePath: string,
  signal?: AbortSignal,
  readConfig: WorkspaceConfigReader = readWorkspaceConfig,
): Promise<WorkspaceRepoEntries> {
  const emptyConfig: WorkspaceConfigFile = {
    version: 1,
    type: 'multi-repo',
    repos: [],
  };
  const config = await readConfig(workspaceId).catch(
    (): WorkspaceConfigFile => emptyConfig,
  );
  return enumerateWorkspaceWorktreeRepoEntries(worktreePath, config, signal);
}

/** A `signal` stops the listing before each later read or Git launch. */
async function enumerateWorkspaceWorktreeRepoEntries(
  worktreePath: string,
  config: WorkspaceConfigFile,
  signal?: AbortSignal,
): Promise<WorkspaceRepoEntries> {
  signal?.throwIfAborted();
  const repoNameById = new Map(
    config.repos.map((repo) => [repo.id, repo.name]),
  );
  const repositories = await listCodeGraphWorktreeRepositories(
    worktreePath,
    {
      multiRepo: config.type === 'multi-repo',
      hasSourceRepo:
        config.type === 'multi-repo' && Boolean(config.sourceRepoPath),
    },
    signal
      ? async (directory): Promise<boolean> => {
          signal.throwIfAborted();
          const repo = await isGitRepo(directory, signal);
          signal.throwIfAborted();
          return repo;
        }
      : isGitRepo,
  );
  const repoEntries = repositories.map(
    (repository): WorktreeRepoEntry => ({
      repoId: repository.repoId,
      repoName:
        repository.repoId === WORKSPACE_ROOT_REPO_ID
          ? WORKSPACE_ROOT_REPO_NAME
          : (repoNameById.get(repository.repoId) ?? repository.repoId),
      repoPath: repository.rootPath,
    }),
  );

  return { config, entries: repoEntries };
}

/**
 * `readConfig` defaults to today's manifest read; only the read-cache
 * readers (CAN-7835) pass their own. Worktree health keeps the default on
 * purpose: it must agree with the daemon's reader on disk.
 */
export async function listWorkspaceWorktreeRepoEntries(
  workspaceId: string,
  worktreePath: string,
  signal?: AbortSignal,
  readConfig?: WorkspaceConfigReader,
): Promise<WorktreeRepoEntry[]> {
  return (
    await loadWorkspaceWorktreeRepoEntries(
      workspaceId,
      worktreePath,
      signal,
      readConfig,
    )
  ).entries;
}

/** Stats phase enumeration uses its own normalized local config, not effective repos. */
export async function listWorkspaceWorktreeRepoEntriesFromConfig(
  worktreePath: string,
  config: WorkspaceConfigFile,
): Promise<WorktreeRepoEntry[]> {
  return (await enumerateWorkspaceWorktreeRepoEntries(worktreePath, config))
    .entries;
}

/** Canonical graph descriptor resolution shared by scheduler and tool builds. */
export async function resolveWorktreeCodeGraphRepositories(
  workspaceId: string,
  worktreePath: string,
): Promise<CodeGraphRepositoryInput[]> {
  const { config, entries } = await loadWorkspaceWorktreeRepoEntries(
    workspaceId,
    worktreePath,
  );
  return codeGraphBuildRepositories(
    worktreePath,
    config.type === 'multi-repo',
    entries.map((entry) => ({
      repoId: entry.repoId,
      rootPath: entry.repoPath,
    })),
  );
}
