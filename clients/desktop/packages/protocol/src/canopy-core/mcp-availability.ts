import { z } from 'zod';

const id = z.string().min(1).max(1024);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const mcpActivationProviderSchema = z.enum([
  'claude',
  'codex',
  'ollama',
  'cursor',
  'copilot',
  'antigravity',
  'opencode',
]);
export type McpActivationProvider = z.infer<typeof mcpActivationProviderSchema>;

/** Capability identity is descriptive, never an authorization grant. */
export const mcpCapabilityIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('standalone'), serverId: id, configId: id }),
  z.strictObject({
    kind: z.literal('plugin'),
    marketplaceId: id,
    pluginName: id,
    serverName: id,
  }),
  z.strictObject({
    kind: z.literal('account'),
    connectionId: id,
    configId: id,
  }),
]);

export type McpCapabilityIdentity = z.infer<typeof mcpCapabilityIdentitySchema>;

export function mcpCapabilityIdentityKey(
  identity: McpCapabilityIdentity,
): string {
  switch (identity.kind) {
    case 'standalone':
      return JSON.stringify([
        identity.kind,
        identity.serverId,
        identity.configId,
      ]);
    case 'plugin':
      return JSON.stringify([
        identity.kind,
        identity.marketplaceId,
        identity.pluginName,
        identity.serverName,
      ]);
    case 'account':
      return JSON.stringify([
        identity.kind,
        identity.connectionId,
        identity.configId,
      ]);
  }
}

export const mcpAvailabilityReasonSchema = z.enum([
  'unchecked',
  'startup_failed',
  'timeout',
  'permission_denied',
  'unsupported_execution',
  'removed',
  'no_tools',
  'disconnected',
]);
export type McpAvailabilityReason = z.infer<typeof mcpAvailabilityReasonSchema>;

export const mcpSessionStatusSchema = z
  .strictObject({
    identity: mcpCapabilityIdentitySchema,
    sessionId: id,
    generation,
    selected: z.boolean(),
    enabled: z.boolean(),
    permitted: z.boolean(),
    authRequirement: z.enum([
      'unknown',
      'none',
      'required',
      'provider_managed',
    ]),
    availability: z.enum([
      'not_selected',
      'disabled',
      'connecting',
      'ready',
      'auth_required',
      'unavailable',
    ]),
    toolCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    reasonCode: mcpAvailabilityReasonSchema.optional(),
    /** Only an owning provider session may supply this evidence. */
    evidence: z
      .strictObject({
        initialized: z.literal(true),
        toolsDiscovered: z.literal(true),
      })
      .optional(),
  })
  .superRefine((status, context) => {
    let valid: boolean;
    if (!status.selected) valid = status.availability === 'not_selected';
    else if (!status.enabled) valid = status.availability === 'disabled';
    else if (!status.permitted)
      valid =
        status.availability === 'unavailable' &&
        status.reasonCode === 'permission_denied';
    else valid = !['not_selected', 'disabled'].includes(status.availability);
    if (status.availability === 'ready') {
      valid &&=
        status.evidence !== undefined &&
        (status.toolCount ?? 0) > 0 &&
        status.reasonCode === undefined;
    }
    if (status.availability === 'unavailable')
      valid &&= status.reasonCode !== undefined;
    if (status.availability === 'auth_required')
      valid &&=
        status.authRequirement === 'required' ||
        status.authRequirement === 'provider_managed';
    if (status.reasonCode === 'no_tools')
      valid &&= status.availability === 'unavailable' && status.toolCount === 0;
    if (!valid)
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent MCP session status',
      });
  });
export type McpSessionStatus = z.infer<typeof mcpSessionStatusSchema>;

export const mcpActivationScopeSchema = z.strictObject({
  projectId: id,
  worktreeId: id,
  chatId: id,
});
export type McpActivationScope = z.infer<typeof mcpActivationScopeSchema>;

export const mcpActivationPhaseSchema = z.enum([
  'result_pending',
  'preparing',
  'connecting',
  'awaiting_auth',
  'resuming',
  'completed',
  'failed',
  'cancelled',
]);
export type McpActivationPhase = z.infer<typeof mcpActivationPhaseSchema>;

export const mcpActivationFailureSchema = z.enum([
  'result_delivery_failed',
  'startup_failed',
  'timeout',
  'permission_denied',
  'unsupported_execution',
  'removed',
  'no_tools',
  'stale_task',
  'resume_failed',
  'admission_uncertain',
]);
export type McpActivationFailure = z.infer<typeof mcpActivationFailureSchema>;

const mcpActivationLoadReceiptSchema = z.strictObject({
  activationId: id,
  originatingMessageId: id,
  provider: mcpActivationProviderSchema,
  toolCallId: id,
  sessionId: id,
  attemptId: id,
  generation,
  desiredGeneration: generation.optional(),
  targetKey: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Recovery facts only. Never persist credentials or live readiness here. */
export const mcpActivationRecordSchema = z
  .strictObject({
    version: z.literal(1),
    ownerId: id,
    activationId: id,
    attemptId: id,
    originatingMessageId: id,
    providerSessionId: id,
    provider: mcpActivationProviderSchema,
    loadRequest: mcpActivationLoadReceiptSchema.optional(),
    retainedLoads: z.array(mcpActivationLoadReceiptSchema).max(16).optional(),
    trigger: z.enum(['load', 'selection', 'auth', 'retry']),
    requiredTargets: z.array(mcpCapabilityIdentitySchema).min(1).max(100),
    desiredGeneration: generation,
    phase: mcpActivationPhaseSchema,
    failureCode: mcpActivationFailureSchema.optional(),
    retryEligible: z.boolean(),
    cancelled: z.boolean(),
    admission: z.enum(['not_sent', 'uncertain', 'accepted']),
    /** Host-owned digest of the intended canonical execution settings and selections. */
    continuationContextHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    attemptNumber: z.number().int().min(1).max(3).optional(),
    retryReceipts: z
      .array(
        z.strictObject({
          idempotencyKey: z.string().min(1).max(128),
          attemptId: id,
          generation,
        }),
      )
      .max(2)
      .optional(),
  })
  .superRefine((record, context) => {
    const keys = record.requiredTargets.map(mcpCapabilityIdentityKey);
    if (
      new Set(keys).size !== keys.length ||
      (record.phase === 'completed' && record.admission !== 'accepted') ||
      (record.phase === 'cancelled') !== record.cancelled ||
      (record.phase === 'failed' && record.failureCode === undefined) ||
      (record.retryEligible &&
        (record.phase !== 'failed' ||
          record.admission !== 'not_sent' ||
          record.cancelled))
    )
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent MCP activation recovery record',
      });
  });
export type McpActivationRecord = z.infer<typeof mcpActivationRecordSchema>;

export const mcpRetryActivationRequestSchema = z.strictObject({
  scope: mcpActivationScopeSchema,
  activationId: id,
  expectedGeneration: generation,
  idempotencyKey: z.string().min(1).max(128),
});
export type McpRetryActivationRequest = z.infer<
  typeof mcpRetryActivationRequestSchema
>;

/** Sign-in uses the host's exact required target, never a caller-supplied URL or config. */
export const mcpActivationAuthRequestSchema = mcpRetryActivationRequestSchema
  .omit({ idempotencyKey: true })
  .extend({ action: z.enum(['start', 'cancel']) });
export type McpActivationAuthRequest = z.infer<
  typeof mcpActivationAuthRequestSchema
>;
export const mcpActivationAuthResultSchema = z.strictObject({
  status: z.enum(['started', 'completed', 'cancelled']),
});
export type McpActivationAuthResult = z.infer<
  typeof mcpActivationAuthResultSchema
>;

/** Transient tools and durable recovery are scoped to exactly one chat. */
export const mcpActivationStatusSchema = z.strictObject({
  scope: mcpActivationScopeSchema,
  statuses: z.array(mcpSessionStatusSchema).max(1000),
  activation: mcpActivationRecordSchema.optional(),
  recoverySupported: z.boolean(),
  signInSupported: z.boolean().optional(),
});
export type McpActivationStatus = z.infer<typeof mcpActivationStatusSchema>;

export const mcpActivationReceiptSchema = z.strictObject({
  activationId: id,
  attemptId: id,
  generation,
});
export type McpActivationReceipt = z.infer<typeof mcpActivationReceiptSchema>;

export const MCP_ACTIVATION_CONTINUATION =
  '<system_instruction>The requested tools are available. Continue the interrupted request without repeating completed work.</system_instruction>';

/** Invalid or future recovery metadata must not make an old chat unreadable. */
export function readMcpActivationRecord(
  value: unknown,
): McpActivationRecord | undefined {
  if (value === undefined || value === null) return undefined;
  const result = mcpActivationRecordSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
