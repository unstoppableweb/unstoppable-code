import { z } from 'zod';
import {
  ExecutionSecretBindingsSchema,
  WORKER_EXECUTION_SECRET_ERROR_CODES,
} from './execution-secrets';

import {
  CORE_SCRIPT_LIFECYCLE_ROLES,
  CoreScriptCommandSchema,
  CoreScriptCommandShellSchema,
  CoreScriptDevServerPatternSchema,
  MAX_SCRIPT_TIMEOUT_SECONDS,
} from '../script-values';
import { CanopyQueryRequestMetadataSchema } from '../common';
import {
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';

/** Run logs keep at most this many lines in one read. */
export const WORKER_SCRIPT_MAX_TAIL_LINES = 2_000;

export const WORKER_SCRIPT_GRANTS = {
  execute: 'worker.script.execute',
  read: 'worker.script.read',
} as const;

export const WORKER_SCRIPT_ERROR_CODES = [
  'worker.script.contextUnavailable',
  'worker.script.executionInProgress',
  'worker.script.idempotencyKeyReused',
  'worker.script.placementUnreachable',
  ...WORKER_EXECUTION_SECRET_ERROR_CODES,
] as const;

export type WorkerScriptErrorCode = (typeof WORKER_SCRIPT_ERROR_CODES)[number];

const id = z.string().min(1).max(512);

/**
 * The worktree a script runs in. The worker projects it, with the context,
 * onto its own trusted checkout; params never carry host paths.
 */
export const WorkerScriptScopeSchema = z.strictObject({
  authorityId: id.optional(),
  targetId: id.optional(),
  workspaceId: id,
  worktreeId: id,
});
export type WorkerScriptScope = z.output<typeof WorkerScriptScopeSchema>;

const environmentKey = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/**
 * Where in the worktree the command runs, and which environment it gets.
 *
 * - `project`, `workspace-root` and `workspace-repo` run in that checkout
 *   with the worktree's data environment.
 * - `shared-container` runs in the container's run copy of `repoId` with
 *   exactly the declared `environmentKeys` the recipient assigned, and no
 *   other variable: the values stay on the worker.
 * - `automation-home` is an automation If Command gate, run in the
 *   automation home with the login-shell environment; its scope is unused.
 */
export const WorkerScriptContextSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project') }),
  z.strictObject({ kind: z.literal('workspace-root') }),
  z.strictObject({ kind: z.literal('workspace-repo'), repoId: id }),
  z.strictObject({
    kind: z.literal('shared-container'),
    repoId: id,
    environmentKeys: z.array(environmentKey).max(256),
  }),
  z.strictObject({ kind: z.literal('automation-home') }),
]);
export type WorkerScriptContext = z.output<typeof WorkerScriptContextSchema>;

export const WORKER_SCRIPT_INVOCATIONS = [
  'automatic-setup',
  'manual-run',
  'manual-lifecycle',
  'workspace-lifecycle',
] as const;

/** The script a durable run log names. */
export const WorkerScriptDescriptorSchema = z.strictObject({
  scriptKey: z.string().min(1).max(1024),
  scriptName: z.string().min(1).max(512),
  label: z.string().max(1024),
  command: z.string().max(65_536),
  lifecycle: z.enum(CORE_SCRIPT_LIFECYCLE_ROLES),
  target: z.enum(['project', 'workspace-repo', 'workspace-root']),
  repoId: id.optional(),
  repoName: z.string().max(1024).optional(),
  devServerPattern: CoreScriptDevServerPatternSchema.optional(),
  shell: CoreScriptCommandShellSchema.optional(),
  interactive: z.literal(true).optional(),
});
export type WorkerScriptDescriptor = z.output<
  typeof WorkerScriptDescriptorSchema
>;

export const WorkerScriptExecuteParamsSchema = z
  .strictObject({
    scope: WorkerScriptScopeSchema.partial({
      workspaceId: true,
      worktreeId: true,
    }),
    /** Names the run in its log and in cancellation; the caller mints it. */
    executionId: id,
    context: WorkerScriptContextSchema,
    command: CoreScriptCommandSchema,
    shell: CoreScriptCommandShellSchema.optional(),
    /**
     * `interactive` starts a POSIX shell with `-li`, as scripts do; `login`
     * with `-l`, as If Command gates do. Windows ignores it.
     */
    shellStartup: z.enum(['interactive', 'login']),
    /** Null runs without a timeout. */
    timeoutMs: z
      .int()
      .min(1)
      .max(MAX_SCRIPT_TIMEOUT_SECONDS * 1000)
      .nullable(),
    /** `background` runs below the app's priority, for automatic work. */
    priority: z.enum(['normal', 'background']),
    /**
     * Run in a terminal the worker owns for the worktree, so the command can
     * take typed input (CAN-5082). `title` names the terminal, defaulting to
     * the recorded script's label. Needs a workspace, worktree and `record`.
     */
    terminal: z
      .strictObject({ title: z.string().min(1).max(1024).optional() })
      .optional(),
    /** Keep the run in the worktree's durable run log; gates omit it. */
    record: z
      .strictObject({
        script: WorkerScriptDescriptorSchema,
        invocation: z.enum(WORKER_SCRIPT_INVOCATIONS),
      })
      .optional(),
    secrets: ExecutionSecretBindingsSchema.optional(),
  })
  .superRefine((params, context) => {
    const scoped =
      params.scope.workspaceId !== undefined &&
      params.scope.worktreeId !== undefined;
    if (!scoped && (params.context.kind !== 'automation-home' || params.record))
      context.addIssue({
        code: 'custom',
        path: ['scope'],
        message: 'This run needs a workspace and worktree.',
      });
    if (params.terminal && !params.record)
      context.addIssue({
        code: 'custom',
        path: ['terminal'],
        message: 'A terminal-backed run is kept in the run log.',
      });
  });
export type WorkerScriptExecuteParams = z.output<
  typeof WorkerScriptExecuteParamsSchema
>;

const exitCode = z.int().nullable();

/**
 * How a run ended. `cancelled` is a stop or a cancellation, with no exit
 * code; a timeout is `failed` with `timedOut`.
 */
export const WorkerScriptExecuteResultSchema = z.strictObject({
  executionId: id,
  status: z.enum(['success', 'failed', 'cancelled']),
  exitCode,
  timedOut: z.boolean(),
  durationMs: z.int().nonnegative(),
  /** Bytes of output the worker kept; at most 256 KiB. */
  outputBytes: z.int().nonnegative(),
  outputTruncated: z.boolean(),
  /** False when the run log could not be written; the run still ran. */
  recorded: z.boolean(),
});
export type WorkerScriptExecuteResult = z.output<
  typeof WorkerScriptExecuteResultSchema
>;

export const WORKER_SCRIPT_EXECUTION_STATUSES = [
  'running',
  'success',
  'failed',
  'cancelled',
  'lost',
] as const;

/**
 * A script key's latest run from the durable run log. `lost` is a run a
 * restart interrupted: it was not run again and its outcome is unknown.
 */
export const WorkerScriptExecutionSchema = z.strictObject({
  executionId: id,
  script: WorkerScriptDescriptorSchema,
  invocation: z.enum(WORKER_SCRIPT_INVOCATIONS),
  status: z.enum(WORKER_SCRIPT_EXECUTION_STATUSES),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  exitCode,
  timedOut: z.boolean(),
  durationMs: z.int().nonnegative(),
});
export type WorkerScriptExecution = z.output<
  typeof WorkerScriptExecutionSchema
>;

const tailLines = z.int().min(0).max(WORKER_SCRIPT_MAX_TAIL_LINES);

export const WorkerScriptExecutionGetParamsSchema = z.strictObject({
  scope: WorkerScriptScopeSchema,
  scriptKey: z.string().min(1).max(1024),
  /** Read up to this many of the log's last lines; 0 reads none. */
  tailLines: tailLines.optional(),
});
export type WorkerScriptExecutionGetParams = z.output<
  typeof WorkerScriptExecutionGetParamsSchema
>;

const executionLog = z.strictObject({
  execution: WorkerScriptExecutionSchema,
  lines: z.array(z.string()).max(WORKER_SCRIPT_MAX_TAIL_LINES),
});

export const WorkerScriptExecutionGetResultSchema = z.strictObject({
  /** Null when the script key has no readable run. */
  run: executionLog.nullable(),
});
export type WorkerScriptExecutionGetResult = z.output<
  typeof WorkerScriptExecutionGetResultSchema
>;

export const WorkerScriptExecutionListParamsSchema = z.strictObject({
  scope: WorkerScriptScopeSchema,
  tailLines: tailLines.optional(),
});
export type WorkerScriptExecutionListParams = z.output<
  typeof WorkerScriptExecutionListParamsSchema
>;

export const WorkerScriptExecutionListResultSchema = z.strictObject({
  /** Each script key's latest run in the worktree's log. */
  runs: z.array(executionLog),
});
export type WorkerScriptExecutionListResult = z.output<
  typeof WorkerScriptExecutionListResultSchema
>;

export const WorkerScriptExecutionCancelParamsSchema = z.strictObject({
  scope: WorkerScriptScopeSchema,
  scriptKey: z.string().min(1).max(1024),
  /** Stop only this run; without it every run of the script key stops. */
  executionId: id.optional(),
  /**
   * End each run's whole process tree and answer once it has exited, not
   * when its shell has (worktree removal, CAN-5839).
   */
  drain: z.literal(true).optional(),
});
export type WorkerScriptExecutionCancelParams = z.output<
  typeof WorkerScriptExecutionCancelParamsSchema
>;

export const WorkerScriptExecutionCancelResultSchema = z.strictObject({
  /** The runs that were running and have now ended; empty when none was. */
  stopped: z.array(WorkerScriptExecuteResultSchema),
});
export type WorkerScriptExecutionCancelResult = z.output<
  typeof WorkerScriptExecutionCancelResultSchema
>;

export const WorkerScriptQueryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_SCRIPT_ERROR_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
export const WorkerScriptInstructionErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(WORKER_SCRIPT_ERROR_CODES).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

/** Streamed lines are cut to this many characters; the run log keeps them whole. */
export const WORKER_SCRIPT_OUTPUT_LINE_MAX_LENGTH = 8_192;
export const WORKER_SCRIPT_OUTPUT_ITEM_MAX_LINES = 500;

export const WorkerScriptExecutionOutputParamsSchema = z.strictObject({
  scope: WorkerScriptScopeSchema,
  executionId: id,
  /** Wait up to 60 s for a run that has not begun; without it, end at once. */
  awaitStart: z.boolean().optional(),
  /** The stream doesn't resume; a subscription starts at the next line. */
  cursor: z.null().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export type WorkerScriptExecutionOutputParams = z.output<
  typeof WorkerScriptExecutionOutputParamsSchema
>;

export const WorkerScriptExecutionOutputOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: z.null(),
});

/** `started` and `gap` are never dropped; `lines` may be, and the next `gap` counts them. */
export const WorkerScriptExecutionOutputItemSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ kind: z.literal('started') }),
    z.strictObject({
      kind: z.literal('lines'),
      lines: z
        .array(z.string().max(WORKER_SCRIPT_OUTPUT_LINE_MAX_LENGTH))
        .min(1)
        .max(WORKER_SCRIPT_OUTPUT_ITEM_MAX_LINES),
      /** A line was cut to the maximum length. */
      truncated: z.boolean(),
    }),
    z.strictObject({ kind: z.literal('gap'), droppedLines: z.int().min(1) }),
  ],
);
export type WorkerScriptExecutionOutputItem = z.output<
  typeof WorkerScriptExecutionOutputItemSchema
>;

export const WorkerScriptExecutionOutputEndSchema =
  CanopyStreamEndSchema.extend({
    error: WorkerScriptQueryErrorSchema.nullable(),
  });

export const WORKER_SCRIPT_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.script.execution.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'script',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_SCRIPT_GRANTS.read],
      params: WorkerScriptExecutionGetParamsSchema,
      result: WorkerScriptExecutionGetResultSchema,
      error: WorkerScriptQueryErrorSchema,
    }),
    'worker.script.execution.list': defineCanopyQuery({
      plane: 'worker',
      domain: 'script',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_SCRIPT_GRANTS.read],
      params: WorkerScriptExecutionListParamsSchema,
      result: WorkerScriptExecutionListResultSchema,
      error: WorkerScriptQueryErrorSchema,
    }),
  },
);

export const WORKER_SCRIPT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.script.execute': defineCanopyInstruction({
      plane: 'worker',
      domain: 'script',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: [WORKER_SCRIPT_GRANTS.execute],
      params: WorkerScriptExecuteParamsSchema,
      result: WorkerScriptExecuteResultSchema,
      error: WorkerScriptInstructionErrorSchema,
    }),
    'worker.script.execution.cancel': defineCanopyInstruction({
      plane: 'worker',
      domain: 'script',
      version: 1,
      placement: 'worker-only',
      idempotency: 'keyed',
      requiredGrants: [WORKER_SCRIPT_GRANTS.execute],
      params: WorkerScriptExecutionCancelParamsSchema,
      result: WorkerScriptExecutionCancelResultSchema,
      error: WorkerScriptInstructionErrorSchema,
    }),
  });

/** Not spread into the worker registry: only hosts that serve remote runs compose it (CAN-5087). */
export const WORKER_SCRIPT_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'worker',
  {
    'worker.script.execution.output': defineCanopyStream({
      plane: 'worker',
      domain: 'script',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_SCRIPT_GRANTS.read],
      params: WorkerScriptExecutionOutputParamsSchema,
      openResult: WorkerScriptExecutionOutputOpenResultSchema,
      item: WorkerScriptExecutionOutputItemSchema,
      end: WorkerScriptExecutionOutputEndSchema,
      error: WorkerScriptQueryErrorSchema,
    }),
  },
);
