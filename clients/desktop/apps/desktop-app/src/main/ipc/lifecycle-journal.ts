import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  inspectLifecycleJournal,
  lifecycleJournalLocationLabel,
  type LifecycleJournalLocationProjector,
  portableLifecycleJournalLocationLabel,
  quarantineLifecycleJournalEntry,
} from '../lib/w5-lifecycle-journal-quarantine';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import { registerIpcHandler } from './register';

const localLabel = (path: string): string =>
  lifecycleJournalLocationLabel(path);

const portableLabel = (path: string): string =>
  portableLifecycleJournalLocationLabel(path);

/**
 * The label for one call's sender: the local `~/…` location for the
 * desktop's own windows, and the portable `<data>/…` label for any Remote
 * Control bridge, so no host path reaches a controller (CAN-7443).
 */
function labelFor(sender: { id: number }): LifecycleJournalLocationProjector {
  return resolveRemoteBridgeSender(sender) === null
    ? localLabel
    : portableLabel;
}

/**
 * CAN-5335: the renderer is the user's own interface; no agent action binds
 * these (Q6 A). Quarantine validates its request itself. As the trusted host
 * adapter, it shows the local location to the desktop's own windows; Remote
 * Control controllers, browsers included (CAN-7443), get the portable label.
 * Quarantine's refusals are fixed messages that carry no location.
 */
export function registerLifecycleJournalHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.lifecycleJournalInspect, (event) =>
    inspectLifecycleJournal(labelFor(event.sender)),
  );
  registerIpcHandler(
    IPC_CHANNELS.lifecycleJournalQuarantine,
    (event, request: unknown) =>
      quarantineLifecycleJournalEntry(request, labelFor(event.sender)),
  );
}
