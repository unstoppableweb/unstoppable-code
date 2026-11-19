import {
  InspectMcpRemovalRequestSchema,
  ForceMcpRemovalRequestSchema,
} from '@canopy/protocol/mcp-removal';
import { z } from 'zod';
import {
  SetInstalledItemStatusRequestSchema,
  UninstallInstalledItemRequestSchema,
} from '@canopy/protocol/installed-items';

export const INSTALLED_ITEM_ACTION_TYPES = [
  'installed_items.list_status',
  'installed_items.set_status',
  'installed_items.uninstall',
  'installed_items.list_mcp_removals',
  'installed_items.inspect_mcp_removal',
  'installed_items.force_mcp_removal',
] as const;
export const installedItemActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('installed_items.list_mcp_removals') }).strict(),
  InspectMcpRemovalRequestSchema.extend({
    type: z.literal('installed_items.inspect_mcp_removal'),
  }),
  ForceMcpRemovalRequestSchema.safeExtend({
    type: z.literal('installed_items.force_mcp_removal'),
  }),
  z.object({ type: z.literal('installed_items.list_status') }).strict(),
  SetInstalledItemStatusRequestSchema.extend({
    type: z.literal('installed_items.set_status'),
  }),
  UninstallInstalledItemRequestSchema.extend({
    type: z.literal('installed_items.uninstall'),
  }),
]);
export type InstalledItemAction = z.infer<typeof installedItemActionSchema>;
