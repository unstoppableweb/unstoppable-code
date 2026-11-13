import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { CloudChatListEntry } from '@canopy/agent-actions/families/cloud-chats/actions';
import type {
  AppAdvisorActionError,
  AppAdvisorJson,
} from '@canopy/desktop-shared/types';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { webCoreScopeId } from '@/lib/chat-authority';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import {
  cloudCoworkStore,
  cloudProjectsForContext,
} from './useCloudCoworkSidebar';

type AdvisorFailure = { ok: false; error: AppAdvisorActionError };
type AdvisorOutcome = { ok: true; result: AppAdvisorJson } | AdvisorFailure;

const unavailable = (message: string): AdvisorFailure => ({
  ok: false,
  error: { code: 'surface_unavailable', message, retryable: true },
});

/**
 * CAN-5974: the cloud chats the sidebar shows, in the selected context, as
 * ids and titles. Answers from the window's store; never reads the web core.
 */
function sidebarCloudChats():
  | { ok: true; chats: readonly CloudChatListEntry[] }
  | AdvisorFailure {
  if (
    !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key)
  )
    return unavailable('Cloud chats are turned off.');
  const { status, projects, tasksByProject } = cloudCoworkStore.getState();
  if (status === 'disabled')
    return unavailable('Cloud chats are not loaded in the main window.');
  if (status === 'offline')
    return unavailable(
      'Cloud chats are offline. The member can reconnect from the sidebar.',
    );
  const chats = cloudProjectsForContext(
    projects,
    tasksByProject,
    getSidebarScopingContext(),
  ).flatMap((project) =>
    project.entries.map((entry) => ({
      chatId: entry.worktreeId,
      projectId: project.workspaceId,
      projectName: project.name,
      title: entry.title,
    })),
  );
  return { ok: true, chats };
}

export function listCloudChatsForAdvisor(): AdvisorOutcome {
  const listed = sidebarCloudChats();
  if (!listed.ok) return listed;
  return {
    ok: true,
    result: {
      chats: listed.chats.map((chat) => ({
        chatId: chat.chatId,
        projectId: chat.projectId,
        projectName: chat.projectName,
        title: chat.title,
      })),
    },
  };
}

export function openCloudChatForAdvisor(chatId: string): AdvisorOutcome {
  const listed = sidebarCloudChats();
  if (!listed.ok) return listed;
  const chat = listed.chats.find((each) => each.chatId === chatId);
  if (chat === undefined)
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: 'The sidebar does not list that cloud chat.',
      },
    };
  openCoworkWorkEntryFromSidebar(
    webCoreScopeId(chat.projectId),
    webCoreScopeId(chat.chatId),
  );
  return {
    ok: true,
    result: {
      chatId: chat.chatId,
      projectId: chat.projectId,
      title: chat.title,
    },
  };
}
