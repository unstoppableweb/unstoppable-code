import { ProjectIcon } from '@/components/shared/ProjectIcon';
import type { SearchableSelectOption } from '@/components/shared/SearchableSelect';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import type { useProjectsStore } from '@/stores/projectsStore';

/** A project as a project picker lists it, with its icon and repo count. */
export function projectPickerOption(
  project: ReturnType<typeof useProjectsStore.getState>['projects'][number],
): SearchableSelectOption {
  const displayName = getWorkspaceDisplayName(project);
  const isMultiRepo = project.type === 'multi-repo';
  const isCowork = project.type === 'cowork';
  const subtitle = isMultiRepo
    ? `${project.repos.length} ${
        project.repos.length === 1 ? 'repo' : 'repos'
      }${project.temporary === true ? ' • Temporary' : ''}`
    : undefined;
  return {
    id: project.id,
    label: displayName,
    // A project's title is user-authored.
    maskInReplay: true,
    subtitle,
    badge: (
      <ProjectIcon
        color={project.color}
        repoPath={project.type === 'single-repo' ? project.repoPath : undefined}
        kind={isCowork ? 'cowork' : isMultiRepo ? 'multi-repo' : 'single-repo'}
        temporary={isMultiRepo && project.temporary === true}
      />
    ),
  };
}
