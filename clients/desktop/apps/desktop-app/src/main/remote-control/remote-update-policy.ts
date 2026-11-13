import type { CoreUpdateRemotePolicy } from '@canopy/core-runtime/update';

/*
 * How `core.update` treats paired computers that control this one. Remote
 * control registers the policy when it starts; until then, and when it is
 * off, every update request from a paired computer is refused. Kept apart
 * from the remote-control service so the dispatcher never loads it.
 */

let provider: CoreUpdateRemotePolicy | null = null;
const listeners = new Set<() => void>();

/** Tells `core.update` that whether paired computers may update changed. */
export function notifyRemoteUpdatePolicyChanged(): void {
  for (const listener of [...listeners]) listener();
}

export function setRemoteUpdatePolicy(
  policy: CoreUpdateRemotePolicy | null,
): void {
  provider = policy;
  notifyRemoteUpdatePolicyChanged();
}

export const remoteUpdatePolicy: CoreUpdateRemotePolicy = {
  allowed: () => provider?.allowed() ?? false,
  nameOf: (principalId) => provider?.nameOf(principalId) ?? null,
  subscribe: (listener) => {
    listeners.add(listener);
    return (): void => {
      listeners.delete(listener);
    };
  },
};
