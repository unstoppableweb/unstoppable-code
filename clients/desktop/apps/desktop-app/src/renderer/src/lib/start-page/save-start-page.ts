import type { ProjectStartPage } from '@canopy/protocol/start-page';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useStartPageStore } from '@/stores/startPageStore';

export const START_PAGE_SAVED_FOR_YOU = 'Start page saved for you';
export const START_PAGE_REMOVED_FOR_YOU = 'Start page removed for you';
export const START_PAGE_SAVED = 'Start page saved';
export const START_PAGE_REMOVED = 'Start page removed';
export const START_PAGE_SHARE_WITH_TEAM = 'Share with team';
export const START_PAGE_SAVE_FAILED = "Couldn't save the start page";

/** Open project Settings on the Start page tab in the given mode. */
export function openStartPageSettings(
  projectId: string,
  mode: 'source' | 'local',
  prefill?: ProjectStartPage | null,
  worktreeId?: string,
): void {
  useNavigationStore.getState().openWorkspaceSettings({
    workspaceId: projectId,
    initialTab: 'start-page',
    startPage: prefill === undefined ? { mode } : { mode, prefill },
    ...(worktreeId ? { worktreeId } : {}),
  });
}

/**
 * Write a project's start page from an in-place action ("Set as start page",
 * "Remove start page"). Cowork projects update their settings; code projects
 * write the local override, reload projects so a later `saveProjects` can't
 * restore the old value, and offer "Share with team". `null` means none.
 */
export async function saveStartPageFromAction(
  projectId: string,
  startPage: ProjectStartPage | null,
): Promise<boolean> {
  const toast = useGitHubStore.getState().addToast;
  const project = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === projectId);
  if (!project) return false;
  try {
    if (project.type === 'cowork') {
      const chatStore = useStandaloneChatStore.getState();
      if (chatStore.chatProjects.some((p) => p.id === projectId)) {
        await chatStore.updateChatProject({ projectId, startPage });
      } else {
        await window.api.chatProject.update({ projectId, startPage });
        await useProjectsStore.getState().loadProjects({ silent: true });
      }
      await useStartPageStore.getState().refreshProject(projectId);
      toast(
        startPage ? START_PAGE_SAVED : START_PAGE_REMOVED,
        'success',
        undefined,
        {
          projectId,
          forceInApp: true,
          suppressOsNotification: true,
        },
      );
      return true;
    }
    await window.api.setWorkspaceStartPage({
      workspaceId: projectId,
      startPage,
    });
    await useProjectsStore.getState().loadProjects({ silent: true });
    await useStartPageStore.getState().refreshProject(projectId);
    toast(
      startPage ? START_PAGE_SAVED_FOR_YOU : START_PAGE_REMOVED_FOR_YOU,
      'success',
      undefined,
      {
        projectId,
        forceInApp: true,
        suppressOsNotification: true,
        action: {
          label: START_PAGE_SHARE_WITH_TEAM,
          onClick: () => openStartPageSettings(projectId, 'source', startPage),
        },
      },
    );
    return true;
  } catch (error) {
    toast(START_PAGE_SAVE_FAILED, 'error', undefined, {
      caught: error,
      projectId,
      forceInApp: true,
      suppressOsNotification: true,
    });
    return false;
  }
}
