import { z } from 'zod';

import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
} from '../../errors';
import { PUBLICATION_GRANTS, PublicationSchema } from './operations';
import { PUBLICATION_SHARE_ERROR_CODES } from './plan-sharing';

/*
 * A shared run's comment threads (CAN-4169). `markSeen` advances the local
 * seen marker that drives the unread badge; comment bodies stay hosted. A
 * shared run's `publicationId` is its `clientLocalRunId`, the UUIDv5 desktop
 * derives from the chat and the hosted runs routes accept. The keyed
 * envelope carries `_meta.idempotencyKey`, as core.plan's writes do.
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
