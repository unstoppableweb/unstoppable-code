import { z } from 'zod';
import type {
  WorktreeArchiveResult,
  WorktreeDiscardDescription,
  WorktreeDiscardResult,
  WorktreeRemovalOutcome,
} from './worktree-discard';

import type {
  WorktreeRecoveryDescription,
  WorktreeRecoveryRequest,
} from './worktree-recovery';

export const WorktreeRecoveryRequestSchema: z.ZodType<WorktreeRecoveryRequest> =
  z.object({
    intent: z.enum(['archive', 'delete']),
    expectedCreatedAt: z.string().min(1).nullable(),
    operationId: z.string().uuid().optional(),
  });
const presence = z.enum(['unknown', 'absent', 'present']);
const verification = z.enum(['unknown', 'unverified', 'verified']);
const asset = z.object({
  presence: z.enum(['unknown', 'absent', 'present', 'partial']),
  verification,
  repositories: z
    .array(z.object({ repoId: z.string(), presence, verification }))
    .optional(),
});
const action = z.discriminatedUnion('eligible', [
  z.object({ eligible: z.literal(true) }),
  z.object({
    eligible: z.literal(false),
    reason: z.enum([
      'unavailable',
      'not-admitted',
      'other-incarnation',
      'future-capability',
    ]),
  }),
]);
export const WorktreeRecoveryDescriptionSchema: z.ZodType<WorktreeRecoveryDescription> =
  z
    .object({
      version: z.literal(1),
      diagnosis: z
        .object({
          operationId: z.string().uuid(),
          revision: z.string().regex(/^[a-f0-9]{64}$/),
          copies: z.number().int().positive(),
          slot: z.enum(['same-operation', 'other-operation', 'absent']),
          rawState: z.enum(['active', 'recovery-required', 'completed']),
          verdict: z.enum([
            'keep-worktree',
            'release',
            'finish-tail',
            'finish-journal',
            'retry',
            'cleanup-debt',
            'refused',
          ]),
          check: z.string(),
        })
        .optional(),
      code: z.enum([
        'external.worktree_recovery_required',
        'external.worktree_recovery_retryable',
        'external.worktree_recovery_cleanup',
        'external.worktree_recovery_unreadable',
      ]),
      intent: z.enum(['archive', 'delete']),
      subject: z.object({
        workspaceId: z.string(),
        worktreeId: z.string(),
        createdAt: z.string().nullable(),
      }),
      evidence: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('unknown') }),
        z.object({
          kind: z.literal('journal'),
          operation: z.enum([
            'workspace-delete',
            'worktree-archive',
            'worktree-delete',
          ]),
          operationId: z.string(),
          attribution: z.enum(['subject', 'other', 'unknown']),
        }),
      ]),
      stoppingPoint: z.object({
        phase: z.string(),
        state: z.enum(['pending', 'failed', 'between', 'unknown']),
      }),
      check: z.string(),
      retained: z.object({
        checkout: asset,
        stagedCopy: asset,
        gitSnapshot: asset,
        committedArchive: asset,
        chats: asset,
      }),
      actions: z.object({
        retry: action,
        finishArchive: action,
        discard: action,
        keepWorktree: action,
      }),
      destination: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('recovery') }),
        z.object({
          kind: z.literal('journal-review'),
          reason: z.enum(['unreadable-entry', 'directory-unreadable']),
        }),
      ]),
    })
    .refine(
      (description) =>
        description.actions.retry.eligible ===
        (description.code === 'external.worktree_recovery_retryable'),
      {
        message: 'Recovery code and retry eligibility must agree',
      },
    )
    .refine(
      (description) =>
        description.destination.kind !== 'journal-review' ||
        (description.code === 'external.worktree_recovery_unreadable' &&
          !description.actions.retry.eligible &&
          !description.actions.finishArchive.eligible &&
          !description.actions.discard.eligible),
      { message: 'Unreadable journal review cannot authorize removal actions' },
    );

/**
 * CAN-5336: parses the paired desktop's discard answers on the web. Loaded
 * with the first discard offer, never with a route. Unknown fields are
 * dropped so a newer desktop's additions don't fail an older browser.
 */

const causeSchema = z.enum([
  'stranded-removal-journal',
  'pending-checkout-quarantine',
  'source-gone',
  'interrupted-discard',
  'archive-recovery-unverified',
]);

const refusalSchema = z.enum([
  'not-found',
  'read-only-scope',
  'forbidden',
  'list-unreadable',
  'configuration-unreadable',
  'unsupported-workspace',
  'project-deletion-pending',
  'other-incarnation',
  'no-broken-removal',
  'retry-available',
  'source-unverified',
  'evidence-mismatch',
  'evidence-unreadable',
  'unverifiable-target',
  'retained-archive',
  'busy',
]);

const targetKindSchema = z.enum([
  'live-checkout',
  'git-quarantine',
  'files-only-recovery',
  'recreated-checkout-path',
  'retained-archive',
]);

const displayPathSchema = z.string().max(4096);

export const WorktreeDiscardDescriptionSchema: z.ZodType<WorktreeDiscardDescription> =
  z.object({
    version: z.literal(1),
    recovery: WorktreeRecoveryDescriptionSchema.optional(),
    workspaceId: z.string(),
    worktreeId: z.string(),
    createdAt: z.string(),
    status: z.enum(['discardable', 'refused']),
    causes: z.array(causeSchema),
    refusal: z
      .object({
        reason: refusalSchema,
        retry: z
          .enum(['remove-worktree', 'delete-project', 'finish-archive-cleanup'])
          .optional(),
      })
      .optional(),
    sources: z.array(
      z.object({
        repoId: z.string(),
        path: displayPathSchema,
        state: z.enum([
          'gone-absent',
          'gone-not-a-repository',
          'available',
          'unverified',
        ]),
      }),
    ),
    targets: z.array(
      z.object({
        kind: targetKindSchema,
        path: displayPathSchema,
        identity: z.string(),
        identityVerified: z.boolean(),
        reason: causeSchema,
        repositories: z
          .array(
            z.object({
              repoId: z.string(),
              relativePath: z.string(),
              uncommittedChanges: z
                .union([z.boolean(), z.literal('unknown')])
                .optional(),
            }),
          )
          .optional(),
      }),
    ),
    alsoDeleted: z.array(
      z.enum([
        'chats',
        'plans',
        'attachments',
        'cost-history',
        'retained-payload-copy',
      ]),
    ),
    preserved: z.array(z.enum(['source-working-files', 'branches'])),
    mayRemain: z.array(
      z.object({
        kind: z.enum(['git-registration', 'git-ref']),
        repoId: z.string(),
      }),
    ),
    verifyAtDiscard: z.literal('quarantine-against-snapshots').optional(),
    confirmation: z.string().min(1),
  });

export const WorktreeDiscardResultSchema: z.ZodType<WorktreeDiscardResult> =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('discarded'),
      removed: z.array(targetKindSchema),
      gitCleanup: z.array(
        z.object({
          repoId: z.string(),
          status: z.enum(['cleaned', 'skipped', 'failed']),
        }),
      ),
      warnings: z.array(z.string()),
      removedTemporaryWorkspaceId: z.string().optional(),
    }),
    z.object({
      status: z.literal('refused'),
      reason: z.union([refusalSchema, z.literal('changed')]),
      description: WorktreeDiscardDescriptionSchema,
    }),
  ]);

export const WorktreeArchiveResultSchema: z.ZodType<WorktreeArchiveResult> =
  z.union([
    z.void(),
    z.object({
      success: z.boolean(),
      warnings: z.array(z.string()),
      refusal: z
        .object({
          reason: z.string(),
          message: z.string(),
          discard: WorktreeDiscardDescriptionSchema,
          recovery: WorktreeRecoveryDescriptionSchema.optional(),
        })
        .optional(),
    }),
  ]);

const archiveAnswer = z.union([
  z.object({
    success: z.literal(false),
    refusal: z.object({
      reason: z.string(),
      message: z.string(),
      discard: WorktreeDiscardDescriptionSchema,
      recovery: WorktreeRecoveryDescriptionSchema.optional(),
    }),
  }),
  z.object({
    success: z.literal(true),
    warnings: z.array(z.string()),
    removedTemporaryWorkspaceId: z.string().optional(),
    refusal: z.never().optional(),
  }),
]);

export function worktreeRemovalOutcome(
  answer: unknown,
): WorktreeRemovalOutcome {
  const parsed = archiveAnswer.safeParse(answer);
  if (!parsed.success) return { status: 'unconfirmed' };
  if (!parsed.data.success)
    return { status: 'refused', refusal: parsed.data.refusal };
  return {
    status: 'completed',
    warnings: parsed.data.warnings,
    ...(parsed.data.removedTemporaryWorkspaceId
      ? { removedTemporaryWorkspaceId: parsed.data.removedTemporaryWorkspaceId }
      : {}),
  };
}
