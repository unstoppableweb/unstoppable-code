import { useSyncExternalStore } from 'react';
import type { LocalModelGatewayState } from '@canopy/desktop-shared/types';

/**
 * The device AI gateway, shared by every mounted reader: one read, then a
 * re-read whenever main reports the device gateway changed. `undefined` until
 * the first read answers; a failed read is `null` (no device gateway).
 *
 * With no reader mounted, the last answer is kept and read again when one
 * mounts: a switch unmounts every reader and mounts new ones in one commit,
 * and dropping it rendered them empty and then again when the read answered.
 */
let snapshot: LocalModelGatewayState | null | undefined;
let readSequence = 0;
const listeners = new Set<() => void>();
let stopChanges: (() => void) | null = null;

function publish(next: LocalModelGatewayState | null): void {
  // An answer equal to the held one keeps it, so readers do not render again.
  if (
    snapshot !== undefined &&
    JSON.stringify(snapshot) === JSON.stringify(next)
  ) {
    return;
  }
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
