import { z } from 'zod';
import worldJson from './fixtures/world.json';

const idSchema = z.string().min(1);

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
