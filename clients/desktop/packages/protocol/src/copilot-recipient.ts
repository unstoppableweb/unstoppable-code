import { z } from 'zod';

// Private local pilot binding, not a core operation or a serialized SDK handle.
export const COPILOT_RECIPIENT_LIMITS = Object.freeze({
  frameBytes: 262_144,
  outputBytes: 4_194_304,
  events: 1024,
  callbacks: 16,
  handles: 32,
  lifetimeMs: 120_000,
  callbackMs: 30_000,
});
const id = z.string().min(1).max(256);
const text = z.string().max(65_536);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const COPILOT_RECIPIENT_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const CopilotRecipientPurposeSchema = z.enum([
  'turn',
  'models',
  'quota',
  'setup-probe',
]);
export type CopilotRecipientPurpose = z.infer<
  typeof CopilotRecipientPurposeSchema
>;
export const CopilotRecipientAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), operationId: id }).strict(),
  z
    .object({ kind: z.literal('resume'), operationId: id, sessionId: id })
    .strict(),
]);
export type CopilotRecipientAudience = z.infer<
  typeof CopilotRecipientAudienceSchema
>;
export const CopilotRecipientTurnSchema = z
  .object({
    prompt: text,
    model: id,
    reasoningEffort: z.enum(COPILOT_RECIPIENT_REASONING_EFFORTS).optional(),
    recoverMissingSession: z.boolean(),
    observeTools: z.boolean().optional(),
  })
  .strict();
export type CopilotRecipientTurn = z.infer<typeof CopilotRecipientTurnSchema>;
const observationEnvelope = {
  id,
  parentId: id.nullable(),
  timestamp: id,
  ephemeral: z.boolean().optional(),
  agentId: id.optional(),
};
export const CopilotToolObservationSchema = z.discriminatedUnion('type', [
  z.object({
    ...observationEnvelope,
    type: z.literal('tool.execution_start'),
    data: z.object({
      toolCallId: id,
      toolName: id,
      arguments: z.json().optional(),
      mcpConfigServerName: id.optional(),
      mcpServerName: id.optional(),
      mcpToolName: id.optional(),
    }),
  }),
  z.object({
    ...observationEnvelope,
    type: z.literal('tool.execution_complete'),
    data: z.object({
      toolCallId: id,
      success: z.boolean(),
      parentToolCallId: id.optional(),
      result: z
        .object({
          content: text,
          detailedContent: text.optional(),
          contents: z
            .array(z.object({ type: z.literal('text'), text }))
            .max(256)
            .optional(),
        })
        .optional(),
    }),
  }),
]);
export const CopilotToolReplyResultSchema = z.object({
  textResultForLlm: text,
  resultType: z.enum(['success', 'failure', 'rejected', 'denied', 'timeout']),
  error: text.optional(),
  sessionLog: text.optional(),
  binaryResultsForLlm: z
    .array(
      z.object({
        data: text,
        mimeType: id,
        type: z.enum(['image', 'resource']),
        description: text.optional(),
      }),
    )
    .max(16)
    .optional(),
  toolTelemetry: z
    .record(z.string(), z.record(z.string(), z.json()).optional())
    .optional(),
  toolReferences: z.array(id).max(256).optional(),
});
export const CopilotCallbackRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('observation'),
      event: CopilotToolObservationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('approval'),
      toolCallId: id,
      toolName: id,
      argumentsJson: text,
    })
    .strict(),
  z.object({ kind: z.literal('permission'), requestJson: text }).strict(),
  z
    .object({
      kind: z.literal('tool'),
      toolCallId: id,
      toolName: id,
      argumentsJson: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal('input'),
      question: text,
      choices: z.array(id).max(64),
      allowFreeform: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('history'), sessionId: id }).strict(),
  z
    .object({
      kind: z.literal('notice'),
      name: z.enum([
        'session',
        'prompt-accepted',
        'before-prompt',
        'session-unavailable',
        'tools-ready',
      ]),
      sessionId: id.optional(),
      digest: id.optional(),
      servers: z
        .array(z.object({ name: id, status: id }).strict())
        .max(256)
        .optional(),
    })
    .strict(),
]);
export type CopilotCallbackRequest = z.infer<
  typeof CopilotCallbackRequestSchema
>;
export const CopilotCallbackReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('observation'), accepted: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('approval'),
      allow: z.boolean(),
      message: text.optional(),
      modifiedArgumentsJson: text.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('permission'), allow: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal('tool'),
      result: text,
      structured: CopilotToolReplyResultSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('input'),
      answer: text,
      wasFreeform: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('history'), prompt: text }).strict(),
  z.object({ kind: z.literal('notice'), accepted: z.boolean() }).strict(),
]);
export type CopilotCallbackReply = z.infer<typeof CopilotCallbackReplySchema>;
const envelope = {
  version: z.literal(1),
  handle: id,
  generation: count,
  audience: CopilotRecipientAudienceSchema,
  purpose: CopilotRecipientPurposeSchema,
};
export const CopilotRecipientCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...envelope,
      kind: z.literal('run'),
      turn: CopilotRecipientTurnSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal('reply'),
      correlationId: id,
      reply: CopilotCallbackReplySchema,
    })
    .strict(),
  z.object({ ...envelope, kind: z.literal('renew') }).strict(),
  z.object({ ...envelope, kind: z.literal('cancel') }).strict(),
  z.object({ ...envelope, kind: z.literal('close') }).strict(),
]);
export type CopilotRecipientCommand = z.infer<
  typeof CopilotRecipientCommandSchema
>;
const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text }).strict(),
  z.object({ type: z.literal('thinking'), text }).strict(),
  z
    .object({
      type: z.literal('tool_use'),
      toolUseId: id,
      toolName: id,
      input: text,
      display: z.object({ toolName: id, input: text }).strict().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_result'),
      toolUseId: id,
      toolName: id,
      output: text,
      isError: z.boolean(),
    })
    .strict(),
]);
export const CopilotAssistantPatchSchema = z
  .object({
    type: z.literal('canopy_assistant_patch'),
    provider: z.literal('copilot'),
    messageId: id,
    timestamp: z.number().finite(),
    revision: count,
    patches: z
      .array(
        z.union([
          z.object({ index: count, block }).strict(),
          z.object({ index: count, appendText: text }).strict(),
        ]),
      )
      .max(256),
  })
  .strict();
export const CopilotProjectedEventSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('patch'), patch: CopilotAssistantPatchSchema })
    .strict(),
  z.object({ kind: z.literal('text'), text }).strict(),
  z.object({ kind: z.literal('thinking'), text }).strict(),
  z
    .object({
      kind: z.literal('tool'),
      toolCallId: id,
      toolName: id,
      output: text,
    })
    .strict(),
]);
export type CopilotProjectedEvent = z.infer<typeof CopilotProjectedEventSchema>;
export const CopilotRecipientResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('turn'),
      sessionId: id,
      text,
      usage: z
        .object({
          input_tokens: count,
          output_tokens: count,
          cache_read_input_tokens: count,
          cache_creation_input_tokens: count,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('models'),
      models: z
        .array(
          z
            .object({
              id,
              name: id,
              supportsVision: z.boolean(),
              reasoningEfforts: z
                .array(z.enum(['none', ...COPILOT_RECIPIENT_REASONING_EFFORTS]))
                .max(COPILOT_RECIPIENT_REASONING_EFFORTS.length + 1),
              contextWindow: count.optional(),
            })
            .strict(),
        )
        .max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal('quota'),
      snapshots: z
        .array(
          z
            .object({
              id,
              remainingPercentage: z.number().min(0).max(100).optional(),
              unlimited: z.boolean(),
              resetsAt: id.optional(),
            })
            .strict(),
        )
        .max(16),
    })
    .strict(),
  z
    .object({ kind: z.literal('setup-probe'), available: z.literal(true) })
    .strict(),
]);
export type CopilotRecipientResult = z.infer<
  typeof CopilotRecipientResultSchema
>;
export const CopilotRecipientRefusalSchema = z.enum([
  'unavailable',
  'unsupported',
  'stale',
  'expired',
  'purpose',
  'audience',
  'identity',
  'channel',
  'limit',
  'invalid',
  'cancelled',
  // Closed failure causes (CAN-7117); the failure's message never crosses.
  'provider_error',
  'auth',
  'start_timeout',
  'exited_during_startup',
  'version_mismatch',
  'not_installed',
  'refresh_failed',
]);
export type CopilotRecipientRefusal = z.infer<
  typeof CopilotRecipientRefusalSchema
>;
/** The SDK `session.error` categories we act on; any other reads as `other`. */
export const CopilotSdkErrorTypeSchema = z.enum([
  'authentication',
  'authorization',
  'quota',
  'rate_limit',
  'context_limit',
  'query',
  'other',
]);
export type CopilotSdkErrorType = z.infer<typeof CopilotSdkErrorTypeSchema>;
export const CopilotRecipientOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('refused'),
      reason: CopilotRecipientRefusalSchema,
      /** Only with `provider_error`. */
      errorType: CopilotSdkErrorTypeSchema.optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('opened'), handle: id, generation: count })
    .strict(),
  z.object({ kind: z.literal('accepted') }).strict(),
  z
    .object({
      kind: z.literal('completed'),
      result: CopilotRecipientResultSchema,
    })
    .strict(),
]);
export type CopilotRecipientOutcome = z.infer<
  typeof CopilotRecipientOutcomeSchema
>;
const messageEnvelope = {
  version: z.literal(1),
  handle: id,
  generation: count,
  sequence: count,
};
export const CopilotRecipientMessageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...messageEnvelope,
      kind: z.literal('callback'),
      correlationId: id,
      request: CopilotCallbackRequestSchema,
    })
    .strict(),
  z
    .object({
      ...messageEnvelope,
      kind: z.literal('event'),
      event: CopilotProjectedEventSchema,
    })
    .strict(),
]);
export type CopilotRecipientMessage = z.infer<
  typeof CopilotRecipientMessageSchema
>;
export const CopilotLocalRequestSchema = z
  .object({
    requestId: count,
    command: CopilotRecipientCommandSchema,
  })
  .strict();
export const CopilotLocalFrameSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('message'),
      message: CopilotRecipientMessageSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('response'),
      requestId: count,
      outcome: CopilotRecipientOutcomeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('failure'),
      reason: z.enum(['invalid', 'limit', 'channel']),
    })
    .strict(),
]);
export type CopilotLocalFrame = z.infer<typeof CopilotLocalFrameSchema>;
