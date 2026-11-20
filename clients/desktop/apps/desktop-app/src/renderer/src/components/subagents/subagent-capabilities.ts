/**
 * Maps a scope's `CanopyCapabilities` onto the subagent viewer's capability
 * flags. Components never hardcode a capability: they read the scope's
 * flags through here. Per-kind narrowing lives in `@canopy/ui-app/subagents`
 * (`subagentCapabilitiesForKind`).
 */
import { useMemo } from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { SubagentViewerCapabilities } from '@canopy/ui-app/subagents';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import { isWebCoreScope } from '@/lib/chat-authority';
import {
  useWebCoreServedOperationsFailed,
  useWebCoreServedOperationsKnown,
} from '@/lib/web-core-served-operations';
import type { SubagentHostScope } from './subagent-scope';

/** The viewer's flags for a host, before any per-subagent narrowing. */
export function subagentViewerCapabilitiesFrom(
  capabilities: CanopyCapabilities,
): SubagentViewerCapabilities {
  return {
    stop: capabilities.delegationStop === true,
    messaging: capabilities.delegationMessaging === true,
    worktreeDetails: capabilities.delegationWorktreeDetails === true,
    nativeInterrupt: capabilities.nativeSubagentInterrupt === true,
    // Workflow runs are pipelines on this computer (CAN-7133).
    openWorkflow: capabilities.localExecution,
    stopWorkflow: capabilities.localExecution,
  };
}

/**
 * The viewer's capabilities for a scope: a local scope's are the desktop
 * host's, a cloud scope's what the web core serves it (CAN-7133).
 */
export function useSubagentViewerCapabilities(
  scope: SubagentHostScope,
): SubagentViewerCapabilities {
  const capabilities = useScopeCapabilities({ projectId: scope.projectId });
  return useMemo(
    () => subagentViewerCapabilitiesFrom(capabilities),
    [capabilities],
  );
}

/**
 * Whether a scope's Subagents hosts may read (CAN-7133): a local scope's
 * always, a cloud scope's once the web core's manifest serves them. While
 * the manifest read is in flight a kept tab waits, and if it then doesn't
 * serve them the tab says so; neither reads or offers Stop.
 */
export type SubagentPanelsAvailability =
  | 'served'
  | 'pending'
  | 'failed'
  | 'unavailable';

export function useSubagentPanelsAvailability(
  scope: SubagentHostScope,
): SubagentPanelsAvailability {
  const capabilities = useScopeCapabilities({ projectId: scope.projectId });
  const manifestKnown = useWebCoreServedOperationsKnown();
  const manifestFailed = useWebCoreServedOperationsFailed();
  if (!isWebCoreScope(scope.projectId) || capabilities.subagentPanels === true)
    return 'served';
  // A failed read offers Try again (CAN-7464); it's never read in a loop.
  if (manifestFailed) return 'failed';
  return manifestKnown ? 'unavailable' : 'pending';
}
