/** Freshness of the originating host, excluding display-only defaults. */
export type ModelRecoveryFreshness = (pendingRequestId?: string) => boolean;

export interface ModelRecoveryTarget {
  readonly key: string;
  /** Missing/unprovable targets refuse recovery rather than using the active chat. */
  readonly capture: () => ModelRecoveryFreshness | undefined;
}

export interface ModelRecoveryLease {
  readonly isCurrent: ModelRecoveryFreshness;
  readonly revoke: () => void;
}

// Only live recoveries are registered. Dismissed checkout keeps its lease until
// supersession/unmount; closing its modal alone is not a new selection command.
const leases = new Map<string, Set<ModelRecoveryLease>>();

export function supersedeModelRecovery(key: string): void {
  for (const lease of leases.get(key) ?? []) lease.revoke();
}

export function acquireModelRecoveryLease(
  target: ModelRecoveryTarget,
  onRevoked?: () => void,
): ModelRecoveryLease {
  const sourceIsCurrent = target.capture();
  let valid = sourceIsCurrent !== undefined;
  const registered = leases.get(target.key) ?? new Set<ModelRecoveryLease>();
  const lease: ModelRecoveryLease = {
    isCurrent: (pendingRequestId): boolean =>
      valid && sourceIsCurrent?.(pendingRequestId) === true,
    revoke: (): void => {
      if (!valid) return;
      valid = false;
      registered.delete(lease);
      onRevoked?.();
      if (registered.size === 0 && leases.get(target.key) === registered)
        leases.delete(target.key);
    },
  };
  if (valid) {
    registered.add(lease);
    leases.set(target.key, registered);
  }
  return lease;
}
