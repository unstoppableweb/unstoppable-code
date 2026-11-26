import {
  ExclusiveMaintenanceRefusedError,
  withExclusiveOfflineMaintenance,
  type ExclusiveMaintenanceOptions,
} from './exclusive-window';

/** A refused or uncertain item-store window, with its reason and peers. */
export class ItemStoreMaintenanceRefusedError extends ExclusiveMaintenanceRefusedError {
  constructor(refusal: ExclusiveMaintenanceRefusedError) {
    super(refusal.reason, {
      cause: refusal.underlying,
      peers: refusal.peers,
      held: refusal.held,
    });
    this.name = 'ItemStoreMaintenanceRefusedError';
  }
}

/**
 * CAN-4498: the backup and restore families' `quiesce` (CAN-5340
 * `FamilyOptions.quiesce`) over the exclusive offline window. Each call opens
 * its own window; callable only before this process joins root presence.
 * `op` errors pass through unchanged once a read-only window has released.
 */
export function createItemStoreQuiesce(
  options: ExclusiveMaintenanceOptions,
): <T>(op: () => Promise<T>) => Promise<T> {
  const frozen: ExclusiveMaintenanceOptions = Object.freeze({
    ...options,
    targets: Object.freeze([...options.targets]),
  });
  return async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await withExclusiveOfflineMaintenance(frozen, () => op());
    } catch (error) {
      if (
        error instanceof ExclusiveMaintenanceRefusedError &&
        !(error instanceof ItemStoreMaintenanceRefusedError)
      )
        throw new ItemStoreMaintenanceRefusedError(error);
      throw error;
    }
  };
}
