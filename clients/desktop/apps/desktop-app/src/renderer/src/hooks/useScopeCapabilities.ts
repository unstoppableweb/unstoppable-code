import type { CanopyCapabilities } from '@canopy/app-core';
import { useWorkspaceCapabilities } from '@canopy/app-state/CanopyClientProvider';

/**
 * What a chat scope can do (CAN-6175 D4): the desktop set for a local
 * project, the web core set for a cloud one. Components that render both
 * local and cloud chats read this, never the scope's authority.
 */
export function useScopeCapabilities(scope: {
  readonly projectId: string;
}): CanopyCapabilities {
  return useWorkspaceCapabilities(scope.projectId);
}
