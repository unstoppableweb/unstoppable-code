import { z } from 'zod';

import {
  MAX_SHARED_RUN_COMMENT_ANCHOR_MESSAGE_ID_LENGTH,
  MAX_SHARED_RUN_COMMENT_BODY_LENGTH,
  MAX_SHARED_RUN_COMMENT_THREADS,
  MAX_SHARED_RUN_COMMENTS_PER_THREAD,
} from '../../../runs';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorKindSchema,
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyRetryDirectiveSchema,
} from '../../errors';
import { PUBLICATION_GRANTS, PublicationSchema } from './operations';
import { PUBLICATION_SHARE_ERROR_CODES } from './plan-sharing';

/*
 * A shared run's comment threads (CAN-4169). `markSeen` advances the local
 * seen marker that drives the unread badge; comment bodies stay hosted. A
 * shared run's `publicationId` is its `clientLocalRunId`, the UUIDv5 desktop
 * derives from the chat and the hosted runs routes accept. The keyed
 * envelope carries `_meta.idempotencyKey`, as core.plan's writes do.
 *
 * `list`, `create`, `reply` and `update` match desktop's runs:comments:list,
 * create, reply and setStatus channels, which name the shared chat rather
 * than its publication; the desktop dispatcher serves them (CAN-4169 PR 3b).
 */

const RevisionSchema = PublicationSchema.shape.revision;

export const PublicationCommentMarkSeenParamsSchema = z.strictObject({
  publicationId: PublicationSchema.shape.publicationId,
  throughRevision: RevisionSchema,
});
export type PublicationCommentMarkSeenParams = z.output<
  typeof PublicationCommentMarkSeenParamsSchema
>;

export const PublicationCommentMarkSeenResultSchema = z.strictObject({
  seenRevision: RevisionSchema,
  unreadCount: z.number().int().nonnegative(),
});

export const CORE_PUBLICATION_COMMENT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.publication.comment.markSeen': defineCanopyInstruction({
      plane: 'core',
      domain: 'publication',
      version: 1,
      placement: 'core-only',
      params: PublicationCommentMarkSeenParamsSchema,
      result: PublicationCommentMarkSeenResultSchema,
      error: CanopyErrorPayloadSchema.extend({
        // `not_found`: this core watches no shared run with that id.
        code: z.enum([PUBLICATION_SHARE_ERROR_CODES.NOT_FOUND]).optional(),
        retry: CanopyKeyedRetryDirectiveSchema,
      }),
      idempotency: 'keyed',
      requiredGrants: [PUBLICATION_GRANTS.write],
    }),
  });

// The hosted route's checks (apps/web/src/lib/runs/run-comments.ts): a body
// with a non-whitespace character, and an anchor naming the whole run or one
// message by an opaque id.
const CommentBodySchema = z
  .string()
  .max(MAX_SHARED_RUN_COMMENT_BODY_LENGTH)
  .regex(/\S/)
  .describe(
    'A comment body with a non-whitespace character. Its 16,384 limit counts UTF-16 code units (JavaScript String.length), as the hosted route does, so a supplementary character such as an emoji counts twice.',
  );

const CommentAnchorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run') }),
  z.strictObject({
    kind: z.literal('message'),
    messageId: z
      .string()
      .min(1)
      .max(MAX_SHARED_RUN_COMMENT_ANCHOR_MESSAGE_ID_LENGTH)
      .describe(
        'An opaque transcript message id. Its 512 limit counts UTF-16 code units (JavaScript String.length), as the hosted route does.',
      ),
  }),
]);

const ThreadStatusSchema = z.enum(['open', 'resolved']);

// Desktop's validateCommentThreadId: server-minted (`web:<uuid>` today) and
// bounded by the hosted VarChar(128) column.
const ThreadIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);

// A shared run's comment state, built from the hosted run detail. The
// detail's diff (up to 5 MiB), transcript, messages and plans never cross: the
// renderer relay caps a reply at 1 MiB. `anchorText` previews the message a
// thread is anchored to, whitespace collapsed and cut to 256 characters.
const SharedRunCommentSchema = z.strictObject({
  id: z.string(),
  author: z.strictObject({
    userId: z.string(),
    displayName: z.string().nullable(),
    image: z.string().nullable(),
  }),
  body: z.string().max(MAX_SHARED_RUN_COMMENT_BODY_LENGTH),
  createdAt: z.string(),
});

export const SharedRunCommentThreadSchema = z.strictObject({
  id: ThreadIdSchema,
  status: ThreadStatusSchema,
  anchor: CommentAnchorSchema,
  anchorState: z.enum(['matched', 'orphaned']),
  anchorText: z.string().max(256).nullable(),
  createdAt: z.string(),
  comments: z
    .array(SharedRunCommentSchema)
    .max(MAX_SHARED_RUN_COMMENTS_PER_THREAD),
});

export const SharedRunCommentStateSchema = z.strictObject({
  commentThreads: z
    .array(SharedRunCommentThreadSchema)
    .max(MAX_SHARED_RUN_COMMENT_THREADS),
  commentRevision: RevisionSchema,
  viewerUserId: z.string().nullable(),
});
export type SharedRunCommentState = z.output<
  typeof SharedRunCommentStateSchema
>;

/** The project, worktree and chat id charset (`validateId`). */
const SlugSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

// The shared chat, as desktop's runs:comments channels name it: the core
// resolves its hosted run from the chat's share metadata, and registers a run
// shared before comments existed on its first list.
const ChatParams = {
  projectId: SlugSchema,
  worktreeId: SlugSchema,
  chatId: SlugSchema,
};

export const PublicationCommentListParamsSchema = z.strictObject(ChatParams);

export const PublicationCommentListResultSchema = z.strictObject({
  // null: the chat is not shared, or the hosted service has no comments.
  comments: SharedRunCommentStateSchema.nullable(),
  lastSeenCommentRevision: RevisionSchema,
});
export type PublicationCommentListResult = z.output<
  typeof PublicationCommentListResultSchema
>;

export const PublicationCommentCreateParamsSchema = z.strictObject({
  ...ChatParams,
  body: CommentBodySchema,
  anchor: CommentAnchorSchema.optional(),
});

export const PublicationCommentReplyParamsSchema = z.strictObject({
  ...ChatParams,
  threadId: ThreadIdSchema,
  body: CommentBodySchema,
});

export const PublicationCommentUpdateParamsSchema = z.strictObject({
  ...ChatParams,
  threadId: ThreadIdSchema,
  status: ThreadStatusSchema,
});

export const PublicationCommentMutationResultSchema = z.strictObject({
  comments: SharedRunCommentStateSchema,
});
export type PublicationCommentMutationResult = z.output<
  typeof PublicationCommentMutationResultSchema
>;

const comment = {
  plane: 'core',
  domain: 'publication',
  version: 1,
  placement: 'core-only',
} as const;

export const PUBLICATION_COMMENT_ERROR_CODES = {
  // resource_exhausted, retry never: the hosted thread or comment cap (429).
  LIMIT_REACHED: 'core.publication.commentLimitReached',
  // conflict, retry same_idempotency_key after a delay: the hosted write lost
  // its serializable retries and rolled back (409).
  WRITE_CONTENDED: 'core.publication.commentWriteContended',
  // unavailable, retry never: the hosted request left the process and may
  // have landed (a timeout, reset or unreadable reply).
  SEND_UNCERTAIN: 'core.publication.commentSendUncertain',
} as const;

const codes = PUBLICATION_COMMENT_ERROR_CODES;
const ErrorBase = CanopyErrorPayloadSchema.pick({
  message: true,
  details: true,
});
const NEVER = z.strictObject({ kind: z.literal('never') });
const SAME_KEY = CanopyRetryDirectiveSchema.options[2];
// A contended write is resent under its key only after a delay.
const SAME_KEY_AFTER_DELAY = z.strictObject({
  kind: z.literal('same_idempotency_key'),
  delayMs: z.number().int().positive().max(86_400_000),
});

// The hosted writes take no idempotency key, so each refusal is one variant
// with one retry, and no two variants overlap: a request that may have been
// sent is never retried, the cap is final, a contended write is retried under
// its key, and a reused key is not. A plain `unavailable` is the dispatcher's
// own refusal before anything is sent (a draining or closed runtime).
const CommentWriteErrorSchema = z.union([
  ErrorBase.extend({ kind: z.literal('unavailable'), retry: SAME_KEY }),
  ErrorBase.extend({
    kind: z.literal('unavailable'),
    code: z.literal(codes.SEND_UNCERTAIN),
    retry: NEVER,
  }),
  ErrorBase.extend({
    kind: z.literal('resource_exhausted'),
    code: z.literal(codes.LIMIT_REACHED),
    retry: NEVER,
  }),
  ErrorBase.extend({
    kind: z.literal('conflict'),
    code: z.literal(codes.WRITE_CONTENDED),
    retry: SAME_KEY_AFTER_DELAY,
  }),
  ErrorBase.extend({ kind: z.literal('conflict'), retry: NEVER }),
  ErrorBase.extend({
    kind: CanopyErrorKindSchema.exclude([
      'unavailable',
      'resource_exhausted',
      'conflict',
    ]),
    retry: CanopyKeyedRetryDirectiveSchema,
  }),
]);

export const CORE_PUBLICATION_COMMENT_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.publication.comment.list': defineCanopyQuery({
      ...comment,
      params: PublicationCommentListParamsSchema,
      result: PublicationCommentListResultSchema,
      error: CanopyErrorPayloadSchema.omit({ code: true }).extend({
        retry: CanopyQueryRetryDirectiveSchema,
      }),
      idempotency: 'inherent',
      // It reads a local chat's share metadata: plus workspace.read.
      requiredGrants: [PUBLICATION_GRANTS.read, 'core.workspace.read'],
    }),
  });

export const CORE_PUBLICATION_COMMENT_THREAD_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.publication.comment.create': defineCanopyInstruction({
      ...comment,
      params: PublicationCommentCreateParamsSchema,
      result: PublicationCommentMutationResultSchema,
      error: CommentWriteErrorSchema,
      idempotency: 'keyed',
      // Named by a local chat, as the list is: plus workspace.write.
      requiredGrants: [PUBLICATION_GRANTS.write, 'core.workspace.write'],
    }),
    'core.publication.comment.reply': defineCanopyInstruction({
      ...comment,
      params: PublicationCommentReplyParamsSchema,
      result: PublicationCommentMutationResultSchema,
      error: CommentWriteErrorSchema,
      idempotency: 'keyed',
      // Named by a local chat, as the list is: plus workspace.write.
      requiredGrants: [PUBLICATION_GRANTS.write, 'core.workspace.write'],
    }),
    'core.publication.comment.update': defineCanopyInstruction({
      ...comment,
      params: PublicationCommentUpdateParamsSchema,
      result: PublicationCommentMutationResultSchema,
      error: CommentWriteErrorSchema,
      idempotency: 'keyed',
      // Named by a local chat, as the list is: plus workspace.write.
      requiredGrants: [PUBLICATION_GRANTS.write, 'core.workspace.write'],
    }),
  });
