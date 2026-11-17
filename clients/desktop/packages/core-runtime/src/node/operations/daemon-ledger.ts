import { join } from 'node:path';
import {
  assertStorageWriteAllowed,
  evaluateStorageWrite,
  STORAGE_OWNERSHIP,
  type StorageOwnershipRow,
} from '../../storage';
import { OperationLedgerError } from './ledger/errors';
import type { OperationLedger } from './ledger/ledger';
import { OperationService, type OperationServiceOptions } from './service';

/** The ledger under a data root, as Electron main's path helper resolves it. */
export function operationLedgerPath(dataRoot: string): string {
  return join(dataRoot, 'operations', 'operation-ledger.sqlite');
}

/** Whether these rows let the daemon write the operation ledger. */
export function isDaemonOperationLedgerOwner(
  ownership: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP,
): boolean {
  return evaluateStorageWrite('operation_ledger', 'daemon', ownership).allowed;
}

/**
 * How long one open waits for another writer's lock. The open is
 * synchronous on the daemon thread, so it stays far below the ledger's
 * default.
 */
export const DAEMON_OPERATION_LEDGER_OPEN_BUSY_TIMEOUT_MS = 50;

/**
 * After another writer refuses the open, calls answer unavailable without
 * trying again until this much time has passed.
 */
export const DAEMON_OPERATION_LEDGER_RETRY_AFTER_MS = 1_000;

export interface DaemonOperationServiceOptions {
  readonly dataRoot: string;
  /** Trusted composition only; defaults to the compiled ownership rows. */
  readonly ownership?: readonly StorageOwnershipRow[];
  readonly onError?: OperationServiceOptions['onError'];
  readonly openBusyTimeoutMs?: number;
  readonly retryAfterMs?: number;
}

/**
 * The daemon's operation service (CAN-5092). Each open first checks that
 * the ownership rows make the daemon the ledger's writer, so a mis-gated
 * composition fails closed as `unavailable` and never loads the ledger
 * module or touches the path. A ledger another writer holds is tried at
 * most once per retry window.
 */
export function createDaemonOperationService(
  options: DaemonOperationServiceOptions,
): OperationService {
  const ownership = options.ownership ?? STORAGE_OWNERSHIP;
  let refused: {
    readonly error: OperationLedgerError;
    readonly until: number;
  } | null = null;
  return new OperationService({
    openLedger: async (): Promise<OperationLedger> => {
      try {
        assertStorageWriteAllowed('operation_ledger', 'daemon', ownership);
      } catch (error) {
        throw new OperationLedgerError(
          'STORAGE_UNAVAILABLE',
          'This daemon does not own the operation ledger.',
          error,
        );
      }
      if (refused && Date.now() < refused.until) throw refused.error;
      refused = null;
      const { OperationLedger } = await import('./ledger');
      try {
        return OperationLedger.open(operationLedgerPath(options.dataRoot), {
          openBusyTimeoutMs:
            options.openBusyTimeoutMs ??
            DAEMON_OPERATION_LEDGER_OPEN_BUSY_TIMEOUT_MS,
        });
      } catch (error) {
        if (
          error instanceof OperationLedgerError &&
          error.code === 'WRITER_UNAVAILABLE'
        )
          refused = {
            error,
            until:
              Date.now() +
              (options.retryAfterMs ?? DAEMON_OPERATION_LEDGER_RETRY_AFTER_MS),
          };
        throw error;
      }
    },
    ...(options.onError && { onError: options.onError }),
  });
}
