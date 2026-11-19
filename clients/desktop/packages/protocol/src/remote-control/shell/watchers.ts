import { z } from 'zod';
import {
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
  GITHUB_WORKFLOW_RUN_CONCLUSIONS,
  GITHUB_WORKFLOW_JOB_CONCLUSIONS,
} from '../../github-workflows';

/** Sanitized progress is additive to the chat_watchers projection. */
export const REMOTE_CONTROL_CAPABILITY_WATCHED_GITHUB_ITEMS =
  'watched_github_items' as const;

const githubUrl = z
  .string()
  .max(2048)
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:actions\/runs\/[0-9]+(?:\/(?:attempts|job)\/[0-9]+)?|pull\/[0-9]+)$/,
  );
const repository = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const state = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('intermediate'),
    status: z.enum(GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES),
  }),
  z.object({
    kind: z.literal('terminal'),
    conclusion: z.enum(GITHUB_WORKFLOW_RUN_CONCLUSIONS),
  }),
  z.object({
    kind: z.literal('unsupported'),
    status: z.string().max(128).nullable(),
    conclusion: z.string().max(128).nullable(),
    terminal: z.boolean(),
  }),
]);

/** Only display fields, never workflow source paths, cursors or delivery state. */
export const RemoteControlGitHubRunProgressSchema = z.object({
  repository,
  runId: z.string().regex(/^[1-9][0-9]*$/),
  runAttempt: z.number().int().positive(),
  workflowName: z.string().max(512).optional(),
  runNumber: z.number().int().positive().optional(),
  htmlUrl: githubUrl,
  state,
  startedAt: z.string().optional(),
  observedAt: z.string(),
  tiers: z.array(z.array(z.string())).max(1000).optional(),
  jobs: z
    .array(
      z.object({
        jobId: z.string().min(1),
        tier: z.number().int().nonnegative().optional(),
        name: z.string().max(512),
        status: z.string().max(128),
        conclusion: z.enum(GITHUB_WORKFLOW_JOB_CONCLUSIONS).nullable(),
        htmlUrl: githubUrl,
        createdAt: z.string().optional(),
        startedAt: z.string().optional(),
        completedAt: z.string().optional(),
      }),
    )
    .max(1000)
    .optional(),
  // Display names and dependency edges preserve tiers and pending jobs on every client.
  definition: z
    .object({
      jobs: z
        .array(
          z.object({
            id: z.string().max(512),
            template: z.string().max(512),
            names: z.array(z.string().max(512)).max(500),
            needs: z.array(z.string().max(512)).max(200),
            dynamic: z.boolean(),
          }),
        )
        .max(200),
    })
    .optional(),
});
export type RemoteControlGitHubRunProgress = z.infer<
  typeof RemoteControlGitHubRunProgressSchema
>;

export const RemoteControlGitHubPullRequestProgressSchema = z.object({
  repository,
  number: z.number().int().positive(),
  title: z.string().max(512).optional(),
  url: githubUrl,
  additions: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  deletions: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  baseRefName: z.string().max(256),
  state: z.enum(['open', 'merged', 'closed']),
  queue: z
    .object({ position: z.number().int().positive().nullable() })
    .nullable(),
  observedAt: z.string(),
});
export type RemoteControlGitHubPullRequestProgress = z.infer<
  typeof RemoteControlGitHubPullRequestProgressSchema
>;

/** Additive Portal support. Clients hide watcher controls when absent. */
export const REMOTE_CONTROL_CAPABILITY_CHAT_WATCHERS = 'chat_watchers' as const;

const detailSchema = z.object({ label: z.string(), value: z.string() });

/** Display projection only. Target records and host execution state stay local. */
export const RemoteControlWatcherEntitySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  chatId: z.string().min(1),
  trigger: z.string().min(1),
  targetKind: z.string().min(1),
  status: z.enum(['active', 'delivery_failed', 'fired']),
  githubProgress: z
    .object({ runs: z.array(RemoteControlGitHubRunProgressSchema).max(20) })
    .optional(),
  githubPullRequestProgress: z
    .object({
      pullRequests: z
        .array(RemoteControlGitHubPullRequestProgressSchema)
        .max(20),
    })
    .optional(),
  createdAt: z.string(),
  followUpInstruction: z.string().optional(),
  deliveryError: z.string().optional(),
  display: z.object({
    title: z.string(),
    subtitle: z.string(),
    watching: z.string(),
    watchingSubtitle: z.string(),
    status: z.string(),
    details: z.array(detailSchema),
    ownerDelegate: z
      .object({ name: z.string(), detail: z.string().optional() })
      .optional(),
    github: z
      .object({
        subtitle: z.string(),
        filters: z.array(detailSchema),
        samples: z.array(z.string()).max(5),
        totalCount: z.number().int().nonnegative(),
      })
      .optional(),
  }),
});

export type RemoteControlWatcherEntity = z.infer<
  typeof RemoteControlWatcherEntitySchema
>;

export function parseRemoteControlWatcher(
  value: unknown,
): RemoteControlWatcherEntity | null {
  const parsed = RemoteControlWatcherEntitySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const RemoteControlWatcherDeletePayloadSchema = z
  .object({
    watcherId: z.string().min(1),
    notifySubscriber: z.boolean(),
  })
  .strict();
export type RemoteControlWatcherDeletePayload = z.infer<
  typeof RemoteControlWatcherDeletePayloadSchema
>;
