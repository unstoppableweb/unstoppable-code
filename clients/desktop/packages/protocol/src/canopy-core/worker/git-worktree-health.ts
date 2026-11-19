import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../common';
import { defineCanopyQuery, defineCanopyQueryRegistry } from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';
import { WORKER_GIT_GRANTS } from './git';

/**
 * Why a worktree or one of its repositories is broken: its directory is
 * missing, it has no `.git`, its Git metadata is incomplete or Git says it is
 * not a work tree, a configured repository's checkout is missing, Git could
 * not run, or the filesystem refused a read (permission or I/O error) so the
 * state is unknown.
 */
export const WORKER_GIT_WORKTREE_HEALTH_CODES = [
  'missing-worktree-path',
  'missing-git-metadata',
  'invalid-git-worktree',
  'missing-repository',
  'git-error',
  'unreadable',
] as const;

export type WorkerGitWorktreeHealthCode =
  (typeof WORKER_GIT_WORKTREE_HEALTH_CODES)[number];

export const WORKER_GIT_WORKTREE_HEALTH_ERROR_CODES = [
  'worker.git.worktree.invalidScope',
  'worker.git.worktree.scopeUnsupported',
] as const;

/** One worktree of one workspace, on the serving authority and target. */
export const WorkerGitWorktreeHealthScopeSchema =
  CanopyWorkspaceScopeSchema.pick({
    workspaceId: true,
    worktreeId: true,
    authorityId: true,
    targetId: true,
  }).required({ workspaceId: true, worktreeId: true });

export const WorkerGitWorktreeHealthGetParamsSchema = z.strictObject({
  scope: WorkerGitWorktreeHealthScopeSchema,
});

export type WorkerGitWorktreeHealthGetParams = z.output<
  typeof WorkerGitWorktreeHealthGetParamsSchema
>;

/** A repository of a multi-repository worktree, named by its workspace id. */
export const WorkerGitWorktreeRepositoryIssueSchema = z.strictObject({
  /**
   * A configured or present repository id; `__workspace_root__` is the root.
   * Unbounded: workspace configuration does not bound repository ids, and a
   * stored id must not turn a health answer into an invalid result.
   */
  repoId: z.string(),
  code: z.enum(WORKER_GIT_WORKTREE_HEALTH_CODES),
});

export const WorkerGitWorktreeHealthIssueSchema = z.strictObject({
  code: z.enum(WORKER_GIT_WORKTREE_HEALTH_CODES),
  checkedAt: z.iso.datetime({ offset: true }),
  /**
   * Each broken repository of a multi-repository worktree, in check order;
   * `null` for a single-repository worktree and for a missing worktree root.
   */
  repoIssues: z.array(WorkerGitWorktreeRepositoryIssueSchema).nullable(),
});

// Ids and codes only: worktree and repository paths, repository names,
// messages and Git output stay on the host for its compatibility projection.
export const WorkerGitWorktreeHealthGetResultSchema = z.discriminatedUnion(
  'healthy',
  [
    z.strictObject({ healthy: z.literal(true) }),
    z.strictObject({
      healthy: z.literal(false),
      issue: WorkerGitWorktreeHealthIssueSchema,
    }),
  ],
);

export type WorkerGitWorktreeHealthGetResult = z.output<
  typeof WorkerGitWorktreeHealthGetResultSchema
>;

export const WorkerGitWorktreeHealthGetErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(WORKER_GIT_WORKTREE_HEALTH_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('worker', {
    'worker.git.worktree.health.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitWorktreeHealthGetParamsSchema,
      result: WorkerGitWorktreeHealthGetResultSchema,
      error: WorkerGitWorktreeHealthGetErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_GIT_GRANTS.read],
    }),
  });
