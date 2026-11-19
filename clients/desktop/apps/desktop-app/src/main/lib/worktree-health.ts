import {
  consumeW5Metadata,
  prepareW5Metadata,
} from './w5-metadata-preparation';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import type {
  WorktreeData,
  WorkspaceConfigFile,
  WorktreeHealthCheckResponse,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import {
  inspectWorktreeHealth,
  type WorktreeHealthSources,
  type WorktreeHealthWorkspace,
} from '@canopy/core-runtime/node/git';
import {
  getGitRequestContext,
  runWithGitRequestContext,
  withGitRequestContextEnv,
} from '@canopy/desktop-shared/node/git-request-context';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import { resolveWorktreeCwd } from './resolve-worktree';
import {
  readWorkspaceWorktrees,
  readWorkspaceConfig,
} from './workspace-persistence';
import { recordWorktreeHealth } from './worktree-repair';
import {
  listWorkspaceWorktreeRepoEntries,
  listWorkspaceWorktreeRepoEntriesFromConfig,
} from './worktree-repo-entries';

const GIT_HEALTH_TIMEOUT_MS = 5000;

async function runGitBounded(args: string[], cwd: string): Promise<string> {
  const executable = await getResolvedGitExecutableForSpawn();
  return await new Promise<string>((resolvePromise, reject) => {
    const child = execFile(
      executable,
      args,
      {
        cwd,
        // The enhanced Git environment main's runGit uses, plus the active
        // request context for diagnostic attribution (CAN-4397).
        env: withGitRequestContextEnv(
          getEnhancedEnv({ includeCanopySecrets: false, environment: false }),
        ),
        timeout: GIT_HEALTH_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout: string | Buffer, stderr: string | Buffer) => {
        if (error) {
          const stderrText =
            typeof stderr === 'string' ? stderr : stderr.toString('utf8');
          const message =
            error instanceof Error ? error.message : 'Git health check failed';
          reject(
            new Error(
              stderrText.trim() ? `${message}\n${stderrText.trim()}` : message,
            ),
          );
          return;
        }
        resolvePromise(
          typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
        );
      },
    );
    void child;
  });
}

async function createBestEffortWorktree(
  projectId: string,
  worktreeId: string,
  healthIssue: WorktreeHealthIssue | null,
): Promise<WorktreeData> {
  const worktrees = await readWorkspaceWorktrees(projectId).catch(() => []);
  const existing = worktrees.find((worktree) => worktree.id === worktreeId);
  const base: WorktreeData = existing ?? {
    id: worktreeId,
    branchName: worktreeId,
    createdAt: new Date().toISOString(),
  };

  if (healthIssue) {
    return { ...base, healthIssue };
  }

  const next: WorktreeData = { ...base };
  delete next.healthIssue;
  delete next.splitRecoveryRequired;
  return next;
}

/**
 * The desktop sources for one worktree's health check (`inspectWorktreeHealth`
 * in core-runtime): today's workspace records, repository listing,
 * filesystem and bounded Git confirmation. Reads only; the worktree list is
 * read without persisting its removal cleanup.
 */
export function desktopWorktreeHealthSources(
  projectId: string,
  worktreeId: string,
  worktreePath: string,
): WorktreeHealthSources {
  return {
    worktreePath,
    readWorkspace: async (): Promise<WorktreeHealthWorkspace> => {
      const config = await readWorkspaceConfig(projectId);
      return {
        type: config.type,
        repos: config.repos,
        hasSourceRepository: Boolean(config.sourceRepoPath),
      };
    },
    listRepositoryEntries: () =>
      listWorkspaceWorktreeRepoEntries(projectId, worktreePath),
    readIncludedRepoIds: async () =>
      (
        await readWorkspaceWorktrees(projectId, {
          persistRemovalCleanup: false,
        })
      ).find((worktree) => worktree.id === worktreeId)?.includedRepoIds,
    stat: (path) => stat(path),
    lstat: (path) => lstat(path),
    readText: (path) => readFile(path, 'utf8'),
    confirmWorkTree: (path) =>
      runGitBounded(['rev-parse', '--is-inside-work-tree'], path),
    now: () => new Date(),
  };
}

/** One implementation: the core-runtime check over the desktop sources. */
export async function validateWorktreeHealth(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeHealthIssue | null> {
  return inspectWorktreeHealth(
    desktopWorktreeHealthSources(
      projectId,
      worktreeId,
      resolveWorktreeCwd(projectId, worktreeId),
    ),
  );
}

/** Opt-in stats phase: short decodes, enumeration outside bindings, included IDs lazy. */
export function validateWorktreeHealthForStats(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeHealthIssue | null> {
  // Keeps the stats request's ID and tags the health check's own launches
  // for diagnostic attribution (CAN-4397).
  return runWithGitRequestContext(
    {
      source: 'worktree-health',
      requestId: getGitRequestContext()?.requestId ?? randomUUID(),
    },
    () => validateWorktreeHealthForStatsInContext(projectId, worktreeId),
  );
}

async function validateWorktreeHealthForStatsInContext(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeHealthIssue | null> {
  const metadata = await prepareW5Metadata({
    kind: 'targeted',
    workspaceId: projectId,
  });
  if (metadata.status === 'fallback')
    return validateWorktreeHealth(projectId, worktreeId);
  const worktreePath = resolveWorktreeCwd(projectId, worktreeId);
  const sources = desktopWorktreeHealthSources(
    projectId,
    worktreeId,
    worktreePath,
  );
  const readConfig = async (): Promise<WorkspaceConfigFile> =>
    (await consumeW5Metadata(metadata.manifest(projectId))).config;
  try {
    return await inspectWorktreeHealth({
      ...sources,
      readWorkspace: async () => {
        const config = await readConfig();
        return {
          type: config.type,
          repos: config.repos,
          hasSourceRepository: Boolean(config.sourceRepoPath),
        };
      },
      listRepositoryEntries: async () => {
        const config = await readConfig().catch(
          (): WorkspaceConfigFile => ({
            version: 1,
            type: 'multi-repo',
            repos: [],
          }),
        );
        return listWorkspaceWorktreeRepoEntriesFromConfig(worktreePath, config);
      },
      readIncludedRepoIds: async () =>
        (await consumeW5Metadata(metadata.worktrees(projectId))).worktrees.find(
          (row) => row.id === worktreeId,
        )?.includedRepoIds,
    });
  } finally {
    await metadata.join();
    metadata.close();
  }
}

/**
 * `internal.worktree.health.record` after a check, then the legacy
 * `worktree:health-check` response, with a best-effort row when the worktree
 * is not in its list.
 */
export async function completeWorktreeHealthCheck(
  projectId: string,
  worktreeId: string,
  issue: WorktreeHealthIssue | null,
): Promise<WorktreeHealthCheckResponse> {
  const recorded = await recordWorktreeHealth({
    source: 'health-check',
    workspaceId: projectId,
    worktreeId,
    issue,
  });
  const worktree =
    recorded.worktree ??
    (await createBestEffortWorktree(projectId, worktreeId, issue));
  return issue
    ? { healthy: false, worktree, issue }
    : { healthy: true, worktree };
}

export async function retryWorktreeHealthCheck(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeHealthCheckResponse> {
  return completeWorktreeHealthCheck(
    projectId,
    worktreeId,
    await validateWorktreeHealth(projectId, worktreeId),
  );
}

/**
 * The legacy response for a scope that has no worktree row to record (a
 * shared-container run directory a code-review entry borrows): the check,
 * then the best-effort row, with no record.
 */
export async function checkUnrecordedWorktreeHealth(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeHealthCheckResponse> {
  const issue = await validateWorktreeHealth(projectId, worktreeId);
  const worktree = await createBestEffortWorktree(projectId, worktreeId, issue);
  return issue
    ? { healthy: false, worktree, issue }
    : { healthy: true, worktree };
}
