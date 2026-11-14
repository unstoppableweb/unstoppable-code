import type { CreateBranchResponse } from '@canopy/desktop-shared/types';
import { useGitHubStore } from '@/stores/githubStore';

export function showBranchCheckoutWarning(
  warning: CreateBranchResponse['warning'],
  projectId: string,
  worktreeId: string,
): void {
  if (warning?.code !== 'checkout-command-failed') return;
  const upstream = {
    configured: 'Upstream is configured.',
    partial: 'Upstream is partially configured.',
    unset: 'Upstream is unset.',
  }[warning.upstream];
  // Confirm the switch so a hook failure doesn't prompt another create.
  useGitHubStore
    .getState()
    .addToast(
      `Branch checked out. Git reported an error after switching. ${upstream}`,
      'warning',
      undefined,
      { category: 'Worktree', projectId, worktreeId },
    );
}
