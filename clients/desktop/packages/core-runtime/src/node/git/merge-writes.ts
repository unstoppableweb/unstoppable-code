import type { WorkerGitMergeResult } from '@canopy/protocol/canopy-core';
import {
  GIT_BRANCH_HEAD_CHANGED_MESSAGE,
  GitBranchWriteInterrupted,
  GitBranchWriteRefusal,
} from './branch-writes';
import { parseGitBranchName, type GitRefName } from './ref-name';

/** Host-owned worktree handles never appear on the wire. No effect takes a signal. */
export interface GitMergeWritePort {
  currentBranch(this: void): Promise<string>;
  repositoryRoot(this: void): Promise<string>;
  localBranchExists(this: void, root: string, branch: string): Promise<boolean>;
  baseWorktree(
    this: void,
    root: string,
    branch: string,
  ): Promise<string | null>;
  temporaryWorktree(this: void): string;
  addWorktree(
    this: void,
    root: string,
    path: string,
    branch: GitRefName,
  ): Promise<void>;
  isDirty(this: void, path: string): Promise<boolean>;
  merge(
    this: void,
    path: string,
    source: GitRefName,
    base: GitRefName,
  ): Promise<void>;
  hasUnmergedPaths(this: void, path: string): Promise<boolean>;
  abort(this: void, path: string): Promise<void>;
  head(this: void, path: string): Promise<string>;
  removeWorktree(this: void, root: string, path: string): Promise<void>;
}

export type GitMergeRefusalReason =
  | 'sameBranch'
  | 'baseNotFound'
  | 'uncommittedChanges'
  | 'headChanged';
export class GitMergeRefusal extends Error {
  constructor(
    readonly reason: GitMergeRefusalReason,
    message: string,
  ) {
    super(message);
  }
}

/** Preserves the desktop's source-into-base direction and best-effort cleanup. */
export async function mergeGitBranches(
  port: GitMergeWritePort,
  sourceName: string,
  baseName: string,
  expectedBranch?: string,
): Promise<WorkerGitMergeResult> {
  // CAN-7169: a clone can name a local branch like an option, so only names
  // Git would accept as branches reach the merge.
  const source = parseGitBranchName(sourceName);
  const base = parseGitBranchName(baseName);
  if (!source || !base)
    throw new GitBranchWriteRefusal(
      'invalid-name',
      'The branch name is not a valid branch name.',
    );
  if (source === base)
    throw new GitMergeRefusal(
      'sameBranch',
      'Source and base branches must be different',
    );
  const root = await port.repositoryRoot();
  if (!(await port.localBranchExists(root, base)))
    throw new GitMergeRefusal(
      'baseNotFound',
      `Base branch "${base}" does not exist locally`,
    );
  const existing = await port.baseWorktree(root, base);
  const path = existing ?? port.temporaryWorktree();
  if (existing === null) await port.addWorktree(root, path, base);
  try {
    if (await port.isDirty(path))
      throw new GitMergeRefusal(
        'uncommittedChanges',
        `Cannot merge into "${base}" because its worktree has uncommitted changes`,
      );
    if (
      expectedBranch !== undefined &&
      (await port.currentBranch()) !== expectedBranch
    )
      throw new GitMergeRefusal('headChanged', GIT_BRANCH_HEAD_CHANGED_MESSAGE);
    try {
      await port.merge(path, source, base);
    } catch (error) {
      if (error instanceof GitBranchWriteInterrupted) throw error;
      // Classification must precede abort; it must never replace Git's failure.
      const conflict = await port.hasUnmergedPaths(path).catch(() => false);
      await port.abort(path).catch(() => undefined);
      if (conflict) return { outcome: 'conflict' };
      throw error;
    }
    return { outcome: 'merged', mergeCommitHash: await port.head(path) };
  } finally {
    if (existing === null)
      await port.removeWorktree(root, path).catch(() => undefined);
  }
}
