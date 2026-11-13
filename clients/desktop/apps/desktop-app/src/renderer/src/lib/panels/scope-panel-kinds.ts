import type { CanopyCapabilities } from '@canopy/app-core';
import type { PanelKind } from '@canopy/protocol/panels';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import {
  setPanelLayoutScopeExcludedKinds,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { splitWorktreeKey } from '@/stores/chat/utils';

/**
 * Panel kinds a chat scope can't serve, read from its capabilities
 * (CAN-6175 D4). A local scope reports every one of these, so its grid
 * offers all of them.
 */
export function panelKindsUnavailableFor(
  capabilities: CanopyCapabilities,
): PanelKind[] {
  const unavailable: PanelKind[] = [];
  if (capabilities.terminalPty !== true) unavailable.push('terminal');
  if (capabilities.fileSystemAccess === 'none') {
    unavailable.push('file-explorer', 'file-diff');
  }
  if (capabilities.inAppBrowserPanel !== true) unavailable.push('browser');
  if (capabilities.automations !== true) unavailable.push('automations');
  if (capabilities.chatWorkflows?.planMode !== true) {
    unavailable.push('plan', 'plan-diagram');
  }
  if (capabilities.chatVisuals !== true) unavailable.push('chat-visuals');
  if (capabilities.delegationTranscriptReads !== true) {
    unavailable.push('subagents', 'subagent-chat');
  }
  if (capabilities.ledger !== true) unavailable.push('ledger');
  if (capabilities.costInsights !== true) {
    unavailable.push('cost', 'session-breakdown');
  }
  // A scope that serves no activity section has no Activity tab to offer.
  if (capabilities.activitySectionIds?.length === 0) {
    unavailable.push('activity-section');
  }
  return unavailable;
}

/**
 * Whether a chat scope serves one activity section, as its own card or in
 * the Activity stack: its allowlist names it (CAN-6430), and Cost only where
 * the scope has cost insights (CAN-6431). Every other section of a cloud
 * scope would read this computer with the cloud task's ids.
 */
export function scopeServesActivitySection(
  capabilities: CanopyCapabilities,
  sectionId: string,
): boolean {
  if (sectionId === 'cost' && capabilities.costInsights !== true) return false;
  return (
    capabilities.activitySectionIds === undefined ||
    capabilities.activitySectionIds.includes(sectionId)
  );
}

/** A layout's scope's capabilities, outside React. */
function layoutScopeCapabilities(worktreeKey: string): CanopyCapabilities {
  const { projectId } = splitWorktreeKey(worktreeKey);
  return (
    ipcCanopyClient.capabilitiesFor?.(projectId) ?? ipcCanopyClient.capabilities
  );
}

/** Whether a layout's scope serves an activity section, outside React. */
export function layoutScopeServesActivitySection(
  worktreeKey: string,
  sectionId: string,
): boolean {
  return scopeServesActivitySection(
    layoutScopeCapabilities(worktreeKey),
    sectionId,
  );
}

const unavailableByCapabilities = new WeakMap<
  CanopyCapabilities,
  ReadonlySet<PanelKind>
>();

/** The kinds a layout's scope can't serve, outside React. */
function panelKindsUnavailableInLayout(
  worktreeKey: string,
): ReadonlySet<PanelKind> {
  const capabilities = layoutScopeCapabilities(worktreeKey);
  let kinds = unavailableByCapabilities.get(capabilities);
  if (kinds === undefined) {
    kinds = new Set(panelKindsUnavailableFor(capabilities));
    unavailableByCapabilities.set(capabilities, kinds);
  }
  return kinds;
}

/** Whether a layout's scope can serve `kind`, outside React. */
export function layoutScopeServesPanelKind(
  worktreeKey: string,
  kind: PanelKind,
): boolean {
  return !panelKindsUnavailableInLayout(worktreeKey).has(kind);
}

let installed = false;

/**
 * Makes the panel layout store refuse, in each layout, the kinds its scope
 * can't serve. Idempotent.
 */
export function ensureScopePanelRules(): void {
  if (installed) return;
  installed = true;
  setPanelLayoutScopeExcludedKinds(panelKindsUnavailableInLayout);
}

/**
 * Closes panels a restored or default layout holds that its scope can't
 * serve, such as a terminal from the saved cowork default. A local scope
 * has none, so its layout is left as it is.
 */
export function removeScopeUnavailablePanels(worktreeKey: string): void {
  if (panelKindsUnavailableInLayout(worktreeKey).size === 0) return;
  usePanelLayoutStore.getState().removeExcludedKindTabs(worktreeKey);
}
