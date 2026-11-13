import { z } from 'zod';

// Nested core modules use ../../ for common canopy-core contracts.

import { CanopyWorkspaceScopeSchema } from '../../common';
import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { CanopyEventSchema } from '../../wire';
import { inherentOperationErrorSchema } from '../shared';

const id = z.string().min(1).max(512);

export const CoreEventsSubscribeParamsSchema = z.strictObject({
  families: z
    .array(z.string().regex(/^(core|worker)\./))
    .min(1)
    .max(256),
  scope: CanopyWorkspaceScopeSchema.optional(),
  cursor: CanopyStreamCursorSchema.nullable().optional(),
  maxInFlight: z.number().int().min(1).max(10_000).optional(),
});
export const CoreEventsSubscribeOpenResultSchema = z
  .object({
    subscriptionId: id,
    acceptedCursor: CanopyStreamCursorSchema.nullable(),
  })
  .catchall(CanopyJsonValueSchema);
export const CoreEventsSubscribeItemSchema = CanopyEventSchema;
export const CoreEventsSubscribeErrorSchema = inherentOperationErrorSchema([
  'core.events.invalidState',
  'core.events.revisionConflict',
  'core.events.notFound',
  'core.events.snapshotRequired',
]);
export const CoreEventsSubscribeEndSchema = CanopyStreamEndSchema.extend({
  error: CoreEventsSubscribeErrorSchema.nullable(),
});

export const CoreEventsAckParamsSchema = z.strictObject({
  subscriptionId: id,
  cursor: CanopyStreamCursorSchema,
});
export const CoreEventsAckResultSchema = z
  .object({ acknowledgedCursor: CanopyStreamCursorSchema })
  .catchall(CanopyJsonValueSchema);
export const CoreEventsAckErrorSchema = inherentOperationErrorSchema([
  'core.events.invalidState',
  'core.events.revisionConflict',
  'core.events.notFound',
]);

export const CoreEventsUnsubscribeParamsSchema = z.strictObject({
  subscriptionId: id,
});
/** `unsubscribed` is false when the connection holds no such subscription. */
export const CoreEventsUnsubscribeResultSchema = z
  .object({ unsubscribed: z.boolean() })
  .catchall(CanopyJsonValueSchema);
// No operation codes: an unknown id answers `unsubscribed: false`.
export const CoreEventsUnsubscribeErrorSchema = CanopyErrorPayloadSchema.extend(
  { code: z.never().optional(), retry: CanopyQueryRetryDirectiveSchema },
);
