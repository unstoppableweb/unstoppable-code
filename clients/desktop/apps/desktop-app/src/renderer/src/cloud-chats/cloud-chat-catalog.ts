import { useMemo } from 'react';
import {
  createCloudChatCatalog,
  type CloudChatCatalog,
  type CloudChatThreadTarget,
} from '@canopy/app-state/core-cowork';
import { createRelayCoreCoworkInvoker } from './relay-invoker';

function devLog(message: string): void {
  if (process.env.NODE_ENV === 'production') return;
  // eslint-disable-next-line no-console
  console.info(message);
}

/** The chat's catalog over the web-core relay, or null without the relay. */
export function useCloudChatCatalog(
  target: CloudChatThreadTarget,
): CloudChatCatalog | null {
  const { workspaceId, worktreeId, chatId } = target;
  return useMemo(() => {
    if (typeof window === 'undefined' || !window.canopyCore) return null;
    return createCloudChatCatalog(
      createRelayCoreCoworkInvoker(window.canopyCore),
      { workspaceId, worktreeId, chatId },
      { logDev: devLog },
    );
  }, [workspaceId, worktreeId, chatId]);
}
