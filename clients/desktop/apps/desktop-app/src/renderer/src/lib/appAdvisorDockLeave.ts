/**
 * Any navigation leaves the docked Orchestrator page: every page request
 * (`pageRequestSeq`, bumped on each request, even for the page already
 * open), and every change of the selected worktree or Cowork chat. A
 * request for the destination that was open before the page docked counts
 * too: the page covers it.
 *
 * An explicit navigation that changes none of these (a sidebar row for the
 * chat already open under the page, a notification for it) leaves it
 * through `dismissPageLikeViewers`, which every such navigation calls.
 *
 * The pages under the docked page stay mounted (hidden), so no page's
 * teardown changes the selection while it shows.
 */
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { setAppAdvisorDockLeaveHandler } from '@/stores/appAdvisorDockCover';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import type { WorktreeSelection } from '@canopy/desktop-shared/types';

function leaveDockedPage(): void {
  const appAdvisor = useAppAdvisorStore.getState();
  if (appAdvisor.open && appAdvisor.layout === 'docked') {
    appAdvisor.closeDialog();
  }
}

function selectionKey(selection: WorktreeSelection | null): string | null {
  return selection === null
    ? null
    : `${selection.projectId}/${selection.worktreeId}`;
}

export function installAppAdvisorDockLeaveOnNavigation(): () => void {
  // Explicit navigations that change nothing (a sidebar row for the chat
  // already open under the page) say so through `dismissPageLikeViewers`.
  const uninstallLeaveHandler = setAppAdvisorDockLeaveHandler(leaveDockedPage);
  const unsubscribeNavigation = useNavigationStore.subscribe(
    (state, previous): void => {
      if (state.pageRequestSeq !== previous.pageRequestSeq) leaveDockedPage();
    },
  );
  const unsubscribeSelection = useChatStore.subscribe(
    (state, previous): void => {
      if (
        selectionKey(state.selectedWorktree) !==
        selectionKey(previous.selectedWorktree)
      ) {
        leaveDockedPage();
      }
    },
  );
  const unsubscribeCoworkEntry = useStandaloneChatStore.subscribe(
    (state, previous): void => {
      if (state.activeWorkEntryId !== previous.activeWorkEntryId) {
        leaveDockedPage();
      }
    },
  );
  return (): void => {
    uninstallLeaveHandler();
    unsubscribeNavigation();
    unsubscribeSelection();
    unsubscribeCoworkEntry();
  };
}
