import type { CanopyCapabilities } from '@canopy/app-core';

/**
 * What the main window can do with a paired computer's row, a task or a
 * project only on paired computers, in this unit
 * (CAN-7766): nothing that changes it. Every affordance the shared sidebar
 * would reach through this computer's stores or IPC is withheld, so a
 * paired computer's id never meets a local action: no rename, archive,
 * delete, pin, reorder, drag, grouping, multi-select (which needs removal)
 * or new task, and a project only on another computer has no settings,
 * scripts or new task here, since those need a checkout here. The sidebar
 * hides what these deny; opening a task goes to that computer's window.
 * Mark read is CAN-7866; acting on another computer's task is later work.
 */
export function pairedSidebarRowCapabilities(
  base: CanopyCapabilities,
): CanopyCapabilities {
  const {
    worktreeRetention: _retention,
    workspaceRetention: _workspaceRetention,
    ...host
  } = base;
  void _retention;
  void _workspaceRetention;
  return {
    ...host,
    localExecution: false,
    terminalPty: false,
    fileSystemAccess: 'none',
    pipelines: 'read-only',
    scriptActions: false,
    nativeWorktreeOpen: false,
    workspaceCreation: false,
    workspaceReordering: false,
    workspaceMoveToOrganization: false,
    workspaceSettings: false,
    workspaceRemoval: false,
    workspaceArchiveRetention: false,
    itemGrouping: false,
    worktreeReordering: false,
    worktreePinning: false,
    worktreeRemoval: false,
    projectDeletionDiscard: false,
    worktreeDiscard: false,
    worktreeRecovery: false,
    worktreeBranching: false,
    worktreeBaseBranch: false,
    worktreeMetadata: false,
    worktreeSplitPr: false,
    worktreeBranchGrouping: false,
    worktreeRepositoryAttachment: false,
    worktreePrAgentHelpers: false,
    wholeWorktreeDiff: false,
    worktreeCreation: false,
  };
}
