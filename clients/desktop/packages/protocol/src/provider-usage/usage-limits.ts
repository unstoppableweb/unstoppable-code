import { z } from 'zod';

const at = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(512);
const label = z.string().min(1).max(320);
const amount = z.number().finite().min(0);

export const USAGE_LIMIT_SOURCES = [
  'native',
  'account_proxy',
  'opencode',
] as const;
export const USAGE_LIMITS_MAX_ACCOUNTS = 1_000;

/** Source adapters curate messages; raw provider errors never cross this boundary. */
export const UsageLimitsReadErrorSchema = z.strictObject({
  kind: z.enum([
    'auth',
    'network',
    'service',
    'rate_limited',
    'unsupported',
    'unknown',
  ]),
  message: z.string().min(1).max(1_024),
  retryAt: at.optional(),
});
export type UsageLimitsReadError = z.output<typeof UsageLimitsReadErrorSchema>;

export const UsageLimitWindowSchema = z.strictObject({
  kind: z.enum(['primary', 'secondary']),
  unlimited: z.boolean().optional(),
  limit: amount.optional(),
  remaining: amount.optional(),
  // Over-limit observations can exceed 100 percent.
  usedPercent: amount.optional(),
  resetsAt: at.optional(),
  windowDurationMs: amount.optional(),
});
export type UsageLimitWindow = z.output<typeof UsageLimitWindowSchema>;

export const UsageLimitBucketSchema = z.strictObject({
  id,
  label,
  scope: z
    .strictObject({
      model: z
        .strictObject({ id: id.nullable(), displayName: label.nullable() })
        .optional(),
      surface: label.nullable().optional(),
    })
    .optional(),
  windows: z.array(UsageLimitWindowSchema),
});
export type UsageLimitBucket = z.output<typeof UsageLimitBucketSchema>;

export const UsageLimitAccountSchema = z.strictObject({
  /** Snapshot-local opaque identity; never a credential identifier. */
  accountId: id,
  provider: id,
  source: z.enum(USAGE_LIMIT_SOURCES),
  label: label.optional(),
  planLabel: label.optional(),
  authState: z.enum(['authenticated', 'unauthenticated', 'unknown', 'error']),
  status: z
    .enum(['active', 'cooling', 'error', 'disabled', 'refreshing', 'pending'])
    .optional(),
  selected: z.boolean().optional(),
  needsSignIn: z.boolean().optional(),
  availableAt: at.optional(),
  inventoryObservedAt: at.nullable(),
  usageObservedAt: at.nullable(),
  usageSource: z.enum(['live', 'passive', 'unknown']),
  usageState: z.enum(['reported', 'unavailable', 'unsupported']),
  error: UsageLimitsReadErrorSchema.optional(),
  limits: z.array(UsageLimitBucketSchema),
});
export type UsageLimitAccount = z.output<typeof UsageLimitAccountSchema>;

export const UsageLimitSourceStatusSchema = z.strictObject({
  source: z.enum(USAGE_LIMIT_SOURCES),
  provider: id.optional(),
  state: z.enum(['observed', 'not_observed', 'unavailable', 'not_configured']),
  observedAt: at.nullable(),
  error: UsageLimitsReadErrorSchema.optional(),
});
export type UsageLimitSourceStatus = z.output<
  typeof UsageLimitSourceStatusSchema
>;

export const UsageLimitsSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotAt: at,
  accounts: z.array(UsageLimitAccountSchema).max(USAGE_LIMITS_MAX_ACCOUNTS),
  sources: z.array(UsageLimitSourceStatusSchema),
  completeness: z.enum(['complete', 'partial']),
});
export type UsageLimitsSnapshot = z.output<typeof UsageLimitsSnapshotSchema>;

/** Client-side wrapper; workers return only the snapshot. */
export const UsageLimitsGetResultSchema = UsageLimitsSnapshotSchema.extend({
  host: z.string().min(1),
  nextCursor: z.string().nullable(),
});
export type UsageLimitsGetResult = z.output<typeof UsageLimitsGetResultSchema>;
