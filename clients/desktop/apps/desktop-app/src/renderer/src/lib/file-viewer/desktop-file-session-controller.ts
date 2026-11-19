import { useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand';
import {
  fileViewerKey,
  type FileViewerSession,
  type FileViewerState,
} from '@canopy/app-state';
import type { PortalFileReadPayload } from '@canopy/protocol/portal';

/** Autosave debounce; a content change to a dirty session resets this timer. */
export const AUTO_SAVE_DEBOUNCE_MS = 1200;

export interface DesktopFileSessionControllerAttachOptions {
  /**
   * Invoked exactly once per observed successful shared save transition
   * (`saving` → `idle` with an advanced preview). The desktop runtime maps this
   * to `fastRefreshWorktreeDiffStats`, keeping the projects-store dependency out
   * of the controller core (which would otherwise reintroduce a chat/projects
   * module cycle).
   */
  onSaveCommitted: (request: PortalFileReadPayload) => void;
}

/**
 * Desktop-only ownership adapter over the shared file-viewer store. It owns the
 * transient `tabId → { key, request }` registry (reference-counted per canonical
 * key), the canonical-key autosave timers, and the save-success diff-stat
 * coordination — but never the file content, baseline, mtime, dirty, status, or
 * error, all of which live exclusively in `FileViewerState.files[key]`.
 */
export interface DesktopFileSessionController {
  attachStore(
    store: StoreApi<FileViewerState>,
    options: DesktopFileSessionControllerAttachOptions,
  ): () => void;

  /**
   * Binds a tab to `request`'s session and answers the key it is bound to.
   * A tab whose session has unsaved changes stays bound to it, so the answer
   * is then its current key.
   */
  registerTab(tabId: string, request: PortalFileReadPayload): string;
  getFileKey(tabId: string): string | null;
  getSession(tabId: string): FileViewerSession | undefined;
  hasSession(tabId: string): boolean;
  isDirty(tabId: string): boolean;
  /** Ids of the registered tabs with unsaved edits; never their content. */
  dirtyTabIds(): string[];
  matches(tabId: string, key: string): boolean;

  saveTab(tabId: string): Promise<boolean>;
  /**
   * Check a tab's shared session against disk without changing activation.
   * Clean sessions take the disk version; unsaved edits are kept and flagged
   * when disk differs. A read already in flight covers this request.
   */
  refreshTab(tabId: string): void;
  discardTab(tabId: string): void;
  releaseTab(tabId: string): void;

  setAutoSaveEnabled(enabled: boolean): void;

  subscribe(listener: () => void): () => void;
  getRevision(): number;
  dispose(): void;
}

interface TabRegistration {
  key: string;
  request: PortalFileReadPayload;
}

/**
 * Factory for a fresh controller instance. Exported for isolated tests; the
 * desktop app uses the {@link desktopFileSessionController} singleton below.
 */
export function createDesktopFileSessionController(): DesktopFileSessionController {
  let store: StoreApi<FileViewerState> | null = null;
  let onSaveCommitted: ((request: PortalFileReadPayload) => void) | null = null;
  let unsubscribeStore: (() => void) | null = null;
  let autoSaveEnabled = false;

  // tabId → registration.
  const registry = new Map<string, TabRegistration>();
  // canonical key → set of tabIds referencing it (reference counting).
  const keyRefs = new Map<string, Set<string>>();
  // canonical key → queued autosave timer.
  const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  let revision = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    revision += 1;
    listeners.forEach((listener) => listener());
  };

  const cancelTimer = (key: string): void => {
    const timer = autoSaveTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      autoSaveTimers.delete(key);
    }
  };

  const scheduleTimer = (key: string): void => {
    cancelTimer(key);
    const timer = setTimeout(() => {
      autoSaveTimers.delete(key);
      // The shared transaction dedups against an in-flight write and fails
      // closed on a missing confirmed mtime — the controller only picks the
      // moment to fire. Autosave never moves focus to a conflict notice.
      void store?.getState().saveFile(key, { origin: 'autosave' });
    }, AUTO_SAVE_DEBOUNCE_MS);
    autoSaveTimers.set(key, timer);
  };

  const addKeyRef = (key: string, tabId: string): void => {
    let refs = keyRefs.get(key);
    if (!refs) {
      refs = new Set<string>();
      keyRefs.set(key, refs);
    }
    refs.add(tabId);
  };

  const releaseKeyRef = (key: string, tabId: string): void => {
    const refs = keyRefs.get(key);
    if (!refs) return;
    refs.delete(tabId);
    if (refs.size === 0) {
      // Last tab referencing this file was released: cancel its autosave timer
      // and drop the shared session so a reopen reads disk rather than
      // resurrecting the buffer. While other tabs still reference the key, the
      // timer and shared session survive so autosave keeps firing.
      keyRefs.delete(key);
      cancelTimer(key);
      store?.getState().closeFile(key);
    }
  };

  const getFileKey = (tabId: string): string | null =>
    registry.get(tabId)?.key ?? null;

  const getSession = (tabId: string): FileViewerSession | undefined => {
    const key = getFileKey(tabId);
    if (!key || !store) return undefined;
    return store.getState().files[key];
  };

  const handleStoreChange = (
    next: FileViewerState,
    prev: FileViewerState,
  ): void => {
    let changed = false;
    for (const key of Array.from(keyRefs.keys())) {
      const nextSession = next.files[key];
      const prevSession = prev.files[key];
      if (nextSession === prevSession) {
        continue;
      }
      changed = true;
      if (!nextSession) {
        cancelTimer(key);
        continue;
      }
      // A successful save advances the preview on the saving→idle transition;
      // fire the diff-stat refresh exactly once here (covers Save button,
      // shortcut, App Advisor, close-save, and autosave without duplication).
      if (
        prevSession?.status === 'saving' &&
        nextSession.status === 'idle' &&
        nextSession.preview !== prevSession.preview
      ) {
        onSaveCommitted?.(nextSession.request);
      }
      const contentChanged = prevSession?.content !== nextSession.content;
      const enteredSaving =
        prevSession?.status !== 'saving' && nextSession.status === 'saving';
      // A pending save conflict suspends autosave, including queued timers,
      // until the user resolves it; it never retries on its own.
      const conflictPending = nextSession.saveConflict != null;
      const conflictResolved =
        (prevSession?.saveConflict != null && !conflictPending) ||
        // Keeping Yours may resolve an overlap without changing the buffer.
        (nextSession.overlapResolvedRevision ?? 0) >
          (prevSession?.overlapResolvedRevision ?? 0);
      // Only a SUCCESSFUL completion (saving→idle) may reschedule. A failed save
      // (saving→error) must not loop automatically — it stays dirty until a
      // later edit or an explicit Auto Save re-enable reschedules it.
      const savedSuccessfully =
        prevSession?.status === 'saving' &&
        nextSession.status === 'idle' &&
        !conflictPending;
      // Entering a save cancels any queued debounce (we're saving now).
      if (enteredSaving || conflictPending) {
        cancelTimer(key);
      }
      // Reset the debounce on a user edit; after a save completes with newer
      // edits still dirty, or a conflict resolves with edits still dirty,
      // schedule the follow-up. Reverting to baseline (or any transition to
      // clean) cancels the queued timer.
      if (
        !conflictPending &&
        (contentChanged || savedSuccessfully || conflictResolved)
      ) {
        if (nextSession.dirty && autoSaveEnabled) {
          scheduleTimer(key);
        } else if (!nextSession.dirty) {
          cancelTimer(key);
        }
      }
    }
    if (changed) {
      notify();
    }
  };

  return {
    attachStore(nextStore, options): () => void {
      store = nextStore;
      onSaveCommitted = options.onSaveCommitted;
      unsubscribeStore = nextStore.subscribe(handleStoreChange);
      notify();
      return (): void => {
        unsubscribeStore?.();
        unsubscribeStore = null;
        store = null;
        onSaveCommitted = null;
        // Detaching cancels queued timers but never aborts an in-flight write.
        for (const key of Array.from(autoSaveTimers.keys())) {
          cancelTimer(key);
        }
        notify();
      };
    },

    registerTab(tabId, request): string {
      const key = fileViewerKey(request);
      const existing = registry.get(tabId);
      if (existing && existing.key === key) {
        // Idempotent re-registration of the same tab/file; refresh the request
        // snapshot in case the caller passes a structurally equal object.
        existing.request = request;
        return key;
      }
      if (existing) {
        // Unsaved changes outlive a path change (CAN-6540): only a save, a
        // discard or the close flow, which asks first, ends a dirty session.
        if (getSession(tabId)?.dirty === true) return existing.key;
        // Registration changed to a different file: release the old key ref
        // (the last-reference timer/closeFile rule applies) before taking the
        // new one.
        releaseKeyRef(existing.key, tabId);
      }
      registry.set(tabId, { key, request });
      addKeyRef(key, tabId);
      notify();
      return key;
    },

    getFileKey,
    getSession,

    hasSession(tabId): boolean {
      return getSession(tabId) !== undefined;
    },

    isDirty(tabId): boolean {
      return getSession(tabId)?.dirty === true;
    },

    dirtyTabIds(): string[] {
      return Array.from(registry.keys()).filter(
        (tabId) => getSession(tabId)?.dirty === true,
      );
    },

    matches(tabId, key): boolean {
      return getFileKey(tabId) === key;
    },

    saveTab(tabId): Promise<boolean> {
      const key = getFileKey(tabId);
      if (!key || !store) {
        return Promise.resolve(false);
      }
      // The shared transaction returns false for a missing/unloaded session and
      // true for a clean one — both correct here.
      return store.getState().saveFile(key);
    },

    refreshTab(tabId): void {
      const key = getFileKey(tabId);
      if (!key || !store) return;
      void store.getState().refreshFile(key);
    },

    discardTab(tabId): void {
      const key = getFileKey(tabId);
      if (!key || !store) return;
      cancelTimer(key);
      store.getState().discardEdits(key);
    },

    releaseTab(tabId): void {
      const entry = registry.get(tabId);
      if (!entry) return;
      registry.delete(tabId);
      releaseKeyRef(entry.key, tabId);
      notify();
    },

    setAutoSaveEnabled(enabled): void {
      if (enabled === autoSaveEnabled) return;
      autoSaveEnabled = enabled;
      if (enabled) {
        // Schedule a save for every registered dirty session so a toggle-on
        // while editing eventually persists (same debounce as a fresh edit).
        const files = store?.getState().files;
        if (files) {
          for (const key of Array.from(keyRefs.keys())) {
            if (files[key]?.dirty && files[key]?.saveConflict == null) {
              scheduleTimer(key);
            }
          }
        }
      } else {
        // Toggling off cancels queued debounce timers. In-flight writes still
        // complete — there is no value in aborting a command mid-flight.
        for (const key of Array.from(autoSaveTimers.keys())) {
          cancelTimer(key);
        }
      }
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },

    getRevision(): number {
      return revision;
    },

    dispose(): void {
      unsubscribeStore?.();
      unsubscribeStore = null;
      store = null;
      onSaveCommitted = null;
      for (const key of Array.from(autoSaveTimers.keys())) {
        cancelTimer(key);
      }
      registry.clear();
      keyRefs.clear();
      listeners.clear();
    },
  };
}

/** The single desktop-renderer controller instance. */
export const desktopFileSessionController =
  createDesktopFileSessionController();

// --- React bindings ---------------------------------------------------------
// `useSyncExternalStore` snapshots must be referentially stable: the revision is
// a number, dirty is a boolean, and sessions are the actual shared session
// objects (immutably replaced only when they change). The subscribe reference
// must also be stable across renders, so these module-level wrappers front the
// singleton (and keep `this` bound to it).

const subscribeController = (listener: () => void): (() => void) =>
  desktopFileSessionController.subscribe(listener);
const getControllerRevision = (): number =>
  desktopFileSessionController.getRevision();

/** Re-renders on any registration or shared-session change. */
export function useDesktopFileSessionRevision(): number {
  return useSyncExternalStore(
    subscribeController,
    getControllerRevision,
    getControllerRevision,
  );
}

/**
 * The shared session for a tab. When `expectedKey` is provided, resolves to
 * `undefined` unless the tab is still registered to that canonical key (guards
 * against a stale modal/handler acting on a replacement file identity).
 */
export function useDesktopFileTabSession(
  tabId: string,
  expectedKey?: string,
): FileViewerSession | undefined {
  return useSyncExternalStore(
    subscribeController,
    () => {
      const session = desktopFileSessionController.getSession(tabId);
      if (expectedKey && session && session.key !== expectedKey) {
        return undefined;
      }
      return session;
    },
    () => undefined,
  );
}

/** The dirty state of a tab's shared session. */
export function useDesktopFileTabDirty(tabId: string): boolean {
  return useSyncExternalStore(
    subscribeController,
    () => desktopFileSessionController.isDirty(tabId),
    () => false,
  );
}
