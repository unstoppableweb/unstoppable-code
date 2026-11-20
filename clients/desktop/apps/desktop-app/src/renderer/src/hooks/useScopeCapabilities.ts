import type { CanopyCapabilities } from '@canopy/app-core';
import { useWorkspaceCapabilities } from '@canopy/app-state/CanopyClientProvider';
import { useStore } from 'zustand';
import { cloudCoworkStore } from '@/cloud-chats/cloud-cowork-store';
import { cloudProjectIsCowork } from '@/cloud-chats/cloud-project-kind';
import { cloudTerminalsEnabled } from '@/lib/web-core-scope-capabilities';
import {
  useWebCoreServesChatFork,
  useWebCoreServesCost,
  useWebCoreServesDelegationStop,
} from '@/lib/web-core-served-operations';
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
  // ...and its Fork on the manifest and the project's kind (CAN-7007).
  useWebCoreServesChatFork();
  // ...and its delegates' Stop on the manifest (CAN-7245).
  useWebCoreServesDelegationStop();
  useStore(cloudCoworkStore, (state) =>
    cloudProjectIsCowork(scope.projectId, state.projects),
  );
  return useWorkspaceCapabilities(scope.projectId);
}
