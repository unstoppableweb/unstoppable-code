import { refusesPairedComputerIds } from '../../shared/paired-computer-target';
import { IdentifierValidationError } from '../lib/validation';

/**
 * Refuses a request that addresses a paired computer's project, task or chat
 * (CAN-7757, CAN-8065). Main serves only this computer's ids, which are never
 * qualified, so such an id must never be resolved as a local one. Covers
 * every `registerIpcHandler` channel and `onIpcMessage` listener, for this
 * computer's windows and for remote controllers alike: an argument that is
 * exactly a paired computer's id, or an address field holding one in a
 * request or its address containers (`ipcArgumentsAddressPairedComputer`),
 * unless the channel is a reviewed exception
 * (`PAIRED_COMPUTER_ID_CHANNELS`).
 */
export function refusePairedComputerIds(
  channel: string,
  args: readonly unknown[],
): void {
  if (refusesPairedComputerIds(channel, args))
    throw new IdentifierValidationError(
      'Invalid id: it belongs to another computer',
    );
}
