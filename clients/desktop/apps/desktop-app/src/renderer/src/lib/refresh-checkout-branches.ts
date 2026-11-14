import type {
  ListBranchesRequest,
  ListBranchesResponse,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';

/** Read the checkout after Git has answered, including after a partial failure. */
export async function refreshCheckoutBranches(
  request: ListBranchesRequest,
): Promise<ListBranchesResponse & { branchName: string }> {
  const response = await window.api.listBranches(request);
  const branchName =
    response.branches.find((branch) => branch.isCurrent)?.name ?? 'HEAD';
  const projects = useProjectsStore.getState();
  projects.updateBranchName(
    request.projectId,
    request.worktreeId,
    branchName,
    request.repoId,
  );
  void projects.refreshDiffStats();
  return { ...response, branchName };
}
