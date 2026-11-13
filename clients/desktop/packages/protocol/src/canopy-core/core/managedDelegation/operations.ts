import { z } from 'zod';
import type { AgentDelegationError } from '../../../delegation';
import {
  AGENT_DELEGATION_ERROR_CODES,
  AgentDelegationPhaseSchema,
  AgentDelegationSnapshotSchema,
  AgentDelegationSpawnRequestShape,
  DelegationIdentifierSchema,
  DelegationIfBusySchema,
  DelegationMessageTextSchema,
  DelegationModelDiscoverySchema,
  GetDelegateOutputValueSchema,
} from '../../../delegation/wire';
import { DELEGATION_CAPABILITY_KINDS } from '../../../delegation/capabilities';
import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
  type CanopyErrorPayload,
} from '../../errors';

/*
 * Managed delegation (CAN-6291, cloud cross-harness delegation contract
 * section 8): the reads and controls the UI and agents use for a chat's
 * delegates. Agents keep their tool names (DelegateTask and the rest); these
 * are the operations those tools and the UI call.
 *
 * Not composed into the core registry. The web core registers every one
 * behind its rollout flag and answers `capability_unavailable` until Core's
 * delegation API exists (CAN-6293). The desktop dispatcher serves the user
 * reads and controls from its delegation broker and answers
 * `capability_unavailable` for the ones only a calling agent's own turn can
 * make (spawn, output, models, steering, workspace). The daemon serves none.
 *
 * The caller's chat turn, tool call, depth and delegation record come from
 * the binding, never from params. CAN-6107's native agent task operations
 * stay under `core.chat`; nothing here reads a chat's task tree.
 */

export const MANAGED_DELEGATION_GRANTS = {
  read: 'core.managedDelegation.read',
  control: 'core.managedDelegation.control',
} as const;

/** The most delegations one `core.managedDelegation.list` page holds. */
export const MANAGED_DELEGATION_LIST_PAGE_MAX = 100;

const id = z.string().min(1).max(512);
const cursor = z.string().min(1).max(2048);
const keyedMeta = CanopyRequestMetadataSchema.extend({ idempotencyKey: id });

/** The chat whose delegates a call reads or controls, as `core.chat` names it. */
const chat = {
  scope: z.strictObject({ workspaceId: id, worktreeId: id }),
  chatId: id,
};

function camel(code: string): string {
  return code.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Operation codes: one per `AgentDelegationErrorCode`, in lower camel case,
 * and `notFound` for a delegation the chat does not have.
 */
export const MANAGED_DELEGATION_ERROR_CODES = [
  ...AGENT_DELEGATION_ERROR_CODES.map(
    (code) => `core.managedDelegation.${camel(code)}` as const,
  ),
  'core.managedDelegation.notFound',
] as const;

export const ManagedDelegationErrorCodeSchema = z.enum(
  MANAGED_DELEGATION_ERROR_CODES,
);

const QueryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: ManagedDelegationErrorCodeSchema.optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

const InstructionErrorSchema = CanopyErrorPayloadSchema.extend({
  code: ManagedDelegationErrorCodeSchema.optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

const ERROR_KINDS = {
  invalid_request: 'invalid_argument',
  capability_unavailable: 'capability_unavailable',
  route_unavailable: 'failed_precondition',
  auth_required: 'failed_precondition',
  interaction_required: 'failed_precondition',
  policy_blocked: 'permission_denied',
  capacity_exceeded: 'resource_exhausted',
  lifetime_limit_reached: 'resource_exhausted',
  // Also the denial for a delegation outside the caller's subtree, which
  // reveals nothing about that delegation.
  parent_unavailable: 'not_found',
  launch_uncertain: 'unavailable',
  runtime_error: 'internal',
  apply_failed: 'failed_precondition',
  terminated_by_parent: 'failed_precondition',
} as const satisfies Record<
  (typeof AGENT_DELEGATION_ERROR_CODES)[number],
  CanopyErrorPayload['kind']
>;

/**
 * The error payload for a delegation error: its code as the operation code,
 * its kind from the table above, and a retry only when the error says it is
 * retryable. An `apply_failed` error carries its failure in `details`.
 */
export function managedDelegationErrorPayload(
  error: AgentDelegationError,
  kind: 'query' | 'instruction',
): CanopyErrorPayload {
  return {
    kind: ERROR_KINDS[error.code],
    message: error.message,
    code: `core.managedDelegation.${camel(error.code)}`,
    ...(error.apply
      ? {
          details: CanopyJsonValueSchema.parse(
            JSON.parse(JSON.stringify(error.apply)),
          ),
        }
      : {}),
    retry: error.retryable
      ? { kind: kind === 'query' ? 'same_request' : 'same_idempotency_key' }
      : { kind: 'never' },
  };
}

export const ManagedDelegationSpawnParamsSchema = z.strictObject({
  ...chat,
  ...AgentDelegationSpawnRequestShape,
  _meta: keyedMeta,
});

export const ManagedDelegationGetParamsSchema = z.strictObject({
  ...chat,
  delegationId: DelegationIdentifierSchema,
});

export const ManagedDelegationListParamsSchema = z.strictObject({
  ...chat,
  /** Only this delegation's descendants; it never widens what the caller reads. */
  underDelegationId: DelegationIdentifierSchema.optional(),
  cursor: cursor.optional(),
});

export const ManagedDelegationListResultSchema = z.object({
  items: z
    .array(AgentDelegationSnapshotSchema)
    .max(MANAGED_DELEGATION_LIST_PAGE_MAX)
    .readonly(),
  nextCursor: cursor.nullable(),
});

export const ManagedDelegationModelsListParamsSchema = z.strictObject({
  ...chat,
  includeCapabilities: z.boolean().optional(),
});

export const ManagedDelegationModelsListResultSchema =
  DelegationModelDiscoverySchema.extend({
    /** With `includeCapabilities`: what a delegate could be given. */
    capabilities: z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(DELEGATION_CAPABILITY_KINDS),
          name: z.string(),
          description: z.string().optional(),
          inherited: z.boolean(),
          assignable: z.boolean(),
          disabledReason: z.string().optional(),
        }),
      )
      .readonly()
      .optional(),
  });

export const ManagedDelegationOutputReadParamsSchema = z
  .strictObject({
    ...chat,
    delegationId: DelegationIdentifierSchema,
    resultIndex: z.number().int().positive().optional(),
    /** Byte offset into the pinned result's body; nonzero requires `resultIndex`. */
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(4).max(65_536).optional(),
  })
  .refine(
    (params) => !params.offset || params.resultIndex !== undefined,
    'A nonzero offset reads a pinned result: pass resultIndex.',
  );

export const ManagedDelegationMessageParamsSchema = z
  .strictObject({
    ...chat,
    delegationId: DelegationIdentifierSchema,
    operation: z.enum(['follow_up', 'steer', 'interrupt']),
    /** Required for a follow-up or steer; an interrupt takes none. */
    message: DelegationMessageTextSchema.optional(),
    ifBusy: DelegationIfBusySchema.optional(),
    /** The control's identity, which the delegation reports back in `control`. */
    operationId: z.uuid(),
    _meta: keyedMeta,
  })
  .refine(
    (params) =>
      params.operation === 'interrupt'
        ? params.message === undefined && params.ifBusy === undefined
        : params.message !== undefined,
    'A follow-up or steer needs a message; an interrupt takes no message or ifBusy.',
  );

export const ManagedDelegationMessageResultSchema = z.object({
  /** The run the message started or reached. */
  runGeneration: z.number().int().positive(),
  phase: AgentDelegationPhaseSchema.optional(),
});

export const ManagedDelegationStopParamsSchema = z.strictObject({
  ...chat,
  delegationId: DelegationIdentifierSchema,
  _meta: keyedMeta,
});

export const ManagedDelegationStopResultSchema = z.object({
  accepted: z.boolean(),
});

export const ManagedDelegationStopAllParamsSchema = z.strictObject({
  ...chat,
  _meta: keyedMeta,
});

export const ManagedDelegationStopAllResultSchema = z.object({
  /** Live delegations the stop reached, subtrees included. */
  stopped: z.number().int().nonnegative(),
});

/** Sent by a delegate; its delegation comes from the binding. */
export const ManagedDelegationSteeringRequestParamsSchema = z.strictObject({
  message: DelegationMessageTextSchema,
  _meta: keyedMeta,
});

export const ManagedDelegationSteeringRequestResultSchema = z.object({
  requestId: z.string().min(1),
});

export const ManagedDelegationLifetimeGetParamsSchema = z.strictObject({
  ...chat,
});

export const ManagedDelegationLifetimeGetResultSchema = z.object({
  /** Delegations counted against the limit. */
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
});

export const ManagedDelegationWorkspaceManageParamsSchema = z.strictObject({
  ...chat,
  delegationId: DelegationIdentifierSchema,
  operation: z.enum(['apply', 'discard']),
  _meta: keyedMeta,
});

export const CORE_MANAGED_DELEGATION_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.managedDelegation.get': defineCanopyQuery({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationGetParamsSchema,
      result: AgentDelegationSnapshotSchema,
      error: QueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.read],
    }),
    'core.managedDelegation.list': defineCanopyQuery({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationListParamsSchema,
      result: ManagedDelegationListResultSchema,
      error: QueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.read],
    }),
    'core.managedDelegation.models.list': defineCanopyQuery({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationModelsListParamsSchema,
      result: ManagedDelegationModelsListResultSchema,
      error: QueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.read],
    }),
    'core.managedDelegation.output.read': defineCanopyQuery({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationOutputReadParamsSchema,
      result: GetDelegateOutputValueSchema,
      error: QueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.read],
    }),
    'core.managedDelegation.lifetime.get': defineCanopyQuery({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationLifetimeGetParamsSchema,
      result: ManagedDelegationLifetimeGetResultSchema,
      error: QueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.read],
    }),
  });

export const CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.managedDelegation.spawn': defineCanopyInstruction({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationSpawnParamsSchema,
      result: AgentDelegationSnapshotSchema,
      error: InstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.control],
    }),
    'core.managedDelegation.message': defineCanopyInstruction({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationMessageParamsSchema,
      result: ManagedDelegationMessageResultSchema,
      error: InstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.control],
    }),
    'core.managedDelegation.stop': defineCanopyInstruction({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationStopParamsSchema,
      result: ManagedDelegationStopResultSchema,
      error: InstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.control],
    }),
    'core.managedDelegation.stopAll': defineCanopyInstruction({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationStopAllParamsSchema,
      result: ManagedDelegationStopAllResultSchema,
      error: InstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.control],
    }),
    'core.managedDelegation.steering.request': defineCanopyInstruction({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationSteeringRequestParamsSchema,
      result: ManagedDelegationSteeringRequestResultSchema,
      error: InstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.control],
    }),
    'core.managedDelegation.workspace.manage': defineCanopyInstruction({
      plane: 'core',
      domain: 'managedDelegation',
      version: 1,
      placement: 'core-only',
      params: ManagedDelegationWorkspaceManageParamsSchema,
      result: AgentDelegationSnapshotSchema,
      error: InstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [MANAGED_DELEGATION_GRANTS.control],
    }),
  });
