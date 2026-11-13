import { useMemo } from 'react';
import type { ChatMessageLinkActions } from '@canopy/ui-shared/components';
import {
  isExternalBrowserOpenAvailable,
  isInAppBrowserAvailable,
} from '@/lib/remote-control/in-app-browser-availability';
import { openAppLinkInWorktreeBrowser } from '@/stores/browserEventSubscription';
import { isSyntheticChatTarget } from '@/stores/chat/surface';

/**
 * The desktop chat message menu's link actions (CAN-2632). "Open in browser"
 * targets the message's own worktree, so it is offered only for a real
 * worktree chat; synthetic targets such as App Advisor have no Browser panel.
 * A window that shows another computer omits the actions its browser
 * channels cannot carry.
 */
export function useChatMessageLinkActions(
  worktreeTarget: { projectId: string; worktreeId: string } | null,
): ChatMessageLinkActions {
  const projectId = worktreeTarget?.projectId ?? null;
  const worktreeId = worktreeTarget?.worktreeId ?? null;
  return useMemo((): ChatMessageLinkActions => {
    const actions: ChatMessageLinkActions = {};
    if (isExternalBrowserOpenAvailable()) {
      actions.openExternal = (url: string): void => {
        void window.api.browser.openExternal({ url }).catch(() => undefined);
      };
    }
    if (
      projectId !== null &&
      worktreeId !== null &&
      !isSyntheticChatTarget(projectId, worktreeId) &&
      isInAppBrowserAvailable()
    ) {
      actions.openInBrowser = (url: string): void => {
        void openAppLinkInWorktreeBrowser(projectId, worktreeId, url);
      };
    }
    return actions;
  }, [projectId, worktreeId]);
}
