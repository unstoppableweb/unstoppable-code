import { z } from 'zod';

import { CanopyStreamCursorSchema } from '../../definitions';

const FeatureFlagKeySchema = z.string().min(1).max(256);
const FeatureFlagKeysSchema = z.array(FeatureFlagKeySchema).max(512);

/** A Labs availability (`hidden`, `offered`, `on`) is a string value. */
export const FeatureFlagValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().max(256),
]);

export const FeatureFlagValuesSchema = z.record(
  FeatureFlagKeySchema,
  FeatureFlagValueSchema,
);

/** Where the values came from: the shared `FeatureFlagSnapshot` lifecycle. */
export const FeatureFlagProvenanceSchema = z.strictObject({
  status: z.enum(['not_configured', 'initializing', 'ready', 'error']),
  initialized: z.boolean(),
  error: z.string().max(1024).nullable(),
});
export type FeatureFlagProvenance = z.output<
  typeof FeatureFlagProvenanceSchema
>;

export const FeatureFlagSnapshotGetParamsSchema = z.strictObject({
  keys: FeatureFlagKeysSchema.optional(),
});

export const FeatureFlagSnapshotGetResultSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  flags: FeatureFlagValuesSchema,
  provenance: FeatureFlagProvenanceSchema,
  evaluatedAt: z.iso.datetime(),
});
export type FeatureFlagSnapshotGetResult = z.output<
  typeof FeatureFlagSnapshotGetResultSchema
>;

export const FeatureFlagEventsParamsSchema = z.strictObject({
  keys: FeatureFlagKeysSchema.optional(),
  cursor: CanopyStreamCursorSchema.nullable().optional(),
});

export const FeatureFlagEventSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  changed: FeatureFlagValuesSchema,
  provenance: FeatureFlagProvenanceSchema,
  evaluatedAt: z.iso.datetime(),
});
export type FeatureFlagEvent = z.output<typeof FeatureFlagEventSchema>;
