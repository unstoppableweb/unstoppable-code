import { requestAddressesPairedComputer } from '@canopy/protocol/authority-qualified-id';
import { IdentifierValidationError } from '../lib/validation';

/**
 * Refuses a request that addresses a paired computer's project, task or chat
 * (CAN-7757). Main serves only this computer's ids, which are never
 * qualified, so such an id must never be resolved as a local one. Covers
 * every `registerIpcHandler` channel, for this computer's windows and for
 * remote controllers alike; see `requestAddressesPairedComputer` for the
 * fields it reads.
 */
export function refusePairedComputerIds(args: readonly unknown[]): void {
  for (const arg of args) {
    if (requestAddressesPairedComputer(arg))
      throw new IdentifierValidationError(
        'Invalid id: it belongs to another computer',
      );
  }
}
