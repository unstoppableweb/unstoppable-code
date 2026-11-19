import type { OpenCodeAccountSnapshot } from '@canopy/protocol/remote-control/shell';

// Owned by the connection/discovery lifecycle. Never persisted: a previous
// account must not reappear from disk before native discovery has completed.
let snapshot: OpenCodeAccountSnapshot | undefined;
const listeners = new Set<() => void>();

export function peekOpenCodeAccounts(): OpenCodeAccountSnapshot | undefined {
  return snapshot === undefined ? undefined : structuredClone(snapshot);
}

export function publishOpenCodeAccounts(
  value: OpenCodeAccountSnapshot | undefined,
): void {
  snapshot = value === undefined ? undefined : structuredClone(value);
  for (const listener of Array.from(listeners)) listener();
}

export function onOpenCodeAccountsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
