export type ChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'type-changed'
  | 'untracked'
  | 'unknown';

export interface ChangedFileInfo {
  path: string;
  status: ChangedFileStatus;
  insertions: number;
  deletions: number;
  /** Trusted prior path supplied by the backend for rename/copy records. */
  previousPath?: string;
  /** Renderer-safe repository identity; never a repository filesystem path. */
  repoId?: string;
  /** Renderer-safe display name; never a repository filesystem path. */
  repoName?: string;
  /**
   * Binary content: git reports no line counts for it, so `insertions` and
   * `deletions` are 0 and carry no meaning (REG-3024).
   */
  binary?: boolean;
}

export interface TurnDiffTreeRef {
  startTree: string;
  endTree: string;
  repoId?: string;
  startHeadCommitSha?: string;
}
