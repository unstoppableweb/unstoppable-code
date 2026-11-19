import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { isCoworkChatTarget } from '@/lib/cowork';
import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import { useNavigationStore } from '@/stores/navigationStore';
import { useChatStore, navigateToWorktreeChat } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useGitHubStore } from '@/stores/githubStore';

export interface LiveChatNavigationTarget {
  readonly projectId: string;
  /** Worktree id, or the Work Entry id for cowork chats. */
  readonly worktreeId: string;
  readonly chatId: string;
  /** Current workspace from the registry group, for legacy sentinel targets. */
  readonly workspaceId?: string;
}

/**
 * Bring a live (not archived) chat on screen and select its tab: the App
 * Advisor window, the cowork chat page for a Work Entry, or the worktree's
 * main page. Shared by the command palette and the Usage waiting row. It
 * only navigates; a chat that is gone is handled by the underlying openers.
 */
export async function navigateToLiveChat(
  target: LiveChatNavigationTarget,
): Promise<void> {
  try {
    await openLiveChat(target);
  } catch (error) {
    useGitHubStore
      .getState()
      .addToast(
        target.projectId === CODE_REVIEW_CHAT_PROJECT_ID
          ? 'This interrupted review chat has no available chat view.'
          : "Couldn't open the chat. It may no longer be available. Try opening it from the sidebar.",
        'error',
        undefined,
        { caught: error },
      );
  }
}

function requireLiveTab(target: LiveChatNavigationTarget): void {
  const tabs =
    useChatStore.getState().worktreeChats[
      `${target.projectId}/${target.worktreeId}`
    ]?.tabs;
  if (!tabs?.some((tab) => tab.id === target.chatId)) {
    throw new Error('The requested live chat is unavailable');
  }
}

async function openLiveChat(target: LiveChatNavigationTarget): Promise<void> {
  // The registry keeps legacy keys for resume/clear operations. Navigation
  // resolves the current owner through the existing read-only host contract.
  if (target.projectId === STANDALONE_CHAT_PROJECT_ID) {
    if (!target.workspaceId) throw new Error('Missing chat workspace');
    // Match the existing legacy-chat destination resolver: initialization may
    // migrate the old home scope into an entry before ownership is readable.
    await window.api.standaloneChat.init(target.workspaceId);
    const owner = await window.api.workEntries.resolveChat({
      projectId: target.workspaceId,
      chatId: target.chatId,
    });
    if (owner.archivedInEntryId && !owner.entryId) {
      throw new Error('The chat has been archived');
    }
    await openLiveChat({
      projectId: target.workspaceId,
      worktreeId: owner.entryId ?? COWORK_HOME_WORKTREE_ID,
      chatId: target.chatId,
    });
    return;
  }
  if (target.projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    // Retained review chats still appear in the interruption registry, but
    // openCodeReview now opens a change diagram and has no chat host. Do not
    // pass that off as opening this session. Usage mounts a read-only viewer
    // for this retained identity instead; there is still no live chat host.
    throw new Error('The legacy review chat view is unavailable');
  }
  if (isBotProjectId(target.projectId)) {
    // App Advisor chats are live tabs in its own BrowserWindow; opening the
    // window with the target `chatId` selects that exact chat's tab (the
    // App-Advisor analog of the worktree `switchTab`).
    useNavigationStore.getState().openAppAdvisor({ chatId: target.chatId });
    return;
  }
  if (isCoworkChatTarget(target.projectId)) {
    // Live cowork chats are scoped to a Work Entry, which occupies the
    // worktreeId slot.
    await useStandaloneChatStore
      .getState()
      .openWorkEntryFromSidebar(target.projectId, target.worktreeId);
    requireLiveTab(target);
    const destination = useStandaloneChatStore.getState();
    if (
      destination.activeChatProjectId !== target.projectId ||
      destination.activeWorkEntryId !== target.worktreeId
    )
      return;
    useChatStore.getState().switchTab(target.chatId, {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
    });
    useNavigationStore.getState().navigate('chat');
    requestChatPanelReveal(target.projectId, target.worktreeId, target.chatId);
    return;
  }
  await navigateToWorktreeChat({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    openArchivedTranscript: false,
  });
  requireLiveTab(target);
}
