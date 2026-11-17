// Shared helper for stamping a freshly created chat tab with its resolved
// approval-mode default. Kept out of tab-lifecycle.ts/messaging.ts so both
// can call it without a circular import.
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ApprovalMode,
  type WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { worktreeKey } from './utils';
import type { ChatState } from './state';

type ChatSet = (
  partial:
    | ChatState
    | Partial<ChatState>
    | ((state: ChatState) => ChatState | Partial<ChatState>),
) => void;
type ChatGet = () => ChatState;

let approvalDefaultsGeneration = 0;
const approvalDefaultsGenerationListeners = new Set<() => void>();

export function getApprovalDefaultsGeneration(): number {
  return approvalDefaultsGeneration;
}

export function subscribeApprovalDefaultsGeneration(
  listener: () => void,
): () => void {
  approvalDefaultsGenerationListeners.add(listener);
  return (): void => {
    approvalDefaultsGenerationListeners.delete(listener);
  };
}

export function invalidateApprovalDefaults(): void {
  approvalDefaultsGeneration += 1;
  approvalDefaultsGenerationListeners.forEach((listener) => listener());
}

export function approvalDefaultCacheKey(
  projectId: string,
  worktreeId?: string,
): string {
  if (
    worktreeId &&
    (projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
      projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
      projectId === STANDALONE_CHAT_PROJECT_ID)
  ) {
    return `${projectId}/${worktreeId}`;
  }
  return projectId;
}

const provisionalApprovalModeResolutions = new Map<string, Promise<void>>();

function provisionalResolutionKey(
  sel: WorktreeSelection,
  chatId: string,
): string {
  return `${worktreeKey(sel)}/${chatId}`;
}

/**
 * The fresh approval-default lookup still pending for a starter that shows a
 * provisional (cached) mode, or `undefined` when none is. Senders await it
 * before reading the tab's mode, so a provisional value never reaches a turn.
 */
export function pendingProvisionalApprovalMode(
  sel: WorktreeSelection,
  chatId: string,
): Promise<void> | undefined {
  return provisionalApprovalModeResolutions.get(
    provisionalResolutionKey(sel, chatId),
  );
}

/**
 * Resolves the default (`ChatApprovalsSlice.fetchApprovalDefault`) for a
 * just-created tab and stamps `approvalMode` onto
 * that tab — but only if nothing else (the user via the picker, or a
 * faster-resolving concurrent lookup) has set an explicit mode in the
 * meantime. The returned mode is the tab's latest explicit value, so callers
 * that commit canonical tab creation can persist the resolved default (or a
 * user choice that won the race) atomically with the new tab.
 *
 * Explicit tab creation stays synchronous and can use a cached value while a
 * fresh lookup is pending. A new worktree's starter may also be exposed at
 * once with the cached default, marked `approvalModeProvisional` (CAN-6957):
 * this helper still runs the fresh lookup for it, replaces the mode only while
 * the marker is set (the picker clears it, so a user choice wins), and clears
 * the marker on every exit. Without a cached value the starter waits for the
 * lookup before it is exposed, so its first rendered mode is authoritative.
 */
export async function applyResolvedApprovalModeForNewTab(
  sel: WorktreeSelection,
  chatId: string,
  set: ChatSet,
  get: ChatGet,
): Promise<ApprovalMode | undefined> {
  const key = worktreeKey(sel);
  const existingTab = get().worktreeChats[key]?.tabs.find(
    (entry) => entry.id === chatId,
  );
  if (existingTab?.kind !== 'file' && existingTab?.approvalMode !== undefined) {
    if (existingTab.approvalModeProvisional === true) {
      // Keep this path free of any `await` before the resolution registers:
      // senders find the pending lookup only once it is registered, so a gap
      // here would let the cached mode reach a turn.
      return resolveProvisionalApprovalMode(sel, chatId, set, get);
    }
    return existingTab.approvalMode;
  }

  // Tab creation is a durability boundary, so confirm the current main-owned
  // default instead of trusting a cache that may have been warmed while a
  // Settings preference update was still in flight. A forced request also
  // supersedes any older in-flight lookup for this scope, preventing that
  // older response from replacing the creation-time result.
  const mode = await get().fetchApprovalDefault(sel.projectId, sel.worktreeId, {
    forceFresh: true,
  });
  set((state) => {
    const wc = state.worktreeChats[key];
    if (!wc) return state;
    const tab = wc.tabs.find((t) => t.id === chatId);
    if (!tab || tab.kind === 'file' || tab.approvalMode !== undefined) {
      return state;
    }
    const updatedTabs = wc.tabs.map((t) =>
      t.id === chatId ? { ...t, approvalMode: mode } : t,
    );
    const updated = { ...wc, tabs: updatedTabs };
    return { worktreeChats: { ...state.worktreeChats, [key]: updated } };
  });
  const tab = get().worktreeChats[key]?.tabs.find(
    (entry) => entry.id === chatId,
  );
  return tab?.kind === 'file' ? undefined : tab?.approvalMode;
}

/** Applies the fresh mode, unless the tab is gone or the picker won. */
function clearProvisionalMarker(
  set: ChatSet,
  key: string,
  chatId: string,
  fresh: ApprovalMode | undefined,
): void {
  set((state) => {
    const wc = state.worktreeChats[key];
    if (!wc) return state;
    const tab = wc.tabs.find((t) => t.id === chatId);
    // Closed mid-lookup, or the picker already cleared the marker.
    if (!tab || tab.kind === 'file' || tab.approvalModeProvisional !== true) {
      return state;
    }
    const updatedTabs = wc.tabs.map((t) =>
      t.id === chatId
        ? {
            ...t,
            ...(fresh === undefined ? {} : { approvalMode: fresh }),
            approvalModeProvisional: undefined,
          }
        : t,
    );
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [key]: { ...wc, tabs: updatedTabs },
      },
    };
  });
}

async function resolveProvisionalApprovalMode(
  sel: WorktreeSelection,
  chatId: string,
  set: ChatSet,
  get: ChatGet,
): Promise<ApprovalMode | undefined> {
  const key = worktreeKey(sel);
  const resolutionKey = provisionalResolutionKey(sel, chatId);
  // One lookup per tab: a second caller joins the one in flight, so every
  // waiter is released by the same lookup and none is replaced.
  const inFlight = provisionalApprovalModeResolutions.get(resolutionKey);
  if (inFlight) {
    await inFlight;
    const joined = get().worktreeChats[key]?.tabs.find(
      (entry) => entry.id === chatId,
    );
    return joined?.kind === 'file' ? undefined : joined?.approvalMode;
  }
  const resolution = (async (): Promise<void> => {
    let fresh: ApprovalMode | undefined;
    try {
      // Same durability boundary as above: never trust the cached value that
      // the provisional mode came from. `fetchApprovalDefault` already falls
      // back to the cache or 'ask' on a failed lookup.
      fresh = await get().fetchApprovalDefault(sel.projectId, sel.worktreeId, {
        forceFresh: true,
      });
    } finally {
      // Clear the marker on every exit. A lookup that throws keeps the shown
      // cached mode, the value a failed lookup resolves to anyway, and
      // propagates like the non-provisional path.
      clearProvisionalMarker(set, key, chatId, fresh);
    }
  })();
  // Senders and canonical creation only wait for the marker to clear; a failed
  // lookup leaves the cached mode in place, so they must never see it reject.
  const settled = resolution.then(
    () => undefined,
    () => undefined,
  );
  provisionalApprovalModeResolutions.set(resolutionKey, settled);
  try {
    await resolution;
  } finally {
    if (provisionalApprovalModeResolutions.get(resolutionKey) === settled) {
      provisionalApprovalModeResolutions.delete(resolutionKey);
    }
  }
  const tab = get().worktreeChats[key]?.tabs.find(
    (entry) => entry.id === chatId,
  );
  return tab?.kind === 'file' ? undefined : tab?.approvalMode;
}
