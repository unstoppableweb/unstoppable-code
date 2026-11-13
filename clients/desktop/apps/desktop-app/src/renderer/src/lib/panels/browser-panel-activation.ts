/**
 * Browser-panel activation bridge — routes `requestBrowserPanel(...)`
 * requests (dev-server `Open`, App Advisor browser actions, `open-requested`
 * push events) into the panel grid. Browser panels are repeatable and each
 * binds exactly one session, so every request targets an EXACT browser id:
 *
 * - an already-bound panel for that id anywhere in the worktree's layout
 *   family is selected and focused for user requests, or left in place for
 *   background agent requests;
 * - otherwise a bound Browser panel is added adjacent to the origin chat
 *   (existing side group holding files/browsers, else a right split of the
 *   origin chat's group), else in the active group. A `'content-panel'`
 *   request (a script's dev-server `Open`) instead lands where a pipeline run
 *   opened from the Activity list does: the most recently used chat group,
 *   never the group of the control that was clicked, and the panel is then
 *   revealed like any content panel;
 * - a worktree whose panel layout is not available yet QUEUES the request
 *   and flushes it as soon as the layout appears;
 * - the activated browser is explicitly made the worktree's active browser,
 *   without moving logical or DOM focus for background agent requests;
 * - a window that cannot host the in-app browser (one that shows another
 *   computer) refuses every request, including queued ones replayed later.
 *
 * The target browser id is marked PENDING for the whole select/insert window
 * so the lifecycle coordinator (`browser-panel-sync.ts`) and migration
 * reconciliation can never treat the not-yet-bound session as an orphan. A
 * failed insertion is reported to the caller. The caller that created a new
 * session can then roll back that session without ever destroying an
 * existing target.
 *
 * Like `chat-panel-sync`, this deliberately lives OUTSIDE the stores and is
 * installed idempotently from `PanelGridSurface`.
 */
import { subscribeBrowserPanelActivation } from '@/lib/browserPanelActivation';
import { isInAppBrowserAvailable } from '@/lib/remote-control/in-app-browser-availability';
import type { BrowserPanelActivationTarget } from '@/lib/browserPanelActivation';
import { selectBrowserHandoff, useBrowserStore } from '@/stores/browserStore';
import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { browserPanelIdFor } from './browser-panel-identity';
import { revealPanel } from './panel-reveal';
import {
  createChatSiblingGroupToRight,
  pickContentTargetGroupId,
  pickReusableChatSiblingGroupId,
  rollbackCreatedChatSiblingGroup,
} from './sibling-panel-placement';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';
import {
  ensureMinimalDestination,
  removeMinimalDestinationProbe,
} from './minimal-layout';

let installed = false;
let unsubscribeActivation: (() => void) | null = null;
let unsubscribeLayouts: (() => void) | null = null;

/**
 * Browser ids whose activation is in flight (registered before their
 * snapshot/panel is published, cleared once the panel is bound or the
 * request is abandoned). Consulted by the lifecycle coordinator so a
 * session mid-activation is never destroyed as an orphan.
 */
const pendingActivations = new Map<string, number>();

/** Queued requests per worktree key, waiting for the panel layout. */
const queuedTargets = new Map<string, BrowserPanelActivationTarget[]>();
type QueuedActivationTimeout = ReturnType<typeof globalThis.setTimeout>;
const queuedTargetTimeouts = new Map<
  BrowserPanelActivationTarget,
  QueuedActivationTimeout
>();
const QUEUED_ACTIVATION_TIMEOUT_MS = 10_000;

export function isBrowserActivationPending(browserId: string): boolean {
  return (pendingActivations.get(browserId) ?? 0) > 0;
}

/** Makes the Browser panel selected by a grid intent the active session. */
/** A Browser panel the person selected, focused or moved in the grid. */
export interface BoundBrowserPanelSelection {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly browserId: string;
}

const boundBrowserSelectionListeners = new Set<
  (selection: BoundBrowserPanelSelection) => void
>();

/**
 * Subscribe to the person's Browser panel selections (the grid's own tab,
 * focus and move intents; not agent requests). Returns an unsubscribe fn.
 */
export function subscribeBoundBrowserPanelSelection(
  listener: (selection: BoundBrowserPanelSelection) => void,
): () => void {
  boundBrowserSelectionListeners.add(listener);
  return (): void => {
    boundBrowserSelectionListeners.delete(listener);
  };
}

export function activateBoundBrowserPanel(
  projectId: string,
  worktreeId: string,
  groupId: string | null,
  panelId?: string,
): void {
  const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  if (!layout) {
    return;
  }
  const group =
    groupId === null
      ? Object.values(layout.groups).find((candidate) =>
          candidate.tabs.some((tab) => tab.panelId === panelId),
        )
      : layout.groups[groupId];
  if (!group) {
    return;
  }
  const targetPanelId = panelId ?? group.activePanelId;
  const tab = group.tabs.find(
    (candidate) => candidate.panelId === targetPanelId,
  );
  const browserId =
    tab?.kind === 'browser' ? tab.instance?.browserId : undefined;
  if (browserId !== undefined && browserId.length > 0) {
    void useBrowserStore
      .getState()
      .setActiveBrowser(projectId, worktreeId, browserId);
    for (const listener of boundBrowserSelectionListeners) {
      listener({ projectId, worktreeId, browserId });
    }
  }
}

/**
 * Marks a browser id as activation-pending BEFORE its snapshot/panel is
 * published (push-event race guard). Returns a release function; releases
 * are ref-counted so overlapping requests cannot clear each other.
 */
export function registerPendingBrowserActivation(
  browserId: string,
): () => void {
  pendingActivations.set(
    browserId,
    (pendingActivations.get(browserId) ?? 0) + 1,
  );
  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    const count = pendingActivations.get(browserId) ?? 0;
    if (count <= 1) {
      pendingActivations.delete(browserId);
    } else {
      pendingActivations.set(browserId, count - 1);
    }
  };
}

/**
 * Background agent work must not make another browser the worktree's active
 * one while a handoff pins the browser the user needs (CAN-4663).
 */
function selectActiveBrowser(
  projectId: string,
  worktreeId: string,
  browserId: string,
  foreground: boolean,
): void {
  const handoff = selectBrowserHandoff(
    useBrowserStore.getState(),
    projectId,
    worktreeId,
  );
  if (!foreground && handoff !== null) {
    return;
  }
  void useBrowserStore
    .getState()
    .setActiveBrowser(projectId, worktreeId, browserId);
}

function activateTarget(
  target: BrowserPanelActivationTarget,
): 'unavailable' | 'activated' | 'failed' {
  if (!isInAppBrowserAvailable()) {
    return 'failed';
  }
  const { projectId, worktreeId, browserId, originChatTabId } = target;
  const shouldFocus = target.focus !== false;
  const preserveSelection =
    target.preserveSelection === true ||
    (!shouldFocus &&
      selectBrowserHandoff(
        useBrowserStore.getState(),
        projectId,
        worktreeId,
      ) !== null);
  const contentPlacement = target.placement === 'content-panel';
  const focusedElement =
    !shouldFocus &&
    typeof document !== 'undefined' &&
    typeof HTMLElement !== 'undefined' &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
  const store = usePanelLayoutStore.getState();
  if (store.layouts[worktreeKey] === undefined) {
    return 'unavailable'; // Layout not available yet — caller queues.
  }

  const instanceKey = getPanelInstanceKey({
    kind: 'browser',
    instance: { browserId },
  });
  const existing = findPanelByInstanceKey(worktreeKey, instanceKey);
  if (existing !== null) {
    if (shouldFocus && contentPlacement) {
      // Never moved: shown where it is, like an already-open pipeline run.
      revealPanel(existing);
    } else if (shouldFocus) {
      store.ensureGroupExpanded(existing.layoutKey, existing.groupId);
      store.selectTab(existing.layoutKey, existing.groupId, existing.panelId);
      store.focusGroup(existing.layoutKey, existing.groupId);
    }
    selectActiveBrowser(projectId, worktreeId, browserId, shouldFocus);
    return 'activated';
  }

  // Retain the origin even when its chat is popped out. The main layout
  // shows its content while that chat cannot be selected in this window.
  const chatScope =
    originChatTabId === undefined ? {} : { chatScope: originChatTabId };
  const addTo = (layoutKey: string, groupId: string): string | null =>
    usePanelLayoutStore.getState().addTab(layoutKey, groupId, 'browser', {
      panelId: browserPanelIdFor(browserId),
      instance: { browserId },
      ...(shouldFocus ? {} : { activate: false }),
      ...chatScope,
    }) ??
    usePanelLayoutStore.getState().addTab(layoutKey, groupId, 'browser', {
      instance: { browserId },
      ...(shouldFocus ? {} : { activate: false }),
      ...chatScope,
    });

  let added: string | null = null;
  let addedLayoutKey = worktreeKey;
  let addedGroupId: string | null = null;
  if (getWorkspaceLayoutMode(worktreeKey) === 'minimal') {
    const extrasGroupId = ensureMinimalDestination(worktreeKey, 'browser');
    if (extrasGroupId !== null) {
      added = addTo(worktreeKey, extrasGroupId);
      addedGroupId = extrasGroupId;
      if (added !== null) removeMinimalDestinationProbe(worktreeKey, 'side');
    }
  }
  if (added === null && originChatTabId !== undefined) {
    const origin = findPanelByInstanceKey(
      worktreeKey,
      `chat:${originChatTabId}`,
    );
    if (origin !== null) {
      const layout = usePanelLayoutStore.getState().layouts[origin.layoutKey];
      if (layout) {
        // Reuse the existing non-chat file/browser sibling before splitting.
        const sideGroupId = pickReusableChatSiblingGroupId(
          layout,
          origin.groupId,
        );
        if (sideGroupId !== null) {
          added = addTo(origin.layoutKey, sideGroupId);
          addedLayoutKey = origin.layoutKey;
          addedGroupId = sideGroupId;
        }
        if (added === null && !preserveSelection) {
          const created = createChatSiblingGroupToRight(
            origin.layoutKey,
            origin.groupId,
          );
          if (created !== null) {
            added = addTo(origin.layoutKey, created.groupId);
            addedLayoutKey = origin.layoutKey;
            addedGroupId = created.groupId;
            if (added === null) {
              rollbackCreatedChatSiblingGroup(origin.layoutKey, created);
            } else if (!shouldFocus && layout.activeGroupId !== null) {
              usePanelLayoutStore
                .getState()
                .focusGroup(origin.layoutKey, layout.activeGroupId);
              if (focusedElement?.isConnected)
                focusedElement.focus({ preventScroll: true });
            }
          }
        }
      }
    }
  }

  if (added === null) {
    const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
    const groupId =
      layout === undefined
        ? null
        : contentPlacement
          ? pickContentTargetGroupId(layout)
          : layout.activeGroupId;
    if (groupId !== null) {
      added = addTo(worktreeKey, groupId);
      addedLayoutKey = worktreeKey;
      addedGroupId = groupId;
    }
  }

  if (added !== null) {
    if (shouldFocus && contentPlacement && addedGroupId !== null) {
      // A new tab can land behind a maximized sibling or in a collapsed
      // group; surface it the same way a placed pipeline run is.
      revealPanel({
        layoutKey: addedLayoutKey,
        groupId: addedGroupId,
        panelId: added,
      });
    }
    selectActiveBrowser(projectId, worktreeId, browserId, shouldFocus);
  }
  return added !== null ? 'activated' : 'failed';
}

function handleActivation(target: BrowserPanelActivationTarget): void {
  const release = registerPendingBrowserActivation(target.browserId);
  const result = activateTarget(target);
  if (result !== 'unavailable' || target.queue === false) {
    release();
    target.complete(result === 'activated');
    return;
  }
  // Queue until the target worktree's panel layout is available; the layout
  // subscription below flushes queued requests. Pending stays registered so
  // the session cannot be reaped mid-queue.
  const worktreeKey = makeWorktreePanelKey(target.projectId, target.worktreeId);
  const queue = queuedTargets.get(worktreeKey) ?? [];
  queue.push(target);
  queuedTargets.set(worktreeKey, queue);
  releaseByTarget.set(target, release);
  const timeout = globalThis.setTimeout(() => {
    const queued = queuedTargets.get(worktreeKey);
    if (!queued?.includes(target)) {
      return;
    }
    const remaining = queued.filter((candidate) => candidate !== target);
    if (remaining.length === 0) {
      queuedTargets.delete(worktreeKey);
    } else {
      queuedTargets.set(worktreeKey, remaining);
    }
    queuedTargetTimeouts.delete(target);
    const releasePending = releaseByTarget.get(target);
    releaseByTarget.delete(target);
    releasePending?.();
    target.complete(false);
  }, QUEUED_ACTIVATION_TIMEOUT_MS);
  queuedTargetTimeouts.set(target, timeout);
}

const releaseByTarget = new Map<BrowserPanelActivationTarget, () => void>();

/**
 * Drops activation requests for `browserId` still queued for a layout (its
 * session was destroyed before the layout appeared), so they can never place
 * a tab for a session that no longer exists. Each request completes as not
 * activated.
 */
export function cancelQueuedBrowserActivation(browserId: string): void {
  for (const [worktreeKey, targets] of Array.from(queuedTargets.entries())) {
    const cancelled = targets.filter(
      (target) => target.browserId === browserId,
    );
    if (cancelled.length === 0) continue;
    const remaining = targets.filter(
      (target) => target.browserId !== browserId,
    );
    if (remaining.length === 0) {
      queuedTargets.delete(worktreeKey);
    } else {
      queuedTargets.set(worktreeKey, remaining);
    }
    for (const target of cancelled) {
      const timeout = queuedTargetTimeouts.get(target);
      if (timeout !== undefined) {
        globalThis.clearTimeout(timeout);
        queuedTargetTimeouts.delete(target);
      }
      const release = releaseByTarget.get(target);
      releaseByTarget.delete(target);
      release?.();
      target.complete(false);
    }
  }
}

function flushQueuedTargets(): void {
  if (queuedTargets.size === 0) {
    return;
  }
  const layouts = usePanelLayoutStore.getState().layouts;
  for (const [worktreeKey, targets] of Array.from(queuedTargets.entries())) {
    if (layouts[worktreeKey] === undefined) {
      continue;
    }
    queuedTargets.delete(worktreeKey);
    for (const target of targets) {
      const timeout = queuedTargetTimeouts.get(target);
      if (timeout !== undefined) {
        globalThis.clearTimeout(timeout);
        queuedTargetTimeouts.delete(target);
      }
      const release = releaseByTarget.get(target);
      releaseByTarget.delete(target);
      const result = activateTarget(target);
      release?.();
      target.complete(result === 'activated');
    }
  }
}

/** Install the activation subscription once (idempotent). */
export function initBrowserPanelActivation(): void {
  if (installed) {
    return;
  }
  installed = true;

  unsubscribeActivation = subscribeBrowserPanelActivation(handleActivation);

  let previousLayouts = usePanelLayoutStore.getState().layouts;
  unsubscribeLayouts = usePanelLayoutStore.subscribe((state) => {
    if (state.layouts !== previousLayouts) {
      previousLayouts = state.layouts;
      flushQueuedTargets();
    }
  });
}

/** Test-only: tears down subscriptions and clears all module state. */
export function resetBrowserPanelActivationForTests(): void {
  unsubscribeActivation?.();
  unsubscribeLayouts?.();
  unsubscribeActivation = null;
  unsubscribeLayouts = null;
  installed = false;
  pendingActivations.clear();
  queuedTargets.clear();
  releaseByTarget.clear();
  for (const timeout of Array.from(queuedTargetTimeouts.values())) {
    globalThis.clearTimeout(timeout);
  }
  queuedTargetTimeouts.clear();
}
