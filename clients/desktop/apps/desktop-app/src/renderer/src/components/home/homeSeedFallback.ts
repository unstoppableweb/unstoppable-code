import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/shallow';
import type {
  SidebarItem,
  SidebarItemsLoadWarning,
} from '@canopy/desktop-shared/types';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import {
  homeBranchTargetsEqual,
  NEW_WORKTREE_TARGET,
  useHomeComposerStore,
  type HomeComposerState,
  type HomeSeedFallbackRecord,
} from '@/stores/homeComposerStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { isHomeSendTargetUsable } from './homeSendTarget';

/**
 * CAN-7326: at launch Home seeds its target from the last active project. When
 * that project failed to load it is missing from `projects`, so the seed falls
 * back to another project. The seed records that fallback in the composer
 * store (`seedFallback`); this module turns the record into the notice Home
 * shows, follows the project back once it loads, and remembers dismissals.
 */

/** What the notice needs to name both projects and the failure. */
export interface HomeSeedFallbackNotice {
  readonly unavailableWorkspaceId: string;
  /** The failed project's name, from its load warning. */
  readonly failedName: string;
  readonly failedCode: SidebarItemsLoadWarning['code'];
  /** The invalid config file's name, or null for a general load failure. */
  readonly failedFileName: string | null;
  /** The seeded project's name, as the project chip shows it. */
  readonly targetName: string;
}

export interface HomeSeedFallbackNoticeInput {
  readonly record: HomeSeedFallbackRecord | null;
  readonly workspaceId: string | null;
  readonly projectLoadWarnings: readonly SidebarItemsLoadWarning[];
  readonly projects: readonly SidebarItem[];
}

/** The last non-empty segment of a POSIX or Windows path, or null. */
function lastPathSegment(filePath: string): string | null {
  const segments = filePath.split(/[/\\]/);
  const last = segments[segments.length - 1];
  return last === undefined || last.trim() === '' ? null : last;
}

/**
 * Resolves the notice for the current state, or null when it must not show:
 * no record, the target moved off the seeded project, the failed project has
 * no current warning (it loaded or is gone), the warning has no name, or the
 * seeded project is not listed.
 */
export function resolveHomeSeedFallbackNotice(
  input: HomeSeedFallbackNoticeInput,
): HomeSeedFallbackNotice | null {
  const { record } = input;
  if (record === null) return null;
  if (input.workspaceId !== record.seededWorkspaceId) return null;
  const warning = input.projectLoadWarnings.find(
    (each) => each.workspaceId === record.unavailableWorkspaceId,
  );
  if (warning === undefined) return null;
  const failedName = warning.workspaceName.trim();
  if (failedName === '') return null;
  const project = input.projects.find(
    (each) => each.id === record.seededWorkspaceId,
  );
  if (project === undefined) return null;
  return {
    unavailableWorkspaceId: record.unavailableWorkspaceId,
    failedName,
    failedCode: warning.code,
    failedFileName:
      warning.code === 'invalid-canopy-json'
        ? lastPathSegment(warning.filePath)
        : null,
    targetName: getWorkspaceDisplayName(project),
  };
}

/** The notice for the current state. Read-only; safe on every surface. */
export function useHomeSeedFallback(): HomeSeedFallbackNotice | null {
  const { record, workspaceId } = useHomeComposerStore(
    useShallow((state) => ({
      record: state.seedFallback,
      workspaceId: state.workspaceId,
    })),
  );
  const { projectLoadWarnings, projects } = useProjectsStore(
    useShallow((state) => ({
      projectLoadWarnings: state.projectLoadWarnings,
      projects: state.projects,
    })),
  );
  return useMemo(
    () =>
      resolveHomeSeedFallbackNotice({
        record,
        workspaceId,
        projectLoadWarnings,
        projects,
      }),
    [record, workspaceId, projectLoadWarnings, projects],
  );
}

// Dismissals last for the session, so a later re-seed (for example after
// `reset()`) does not bring a dismissed notice back. They are keyed by the
// account epoch so they never carry over to another account.
let dismissals: { epoch: number; ids: Set<string> } = {
  epoch: -1,
  ids: new Set<string>(),
};

function currentDismissals(): Set<string> {
  const epoch = useWorkspaceContextStore.getState().accountEpoch;
  if (dismissals.epoch !== epoch) dismissals = { epoch, ids: new Set() };
  return dismissals.ids;
}

/** Hides the notice and keeps it hidden for this project this session. */
export function dismissHomeSeedFallback(unavailableWorkspaceId: string): void {
  currentDismissals().add(unavailableWorkspaceId);
  useHomeComposerStore.getState().setSeedFallback(null);
}

/** Whether the seed must not record a fallback from this project. */
export function isHomeSeedFallbackDismissed(
  unavailableWorkspaceId: string,
): boolean {
  return currentDismissals().has(unavailableWorkspaceId);
}

/**
 * Whether Home may move the draft back to the recovered project: nothing in
 * it is bound to the fallback project. Plain text carries over; attachments,
 * file and prompt mentions, a scheduled send, a workflow, a branch choice,
 * or a repo choice do not. `newWorktreeBaseTarget` is left out because
 * loading branch targets fills it in without a user choice.
 */
export function canHomeFollowRecoveredProject(
  state: Pick<
    HomeComposerState,
    | 'isSending'
    | 'attachments'
    | 'pendingAttachmentImportIds'
    | 'scheduledSendDraft'
    | 'selectedWorkflow'
    | 'branchTarget'
    | 'selectedRepoId'
    | 'fileReferences'
  >,
): boolean {
  return (
    !state.isSending &&
    state.attachments.length === 0 &&
    state.pendingAttachmentImportIds.length === 0 &&
    state.scheduledSendDraft === null &&
    state.selectedWorkflow === null &&
    homeBranchTargetsEqual(state.branchTarget, NEW_WORKTREE_TARGET) &&
    state.selectedRepoId === undefined &&
    !state.fileReferences.some(
      (reference) =>
        reference.kind === undefined ||
        reference.kind === 'file' ||
        reference.kind === 'folder' ||
        reference.kind === 'prompt',
    )
  );
}

/**
 * Settles the record after each settled inventory load: keeps it while the
 * project still fails, re-selects the project once it loads and the draft
 * allows, and otherwise clears it so the notice hides and the target stays.
 * Re-reads both stores before acting, so every mounted surface may run it.
 *
 * A context switch rebinds the target through `selectWorkspace`, which
 * clears the record, so the Home scope is not a dependency here.
 */
export function settleHomeSeedFallback(): void {
  const composer = useHomeComposerStore.getState();
  const record = composer.seedFallback;
  if (record === null) return;
  if (composer.workspaceId !== record.seededWorkspaceId) {
    // The target moved by a path that bypassed `selectWorkspace`; a stale
    // record must not bring the notice back later.
    composer.setSeedFallback(null);
    return;
  }
  const projects = useProjectsStore.getState();
  if (projects.projectInventoryStatus === 'loading') return;
  if (projects.failedWorkspaceIds.has(record.unavailableWorkspaceId)) return;
  if (
    isHomeSendTargetUsable(record.unavailableWorkspaceId) &&
    canHomeFollowRecoveredProject(composer)
  ) {
    // Inherited, like the seed, and clears the record.
    composer.selectWorkspace(record.unavailableWorkspaceId, {
      preserveDraft: true,
    });
    return;
  }
  composer.setSeedFallback(null);
}

/** Runs {@link settleHomeSeedFallback} whenever its inputs change. */
export function useHomeSeedFallbackRecovery(): void {
  const record = useHomeComposerStore((state) => state.seedFallback);
  const { failedWorkspaceIds, projects, projectInventoryStatus } =
    useProjectsStore(
      useShallow((state) => ({
        failedWorkspaceIds: state.failedWorkspaceIds,
        projects: state.projects,
        projectInventoryStatus: state.projectInventoryStatus,
      })),
    );
  useEffect(() => {
    settleHomeSeedFallback();
  }, [record, failedWorkspaceIds, projects, projectInventoryStatus]);
}
