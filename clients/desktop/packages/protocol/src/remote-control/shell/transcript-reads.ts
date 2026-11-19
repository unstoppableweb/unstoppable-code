import { z } from 'zod';

import {
  TRANSCRIPT_BLOCK_PAGE_LIMIT,
  TranscriptContentFieldSchema,
  TranscriptFieldSourceSchema,
} from '../../canopy-core/core/chat/content';
import {
  TranscriptDelegationTargetSchema,
  TranscriptTargetSchema,
} from '../../canopy-core/core/chat/transcript';

/**
 * Child stream pages, their block pages and field bodies, read live from the
 * paired desktop through `portal.chat.transcript.page`,
 * `portal.chat.transcript.blocks.page` and `portal.chat.content.read` with the
 * {@link RemoteControlTranscriptReadReplySchema} reply.
 */
export const REMOTE_CONTROL_CAPABILITY_TRANSCRIPT_READS =
  'transcript_reads_v1' as const;

/**
 * Adds bounded block pages (`portal.chat.transcript.blocks.page`), primary
 * content reads and logical field reads. A desktop announcing it also
 * announces v1, whose reads keep their meaning.
 */
export const REMOTE_CONTROL_CAPABILITY_TRANSCRIPT_READS_V2 =
  'transcript_reads_v2' as const;

/**
 * Delivered work may outlive command expiry, so a delivered read holds its
 * admission until it completes or this long after acceptance.
 */
export const REMOTE_CONTROL_TRANSCRIPT_READ_SETTLE_MS = 300_000;

const localId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

/**
 * The chat a read selects, as the Portal knows it. The desktop resolves a
 * standalone chat to its canonical scope and archive itself.
 */
export const RemoteControlTranscriptSourceSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('worktree'),
      workspaceId: localId,
      worktreeId: localId,
      chatId: localId,
      archivedContainerId: localId.optional(),
    }),
    z.strictObject({
      kind: z.literal('standalone'),
      projectLocalId: localId,
      chatId: localId,
    }),
  ],
);
export type RemoteControlTranscriptSource = z.infer<
  typeof RemoteControlTranscriptSourceSchema
>;

const targetsSourceChat = (payload: {
  source: { chatId: string };
  target: { chatId: string };
}): boolean => payload.target.chatId === payload.source.chatId;

export const RemoteControlChatTranscriptPagePayloadSchema = z
  .strictObject({
    source: RemoteControlTranscriptSourceSchema,
    target: TranscriptDelegationTargetSchema,
    cursor: z.string().min(1).max(2048).optional(),
  })
  .refine(targetsSourceChat, 'The read target must belong to the source chat.');
export type RemoteControlChatTranscriptPagePayload = z.infer<
  typeof RemoteControlChatTranscriptPagePayloadSchema
>;

const contentRead = {
  source: RemoteControlTranscriptSourceSchema,
  messageId: z.string().min(1).max(512),
  blockOrdinal: z.number().int().nonnegative(),
  field: TranscriptContentFieldSchema,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(4).max(65_536),
};

export const RemoteControlChatContentReadPayloadSchema = z
  .strictObject({ ...contentRead, target: TranscriptDelegationTargetSchema })
  .refine(targetsSourceChat, 'The read target must belong to the source chat.');

/** v2 adds the primary target and logical field reads to v1's payload. */
export const RemoteControlChatContentReadV2PayloadSchema = z
  .strictObject({
    ...contentRead,
    target: TranscriptTargetSchema,
    fieldSource: TranscriptFieldSourceSchema.optional(),
  })
  .refine(targetsSourceChat, 'The read target must belong to the source chat.');
/** Every content read; a v1 session accepts only the v1 schema's subset. */
export type RemoteControlChatContentReadPayload = z.infer<
  typeof RemoteControlChatContentReadV2PayloadSchema
>;

/** A bounded block page of one delegation child row (v2). */
export const RemoteControlChatTranscriptBlocksPagePayloadSchema = z
  .strictObject({
    source: RemoteControlTranscriptSourceSchema,
    target: TranscriptDelegationTargetSchema,
    messageId: z.string().min(1).max(512),
    firstBlockOrdinal: z.number().int().nonnegative().optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(TRANSCRIPT_BLOCK_PAGE_LIMIT),
  })
  .refine(targetsSourceChat, 'The read target must belong to the source chat.')
  .refine(
    (payload) =>
      payload.cursor === undefined || payload.firstBlockOrdinal === undefined,
    'A cursor already names the first block ordinal.',
  );
export type RemoteControlChatTranscriptBlocksPagePayload = z.infer<
  typeof RemoteControlChatTranscriptBlocksPagePayloadSchema
>;

export type RemoteControlTranscriptReadFailure =
  | 'stale'
  | 'unavailable'
  | 'failed';

/**
 * Completes every read that reached the desktop's dispatcher. `value` is the
 * core result; no error message or path crosses the wire.
 */
export const RemoteControlTranscriptReadReplySchema = z.discriminatedUnion(
  'ok',
  [
    z.strictObject({ ok: z.literal(true), value: z.unknown() }),
    z.strictObject({
      ok: z.literal(false),
      reason: z.enum(['stale', 'unavailable', 'failed']),
    }),
  ],
);
export type RemoteControlTranscriptReadReply = z.infer<
  typeof RemoteControlTranscriptReadReplySchema
>;

/** Maps a core read's error payload to the reply's failure reason. */
export function transcriptReadFailure(
  error: unknown,
): RemoteControlTranscriptReadFailure {
  if (typeof error !== 'object' || error === null) return 'failed';
  const code = 'code' in error ? error.code : undefined;
  const kind = 'kind' in error ? error.kind : undefined;
  if (
    code === 'core.chat.transcript.page.staleCursor' ||
    code === 'core.chat.transcript.blocks.page.staleCursor'
  )
    return 'stale';
  if (
    kind === 'unavailable' ||
    kind === 'capability_unavailable' ||
    code === 'unavailable'
  )
    return 'unavailable';
  return 'failed';
}
