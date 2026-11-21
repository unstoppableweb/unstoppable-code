/**
 * Reads a host's provider quota projection at a trust boundary: the web's
 * shell state and the portable adapter's `providerUsage.*` replies
 * (CAN-7433) both decode through it.
 */
import { z } from 'zod';
import {
  antigravityAccountSnapshotSchema,
  openCodeAccountSnapshotSchema,
  REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_LABEL_LENGTH,
  REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS,
  REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNTS,
  type RemoteControlProviderUsageProjection,
} from './index';

const finite = z.number().finite();
const timestamp = z.string().datetime({ offset: true });
const errorSchema = z.object({
  kind: z.enum(['auth', 'network', 'service', 'unsupported', 'unknown']),
  message: z.string(),
});
const windowSchema = z.object({
  id: z.string(),
  label: z.string(),
  unlimited: z.boolean().optional(),
  usedPercent: finite.optional(),
  resetsAt: timestamp.optional(),
  windowDurationMs: finite.positive().optional(),
  spend: z
    .object({
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
      used: finite.nonnegative().optional(),
      limit: finite.nonnegative().nullable().optional(),
      isEnabled: z.boolean().optional(),
    })
    .optional(),
  credits: z
    .object({
      unit: z.enum(['usd', 'credits']),
      spent: finite.optional(),
      remaining: finite.optional(),
      total: finite.optional(),
    })
    .optional(),
});
const accountSchema = z.object({
  id: z.string().min(1).max(200),
  label: z
    .string()
    .max(REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_LABEL_LENGTH)
    .optional(),
  planLabel: z
    .string()
    .max(REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_LABEL_LENGTH)
    .optional(),
  status: z.enum([
    'active',
    'cooling',
    'error',
    'disabled',
    'refreshing',
    'pending',
  ]),
  signInRequired: z.literal(true).optional(),
  availableAt: timestamp.optional(),
  usageSource: z.enum(['live', 'passive']).optional(),
  lastUpdatedAt: timestamp.optional(),
  error: errorSchema.optional(),
  retryAt: timestamp.optional(),
  windows: z
    .array(windowSchema)
    .max(REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS),
});
const projectionSchema = z.object({
  openCodeAccounts: openCodeAccountSnapshotSchema.optional(),
  // Parsed separately below, so an invalid plan snapshot never drops quotas.
  antigravityAccount: z.unknown().optional(),
  updatedAt: timestamp,
  providers: z
    .array(
      z.object({
        provider: z.enum(['claude', 'codex', 'copilot']),
        authState: z.enum([
          'authenticated',
          'unauthenticated',
          'unknown',
          'error',
        ]),
        accountEmail: z.string().optional(),
        accountLabel: z.string().optional(),
        planLabel: z.string().optional(),
        lastUpdatedAt: timestamp.optional(),
        error: errorSchema.optional(),
        windows: z.array(windowSchema).max(100),
        accounts: z
          .array(accountSchema)
          .max(REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNTS)
          .optional(),
      }),
    )
    .max(3),
});

/** Project only display fields; invalid replacements revoke stale account data. */
export function readRemoteControlProviderUsage(
  value: unknown,
): RemoteControlProviderUsageProjection | undefined {
  const parsed = projectionSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const providers = new Set(
    parsed.data.providers.map((entry) => entry.provider),
  );
  if (providers.size !== parsed.data.providers.length) return undefined;
  for (const entry of parsed.data.providers) {
    if (!entry.accounts) continue;
    const ids = new Set(entry.accounts.map((account) => account.id));
    if (ids.size !== entry.accounts.length) return undefined;
  }
  const { antigravityAccount: rawAntigravity, ...projection } = parsed.data;
  const antigravity =
    rawAntigravity === undefined
      ? undefined
      : antigravityAccountSnapshotSchema.safeParse(rawAntigravity);
  return antigravity?.success
    ? { ...projection, antigravityAccount: antigravity.data }
    : projection;
}
