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
  return unavailable;
}

const unavailableByCapabilities = new WeakMap<
  CanopyCapabilities,
  ReadonlySet<PanelKind>
>();

/** The kinds a layout's scope can't serve, outside React. */
function panelKindsUnavailableInLayout(
  worktreeKey: string,
): ReadonlySet<PanelKind> {
  const { projectId } = splitWorktreeKey(worktreeKey);
  const capabilities =
    ipcCanopyClient.capabilitiesFor?.(projectId) ??
    ipcCanopyClient.capabilities;
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
