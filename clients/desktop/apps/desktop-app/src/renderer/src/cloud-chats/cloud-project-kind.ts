import type { CoreCoworkProject } from '@canopy/app-state/core-cowork';
import { cloudCoworkStore } from './cloud-cowork-store';

/**
 * Whether `projectId` is a listed cowork project, whose new tasks this window
 * opens. A repository project's tasks live in a worktree the desktop can't
 * open yet (`workspaceContents: false`, CAN-6177); an unlisted one is
 * neither.
 */
export function cloudProjectIsCowork(
  projectId: string,
  projects: readonly CoreCoworkProject[] = cloudCoworkStore.getState().projects,
): boolean {
  return (
    projects.find((project) => project.key === projectId)?.kind === 'cowork'
  );
}
