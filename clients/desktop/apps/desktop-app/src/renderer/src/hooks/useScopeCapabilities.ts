import type { CanopyCapabilities } from '@canopy/app-core';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
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
import {
  pairedComputerConnectionForProject,
  usePairedComputerConnectionStore,
} from '@/stores/chat/paired-computer/connection-store';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useOneWindowEnabledWhen } from '@/stores/oneWindowStore';

/**
 * What a chat scope can do (CAN-6175 D4, CAN-7767): the desktop set for a
 * local project, the web core set for a cloud one, and the one-window
 * allowlist set for a paired computer. Components that render across
 * authorities read this, never the scope's authority.
 */
export function useScopeCapabilities(scope: {
  readonly projectId: string;
}): CanopyCapabilities {
  const isPaired = isPairedComputerId(scope.projectId);
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
  // A paired computer scope's set follows the one-window switch and that
  // computer's announced capabilities; local scopes select `undefined` so they
  // never re-render when paired computers change state.
  useOneWindowEnabledWhen(isPaired);
  usePairedComputerConnectionStore((state) =>
    isPaired
      ? pairedComputerConnectionForProject(state, scope.projectId)?.state
      : undefined,
  );
  return useWorkspaceCapabilities(scope.projectId);
}
