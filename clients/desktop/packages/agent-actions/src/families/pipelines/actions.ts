import { z } from 'zod';

export const PIPELINES_ACTION_TYPES = ['pipeline.run'] as const;

export const PIPELINE_RUN_MODES = [
  'dispatch',
  'plan_ready',
  'task_ready',
] as const;

export const PIPELINE_RUN_MAX_WATCHERS = 10;

/** Where a run executes (CAN-6187): this computer, or the cloud. */
export const PIPELINE_RUN_LOCATIONS = ['local', 'cloud'] as const;

export type PipelineRunLocation = (typeof PIPELINE_RUN_LOCATIONS)[number];

const terminalStatusSchema = z.enum(['success', 'failure', 'cancelled']);

/**
 * An inline completion watcher armed once the run starts. Scoped chats name
 * terminal statuses under `target`; App Advisor names them at the top level.
 */
export const pipelineRunWatcherSchema = z.object({
  label: z.string().optional(),
  target: z
    .object({
      executionId: z.string().optional(),
      pipelineId: z.string().optional(),
      terminalStatuses: z.array(terminalStatusSchema).optional(),
    })
    .optional(),
  terminalStatuses: z.array(terminalStatusSchema).optional(),
  followUpInstruction: z.string().optional(),
  allowDuplicate: z.boolean().optional(),
});

export type PipelineRunWatcher = z.output<typeof pipelineRunWatcherSchema>;

const pipelineRunFields = {
  type: z.literal('pipeline.run'),
  pipelineId: z.string().min(1),
  /** `global` runs with no project; omitted runs where the caller is. */
  scope: z.literal('global').optional(),
  /** `cloud` starts the run in the cloud; omitted runs on this computer. */
  runOn: z.enum(PIPELINE_RUN_LOCATIONS).optional(),
  inputs: z.record(z.string(), z.string()).optional(),
  runMode: z.enum(PIPELINE_RUN_MODES).optional(),
  planPath: z.string().optional(),
  taskPath: z.string().optional(),
  planId: z.string().optional(),
  repoId: z.string().optional(),
  watchers: z
    .array(pipelineRunWatcherSchema)
    .max(PIPELINE_RUN_MAX_WATCHERS)
    .optional(),
};

export const GLOBAL_PIPELINE_RUN_MODE_MESSAGE =
  'A run with no project (scope "global") supports only runMode "dispatch".';
export const GLOBAL_PIPELINE_RUN_TARGET_MESSAGE =
  'A run with no project (scope "global") cannot take planPath, taskPath, planId, or repoId.';
export const GLOBAL_PIPELINE_RUN_WATCHERS_MESSAGE =
  'Completion watchers are not available for a run with no project (scope "global").';
export const CLOUD_PIPELINE_RUN_MODE_MESSAGE =
  'A cloud run (runOn "cloud") from this chat supports only runMode "dispatch".';
export const CLOUD_PIPELINE_RUN_TARGET_MESSAGE =
  'A cloud run (runOn "cloud") cannot take planPath, taskPath, or planId.';
export const CLOUD_PIPELINE_RUN_WATCHERS_MESSAGE =
  'Completion watchers are not available for a cloud run (runOn "cloud") from this chat yet.';
export const APP_ADVISOR_PIPELINE_RUN_TARGET_MESSAGE =
  'Pass projectId and worktreeId for a run in a task, or scope "global" without them for a run with no project.';

interface PipelineRunShape {
  scope?: 'global';
  runOn?: PipelineRunLocation;
  runMode?: (typeof PIPELINE_RUN_MODES)[number];
  planPath?: string;
  taskPath?: string;
  planId?: string;
  repoId?: string;
  watchers?: unknown[];
}

/**
 * A global run is a plain dispatch with no task inputs or watchers. A cloud
 * run is a plain dispatch too: with no project, or where the caller is, if
 * the web core admits it there (CAN-6354); it takes no local plan or task
 * file, and its completion watchers come later (CP-49).
 */
function refineGlobalRun(action: PipelineRunShape, ctx: z.RefinementCtx): void {
  if (action.scope === 'global') {
    if (action.runMode !== undefined && action.runMode !== 'dispatch')
      ctx.addIssue({
        code: 'custom',
        path: ['runMode'],
        message: GLOBAL_PIPELINE_RUN_MODE_MESSAGE,
      });
    for (const field of ['planPath', 'taskPath', 'planId', 'repoId'] as const) {
      if (action[field] !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: GLOBAL_PIPELINE_RUN_TARGET_MESSAGE,
        });
    }
    if ((action.watchers?.length ?? 0) > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['watchers'],
        message: GLOBAL_PIPELINE_RUN_WATCHERS_MESSAGE,
      });
    return;
  }
  if (action.runOn !== 'cloud') return;
  if (action.runMode !== undefined && action.runMode !== 'dispatch')
    ctx.addIssue({
      code: 'custom',
      path: ['runMode'],
      message: CLOUD_PIPELINE_RUN_MODE_MESSAGE,
    });
  for (const field of ['planPath', 'taskPath', 'planId'] as const) {
    if (action[field] !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: CLOUD_PIPELINE_RUN_TARGET_MESSAGE,
      });
  }
  if ((action.watchers?.length ?? 0) > 0)
    ctx.addIssue({
      code: 'custom',
      path: ['watchers'],
      message: CLOUD_PIPELINE_RUN_WATCHERS_MESSAGE,
    });
}

/**
 * `pipeline.run` in a chat-scoped surface: the calling chat supplies the
 * project and task, so the payload never names them.
 */
export const pipelineRunActionSchema = z
  .object(pipelineRunFields)
  .superRefine(refineGlobalRun);

export type PipelineRunAction = z.output<typeof pipelineRunActionSchema>;

/**
 * App Advisor's `pipeline.run`: it has no task of its own, so a targeted run
 * names `projectId` and `worktreeId`; a global run names neither. The host
 * resolves the pair as trusted context and dispatches the common action.
 */
export const appAdvisorPipelineRunActionSchema = z
  .object({
    ...pipelineRunFields,
    projectId: z.string().min(1).optional(),
    worktreeId: z.string().min(1).optional(),
  })
  .superRefine((action, ctx) => {
    refineGlobalRun(action, ctx);
    // App Advisor has always required the event's file for these run modes.
    if (action.runMode === 'plan_ready' && !action.planPath)
      ctx.addIssue({
        code: 'custom',
        path: ['planPath'],
        message: 'planPath is required for runMode "plan_ready".',
      });
    if (action.runMode === 'task_ready' && !action.taskPath)
      ctx.addIssue({
        code: 'custom',
        path: ['taskPath'],
        message: 'taskPath is required for runMode "task_ready".',
      });
    const named =
      action.projectId !== undefined || action.worktreeId !== undefined;
    const complete =
      action.projectId !== undefined && action.worktreeId !== undefined;
    if (action.scope === 'global' ? named : !complete)
      ctx.addIssue({
        code: 'custom',
        path: ['projectId'],
        message: APP_ADVISOR_PIPELINE_RUN_TARGET_MESSAGE,
      });
  });

export type AppAdvisorPipelineRunAction = z.output<
  typeof appAdvisorPipelineRunActionSchema
>;
