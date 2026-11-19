import type { AgentActionCatalogEntry } from '../../catalog/types';
import type { AgentWritePreparation } from '../../action-support';
import type { AgentActionToolResult } from '../../tools/definition';
import type { AgentInventorySyncPort } from '../../port/inventory-sync-port';
import type { AgentActionReceiptStore } from '../../receipts';
import type { AgentActionLimitsPort } from '../../limits';
import {
  defineAgentActionFamily,
  type AgentActionFamily,
  type AgentActionFamilyJsonSchema,
  type AgentActionDispatchOutput,
} from '../../surface/family';
import {
  agentActionIdempotencyKey,
  agentActionResult,
  agentActionToolResult,
  portErrorResponse,
  runIdempotentWrite,
} from '../../action-support';

export {
  INVENTORY_SYNC_ACTION_TYPES,
  inventorySyncActionSchema,
} from './actions';
import {
  INVENTORY_SYNC_ACTION_TYPES,
  inventorySyncActionSchema,
} from './actions';

/**
 * This computer's "Sync lists to the web" switch (CAN-7262). Only a desktop
 * syncs inventory, so only the desktop host registers the family. Turning
 * the switch off always asks the person: the port owns that approval.
 */
export function createInventorySyncActionFamily<H>(options: {
  port: AgentInventorySyncPort<H>;
  receipts: AgentActionReceiptStore<H>;
  limits: AgentActionLimitsPort | null;
}): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'inventory-sync',
    types: INVENTORY_SYNC_ACTION_TYPES,
    actionSchema: inventorySyncActionSchema,
    supportedTypes: () => INVENTORY_SYNC_ACTION_TYPES,
    catalog: inventorySyncActionCatalog,
    dispatchJsonSchema: inventorySyncDispatchJsonSchema,
    dispatch: async (action, call): Promise<AgentActionDispatchOutput> => {
      try {
        if (action.type === 'inventory_sync.get_state') {
          const state = await options.port.getState(call);
          return agentActionToolResult(
            agentActionResult(call, action.type, { ...state }),
          );
        }
        const enabled = action.enabled;
        return await runIdempotentWrite({
          receipts: options.receipts,
          limits: options.limits,
          kind: 'inventory_sync.set_enabled',
          call,
          idempotencyKey: agentActionIdempotencyKey(action.type, call, action),
          payload: action,
          prepare: (): Promise<AgentWritePreparation> =>
            Promise.resolve({
              ok: true,
              parentDepth: 0,
              write: async (): Promise<AgentActionToolResult> => {
                const result = await options.port.setEnabled({ enabled }, call);
                return agentActionToolResult(
                  agentActionResult(call, action.type, {
                    changed: result.changed,
                    stateAtCommit: { ...result.stateAtCommit },
                  }),
                );
              },
            }),
        });
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}

export function inventorySyncActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'inventory_sync.get_state',
      category: 'remote-control',
      summary:
        "Read this computer's Sync lists to the web switch and whether syncing is paused.",
      fields: [],
      example: { type: 'inventory_sync.get_state' },
      keywords: [
        'inventory',
        'sync',
        'web',
        'lists',
        'remote control',
        'allow incoming',
      ],
      notes: [
        'syncing is true only when the switch is on, Allow incoming is on and the person is signed in.',
        'pausedReason is allow_incoming_off while the switch is on but Allow incoming is off.',
      ],
    },
    {
      type: 'inventory_sync.set_enabled',
      category: 'remote-control',
      summary: "Turn this computer's Sync lists to the web switch on or off.",
      fields: [
        {
          name: 'enabled',
          type: 'boolean',
          required: true,
          description: 'Whether this computer syncs its lists to the web.',
        },
      ],
      example: { type: 'inventory_sync.set_enabled', enabled: false },
      keywords: [
        'inventory',
        'sync',
        'web',
        'lists',
        'remote control',
        'opt out',
      ],
      notes: [
        "Turning off always asks the person, then removes this computer's lists from the web in the background; deleteStatus reports it.",
        "Turning on needs Allow incoming and starts uploading this computer's lists.",
        'Results describe state at commit. Replayed receipts are historical and must not be used as a current snapshot.',
      ],
    },
  ];
}

export const inventorySyncDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    enabled: { type: 'boolean' },
  },
  allOf: [
    {
      if: { properties: { type: { const: 'inventory_sync.set_enabled' } } },
      then: { required: ['enabled'] },
    },
  ],
};
