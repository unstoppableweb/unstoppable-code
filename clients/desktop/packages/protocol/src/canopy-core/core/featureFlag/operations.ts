import { z } from 'zod';

import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  FeatureFlagEventSchema,
  FeatureFlagEventsParamsSchema,
  FeatureFlagSnapshotGetParamsSchema,
  FeatureFlagSnapshotGetResultSchema,
} from './schemas';

export const FEATURE_FLAG_GRANTS = {
  read: 'core.featureFlag.read',
} as const;

export const FEATURE_FLAG_ERROR_CODES = {
  /** The events cursor is from another daemon epoch or past retention: read a snapshot first. */
  SNAPSHOT_REQUIRED: 'core.featureFlag.snapshotRequired',
} as const;

export const FeatureFlagQueryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum([FEATURE_FLAG_ERROR_CODES.SNAPSHOT_REQUIRED]).optional(),
  details: z.strictObject({ reason: z.enum(['SNAPSHOT_REQUIRED']) }).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const FeatureFlagEventsOpenResultSchema = z.strictObject({
  subscriptionId: z.string().min(1).max(512),
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});

export const FeatureFlagEventsEndSchema = CanopyStreamEndSchema.extend({
  error: FeatureFlagQueryErrorSchema.nullable(),
});

const featureFlag = {
  plane: 'core',
  domain: 'featureFlag',
  version: 1,
  placement: 'core-only',
} as const;

// The desktop dispatcher composes these (CAN-4181 F3); the shared registries
// leave them out, so the daemon answers an unknown method until it serves them,
// and the web core joins in F4.
export const CORE_FEATURE_FLAG_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.featureFlag.snapshot.get': defineCanopyQuery({
      ...featureFlag,
      params: FeatureFlagSnapshotGetParamsSchema,
      result: FeatureFlagSnapshotGetResultSchema,
      error: FeatureFlagQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [FEATURE_FLAG_GRANTS.read],
    }),
  },
);

export const CORE_FEATURE_FLAG_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'core',
  {
    'core.featureFlag.events': defineCanopyStream({
      ...featureFlag,
      idempotency: 'inherent',
      requiredGrants: [FEATURE_FLAG_GRANTS.read],
      params: FeatureFlagEventsParamsSchema,
      openResult: FeatureFlagEventsOpenResultSchema,
      item: FeatureFlagEventSchema,
      end: FeatureFlagEventsEndSchema,
      error: FeatureFlagQueryErrorSchema,
    }),
  },
);
