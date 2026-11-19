import { classifyError } from '@canopy/protocol/app-errors/classification';

export class InvalidWorktreePathError extends Error {
  public constructor() {
    super('The worktree path is not a valid path.');
    this.name = 'InvalidWorktreePathError';
    classifyError(this, 'input.not_accepted');
  }
}

/** Git reads a path that starts with '-' as an option, so refuse it first. */
export function refuseOptionLikeWorktreePath(worktreePath: string): void {
  if (worktreePath.startsWith('-')) throw new InvalidWorktreePathError();
}
