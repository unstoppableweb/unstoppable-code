import { useEffect, useMemo, useState } from 'react';
import type { ReviewApprovalReadinessInput } from '@canopy/protocol/settings/github-review-approvals';
import {
  gitHubRepositoryOfPullRequestUrl,
  gitHubRepositoryOfRemoteUrl,
  reviewApprovalReadinessInput,
  reviewApprovalRunOwnerOf,
} from '@canopy/ui-app/review-approval-link';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * The run owner a project's pipeline runs publish reviews under (CAN-7162):
 * `org:<uuid>` for an organization-owned project, `personal` otherwise. This
 * is the work owner (the project's saved owner binding), never the selected
 * navigation context or membership order.
 */
export function useProjectReviewApprovalRunOwner(projectId: string): string {
  return useProjectsStore((state) =>
    reviewApprovalRunOwnerOf(
      state.projects.find((item) => item.id === projectId)?.owner
        ?.organizationId,
    ),
  );
}

type Repository = { readonly owner: string; readonly name: string };

const NO_REPOSITORIES: readonly Repository[] = [];

/** The distinct GitHub repositories among settled remote lookups. */
function gitHubRepositoriesOf(
  results: readonly PromiseSettledResult<{ remoteUrl: string | null }>[],
): readonly Repository[] {
  const seen = new Set<string>();
  return results.flatMap((result) => {
    const remoteUrl =
      result.status === 'fulfilled' ? result.value.remoteUrl : null;
    const repository =
      remoteUrl === null ? null : gitHubRepositoryOfRemoteUrl(remoteUrl);
    if (repository === null) return [];
    const id = `${repository.owner}/${repository.name}`.toLowerCase();
    if (seen.has(id)) return [];
    seen.add(id);
    return [repository];
  });
}

/**
 * The GitHub repositories of a worktree's git remotes, read only while
 * `enabled` (no open pull request to read them from). Non-GitHub remotes and
 * failed lookups are left out.
 */
function useWorktreeRemoteRepositories(
  projectId: string | undefined,
  worktreeId: string | undefined,
  enabled: boolean,
): readonly Repository[] {
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly repositories: readonly Repository[];
  } | null>(null);
  const key =
    enabled && projectId !== undefined && worktreeId !== undefined
      ? JSON.stringify([projectId, worktreeId])
      : null;

  useEffect(() => {
    if (key === null || projectId === undefined || worktreeId === undefined) {
      return undefined;
    }
    let cancelled = false;
    // A failed lookup is an expected outcome, not an error to surface: the
    // notice is a hint, so an unknown remote just shows no notice.
    void window.api
      .listWorktreeRepoEntries({ projectId, worktreeId })
      .then((entries) =>
        Promise.allSettled(
          entries.map((entry) =>
            window.api.getRemoteUrl({ repoPath: entry.repoPath }),
          ),
        ),
      )
      .then(
        (results) => {
          if (!cancelled) {
            setLoaded({ key, repositories: gitHubRepositoriesOf(results) });
          }
        },
        () => {
          if (!cancelled) setLoaded({ key, repositories: NO_REPOSITORIES });
        },
      );
    return (): void => {
      cancelled = true;
    };
  }, [key, projectId, worktreeId]);

  return loaded !== null && loaded.key === key
    ? loaded.repositories
    : NO_REPOSITORIES;
}

/**
 * Readiness inputs for a code review launched in a worktree, under the
 * project's run owner: each open or draft pull request's base repository;
 * without one, each GitHub remote of the worktree's repositories. Nothing
 * known: no inputs (and no notice).
 */
export function useWorktreeReviewApprovalInputs(
  projectId: string | undefined,
  worktreeId: string | undefined,
): readonly ReviewApprovalReadinessInput[] {
  const runOwner = useProjectReviewApprovalRunOwner(projectId ?? '');
  const prStatus = useGitHubStore((state) =>
    projectId === undefined || worktreeId === undefined
      ? undefined
      : state.prStatuses[worktreeKey(projectId, worktreeId)],
  );
  const fromPullRequests = useMemo((): readonly Repository[] => {
    if (projectId === undefined || !prStatus) return NO_REPOSITORIES;
    return prStatus.repos.flatMap((repo) => {
      const status = repo.status;
      if (status === null) return [];
      if (status.state !== 'open' && status.state !== 'draft') return [];
      const repository = gitHubRepositoryOfPullRequestUrl(status.prUrl);
      return repository === null ? [] : [repository];
    });
  }, [projectId, prStatus]);
  // A personal owner never shows a notice, so it reads no remotes.
  const fromRemotes = useWorktreeRemoteRepositories(
    projectId,
    worktreeId,
    fromPullRequests.length === 0 && runOwner !== 'personal',
  );
  return useMemo(() => {
    const repositories =
      fromPullRequests.length > 0 ? fromPullRequests : fromRemotes;
    return repositories.flatMap((repository) => {
      const input = reviewApprovalReadinessInput(runOwner, repository);
      return input === null ? [] : [input];
    });
  }, [fromPullRequests, fromRemotes, runOwner]);
}
