import { CanopyOperationError } from '@canopy/core-runtime';

/**
 * CAN-4733: the desktop dispatcher declares the receipt lookup and seal but
 * serves neither. Its in-process receipts are kept per principal, not per
 * client instance, so they are not offered to interface callers until R2-3
 * records in-process work per caller. The daemon's workers serve both.
 */
function refuseReceiptOperation(): never {
  throw new CanopyOperationError({
    kind: 'capability_unavailable',
    message: 'Receipt lookups are served by the background service only.',
    retry: { kind: 'never' },
  });
}

export const workerOperationReceiptAdapter = {
  queries: {
    'worker.operation.receipt.get': refuseReceiptOperation,
  },
  instructions: {
    'worker.operation.receipt.seal': refuseReceiptOperation,
  },
} as const;
