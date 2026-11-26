import { useMemo, type MouseEvent } from 'react';
import type {
  ChatMessageLinkActions,
  ChatMessageLookUpSelection,
} from '@canopy/ui-shared/components';
import { isMacPlatform } from '@canopy/ui-shared/lib/shortcut-platform';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  isExternalBrowserOpenAvailable,
  isInAppBrowserAvailable,
} from '@/lib/remote-control/in-app-browser-availability';
import { openAppLinkInWorktreeBrowser } from '@/stores/browserEventSubscription';
import { isSyntheticChatTarget } from '@/stores/chat/surface';
import { parseSettingsRoutePath } from '@canopy/protocol/settings';
import { resolveHostedSettingsHref } from '@/components/settings/hosted/hosted-settings-location';

async function openResponseWebLink(href: string): Promise<void> {
  const url = new URL(href);
  // Only possible Settings destinations need the configured cloud origin.
  if (parseSettingsRoutePath(url.pathname, url.search) !== null) {
    const cloudBaseUrl = await window.api
      .getCanopyCloudBaseUrl()
      .catch((error: unknown): null => {
        reportClientAppError(error);
        return null;
      });
    if (
      cloudBaseUrl &&
      resolveHostedSettingsHref(href, cloudBaseUrl, '/').kind === 'settings'
    ) {
      await window.api.browser.openLink({ url: href });
      return;
    }
  }
  await window.api.browser.openExternal({ url: href });
}

export function openOrchestratorResponseLink(
  event: MouseEvent<HTMLAnchorElement>,
): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  const href = event.currentTarget.href;
  event.preventDefault();
  void openResponseWebLink(href).catch(reportClientAppError);
}

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

function lookUpSelectionInFocusedWindow(): void {
  // The menu has already closed, so a failed lookup has nowhere to show;
  // record it rather than drop it.
  void window.api.lookUpSelection().catch((error: unknown) => {
    reportClientAppError(error);
  });
}

/**
 * The desktop chat message menu's Look up row: the macOS dictionary for the
 * selection, which main shows in whichever of this renderer's windows has
 * focus. Other platforms have no system lookup, so they get no row.
 */
export function chatMessageLookUpSelection(): ChatMessageLookUpSelection | null {
  return isMacPlatform() ? lookUpSelectionInFocusedWindow : null;
}
