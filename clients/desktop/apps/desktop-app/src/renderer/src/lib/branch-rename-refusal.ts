import { toAppError } from '@canopy/protocol/app-errors';
import { branchNameProblem } from '@canopy/protocol/worktree-branch-names';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';

/**
 * Main refuses a name Git rejects and a name another branch holds alike, as
 * `input.not_accepted`, and stable builds carry only that code. The rename
 * fields check Git's rules before they submit, so a refusal for a name that
 * passes them is the other case: a branch with this name, or one it would nest
 * under or over (`robin` beside `robin/api`), already exists.
 */
const BRANCH_NAME_CONFLICT =
  'This name conflicts with an existing branch. Choose a different name.';

/**
 * The sentence for a branch rename main refused as input (CAN-7293), or null
 * for any other failure, which keeps its own handling.
 */
export function branchRenameRefusalText(
  error: unknown,
  name: string,
): string | null {
  const appError = toAppError(resolveClientAppError(error));
  if (appError?.code !== 'input.not_accepted') return null;
  return branchNameProblem(name) ?? BRANCH_NAME_CONFLICT;
}
