import { z } from 'zod';
import {
  CopilotSelectionIdentitySchema,
  CopilotHostSelectionSchema,
} from './copilot-selection';
import { VaultSecretPinSchema } from './canopy-core';
const text = z.string().min(1).max(512);
export const CopilotHandoffBindingSchema = z.strictObject({
  attemptId: text,
  migrationEpoch: z.number().int().nonnegative(),
  operationId: text,
  accountEpoch: text,
});
export const CopilotHandoffControlSchema = z.strictObject({
  version: z.literal(1),
  generation: z.number().int().nonnegative(),
  source: z.strictObject({ flavorId: text, secureMode: text }),
  slot: z.literal('copilot-account'),
  handoffId: text,
  ciphertextGeneration: text.nullable(),
  binding: CopilotHandoffBindingSchema.nullable(),
  predecessorGeneration: text.nullable(),
  disposition: z.enum([
    'preparing',
    'pending',
    'selected',
    'cancelling',
    'retired',
  ]),
});
export type CopilotHandoffControl = z.infer<typeof CopilotHandoffControlSchema>;
export const CopilotHandoffActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('freeze'),
    retirement: z.literal(true).optional(),
  }),
  z.strictObject({
    kind: z.literal('checkpoint'),
    binding: CopilotHandoffBindingSchema,
  }),
  z.strictObject({
    kind: z.literal('prepare'),
    identity: CopilotSelectionIdentitySchema,
    predecessorGeneration: text.nullable(),
  }),
  z.strictObject({
    kind: z.literal('confirm'),
    generation: text,
    predecessorGeneration: text.nullable(),
    request: CopilotSelectionIdentitySchema.extend({
      pin: VaultSecretPinSchema,
    }),
  }),
  z.strictObject({
    kind: z.literal('abandon'),
    identity: CopilotSelectionIdentitySchema,
    destination: VaultSecretPinSchema.nullable(),
    published: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('read') }),
  z.strictObject({ kind: z.literal('freeze-cleanup') }),
  z.strictObject({
    kind: z.literal('cleanup'),
    operationId: z.string().uuid(),
    generation: z.string().regex(/^[a-f0-9]{64}$/),
    step: z.enum(['claim', 'detach', 'remove']),
  }),
  z.strictObject({
    kind: z.literal('release'),
    disposition: z.enum(['pending', 'selected', 'cancelling', 'retired']),
  }),
]);
export const CopilotFreezeResultSchema = z.strictObject({
  freezeId: text,
  generation: text,
  account: CopilotSelectionIdentitySchema.shape.account,
  predecessorGeneration: text.nullable(),
});
export const CopilotConfirmResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('confirmed'),
    receipt: CopilotSelectionIdentitySchema.extend({
      pin: VaultSecretPinSchema,
      pinGeneration: text,
    }),
  }),
  z.strictObject({ kind: z.enum(['unconfirmed', 'superseded']) }),
]);
export const CopilotSelectionReadSchema = CopilotHostSelectionSchema.nullable();

export const COPILOT_HANDOFF_PROTOCOL = 'canopy.copilot.handoff';
export const COPILOT_HANDOFF_BOUND_MS = 30_000;
export const CopilotHandoffCorrelationSchema = z.strictObject({
  incarnation: text,
  runId: text,
  requestId: z.number().int().positive(),
  operation: z.enum([
    'begin',
    'resume',
    'import',
    'cancel',
    'verify',
    'cleanup',
  ]),
  sourceFlavor: text,
  sourceMode: text,
  slot: z.literal('copilot-account'),
  binding: CopilotHandoffBindingSchema.nullable(),
  freezeId: text.nullable(),
});
export const CopilotHandoffFrameSchema = z.strictObject({
  protocol: z.literal(COPILOT_HANDOFF_PROTOCOL),
  version: z.literal(1),
  type: z.enum(['command', 'action', 'reply', 'terminal']),
  correlation: CopilotHandoffCorrelationSchema,
  payload: z.string().max(15_000),
});
export const CopilotHandoffWireSchema = z.strictObject({
  protocol: z.literal(COPILOT_HANDOFF_PROTOCOL),
  version: z.literal(1),
  type: CopilotHandoffFrameSchema.shape.type,
  payload: z.string().max(16_384),
});
export const CopilotHandoffEnvelopeSchema = z.strictObject({
  correlation: CopilotHandoffCorrelationSchema,
  payload: z.string().max(15_000),
});
export const CopilotHandoffCommandSchema = z.strictObject({
  kind: z.enum(['begin', 'resume', 'cancel', 'verify', 'cleanup']),
  sessionId: z.string().max(512),
  challenge: z.string().max(512),
  operation: z.string().max(512),
  purpose: z.string().max(512),
});
export const CopilotHandoffSuccessSchema = z.literal(true);
export const CopilotHandoffPreparedSchema = z.boolean();
export type CopilotHandoffFrame = z.infer<typeof CopilotHandoffFrameSchema>;
export type CopilotHandoffCorrelation = z.infer<
  typeof CopilotHandoffCorrelationSchema
>;
export type CopilotFreezeResult = z.infer<typeof CopilotFreezeResultSchema>;

export const CopilotCleanupFreezeSchema = z.strictObject({ freezeId: text });
export const CopilotCleanupResultSchema = z.enum([
  'done',
  'changed',
  'unavailable',
]);

export const CopilotHandoffPhaseSchema = z.enum([
  'invalid_unbound',
  'fenced_before_selection',
  'bound_pre_ingress',
  'ingress_accepted',
  'submitted_uncertain',
  'committed_unpublished',
  'host_confirmation_pending',
  'published',
  'cancelling_retired',
]);
export type CopilotHandoffPhase = z.infer<typeof CopilotHandoffPhaseSchema>;
type HandoffPath = 'unavailable' | 'recover' | 'cancel' | 'read' | 'vault';
type HandoffEntry =
  | 'connect'
  | 'disconnect'
  | 'change-account'
  | 'setup-cancel'
  | 'status'
  | 'startup'
  | 'open';
const pendingImportPaths = {
  connect: 'recover',
  disconnect: 'cancel',
  'change-account': 'cancel',
  'setup-cancel': 'cancel',
  status: 'read',
  startup: 'read',
  open: 'unavailable',
} as const;
/** Runtime admission and q-48 evidence share this dimension; no consumer DTO gains authority. */
export const COPILOT_VAULT_IMPORT_PATHS = {
  invalid_unbound: {
    connect: 'unavailable',
    disconnect: 'unavailable',
    'change-account': 'unavailable',
    'setup-cancel': 'unavailable',
    status: 'read',
    startup: 'read',
    open: 'unavailable',
  },
  fenced_before_selection: pendingImportPaths,
  bound_pre_ingress: pendingImportPaths,
  ingress_accepted: pendingImportPaths,
  submitted_uncertain: pendingImportPaths,
  committed_unpublished: pendingImportPaths,
  host_confirmation_pending: pendingImportPaths,
  published: {
    connect: 'vault',
    disconnect: 'cancel',
    'change-account': 'cancel',
    'setup-cancel': 'cancel',
    status: 'read',
    startup: 'read',
    open: 'vault',
  },
  cancelling_retired: { ...pendingImportPaths, connect: 'cancel' },
} satisfies Record<CopilotHandoffPhase, Record<HandoffEntry, HandoffPath>>;
