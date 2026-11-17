import { useEffect } from 'react';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * CAN-6933: reads this worktree's own scripts and hooks into the projects
 * store when it is shown, and again after each project load, so an edited
 * canopy.json shows up on the next load. Sidebar loads no longer carry them.
 */
export function useWorktreeEffective(
  projectId: string | null | undefined,
  worktreeId: string | null | undefined,
): void {
  const loadCount = useProjectsStore((state) => state.projectsLoadCount);
  const ensure = useProjectsStore((state) => state.ensureWorktreeEffective);
  useEffect(() => {
    if (projectId && worktreeId) void ensure(projectId, [worktreeId]);
  }, [projectId, worktreeId, loadCount, ensure]);
}
