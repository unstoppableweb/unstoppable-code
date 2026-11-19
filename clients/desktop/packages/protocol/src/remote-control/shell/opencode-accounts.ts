import { z } from 'zod';

export type OpenCodeAccountMethod = 'key' | 'oauth' | 'external' | 'env';

export interface OpenCodeUsageWindow {
  id: 'rolling' | 'weekly' | 'monthly';
  percent: number;
  resetsAt: string;
}

/** The runtime schema requires all usage fields for ready and strips them on failure. */
export interface OpenCodeAccountUsage {
  status:
    | 'unsupported'
    | 'not-selected'
    | 'sign-in-required'
    | 'unavailable'
    | 'ready';
  plan?: 'OpenCode Go';
  checkedAt?: string;
  windows?: OpenCodeUsageWindow[];
}

export interface OpenCodeAccount {
  label: string;
  method: OpenCodeAccountMethod;
  /** Reported by the native active-connection API, never inferred from order. */
  selected: boolean;
  needsSignIn: boolean;
  /** Read from the selected provider's usage API, never derived from chat tokens. */
  usage?: OpenCodeAccountUsage;
}

export interface OpenCodeAccountProvider {
  id: string;
  name: string;
  accounts: OpenCodeAccount[];
}

export interface OpenCodeAccountSnapshot {
  status: 'ready' | 'unavailable';
  updatedAt: string;
  /** Empty when unavailable; never retain a previous account after failure. */
  providers: OpenCodeAccountProvider[];
}

/** Display metadata only. Never accepts credential values or provider settings. */
const usageSchema: z.ZodType<OpenCodeAccountUsage> = z.union([
  z.object({
    status: z.enum([
      'unsupported',
      'not-selected',
      'sign-in-required',
      'unavailable',
    ]),
  }),
  z.object({
    status: z.literal('ready'),
    plan: z.literal('OpenCode Go'),
    checkedAt: z.string().datetime({ offset: true }),
    windows: z
      .array(
        z.object({
          id: z.enum(['rolling', 'weekly', 'monthly']),
          percent: z.number().finite().min(0).max(100),
          resetsAt: z.string().datetime({ offset: true }),
        }),
      )
      .length(3)
      .refine(
        (windows) => new Set(windows.map((window) => window.id)).size === 3,
      ),
  }),
]);
const accountSchema = z.object({
  label: z.string().max(320),
  method: z.enum(['key', 'oauth', 'external', 'env']),
  selected: z.boolean(),
  needsSignIn: z.boolean(),
  usage: usageSchema.optional(),
});
const providerSchema = z.object({
  id: z.string().min(1).max(320),
  name: z.string().max(320),
  accounts: z.array(accountSchema).max(50),
});

const providerListSchema = z
  .array(providerSchema)
  .max(50)
  .refine(
    (providers) =>
      new Set(providers.map((provider) => provider.id)).size ===
      providers.length,
  )
  .refine(
    (providers) =>
      providers.reduce(
        (total, provider) => total + provider.accounts.length,
        0,
      ) <= 200,
  );
export const openCodeAccountMetadataSchema = z.object({
  providers: providerListSchema,
});

/** `ready` means metadata was read, not that credentials were validated. */
export const openCodeAccountSnapshotSchema: z.ZodType<OpenCodeAccountSnapshot> =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('ready'),
      updatedAt: z.string().datetime({ offset: true }),
      providers: providerListSchema,
    }),
    z.object({
      status: z.literal('unavailable'),
      updatedAt: z.string().datetime({ offset: true }),
      providers: z.tuple([]),
    }),
  ]);
