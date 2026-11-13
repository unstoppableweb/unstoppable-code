export type WorkspaceDeletionRefusal =
  | 'protected'
  | 'configuration-unavailable'
  | 'not-single-repo'
  | 'not-cowork'
  | 'git-cleanup-pending'
  | 'archive-recovery-unverified'
  | 'source-unavailable'
  | 'archive-in-progress';

/** An admission check refused the deletion before anything was removed. */
export class WorkspaceDeletionRefusedError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  /** The admission check's own failure, when it caused the refusal. */
  declare readonly cause?: unknown;

  constructor(
    readonly reason: WorkspaceDeletionRefusal,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'WorkspaceDeletionRefusedError';
    if (cause !== undefined) this.cause = cause;
  }
}
