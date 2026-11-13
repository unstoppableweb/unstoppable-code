import { z } from 'zod';

import {
  CanopyWorkspaceScopeSchema,
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../shared';

const ordinal = z.number().int().nonnegative();
const safeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const anchorId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const scope = CanopyWorkspaceScopeSchema.safeExtend({
  workspaceId: safeId,
  worktreeId: safeId,
  chatId: safeId,
});
const HOST_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\|file:\/\/)/;

/** A verified tool-output artifact that holds a body too large to inline. */
export const PersistedToolOutputReferenceSchema = z.strictObject({
  version: z.literal(1),
  artifactId: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** UTF-16LE preserves rare unpaired code units that UTF-8 would replace. */
  encoding: z.enum(['utf-8', 'utf-16le']),
  mediaType: z.literal('text/plain'),
});

export type PersistedToolOutputReference = z.infer<
  typeof PersistedToolOutputReferenceSchema
>;

// Storage identities are portable. Hosts validate chat IDs again before using
// them as path components; delegation IDs never become path components.
const streamIdentity = z.string().min(1).max(256);
const streamDigest = z.string().regex(/^[a-f0-9]{64}$/);
const streamRevision = z.number().int().nonnegative().safe();
const preview = z.string().max(8192);

const delegationTargetSchema = z.strictObject({
  kind: z.literal('delegation'),
  chatId: streamIdentity,
  delegationId: streamIdentity,
  runGeneration: streamRevision,
});
export const TranscriptTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('primary'), chatId: streamIdentity }),
  delegationTargetSchema,
]);
export type TranscriptTarget = z.infer<typeof TranscriptTargetSchema>;
export const TranscriptDelegationTargetSchema = delegationTargetSchema;

export const TranscriptStreamRegistrationSchema = z.strictObject({
  type: z.literal('stream'),
  version: z.literal(1),
  target: delegationTargetSchema,
  streamKey: streamDigest,
  registeredAtRevision: streamRevision,
  openedAt: z.number().finite().optional(),
});
export type TranscriptStreamRegistration = z.infer<
  typeof TranscriptStreamRegistrationSchema
>;

export const TranscriptStreamRegistryHeaderSchema = z.strictObject({
  type: z.literal('stream-registry'),
  version: z.literal(1),
  parentChatId: streamIdentity,
  checkpointRevision: streamRevision,
  entryCount: streamRevision,
  entriesSha256: streamDigest,
});
export type TranscriptStreamRegistryHeader = z.infer<
  typeof TranscriptStreamRegistryHeaderSchema
>;

/** Mutable, portable projection of a stream-backed delegation card. */
export const CardStateV1Schema = z.strictObject({
  version: z.literal(1),
  status: z.enum([
    'pending',
    'running',
    'interrupted',
    'completed',
    'failed',
    'cancelled',
    'deadline_exceeded',
  ]),
  resultIndex: streamRevision.nullable(),
  error: preview.nullable(),
  usage: z
    .strictObject({ inputTokens: streamRevision, outputTokens: streamRevision })
    .nullable(),
  workspaceRevision: streamRevision.nullable(),
  workspaceDiscarded: z.boolean(),
  stopOutcome: preview.nullable(),
  controlOutcome: preview.nullable(),
  attribution: preview.nullable(),
  capabilitySummary: preview.nullable(),
  nestedChildSummary: preview.nullable(),
  partialPreview: preview.nullable(),
  finalPreview: preview.nullable(),
});
export type CardStateV1 = z.infer<typeof CardStateV1Schema>;

/** Encoded JSON bytes, including value quotes/brackets; prompt is separate. */
export const STREAM_CARD_CAPS = Object.freeze({
  aggregate: 128 * 1024,
  draft: 60_000,
  canonical: 64_000,
  id: 1_024,
  label: 1_024,
  message: 4_096,
  route: 12_000,
  control: 18_000,
  applyFailure: 14_000,
  capabilities: 18_000,
  childDelegationIds: 6_000,
  stoppedBy: 2_048,
  reference: 2_048,
  previewCodeUnits: 8_192,
  previewBytes: 49_154,
  promptCodeUnits: 32_768,
  promptBytes: 196_610,
});

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedString(bytes: number): z.ZodString {
  return z.string().refine((value) => encodedBytes(value) <= bytes, {
    message: `Encoded JSON string exceeds ${String(bytes)} bytes`,
  });
}

const cardId = boundedString(STREAM_CARD_CAPS.id);
const cardLabel = boundedString(STREAM_CARD_CAPS.label);
const cardMessage = boundedString(STREAM_CARD_CAPS.message);
const cardNumber = z.number().finite().nonnegative();
// Portable wire literals; core contracts cannot import host-facing subpaths.
const THINKING_LEVELS = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
const DELEGATION_APPLY_FAILURE_REASONS = [
  'conflict',
  'approval_denied',
  'write_failed',
  'cancelled',
  'interrupted',
  'unavailable',
] as const;
const DELEGATION_APPLY_ISSUE_REASONS = [
  'parent_changed',
  'too_large',
  'not_text',
  'not_regular_file',
  'protected_path',
  'outside_write_grant',
  'unreconciled',
  'approval_denied',
  'write_failed',
  'not_restored',
] as const;
const DELEGATION_CAPABILITY_KINDS = ['skill', 'plugin', 'mcp'] as const;
const DELEGATION_CAPABILITY_SOURCES = [
  'agent',
  'inherited',
  'explicit',
  'loaded',
] as const;
const DELEGATION_CAPABILITY_SKIP_REASONS = [
  'missing_selection',
  'unsupported_capability',
  'unsupported_hooks',
  'unsupported_lsp',
  'unsupported_skill_execution',
  'unavailable_asset',
] as const;
const DELEGATION_NESTING_STATES = [
  'enabled',
  'not_enabled',
  'depth_limit',
] as const;
const DELEGATION_STOP_REASONS = [
  'parent_cancelled',
  'user_cancelled',
  'deadline_exceeded',
  'shutdown',
  'policy_revoked',
  'stopped_by_parent',
  'ancestor_stopped',
] as const;
const cardApplyFailure = z
  .strictObject({
    reason: z.enum(DELEGATION_APPLY_FAILURE_REASONS),
    issues: z
      .array(
        z.strictObject({
          path: cardId,
          reason: z.enum(DELEGATION_APPLY_ISSUE_REASONS),
          parentDiff: cardMessage.optional(),
          parentDiffTruncated: z.boolean().optional(),
        }),
      )
      .max(64),
    omittedIssues: streamRevision.optional(),
    guidance: cardMessage,
  })
  .refine((value) => encodedBytes(value) <= STREAM_CARD_CAPS.applyFailure);
const cardRoute = z
  .strictObject({
    selectedModelId: cardId,
    selectedModelLabel: cardLabel.optional(),
    runtimeModelLabel: cardLabel.optional(),
    runtimeModelId: cardId,
    harnessId: cardId,
    runtimeKind: cardId,
    runnerRegistrationId: cardId,
    runtimeVersion: cardId,
    adapterVersion: cardId,
    modelSource: cardId,
    providerType: cardId,
    assignmentRevision: cardId,
    routeId: cardId.optional(),
    billingAuthority: cardId,
    aiCreditsRouted: z.boolean(),
    requestedThinkingLevel: z.enum(THINKING_LEVELS).optional(),
    effectiveThinkingLevel: z.enum(THINKING_LEVELS).optional(),
    capabilities: z.array(cardLabel).max(64),
    supportedThinkingLevels: z.array(z.enum(THINKING_LEVELS)).max(16),
    capabilitySnapshotHash: cardId,
    capabilityGeneration: streamRevision,
    policyRevision: cardId,
    agentOverlay: z
      .strictObject({
        agentDefinitionId: cardId,
        agentDefinitionRevision: cardId,
        agentDefinitionHash: cardId,
        pluginProjectionHash: cardId,
      })
      .optional(),
  })
  .refine((value) => encodedBytes(value) <= STREAM_CARD_CAPS.route);
const cardControl = z
  .strictObject({
    operationId: cardId,
    operation: z.enum([
      'follow_up',
      'resume',
      'steer',
      'interrupt',
      'apply',
      'discard',
    ]),
    status: z.enum(['completed', 'failed']),
    steeringDelivery: z
      .union([
        z.strictObject({
          kind: z.literal('accepted'),
          attemptId: cardId,
          providerTurnId: cardId.optional(),
        }),
        z.strictObject({
          kind: z.enum(['rejected', 'unknown']),
          attemptId: cardId,
          reason: cardMessage,
          fallback: z.literal('ordinary').optional(),
        }),
      ])
      .optional(),
    error: cardMessage.optional(),
    applyFailure: cardApplyFailure.optional(),
  })
  .refine((value) => encodedBytes(value) <= STREAM_CARD_CAPS.control);
const cardCapabilities = z
  .strictObject({
    inherit: z.boolean(),
    discovery: z.boolean(),
    items: z
      .array(
        z.strictObject({
          kind: z.enum(DELEGATION_CAPABILITY_KINDS),
          name: cardLabel,
          source: z.enum(DELEGATION_CAPABILITY_SOURCES),
        }),
      )
      .max(128),
    skipped: z
      .array(
        z.strictObject({
          kind: z.enum(DELEGATION_CAPABILITY_KINDS),
          name: cardLabel,
          reason: z.enum(DELEGATION_CAPABILITY_SKIP_REASONS),
        }),
      )
      .max(64),
    omittedItems: streamRevision.optional(),
    omittedSkipped: streamRevision.optional(),
  })
  .refine((value) => encodedBytes(value) <= STREAM_CARD_CAPS.capabilities);
const cardStoppedBy = z
  .union([
    z.strictObject({ kind: z.literal('user') }),
    z.strictObject({
      kind: z.literal('agent'),
      depth: streamRevision,
      delegationId: cardId.optional(),
      description: cardLabel.optional(),
    }),
  ])
  .refine((value) => encodedBytes(value) <= STREAM_CARD_CAPS.stoppedBy);

const cardDraftShape = {
  version: z.literal(2),
  status: z.enum(['pending', 'running']).optional(),
  prompt: z.string().max(STREAM_CARD_CAPS.promptCodeUnits).optional(),
  routeSnapshot: cardRoute.optional(),
  requestedModelId: cardId.optional(),
  nativeSessionId: cardId.optional(),
  nestedDelegation: z.enum(DELEGATION_NESTING_STATES).optional(),
  childDelegationIds: z
    .array(cardId)
    .max(64)
    .refine(
      (value) => encodedBytes(value) <= STREAM_CARD_CAPS.childDelegationIds,
    )
    .optional(),
  capabilities: cardCapabilities.optional(),
  isolatedWorkspace: z
    .strictObject({
      revision: cardId,
      dirtyParentChangesIncluded: z.literal(false),
    })
    .optional(),
  workspaceDiscarded: z.boolean().optional(),
  control: cardControl.optional(),
  cancelledByUser: z.boolean().optional(),
  stoppedBy: cardStoppedBy.optional(),
  outputTruncated: z.boolean().optional(),
  detailOmitted: z.boolean().optional(),
};

/** Prompt has its own 196,610-byte maximum and does not spend this budget. */
function draftBudget(value: { prompt?: string }): boolean {
  const { prompt: _prompt, ...bounded } = value;
  void _prompt;
  return encodedBytes(bounded) <= STREAM_CARD_CAPS.draft;
}

// Every draft names its status and truncation, so a later state never needs a
// value only an earlier merge saw.
export const CardStateDraftSchema = z
  .strictObject({
    ...cardDraftShape,
    status: z.enum(['pending', 'running']),
    outputTruncated: z.boolean(),
  })
  .refine(draftBudget);
export type CardStateDraft = z.infer<typeof CardStateDraftSchema>;

const cardPreview = z.string().max(STREAM_CARD_CAPS.previewCodeUnits);
const cardReference = PersistedToolOutputReferenceSchema.safeExtend({
  artifactId: cardId.min(1),
  byteLength: streamRevision,
}).refine((value) => encodedBytes(value) <= STREAM_CARD_CAPS.reference);
export const CardStateCanonicalSchema = z
  .strictObject({
    status: z.enum([
      'completed',
      'failed',
      'cancelled',
      'deadline_exceeded',
      'interrupted',
    ]),
    resultIndex: streamRevision,
    error: z
      .strictObject({
        code: z.enum([
          'invalid_request',
          'capability_unavailable',
          'route_unavailable',
          'auth_required',
          'interaction_required',
          'policy_blocked',
          'capacity_exceeded',
          'parent_unavailable',
          'launch_uncertain',
          'runtime_error',
          'apply_failed',
          'terminated_by_parent',
        ]),
        message: cardMessage,
        retryable: z.boolean(),
        apply: cardApplyFailure.optional(),
      })
      .refine((value) => encodedBytes(value) <= 8_192)
      .optional(),
    usage: z
      .strictObject({
        inputTokens: cardNumber.optional(),
        outputTokens: cardNumber.optional(),
        cachedInputTokens: cardNumber.optional(),
        cacheCreationInputTokens: cardNumber.optional(),
        costUsd: cardNumber.optional(),
      })
      .optional(),
    stopReason: z.enum(DELEGATION_STOP_REASONS).optional(),
    finalText: cardPreview.optional(),
    finalTextRef: cardReference.optional(),
    partialText: cardPreview.optional(),
    partialTextRef: cardReference.optional(),
    answerUnavailable: z.literal(true).optional(),
    detailOmitted: z.literal(true).optional(),
  })
  .refine((value) => {
    const final =
      value.finalText !== undefined || value.finalTextRef !== undefined;
    const partial =
      value.partialText !== undefined || value.partialTextRef !== undefined;
    return (
      !(final && partial) &&
      !(value.answerUnavailable && (final || partial)) &&
      (value.finalTextRef === undefined || value.finalText !== undefined) &&
      (value.partialTextRef === undefined || value.partialText !== undefined) &&
      encodedBytes(value) <= STREAM_CARD_CAPS.canonical
    );
  });
export type CardStateCanonical = z.infer<typeof CardStateCanonicalSchema>;

export const CardStateV2Schema = z
  .strictObject({
    ...cardDraftShape,
    cardRevision: streamRevision,
    canonical: CardStateCanonicalSchema.optional(),
  })
  .refine((value) => {
    const { cardRevision: _revision, canonical: _canonical, ...draft } = value;
    void _revision;
    void _canonical;
    return draftBudget(draft);
  })
  // A stored draft is whole: canonical-only, or draft with status and truncation.
  .refine((value) => {
    const {
      version: _version,
      cardRevision: _revision,
      canonical: _canonical,
      ...draft
    } = value;
    void _version;
    void _revision;
    void _canonical;
    return (
      Object.keys(draft).length === 0 ||
      (draft.status !== undefined && draft.outputTruncated !== undefined)
    );
  })
  .refine((value) => {
    const { prompt: _prompt, ...bounded } = value;
    void _prompt;
    return encodedBytes(bounded) <= STREAM_CARD_CAPS.aggregate;
  });
export type CardStateV2 = z.infer<typeof CardStateV2Schema>;
export const CardStateSchema = z.union([CardStateV1Schema, CardStateV2Schema]);
export type CardState = z.infer<typeof CardStateSchema>;

export const DelegationChildRowEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  row: z
    .object({
      id: z.string().min(1),
      role: z.enum(['user', 'assistant', 'system']),
      timestamp: z.number().finite(),
      parentBlockId: z.string().min(1),
      delegationSequence: streamRevision,
      blocks: z.array(z.unknown()),
      itemRevision: streamRevision,
      final: z.boolean(),
    })
    .passthrough(),
});
export type DelegationChildRowEnvelope = z.infer<
  typeof DelegationChildRowEnvelopeSchema
>;

export const TranscriptStreamDescriptorUpdateSchema = z.strictObject({
  version: z.literal(1),
  target: delegationTargetSchema,
  expectedStreamRevision: streamRevision,
  nextStreamRevision: streamRevision,
  cardState: CardStateSchema.nullable().optional(),
  status: z.enum(['open', 'settled']).optional(),
  latestRowTimestamp: z.number().finite().nullable().optional(),
  settleReceipt: z
    .strictObject({
      mutationId: streamIdentity,
      scopeRevision: streamRevision,
      streamRevision,
      committedRowCount: streamRevision,
      committedByteLength: streamRevision,
      committedSha256: streamDigest,
    })
    .optional(),
});
export type TranscriptStreamDescriptorUpdate = z.infer<
  typeof TranscriptStreamDescriptorUpdateSchema
>;

export const TranscriptStreamDescriptorSchema = z.strictObject({
  version: z.literal(1),
  target: delegationTargetSchema,
  streamKey: streamDigest,
  checkpointRevision: streamRevision,
  openedAt: z.number().finite().optional(),
  status: z.enum(['open', 'settled']),
  streamRevision,
  committedRowCount: streamRevision,
  latestRowTimestamp: z.number().finite().nullable(),
  committedByteLength: streamRevision,
  committedSha256: streamDigest,
  settleReceipt: z
    .strictObject({
      mutationId: streamIdentity,
      scopeRevision: streamRevision,
      streamRevision,
      committedRowCount: streamRevision,
      committedByteLength: streamRevision,
      committedSha256: streamDigest,
    })
    .nullable(),
  cardState: CardStateSchema.nullable(),
});
export type TranscriptStreamDescriptor = z.infer<
  typeof TranscriptStreamDescriptorSchema
>;

export const TranscriptStreamCatalogSchema = z.strictObject({
  version: z.literal(1),
  checkpointRevision: streamRevision,
  parents: z.record(
    z.string(),
    z.strictObject({
      entryCount: streamRevision,
      registrySha256: streamDigest,
      registryBytes: streamRevision,
    }),
  ),
});
export type TranscriptStreamCatalog = z.infer<
  typeof TranscriptStreamCatalogSchema
>;

export const CoreChatTranscriptMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant', 'system']),
    blocks: z.array(z.unknown()),
    timestamp: z.number(),
    /**
     * Child stream pages only: the row's blocks exceed the page byte budget,
     * so `blocks` is empty; read its logical blocks by block page.
     */
    blocksOmitted: z.strictObject({ blockCount: ordinal }).optional(),
  })
  .catchall(z.unknown())
  .refine(
    (message) =>
      message.blocksOmitted === undefined || message.blocks.length === 0,
    'A row with omitted blocks carries none.',
  );

function containsHostPath(value: unknown): boolean {
  if (typeof value === 'string') return false;
  if (Array.isArray(value)) return value.some(containsHostPath);
  if (typeof value === 'object' && value !== null) {
    if (
      'type' in value &&
      value.type === 'image' &&
      'path' in value &&
      typeof value.path === 'string' &&
      HOST_PATH.test(value.path)
    )
      return true;
    if (
      'type' in value &&
      value.type === 'compaction_info' &&
      'transcriptPath' in value &&
      typeof value.transcriptPath === 'string' &&
      HOST_PATH.test(value.transcriptPath)
    )
      return true;
    return Object.entries(value).some(
      ([key, child]) =>
        [
          'absolutePath',
          'attachmentPath',
          'attachmentPaths',
          'attachmentPromptContexts',
        ].includes(key) || containsHostPath(child),
    );
  }
  return false;
}

/**
 * The stream a read selects. Absent, or `primary`, reads the chat's own
 * transcript; a `delegation` target reads that run's child stream, which
 * exists only in format 4 scopes. The target's chat must be the scope's.
 */
const readTarget = TranscriptTargetSchema.optional();
function targetsScopeChat(params: {
  scope: { chatId?: string };
  target?: TranscriptTarget;
}): boolean {
  return (
    params.target === undefined || params.target.chatId === params.scope.chatId
  );
}

export const CoreChatTranscriptPageParamsSchema = z
  .strictObject({
    scope,
    archivedContainerId: safeId.optional(),
    standaloneHistory: z.literal(true).optional(),
    target: readTarget,
    /**
     * Child stream pages continue with the opaque cursor the previous page
     * returned; it binds scope, archive, target, revision and position.
     */
    cursor: z.string().min(1).max(2048).optional(),
    before: ordinal.optional(),
    view: z.literal('turns').optional(),
    turnId: anchorId.optional(),
    transcriptRevision: ordinal.optional(),
  })
  .refine(
    (params) => params.turnId === undefined || params.view === 'turns',
    'Turn paging requires the turn view.',
  )
  .refine(targetsScopeChat, 'The read target must belong to the scope chat.')
  .refine(
    (params) =>
      params.target?.kind !== 'delegation' || params.view === undefined,
    'A child stream has no turn view.',
  )
  .refine(
    (params) =>
      params.target?.kind === 'delegation'
        ? params.before === undefined && params.transcriptRevision === undefined
        : params.cursor === undefined,
    'A child stream pages by cursor; the primary transcript by position.',
  )
  .refine(
    (params) =>
      params.archivedContainerId === undefined ||
      params.archivedContainerId === params.scope.worktreeId,
    'Archived container must match the transcript scope.',
  )
  .refine(
    (params) =>
      !params.standaloneHistory || params.archivedContainerId === undefined,
    'Invalid standalone archive scope.',
  );
export type CoreChatTranscriptPageParams = z.output<
  typeof CoreChatTranscriptPageParamsSchema
>;

export const CoreChatTranscriptPageResultSchema = z
  .object({
    messages: z.array(CoreChatTranscriptMessageSchema),
    runTruncated: z.literal(true).optional(),
    view: z.literal('turns').optional(),
    turnId: z.string().optional(),
    messageOrdinals: z.record(z.string(), ordinal).optional(),
    turns: z.array(z.unknown()).optional(),
    before: ordinal.optional(),
    totalMessages: ordinal,
    transcriptRevision: ordinal,
    /** A child stream's cursor for the next older page; absent at its start. */
    cursor: z.string().min(1).max(2048).optional(),
    latestHumanMessage: CoreChatTranscriptMessageSchema.optional(),
  })
  .refine(
    (result) =>
      !result.messages.some((message) => message.hidden === true) &&
      result.latestHumanMessage?.hidden !== true &&
      !containsHostPath(result),
    'Host-local paths are not portable.',
  );
export type CoreChatTranscriptPageResult = z.output<
  typeof CoreChatTranscriptPageResultSchema
>;

export const CoreChatTranscriptSearchParamsSchema = z
  .strictObject({
    scope,
    target: readTarget,
    query: z.string().min(2).max(256),
  })
  .refine(targetsScopeChat, 'The read target must belong to the scope chat.');
export type CoreChatTranscriptSearchParams = z.output<
  typeof CoreChatTranscriptSearchParamsSchema
>;

export const CoreChatTranscriptSearchResultSchema = z.object({
  matches: z.array(
    z.object({
      renderMessageId: z.string().optional(),
      messageId: z.string(),
      turnId: z.string(),
      count: ordinal,
    }),
  ),
  totalCount: ordinal,
});
export type CoreChatTranscriptSearchResult = z.output<
  typeof CoreChatTranscriptSearchResultSchema
>;

export const CoreChatTranscriptPageErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.chat.transcript.page.invalidState',
        'core.chat.transcript.page.notFound',
        /** A child page cursor from an older stream revision; read newest. */
        'core.chat.transcript.page.staleCursor',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });
export const CoreChatTranscriptSearchErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.chat.transcript.search.invalidState',
        'core.chat.transcript.search.notFound',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });
