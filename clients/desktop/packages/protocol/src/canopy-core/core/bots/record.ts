import { z } from 'zod';

import type { BotColor, BotGlyph } from '../../../bot-glyph';
import type { BotId } from '../../../chat-targets';
import { SIDEBAR_ITEM_GROUP_COLORS } from '../../sidebar-values';

/** Name limits shared by every host that validates a Bot name. */
export const BOT_NAME_MAX_LENGTH = 40;
/** One line; a newline is refused rather than trimmed. */
export const BOT_DESCRIPTION_MAX_LENGTH = 200;

/**
 * The same rule as `isBotId` in `@canopy/protocol/chat-targets`: the default
 * Bot's ID or `bot_` plus a 26-character lowercase Crockford ULID. Kept as a
 * type-only import of that module: evaluating it from this core module breaks
 * the Electron parallel lane's ESM named imports of `isBotProjectId` (CAN-6351
 * shared module cache). A protocol test keeps both rules in agreement.
 */
const BOT_ID_PATTERN = /^(?:app_advisor|bot_[0-9a-hjkmnp-tv-z]{26})$/;

export const BotIdSchema = z
  .string()
  .refine((value): value is BotId => BOT_ID_PATTERN.test(value), {
    message: 'Expected app_advisor or bot_<lowercase ULID>.',
  });

const IsoTimestampSchema = z.iso.datetime({ offset: true });

/**
 * User-picked identity color. A custom hex is user data in lowercase
 * `#rrggbb` form (the glyph picker normalizes to it), rendered only through
 * the shared contrast helper; never a CSS expression or host path.
 */
export const BotColorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('theme'),
    key: z.enum(SIDEBAR_ITEM_GROUP_COLORS),
  }),
  z.strictObject({
    kind: z.literal('custom'),
    hex: z.string().regex(/^#[0-9a-f]{6}$/),
  }),
]);

/**
 * Runtime validator for `BotGlyph` (`@canopy/protocol/bot-glyph`). The checks
 * below keep the two in agreement in both directions.
 */
export const BotGlyphSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('default') }),
  z.strictObject({
    kind: z.literal('icon'),
    name: z.string().min(1).max(64),
    color: BotColorSchema,
  }),
  z.strictObject({
    kind: z.literal('emoji'),
    emoji: z.string().min(1).max(32),
    color: BotColorSchema,
  }),
]);

/** A pin is placement plus context hints, never a permission. */
export const BotPinSchema = z.strictObject({
  /** Saved local project ID. Pins to deleted projects are kept but filtered on read. */
  projectId: z.string().min(1),
  pinnedAt: IsoTimestampSchema,
});

export const BotNameSchema = z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH);

export const BotDescriptionSchema = z
  .string()
  .refine((value) => !/[\r\n]/.test(value), {
    message: 'A Bot description is one line.',
  })
  .transform((value) => value.trim())
  .pipe(z.string().max(BOT_DESCRIPTION_MAX_LENGTH));

/**
 * One registry row. The internal project ID is derived from `botId`
 * (`projectIdForBotId`), never stored. Instructions, model, plugins and
 * retention are not part of the record.
 */
export const BotRecordSchema = z.strictObject({
  botId: BotIdSchema,
  kind: z.enum(['default', 'custom']),
  name: BotNameSchema,
  description: BotDescriptionSchema.nullable(),
  glyph: BotGlyphSchema,
  /** Ordered. */
  pins: z.array(BotPinSchema),
  /** Listed in the Bots section; true when there are no pins. */
  showInSidebar: z.boolean(),
  /** Bots section seat, as for Work Entries. */
  pinnedToTop: z.boolean(),
  /** Reserved for BOTS-04 (Primary chat identity); null until then. */
  primaryChatId: z.string().min(1).nullable(),
  /** Reserved for BOTS-04; increments on handoff. 0 until then. */
  primaryRevision: z.number().int().nonnegative(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  /** Optimistic concurrency for every write to this record. */
  revision: z.number().int().nonnegative(),
  /** Tombstone; a deleted Bot is unknown to every read. */
  deletedAt: IsoTimestampSchema.nullable(),
});

export type BotPin = z.output<typeof BotPinSchema>;
export type BotRecord = z.output<typeof BotRecordSchema>;
export type BotKind = BotRecord['kind'];

/** Compile-time agreement with the portable glyph types, in both directions. */
type Agrees<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const colorAgrees: Agrees<z.output<typeof BotColorSchema>, BotColor> = true;
const glyphAgrees: Agrees<z.output<typeof BotGlyphSchema>, BotGlyph> = true;
void colorAgrees;
void glyphAgrees;
