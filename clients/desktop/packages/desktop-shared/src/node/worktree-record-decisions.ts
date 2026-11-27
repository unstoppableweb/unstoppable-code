import type {
  CoreWorkspaceAdditionDecision,
  CoreWorkspaceCreationDecision,
  CoreWorkspaceCreationPublishDecision,
  CoreWorkspaceImportPublishDecision,
  CoreWorkspaceSidebarWrite,
  CoreWorktreeCreationReservationDecision,
  CoreWorktreeCreationSetupDecision,
  CoreWorktreeIncarnation,
  W5LifecycleTypes,
} from '@canopy/core-runtime/node/w5/lifecycle-ports';
import type {
  MultiRepoSidebarItem,
  SidebarItem,
  SidebarItemsFile,
  SingleRepoSidebarItem,
  WorkspaceConfigFile,
  WorktreeCreationIdentity,
  WorktreeData,
  WorktreeHealthIssue,
} from '../types';

export type {
  ReservedWorktreeTarget,
  WorktreeCreationPromoteDecision,
  WorktreeCreationReservationOutcome,
  WorktreeCreationReservationPreconditions,
  WorktreeCreationReservationRemovalDecision,
  WorktreeRecordTarget,
} from '@canopy/core-runtime/node/w5/lifecycle-ports';

/** The desktop's W5 lifecycle vocabulary, over its sidebar and worktree types. */
export interface DesktopW5LifecycleTypes extends W5LifecycleTypes {
  readonly item: SidebarItem;
  readonly singleRepoItem: SingleRepoSidebarItem;
  readonly multiRepoItem: MultiRepoSidebarItem;
  readonly itemsFile: SidebarItemsFile;
  readonly worktree: WorktreeData;
  readonly creationPhase: WorktreeCreationIdentity['phase'];
  readonly healthIssue: WorktreeHealthIssue;
}

/** The desktop's create orchestration vocabulary (CAN-4096 C1). */
export interface DesktopWorkspaceCreateTypes extends DesktopW5LifecycleTypes {
  readonly repos: WorkspaceConfigFile['repos'];
}

export type WorktreeIncarnation = CoreWorktreeIncarnation<WorktreeData, 'id'>;

export type WorkspaceAdditionDecision =
  CoreWorkspaceAdditionDecision<DesktopW5LifecycleTypes>;
export type WorkspaceCreationPublishDecision =
  CoreWorkspaceCreationPublishDecision<DesktopW5LifecycleTypes>;
export type WorkspaceImportPublishDecision =
  CoreWorkspaceImportPublishDecision<DesktopW5LifecycleTypes>;
export type WorkspaceCreationDecision =
  CoreWorkspaceCreationDecision<DesktopW5LifecycleTypes>;
export type WorkspaceSidebarWrite =
  CoreWorkspaceSidebarWrite<DesktopW5LifecycleTypes>;

export type WorktreeCreationReservationDecision =
  CoreWorktreeCreationReservationDecision<DesktopW5LifecycleTypes>;
export type WorktreeCreationSetupDecision =
  CoreWorktreeCreationSetupDecision<DesktopW5LifecycleTypes>;
