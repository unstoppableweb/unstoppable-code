import { z } from 'zod';
import type { WorktreeRecoveryDescription } from './worktree-recovery';

const identity = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(200);
const reason = z.object({
  code: z.enum([
    'external.worktree_recovery_required',
    'external.worktree_recovery_retryable',
    'external.worktree_recovery_cleanup',
    'external.worktree_recovery_unreadable',
  ]),
  intent: z.enum(['archive', 'delete']),
  stoppingPoint: z.object({
    phase: z.string().max(100),
    state: z.enum(['pending', 'failed', 'between', 'unknown']),
  }),
});

/** Display context only: never a journal, host path or permission to remove. */
export const AutoDeleteAttentionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('worktree'),
    id: z.string().uuid(),
    workspaceId: identity,
    worktreeId: identity,
    createdAt: z.string().max(100),
    worktreeName: z.string().max(500),
    reason,
  }),
  z.object({
    // An unreadable global journal has no attributable owning worktree.
    kind: z.literal('journal-review'),
    id: z.string().uuid(),
    workspaceId: identity,
    review: z.enum(['unreadable-entry', 'directory-unreadable']),
    reason,
  }),
]);

export type AutoDeleteAttention = z.infer<typeof AutoDeleteAttentionSchema>;
export const AutoDeleteAttentionListSchema = z
  .array(AutoDeleteAttentionSchema)
  .max(100);
export type AutoDeleteAttentionReason = Pick<
  WorktreeRecoveryDescription,
  'code' | 'intent' | 'stoppingPoint'
>;
