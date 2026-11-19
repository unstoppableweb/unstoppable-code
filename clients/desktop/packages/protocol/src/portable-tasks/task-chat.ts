import { API_PIPELINE_TRIGGER_TYPES } from '../pipelines';
import { z } from 'zod';
import { externalAgentSenderSchema } from '../remote-control/shell/external-agent-sender';
import {
  normalizeSidebarItemGroupName,
  SIDEBAR_ITEM_GROUP_NAME_LIMIT,
} from '../sidebar/sidebar-item-groups';
import { THINKING_LEVELS } from '../thinking';
import { parseTaskPullRequestReference } from './pull-request-reference';

const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const TaskId = UUID.describe('Identifier for a task, not a chat.');
const ChatId = UUID.describe('Identifier for a chat within a task.');
const IsoDateTime = z.iso.datetime();
const Host = z.union([
  z.literal('linux-managed'),
  z.string().regex(/^[0-9abcdefghjkmnpqrstvwxyz]{10}$/u),
]);
const ReadSource = z.enum(['cached', 'live']);
const observationKindSchema = z.enum([
  'authority',
  'server_held',
  'host_rebuilt',
  'host_rpc',
  'host_cache',
  'relay_registry',
]);
const taskChatReadMetadataShape = {
  source: ReadSource,
  observationKind: observationKindSchema,
  observedAt: IsoDateTime.nullable(),
  repliedAt: IsoDateTime.nullable(),
};

const portableObservationKindSchema = z.enum([
  'authority',
  'server_held',
  'desktop_rebuilt',
  'desktop_rpc',
  'desktop_cache',
  'relay_registry',
]);

export const readMetadataShape = {
  source: ReadSource,
  observationKind: portableObservationKindSchema,
  observedAt: IsoDateTime.nullable(),
  repliedAt: IsoDateTime.nullable(),
};

export const taskTurnStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_for_input',
  'waiting_for_approval',
  'complete',
  'failed',
  'cancelled',
]);
const taskEnvironmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('cloud_sandbox'),
    sandboxId: UUID.nullable(),
  }),
  z.strictObject({
    kind: z.literal('remote_worktree'),
    remoteId: UUID,
    worktreeId: UUID,
    branch: z.string().max(255).nullable(),
  }),
  z.strictObject({ kind: z.literal('remote_no_repository'), remoteId: UUID }),
]);

export const questionSchema = z
  .strictObject({
    questionId: UUID,
    prompt: z.string().min(1).max(8000),
    options: z
      .array(
        z.strictObject({
          optionIndex: z.number().int().min(0).max(99),
          label: z.string().min(1).max(500),
        }),
      )
      .max(100),
    allowOther: z.boolean(),
    multiSelect: z.boolean(),
  })
  .refine(
    ({ options }) =>
      new Set(options.map(({ optionIndex }) => optionIndex)).size ===
      options.length,
    { path: ['options'], message: 'optionIndex values must be unique' },
  );
export type Question = z.infer<typeof questionSchema>;

export const turnSummarySchema = z.strictObject({
  turnId: UUID,
  status: taskTurnStatusSchema,
  startedAt: IsoDateTime.nullable(),
  finalMessageSummary: z.string().max(2000).nullable(),
  outcome: z.enum(['complete', 'failed', 'cancelled']).nullable(),
  endedAt: IsoDateTime.nullable(),
  environment: taskEnvironmentSchema.nullable(),
});
export type TurnSummary = z.infer<typeof turnSummarySchema>;

const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/);
const activityStateSchema = z.enum(['blocked', 'active', 'idle']);
const activityAspectStateSchema = z.enum(['blocked', 'active', 'idle']);
const taskLifecycleSchema = z.enum(['active', 'archived', 'deleted']);
const chatLifecycleSchema = z.enum(['active', 'archived']);
const taskSetupSchema = z.enum(['pending', 'ready', 'failed']).nullable();
const nonnegativeCountSchema = z.number().int().min(0);

const portableErrorSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
});

export const taskReceiptSchema = z.strictObject({
  receiptId: UUID,
  operation: z.enum([
    'project_create',
    'project_update',
    'create',
    'send',
    'respond',
    'cancel',
    'archive',
  ]),
  projectId: UUID.nullable(),
  taskId: UUID.nullable(),
  messageId: UUID.nullable(),
  turnId: UUID.nullable(),
  status: z.enum(['accepted', 'completed', 'failed']),
  delivery: z.enum(['accepted', 'queued', 'steering']).optional(),
  createdAt: IsoDateTime,
  observedAt: IsoDateTime.nullable(),
  error: portableErrorSchema.nullable(),
});
export type TaskReceipt = z.infer<typeof taskReceiptSchema>;

export const projectSummarySchema = z
  .strictObject({
    projectId: UUID,
    // Null only for a remote project with no owner organization.
    organizationId: UUID.nullable(),
    remoteId: UUID.nullable(),
    name: z.string().min(1).max(160),
    status: z.enum(['active', 'archived']).nullable(),
    /**
     * Whether tasks run in repository worktrees or with no repository; null
     * when unknown. It decides which task environments a project accepts.
     * Results stored before the field existed parse as null.
     */
    kind: z.enum(['repository', 'no_repository']).nullable().default(null),
    observedAt: IsoDateTime.nullable(),
    source: ReadSource,
  })
  .refine(
    ({ remoteId, organizationId }) =>
      remoteId !== null || organizationId !== null,
    {
      path: ['organizationId'],
      message: 'organizationId is required for cloud projects',
    },
  );
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectPageSchema = z.strictObject({
  items: z.array(projectSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});

export const projectGetResultSchema = z.strictObject({
  project: projectSummarySchema,
  ...readMetadataShape,
});

export const remoteConnectionSchema = z.enum([
  'active',
  'reconnecting',
  'inactive',
]);
export type RemoteConnection = z.infer<typeof remoteConnectionSchema>;

export const remoteSummarySchema = z.strictObject({
  remoteId: UUID,
  /** Omitted unless the person lets this agent see device names. */
  name: z.string().min(1).max(120).optional(),
  /** Omitted unless the person lets this agent see device names. */
  hostname: z.string().max(255).nullable().optional(),
  appVersion: z.string().max(64).nullable(),
  connection: remoteConnectionSchema,
  observedAt: IsoDateTime.nullable(),
  lastSeenAt: IsoDateTime.nullable(),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
  writable: z.boolean(),
});
export type RemoteSummary = z.infer<typeof remoteSummarySchema>;

export const remotePageSchema = z.strictObject({
  items: z.array(remoteSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});
export type RemotePage = z.infer<typeof remotePageSchema>;

export const remoteGetResultSchema = z.strictObject({
  remote: remoteSummarySchema,
  ...readMetadataShape,
});
export type RemoteGetResult = z.infer<typeof remoteGetResultSchema>;

export const projectCreateInputSchema = z.strictObject({
  organizationId: UUID,
  name: z.string().min(1).max(160),
  idempotencyKey: idempotencyKeySchema,
  repositoryId: UUID.optional(),
  baseBranch: z.string().min(1).max(255).optional(),
});
export type ProjectCreateInput = z.infer<typeof projectCreateInputSchema>;

export const projectCreateResultSchema = z.strictObject({
  project: projectSummarySchema,
  receipt: taskReceiptSchema,
  ...readMetadataShape,
});
export type ProjectCreateResult = z.infer<typeof projectCreateResultSchema>;

export const projectUpdateInputSchema = z
  .strictObject({
    organizationId: UUID,
    projectId: UUID,
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine(
    ({ name, description }) => name !== undefined || description !== undefined,
    {
      message: 'at least one project field must be provided',
    },
  );
export type ProjectUpdateInput = z.infer<typeof projectUpdateInputSchema>;

export const projectUpdateResultSchema = z.strictObject({
  project: projectSummarySchema,
  receipt: taskReceiptSchema,
});
export type ProjectUpdateResult = z.infer<typeof projectUpdateResultSchema>;

export const fileSummarySchema = z.strictObject({
  fileId: UUID,
  name: z.string().min(1).max(255),
  kind: z.enum(['file', 'directory']),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  observedAt: IsoDateTime.nullable(),
});
export type FileSummary = z.infer<typeof fileSummarySchema>;

export const filePageSchema = z.strictObject({
  items: z.array(fileSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});

export const fileReadResultSchema = z
  .strictObject({
    fileId: UUID,
    content: z.string(),
    truncated: z.boolean(),
    ...readMetadataShape,
  })
  .refine(({ content }) => new TextEncoder().encode(content).length <= 49152, {
    path: ['content'],
    message: 'content must be at most 49152 UTF-8 bytes',
  });

function withinUtf8Bytes(limit: number) {
  return (value: string): boolean =>
    new TextEncoder().encode(value).length <= limit;
}

export const planSummarySchema = z.strictObject({
  planId: UUID,
  projectId: UUID,
  worktreeId: UUID,
  title: z.string().min(1).max(300),
  status: z.string().min(1).max(64),
  reviewStatus: z.string().min(1).max(64).nullable(),
  updatedAt: IsoDateTime.nullable(),
});
export type PlanSummary = z.infer<typeof planSummarySchema>;

export const planPageSchema = z.strictObject({
  items: z.array(planSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});

export const planDetailSchema = planSummarySchema.extend({
  content: z.string().refine(withinUtf8Bytes(49152), {
    message: 'content must be at most 49152 UTF-8 bytes',
  }),
  truncated: z.boolean(),
  revisionNumber: z.number().int().min(0).nullable(),
  approvedAt: IsoDateTime.nullable(),
  dismissedAt: IsoDateTime.nullable(),
});
export type PlanDetail = z.infer<typeof planDetailSchema>;

export const planGetResultSchema = z.strictObject({
  plan: planDetailSchema,
  ...readMetadataShape,
});

export const diffSourceSchema = z.enum([
  'uncommitted',
  'committed',
  'combined',
]);
export type DiffSource = z.infer<typeof diffSourceSchema>;

export const diffFileSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  previousPath: z.string().min(1).max(1024).nullable(),
  status: z.string().min(1).max(32),
  insertions: z.number().int().min(0).nullable(),
  deletions: z.number().int().min(0).nullable(),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const diffResultSchema = z.strictObject({
  projectId: UUID,
  worktreeId: UUID,
  diffSource: diffSourceSchema,
  files: z.array(diffFileSchema).max(200),
  filesTruncated: z.boolean(),
  patch: z.string().refine(withinUtf8Bytes(32768), {
    message: 'patch must be at most 32768 UTF-8 bytes',
  }),
  patchTruncated: z.boolean(),
  rangeLabel: z.string().max(255).nullable(),
  ...readMetadataShape,
});
export type DiffResult = z.infer<typeof diffResultSchema>;

export const pullRequestSummarySchema = z.strictObject({
  number: z.number().int().positive().nullable(),
  url: z.url().max(2048).nullable(),
  title: z.string().max(300).nullable(),
  state: z.string().max(32).nullable(),
  baseBranch: z.string().max(255).nullable(),
  headBranch: z.string().max(255).nullable(),
  checkStatus: z
    .enum(['passing', 'failing', 'pending', 'neutral', 'none'])
    .nullable(),
  reviewStatus: z
    .enum(['approved', 'changes-requested', 'pending', 'none'])
    .nullable(),
  hasConflicts: z.boolean().nullable(),
  mergeReady: z.boolean().nullable(),
  commentCount: z.number().int().min(0).nullable(),
  updatedAt: IsoDateTime.nullable(),
});
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

export const pullRequestResultSchema = z.strictObject({
  projectId: UUID,
  worktreeId: UUID,
  // Null when the worktree has no pull request.
  pullRequest: pullRequestSummarySchema.nullable(),
  ...readMetadataShape,
});
export type PullRequestResult = z.infer<typeof pullRequestResultSchema>;

export const pipelineRunRefSchema = z.strictObject({
  runId: UUID,
  status: z.string().min(1).max(32),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});
export type PipelineRunRef = z.infer<typeof pipelineRunRefSchema>;

export const pipelineSummarySchema = z.strictObject({
  pipelineId: UUID,
  projectId: UUID,
  // The worktree the desktop listed from, even when the caller named none.
  worktreeId: UUID,
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable(),
  origin: z.enum(['bundled', 'user', 'project', 'shared']).nullable(),
  triggerTypes: z
    .array(z.enum(API_PIPELINE_TRIGGER_TYPES))
    .max(API_PIPELINE_TRIGGER_TYPES.length),
  // Only known when the call names a worktree.
  latestRun: pipelineRunRefSchema.nullable(),
});
export type PipelineSummary = z.infer<typeof pipelineSummarySchema>;

export const pipelinePageSchema = z.strictObject({
  items: z.array(pipelineSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});

export const pipelineRunSchema = z.strictObject({
  runId: UUID,
  pipelineId: UUID,
  projectId: UUID,
  worktreeId: UUID,
  pipelineName: z.string().min(1).max(200).nullable(),
  status: z.string().min(1).max(32),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  progress: z
    .strictObject({
      completedSteps: z.number().int().min(0),
      totalSteps: z.number().int().min(0),
    })
    .nullable(),
  outputTail: z
    .string()
    .refine(withinUtf8Bytes(8192), {
      message: 'outputTail must be at most 8192 UTF-8 bytes',
    })
    .nullable(),
  outputTruncated: z.boolean(),
});
export type PipelineRun = z.infer<typeof pipelineRunSchema>;

export const pipelineRunGetResultSchema = z.strictObject({
  run: pipelineRunSchema,
  ...readMetadataShape,
});

export const remoteInventoryKindSchema = z.enum([
  'plugin',
  'skill',
  'collection',
  'mcp_server',
]);
export type RemoteInventoryKind = z.infer<typeof remoteInventoryKindSchema>;

export const remoteInventoryItemSchema = z.strictObject({
  itemId: UUID,
  kind: remoteInventoryKindSchema,
  name: z.string().min(1).max(255),
  version: z.string().max(128).nullable(),
});
export type RemoteInventoryItem = z.infer<typeof remoteInventoryItemSchema>;

export const remoteInventoryResultSchema = z.strictObject({
  items: z.array(remoteInventoryItemSchema).max(100),
  nextCursor: UUID.nullable(),
  ...readMetadataShape,
});
export type RemoteInventoryResult = z.infer<typeof remoteInventoryResultSchema>;

export const receiptSchema = z
  .strictObject({
    receiptId: UUID,
    operation: z.enum([
      'task_create',
      'task_update',
      'task_delete',
      'task_chat_create',
      'task_chat_send',
      'task_chat_queue_update',
      'task_chat_update',
      'task_chat_cancel',
      'task_chat_respond',
      'task_chat_archive',
      'task_hook_pause_set',
    ]),
    projectId: UUID.nullable(),
    taskId: TaskId.nullable(),
    chatId: ChatId.nullable(),
    messageId: UUID.nullable(),
    turnId: UUID.nullable(),
    queuedMessageId: UUID.nullable(),
    status: z.enum(['accepted', 'completed', 'failed']),
    delivery: z
      .enum(['started', 'queued', 'steered', 'interrupting'])
      .optional(),
    createdAt: IsoDateTime,
    observedAt: IsoDateTime.nullable(),
    error: portableErrorSchema.nullable(),
  })
  .refine(
    ({ operation, delivery }) =>
      delivery === undefined ||
      operation === 'task_chat_send' ||
      operation === 'task_chat_queue_update',
    {
      path: ['delivery'],
      message: 'receipt delivery is only reported for send or queue update',
    },
  );
export type Receipt = z.infer<typeof receiptSchema>;

const groupSummarySchema = z.strictObject({
  name: z.string().min(1).max(128),
  color: z.string().min(1).max(64),
});

const chatCountsSchema = z
  .strictObject({
    total: nonnegativeCountSchema,
    active: nonnegativeCountSchema,
    blocked: nonnegativeCountSchema,
  })
  .refine(({ total, active, blocked }) => active + blocked <= total, {
    path: ['active'],
    message: 'active and blocked chats cannot exceed total chats',
  });

const activityAgentSchema = z.strictObject({
  state: activityAspectStateSchema,
  blockedOn: z.enum(['question', 'approval', 'plan_review']).optional(),
  queued: nonnegativeCountSchema,
});

const activityBackgroundSchema = z.strictObject({
  state: activityAspectStateSchema,
  agents: nonnegativeCountSchema,
  tasks: nonnegativeCountSchema,
  workflows: nonnegativeCountSchema.optional(),
  blockedOn: z.literal('workflow_paused').optional(),
});

const activityWatchersSchema = z.strictObject({
  state: z.enum(['active', 'idle']),
  count: nonnegativeCountSchema,
});

const activityScheduledSchema = z.strictObject({
  state: z.enum(['active', 'idle']),
  count: nonnegativeCountSchema,
  nextAt: IsoDateTime.optional(),
});

export const activitySchema = z
  .strictObject({
    status: activityStateSchema,
    agent: activityAgentSchema.optional(),
    background: activityBackgroundSchema.optional(),
    watchers: activityWatchersSchema.optional(),
    scheduled: activityScheduledSchema.optional(),
  })
  .superRefine((activity, context) => {
    const blocked =
      activity.agent?.state === 'blocked' ||
      activity.background?.state === 'blocked';
    const active =
      activity.agent?.state === 'active' ||
      activity.background?.state === 'active' ||
      activity.watchers?.state === 'active' ||
      activity.scheduled?.state === 'active';
    const expectedStatus = blocked ? 'blocked' : active ? 'active' : 'idle';

    if (activity.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'status must reflect the reported activity aspects',
      });
    }

    const background = activity.background;
    if (background !== undefined) {
      const hasWork =
        background.agents + background.tasks + (background.workflows ?? 0) > 0;
      const expectedBackgroundState =
        background.blockedOn === 'workflow_paused'
          ? 'blocked'
          : hasWork
            ? 'active'
            : 'idle';
      if (background.state !== expectedBackgroundState) {
        context.addIssue({
          code: 'custom',
          path: ['background', 'state'],
          message: 'background state must reflect its counts and blockedOn',
        });
      }
    }

    if (
      activity.watchers !== undefined &&
      activity.watchers.state !==
        (activity.watchers.count > 0 ? 'active' : 'idle')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['watchers', 'state'],
        message: 'watchers state must reflect its count',
      });
    }

    if (
      activity.scheduled !== undefined &&
      activity.scheduled.state !==
        (activity.scheduled.count > 0 ? 'active' : 'idle')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scheduled', 'state'],
        message: 'scheduled state must reflect its count',
      });
    }

    if (
      activity.scheduled?.count === 0 &&
      activity.scheduled.nextAt !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scheduled', 'nextAt'],
        message: 'nextAt requires at least one scheduled message',
      });
    }
  });
export type Activity = z.infer<typeof activitySchema>;

export const taskSummarySchema = z
  .strictObject({
    host: Host,
    taskId: TaskId,
    projectId: UUID,
    organizationId: UUID.nullable(),
    kind: z.enum(['worktree', 'work_entry']),
    title: z.string().min(1).max(256),
    branch: z.string().min(1).max(255).optional(),
    baseBranch: z.string().min(1).max(255).optional(),
    group: groupSummarySchema.nullable(),
    hidden: z.boolean(),
    setup: taskSetupSchema,
    lifecycle: taskLifecycleSchema,
    activity: activitySchema,
    chats: chatCountsSchema,
    createdAt: IsoDateTime,
    lastActivityAt: IsoDateTime.nullable(),
    links: z.strictObject({
      taskUrl: z.string().max(2048).startsWith('https://').nullable(),
    }),
    source: ReadSource,
    observedAt: IsoDateTime.nullable(),
  })
  .superRefine((task, context) => {
    if (task.kind === 'work_entry') {
      if (task.hidden) {
        context.addIssue({
          code: 'custom',
          path: ['hidden'],
          message: 'work entries cannot be hidden',
        });
      }
      if (task.setup !== null) {
        context.addIssue({
          code: 'custom',
          path: ['setup'],
          message: 'work entries do not have setup state',
        });
      }
      if (task.branch !== undefined || task.baseBranch !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['branch'],
          message: 'branch fields apply only to worktree tasks',
        });
      }
    } else if (task.setup === null) {
      context.addIssue({
        code: 'custom',
        path: ['setup'],
        message: 'worktree tasks require setup state',
      });
    }

    if (
      task.setup === 'pending' &&
      task.activity.agent?.state !== 'active' &&
      task.activity.agent?.state !== 'blocked'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activity', 'agent', 'state'],
        message: 'pending setup requires active or blocked agent activity',
      });
    }
  });
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const chatSettingsSchema = z.strictObject({
  model: z.string().min(1).max(128).optional(),
  auto: z.literal(true).optional(),
  providerType: z.string().min(1).max(64).optional(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  speed: z.enum(['standard', 'fast', 'ultrafast']).optional(),
  planMode: z.boolean().optional(),
  plugins: z.array(UUID).max(100).optional(),
});
export type ChatSettings = z.infer<typeof chatSettingsSchema>;

export const chatSettingsWriteInputSchema = chatSettingsSchema.refine(
  ({ model, providerType }) =>
    providerType === undefined || model !== undefined,
  {
    path: ['model'],
    message: 'Name a model when choosing its provider.',
  },
);
export type ChatSettingsWriteInput = z.infer<
  typeof chatSettingsWriteInputSchema
>;

export const taskOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), userId: UUID }),
  externalAgentSenderSchema,
  z.strictObject({
    kind: z.literal('automation'),
    name: z.string().min(1).max(64),
  }),
]);
export type TaskOrigin = z.infer<typeof taskOriginSchema>;

export const chatSummarySchema = z
  .strictObject({
    host: Host,
    taskId: TaskId,
    chatId: ChatId,
    title: z.string().min(1).max(256),
    activity: activitySchema,
    pendingQuestion: questionSchema.nullable(),
    lastTurn: turnSummarySchema.nullable(),
    lifecycle: chatLifecycleSchema,
    origin: taskOriginSchema,
    settings: chatSettingsSchema,
    steering: z.strictObject({
      steer: z.boolean(),
      interrupt: z.boolean(),
    }),
    source: ReadSource,
    observedAt: IsoDateTime.nullable(),
  })
  .superRefine((chat, context) => {
    if (
      chat.activity.background?.workflows !== undefined ||
      chat.activity.background?.blockedOn === 'workflow_paused'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activity', 'background'],
        message: 'workflow activity belongs on task summaries',
      });
    }
  });
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const queueItemSchema = z.strictObject({
  queuedMessageId: UUID,
  preview: z
    .string()
    .max(2000)
    .refine((preview) => !/\p{Cc}/u.test(preview), {
      message: 'preview must not contain control characters',
    }),
  state: z.enum(['queued', 'steering', 'editing']),
  origin: z.enum([
    'person',
    'this_connection',
    'agent',
    'watcher',
    'automation',
  ]),
  canSteer: z.boolean(),
  waitingReason: z
    .enum(['turn', 'setup', 'steer_unavailable', 'background_work'])
    .optional(),
  enqueuedAt: IsoDateTime,
});
export type QueueItem = z.infer<typeof queueItemSchema>;

const groupInputSchema = z.strictObject({
  // Hosts store normalized names, so a result can only echo a normalized one.
  name: z
    .string()
    .min(1)
    .max(128)
    .refine((name) => normalizeSidebarItemGroupName(name) === name, {
      message: `group name must not start or end with spaces and must be at most ${SIDEBAR_ITEM_GROUP_NAME_LIMIT} characters`,
    }),
  color: z.string().min(1).max(64).optional(),
});

const branchTargetSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((target) => !/\s/u.test(target), {
    message: 'branch target must not contain whitespace',
  });

const EXPLICIT_BRANCH_TARGET_RE = /^(?:local|remote):(.*)$/u;

// An explicit local:/remote: prefix names the namespace and does not count
// toward the branch-name limit. Bare targets keep the legacy contract. `:`
// cannot occur in a Git branch name, so a prefix needs a name after it.
const createBranchTargetSchema = z.union([
  branchTargetSchema.refine(
    (target) => !EXPLICIT_BRANCH_TARGET_RE.test(target),
  ),
  z.string().refine((target) => {
    const name = EXPLICIT_BRANCH_TARGET_RE.exec(target)?.[1];
    return (
      name !== undefined &&
      !name.includes(':') &&
      branchTargetSchema.safeParse(name).success
    );
  }),
]);

function isSupportedPullRequestTarget(target: string): boolean {
  if (target !== target.trim()) return false;
  if (/^#?\d+$/u.test(target)) return /^#?[1-9]\d{0,9}$/u.test(target);
  return parseTaskPullRequestReference(target) !== null;
}

const pullRequestTargetSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isSupportedPullRequestTarget, {
    message:
      'target must be a positive PR number, repository reference, or HTTPS pull request URL',
  });

export const fromSchema = z.union([
  z.strictObject({ kind: z.literal('default') }),
  z.strictObject({
    kind: z.literal('branch'),
    target: createBranchTargetSchema,
  }),
  z.strictObject({
    kind: z.literal('base_branch'),
    target: createBranchTargetSchema,
  }),
  z.strictObject({ kind: z.literal('pr'), target: pullRequestTargetSchema }),
  z.strictObject({
    kind: z.literal('base_pr'),
    target: pullRequestTargetSchema,
  }),
]);
export type From = z.infer<typeof fromSchema>;

const taskListLimit = z.number().int().min(1).max(50).default(50);
const chatListLimit = z.number().int().min(1).max(50).default(50);
const cursorSchema = UUID.optional();
const toolCursorSchema = z.string().min(1).max(2048);
const noCacheSchema = z.boolean().optional();
const fieldResultStatusSchema = z.enum(['applied', 'failed']);
const responseOptionIndexesSchema = z
  .array(z.number().int().min(0).max(99))
  .max(100)
  .refine((indexes) => new Set(indexes).size === indexes.length, {
    message: 'selectedOptionIndexes must be distinct',
  });

export const taskListInputSchema = z.strictObject({
  organizationId: UUID.optional(),
  projectId: UUID.optional(),
  group: z.string().min(1).max(128).nullable().optional(),
  setup: taskSetupSchema.optional(),
  lifecycle: z.enum(['active', 'archived']).optional(),
  origin: z.enum(['this_connection', 'all']).optional(),
  limit: taskListLimit,
  cursor: cursorSchema,
  noCache: noCacheSchema,
});
export type TaskListInput = z.infer<typeof taskListInputSchema>;

export const taskListResultSchema = z.strictObject({
  host: Host,
  items: z.array(taskSummarySchema).max(50),
  nextCursor: UUID.nullable(),
});
export type TaskListResult = z.infer<typeof taskListResultSchema>;

export const taskGetInputSchema = z.strictObject({
  organizationId: UUID.optional(),
  taskId: TaskId,
  noCache: noCacheSchema,
});
export type TaskGetInput = z.infer<typeof taskGetInputSchema>;

export const taskGetResultSchema = z.strictObject({
  host: Host,
  task: taskSummarySchema,
  chats: z.array(chatSummarySchema).max(50),
  chatsTruncated: z.boolean(),
});
export type TaskGetResult = z.infer<typeof taskGetResultSchema>;

export const taskWaitInputSchema = z.strictObject({
  organizationId: UUID.optional(),
  taskId: TaskId,
  until: z.enum(['change', 'idle', 'agent_idle']).default('change'),
  timeoutSeconds: z.number().int().min(1).max(25).default(25),
});
export type TaskWaitInput = z.infer<typeof taskWaitInputSchema>;

export const taskWaitResultSchema = z.strictObject({
  host: Host,
  task: taskSummarySchema,
  changed: z.boolean(),
  timedOut: z.boolean(),
});
export type TaskWaitResult = z.infer<typeof taskWaitResultSchema>;

export const taskHookSummarySchema = z.strictObject({
  hookKey: z.string().min(1).max(4096),
  name: z.string().min(1).max(2048),
  trigger: z.string().min(1).max(2048),
  paused: z.boolean(),
  runDisabledReason: z.string().min(1).max(2048).optional(),
});
export type TaskHookSummary = z.infer<typeof taskHookSummarySchema>;

export const taskHookListInputSchema = z.strictObject({
  host: Host,
  organizationId: UUID.optional(),
  taskId: TaskId,
  noCache: noCacheSchema,
});
export type TaskHookListInput = z.infer<typeof taskHookListInputSchema>;

export const taskHookListResultSchema = z.strictObject({
  host: Host,
  hooks: z.array(taskHookSummarySchema),
});
export type TaskHookListResult = z.infer<typeof taskHookListResultSchema>;

export const taskHookPauseSetInputSchema = z
  .strictObject({
    host: Host,
    organizationId: UUID.optional(),
    taskId: TaskId,
    idempotencyKey: idempotencyKeySchema,
    paused: z.boolean(),
    hookKey: z.string().min(1).max(4096).optional(),
    all: z.literal(true).optional(),
  })
  .refine(({ hookKey, all }) => (hookKey !== undefined) !== (all === true), {
    path: ['hookKey'],
    message: 'provide exactly one of hookKey or all: true',
  });
export type TaskHookPauseSetInput = z.infer<typeof taskHookPauseSetInputSchema>;

export const taskHookPauseSetResultSchema = z
  .strictObject({
    host: Host,
    hooks: z.array(taskHookSummarySchema),
    receipt: receiptSchema.safeExtend({
      operation: z.literal('task_hook_pause_set'),
    }),
  })
  .superRefine(({ receipt }, context) => {
    if (receipt.taskId === null || receipt.chatId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['receipt'],
        message: 'task hook pause receipt must name only its task',
      });
    }
  });
export type TaskHookPauseSetResult = z.infer<
  typeof taskHookPauseSetResultSchema
>;

export const taskHookPauseSetResultSchemaForInput = (
  input: TaskHookPauseSetInput,
): typeof taskHookPauseSetResultSchema =>
  taskHookPauseSetResultSchema.superRefine(({ host, receipt }, context) => {
    if (host !== input.host) {
      context.addIssue({
        code: 'custom',
        path: ['host'],
        message: 'result host must match the request',
      });
    }
    if (receipt.taskId !== input.taskId) {
      context.addIssue({
        code: 'custom',
        path: ['receipt', 'taskId'],
        message: 'receipt task id must match the request',
      });
    }
  });

export const taskUpdateFieldOrder: readonly [
  'title',
  'group',
  'hidden',
  'baseBranch',
] = ['title', 'group', 'hidden', 'baseBranch'];

const taskUpdateFieldsSchema = z
  .strictObject({
    title: fieldResultStatusSchema.optional(),
    group: fieldResultStatusSchema.optional(),
    hidden: fieldResultStatusSchema.optional(),
    baseBranch: fieldResultStatusSchema.optional(),
  })
  .refine(
    (fields) => Object.values(fields).some((value) => value !== undefined),
    {
      message: 'at least one task field result is required',
    },
  );

export const taskUpdateInputSchema = z
  .strictObject({
    organizationId: UUID.optional(),
    taskId: TaskId,
    idempotencyKey: idempotencyKeySchema,
    title: z.string().min(1).max(256).nullable().optional(),
    group: groupInputSchema.nullable().optional(),
    hidden: z.boolean().optional(),
    baseBranch: branchTargetSchema.optional(),
  })
  .refine(
    ({ title, group, hidden, baseBranch }) =>
      title !== undefined ||
      group !== undefined ||
      hidden !== undefined ||
      baseBranch !== undefined,
    { message: 'at least one task field must be provided' },
  );
export type TaskUpdateInput = z.infer<typeof taskUpdateInputSchema>;

export const taskUpdateResultSchema = z
  .strictObject({
    host: Host,
    task: taskSummarySchema,
    fields: taskUpdateFieldsSchema,
    receipt: receiptSchema.safeExtend({
      operation: z.literal('task_update'),
    }),
  })
  .superRefine(({ receipt }, context) => {
    if (receipt.taskId === null || receipt.chatId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['receipt'],
        message: 'task update receipt must name only its task',
      });
    }
  });
export type TaskUpdateResult = z.infer<typeof taskUpdateResultSchema>;

/** Use at the route boundary so fields name exactly the attempted task updates. */
export const taskUpdateResultSchemaForInput = (
  input: TaskUpdateInput,
): typeof taskUpdateResultSchema =>
  taskUpdateResultSchema.superRefine(({ task, fields, receipt }, context) => {
    const requestedFields = taskUpdateFieldOrder.filter(
      (field) => input[field] !== undefined,
    );
    const returnedFields = taskUpdateFieldOrder.filter(
      (field) => fields[field] !== undefined,
    );

    if (task.taskId !== input.taskId) {
      context.addIssue({
        code: 'custom',
        path: ['task', 'taskId'],
        message: 'result task id must match the request',
      });
    }
    if (receipt.taskId !== input.taskId) {
      context.addIssue({
        code: 'custom',
        path: ['receipt', 'taskId'],
        message: 'receipt task id must match the request',
      });
    }
    if (
      requestedFields.length !== returnedFields.length ||
      requestedFields.some((field, index) => field !== returnedFields[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'field results must match the requested task fields',
      });
    }
  });

export const projectGroupListInputSchema = z.strictObject({
  projectId: UUID,
});
export type ProjectGroupListInput = z.infer<typeof projectGroupListInputSchema>;

export const projectGroupListResultSchema = z.strictObject({
  host: Host,
  groups: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(128),
        color: z.string().min(1).max(64),
        taskCount: nonnegativeCountSchema,
      }),
    )
    .max(100),
});
export type ProjectGroupListResult = z.infer<
  typeof projectGroupListResultSchema
>;

const taskCreateRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('branch'),
    target: createBranchTargetSchema,
    name: branchTargetSchema,
    local: z.boolean(),
    remote: z.boolean(),
    isDefault: z.boolean(),
    checkedOut: z.boolean(),
    existingTaskId: TaskId.optional(),
  }),
  z.strictObject({
    kind: z.literal('pr'),
    target: z
      .string()
      .min(1)
      .max(512)
      .regex(/^(?:#[1-9]\d*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*)$/u),
    number: z.number().int().positive(),
    title: z.string().max(300),
    headBranch: branchTargetSchema,
    baseBranch: branchTargetSchema,
    draft: z.boolean(),
    updatedAt: IsoDateTime,
    checkedOut: z.boolean(),
    existingTaskId: TaskId.optional(),
  }),
]);

export const taskCreateRefListInputSchema = z.strictObject({
  projectId: UUID,
  kind: z.enum(['branch', 'pr']).optional(),
  query: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: toolCursorSchema.optional(),
});
export type TaskCreateRefListInput = z.infer<
  typeof taskCreateRefListInputSchema
>;

export const taskCreateRefListResultSchema = z.strictObject({
  host: Host,
  items: z.array(taskCreateRefSchema).max(100),
  nextCursor: toolCursorSchema.nullable(),
  source: ReadSource,
  observedAt: IsoDateTime.nullable(),
});
export type TaskCreateRefListResult = z.infer<
  typeof taskCreateRefListResultSchema
>;

export const taskCreateInputSchema = z.strictObject({
  organizationId: UUID.optional(),
  projectId: UUID,
  idempotencyKey: idempotencyKeySchema,
  title: z.string().min(1).max(256).optional(),
  group: groupInputSchema.optional(),
  from: fromSchema.optional(),
  chat: z
    .strictObject({
      prompt: z.string().min(1).max(20000),
      settings: chatSettingsWriteInputSchema.optional(),
    })
    .optional(),
});
export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>;

export const taskCreateResultSchema = z
  .strictObject({
    host: Host,
    taskId: TaskId,
    chatId: ChatId.nullable(),
    setup: taskSetupSchema,
    delivery: z.enum(['started', 'queued']).optional(),
    group: z
      .strictObject({
        name: z.string().min(1).max(128),
        outcome: z.enum(['applied', 'failed']),
      })
      .optional(),
    receipt: receiptSchema.safeExtend({ operation: z.literal('task_create') }),
  })
  .superRefine(({ taskId, chatId, delivery, receipt }, context) => {
    if (chatId === null && delivery !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['delivery'],
        message: 'delivery requires an initial chat',
      });
    }
    if (receipt.taskId !== taskId || receipt.chatId !== chatId) {
      context.addIssue({
        code: 'custom',
        path: ['receipt'],
        message: 'receipt task and chat ids must match the result',
      });
    }
  });
export type TaskCreateResult = z.infer<typeof taskCreateResultSchema>;

/** Bind create output to its request; routes must use this to validate group outcomes and receipt scope. */
export const taskCreateResultSchemaForInput = (
  input: TaskCreateInput,
): typeof taskCreateResultSchema =>
  taskCreateResultSchema.superRefine(({ group, receipt }, context) => {
    if (receipt.projectId !== input.projectId) {
      context.addIssue({
        code: 'custom',
        path: ['receipt', 'projectId'],
        message: 'receipt project id must match the request',
      });
    }
    if (input.group === undefined) {
      if (group !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['group'],
          message: 'group outcome requires a requested group',
        });
      }
    } else if (group === undefined || group.name !== input.group.name) {
      context.addIssue({
        code: 'custom',
        path: ['group'],
        message: 'group outcome must match the requested group',
      });
    }
  });

export const taskDeleteInputSchema = z.strictObject({
  organizationId: UUID.optional(),
  taskId: TaskId,
  idempotencyKey: idempotencyKeySchema,
  archive: z.boolean().default(true),
});
export type TaskDeleteInput = z.infer<typeof taskDeleteInputSchema>;

export const taskDeleteResultSchema = z.strictObject({
  host: Host,
  taskId: TaskId,
  lifecycle: z.enum(['archived', 'deleted']),
  receipt: receiptSchema.safeExtend({ operation: z.literal('task_delete') }),
});
export type TaskDeleteResult = z.infer<typeof taskDeleteResultSchema>;

export const taskChatListInputSchema = z.strictObject({
  taskId: TaskId,
  lifecycle: chatLifecycleSchema.optional(),
  limit: chatListLimit,
  cursor: cursorSchema,
});
export type TaskChatListInput = z.infer<typeof taskChatListInputSchema>;

export const taskChatListResultSchema = z.strictObject({
  host: Host,
  items: z.array(chatSummarySchema).max(50),
  nextCursor: UUID.nullable(),
});
export type TaskChatListResult = z.infer<typeof taskChatListResultSchema>;

export const taskChatGetInputSchema = z.strictObject({
  taskId: TaskId,
  chatId: ChatId,
  noCache: noCacheSchema,
});
export type TaskChatGetInput = z.infer<typeof taskChatGetInputSchema>;

export const taskChatGetResultSchema = z.strictObject({
  host: Host,
  chat: chatSummarySchema,
  queue: z.array(queueItemSchema).max(100),
});
export type TaskChatGetResult = z.infer<typeof taskChatGetResultSchema>;

export const taskChatCreateInputSchema = z.strictObject({
  taskId: TaskId,
  idempotencyKey: idempotencyKeySchema,
  prompt: z.string().min(1).max(20000).optional(),
  settings: chatSettingsWriteInputSchema.optional(),
});
export type TaskChatCreateInput = z.infer<typeof taskChatCreateInputSchema>;

export const taskChatCreateResultSchema = z.strictObject({
  host: Host,
  taskId: TaskId,
  chatId: ChatId,
  delivery: z.enum(['started', 'queued']).optional(),
  receipt: receiptSchema.safeExtend({
    operation: z.literal('task_chat_create'),
  }),
});
export type TaskChatCreateResult = z.infer<typeof taskChatCreateResultSchema>;

const taskChatUpdateSettingsInputSchema = chatSettingsWriteInputSchema.refine(
  (settings) => Object.values(settings).some((value) => value !== undefined),
  { message: 'at least one chat setting must be provided' },
);

export const taskChatUpdateInputSchema = z.strictObject({
  taskId: TaskId,
  chatId: ChatId,
  idempotencyKey: idempotencyKeySchema,
  settings: taskChatUpdateSettingsInputSchema,
});
export type TaskChatUpdateInput = z.infer<typeof taskChatUpdateInputSchema>;

const taskChatUpdateFieldsSchema = z
  .strictObject({
    model: fieldResultStatusSchema.optional(),
    auto: fieldResultStatusSchema.optional(),
    providerType: fieldResultStatusSchema.optional(),
    thinkingLevel: fieldResultStatusSchema.optional(),
    speed: fieldResultStatusSchema.optional(),
    planMode: fieldResultStatusSchema.optional(),
    plugins: fieldResultStatusSchema.optional(),
  })
  .refine(
    (fields) => Object.values(fields).some((value) => value !== undefined),
    {
      message: 'at least one chat field result is required',
    },
  );

export const taskChatUpdateResultSchema = z
  .strictObject({
    host: Host,
    chat: chatSummarySchema,
    fields: taskChatUpdateFieldsSchema,
    receipt: receiptSchema.safeExtend({
      operation: z.literal('task_chat_update'),
    }),
  })
  .superRefine(({ receipt }, context) => {
    if (receipt.taskId === null || receipt.chatId === null) {
      context.addIssue({
        code: 'custom',
        path: ['receipt'],
        message: 'chat update receipt must name its task and chat',
      });
    }
  });
export type TaskChatUpdateResult = z.infer<typeof taskChatUpdateResultSchema>;

/** Use at the route boundary so fields name exactly the attempted settings. */
export const taskChatUpdateResultSchemaForInput = (
  input: TaskChatUpdateInput,
): typeof taskChatUpdateResultSchema =>
  taskChatUpdateResultSchema.superRefine(
    ({ chat, fields, receipt }, context) => {
      const requestedFields = Object.entries(input.settings)
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field);
      const returnedFields = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([field]) => field);

      if (chat.taskId !== input.taskId) {
        context.addIssue({
          code: 'custom',
          path: ['chat', 'taskId'],
          message: 'result task id must match the request',
        });
      }
      if (chat.chatId !== input.chatId) {
        context.addIssue({
          code: 'custom',
          path: ['chat', 'chatId'],
          message: 'result chat id must match the request',
        });
      }
      if (receipt.taskId !== input.taskId || receipt.chatId !== input.chatId) {
        context.addIssue({
          code: 'custom',
          path: ['receipt'],
          message: 'receipt task and chat ids must match the request',
        });
      }
      if (
        requestedFields.length !== returnedFields.length ||
        requestedFields.some((field) => !returnedFields.includes(field))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['fields'],
          message: 'field results must match the requested chat settings',
        });
      }
    },
  );

export const taskChatPluginsListInputSchema = z.strictObject({
  taskId: TaskId,
  chatId: ChatId,
  query: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: toolCursorSchema.optional(),
});
export type TaskChatPluginsListInput = z.infer<
  typeof taskChatPluginsListInputSchema
>;

export const taskChatPluginsListResultSchema = z.strictObject({
  host: Host,
  items: z
    .array(
      z.strictObject({
        itemId: UUID,
        kind: remoteInventoryKindSchema,
        name: z.string().min(1).max(255),
        selected: z.boolean(),
        available: z.boolean(),
        unavailableReason: z.string().min(1).max(500).optional(),
      }),
    )
    .max(100),
  nextCursor: toolCursorSchema.nullable(),
});
export type TaskChatPluginsListResult = z.infer<
  typeof taskChatPluginsListResultSchema
>;

const steerRefusalSchema = z.strictObject({
  code: z.enum([
    'steering-unavailable',
    'delivery-backlog',
    'turn-ended',
    'handoff-interrupted',
    'not-correlated',
    'session-not-steerable',
    'not-steerable',
    'no-active-turn',
    'turn-id-mismatch',
    'compact-turn',
    'review-turn',
    'output-schema-mismatch',
    'empty-expected-turn-id',
    'empty-input',
  ]),
  summary: z.string().min(1).max(500),
});

export const taskChatSendInputSchema = z.strictObject({
  taskId: TaskId,
  chatId: ChatId,
  idempotencyKey: idempotencyKeySchema,
  text: z.string().min(1).max(20000),
  delivery: z.enum(['queue', 'steer', 'interrupt']).default('queue'),
  settings: chatSettingsWriteInputSchema.optional(),
});
export type TaskChatSendInput = z.infer<typeof taskChatSendInputSchema>;

export const taskChatSendResultSchema = z
  .strictObject({
    host: Host,
    taskId: TaskId,
    chatId: ChatId,
    delivery: z.enum(['started', 'queued', 'steered', 'interrupting']),
    messageId: UUID,
    queuedMessageId: UUID.optional(),
    steerRefusal: steerRefusalSchema.optional(),
    receipt: receiptSchema.safeExtend({
      operation: z.literal('task_chat_send'),
    }),
  })
  .superRefine((result, context) => {
    if (result.delivery === 'queued' && result.queuedMessageId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['queuedMessageId'],
        message: 'queued delivery requires queuedMessageId',
      });
    }
    if (result.steerRefusal !== undefined && result.delivery !== 'queued') {
      context.addIssue({
        code: 'custom',
        path: ['steerRefusal'],
        message: 'steer refusal requires queued delivery',
      });
    }
  });
export type TaskChatSendResult = z.infer<typeof taskChatSendResultSchema>;

export const taskChatQueueUpdateInputSchema = z
  .strictObject({
    taskId: TaskId,
    chatId: ChatId,
    queuedMessageId: UUID,
    idempotencyKey: idempotencyKeySchema,
    action: z.enum(['steer', 'interrupt', 'cancel', 'edit']),
    text: z.string().min(1).max(20000).optional(),
  })
  .refine(({ action, text }) => action !== 'edit' || text !== undefined, {
    path: ['text'],
    message: 'text is required when action is edit',
  });
export type TaskChatQueueUpdateInput = z.infer<
  typeof taskChatQueueUpdateInputSchema
>;

export const taskChatQueueUpdateResultSchema = z
  .strictObject({
    host: Host,
    outcome: z.enum([
      'steered',
      'interrupting',
      'cancelled',
      'edited',
      'queued',
    ]),
    steerRefusal: steerRefusalSchema.optional(),
    receipt: receiptSchema.safeExtend({
      operation: z.literal('task_chat_queue_update'),
    }),
  })
  .refine(
    ({ outcome, steerRefusal }) =>
      steerRefusal === undefined || outcome === 'queued',
    {
      path: ['steerRefusal'],
      message: 'steer refusal requires queued outcome',
    },
  );
export type TaskChatQueueUpdateResult = z.infer<
  typeof taskChatQueueUpdateResultSchema
>;

const chatMessageSchema = z
  .strictObject({
    kind: z.enum(['message', 'tool_call']),
    messageId: UUID,
    turnId: UUID.nullable(),
    role: z.enum(['user', 'agent']),
    text: z.string().max(20000),
    createdAt: IsoDateTime.nullable(),
    toolCall: z
      .strictObject({
        name: z.string().min(1).max(128),
        status: z.enum(['running', 'complete', 'failed']),
        argumentsSummary: z.string().max(2000).nullable(),
        resultSummary: z.string().max(2000).nullable(),
      })
      .nullable(),
    truncated: z.boolean(),
    provenance: externalAgentSenderSchema.nullable(),
  })
  .refine(
    ({ kind, toolCall }) => (kind === 'tool_call') === (toolCall !== null),
    {
      path: ['toolCall'],
      message: 'toolCall must be present exactly for tool_call messages',
    },
  );
export const taskChatMessageSchema = chatMessageSchema;
export type TaskChatMessage = z.infer<typeof taskChatMessageSchema>;

export const taskChatMessagesInputSchema = z.strictObject({
  organizationId: UUID.optional(),
  taskId: TaskId,
  chatId: ChatId,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: cursorSchema,
  noCache: noCacheSchema,
});
export type TaskChatMessagesInput = z.infer<typeof taskChatMessagesInputSchema>;

export const taskChatMessagesResultSchema = z.strictObject({
  host: Host,
  items: z.array(taskChatMessageSchema).max(100),
  nextCursor: UUID.nullable(),
  ...taskChatReadMetadataShape,
});
export type TaskChatMessagesResult = z.infer<
  typeof taskChatMessagesResultSchema
>;

export const taskChatWaitInputSchema = z.strictObject({
  taskId: TaskId,
  chatId: ChatId,
  afterTurnId: UUID.optional(),
  until: z.enum(['change', 'idle', 'agent_idle']).default('change'),
  timeoutSeconds: z.number().int().min(1).max(25).default(25),
});
export type TaskChatWaitInput = z.infer<typeof taskChatWaitInputSchema>;

export const taskChatWaitResultSchema = z.strictObject({
  host: Host,
  chat: chatSummarySchema,
  changed: z.boolean(),
  timedOut: z.boolean(),
});
export type TaskChatWaitResult = z.infer<typeof taskChatWaitResultSchema>;

export const taskChatCancelInputSchema = z.strictObject({
  taskId: TaskId,
  chatId: ChatId,
  turnId: UUID,
  idempotencyKey: idempotencyKeySchema,
});
export type TaskChatCancelInput = z.infer<typeof taskChatCancelInputSchema>;

export const taskChatCancelResultSchema = z.strictObject({
  host: Host,
  outcome: z.enum(['stop_requested', 'turn_not_active']),
  stopRequested: z.boolean(),
  turnStatus: z.enum([
    'queued',
    'running',
    'waiting_for_input',
    'waiting_for_approval',
    'idle',
    'failed',
    'stopped',
    'archived',
  ]),
  receipt: receiptSchema.safeExtend({
    operation: z.literal('task_chat_cancel'),
  }),
});
export type TaskChatCancelResult = z.infer<typeof taskChatCancelResultSchema>;

export const taskChatRespondInputSchema = z
  .strictObject({
    taskId: TaskId,
    chatId: ChatId,
    questionId: UUID,
    idempotencyKey: idempotencyKeySchema,
    selectedOptionIndexes: responseOptionIndexesSchema,
    freeformText: z.string().max(8000).nullable(),
  })
  .refine(
    ({ selectedOptionIndexes, freeformText }) =>
      selectedOptionIndexes.length > 0 ||
      (freeformText !== null && freeformText.trim().length > 0),
    {
      path: ['freeformText'],
      message: 'provide a selected option or freeform answer',
    },
  );
export type TaskChatRespondInput = z.infer<typeof taskChatRespondInputSchema>;

export const taskChatRespondResultSchema = z.strictObject({
  host: Host,
  receipt: receiptSchema.safeExtend({
    operation: z.literal('task_chat_respond'),
  }),
});
export type TaskChatRespondResult = z.infer<typeof taskChatRespondResultSchema>;

export const taskChatArchiveInputSchema = z.strictObject({
  taskId: TaskId,
  chatId: ChatId,
  idempotencyKey: idempotencyKeySchema,
});
export type TaskChatArchiveInput = z.infer<typeof taskChatArchiveInputSchema>;

export const taskChatArchiveResultSchema = z.strictObject({
  host: Host,
  chatId: ChatId,
  lifecycle: z.literal('archived'),
  receipt: receiptSchema.safeExtend({
    operation: z.literal('task_chat_archive'),
  }),
});
export type TaskChatArchiveResult = z.infer<typeof taskChatArchiveResultSchema>;

export const taskChatDeliverableListInputSchema = z.strictObject({
  taskId: TaskId,
  chatId: ChatId,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: cursorSchema,
});
export type TaskChatDeliverableListInput = z.infer<
  typeof taskChatDeliverableListInputSchema
>;

export const deliverableSummarySchema = z.strictObject({
  deliverableId: UUID,
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: IsoDateTime,
});
export type DeliverableSummary = z.infer<typeof deliverableSummarySchema>;

export const taskChatDeliverableListResultSchema = z.strictObject({
  host: Host,
  items: z.array(deliverableSummarySchema).max(100),
  nextCursor: UUID.nullable(),
  ...taskChatReadMetadataShape,
});
export type TaskChatDeliverableListResult = z.infer<
  typeof taskChatDeliverableListResultSchema
>;

export const taskChatDeliverableGetInputSchema = z.strictObject({
  taskId: TaskId,
  chatId: ChatId,
  deliverableId: UUID,
  maxBytes: z.number().int().min(1).max(49152).default(32768),
});
export type TaskChatDeliverableGetInput = z.infer<
  typeof taskChatDeliverableGetInputSchema
>;

export const taskChatDeliverableGetResultSchema = z.strictObject({
  host: Host,
  deliverable: z.strictObject({
    deliverableId: UUID,
    filename: z.string().min(1).max(255).nullable(),
    mediaType: z.string().min(1).max(255).nullable(),
    sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  }),
  content: z.string().max(49152).nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
  ...taskChatReadMetadataShape,
});
export type TaskChatDeliverableGetResult = z.infer<
  typeof taskChatDeliverableGetResultSchema
>;

const projectOrTaskScope = {
  projectId: UUID.optional(),
  taskId: TaskId.optional(),
};

function hasExactlyOneScope(scope: {
  projectId?: string;
  taskId?: string;
}): boolean {
  return (scope.projectId === undefined) !== (scope.taskId === undefined);
}

const exactlyOneScopeMessage = 'Provide exactly one of projectId or taskId.';

export const planListInputSchema = z.strictObject({
  taskId: TaskId,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: cursorSchema,
  noCache: z.boolean().default(false),
});
export type PlanListInput = z.infer<typeof planListInputSchema>;
export const planListResultSchema = planPageSchema;
export type PlanListResult = z.infer<typeof planListResultSchema>;

export const planGetInputSchema = z.strictObject({
  taskId: TaskId,
  planId: UUID,
  noCache: z.boolean().default(false),
});
export type PlanGetInput = z.infer<typeof planGetInputSchema>;
export type PlanGetResult = z.infer<typeof planGetResultSchema>;

export const pipelineListInputSchema = z
  .strictObject({
    ...projectOrTaskScope,
    limit: z.number().int().min(1).max(100).default(50),
    cursor: cursorSchema,
    noCache: z.boolean().default(false),
  })
  .refine(hasExactlyOneScope, {
    path: ['taskId'],
    message: exactlyOneScopeMessage,
  });
export type PipelineListInput = z.infer<typeof pipelineListInputSchema>;
export const pipelineListResultSchema = pipelinePageSchema;
export type PipelineListResult = z.infer<typeof pipelineListResultSchema>;

export const pipelineRunGetInputSchema = z.strictObject({
  runId: UUID,
  noCache: z.boolean().default(false),
});
export type PipelineRunGetInput = z.infer<typeof pipelineRunGetInputSchema>;
export type PipelineRunGetResult = z.infer<typeof pipelineRunGetResultSchema>;

export const fileListInputSchema = z
  .strictObject({
    organizationId: UUID.optional(),
    ...projectOrTaskScope,
    parentFileId: UUID.nullable().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: cursorSchema,
    noCache: noCacheSchema,
  })
  .refine(hasExactlyOneScope, {
    path: ['taskId'],
    message: exactlyOneScopeMessage,
  });
export type FileListInput = z.infer<typeof fileListInputSchema>;
export const fileListResultSchema = filePageSchema;
export type FileListResult = z.infer<typeof fileListResultSchema>;

export const fileReadInputSchema = z
  .strictObject({
    organizationId: UUID.optional(),
    ...projectOrTaskScope,
    fileId: UUID,
    maxBytes: z.number().int().min(1).max(49152).default(32768),
    noCache: noCacheSchema,
  })
  .refine(hasExactlyOneScope, {
    path: ['taskId'],
    message: exactlyOneScopeMessage,
  });
export type FileReadInput = z.infer<typeof fileReadInputSchema>;
export type FileReadResult = z.infer<typeof fileReadResultSchema>;

export const taskDiffGetInputSchema = z.strictObject({
  taskId: TaskId,
  diffSource: z
    .enum(['uncommitted', 'committed', 'combined'])
    .default('combined'),
  noCache: z.boolean().default(false),
});
export type TaskDiffGetInput = z.infer<typeof taskDiffGetInputSchema>;
export const taskDiffGetResultSchema = diffResultSchema;
export type TaskDiffGetResult = z.infer<typeof taskDiffGetResultSchema>;

export const taskPullRequestGetInputSchema = z.strictObject({
  taskId: TaskId,
  noCache: z.boolean().default(false),
});
export type TaskPullRequestGetInput = z.infer<
  typeof taskPullRequestGetInputSchema
>;
export const taskPullRequestGetResultSchema = pullRequestResultSchema;
export type TaskPullRequestGetResult = z.infer<
  typeof taskPullRequestGetResultSchema
>;
