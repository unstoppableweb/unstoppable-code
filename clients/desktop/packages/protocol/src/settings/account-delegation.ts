import { z } from 'zod';

/**
 * Account → Delegation (CAN-7571): the owner's limits for delegates in their
 * cloud chats, kept on the user account for every workspace they own. Canopy
 * reads them on each delegation create and sends them to Core as `limits`;
 * Core keeps the newest on the tree's root, so a change applies to the next
 * delegate a chat starts, never to one already running. Desktop's own
 * managed delegation settings (1 to 10 levels, default 1) are separate.
 */
export const CLOUD_DELEGATION_MAX_DEPTH = 8;
export const DEFAULT_CLOUD_DELEGATION_MAX_DEPTH = 3;
export const CLOUD_DELEGATION_MAX_CONCURRENT = 64;
export const DEFAULT_CLOUD_DELEGATION_MAX_CONCURRENT = 5;

/** The delegation settings API path, for the web route and both hosts. */
export const ACCOUNT_DELEGATION_SETTINGS_PATH = '/api/v1/settings/delegation';

const maxDepthSchema = z.number().int().min(1).max(CLOUD_DELEGATION_MAX_DEPTH);
const maxConcurrentSchema = z
  .number()
  .int()
  .min(1)
  .max(CLOUD_DELEGATION_MAX_CONCURRENT);

export const accountDelegationSettingsSchema = z.looseObject({
  /** The most levels of delegates below a chat; 1 lets only the chat start them. */
  maxDepth: maxDepthSchema,
  /** The most delegates one chat's tree runs at once; more wait their turn. */
  maxConcurrent: maxConcurrentSchema,
});

export type AccountDelegationSettings = z.infer<
  typeof accountDelegationSettingsSchema
>;

/** A change to one or both settings; the other keeps its saved value. */
export const accountDelegationSettingsUpdateSchema = z
  .strictObject({
    maxDepth: maxDepthSchema.optional(),
    maxConcurrent: maxConcurrentSchema.optional(),
  })
  .refine(
    (update) =>
      update.maxDepth !== undefined || update.maxConcurrent !== undefined,
    { message: 'Send maxDepth, maxConcurrent or both.' },
  );

export type AccountDelegationSettingsUpdate = z.infer<
  typeof accountDelegationSettingsUpdateSchema
>;

/**
 * The settings a stored pair reads as: null (never chosen) or a value outside
 * the range reads as the default.
 */
export function normalizeAccountDelegationSettings(stored: {
  readonly maxDepth: number | null | undefined;
  readonly maxConcurrent: number | null | undefined;
}): AccountDelegationSettings {
  const depth = maxDepthSchema.safeParse(stored.maxDepth);
  const concurrent = maxConcurrentSchema.safeParse(stored.maxConcurrent);
  return {
    maxDepth: depth.success ? depth.data : DEFAULT_CLOUD_DELEGATION_MAX_DEPTH,
    maxConcurrent: concurrent.success
      ? concurrent.data
      : DEFAULT_CLOUD_DELEGATION_MAX_CONCURRENT,
  };
}
