import { z } from 'zod';

/** Explicit rewrite counters, not normalization writes or a durable receipt. */
export const McpRefRewriteResultSchema = z.strictObject({
  globalDefaults: z.boolean(),
  workspaces: z.number().int().nonnegative(),
  chats: z.number().int().nonnegative(),
  retired: z.enum(['removed', 'changed']).optional(),
});
export type McpRefRewriteResult = z.output<typeof McpRefRewriteResultSchema>;

export type McpRefRewritePhase =
  | 'rewrite'
  | 'validation'
  | 'retirementGuard'
  | 'globalDefaults'
  | 'workspaceEnumeration'
  | 'workspaceRead'
  | 'workspaceDefaults'
  | 'normalization'
  | 'manifestCommit'
  | 'scopeEnumeration'
  | 'chatRewrite'
  | 'removalPreflight'
  | 'removalRevalidation'
  | 'retirementRead'
  | 'tokenClear'
  | 'serverUnlink'
  | 'indexUpdate'
  | 'result';

export type McpRefRewriteCode =
  | 'invalidRef'
  | 'retireNotRewritten'
  | 'rewriteIncomplete'
  | 'rewriteFailed'
  | 'retirementFailed'
  | 'removalRefused';
