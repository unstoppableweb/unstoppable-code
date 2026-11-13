import { isWebCoreScope } from '@/lib/chat-authority';

export interface SidebarReorderTargets {
  readonly local: (activeId: string, overId: string) => void;
  /** Absent while cloud projects are offline or off. */
  readonly cloud?: (activeId: string, overId: string) => void;
}

/**
 * A project drop in the shared sidebar, routed by authority. Local projects
 * reorder in the local index and cloud projects in the web core; a drop
 * across the two moves nothing, so neither ever receives the other's id.
 */
export function routeSidebarReorder(
  activeId: string,
  overId: string,
  targets: SidebarReorderTargets,
): void {
  const cloudActive = isWebCoreScope(activeId);
  const cloudOver = isWebCoreScope(overId);
  if (!cloudActive && !cloudOver) targets.local(activeId, overId);
  else if (cloudActive && cloudOver) targets.cloud?.(activeId, overId);
}
