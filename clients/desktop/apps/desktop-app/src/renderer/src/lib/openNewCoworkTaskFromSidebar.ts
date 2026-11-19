import { isOrgDefaultCoworkWorkspaceId } from '@canopy/protocol/ui-labels';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { useGitHubStore } from '@/stores/githubStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/**
 * The sidebar "+" for a Cowork project, shared by the project row and the
 * sole-project header so both behave the same. Same shape as a code project's
 * "+" (`useSidebarWorkspaces.onCreateWorktree`): start the create and open the
 * chat page, so the first action can be a pipeline run instead of a message.
 * Main reuses an existing empty task, so repeated clicks never pile up blanks.
 * A failed create is surfaced, the way the code path surfaces `worktreeError`.
 */
export function openNewCoworkTaskFromSidebar(
  projectId: string,
  options: { pending?: boolean; sidebarItemGroupId?: string } = {},
): void {
  dismissPageLikeViewers();
  const store = useStandaloneChatStore.getState();
  if (options.pending === true && isOrgDefaultCoworkWorkspaceId(projectId)) {
    const homeComposer = useHomeComposerStore.getState();
    homeComposer.selectWorkspace(projectId);
    homeComposer.setMode('chat');
    useNavigationStore.getState().navigate('home');
    return;
  }
  // The first-run "New chat" screen shows while there is one Cowork project
  // and no message anywhere, and a new task has no message yet. That screen's
  // own button dismisses it before starting a chat; the "+" does the same, or
  // a pipeline-first user never reaches the new task's grid.
  store.dismissColdStart();
  const creating =
    options.sidebarItemGroupId === undefined
      ? store.createWorkEntryInProject(projectId)
      : store.createWorkEntryInProject(projectId, {
          sidebarItemGroupId: options.sidebarItemGroupId,
        });
  void creating.catch((error: unknown) => {
    useGitHubStore
      .getState()
      .addToast("Couldn't create the task. Try again.", 'error', undefined, {
        caught: error,
      });
  });
  useNavigationStore.getState().navigate('chat');
}
