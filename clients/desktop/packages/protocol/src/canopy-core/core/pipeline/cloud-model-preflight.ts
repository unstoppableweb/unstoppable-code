import { z } from 'zod';

import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyRetryDirectiveSchema,
} from '../../errors';
import { PIPELINE_GRANTS } from './operations';

/**
 * Cloud model preflight (CAN-6174, plan CP-26): the model steps of a workflow
 * that a cloud run can't run as written, each with the cloud models the user
 * may pick instead. Nothing is replaced until the user confirms a choice for
 * every item; the web core saves confirmed choices per workflow and per
 * workflow schedule, and asks again when the workflow or the run owner's
 * model policy changes. The local workflow is never edited.
 *
 * `@canopy/pipeline-interop/cloud-model-preflight` finds the items and
 * applies confirmed choices; the web core's cloud run service checks them
 * before a run starts and serves `core.pipeline.cloudModels.preflight` and
 * `core.pipeline.cloudModels.save` below.
 */

/**
 * Why a model step needs a cloud replacement. Rows R1 to R3 of the cloud
 * parity matrix (`docs/pipelines-cloud-parity.md`), the run owner's model
 * policy, and an action that runs only some harnesses in the cloud.
 */
export const CLOUD_MODEL_PREFLIGHT_REASONS = [
  /** R1: the model has no cloud route, only a subscription or local setup. */
  'subscription_model',
  /** R2: a Cursor, Copilot or OpenCode model. */
  'local_harness',
  /** R3: an Ollama model. */
  'local_model',
  /** The run owner's model policy blocks the model, or allows only its gateway. */
  'blocked_model',
  /** The step's action doesn't run this model's harness in the cloud. */
  'action_harness',
] as const;

export type CloudModelPreflightReason =
  (typeof CLOUD_MODEL_PREFLIGHT_REASONS)[number];

/** Harnesses a cloud run executes model steps on. */
export const CLOUD_MODEL_HARNESSES = ['claude', 'codex'] as const;
export type CloudModelHarness = (typeof CLOUD_MODEL_HARNESSES)[number];

/** The harness a step's model names, as far as preflight can tell. */
export const CLOUD_MODEL_STEP_HARNESSES = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
  'ollama',
] as const;

/** The most alternatives listed for one item. */
export const CLOUD_MODEL_ALTERNATIVES_MAX = 50;
/** The most items one preflight lists. */
export const CLOUD_MODEL_PREFLIGHT_ITEMS_MAX = 200;

const modelId = z.string().min(1).max(512);

/** A cloud model a step may use instead. */
export const CloudModelOptionSchema = z.strictObject({
  /** The cloud catalog id (an AI Gateway id such as `anthropic/claude-sonnet-5.5`). */
  modelId,
  label: z.string().min(1).max(256),
  harness: z.enum(CLOUD_MODEL_HARNESSES),
});
export type CloudModelOption = z.output<typeof CloudModelOptionSchema>;

/** One model step a cloud run can't run as written. */
export const CloudModelPreflightItemSchema = z.strictObject({
  /** `<jobId>#<stepIndex>`: stable for one definition content hash. */
  itemKey: z.string().min(1).max(600),
  reason: z.enum(CLOUD_MODEL_PREFLIGHT_REASONS),
  /** The parity matrix row (`R2`) or plan ticket that explains it. */
  parityId: z.string().min(1).max(16),
  message: z.string().min(1).max(512),
  jobId: z.string().min(1).max(512),
  stepIndex: z.number().int().nonnegative(),
  /** The step's `name` or `id`, when it has one. */
  stepName: z.string().max(512).optional(),
  uses: z.string().max(512),
  /** The model as the step names it; empty for the action's default. */
  model: z.string().max(512),
  harness: z.enum(CLOUD_MODEL_STEP_HARNESSES).optional(),
  /** The cloud models the user may pick; empty when there are none. */
  alternatives: z
    .array(CloudModelOptionSchema)
    .max(CLOUD_MODEL_ALTERNATIVES_MAX),
});
export type CloudModelPreflightItem = z.output<
  typeof CloudModelPreflightItemSchema
>;

/** The user's confirmed replacement for one item. */
export const CloudModelChoiceSchema = z.strictObject({
  itemKey: z.string().min(1).max(600),
  modelId,
});
export type CloudModelChoice = z.output<typeof CloudModelChoiceSchema>;

export const CloudModelChoicesSchema = z
  .array(CloudModelChoiceSchema)
  .max(CLOUD_MODEL_PREFLIGHT_ITEMS_MAX);

/**
 * Saved choices for this workflow or schedule: `none`, `current` (the next
 * run reuses them), or `stale` (the workflow or the model policy changed
 * since they were confirmed, so the user chooses again).
 */
export const CLOUD_MODEL_SAVED_STATES = ['none', 'current', 'stale'] as const;
export type CloudModelSavedState = (typeof CLOUD_MODEL_SAVED_STATES)[number];

/** What a cloud model preflight answers. */
export const CloudModelPreflightResultSchema = z.strictObject({
  definitionId: z.string().min(1).max(512),
  /** The workflow schedule the choices belong to; null for manual runs. */
  scheduleId: z.string().min(1).max(512).nullable(),
  /** SHA-256 of the definition document the items were found in. */
  definitionHash: z.string().length(64),
  /** SHA-256 of the run owner's model policy the items were checked against. */
  policyFingerprint: z.string().length(64),
  items: z
    .array(CloudModelPreflightItemSchema)
    .max(CLOUD_MODEL_PREFLIGHT_ITEMS_MAX),
  saved: z.enum(CLOUD_MODEL_SAVED_STATES),
});
export type CloudModelPreflightResult = z.output<
  typeof CloudModelPreflightResultSchema
>;

/** A start refused because model steps have no confirmed replacement. */
export const CLOUD_MODEL_UNCONFIRMED_CODE =
  'core.pipeline.cloudModelsUnconfirmed';

/** What a cloud model preflight names: the workflow, run owner and schedule. */
export const CloudModelPreflightParamsSchema = z.strictObject({
  definitionId: z.string().min(1).max(512),
  /** `personal` or `org:<uuid>`: who the cloud run belongs to. */
  owner: z.string().min(1).max(64),
  /** The workflow schedule the choices belong to; omitted for manual runs. */
  scheduleId: z.string().min(1).max(512).optional(),
});

/** Choices the user confirmed, for the preflight they were shown. */
export const CloudModelSaveParamsSchema =
  CloudModelPreflightParamsSchema.extend({
    definitionHash: z.string().length(64),
    policyFingerprint: z.string().length(64),
    choices: CloudModelChoicesSchema,
  });

/** Codes a cloud model preflight or save may fail with. */
export const CLOUD_MODEL_PREFLIGHT_ERROR_CODES = [
  'core.pipeline.definitionNotFound',
  'core.pipeline.definitionInvalid',
  'core.pipeline.sourceUnavailable',
  'core.pipeline.contextMismatch',
  'core.pipeline.cloudRunRefused',
  CLOUD_MODEL_UNCONFIRMED_CODE,
] as const;

export const CloudModelPreflightErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(CLOUD_MODEL_PREFLIGHT_ERROR_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CloudModelSaveErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(CLOUD_MODEL_PREFLIGHT_ERROR_CODES).optional(),
  retry: CanopyRetryDirectiveSchema,
});

/**
 * Served by the web core only, behind the cloud pipelines rollout flag, and
 * not composed into the core registry: desktop and the daemon answer
 * `capability_unavailable`. They are not in
 * `CORE_PIPELINE_CLOUD_RUN_OPERATIONS`, so they never offer "Run on: Cloud"
 * by themselves; the start operation (CP-21) takes the confirmed choices.
 */
export const CORE_PIPELINE_CLOUD_MODEL_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.pipeline.cloudModels.preflight': defineCanopyQuery({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: CloudModelPreflightParamsSchema,
      result: CloudModelPreflightResultSchema,
      error: CloudModelPreflightErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PIPELINE_GRANTS.read],
    }),
  });

export const CORE_PIPELINE_CLOUD_MODEL_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    // Saving the same choices again stores the same row.
    'core.pipeline.cloudModels.save': defineCanopyInstruction({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: CloudModelSaveParamsSchema,
      result: CloudModelPreflightResultSchema,
      error: CloudModelSaveErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PIPELINE_GRANTS.write],
    }),
  });
