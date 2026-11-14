/** Host facts and effects for the legacy worktree-add policy. */
export interface GitWorktreeAddPort {
  fetch(): Promise<void>;
  defaultBranch(): Promise<string | null>;
  localBranchExists(branch: string): Promise<boolean>;
  availableBranchName(branch: string): Promise<string>;
  add(
    branch: string,
    startPoint: string | null,
    create: boolean,
  ): Promise<void>;
}
export async function addGitWorktree(
  port: GitWorktreeAddPort,
  branch: string,
): Promise<string> {
  const [, defaultBranch] = await Promise.all([
    port.fetch(),
    port.defaultBranch(),
  ]);
  if (await port.localBranchExists(branch)) {
    await port.add(branch, null, false);
    return branch;
  }
  const resolved = await port.availableBranchName(branch);
  await port.add(
    resolved,
    defaultBranch ? `refs/remotes/origin/${defaultBranch}` : null,
    true,
  );
  return resolved;
}
