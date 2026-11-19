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
