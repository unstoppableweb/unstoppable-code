// Kept apart from connection.ts so the preferences store can retire a
// connection without importing the module that reads preferences.
let connectionGeneration = 0;
const disconnectListeners = new Set<(generation: number) => void>();

/** Changes whenever the Google connection consent changes. */
export function getAntigravityConnectionGeneration(): number {
  return connectionGeneration;
}

/**
 * Called synchronously with the new generation on each disconnect. A running
 * delegate subscribes with the generation it was admitted under and stops
 * only when a later generation disconnects, so a reconnect and a delegate
 * admitted afterwards are never affected.
 */
export function onAntigravityDisconnect(
  listener: (generation: number) => void,
): () => void {
  disconnectListeners.add(listener);
  return (): void => {
    disconnectListeners.delete(listener);
  };
}

/**
 * Retires work admitted under the previous connection consent. Every consent
 * change moves the generation, so delegates fail their next recheck at a
 * native permission, managed tool call or completion. A disconnect also
 * notifies running delegates before this returns.
 */
export function retireAntigravityConnection(disconnected: boolean): void {
  connectionGeneration += 1;
  if (!disconnected) return;
  const generation = connectionGeneration;
  for (const listener of Array.from(disconnectListeners)) {
    try {
      listener(generation);
    } catch {
      // One delegate's failure must not keep the others running; each one
      // also fails its next connection recheck.
    }
  }
}
