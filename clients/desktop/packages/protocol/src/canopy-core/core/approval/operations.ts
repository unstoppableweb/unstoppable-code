import { z } from 'zod';

import type { ApprovalRequestDetails } from '../../approval-prompt';
import {
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../../common';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../../definitions';

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
const revision = z.number().int().min(0);

export const CORE_APPROVAL_REQUEST_STATES = [
  'pending',
  'allowed',
  'denied',
  'cancelled',
  'expired',
] as const;

export const CoreApprovalTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('command'),
    executable: z.string().min(1).max(4096),
    args: z.array(z.string().max(16384)),
    cwdRootId: id,
    cwdRelativePath: z.string().max(4096),
  }),
  z.strictObject({
    kind: z.literal('filesystem'),
    action: z.enum(['read', 'write', 'delete', 'move']),
    rootId: id,
    relativePath: z.string().max(4096),
  }),
  z.strictObject({
    kind: z.literal('network'),
    protocol: z.enum(['http', 'https', 'tcp']),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
  }),
  z.strictObject({
    kind: z.literal('mcp'),
    serverId: id,
    toolName: z.string().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal('tool'),
    toolName: z.string().min(1).max(256),
    providerId: id.nullable(),
  }),
]);

export const CoreApprovalRuleSchema = z.strictObject({
  ruleId: id,
  effect: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session', 'project', 'global']),
  target: CoreApprovalTargetSchema,
  sessionId: id.nullable(),
  workspaceId: id.nullable(),
  maxUses: z.number().int().min(1).nullable(),
  expiresAt: timestamp.nullable(),
  source: z.enum(['user', 'organization_policy', 'canopy_json']),
  createdAt: timestamp,
  revision,
});

export const CoreApprovalRequestSchema = z.strictObject({
  requestId: id,
  sessionId: id,
  chatId: id.nullable(),
  turnId: id.nullable(),
  target: CoreApprovalTargetSchema,
  explanation: z.string().max(4096),
  policyRevision: revision,
  state: z.enum(CORE_APPROVAL_REQUEST_STATES),
  requestedAt: timestamp,
  expiresAt: timestamp,
  subagentId: id.nullable(),
  suggestedRule: CoreApprovalRuleSchema.nullable(),
});
export type CoreApprovalRequest = z.output<typeof CoreApprovalRequestSchema>;

/**
 * The minor schema revision of `core.approval.request.list` (protocol rule
 * 5): each request's `presentation` and the result's `viewer` (CAN-6092).
 */
export const CORE_APPROVAL_REQUEST_LIST_SCHEMA_REVISION = 2;

// Display text as the cloud's own approval card carries it.
const text = z.string().max(8 * 1024 * 1024);
const reason = { reason: text.optional() };
const fileChange = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('edit'),
    oldText: text,
    newText: text,
    replaceAll: z.boolean().optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('write'),
    content: text,
    truncated: z.boolean().optional(),
  }),
]);
const origins = { origin: text, topOrigin: text.optional() };

/** What the person deciding sees of the tool call, as a desktop prompt shows it. */
export const CoreApprovalRequestDetailsSchema: z.ZodType<ApprovalRequestDetails> =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('command'),
      command: text,
      cwd: text.optional(),
      ...reason,
    }),
    z.object({
      kind: z.literal('file-write'),
      path: text.optional(),
      displayPath: text.optional(),
      change: fileChange.optional(),
      itemId: text.optional(),
      ...reason,
    }),
    z.object({
      kind: z.literal('mcp'),
      server: text,
      tool: text,
      paramsDisplay: text.optional(),
      ...reason,
    }),
    z.object({ kind: z.literal('network'), host: text, ...reason }),
    z.object({
      kind: z.literal('tool'),
      toolName: text,
      path: text.optional(),
      displayPath: text.optional(),
      inputSummary: text.optional(),
      ...reason,
    }),
    z.object({
      kind: z.literal('browser-upload'),
      ...origins,
      files: z.array(
        z.object({ displayPath: text, sizeBytes: z.number().int().min(0) }),
      ),
      ...reason,
    }),
    z.object({
      kind: z.literal('browser-file-request'),
      ...origins,
      purpose: text.optional(),
      multiple: z.boolean(),
    }),
  ]);

/** A listed request; `presentation` only for a revision 2 caller. */
export const CoreApprovalListedRequestSchema = CoreApprovalRequestSchema.extend(
  {
    presentation: z
      .strictObject({
        toolCallId: id.nullable(),
        details: CoreApprovalRequestDetailsSchema,
        /** Whether a denial's reason and stop reach the agent. */
        explainable: z.boolean(),
      })
      .optional(),
  },
);
export type CoreApprovalListedRequest = z.output<
  typeof CoreApprovalListedRequestSchema
>;

export const CoreApprovalRequestListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  states: z.array(z.enum(CORE_APPROVAL_REQUEST_STATES)),
  cursor: id.nullable(),
  limit: z.number().int().min(1).max(500),
  revision: z.literal(CORE_APPROVAL_REQUEST_LIST_SCHEMA_REVISION).optional(),
});

export const CoreApprovalRequestListResultSchema = z.strictObject({
  requests: z.array(CoreApprovalListedRequestSchema),
  nextCursor: id.nullable(),
  /** What the caller may answer in the chat; only for a revision 2 caller. */
  viewer: z
    .strictObject({
      canAnswerQuestions: z.boolean(),
      canApprove: z.boolean(),
    })
    .optional(),
});

export const CoreApprovalRequestRespondParamsSchema = z.strictObject({
  requestId: id,
  policyRevision: revision,
  decision: z.enum(['allow', 'deny']),
  stopTurn: z.boolean(),
  message: z.string().max(4096).nullable(),
  createRule: z.literal('suggested').nullable(),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: id }),
});

export const CoreApprovalRequestEventsParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  cursor: CanopyStreamCursorSchema.nullable(),
});

export const CoreApprovalRequestEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});

export const CoreApprovalRequestEventsItemSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('request'),
      request: CoreApprovalRequestSchema,
      occurredAt: timestamp,
    }),
    z.strictObject({
      kind: z.enum(['resolved', 'cancelled', 'expired']),
      requestId: id,
      state: z.enum(['allowed', 'denied', 'cancelled', 'expired']),
      occurredAt: timestamp,
    }),
    z.strictObject({
      kind: z.literal('policy_invalidated'),
      previousRevision: revision,
      revision,
      occurredAt: timestamp,
    }),
  ],
);
export type CoreApprovalRequestEventsItem = z.output<
  typeof CoreApprovalRequestEventsItemSchema
>;

// The approval pages define no operation codes.
const ErrorSchema = CanopyErrorPayloadSchema.omit({ code: true });

const StreamError = ErrorSchema.extend({
  retry: CanopyQueryRetryDirectiveSchema,
});

// Served by the web core only (CAN-4162). Kept out of the composed registries
// because the daemon dispatcher requires a handler for every definition it is
// given and has none for approvals yet.
export const CORE_APPROVAL_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.approval.request.list': defineCanopyQuery({
      plane: 'core',
      domain: 'approval',
      version: 1,
      placement: 'core-only',
      params: CoreApprovalRequestListParamsSchema,
      result: CoreApprovalRequestListResultSchema,
      error: ErrorSchema.extend({ retry: CanopyQueryRetryDirectiveSchema }),
      idempotency: 'inherent',
      requiredGrants: ['core.approval.read'],
    }),
  },
);

export const CORE_APPROVAL_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.approval.request.respond': defineCanopyInstruction({
      plane: 'core',
      domain: 'approval',
      version: 1,
      placement: 'core-only',
      params: CoreApprovalRequestRespondParamsSchema,
      result: CoreApprovalRequestSchema,
      error: ErrorSchema.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
      idempotency: 'keyed',
      requiredGrants: ['core.approval.respond'],
    }),
  });

export const CORE_APPROVAL_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'core',
  {
    'core.approval.request.events': defineCanopyStream({
      plane: 'core',
      domain: 'approval',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.approval.read'],
      params: CoreApprovalRequestEventsParamsSchema,
      item: CoreApprovalRequestEventsItemSchema,
      end: CanopyStreamEndSchema.extend({ error: StreamError.nullable() }),
      openResult: CoreApprovalRequestEventsOpenResultSchema,
      error: StreamError,
    }),
  },
);
