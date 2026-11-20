/**
 * Which composer starts dictation when the speech model download finishes
 * (CAN-7341). The first composer to choose Download owns it, as on macOS,
 * where a second start gets "Voice session already active". A claim is never
 * transferred: only its owner clears it.
 */

let ownerId: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Claims the automatic start; false when another composer already owns it. */
export function tryClaimSpeechModelAutostart(id: string): boolean {
  if (ownerId !== null) return ownerId === id;
  ownerId = id;
  notify();
  return true;
}

/** Gives up the claim; a no-op for anyone but the owner. */
export function clearSpeechModelAutostart(id: string): void {
  if (ownerId !== id) return;
  ownerId = null;
  notify();
}

export function isSpeechModelAutostartOwner(id: string): boolean {
  return ownerId === id;
}

/** Whether a composer other than `id` owns the automatic start. */
export function hasOtherSpeechModelAutostartOwner(id: string): boolean {
  return ownerId !== null && ownerId !== id;
}

export function getSpeechModelAutostartOwner(): string | null {
  return ownerId;
}

export function subscribeSpeechModelAutostart(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
