interface WorktreeBaseSourceRequest {
  baseWorktreeId?: string;
  baseBranch?: string;
  existingBranch?: string;
}

export function assertMutuallyExclusiveWorktreeBaseSources(
  request: WorktreeBaseSourceRequest,
): void {
  const hasBaseWorktree =
    typeof request.baseWorktreeId === 'string' &&
    request.baseWorktreeId.trim().length > 0;
  const hasBaseBranch =
    typeof request.baseBranch === 'string' && request.baseBranch.length > 0;
  const hasExistingBranch =
    typeof request.existingBranch === 'string' &&
    request.existingBranch.length > 0;

  // An existing branch is checkout intent, not another source for the tracked
  // comparison base. It may therefore carry baseBranch: the existing branch
  // wins checkout/name resolution while baseBranch is validated and persisted
  // as tracked-base metadata. baseWorktreeId remains exclusive because it
  // derives that tracked base from another worktree's current branch(es).
  if (hasBaseWorktree && (hasBaseBranch || hasExistingBranch)) {
    throw new Error(
      'baseWorktreeId is mutually exclusive with baseBranch and existingBranch',
    );
  }
}

export function validateOptionalWorktreeBaseBranch(
  baseBranch: string | undefined,
): string | undefined {
  if (baseBranch === undefined) return undefined;
  if (!baseBranch || baseBranch.startsWith('-') || baseBranch === 'HEAD') {
    throw new Error(
      'baseBranch must be a valid branch name and cannot be HEAD.',
    );
  }
  return baseBranch;
}
