import { z } from 'zod';

export const INVENTORY_SYNC_ACTION_TYPES = [
  'inventory_sync.get_state',
  'inventory_sync.set_enabled',
] as const;

export const inventorySyncActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('inventory_sync.get_state'),
  }),
  z.strictObject({
    type: z.literal('inventory_sync.set_enabled'),
    enabled: z.boolean(),
  }),
]);

export type InventorySyncAction = z.output<typeof inventorySyncActionSchema>;
