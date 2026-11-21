'use client';

/**
 * Client-side dismissal for the web data-sharing opt-in hints (CAN-3383).
 *
 * A dismissal is keyed by the viewer, the organization, and the feature, so
 * two accounts sharing one browser never inherit each other's choice, and
 * dismissing the feed hint in one organization says nothing about another
 * organization or feature.
 *
 * Everything here is best-effort. Storage access is wrapped in `try/catch`
 * (private mode and sandboxed frames throw) and an unreadable store reads as
 * "not dismissed": hiding a hint the viewer never dismissed is the risky
 * direction. A failed write leaves the hint visible, so it never pretends
 * the dismissal was saved.
 *
 * The store is a factory with injectable storage and event target so tests
 * can exercise failures, cross-account isolation, and cross-tab updates
 * without depending on a real browser store.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { DataSharingOptInFeature } from '@canopy/protocol';

/** The minimal `Storage` surface this module needs. */
export interface DataSharingOptInDismissalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The part of a `StorageEvent` this module reads. */
export interface DataSharingOptInStorageEvent {
  key: string | null;
}

/** The minimal event surface used for cross-tab `storage` notifications. */
export interface DataSharingOptInDismissalEventTarget {
  addEventListener(
    type: 'storage',
    listener: (event: DataSharingOptInStorageEvent) => void,
  ): void;
  removeEventListener(
    type: 'storage',
    listener: (event: DataSharingOptInStorageEvent) => void,
  ): void;
}

/** Who dismissed which hint where. Identifiers are external UUIDs. */
export interface DataSharingOptInDismissalIdentity {
  viewerUserId: string;
  organizationId: string;
  feature: DataSharingOptInFeature;
}

export const DATA_SHARING_OPT_IN_DISMISSED_KEY_PREFIX =
  'canopy:data-sharing-opt-in:dismissed:v1';

const DISMISSED_MARKER = '1';

/** The `localStorage` key holding one viewer's dismissal of one hint. */
export function dataSharingOptInDismissedKey(
  identity: DataSharingOptInDismissalIdentity,
): string {
  return [
    DATA_SHARING_OPT_IN_DISMISSED_KEY_PREFIX,
    identity.viewerUserId.toLowerCase(),
    identity.organizationId.toLowerCase(),
    identity.feature,
  ].join(':');
}

export interface DataSharingOptInDismissalStore {
  isDismissed: (identity: DataSharingOptInDismissalIdentity) => boolean;
  dismiss: (identity: DataSharingOptInDismissalIdentity) => void;
  restore: (identity: DataSharingOptInDismissalIdentity) => void;
  subscribe: (listener: () => void) => () => void;
  /** Cached client snapshot; stable until a write or storage event. */
  getSnapshot: (identity: DataSharingOptInDismissalIdentity) => boolean;
  /** Server snapshot: never dismissed, so SSR and hydration agree. */
  getServerSnapshot: () => boolean;
}

interface DismissalStoreOptions {
  getStorage: () => DataSharingOptInDismissalStorage | null;
  getEventTarget: () => DataSharingOptInDismissalEventTarget | null;
}

export function createDataSharingOptInDismissalStore({
  getStorage,
  getEventTarget,
}: DismissalStoreOptions): DataSharingOptInDismissalStore {
  const listeners = new Set<() => void>();
  const snapshots = new Map<string, boolean>();
  let attachedTarget: DataSharingOptInDismissalEventTarget | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const readDurable = (key: string): boolean => {
    let storage: DataSharingOptInDismissalStorage | null;
    try {
      storage = getStorage();
    } catch {
      return false;
    }
    if (!storage) return false;
    try {
      return storage.getItem(key) === DISMISSED_MARKER;
    } catch {
      return false;
    }
  };

  const read = readDurable;

  const invalidate = (key: string | null): void => {
    if (key === null) {
      snapshots.clear();
    } else {
      snapshots.delete(key);
    }
    notify();
  };

  // Another tab wrote (or cleared) storage. `key === null` means the whole
  // store was cleared; anything outside this module's prefix is ignored.
  const handleStorageEvent = (event: DataSharingOptInStorageEvent): void => {
    if (event.key === null) {
      invalidate(null);
      return;
    }
    if (event.key.startsWith(`${DATA_SHARING_OPT_IN_DISMISSED_KEY_PREFIX}:`)) {
      invalidate(event.key);
    }
  };

  const write = (
    identity: DataSharingOptInDismissalIdentity,
    dismissed: boolean,
  ): void => {
    const key = dataSharingOptInDismissedKey(identity);
    try {
      const storage = getStorage();
      if (storage) {
        if (dismissed) {
          storage.setItem(key, DISMISSED_MARKER);
        } else {
          storage.removeItem(key);
        }
      }
    } catch {
      // Quota or disabled storage leaves the hint visible.
    }
    invalidate(key);
  };

  return {
    isDismissed: (identity): boolean =>
      read(dataSharingOptInDismissedKey(identity)),
    dismiss: (identity): void => {
      write(identity, true);
    },
    restore: (identity): void => {
      write(identity, false);
    },
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      if (attachedTarget === null) {
        try {
          attachedTarget = getEventTarget();
          attachedTarget?.addEventListener('storage', handleStorageEvent);
        } catch {
          attachedTarget = null;
        }
      }
      return (): void => {
        listeners.delete(listener);
        if (listeners.size === 0 && attachedTarget !== null) {
          attachedTarget.removeEventListener('storage', handleStorageEvent);
          attachedTarget = null;
        }
      };
    },
    getSnapshot: (identity): boolean => {
      const key = dataSharingOptInDismissedKey(identity);
      const cached = snapshots.get(key);
      if (cached !== undefined) return cached;
      const value = read(key);
      snapshots.set(key, value);
      return value;
    },
    getServerSnapshot: (): boolean => false,
  };
}

function browserStorage(): DataSharingOptInDismissalStorage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

function browserEventTarget(): DataSharingOptInDismissalEventTarget | null {
  if (typeof window === 'undefined') return null;
  return window;
}

/** The page-wide store backed by `window.localStorage`. */
export const dataSharingOptInDismissalStore: DataSharingOptInDismissalStore =
  createDataSharingOptInDismissalStore({
    getStorage: browserStorage,
    getEventTarget: browserEventTarget,
  });

/**
 * Whether this viewer dismissed this hint, plus a dismiss callback. Reads
 * through `useSyncExternalStore` so a dismissal in another mounted hint, or in
 * another tab, hides this one too, and the server render matches hydration.
 */
export function useDataSharingOptInDismissal(
  identity: DataSharingOptInDismissalIdentity,
  store: DataSharingOptInDismissalStore = dataSharingOptInDismissalStore,
): { dismissed: boolean; dismiss: () => void } {
  const { viewerUserId, organizationId, feature } = identity;
  const getSnapshot = useCallback(
    (): boolean => store.getSnapshot({ viewerUserId, organizationId, feature }),
    [store, viewerUserId, organizationId, feature],
  );
  const dismissed = useSyncExternalStore(
    store.subscribe,
    getSnapshot,
    store.getServerSnapshot,
  );
  const dismiss = useCallback((): void => {
    store.dismiss({ viewerUserId, organizationId, feature });
  }, [store, viewerUserId, organizationId, feature]);
  return { dismissed, dismiss };
}
