import type { CanopyCapabilities } from '@canopy/app-core';
import type { WorkspaceSettingsDangerCopy } from '@canopy/ui-shared/components';

/** What a cloud row in the desktop sidebar is: a project of either kind, or a task. */
export type CloudSidebarRowKind = 'cowork' | 'git' | 'task';

/**
 * What the desktop can do with one cloud row, over the web core. Every
 * affordance the shared sidebar would otherwise reach through local stores or
 * IPC is withheld, so a cloud id never meets a local action (CAN-4185 D6).
 * The sidebar hides what these deny; components never check the id.
 */
export function cloudSidebarRowCapabilities(
  base: CanopyCapabilities,
  kind: CloudSidebarRowKind,
): CanopyCapabilities {
  return {
    ...base,
    localExecution: false,
    terminalPty: false,
    fileSystemAccess: 'none',
    pipelines: 'read-only',
    scriptActions: false,
    nativeWorktreeOpen: false,
    workspaceCreation: false,
    // Projects reorder through `core.workspace.reorder`; tasks keep recency.
    workspaceReordering: kind !== 'task',
    workspaceMoveToOrganization: false,
    // A project's name, colour and delete to Trash go through the web core;
    // its instructions and scripts don't, so its settings show only those.
    workspaceSettings: kind === 'task' ? false : 'details',
    workspaceRemoval: kind === 'task' ? false : 'delete',
    itemGrouping: false,
    worktreeReordering: false,
    worktreePinning: false,
    worktreeRemoval: false,
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
