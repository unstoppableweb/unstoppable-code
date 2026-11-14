import { z } from 'zod';
import { THINKING_LEVELS } from '../thinking';
import type { AgentDelegationErrorCode } from './index';
import {
  AGENT_DELEGATION_INPUT_LIMITS,
  AGENT_DELEGATION_TASK_IDS_MAX,
  AGENT_DELEGATION_TASK_ID_PATTERN,
  DELEGATION_APPLY_FAILURE_REASONS,
  DELEGATION_APPLY_ISSUE_REASONS,
  DELEGATION_STOP_REASONS,
} from './limits';
import {
  DELEGATION_CAPABILITY_ID_PATTERN,
  DELEGATION_CAPABILITY_KINDS,
  DELEGATION_CAPABILITY_LIMITS,
  DELEGATION_CAPABILITY_SKIP_REASONS,
  DELEGATION_CAPABILITY_SOURCES,
} from './capabilities';
import { AGENT_DELEGATION_PHASES, DELEGATION_IF_BUSY_VALUES } from './queues';
import { DELEGATION_NESTING_STATES } from './transcript';

/*
 * Wire schemas for the delegation shapes the `core.managedDelegation.*`
 * operations carry (CAN-6291). They describe the TypeScript contracts in this
 * folder; hosts produce those types, so a host whose values stop matching a
 * schema fails to compile where it returns them. Results are open objects
 * (unknown fields are dropped, not refused); params are closed.
 */

const text = z.string();
const count = z.number().int().nonnegative();
const timestampMs = z.number().int().nonnegative();
const writePaths = z.array(z.string().min(1).max(4095)).max(64).readonly();

export const AgentDelegationStatusSchema = z.enum([
  'pending',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
]);

export const DelegateSettledStatusSchema = z.enum([
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
  'interrupted',
]);

export const AGENT_DELEGATION_ERROR_CODES = [
  'invalid_request',
  'capability_unavailable',
  'route_unavailable',
  'auth_required',
  'interaction_required',
  'policy_blocked',
  'capacity_exceeded',
  'lifetime_limit_reached',
  'parent_unavailable',
  'launch_uncertain',
  'runtime_error',
  'apply_failed',
  'terminated_by_parent',
] as const satisfies readonly AgentDelegationErrorCode[];

export const AgentDelegationErrorCodeSchema = z.enum(
  AGENT_DELEGATION_ERROR_CODES,
);

export const DelegationThinkingLevelSchema = z.enum(THINKING_LEVELS);
export const DelegationIfBusySchema = z.enum(DELEGATION_IF_BUSY_VALUES);
export const AgentDelegationPhaseSchema = z.enum(AGENT_DELEGATION_PHASES);

export const DelegationApplyFailureSchema = z.object({
  reason: z.enum(DELEGATION_APPLY_FAILURE_REASONS),
  issues: z
    .array(
      z.object({
        path: text,
        reason: z.enum(DELEGATION_APPLY_ISSUE_REASONS),
        parentDiff: text.optional(),
        parentDiffTruncated: z.boolean().optional(),
      }),
    )
    .readonly(),
  omittedIssues: count.optional(),
  guidance: text,
});

export const AgentDelegationErrorSchema = z.object({
  code: AgentDelegationErrorCodeSchema,
  message: text,
  retryable: z.boolean(),
  apply: DelegationApplyFailureSchema.optional(),
});

export const AgentDelegationUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
  cacheCreationInputTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});

export const AgentDelegationQueueStateSchema = z.object({
  id: text,
  name: text,
  position: z.number().int().positive().optional(),
  waitingFor: z.enum(['queue', 'app', 'slot']).optional(),
  running: count.optional(),
  waiting: count.optional(),
  limit: z.number().int().positive().optional(),
});

export const AgentDelegationFeedSummarySchema = z.object({
  counts: z.record(z.string(), count.optional()),
  open: z
    .array(
      z.object({
        entryId: text,
        status: text,
        owner: z.object({ kind: text, actorId: text }),
      }),
    )
    .readonly(),
  openTotal: count,
  note: text.optional(),
});

export const AgentDelegationFeedAssignmentSchema = z.object({
  assigned: z.array(text).readonly(),
  subtasksAssigned: count,
  skipped: z.array(z.object({ entryId: text, reason: text })).readonly(),
  subtasksSkipped: count,
});

export const DelegationCapabilitySummarySchema = z.object({
  inherit: z.boolean(),
  discovery: z.boolean(),
  items: z
    .array(
      z.object({
        kind: z.enum(DELEGATION_CAPABILITY_KINDS),
        name: text,
        source: z.enum(DELEGATION_CAPABILITY_SOURCES),
      }),
    )
    .readonly(),
  skipped: z
    .array(
      z.object({
        kind: z.enum(DELEGATION_CAPABILITY_KINDS),
        name: text,
        reason: z.enum(DELEGATION_CAPABILITY_SKIP_REASONS),
      }),
    )
    .readonly(),
  omittedItems: count.optional(),
  omittedSkipped: count.optional(),
});

export const PersistedAgentRouteSnapshotSchema = z.object({
  selectedModelId: text,
  selectedModelLabel: text.optional(),
  runtimeModelLabel: text.optional(),
  runtimeModelId: text,
  harnessId: text,
  runtimeKind: text,
  runnerRegistrationId: text,
  runtimeVersion: text,
  adapterVersion: text,
  modelSource: text,
  providerType: text,
  assignmentRevision: text,
  routeId: text.optional(),
  billingAuthority: text,
  aiCreditsRouted: z.boolean(),
  requestedThinkingLevel: DelegationThinkingLevelSchema.optional(),
  effectiveThinkingLevel: DelegationThinkingLevelSchema.optional(),
  capabilities: z.array(text).readonly(),
  supportedThinkingLevels: z.array(DelegationThinkingLevelSchema).readonly(),
  capabilitySnapshotHash: text,
  capabilityGeneration: z.number().int(),
  policyRevision: text,
  agentOverlay: z
    .object({
      agentDefinitionId: text,
      agentDefinitionRevision: text,
      agentDefinitionHash: text,
      pluginProjectionHash: text,
    })
    .optional(),
});

/**
 * A steer's delivery outcome, as the parent's provider reported it. Only the
 * outcome and attempt are described; the refusal and failure details pass
 * through as the host built them.
 */
export const DelegationSteeringDeliverySchema = z.looseObject({
  kind: z.enum(['accepted', 'rejected', 'unknown']),
  attemptId: text,
});

export const DelegationStoppedBySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({
    kind: z.literal('agent'),
    depth: count,
    delegationId: text.optional(),
    description: text.optional(),
  }),
]);

export const AgentDelegationSnapshotSchema = z.object({
  feed: AgentDelegationFeedSummarySchema.optional(),
  feedAssignment: AgentDelegationFeedAssignmentSchema.optional(),
  depth: count.optional(),
  nestedDelegation: z.enum(DELEGATION_NESTING_STATES).optional(),
  parentDelegationId: text.optional(),
  parentDescription: text.optional(),
  permissions: z.object({ writePaths }).optional(),
  workspaceDiscarded: z.boolean().optional(),
  runGeneration: z.number().int().positive().optional(),
  resultIndex: z.number().int().positive().optional(),
  delegationId: text,
  status: AgentDelegationStatusSchema,
  routeSnapshot: PersistedAgentRouteSnapshotSchema.optional(),
  requestedModelId: text.optional(),
  control: z
    .object({
      operationId: text,
      operation: z.enum([
        'follow_up',
        'resume',
        'steer',
        'interrupt',
        'apply',
        'discard',
      ]),
      status: z.enum(['accepted', 'completed', 'failed']),
      steeringDelivery: DelegationSteeringDeliverySchema.optional(),
      error: text.optional(),
      applyFailure: DelegationApplyFailureSchema.optional(),
    })
    .optional(),
  isolatedWorkspace: z
    .object({
      revision: text,
      dirtyParentChangesIncluded: z.literal(false),
    })
    .optional(),
  stopRequested: z
    .object({
      operationId: text,
      status: z.enum(['accepted', 'completed', 'failed']),
    })
    .optional(),
  approvalPending: z.boolean().optional(),
  workspaceObservation: z
    .object({
      consistency: z.literal('live_shared_worktree'),
      headRevision: text.nullable(),
      dirty: z.boolean().nullable(),
      observedAt: timestampMs,
    })
    .optional(),
  nativeSessionId: text.optional(),
  partialText: text.optional(),
  finalText: text.optional(),
  outputTruncated: z.boolean(),
  error: AgentDelegationErrorSchema.optional(),
  usage: AgentDelegationUsageSchema.optional(),
  stopReason: z.enum(DELEGATION_STOP_REASONS).optional(),
  cancelledByUser: z.boolean().optional(),
  stoppedBy: DelegationStoppedBySchema.optional(),
  childDelegationIds: z.array(text).readonly().optional(),
  capabilities: DelegationCapabilitySummarySchema.optional(),
  phase: AgentDelegationPhaseSchema.optional(),
  queue: AgentDelegationQueueStateSchema.optional(),
});

export const DelegateOutputAnswerPageSchema = z.object({
  role: z.enum(['final', 'partial']),
  text,
  encoding: z.enum(['utf8', 'utf16le']),
  byteLength: count,
  offset: count,
  nextOffset: count.optional(),
  notice: text.optional(),
});

export const DelegateOutputSchema = z.object({
  resultIndex: z.number().int().positive(),
  runGeneration: z.number().int().positive(),
  status: DelegateSettledStatusSchema,
  finalText: text.optional(),
  partialText: text.optional(),
  outputTruncated: z.boolean(),
  error: AgentDelegationErrorSchema.optional(),
  usage: AgentDelegationUsageSchema.optional(),
  answer: DelegateOutputAnswerPageSchema.optional(),
  contentError: z
    .object({
      code: z.enum([
        'answer_unavailable',
        'corruption',
        'not_found',
        'storage_failure',
      ]),
      message: text,
      retryable: z.boolean(),
    })
    .optional(),
});

export const GetDelegateOutputValueSchema = z.object({
  delegationId: text,
  currentRunGeneration: z.number().int().nonnegative(),
  currentStatus: AgentDelegationStatusSchema,
  latestResultIndex: z.number().int().positive().nullable(),
  result: DelegateOutputSchema.nullable(),
  currentPhase: AgentDelegationPhaseSchema.optional(),
  queue: AgentDelegationQueueStateSchema.optional(),
  feed: AgentDelegationFeedSummarySchema.optional(),
});

export const DelegationModelChoiceSchema = z.object({
  modelId: text,
  label: text,
  harnessId: text,
  runtimeKind: text,
  supportedThinkingLevels: z.array(DelegationThinkingLevelSchema).readonly(),
  capabilities: z.array(text).readonly(),
  availability: z.enum(['available', 'unavailable', 'unknown']),
  authState: z.enum(['ready', 'required', 'unknown']),
  disabledReason: text.optional(),
});

export const DelegationModelDiscoverySchema = z.object({
  models: z.array(DelegationModelChoiceSchema).readonly(),
  agents: z
    .array(
      z.object({
        agentId: text,
        label: text,
        models: z.array(text).readonly(),
      }),
    )
    .readonly()
    .optional(),
  recommendedModelId: text.optional(),
  truncated: z.boolean(),
});

const boundedText = (limit: number): z.ZodString =>
  z
    .string()
    .max(limit)
    .refine((value) => value.trim().length > 0 && !value.includes('\0'));

/** A delegation or model identity, as the tools accept it. */
export const DelegationIdentifierSchema = z
  .string()
  .min(1)
  .max(AGENT_DELEGATION_INPUT_LIMITS.idCharacters)
  .regex(/^\S(?:[^\r\n]*\S)?$/);

/** A message or prompt to a delegate. */
export const DelegationMessageTextSchema = boundedText(
  AGENT_DELEGATION_INPUT_LIMITS.promptCharacters,
);

/**
 * `AgentDelegationSpawnRequest` as params. `parseAgentDelegationSpawnRequest`
 * stays the authority: a host parses these fields with it again, so the path
 * and default rules it applies are not repeated here.
 */
export const AgentDelegationSpawnRequestShape = {
  modelId: DelegationIdentifierSchema,
  description: boundedText(AGENT_DELEGATION_INPUT_LIMITS.descriptionCharacters),
  prompt: DelegationMessageTextSchema,
  executionMode: z.enum(['background', 'foreground']).optional(),
  contextPolicy: z.literal('task_only').optional(),
  isolation: z.enum(['shared_worktree', 'worktree']).optional(),
  permissions: z.strictObject({ writePaths }).optional(),
  thinkingLevel: DelegationThinkingLevelSchema.optional(),
  fastMode: z.boolean().optional(),
  allowNestedDelegation: z.boolean().optional(),
  inheritCapabilities: z.boolean().optional(),
  capabilities: z
    .array(z.string().regex(DELEGATION_CAPABILITY_ID_PATTERN))
    .max(DELEGATION_CAPABILITY_LIMITS.explicit)
    .readonly()
    .optional(),
  allowCapabilityDiscovery: z.boolean().optional(),
  ifBusy: DelegationIfBusySchema.optional(),
  name: boundedText(AGENT_DELEGATION_INPUT_LIMITS.nameCharacters).optional(),
  taskIds: z
    .array(z.string().regex(new RegExp(AGENT_DELEGATION_TASK_ID_PATTERN)))
    .min(1)
    .max(AGENT_DELEGATION_TASK_IDS_MAX)
    .readonly()
    .optional(),
} as const;
