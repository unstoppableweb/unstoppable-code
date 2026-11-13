import { z } from 'zod';
import type {
  WorktreeDiscardDescription,
  WorktreeDiscardResult,
} from './worktree-discard';

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
