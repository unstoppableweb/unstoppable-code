import { z } from 'zod';

const deviceServerId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-f0-9-]+$/);
const documentState = z.enum([
  'valid',
  'absent',
  'malformed',
  'unsupported',
  'unreadable',
]);
/** Persisted device-uninstall pointer; the backend receipt owns stage truth. */
export const McpRemovalRecoverySchema = z
  .object({
    version: z.literal(1),
    recoveryId: z.string().uuid(),
  })
  .strict();
export type McpRemovalRecovery = z.infer<typeof McpRemovalRecoverySchema>;

const recoveryStage = z
  .object({
    recoveryId: z.string().uuid(),
    custody: z.boolean(),
    credentials: z.boolean(),
    index: z.enum(['pending', 'unresolved', 'complete']),
  })
  .strict();

/** Read-only discovery; candidates are hints, never destructive authority. */
export const McpRemovalCandidatesRequestSchema = z.object({}).strict();
export const McpRemovalCandidatesResultSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            serverId: deviceServerId,
            pendingUninstall: z.boolean(),
          })
          .strict(),
      )
      .max(256),
    incomplete: z.boolean(),
  })
  .strict();
export type McpRemovalCandidatesResult = z.infer<
  typeof McpRemovalCandidatesResultSchema
>;

export const InspectMcpRemovalRequestSchema = z
  .object({
    serverId: deviceServerId,
  })
  .strict();

export const InspectMcpRemovalResultSchema = z
  .object({
    serverId: deviceServerId,
    target: z.enum([...documentState.options, 'unexpected']),
    index: documentState,
    inspectedState: z.string().uuid(),
    scope: z.enum(['preserve-evidence', 'unavailable']),
    recoveries: z.array(recoveryStage).max(128),
  })
  .strict();

/** Exact device target; this operation cannot remove an account connection. */
export const ForceMcpRemovalRequestSchema = z
  .object({
    serverId: deviceServerId,
    mode: z.literal('preserve-evidence'),
    finishUninstall: z.literal(true).optional(),
    inspectedState: z.string().uuid().optional(),
    recoveryId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.inspectedState === undefined) !==
        (value.recoveryId === undefined) &&
      (!value.finishUninstall || value.recoveryId !== undefined),
    { message: 'Supply exactly one inspected state or recovery id.' },
  );

export const ForceMcpRemovalResultSchema = z
  .object({
    serverId: deviceServerId,
    status: z.enum(['refused', 'pending', 'unknown', 'unresolved', 'complete']),
    recoveryId: z.string().uuid().optional(),
    custody: z.boolean(),
    credentials: z.boolean(),
    index: z.enum(['pending', 'unresolved', 'complete']),
    uninstall: z.enum(['complete', 'pending']).optional(),
    code: z
      .enum([
        'authorization_required',
        'state_changed',
        'previous_removal_pending',
        'custody_failed',
        'credentials_failed',
        'index_failed',
        'index_unresolved',
      ])
      .optional(),
  })
  .strict();

export type InspectMcpRemovalRequest = z.infer<
  typeof InspectMcpRemovalRequestSchema
>;
export type InspectMcpRemovalResult = z.infer<
  typeof InspectMcpRemovalResultSchema
>;
export type ForceMcpRemovalRequest = z.infer<
  typeof ForceMcpRemovalRequestSchema
>;
export type ForceMcpRemovalResult = z.infer<typeof ForceMcpRemovalResultSchema>;
