import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { create } from 'zustand';
import {
  hasClosestMethod,
  isBrowserSurfaceTarget,
  isNodeTarget,
  isTerminalTarget,
  readTargetOwnerDocument,
} from '@/lib/keyboardShortcuts';
import { hasEscapeEnabledOverlay } from '@canopy/ui-shared/components';

const ESCAPE_KEYS = new Set(['Escape', 'Esc']);

/**
 * How long the first Escape press keeps cancellation armed. A second press
 * inside this window cancels the running turn; letting the window lapse
 * disarms the shortcut so a stray Escape never cancels on its own.
 */
export const CANCEL_SHORTCUT_CONFIRM_WINDOW_MS = 3000;
const CANCEL_SHORTCUT_OWNER_HANDOFF_GRACE_MS = 250;

let sharedDisarmTimer: ReturnType<typeof setTimeout> | null = null;
const pendingDisabledClearTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

interface CancelShortcutConfirmationState {
  /**
   * Chat key (`projectId/worktreeId/chatId`) whose Escape cancellation is
   * currently armed, or null when no confirmation is pending.
   */
  armedChatKey: string | null;
  setArmedChatKey: (chatKey: string | null) => void;
}

/**
 * Module-level store rather than hook-local state because the arming hook
 * (mounted by ChatContent / the terminal experience) and the stop button that
 * surfaces the pending confirmation (ChatInput) render in separate trees on
 * the worktree chat surface.
 */
export const useCancelShortcutConfirmationStore =
  create<CancelShortcutConfirmationState>((set) => ({
    armedChatKey: null,
    setArmedChatKey: (chatKey): void => set({ armedChatKey: chatKey }),
  }));

function clearSharedConfirmation(expectedChatKey?: string): void {
  const confirmationStore = useCancelShortcutConfirmationStore.getState();
  if (
    expectedChatKey !== undefined &&
    confirmationStore.armedChatKey !== expectedChatKey
  ) {
    return;
  }
  if (sharedDisarmTimer !== null) {
    clearTimeout(sharedDisarmTimer);
    sharedDisarmTimer = null;
  }
  if (confirmationStore.armedChatKey !== null) {
    confirmationStore.setArmedChatKey(null);
  }
}

function armSharedConfirmation(chatKey: string): void {
  clearSharedConfirmation();
  useCancelShortcutConfirmationStore.getState().setArmedChatKey(chatKey);
  sharedDisarmTimer = setTimeout(() => {
    sharedDisarmTimer = null;
    const confirmationStore = useCancelShortcutConfirmationStore.getState();
    if (confirmationStore.armedChatKey === chatKey) {
      confirmationStore.setArmedChatKey(null);
    }
  }, CANCEL_SHORTCUT_CONFIRM_WINDOW_MS);
}

function cancelPendingDisabledClear(chatKey: string): void {
  const timer = pendingDisabledClearTimers.get(chatKey);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingDisabledClearTimers.delete(chatKey);
}

function schedulePendingDisabledClear(
  chatKey: string,
  onClear: () => void,
): void {
  cancelPendingDisabledClear(chatKey);
  const timer = setTimeout(() => {
    if (pendingDisabledClearTimers.get(chatKey) !== timer) return;
    pendingDisabledClearTimers.delete(chatKey);
    clearSharedConfirmation(chatKey);
    onClear();
  }, CANCEL_SHORTCUT_OWNER_HANDOFF_GRACE_MS);
  pendingDisabledClearTimers.set(chatKey, timer);
}

function targetIsInsideShortcutBlockingUi(target: EventTarget | null): boolean {
  if (!hasClosestMethod(target)) {
    return false;
  }

  // Esc (and Esc-Esc) is ordinary input inside a terminal — vim, less, fzf,
  // and Claude Code's own TUI all consume it — and inside the in-app browser
  // chrome. Neither may cancel a chat turn or interrupt an agent running in a
  // different surface (CAN-2309).
  if (isTerminalTarget(target) || isBrowserSurfaceTarget(target)) {
    return true;
  }

  return Boolean(
    target.closest(
      '[role="dialog"], [aria-modal="true"], [data-chat-cancel-shortcut-ignore]',
    ),
  );
}

/**
 * True when a key press did not originate from any particular surface: no
 * element holds the caret, so the browser reports the document (or its body /
 * root element) as the target.
 *
 * This is common — right after a window refocus, a modal close, or a terminal
 * pane releasing the caret with no predecessor to restore (CAN-2309) — and it
 * must NOT be treated as "belongs to a different chat panel". Surface scoping
 * exists to stop a *sibling* chat from cancelling this one.
 *
 * A neutral target alone is NOT sufficient to accept the press — see
 * {@link isRenderedRoot}.
 */
function isUnscopedTarget(
  target: EventTarget | null,
  shortcutDocument: Document,
): boolean {
  return (
    target === null ||
    target === shortcutDocument ||
    target === shortcutDocument.body ||
    target === shortcutDocument.documentElement
  );
}

/**
 * True when `root` is actually on screen.
 *
 * This is the bound on the neutral-target allowance above, and it is
 * load-bearing. `active` does NOT mean "the user is looking at this": it comes
 * from panel layout (`isActiveGroup && isActiveTab`) and knows nothing about
 * the active page, while `MainPage` deliberately stays mounted behind
 * `display: none` rather than unmounting (see CLAUDE.md). So a worktree chat
 * on a hidden page can still be `enabled && active` and still listening on the
 * document. Containment normally keeps it out; because a neutral target
 * bypasses containment, rendered-ness has to take its place — otherwise
 * Esc-Esc from the Pipelines page would cancel an off-screen turn, and two
 * rendered listeners could each clear the other's armed state.
 *
 * Walking matters: `ChatContent` roots carry `display: contents` and so
 * generate no box of their own and always report invisible. Walk past only
 * those — the first ancestor that does generate a box is authoritative, and
 * stopping there is what keeps a `display: none` page from being "seen
 * through" to its visible `<main>` ancestor.
 *
 * Scope: `checkVisibility()` is called with default options, so this rejects
 * `display: none` and `content-visibility: hidden` but NOT `visibility:
 * hidden` or `opacity: 0`. That is deliberate — the case being bounded is the
 * hidden `MainPage` wrapper, and `active` bounds the rest. It is a
 * "is this surface mounted on a live page" probe, not a full paint check.
 */
function isRenderedRoot(root: HTMLElement): boolean {
  if (!root.isConnected) return false;
  let node: HTMLElement | null = root;
  while (node !== null) {
    // jsdom has no layout engine and does not implement `checkVisibility`.
    // Treat it as rendered there; the real bound is asserted in Electron UI
    // automation, and unit tests stub this to exercise the hidden case.
    if (typeof node.checkVisibility !== 'function') return true;
    const display =
      node.ownerDocument.defaultView?.getComputedStyle(node).display;
    if (display !== 'contents') return node.checkVisibility();
    node = node.parentElement;
  }
  return false;
}

/**
 * True when `doc` holds a rendered `aria-modal="true"` element that does not
 * itself contain `targetRoot`. It owns keyboard focus and Escape even when
 * it is absent from the overlay stack. A modal that hosts the chat is the
 * chat's container, not a layer above it.
 *
 * Matches `aria-modal="true"` only: non-modal pickers render
 * `role="dialog"` with `aria-modal="false"` and must not block the shortcut.
 */
export function hasOpenModalDialogAbove(
  doc: Document,
  targetRoot: Element | null,
): boolean {
  for (const modal of Array.from(
    doc.querySelectorAll<HTMLElement>('[aria-modal="true"]'),
  )) {
    if (!modal.isConnected || modal.matches('dialog:not([open])')) continue;
    if (targetRoot && modal.contains(targetRoot)) continue;
    const containedOverlay = modal.closest(
      '[data-canopy-overlay-containment="parent"]',
    );
    const pane = containedOverlay?.parentElement;
    if (targetRoot && pane && !pane.contains(targetRoot)) continue;
    // jsdom does not implement `checkVisibility`; treat it as rendered there,
    // the same way `isRenderedRoot` does.
    if (typeof modal.checkVisibility !== 'function') return true;
    if (modal.checkVisibility({ visibilityProperty: true })) return true;
  }
  return false;
}

/**
 * Whether an Escape press may arm or confirm the cancel shortcut. It defers
 * when an overlay registered through `useOverlayEscape` is open, when a
 * rendered `aria-modal="true"` dialog sits above the chat, and when the press
 * comes from a dialog, terminal, browser surface, or
 * `data-chat-cancel-shortcut-ignore` subtree.
 */
export function shouldHandleCancelRunningChatShortcut(
  event: KeyboardEvent,
  /**
   * The document this listener is scoped to. Used as the overlay-lookup
   * fallback when the target has no owner document of its own (the `Document`
   * itself, or `window`), so an auxiliary-window press is never checked
   * against the main window's overlays.
   */
  shortcutDocument: Document = document,
  /**
   * The chat surface this listener serves. A modal that contains it hosts the
   * chat rather than covering it, so it does not block the shortcut.
   */
  targetRoot: Element | null = null,
): boolean {
  if (!ESCAPE_KEYS.has(event.key)) {
    return false;
  }

  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false;
  }

  const eventDocument =
    readTargetOwnerDocument(event.target) ?? shortcutDocument;
  if (hasEscapeEnabledOverlay(eventDocument)) {
    return false;
  }

  if (hasOpenModalDialogAbove(eventDocument, targetRoot)) {
    return false;
  }

  return !targetIsInsideShortcutBlockingUi(event.target);
}

/**
 * Escape-to-cancel for a running chat turn, with a two-press confirmation:
 * the first Escape arms the shortcut (published on
 * {@link useCancelShortcutConfirmationStore} under `chatKey` so the stop
 * button can render a "Press Esc again to stop" state), and only a second
 * Escape within {@link CANCEL_SHORTCUT_CONFIRM_WINDOW_MS} actually cancels
 * (ECW-8986).
 */
export function useCancelRunningChatShortcut({
  enabled,
  active = true,
  onCancel,
  chatKey,
  ownerDocument,
  targetRootRef,
}: {
  /** Whether the represented chat currently has a cancellable running turn. */
  enabled: boolean;
  /** Whether this mounted surface currently owns document-level shortcuts. */
  active?: boolean;
  onCancel: () => void | Promise<void>;
  /**
   * `projectId/worktreeId/chatId` identity of the chat this shortcut cancels,
   * used to surface the armed state on that chat's stop button. Omit for
   * surfaces with no stop button to update.
   */
  chatKey?: string | null;
  /**
   * Document that owns the chat surface. Popped-out panels live in an
   * auxiliary document, so using the renderer-global `document` would make
   * Escape in the main window cancel a chat in another OS window.
   */
  ownerDocument?: Document;
  /** Active chat-panel root used to reject Escape from sibling surfaces. */
  targetRootRef?: RefObject<HTMLElement | null>;
}): { armed: boolean } {
  const [localArmed, setLocalArmed] = useState(false);
  const sharedArmed = useCancelShortcutConfirmationStore(
    (state) =>
      chatKey !== null &&
      chatKey !== undefined &&
      state.armedChatKey === chatKey,
  );
  const armedRef = useRef(false);
  const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(enabled);
  const activeRef = useRef(active);
  const onCancelRef = useRef(onCancel);
  const chatKeyRef = useRef(chatKey);
  const cancellableChatKeyRef = useRef<string | null>(
    enabled ? (chatKey ?? null) : null,
  );
  enabledRef.current = enabled;
  activeRef.current = active;
  onCancelRef.current = onCancel;
  chatKeyRef.current = chatKey;

  const disarmLocal = useCallback((): void => {
    if (disarmTimerRef.current !== null) {
      clearTimeout(disarmTimerRef.current);
      disarmTimerRef.current = null;
    }
    if (!armedRef.current) return;
    armedRef.current = false;
    setLocalArmed(false);
  }, []);

  useLayoutEffect(() => {
    const previousChatKey = cancellableChatKeyRef.current;
    if (!enabled) {
      disarmLocal();
      if (previousChatKey !== null) {
        schedulePendingDisabledClear(previousChatKey, () => {
          if (cancellableChatKeyRef.current === previousChatKey) {
            cancellableChatKeyRef.current = null;
          }
        });
      }
      return;
    }

    // Selected-worktree hydration can briefly make the derived identity null
    // while the same running composer stays mounted. Preserve the last keyed
    // identity through that gap so its visible confirmation and second Escape
    // still refer to the same turn.
    const currentChatKey = chatKey ?? null;
    if (previousChatKey !== null) {
      cancelPendingDisabledClear(previousChatKey);
    }
    if (currentChatKey !== null) {
      cancelPendingDisabledClear(currentChatKey);
    }
    if (currentChatKey === null || currentChatKey === previousChatKey) return;
    if (previousChatKey !== null) {
      clearSharedConfirmation(previousChatKey);
    }
    cancellableChatKeyRef.current = currentChatKey;
  }, [enabled, chatKey, disarmLocal]);

  // Keep the listener mounted across status transitions. Re-registering it
  // when `enabled` changes leaves a small window where the streaming stop
  // button is already visible but an immediate Escape press is lost.
  useLayoutEffect(() => {
    let listenerActive = true;
    const shortcutDocument = ownerDocument ?? document;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!listenerActive) return;
      if (targetRootRef !== undefined) {
        const targetRoot = targetRootRef.current;
        if (targetRoot === null) return;
        if (isUnscopedTarget(event.target, shortcutDocument)) {
          // Nothing owns the caret, so containment cannot decide. Accept only
          // for a surface the user can actually see, and only while the caret
          // really is unparked.
          if (
            !isRenderedRoot(targetRoot) ||
            !isUnscopedTarget(shortcutDocument.activeElement, shortcutDocument)
          ) {
            return;
          }
        } else if (
          !isNodeTarget(event.target) ||
          !targetRoot.contains(event.target)
        ) {
          return;
        }
      }
      const shouldHandle = shouldHandleCancelRunningChatShortcut(
        event,
        shortcutDocument,
        targetRootRef?.current ?? null,
      );
      const pendingChatKey =
        chatKeyRef.current ?? cancellableChatKeyRef.current;
      const withinEnabledHandoffGrace =
        pendingChatKey !== null &&
        pendingChatKey !== undefined &&
        pendingDisabledClearTimers.has(pendingChatKey);
      if (
        (!enabledRef.current && !withinEnabledHandoffGrace) ||
        !activeRef.current ||
        !shouldHandle
      ) {
        return;
      }

      event.preventDefault();
      const currentChatKey =
        chatKeyRef.current ?? cancellableChatKeyRef.current;

      if (currentChatKey !== null && currentChatKey !== undefined) {
        if (
          useCancelShortcutConfirmationStore.getState().armedChatKey ===
          currentChatKey
        ) {
          clearSharedConfirmation(currentChatKey);
          void onCancelRef.current();
          return;
        }

        armSharedConfirmation(currentChatKey);
        return;
      }

      if (armedRef.current) {
        disarmLocal();
        void onCancelRef.current();
        return;
      }

      armedRef.current = true;
      setLocalArmed(true);
      disarmTimerRef.current = setTimeout(() => {
        disarmTimerRef.current = null;
        disarmLocal();
      }, CANCEL_SHORTCUT_CONFIRM_WINDOW_MS);
    };

    shortcutDocument.addEventListener('keydown', handleKeyDown, {
      capture: true,
    });
    return (): void => {
      // Stop this owner synchronously even though physical listener removal is
      // delayed for the keyed remount grace. A replacement owner can mount in
      // that interval and must not lose Escape to this retired closure.
      listenerActive = false;
      // A keyed confirmation is intentionally module-owned so a transient
      // composer remount cannot erase it. Keep the previous keyed listener
      // through the same short handoff grace so Escape cannot fall into the
      // cleanup/setup gap between two composer instances.
      const listenerRemovalDelay =
        chatKeyRef.current === null && cancellableChatKeyRef.current === null
          ? 0
          : CANCEL_SHORTCUT_OWNER_HANDOFF_GRACE_MS;
      setTimeout(() => {
        shortcutDocument.removeEventListener('keydown', handleKeyDown, {
          capture: true,
        });
      }, listenerRemovalDelay);
      disarmLocal();
    };
  }, [disarmLocal, ownerDocument, targetRootRef]);

  return {
    armed: chatKey !== null && chatKey !== undefined ? sharedArmed : localArmed,
  };
}
