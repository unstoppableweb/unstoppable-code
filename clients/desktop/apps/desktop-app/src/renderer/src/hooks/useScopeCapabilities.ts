import type { CanopyCapabilities } from '@canopy/app-core';
import { useWorkspaceCapabilities } from '@canopy/app-state/CanopyClientProvider';
import { cloudTerminalsEnabled } from '@/lib/web-core-scope-capabilities';
import { useWebCoreServesCost } from '@/lib/web-core-served-operations';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * What a chat scope can do (CAN-6175 D4): the desktop set for a local
 * project, the web core set for a cloud one. Components that render both
 * local and cloud chats read this, never the scope's authority.
 */
export function useScopeCapabilities(scope: {
  readonly projectId: string;
}): CanopyCapabilities {
  // A cloud scope's set follows these flags, which load after first render.
  useFeatureFlagsStore((s) => cloudTerminalsEnabled(s.isEnabled));
  // ...and its Cost on the web core's manifest, which loads after first render.
  useWebCoreServesCost();
  return useWorkspaceCapabilities(scope.projectId);
}
