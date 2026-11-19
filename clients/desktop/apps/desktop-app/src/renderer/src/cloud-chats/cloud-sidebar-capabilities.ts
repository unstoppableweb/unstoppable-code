import type { CanopyCapabilities } from '@canopy/app-core';
import type { WorkspaceSettingsDangerCopy } from '@canopy/ui-shared/components';

/** What a cloud row in the desktop sidebar is: a project of either kind, or a task. */
export type CloudSidebarRowKind = 'cowork' | 'git' | 'task';

export interface CloudSidebarRowOptions {
  /**
   * The web core serves deleting a task to the Trash and cloud chats are
   * online (CAN-7052). Without it a task only archives.
   */
  readonly taskDelete?: boolean;
  /**
   * Cloud chats are offline: the row is the last listing, read-only, so a
   * project is neither dragged nor dropped on (CAN-6374).
   */
  readonly offline?: boolean;
}

/**
 * What the desktop can do with one cloud row, over the web core. Every
 * affordance the shared sidebar would otherwise reach through local stores or
 * IPC is withheld, so a cloud id never meets a local action (CAN-4185 D6).
 * The sidebar hides what these deny; components never check the id.
 */
export function cloudSidebarRowCapabilities(
  base: CanopyCapabilities,
  kind: CloudSidebarRowKind,
  options: CloudSidebarRowOptions = {},
): CanopyCapabilities {
  // The host's own Archive-or-Delete never carries over: a cloud task offers
  // Delete beside Archive only while the web core serves it (CAN-6511,
  // CAN-7052), in a selection's menu too.
  const { worktreeRetention: _removed, ...host } = base;
  void _removed;
  return {
    ...host,
    ...(kind === 'task' && options.taskDelete === true
      ? { worktreeRetention: 'archive-or-delete' as const }
      : {}),
    localExecution: false,
    terminalPty: false,
    fileSystemAccess: 'none',
    pipelines: 'read-only',
    scriptActions: false,
    nativeWorktreeOpen: false,
    workspaceCreation: false,
    // Projects reorder through `core.workspace.reorder`; tasks keep recency.
    workspaceReordering: kind !== 'task' && options.offline !== true,
    workspaceMoveToOrganization: false,
    // A project's name, colour and delete to Trash go through the web core;
    // its instructions and scripts don't, so its settings show only those.
    workspaceSettings: kind === 'task' ? false : 'details',
    workspaceRemoval: kind === 'task' ? false : 'delete',
    itemGrouping: false,
    worktreeReordering: false,
    worktreePinning: false,
    // A task archives through the web core (CAN-6511); it stays restorable.
    worktreeRemoval: kind === 'task' ? 'archive' : false,
    // The local core's discard flows; a refused cloud delete never offers them.
    projectDeletionDiscard: false,
    worktreeDiscard: false,
    worktreeBranching: false,
    worktreeMetadata: false,
    worktreeSplitPr: false,
    worktreeBranchGrouping: false,
    worktreeRepositoryAttachment: false,
    worktreePrAgentHelpers: false,
    wholeWorktreeDiff: false,
    // A cowork project's "+" starts a cloud task; a repository project can't
    // be opened on desktop yet (CAN-6177).
    worktreeCreation: kind === 'cowork',
    ...(kind === 'git' ? { workspaceContents: false } : {}),
  };
}

/**
 * A cloud project's delete moves it to the web's Archived and deleted, as the
 * web's own project settings say; it stays restorable there until its
 * retention, set per project on the web, runs out (not quoted here, since
 * the web core listing doesn't carry it).
 */
export const CLOUD_PROJECT_DANGER_COPY: WorkspaceSettingsDangerCopy = {
  title: 'Delete project',
  description:
    'Moves the project to Archived and deleted. You can restore it there on the web.',
  confirmDescription:
    'You can restore it from Archived and deleted on the web.',
};
