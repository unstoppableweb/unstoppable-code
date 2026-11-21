import { useMemo } from 'react';
import { NEW_WORKTREE_DISPLAY_NAME } from '@canopy/desktop-shared/lib/default-worktree-branch';
import type { SidebarItem, WorktreeData } from '@canopy/desktop-shared/types';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * Where the Library reads project pipelines from (CAN-965): the selected
 * worktree of a code project, whose checkout holds the copies listed.
 */
export interface LibraryWorktreePlace {
  readonly kind: 'worktree';
  readonly projectId: string;
  readonly projectName: string;
  readonly worktreeId: string;
  readonly worktreeName: string;
  /** The project's other worktrees, whose copies the list leaves out. */
  readonly otherWorktreeIds: readonly string[];
}

/**
 * `no-worktree`: nothing is selected, so no project pipelines load.
 * `folder`: a Cowork project, whose one folder needs no naming.
 */
export type LibraryProjectPlace =
  | LibraryWorktreePlace
  | { readonly kind: 'no-worktree' }
  | { readonly kind: 'folder' };

/**
 * A worktree's name as its sidebar row shows it: its label, else its branch
 * through the same branch display names, and the same name for a generated
 * default branch.
 */
export function libraryWorktreeName(
  worktree: Pick<WorktreeData, 'id' | 'branchName' | 'label'>,
  getBranchDisplayName: (branchName: string) => string = (branchName) =>
    branchName,
): string {
  return (
    worktree.label ??
    getWorktreeBranchDisplayName({
      rawBranch: worktree.branchName,
      worktreeId: worktree.id,
      hasMultipleBranches: false,
      getBranchDisplayName,
      defaultDisplayName: NEW_WORKTREE_DISPLAY_NAME,
    })
  );
}

/** The place for a selection, from the sidebar's projects. */
export function resolveLibraryProjectPlace(
  selected: { readonly projectId: string; readonly worktreeId: string } | null,
  projects: readonly SidebarItem[],
  getBranchDisplayName?: (branchName: string) => string,
): LibraryProjectPlace {
  if (!selected) return { kind: 'no-worktree' };
  const project = projects.find((item) => item.id === selected.projectId);
  if (!project || project.type === 'cowork') return { kind: 'folder' };
  const worktree = project.worktrees.find(
    (candidate) => candidate.id === selected.worktreeId,
  );
  if (!worktree) return { kind: 'folder' };
  return {
    kind: 'worktree',
    projectId: project.id,
    projectName: getWorkspaceDisplayName(project),
    worktreeId: worktree.id,
    worktreeName: libraryWorktreeName(worktree, getBranchDisplayName),
    otherWorktreeIds: project.worktrees
      .filter((candidate) => candidate.id !== worktree.id)
      .map((candidate) => candidate.id),
  };
}

/** The selected worktree's place, following the selection. */
export function useLibraryProjectPlace(): LibraryProjectPlace {
  const selected = useChatStore((state) => state.selectedWorktree);
  const projects = useProjectsStore((state) => state.projects);
  const getDisplayName = useBranchDisplayStore((s) => s.getDisplayName);
  // `getDisplayName` is a stable reference; the version re-reads mappings.
  const mappingsVersion = useBranchDisplayStore((s) => s.mappingsVersion);
  return useMemo(
    () => resolveLibraryProjectPlace(selected, projects, getDisplayName),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mappingsVersion invalidates cache
    [selected, projects, getDisplayName, mappingsVersion],
  );
}
