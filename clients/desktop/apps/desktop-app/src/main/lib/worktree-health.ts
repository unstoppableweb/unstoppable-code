import {
  consumeW5Metadata,
  prepareW5Metadata,
} from './w5-metadata-preparation';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import type {
  WorktreeData,
  WorkspaceConfigFile,
  WorktreeHealthCheckResponse,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import {
  GitRepositoryReadError,
  createRecordedWorkerGitHosts,
  inspectWorktreeHealth,
  type GitRepositoryReader,
  type WorktreeHealthSources,
  type WorktreeHealthWorkspace,
} from '@canopy/core-runtime/node/git';
import {
  getGitRequestContext,
  runWithGitRequestContext,
  withGitRequestContextEnv,
} from '@canopy/desktop-shared/node/git-request-context';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  type WorkerGitDiffGetParams,
} from '@canopy/protocol/canopy-core';
import { classifyPersistedWorkspaceOwner } from '@canopy/protocol/workspace-owner';
import { getDataDir } from './paths';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import { resolveWorktreeCwd } from './resolve-worktree';
import {
  getWorkspaceManifestRepository,
  readWorkspaceWorktrees,
  readWorkspaceConfig,
} from './workspace-persistence';
import { getWorkspaceType } from './workspace-registry';
import { recordWorktreeHealth } from './worktree-repair';
import {
  listWorkspaceWorktreeRepoEntries,
  listWorkspaceWorktreeRepoEntriesFromConfig,
} from './worktree-repo-entries';

const GIT_HEALTH_TIMEOUT_MS = 5000;

async function runGitBounded(
  args: string[],
  cwd: string,
  beforeLaunch?: AbortSignal,
): Promise<string> {
  beforeLaunch?.throwIfAborted();
  const executable = await getResolvedGitExecutableForSpawn();
  beforeLaunch?.throwIfAborted();
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
 * read without persisting its removal cleanup. A `signal` stops the
 * repository listing and the Git confirmation before any later read or Git
 * launch.
 */
export function desktopWorktreeHealthSources(
  projectId: string,
  worktreeId: string,
  worktreePath: string,
  signal?: AbortSignal,
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
      listWorkspaceWorktreeRepoEntries(projectId, worktreePath, signal),
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
      runGitBounded(['rev-parse', '--is-inside-work-tree'], path, signal),
    now: () => new Date(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A recorded path both readers agree on. The daemon reader drops a string
 * path that is empty, relative or contains NUL (its `usablePath`) where main
 * keeps it, so the two would judge the worktree differently.
 */
function recordedPath(value: unknown): boolean {
  return (
    typeof value !== 'string' ||
    (value !== '' && isAbsolute(value) && !value.includes('\0'))
  );
}

/** A repository the daemon's recorded reader accepts (its `safeId` rule). */
function recordedRepo(repo: unknown): boolean {
  return (
    isRecord(repo) &&
    typeof repo.id === 'string' &&
    repo.id.length <= 512 &&
    /^[a-z0-9][a-z0-9-]*$/.test(repo.id) &&
    typeof repo.name === 'string' &&
    typeof repo.repoPath === 'string' &&
    recordedPath(repo.repoPath)
  );
}

/**
 * Whether the daemon's recorded reader accepts this workspace's manifest as
 * it stands on disk. Main normalizes values that reader refuses, and a
 * refusal from a daemon that answered is final, so every manifest it would
 * refuse keeps its health check in process. Each check mirrors one refusal in
 * `readWorkspace` (core-runtime `recorded-worker-git-hosts.ts`), over the same
 * raw read (`readWorkspaceManifest`).
 */
// shortcut: these guards mirror the daemon reader's checks in core-runtime recorded-worker-git-hosts.ts (usablePath :210-217, readWorkspace :310-378), so a new daemon refusal or dropped value must be mirrored here; export a shared predicate the next time that reader is touched.
export async function workspaceManifestReadable(
  workspaceId: string,
): Promise<boolean> {
  const read = await getWorkspaceManifestRepository().read(workspaceId);
  if (read.authority !== 'ok') return false;
  const manifest = read.document;
  const declared =
    manifest.type === undefined
      ? typeof manifest.repoPath === 'string'
        ? 'single-repo'
        : 'multi-repo'
      : manifest.type;
  return (
    declared === getWorkspaceType(workspaceId) &&
    (manifest.workspaceId === undefined ||
      manifest.workspaceId === workspaceId) &&
    (manifest.targetId === undefined ||
      manifest.targetId === CANOPY_IN_PROCESS_WORKER_TARGET_ID) &&
    // shortcut: main can't see the daemon's authority id before the host lookup, so any recorded one stays in process; compare it if desktop starts writing one.
    manifest.authorityId === undefined &&
    classifyPersistedWorkspaceOwner(manifest.owner).kind !== 'malformed' &&
    recordedPath(manifest.repoPath) &&
    recordedPath(manifest.sourceRepoPath) &&
    (manifest.repos === undefined ||
      (Array.isArray(manifest.repos) && manifest.repos.every(recordedRepo)))
  );
}

// The diff resolver runs no Git; if that ever changes, admission fails closed to in process.
const NO_GIT: GitRepositoryReader = {
  read: () => Promise.reject(new GitRepositoryReadError('git_unavailable')),
  selectExecutable: () =>
    Promise.reject(new GitRepositoryReadError('git_unavailable')),
};

/**
 * Pre-contact admission for a daemon diff read (CAN-4729): the daemon's own
 * recorded resolver (recorded-worker-git-hosts.ts), over these records, names
 * main's checkout `repoPath`. The manifest check adds main's stricter
 * authority rule. A refusal or a throw lists in process.
 */
export async function diffScopeAdmitted(
  params: WorkerGitDiffGetParams,
  repoPath: string,
  context: CanopyHandlerContext,
): Promise<boolean> {
  if (!(await workspaceManifestReadable(params.scope.workspaceId ?? '')))
    return false;
  const resolved = await createRecordedWorkerGitHosts({
    dataRoot: await realpath(getDataDir()),
    authorityId: context.caller.authorityId,
    recordsTargetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
    os: hostPlatformOperatingSystem(),
    arch: process.arch,
    git: NO_GIT,
  }).diff.resolveRepository(params, context);
  return (
    resolved !== null &&
    (await realpath(resolved)) === (await realpath(repoPath))
  );
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
