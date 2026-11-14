import {
  consumeW5Metadata,
  prepareW5Metadata,
  readPreparedW5Worktrees,
  type PreparedW5Metadata,
} from './w5-metadata-preparation';
import { basename } from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import {
  doesLocalBranchExist,
  doesRemoteBranchExist,
  getCurrentBranch,
  getLocalDefaultBranch,
  getRepoRootFromWorktree,
  hasLocalCommit,
} from './git';
import { resolveFreshDefaultBranch } from './git-default-branch';
import { resolveWorktreeCwd } from './resolve-worktree';
import {
  listWorkspaceWorktreeRepoEntries,
  listWorkspaceWorktreeRepoEntriesFromConfig,
} from './worktree-repo-entries';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from './workspace-persistence';

export interface EffectiveRepoBaseBranch {
  branch: string | null;
  existsLocally: boolean;
  existsInRemote: boolean;
}

interface WorktreeBaseBranchState {
  isMultiRepo: boolean;
  trackedBaseBranch: string | null;
  trackedRepoBaseBranches: Record<string, string>;
  hasWorkspaceRootRepo: boolean;
  localConfig: WorkspaceConfigFile;
}

function nonemptyBranchName(
  branchName: string | null | undefined,
): string | null {
  return branchName || null;
}

function normalizeTrackedRepoBaseBranches(
  trackedRepoBaseBranches: WorktreeData['trackedRepoBaseBranches'],
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [repoId, branchName] of Object.entries(
    trackedRepoBaseBranches ?? {},
  )) {
    const normalizedBranchName = nonemptyBranchName(branchName);
    if (normalizedBranchName) {
      normalized[repoId] = normalizedBranchName;
    }
  }

  return normalized;
}

async function readTrackedBaseBranchState(
  projectId: string,
  worktreeId: string,
  metadata?: PreparedW5Metadata,
): Promise<WorktreeBaseBranchState> {
  const [config, worktrees] = await Promise.all([
    metadata
      ? consumeW5Metadata(metadata.manifest(projectId)).then(
          ({ config }) => config,
        )
      : readWorkspaceConfig(projectId),
    metadata
      ? readPreparedW5Worktrees(metadata, projectId).then(
          ({ worktrees }) => worktrees,
        )
      : readWorkspaceWorktrees(projectId),
  ]);
  const worktree = worktrees.find((candidate) => candidate.id === worktreeId);

  return {
    localConfig: config,
    isMultiRepo: config.type === 'multi-repo',
    trackedBaseBranch: nonemptyBranchName(worktree?.trackedBaseBranch),
    trackedRepoBaseBranches: normalizeTrackedRepoBaseBranches(
      worktree?.trackedRepoBaseBranches,
    ),
    hasWorkspaceRootRepo: Boolean(config.sourceRepoPath),
  };
}

async function getSingleRepoId(repoPath: string): Promise<string> {
  const repoRoot = await getRepoRootFromWorktree(repoPath).catch(
    () => repoPath,
  );
  return basename(repoRoot);
}

async function resolveConfiguredBaseBranch(
  params: {
    projectId: string;
    worktreeId: string;
    repoId?: string;
    repoPath: string;
    allowRemoteLookup?: boolean;
  },
  state: WorktreeBaseBranchState,
): Promise<string | null> {
  if (!state.isMultiRepo) {
    if (state.trackedBaseBranch) {
      return state.trackedBaseBranch;
    }

    const remoteDefaultBranch = nonemptyBranchName(
      await resolveFreshDefaultBranch(params.repoPath, {
        allowRemoteLookup: params.allowRemoteLookup,
      }).catch(() => null),
    );
    if (remoteDefaultBranch) {
      return remoteDefaultBranch;
    }

    const currentBranch = nonemptyBranchName(
      await getCurrentBranch(params.repoPath).catch(() => null),
    );
    return getLocalDefaultBranch(
      params.repoPath,
      currentBranch ?? undefined,
    ).catch(() => null);
  }

  let resolvedRepoId = params.repoId;
  if (!resolvedRepoId && state.hasWorkspaceRootRepo) {
    const worktreePath = resolveWorktreeCwd(
      params.projectId,
      params.worktreeId,
    );
    if (worktreePath === params.repoPath) {
      resolvedRepoId = WORKSPACE_ROOT_REPO_ID;
    }
  }

  if (resolvedRepoId) {
    const trackedRepoBaseBranch = state.trackedRepoBaseBranches[resolvedRepoId];
    if (trackedRepoBaseBranch) {
      return trackedRepoBaseBranch;
    }
  }

  const remoteDefaultBranch = nonemptyBranchName(
    await resolveFreshDefaultBranch(params.repoPath, {
      allowRemoteLookup: params.allowRemoteLookup,
    }).catch(() => null),
  );
  if (remoteDefaultBranch) {
    return remoteDefaultBranch;
  }

  const currentBranch = nonemptyBranchName(
    await getCurrentBranch(params.repoPath).catch(() => null),
  );
  return getLocalDefaultBranch(
    params.repoPath,
    currentBranch ?? undefined,
  ).catch(() => null);
}
/**
 * Resolves the repo's default branch (remote default, falling back to the
 * local default) for branch-grouping in the sidebar. Returns `null` when it
 * cannot be determined. Independent of any user-configured base-branch
 * override so the default branch can be excluded from grouping even when a
 * worktree explicitly tracks it.
 */
export async function resolveRepoDefaultBranch(
  repoPath: string,
  options: { allowRemoteLookup?: boolean } = {},
): Promise<string | null> {
  const remoteDefaultBranch = nonemptyBranchName(
    await resolveFreshDefaultBranch(repoPath, options).catch(() => null),
  );
  if (remoteDefaultBranch) {
    return remoteDefaultBranch;
  }

  return nonemptyBranchName(
    await getLocalDefaultBranch(repoPath).catch(() => null),
  );
}

export async function resolveEffectiveBaseBranchForRepo(params: {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  repoPath: string;
  allowRemoteLookup?: boolean;
}): Promise<EffectiveRepoBaseBranch> {
  const state = await readTrackedBaseBranchState(
    params.projectId,
    params.worktreeId,
  );
  return resolveEffectiveBaseBranchWithState(params, state);
}

async function resolveEffectiveBaseBranchWithState(
  params: Parameters<typeof resolveEffectiveBaseBranchForRepo>[0],
  state: WorktreeBaseBranchState,
): Promise<EffectiveRepoBaseBranch> {
  const branch = await resolveConfiguredBaseBranch(params, state);
  if (!branch) {
    return { branch: null, existsLocally: false, existsInRemote: false };
  }

  const { existsLocally, existsInRemote } = await resolveBaseBranchPresence(
    params.repoPath,
    branch,
  );
  return { branch, existsLocally, existsInRemote };
}

async function resolveBaseBranchPresence(
  repoPath: string,
  branch: string,
): Promise<Pick<EffectiveRepoBaseBranch, 'existsLocally' | 'existsInRemote'>> {
  if (
    /^[a-fA-F0-9]{40}$/.test(branch) &&
    (await hasLocalCommit(repoPath, branch).catch(() => false))
  ) {
    return {
      existsLocally: true,
      existsInRemote: false,
    };
  }

  const [existsLocally, existsInRemote] = await Promise.all([
    doesLocalBranchExist(repoPath, branch).catch(() => false),
    doesRemoteBranchExist(repoPath, branch).catch(() => false),
  ]);
  return { existsLocally, existsInRemote };
}

export async function resolveEffectiveBaseBranchesForWorktree(params: {
  projectId: string;
  worktreeId: string;
  cwd: string;
  allowRemoteLookup?: boolean;
}): Promise<Record<string, EffectiveRepoBaseBranch>> {
  const state = await readTrackedBaseBranchState(
    params.projectId,
    params.worktreeId,
  );
  return resolveEffectiveBaseBranchesWithState(params, state, false);
}

async function resolveEffectiveBaseBranchesWithState(
  params: Parameters<typeof resolveEffectiveBaseBranchesForWorktree>[0],
  state: WorktreeBaseBranchState,
  usePhaseConfig: boolean,
): Promise<Record<string, EffectiveRepoBaseBranch>> {
  if (!state.isMultiRepo) {
    const repoId = await getSingleRepoId(params.cwd);
    return {
      [repoId]: await resolveEffectiveBaseBranchForRepo({
        projectId: params.projectId,
        worktreeId: params.worktreeId,
        repoPath: params.cwd,
        allowRemoteLookup: params.allowRemoteLookup,
      }),
    };
  }

  const repoEntries = usePhaseConfig
    ? await listWorkspaceWorktreeRepoEntriesFromConfig(
        params.cwd,
        state.localConfig,
      )
    : await listWorkspaceWorktreeRepoEntries(params.projectId, params.cwd);
  const effectiveEntries = await Promise.all(
    repoEntries.map(async (entry) => {
      const branch = await resolveConfiguredBaseBranch(
        {
          projectId: params.projectId,
          worktreeId: params.worktreeId,
          repoId: entry.repoId,
          repoPath: entry.repoPath,
          allowRemoteLookup: params.allowRemoteLookup,
        },
        state,
      );
      const { existsLocally, existsInRemote } = branch
        ? await resolveBaseBranchPresence(entry.repoPath, branch)
        : { existsLocally: false, existsInRemote: false };
      return {
        repoId: entry.repoId,
        effectiveBaseBranch: {
          branch,
          existsLocally,
          existsInRemote,
        },
      };
    }),
  );

  const effectiveByRepo: Record<string, EffectiveRepoBaseBranch> = {};
  for (const entry of effectiveEntries) {
    effectiveByRepo[entry.repoId] = entry.effectiveBaseBranch;
  }

  return effectiveByRepo;
}

async function readStatsBaseBranchState(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeBaseBranchState | undefined> {
  const metadata = await prepareW5Metadata({
    kind: 'targeted',
    workspaceId: projectId,
  });
  if (metadata.status === 'fallback') return undefined;
  try {
    return await readTrackedBaseBranchState(projectId, worktreeId, metadata);
  } finally {
    await metadata.join();
    metadata.close();
  }
}

/** Fresh post-effect phase, selected only by stats. */
export async function resolveEffectiveBaseBranchesForStats(
  params: Parameters<typeof resolveEffectiveBaseBranchesForWorktree>[0],
): Promise<Record<string, EffectiveRepoBaseBranch>> {
  const state = await readStatsBaseBranchState(
    params.projectId,
    params.worktreeId,
  );
  return state
    ? resolveEffectiveBaseBranchesWithState(params, state, true)
    : resolveEffectiveBaseBranchesForWorktree(params);
}

export async function resolveEffectiveBaseBranchForStats(
  params: Parameters<typeof resolveEffectiveBaseBranchForRepo>[0],
): Promise<EffectiveRepoBaseBranch> {
  const state = await readStatsBaseBranchState(
    params.projectId,
    params.worktreeId,
  );
  return state
    ? resolveEffectiveBaseBranchWithState(params, state)
    : resolveEffectiveBaseBranchForRepo(params);
}
