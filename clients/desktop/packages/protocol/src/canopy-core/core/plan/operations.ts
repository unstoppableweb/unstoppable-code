import { z } from 'zod';

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
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  DetectedPlanListParamsSchema,
  DetectedPlanListResultSchema,
  DetectedPlanScanParamsSchema,
  DetectedPlanScanResultSchema,
  DetectedPlanUpdateParamsSchema,
  DetectedPlanUpdateResultSchema,
  PlanCreateParamsSchema,
  PlanDeleteParamsSchema,
  PlanDeleteResultSchema,
  PlanDiagramGenerateParamsSchema,
  PlanDiagramGenerateResultSchema,
  PlanEventSchema,
  PlanEventsParamsSchema,
  PlanGetParamsSchema,
  PlanGetResultSchema,
  PlanImportParamsSchema,
  PlanImportResultSchema,
  PlanListParamsSchema,
  PlanListResultSchema,
  PlanUpdateParamsSchema,
  PlanWriteResultSchema,
} from './schemas';

export const PLAN_GRANTS = {
  read: 'core.plan.read',
  write: 'core.plan.write',
} as const;

/** The resource a conflicting caller refreshes before it retries. */
export const PLAN_RESOURCE = 'core.plan';

export const PLAN_ERROR_REASONS = [
  'REVISION_CONFLICT',
  'READ_ONLY_SCOPE',
  'UNSUPPORTED_SCOPE',
  'IMPORT_PATH',
  'DAMAGED_STATE',
] as const;
export type PlanErrorReason = (typeof PLAN_ERROR_REASONS)[number];

export const PLAN_ERROR_CODES = {
  REVISION_CONFLICT: 'core.plan.revisionConflict',
  /** A shared-container recipient scope, which is read-only. */
  READ_ONLY_SCOPE: 'core.plan.readOnlyScope',
  /** A cowork, plan-explore, code-review or standalone chat scope has no plans. */
  UNSUPPORTED_SCOPE: 'core.plan.unsupportedScope',
  /** An import path outside the worktree, unreadable, or not a plan document. */
  IMPORT_PATH: 'core.plan.importPath',
  /**
   * The scope's stored plans cannot be read, so a write is refused rather
   * than replacing them (the CAN-5833 rule).
   */
  DAMAGED_STATE: 'core.plan.damagedState',
} as const satisfies Record<PlanErrorReason, string>;

export const PlanOperationErrorDetailsSchema = z.strictObject({
  reason: z.enum(PLAN_ERROR_REASONS),
  /** The stored revision a conflicting write was compared with. */
  currentRevision: z.number().int().min(1).optional(),
});
export type PlanOperationErrorDetails = z.output<
  typeof PlanOperationErrorDetailsSchema
>;

const planErrorCode = z
  .enum([
    PLAN_ERROR_CODES.REVISION_CONFLICT,
    PLAN_ERROR_CODES.READ_ONLY_SCOPE,
    PLAN_ERROR_CODES.UNSUPPORTED_SCOPE,
    PLAN_ERROR_CODES.IMPORT_PATH,
    PLAN_ERROR_CODES.DAMAGED_STATE,
  ])
  .optional();

export const PlanQueryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: planErrorCode,
  details: PlanOperationErrorDetailsSchema.optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const PlanInstructionErrorSchema = CanopyErrorPayloadSchema.extend({
  code: planErrorCode,
  details: PlanOperationErrorDetailsSchema.optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

/**
 * `core.plan.diagram.generate` (CAN-4167) adds one reason to the plan
 * failures: no execution harness serves the configured diagram model.
 */
export const PLAN_DIAGRAM_ERROR_REASONS = [
  ...PLAN_ERROR_REASONS,
  'DIAGRAM_MODEL_UNAVAILABLE',
] as const;

export const PLAN_DIAGRAM_ERROR_CODES = {
  ...PLAN_ERROR_CODES,
  DIAGRAM_MODEL_UNAVAILABLE: 'core.plan.diagramModelUnavailable',
} as const satisfies Record<
  (typeof PLAN_DIAGRAM_ERROR_REASONS)[number],
  string
>;

export const PlanDiagramGenerateErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      PLAN_DIAGRAM_ERROR_CODES.REVISION_CONFLICT,
      PLAN_DIAGRAM_ERROR_CODES.READ_ONLY_SCOPE,
      PLAN_DIAGRAM_ERROR_CODES.UNSUPPORTED_SCOPE,
      PLAN_DIAGRAM_ERROR_CODES.IMPORT_PATH,
      PLAN_DIAGRAM_ERROR_CODES.DAMAGED_STATE,
      PLAN_DIAGRAM_ERROR_CODES.DIAGRAM_MODEL_UNAVAILABLE,
    ])
    .optional(),
  details: z
    .strictObject({
      reason: z.enum(PLAN_DIAGRAM_ERROR_REASONS),
      currentRevision: z.number().int().min(1).optional(),
    })
    .optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const PlanEventsOpenResultSchema = z.strictObject({
  subscriptionId: z.string().min(1).max(512),
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});

export const PlanEventsEndSchema = CanopyStreamEndSchema.extend({
  error: PlanQueryErrorSchema.nullable(),
});

const plan = {
  plane: 'core',
  domain: 'plan',
  version: 1,
  placement: 'core-only',
} as const;

// Served by the desktop dispatcher only: list, get, create, update, delete and
// import (CAN-4165, import in PR 5a) in process over the plan engine, the
// detected-plan operations (PR 5b) over the detected-plans writer, and
// diagram.generate (CAN-4167). No binding serves core.plan.events yet; it
// answers `capability_unavailable`.
export const CORE_PLAN_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.plan.list': defineCanopyQuery({
    ...plan,
    params: PlanListParamsSchema,
    result: PlanListResultSchema,
    error: PlanQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [PLAN_GRANTS.read],
  }),
  'core.plan.get': defineCanopyQuery({
    ...plan,
    params: PlanGetParamsSchema,
    result: PlanGetResultSchema,
    error: PlanQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [PLAN_GRANTS.read],
  }),
  'core.plan.detected.list': defineCanopyQuery({
    ...plan,
    params: DetectedPlanListParamsSchema,
    result: DetectedPlanListResultSchema,
    error: PlanQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [PLAN_GRANTS.read],
  }),
});

export const CORE_PLAN_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.plan.create': defineCanopyInstruction({
      ...plan,
      params: PlanCreateParamsSchema,
      result: PlanWriteResultSchema,
      error: PlanInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PLAN_GRANTS.write],
    }),
    'core.plan.update': defineCanopyInstruction({
      ...plan,
      params: PlanUpdateParamsSchema,
      result: PlanWriteResultSchema,
      error: PlanInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PLAN_GRANTS.write],
    }),
    'core.plan.delete': defineCanopyInstruction({
      ...plan,
      params: PlanDeleteParamsSchema,
      result: PlanDeleteResultSchema,
      error: PlanInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PLAN_GRANTS.write],
    }),
    'core.plan.import': defineCanopyInstruction({
      ...plan,
      params: PlanImportParamsSchema,
      result: PlanImportResultSchema,
      error: PlanInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PLAN_GRANTS.write],
    }),
    'core.plan.detected.scan': defineCanopyInstruction({
      ...plan,
      params: DetectedPlanScanParamsSchema,
      result: DetectedPlanScanResultSchema,
      error: PlanInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PLAN_GRANTS.write],
    }),
    'core.plan.detected.update': defineCanopyInstruction({
      ...plan,
      params: DetectedPlanUpdateParamsSchema,
      result: DetectedPlanUpdateResultSchema,
      error: PlanInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PLAN_GRANTS.write],
    }),
    'core.plan.diagram.generate': defineCanopyInstruction({
      ...plan,
      params: PlanDiagramGenerateParamsSchema,
      result: PlanDiagramGenerateResultSchema,
      error: PlanDiagramGenerateErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PLAN_GRANTS.write],
    }),
  });

export const CORE_PLAN_STREAM_DEFINITIONS = defineCanopyStreamRegistry('core', {
  'core.plan.events': defineCanopyStream({
    ...plan,
    idempotency: 'inherent',
    requiredGrants: [PLAN_GRANTS.read],
    params: PlanEventsParamsSchema,
    openResult: PlanEventsOpenResultSchema,
    item: PlanEventSchema,
    end: PlanEventsEndSchema,
    error: PlanQueryErrorSchema,
  }),
});
