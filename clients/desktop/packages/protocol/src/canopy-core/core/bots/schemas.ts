import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import {
  BotDescriptionSchema,
  BotGlyphSchema,
  BotIdSchema,
  BotNameSchema,
  BotRecordSchema,
} from './record';

const projectId = z.string().min(1).max(512);
const expectedRevision = z.number().int().nonnegative();

/** The request metadata required by every keyed Bot registry instruction. */
export const BotKeyedRequestMetadataSchema =
  CanopyRequestMetadataSchema.required({ idempotencyKey: true });

/** No filters are defined; notably, deleted records are never listed. */
export const BotListParamsSchema = z.strictObject({});

export const BotGetParamsSchema = z.strictObject({ botId: BotIdSchema });

export const BotCreateParamsSchema = z.strictObject({
  name: BotNameSchema,
  description: BotDescriptionSchema.nullable().optional(),
  glyph: BotGlyphSchema.optional(),
  pins: z.array(projectId).optional(),
  showInSidebar: z.boolean().optional(),
  pinnedToTop: z.boolean().optional(),
  _meta: BotKeyedRequestMetadataSchema,
});

const BotUpdatePatchBaseSchema = z.strictObject({
  name: BotNameSchema.optional(),
  description: BotDescriptionSchema.nullable().optional(),
  glyph: BotGlyphSchema.optional(),
  showInSidebar: z.boolean().optional(),
  pinnedToTop: z.boolean().optional(),
});

/**
 * A patch names at least one field; pins have their own instruction. One
 * object with every field optional, so a patch with several fields matches
 * exactly one schema; `minProperties` carries the rule into the catalog.
 */
export const BotUpdatePatchSchema = BotUpdatePatchBaseSchema.refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  { message: 'A Bot patch names at least one field.' },
).meta({ minProperties: 1 });

export const BotUpdateParamsSchema = z.strictObject({
  botId: BotIdSchema,
  expectedRevision,
  patch: BotUpdatePatchSchema,
  _meta: BotKeyedRequestMetadataSchema,
});

export const BotSetPinsParamsSchema = z.strictObject({
  botId: BotIdSchema,
  expectedRevision,
  projectIds: z.array(projectId),
  _meta: BotKeyedRequestMetadataSchema,
});

export const BotDeleteParamsSchema = z.strictObject({
  botId: BotIdSchema,
  expectedRevision,
  _meta: BotKeyedRequestMetadataSchema,
});

export const BotListResultSchema = z.strictObject({
  bots: z.array(BotRecordSchema),
});

export const BotResultSchema = z.strictObject({ bot: BotRecordSchema });

export type BotListParams = z.output<typeof BotListParamsSchema>;
export type BotGetParams = z.output<typeof BotGetParamsSchema>;
export type BotCreateParams = z.output<typeof BotCreateParamsSchema>;
export type BotUpdateParams = z.output<typeof BotUpdateParamsSchema>;
export type BotSetPinsParams = z.output<typeof BotSetPinsParamsSchema>;
export type BotDeleteParams = z.output<typeof BotDeleteParamsSchema>;
export type BotListResult = z.output<typeof BotListResultSchema>;
export type BotResult = z.output<typeof BotResultSchema>;
