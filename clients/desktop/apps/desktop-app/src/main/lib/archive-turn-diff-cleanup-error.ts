export const archiveCleanupChecks = [
  'cleanup-journal-unqualified',
  'cleanup-project-unavailable',
  'cleanup-journal-changed',
  'cleanup-worktree-listed',
  'cleanup-recovery-held',
  'cleanup-path-present',
  'cleanup-repositories-unavailable',
  'cleanup-evidence-unavailable',
  'cleanup-worktree-missing',
  'cleanup-repositories-changed',
] as const;
export type ArchiveCleanupCheck = (typeof archiveCleanupChecks)[number];

/** Ordinary cleanup interruption, never a destructive admission refusal. */
export class ArchiveTurnDiffCleanupError extends Error {
  readonly code = 'ARCHIVE_TURN_DIFF_CLEANUP_FAILED';
  constructor(
    readonly check: ArchiveCleanupCheck,
    readonly underlying?: unknown,
  ) {
    super(check);
    this.name = 'ArchiveTurnDiffCleanupError';
  }
}
