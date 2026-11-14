import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import { CanopyErrorPayloadSchema } from '../../errors';

export const CoreW5MaintenanceDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('resolve-reservation'),
    reservationId: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal('retry-commit'),
    commitId: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('abandon-commit'),
    commitId: z.number().int().positive(),
  }),
]);
export const CoreW5MaintenanceRequestSchema = z.discriminatedUnion('mode', [
  z
    .object({
      source: z.literal('offline_maintenance'),
      mode: z.literal('diagnose'),
    })
    .strict(),
  z
    .object({
      source: z.literal('offline_maintenance'),
      mode: z.literal('reopen'),
    })
    .strict(),
  z
    .object({
      source: z.literal('offline_maintenance'),
      mode: z.literal('resolve'),
      decisions: z.array(CoreW5MaintenanceDecisionSchema).min(1).max(512),
    })
    .strict(),
  z
    .object({
      source: z.literal('offline_maintenance'),
      mode: z.literal('restore'),
      backupPath: z.string().regex(/^w5\/backups\/[a-z0-9-]+$/),
      unreadableOverride: z.string().max(16000).optional(),
    })
    .strict(),
]);
export const CoreW5DiagnosisSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      path: z.string(),
      reason: z.enum([
        'corrupt-file',
        'missing-file',
        'unknown-artifact',
        'log-mismatch',
        'untracked-file',
        'quarantined-journal',
      ]),
    }),
  ),
  destructiveJournalArtifactCount: z.number().int().nonnegative().nullable(),
  logIssue: z.enum(['unavailable', 'incompatible-schema']).nullable(),
  commits: z.array(
    z.strictObject({
      commitId: z.number().int().positive(),
      operation: z.string(),
      state: z.string(),
      diagnostics: z.string().nullable(),
      receiptOperations: z.array(z.string()),
    }),
  ),
  reservations: z.array(
    z.strictObject({
      reservationId: z.string(),
      operation: z.string(),
      state: z.string(),
      diagnostics: z.string(),
    }),
  ),
});
export const CoreW5MaintenanceDecisionResultSchema = z.strictObject({
  decision: CoreW5MaintenanceDecisionSchema,
  status: z.enum(['resolved', 'abandoned', 'applied', 'recovery-required']),
});
export const CoreW5MaintenanceResultSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('diagnose'),
    diagnosis: CoreW5DiagnosisSchema,
  }),
  z.strictObject({
    mode: z.literal('reopen'),
    diagnosis: CoreW5DiagnosisSchema,
  }),
  z.strictObject({
    mode: z.literal('restore'),
    commitId: z.number().int().positive(),
  }),
  z.strictObject({
    mode: z.literal('resolve'),
    results: z.array(CoreW5MaintenanceDecisionResultSchema),
    diagnosis: CoreW5DiagnosisSchema,
  }),
]);
export const CoreW5MaintenanceReplySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('recovery-required'),
    commitId: z.number().int().positive(),
  }),
  z.strictObject({
    state: z.literal('complete'),
    result: CoreW5MaintenanceResultSchema,
  }),
  z.strictObject({
    state: z.literal('refused'),
    reason: z.string().min(1).max(64),
    decision: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    state: z.literal('stopped'),
    reason: z.string().min(1).max(64),
    results: z.array(CoreW5MaintenanceDecisionResultSchema),
    diagnosis: CoreW5DiagnosisSchema.optional(),
  }),
]);
export type CoreW5MaintenanceRequest = z.infer<
  typeof CoreW5MaintenanceRequestSchema
>;
export type CoreW5MaintenanceReply = z.infer<
  typeof CoreW5MaintenanceReplySchema
>;
/** Private pre-serving control only; never installed on the published daemon endpoint. */
export const CORE_W5_RECOVERY_INSTRUCTIONS = defineCanopyInstructionRegistry(
  'core',
  {
    'core.workspaceRecovery.execute': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspaceRecovery',
      version: 1,
      placement: 'core-only',
      idempotency: 'none',
      requiredGrants: ['core.workspaceRecovery.maintain'],
      params: CoreW5MaintenanceRequestSchema,
      result: CoreW5MaintenanceReplySchema,
      error: CanopyErrorPayloadSchema.extend({
        code: z.literal('core.workspaceRecovery.refused').optional(),
      }),
    }),
  },
);
