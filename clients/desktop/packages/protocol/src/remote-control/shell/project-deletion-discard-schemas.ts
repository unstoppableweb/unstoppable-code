import { z } from 'zod';
import type { ProjectDeletionDiscardDescription } from './project-deletion-discard';
import { WorktreeDiscardDescriptionSchema } from './worktree-discard-schemas';

/**
 * CAN-5337: parses the paired desktop's project deletion discard description
 * on the web. Loaded with the first refused deletion, never with a route.
 * Unknown fields are dropped so a newer desktop's additions don't fail an
 * older browser.
 */
export const ProjectDeletionDiscardDescriptionSchema: z.ZodType<ProjectDeletionDiscardDescription> =
  z.object({
    version: z.literal(1),
    workspaceId: z.string(),
    status: z.enum(['discardable', 'refused']),
    items: z
      .array(
        z.object({
          worktreeName: z.string().max(1024).optional(),
          description: WorktreeDiscardDescriptionSchema,
        }),
      )
      .max(500),
    pendingRecovery: z
      .array(
        z.object({
          operationId: z.string().uuid(),
          confirmation: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .max(500)
      .optional(),
    interruptedDeletion: z
      .object({ operationId: z.string().uuid() })
      .optional(),
  });
