import { relative, sep } from 'node:path';
import type { RepoRulesScanRequest } from '@canopy/protocol/repo-rules';
import {
  WORKSPACE_ROOT_REPO_ID,
  SINGLE_REPO_USAGE_REPO_ID,
} from '@canopy/desktop-shared/types';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { getWorkspaceRepoRulesStatePath } from '../lib/paths';
import { validateId } from '../lib/validation';
import type { RepoCheckout } from './discovery';
import { RepoRulesService } from './service';
import { RepoRulesStateStore } from './state';

/** Trusted local projection. Public callers authorize IDs before entering here. */
export async function resolveRepoRuleCheckouts(
  request: RepoRulesScanRequest,
): Promise<RepoCheckout[]> {
  validateId(request.workspaceId, 'workspaceId');
  if (request.worktreeId) validateId(request.worktreeId, 'worktreeId');
  const { config, authority } = await readWorkspaceConfigDetailed(
    request.workspaceId,
  );
  if (authority !== 'ok' || config.type === 'cowork')
    throw new Error('The code workspace is unavailable.');
  if (request.worktreeId) {
    const worktrees = await readWorkspaceWorktrees(request.workspaceId);
    if (!worktrees.some((w) => w.id === request.worktreeId))
      throw new Error(
        'The checkout is unavailable. Select another checkout and scan again.',
      );
  }
  if (config.repos.length > 31)
    throw new Error('This workspace exceeds the repository scan limit.');
  if (config.type === 'single-repo') {
    const root = request.worktreeId
      ? resolveWorktreeCwd(request.workspaceId, request.worktreeId)
      : config.repoPath;
    if (!root) throw new Error('The repository is unavailable.');
    return [{ repoId: SINGLE_REPO_USAGE_REPO_ID, root, prefix: '' }];
  }
  const repos: RepoCheckout[] = [];
  if (config.sourceRepoPath)
    repos.push({
      repoId: WORKSPACE_ROOT_REPO_ID,
      root: request.worktreeId
        ? resolveWorktreeCwd(request.workspaceId, request.worktreeId)
        : config.sourceRepoPath,
      prefix: '',
    });
  for (const repo of config.repos) {
    validateId(repo.id, 'repoId');
    repos.push({
      repoId: repo.id,
      root: request.worktreeId
        ? resolveWorktreeCwd(request.workspaceId, request.worktreeId, repo.id)
        : repo.repoPath,
      prefix: request.worktreeId ? `repos/${repo.id}` : repo.id,
    });
  }
  return repos;
}
export const repoRulesService: RepoRulesService = new RepoRulesService(
  new RepoRulesStateStore(getWorkspaceRepoRulesStatePath),
  resolveRepoRuleCheckouts,
);

export async function composeWorktreeRepoRules(
  workspaceId: string,
  worktreeId: string,
  cwd: string,
): Promise<string> {
  // Policy is consulted before resolving or touching checkout directories.
  if (!(await repoRulesService.status(workspaceId)).enabled) return '';
  try {
    const repos = await resolveRepoRuleCheckouts({ workspaceId, worktreeId });
    return await repoRulesService.compose(
      workspaceId,
      repos.map((repo) => ({
        ...repo,
        prefix: relative(cwd, repo.root).split(sep).join('/'),
      })),
    );
  } catch {
    return '';
  }
}
