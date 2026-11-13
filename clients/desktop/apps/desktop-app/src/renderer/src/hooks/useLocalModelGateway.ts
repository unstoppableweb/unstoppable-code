import { useSyncExternalStore } from 'react';
import type { LocalModelGatewayState } from '@canopy/desktop-shared/types';

/**
 * The device AI gateway, shared by every mounted reader: one read, then a
 * re-read whenever main reports the device gateway changed. `undefined` until
 * the first read answers; a failed read is `null` (no device gateway).
 */
let snapshot: LocalModelGatewayState | null | undefined;
let readSequence = 0;
const listeners = new Set<() => void>();
let stopChanges: (() => void) | null = null;

function publish(next: LocalModelGatewayState | null): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function read(): void {
  const sequence = ++readSequence;
  void window.api.localModelGateway.read().then(
    (state) => {
      if (sequence === readSequence) publish(state);
    },
    () => {
      if (sequence === readSequence) publish(null);
    },
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (stopChanges === null) {
    stopChanges = window.api.localModelGateway.onChanged(read);
    read();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || stopChanges === null) return;
    stopChanges();
    stopChanges = null;
    snapshot = undefined;
  };
}

function getSnapshot(): LocalModelGatewayState | null | undefined {
  return snapshot;
}

export function useLocalModelGateway():
  | LocalModelGatewayState
  | null
  | undefined {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Re-read after this window saved, without waiting for main's push. */
export function refreshLocalModelGateway(): void {
  if (stopChanges !== null) read();
}
