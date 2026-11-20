import type { AgentActionCall } from '../surface/family';

/**
 * - `opened`: the host delivered the open request to the window. The request
 *   is one-way, so this does not confirm the dialog is on screen.
 * - `unavailable`: Remote Control is unavailable here, so the host sent
 *   nothing.
 */
export type AgentRemoteControlDialogOpenResult =
  | { status: 'opened' }
  | { status: 'unavailable' };

/**
 * The window that shows this computer's Remote Control dialog (CAN-7298).
 * Opening and closing change only what the person sees, and both are safe to
 * repeat. A host with no window it can reach throws an `AgentPortError`
 * (`surface_unavailable`).
 */
export interface AgentRemoteControlDialogPort<H> {
  open(call: AgentActionCall<H>): Promise<AgentRemoteControlDialogOpenResult>;
  close(call: AgentActionCall<H>): Promise<void>;
}
