import type { DelegationPageRequest } from '@canopy/app-core';
import type { WebCoreTranscriptScope } from '@canopy/app-state/core-cowork';
import { setCloudDelegationScope } from '@/client/ipc-transcript-read-client';
import { webCoreLocalId } from '@/lib/chat-authority';
import { webCoreChatId } from '@/stores/chat/web-core';
import { worktreeKey } from '@/stores/chat/utils';
import { useChatStore } from '@/stores/chatStore';

/**
 * The web core ids of a cloud chat's own delegate (CAN-7027): only a
 * delegation whose card is in that chat's transcript, read for that same
 * chat. The web core refuses any other delegation too; this keeps the
 * desktop from asking.
 */
export function cloudDelegationScope(
  request: DelegationPageRequest,
): WebCoreTranscriptScope | null {
  const { workspaceId, worktreeId, chatId } = request.scope;
  if (request.target.chatId !== chatId) return null;
  const coreWorkspaceId = webCoreLocalId(workspaceId);
  const coreWorktreeId = webCoreLocalId(worktreeId);
  const coreChatId = webCoreChatId(chatId);
  if (coreWorkspaceId === null || coreWorktreeId === null || !coreChatId)
    return null;
  const tab = useChatStore
    .getState()
    .worktreeChats[
      worktreeKey({ projectId: workspaceId, worktreeId })
    ]?.tabs.find((entry) => entry.id === chatId);
  const ownCard = tab?.messages.some((message) =>
    message.blocks.some(
      (block) =>
        block.type === 'delegated_agent_call' &&
        block.delegationId === request.target.delegationId,
    ),
  );
  if (ownCard !== true) return null;
  return {
    workspaceId: coreWorkspaceId,
    worktreeId: coreWorktreeId,
    chatId: coreChatId,
  };
}

/** Lets the window's transcript reads reach a cloud chat's own delegates. */
export function installCloudDelegationTranscripts(): void {
  setCloudDelegationScope(cloudDelegationScope);
}
