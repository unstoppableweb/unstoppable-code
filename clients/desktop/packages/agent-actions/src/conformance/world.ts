import { z } from 'zod';
import worldJson from './fixtures/world.json';

const idSchema = z.string().min(1);

const pullRequestStatusSchema = z.strictObject({
  url: z.string().min(1),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  isDraft: z.boolean(),
  headBranch: z.string(),
  baseBranch: z.string(),
  headSha: z.string(),
  headRepository: z.string().nullable(),
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  reviewDecision: z
    .enum(['approved', 'changes_requested', 'review_required'])
    .nullable(),
  checks: z.strictObject({
    state: z.enum(['success', 'failure', 'pending', 'none']),
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failedNames: z.array(z.string()),
    available: z.boolean(),
  }),
  mergeQueue: z.strictObject({
    inQueue: z.boolean(),
    position: z.number().int().positive().nullable(),
  }),
});

const conformanceWorldSchema = z.strictObject({
  brand: z.strictObject({
    displayName: z.string().min(1),
    toolNamespace: z.string().min(1),
  }),
  workspace: z.strictObject({
    workspaceId: idSchema,
    name: z.string().min(1),
    kind: z.enum(['git', 'cowork']),
    repositories: z.array(
      z.strictObject({
        repoId: idSchema,
        remoteUrl: z.string().min(1),
        defaultBranch: z.string().nullable(),
      }),
    ),
  }),
  worktrees: z.array(
    z.strictObject({
      worktreeId: idSchema,
      name: z.string(),
      branch: idSchema,
    }),
  ),
  chats: z.array(
    z.strictObject({
      chatId: idSchema,
      worktreeId: idSchema,
      title: z.string(),
      state: z.enum(['idle', 'running', 'archived']),
      modelId: idSchema,
      lastResponse: z.string().nullable(),
    }),
  ),
  chatHistory: z.array(
    z.strictObject({
      chatId: idSchema,
      matchId: z.string().uuid(),
      date: z.string().datetime(),
      text: z.string(),
    }),
  ),
  models: z.array(
    z.strictObject({
      id: idSchema,
      label: z.string(),
      provider: z.enum(['claude', 'codex']),
      thinkingLevels: z.array(z.enum(['off', 'medium', 'high'])),
    }),
  ),
  transcript: z.strictObject({
    target: z.strictObject({
      kind: z.literal('delegation'),
      chatId: idSchema,
      delegationId: idSchema,
      runGeneration: z.number().int().positive(),
    }),
    pageSize: z.number().int().positive(),
    blockPageSize: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    rows: z.array(
      z.strictObject({
        id: idSchema,
        role: z.enum(['user', 'assistant', 'system']),
        timestamp: z.number(),
        blocks: z.array(
          z.strictObject({
            type: z.enum(['text', 'thinking']),
            text: z.string(),
          }),
        ),
      }),
    ),
  }),
  /**
   * GitHub.com pull requests the signed-in owner can read, with the status
   * each host must return (without `fetchedAt`, which the host stamps), and
   * one the owner cannot see.
   */
  pullRequests: z.strictObject({
    readable: z.array(
      z.strictObject({
        repository: z.string().min(1),
        number: z.number().int().positive(),
        status: pullRequestStatusSchema,
      }),
    ),
    inaccessible: z.strictObject({
      repository: z.string().min(1),
      number: z.number().int().positive(),
    }),
  }),
  defaultModelId: idSchema,
  /** The signed-in account's current organization memberships. */
  organizations: z
    .array(
      z.strictObject({
        organizationId: idSchema,
        name: z.string().min(1),
      }),
    )
    .min(1),
  /**
   * A workspace the calling chat must never reach, and an organization the
   * signed-in account does not belong to.
   */
  foreign: z.strictObject({
    workspaceId: idSchema,
    worktreeId: idSchema,
    chatId: idSchema,
    organizationId: idSchema,
  }),
  current: z.strictObject({
    workspaceId: idSchema,
    worktreeId: idSchema,
    chatId: idSchema,
  }),
  callerDepth: z.number().int().nonnegative(),
});

/** The neutral world every conformance host seeds before the suite runs. */
export type ConformanceWorld = z.output<typeof conformanceWorldSchema>;

export function loadConformanceWorld(): ConformanceWorld {
  return conformanceWorldSchema.parse(worldJson);
}
