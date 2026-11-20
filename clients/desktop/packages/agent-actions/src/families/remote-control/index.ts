import { REMOTE_CONTROL_LABEL } from '@canopy/protocol/ui-labels';
import type { AgentActionCatalogEntry } from '../../catalog/types';
import { agentActionResult, portErrorResponse } from '../../action-support';
import type { AgentRemoteControlDialogPort } from '../../port/remote-control-dialog-port';
import {
  defineAgentActionFamily,
  type AgentActionDispatchOutput,
  type AgentActionFamily,
  type AgentActionFamilyJsonSchema,
} from '../../surface/family';
import {
  REMOTE_CONTROL_ACTION_TYPES,
  remoteControlActionSchema,
} from './actions';

export {
  REMOTE_CONTROL_ACTION_TYPES,
  remoteControlActionSchema,
} from './actions';

/**
 * This computer's Remote Control dialog (CAN-7298). Opening or closing it
 * changes only what the person sees, so, like `settings.open`, neither action
 * is an idempotent write: no receipts and no limits reservation. Both are
 * safe to repeat. Only a desktop has the dialog, so only the desktop host
 * registers the family.
 */
export function createRemoteControlActionFamily<H>(options: {
  port: AgentRemoteControlDialogPort<H>;
}): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'remote-control',
    types: REMOTE_CONTROL_ACTION_TYPES,
    actionSchema: remoteControlActionSchema,
    supportedTypes: () => REMOTE_CONTROL_ACTION_TYPES,
    catalog: remoteControlActionCatalog,
    dispatchJsonSchema: remoteControlDispatchJsonSchema,
    dispatch: async (action, call): Promise<AgentActionDispatchOutput> => {
      try {
        if (action.type === 'remote_control.open_dialog') {
          const outcome = await options.port.open(call);
          if (outcome.status === 'unavailable') {
            // The legacy canopy_portal.open success shape: a skipped open is
            // not an error.
            return agentActionResult(call, action.type, {
              skipped: true,
              reason: 'remote-control-unavailable',
            });
          }
          return agentActionResult(call, action.type, { opened: true });
        }
        await options.port.close(call);
        return agentActionResult(call, action.type, { closed: true });
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}

export function remoteControlActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'remote_control.open_dialog',
      category: 'remote-control',
      summary: `Open the ${REMOTE_CONTROL_LABEL} dialog on this computer, where the person pairs and manages devices.`,
      fields: [],
      example: { type: 'remote_control.open_dialog' },
      keywords: ['remote control', 'dialog', 'open', 'pair', 'devices'],
      notes: [
        `opened: true reports that the request reached the window, not that the dialog is on screen. A window where ${REMOTE_CONTROL_LABEL} is unavailable shows a notice instead of the dialog.`,
        `skipped: true with reason remote-control-unavailable means ${REMOTE_CONTROL_LABEL} is unavailable here and nothing was shown.`,
      ],
    },
    {
      type: 'remote_control.close_dialog',
      category: 'remote-control',
      summary: `Close the ${REMOTE_CONTROL_LABEL} dialog on this computer.`,
      fields: [],
      example: { type: 'remote_control.close_dialog' },
      keywords: ['remote control', 'dialog', 'close', 'pair', 'devices'],
    },
  ];
}

/** The actions have no fields. */
export const remoteControlDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {},
};
