import { z } from 'zod';

import {
  TRANSCRIPT_BLOCK_PAGE_LIMIT,
  TranscriptContentFieldSchema,
} from '../canopy-core/core/chat/content';
import { TranscriptDelegationTargetSchema } from '../canopy-core/core/chat/transcript';

/**
 * Delegate transcript reads a controller makes over the tunneled channels
 * `chat:read-delegation-page`, `chat:read-delegation-content` and
 * `chat:read-delegation-blocks` (CAN-7432). The host serves each from
 * `core.chat.transcript.page`, `core.chat.content.read` and
 * `core.chat.transcript.blocks.page` (`projection: 'bounded-v1'`) for one
 * delegation child of the named chat, and answers with
 * {@link RemoteControlTranscriptReadReplySchema} from `./shell/transcript-reads`.
 *
 * The target is always a delegation: primary transcript content and
 * standalone history are not read here. A request that fails its schema is a
 * contract violation and rejects; every request that reaches the dispatcher
 * completes with a typed reply.
 */
const localId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

const delegationRead = {
  projectId: localId,
  worktreeId: localId,
  chatId: localId,
  /** An archived worktree chat; it names the scope's own worktree. */
  archivedContainerId: localId.optional(),
  target: TranscriptDelegationTargetSchema,
};

interface DelegationReadScope {
  readonly worktreeId: string;
  readonly chatId: string;
  readonly archivedContainerId?: string | undefined;
  readonly target: { readonly chatId: string };
}

function checkDelegationRead(
  request: DelegationReadScope,
  context: z.RefinementCtx,
): void {
  if (request.target.chatId !== request.chatId)
    context.addIssue({
      code: 'custom',
      path: ['target', 'chatId'],
      message: 'The read target must belong to the chat.',
    });
  if (
    request.archivedContainerId !== undefined &&
    request.archivedContainerId !== request.worktreeId
  )
    context.addIssue({
      code: 'custom',
      path: ['archivedContainerId'],
      message: 'Archived container must match the worktree.',
    });
}

/** One page of a delegation child's stream; a later page passes `cursor`. */
export const RemoteControlDelegationPageRequestSchema = z
  .strictObject({
    ...delegationRead,
    cursor: z.string().min(1).max(2048).optional(),
  })
  .superRefine(checkDelegationRead);
export type RemoteControlDelegationPageRequest = z.output<
  typeof RemoteControlDelegationPageRequestSchema
>;

/**
 * A byte range of one field of a child row. `fieldSource: 'logical'` reads
 * the inline field when the row stores no separate body, so a field
 * shortened for display reads in full; it stays inside the child's stream.
 */
export const RemoteControlDelegationContentRequestSchema = z
  .strictObject({
    ...delegationRead,
    messageId: z.string().min(1).max(512),
    blockOrdinal: z.number().int().nonnegative(),
    field: TranscriptContentFieldSchema,
    fieldSource: z.literal('logical').optional(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(4).max(65_536),
  })
  .superRefine(checkDelegationRead);
export type RemoteControlDelegationContentRequest = z.output<
  typeof RemoteControlDelegationContentRequestSchema
>;

/** A bounded block page of one child row. */
export const RemoteControlDelegationBlocksRequestSchema = z
  .strictObject({
    ...delegationRead,
    messageId: z.string().min(1).max(512),
    firstBlockOrdinal: z.number().int().nonnegative().optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(TRANSCRIPT_BLOCK_PAGE_LIMIT),
  })
  .superRefine(checkDelegationRead)
  .refine(
    (request) =>
      request.cursor === undefined || request.firstBlockOrdinal === undefined,
    'A cursor already names the first block ordinal.',
  );
export type RemoteControlDelegationBlocksRequest = z.output<
  typeof RemoteControlDelegationBlocksRequestSchema
>;

export {
  RemoteControlTranscriptReadReplySchema,
  transcriptReadFailure,
  type RemoteControlTranscriptReadFailure,
  type RemoteControlTranscriptReadReply,
} from './shell/transcript-reads';
