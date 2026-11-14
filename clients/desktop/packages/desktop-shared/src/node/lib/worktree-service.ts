export { ensureAgentsMdSymlinkOrCopy } from './worktree-create-effects';
export type { WorktreeCliRepoEntry } from './worktree-cli-reads';
export {
  aggregateMultiRepoDiffStats,
  getWorktreeCliRecord,
  getWorktreeStats,
  listWorktreeCliRepoEntries,
  listWorktreeCliRows,
  listWorktreePipelineExecutions,
} from './worktree-cli-reads';

export interface CreateWorktreeServiceOptions {
  workspaceId: string;
  branchName?: string;
  baseBranch?: string;
  repairWorkspaceRoot?: boolean;
  restoreClaudeMd?: boolean;
  startPostCreateSetup?: boolean;
  /** Defaults to true. Restore-style callers can explicitly suppress seeding. */
  seedPanelLayoutMode?: boolean;
}
