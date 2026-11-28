import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';

const ID = z.string().min(1).max(512);
/** Bounded so `desktop-window:<id>` fits a caller principal (512). */
const WINDOW_INSTANCE_ID = z.string().min(1).max(256);

/** Held by the daemon's ordinary local-user caller only (CAN-8039). */
export const CORE_CLIENT_WINDOW_GRANTS = {
  issue: 'core.client.window.issue',
} as const;

/** What a window may do on one granted terminal. */
export const CORE_CLIENT_WINDOW_RIGHTS = ['attach', 'write', 'resize'] as const;
export type CoreClientWindowRight = (typeof CORE_CLIENT_WINDOW_RIGHTS)[number];

/** A ticket's secret: 32 random bytes, base64url without padding. */
const TICKET_SECRET = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * `client.windowTicket` in `core.runtime.initialize`: admits that connection
 * as the ticket's window. Single use.
 */
export const CoreClientWindowTicketSchema = z.strictObject({
  ticketId: ID,
  secret: TICKET_SECRET,
});
export type CoreClientWindowTicket = z.output<
  typeof CoreClientWindowTicketSchema
>;

export const CoreClientWindowIssueParamsSchema = z.strictObject({
  windowInstanceId: WINDOW_INSTANCE_ID,
  label: z.string().min(1).max(256),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});
export type CoreClientWindowIssueParams = z.output<
  typeof CoreClientWindowIssueParamsSchema
>;

export const CoreClientWindowIssueResultSchema = z.strictObject({
  ticketId: ID,
  secret: TICKET_SECRET,
  expiresAt: z.iso.datetime({ offset: true }),
});
export type CoreClientWindowIssueResult = z.output<
  typeof CoreClientWindowIssueResultSchema
>;

export const CoreClientWindowGrantParamsSchema = z.strictObject({
  windowInstanceId: WINDOW_INSTANCE_ID,
  terminalId: ID,
  rights: z.array(z.enum(CORE_CLIENT_WINDOW_RIGHTS)).min(1).max(3),
});
export type CoreClientWindowGrantParams = z.output<
  typeof CoreClientWindowGrantParamsSchema
>;

export const CoreClientWindowGrantResultSchema = z.strictObject({
  grantId: ID,
});

export const CoreClientWindowRevokeParamsSchema = z.strictObject({
  windowInstanceId: WINDOW_INSTANCE_ID,
  terminalId: ID.optional(),
});
export type CoreClientWindowRevokeParams = z.output<
  typeof CoreClientWindowRevokeParamsSchema
>;

export const CoreClientWindowRevokeResultSchema = z.strictObject({
  revoked: z.boolean(),
});

/** No codes of their own: refusals are typed by kind. */
export const CoreClientWindowIssueErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.never().optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  },
);
export const CoreClientWindowErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.never().optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

/**
 * Window admission on the daemon (CAN-8039): Electron main's ordinary
 * connection issues a single-use ticket that admits one renderer window's
 * connection as `desktop-window:<windowInstanceId>`, and grants that window
 * rights on specific terminals. Every operation is bound to the issuing
 * client lease. Host-only: excluded from the renderer relay.
 */
export const CORE_CLIENT_WINDOW_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.client.window.issue': defineCanopyInstruction({
      plane: 'core',
      domain: 'client',
      version: 1,
      placement: 'core-only',
      requiredGrants: [CORE_CLIENT_WINDOW_GRANTS.issue],
      idempotency: 'keyed',
      params: CoreClientWindowIssueParamsSchema,
      result: CoreClientWindowIssueResultSchema,
      error: CoreClientWindowIssueErrorSchema,
    }),
    'core.client.window.grant': defineCanopyInstruction({
      plane: 'core',
      domain: 'client',
      version: 1,
      placement: 'core-only',
      requiredGrants: [CORE_CLIENT_WINDOW_GRANTS.issue],
      idempotency: 'inherent',
      params: CoreClientWindowGrantParamsSchema,
      result: CoreClientWindowGrantResultSchema,
      error: CoreClientWindowErrorSchema,
    }),
    'core.client.window.revoke': defineCanopyInstruction({
      plane: 'core',
      domain: 'client',
      version: 1,
      placement: 'core-only',
      requiredGrants: [CORE_CLIENT_WINDOW_GRANTS.issue],
      idempotency: 'inherent',
      params: CoreClientWindowRevokeParamsSchema,
      result: CoreClientWindowRevokeResultSchema,
      error: CoreClientWindowErrorSchema,
    }),
  });
