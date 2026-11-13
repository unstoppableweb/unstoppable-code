import { z } from 'zod';

import {
  CanopyJsonValueSchema,
  canopyJsonValueSchemaWithin,
  type CanopyJsonValue,
} from './errors';

/**
 * The reserved request member that carries host execution input (CAN-5496).
 * It sits beside `_meta`, never inside it or the operation params, and is
 * accepted only by {@link CANOPY_HOST_EXECUTION_OPERATIONS}.
 */
export const CANOPY_HOST_EXECUTION_MEMBER = '_execution';

/**
 * The operations whose request envelope admits `_execution`: the
 * `worker.git.*` operations whose Git children run with the forwarded
 * environment. `worker.git.executable.get` is absent because executable
 * selection keeps the daemon's own environment. `worker.git.diff.get` is
 * absent too: its change-set reads keep the daemon's own environment,
 * recorded debt (CAN-4729). The branch writes are idempotency `none`, so no
 * receipt or replay can run them again with a stale environment (CAN-4108,
 * CAN-5516). `worker.script.execute` takes the run's complete environment
 * (CAN-5087).
 */
export const CANOPY_HOST_EXECUTION_OPERATIONS: ReadonlySet<string> = new Set([
  'worker.git.branch.list',
  'worker.git.remote.get',
  'worker.git.worktree.health.get',
  'worker.git.checkout',
  'worker.git.branch.create',
  'worker.git.branch.rename',
  'worker.git.branch.delete',
  // CAN-5517: idempotency none, as the branch writes.
  'worker.git.fetch',
  'worker.git.pull',
  // CAN-5882: keyed without retention until CAN-4733; no credentials forwarded.
  'worker.git.commit',
  'worker.git.push',
  'worker.git.merge',
  'worker.git.worktree.add',
  'worker.git.worktree.remove',
  'worker.git.worktree.prune',
  // CAN-5087: keyed, but `_execution` is outside params, so a keyed repeat joins the running execution and never runs it with another environment.
  'worker.script.execute',
  // CAN-5086: a pipeline start carries its launch in pipelineLaunch; keyed, but a keyed replay never runs a launch again.
  'worker.pipeline.execution.start',
  // CAN-5095: an owner request's answer carries its capabilities in pipelineOwnerValues.
  // CAN-5771: the owner's settlement carries its host-local values; idempotency inherent, so a repeat answers already_settled.
  'worker.pipeline.hostRequest.respond',
]);

/** Bounds well below one 8 MiB frame and macOS `ARG_MAX`. */
export const CANOPY_HOST_EXECUTION_LIMITS = Object.freeze({
  entries: 1_024,
  bytes: 256 * 1024,
});

/**
 * UTF-8 bytes of `text`, counting an unpaired surrogate as U+FFFD (three
 * bytes), as `TextEncoder` and Node's spawn encode it. Counted directly
 * because the renderer's jsdom tests import this module and lack
 * `TextEncoder`.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function withinLimits(environment: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(environment);
  if (entries.length > CANOPY_HOST_EXECUTION_LIMITS.entries) return false;
  let bytes = 0;
  for (const [key, value] of entries) {
    // `KEY=value` plus its terminator, as the child's environment block holds it.
    bytes += utf8ByteLength(key) + utf8ByteLength(value) + 2;
    if (bytes > CANOPY_HOST_EXECUTION_LIMITS.bytes) return false;
  }
  return true;
}

const EnvironmentKeySchema = z
  .string()
  .min(1)
  .refine((key) => !key.includes('\0') && !key.includes('='));
const EnvironmentValueSchema = z
  .string()
  .refine((value) => !value.includes('\0'));

/**
 * The complete environment a host-local child runs with. It replaces the
 * executing host's own environment for that child; it is never merged.
 * For a pipeline start it is the run's base environment, which replaces the
 * worker's own for every step; the executor layers `pipelineLaunch.env` and
 * `secretEnv` over it as it layers them over its own (CAN-5086).
 */
export const CanopyChildEnvironmentSchema = z
  .record(EnvironmentKeySchema, EnvironmentValueSchema)
  .refine(withinLimits, 'The child environment exceeds its limits.');

/** The operation whose `_execution` may carry a pipeline launch (CAN-5086). */
export const CANOPY_PIPELINE_LAUNCH_OPERATION =
  'worker.pipeline.execution.start';

/** The longest admitted pipeline snapshot, as UTF-8 JSON. */
export const WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

/** Deeper than any workflow document nests; it bounds the check below. */
const WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_DEPTH = 64;

/**
 * JSON data with no per-value size bound: the snapshot is bounded as a whole
 * by {@link WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_BYTES}, unlike error details.
 */
function isSnapshotValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): value is CanopyJsonValue {
  if (value === null || typeof value === 'string') return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (depth >= WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_DEPTH) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.every((entry) =>
        isSnapshotValue(entry, depth + 1, ancestors),
      );
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    return Object.values(value).every((entry) =>
      isSnapshotValue(entry, depth + 1, ancestors),
    );
  } finally {
    ancestors.delete(value);
  }
}

/** The most a launch's model registry snapshot may hold, in UTF-8 bytes (CAN-5095). */
export const WORKER_PIPELINE_MODEL_CATALOG_MAX_BYTES = 1_048_576;

const modelRegistryValue = z
  .string()
  .min(1)
  .max(WORKER_PIPELINE_MODEL_CATALOG_MAX_BYTES);

/**
 * The model registry a launch's model steps resolve against (CAN-5095): the
 * values the step runner gives action subprocesses, by branded environment
 * name. Not a secret; every action subprocess's environment carries it.
 */
export const WorkerPipelineModelCatalogSchema = z
  .strictObject({
    CLAUDE_MODELS: modelRegistryValue.optional(),
    CODEX_MODELS: modelRegistryValue.optional(),
    OLLAMA_MODELS: modelRegistryValue.optional(),
    MODEL_ALIASES: modelRegistryValue.optional(),
    MODEL_CATALOG: modelRegistryValue,
    MODEL_HARNESS_ASSIGNMENTS: modelRegistryValue,
    MODEL_THINKING_LEVELS: modelRegistryValue.optional(),
  })
  .refine(
    (catalog) =>
      Object.values(catalog).reduce(
        (total, value) => total + (value ? utf8ByteLength(value) : 0),
        0,
      ) <= WORKER_PIPELINE_MODEL_CATALOG_MAX_BYTES,
    'The model catalog exceeds its limit.',
  );

/** What each of a pipeline's model aliases names for one run (CAN-5832). */
export const WorkerPipelineModelAliasResolutionsSchema = z
  .record(
    z.string().min(1).max(256),
    z.strictObject({
      base: z.string().min(1).max(512),
      plugins: z.boolean(),
    }),
  )
  .refine((aliases) => Object.keys(aliases).length <= 256);

/** A run's plugin collection snapshots: selection references, never MCP configuration (CAN-5832). */
export const WorkerPipelinePluginCollectionSnapshotsSchema = z
  .record(z.string().min(1).max(256), CanopyJsonValueSchema)
  .refine((collections) => Object.keys(collections).length <= 64);

/** A launch's inputs, as the executor reads them. */
export const WorkerPipelineLaunchInputsSchema = z
  .record(z.string().min(1).max(256), z.string().max(65_536))
  .refine((inputs) => Object.keys(inputs).length <= 256);

/** The longest plan or task text a launch event carries, as UTF-8: a shared plan's limit. */
export const WORKER_PIPELINE_LAUNCH_EVENT_TEXT_MAX_BYTES = 1024 * 1024;

const launchEventText = z
  .string()
  .min(1)
  .refine(
    (text) =>
      utf8ByteLength(text) <= WORKER_PIPELINE_LAUNCH_EVENT_TEXT_MAX_BYTES,
    'The text exceeds its limit.',
  );

/**
 * The trigger event a run starts from, when it is not `dispatch` (CAN-6327):
 * a `plan_ready` run's plan, with the plan it revises when it has one, or a
 * `task_ready` run's task. Text, never a path: the host writes it into the
 * run's own folder and hands the steps that file as `plan_path` or
 * `task_path`, and a `task_ready` run's plan is written beside it. What a run
 * writes to `plan_path` returns to its owner through `owner.plan.*`.
 */
export const WorkerPipelineLaunchEventSchema = z.discriminatedUnion('name', [
  z.strictObject({
    name: z.literal('plan_ready'),
    planText: launchEventText,
    /** The owner's plan the run revises; absent for a plan it has not kept yet. */
    planId: z.string().min(1).max(512).optional(),
  }),
  z.strictObject({
    name: z.literal('task_ready'),
    taskText: launchEventText,
  }),
]);
export type WorkerPipelineLaunchEvent = z.output<
  typeof WorkerPipelineLaunchEventSchema
>;

/**
 * An absolute host path: POSIX, or a Windows drive path (CAN-5091). A path
 * that starts with two separators, in either direction, is refused: on
 * Windows it is a UNC or device path.
 */
const HostPathSchema = z
  .string()
  .min(2)
  .max(4096)
  .refine(
    (value) =>
      (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) &&
      !/^[\\/]{2}/.test(value) &&
      !value.includes('\0'),
  );

/** The admitted pipeline document a launch runs: JSON data within its size limit. */
export const WorkerPipelineLaunchSnapshotSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (pipeline) =>
      Object.values(pipeline).every((value) =>
        isSnapshotValue(value, 1, new Set()),
      ),
    // Abort, so the size check below never serializes a cycle.
    { message: 'Expected JSON-safe data.', abort: true },
  )
  .refine(
    (pipeline) =>
      utf8ByteLength(JSON.stringify(pipeline)) <=
      WORKER_PIPELINE_LAUNCH_SNAPSHOT_MAX_BYTES,
    'The pipeline snapshot exceeds its limit.',
  );

/**
 * What a pipeline start runs, host-local (CAN-5086): the snapshot core
 * admitted, its resolved paths, its launch environment and the secret
 * environment its core redeemed. It never enters params, records or logs.
 */
export const WorkerPipelineHostLaunchSchema = z.strictObject({
  pipeline: WorkerPipelineLaunchSnapshotSchema,
  cwd: HostPathSchema,
  /** The core's own built bundled actions (`getBundledActionsDir()`), so both hosts run one copy. */
  bundledActionsDir: HostPathSchema,
  repoPath: HostPathSchema.optional(),
  pipelineFileDir: HostPathSchema.optional(),
  pipelineDataDir: HostPathSchema.optional(),
  assetsDir: HostPathSchema.optional(),
  assetPaths: z
    .record(z.string().min(1).max(256), HostPathSchema)
    .refine((paths) => Object.keys(paths).length <= 64)
    .optional(),
  executionCheckoutRoot: HostPathSchema.nullable().optional(),
  /**
   * `ExecutionOptions.globalWorkspaceDir` (CAN-6317): the folder a top-level
   * global run works in, instead of one inside its execution folder. A cloud
   * runner names the pipeline's kept workspace, so files its steps write
   * there last from one run to the next.
   */
  globalWorkspaceDir: HostPathSchema.optional(),
  /** `ExecutionOptions.env`: layered over the base environment by the executor. */
  env: CanopyChildEnvironmentSchema,
  /** `ExecutionOptions.secretEnv`: masked in step output. */
  secretEnv: CanopyChildEnvironmentSchema,
  inputs: WorkerPipelineLaunchInputsSchema.optional(),
  /** The run's trigger event; absent for `dispatch` (CAN-6327). */
  event: WorkerPipelineLaunchEventSchema.optional(),
  target: CanopyJsonValueSchema.optional(),
  pipelinePreferenceLocator: CanopyJsonValueSchema.optional(),
  sharedPipelineSource: CanopyJsonValueSchema.optional(),
  curatedPipelineSource: CanopyJsonValueSchema.optional(),
  initiator: CanopyJsonValueSchema.optional(),
  agentOrigin: CanopyJsonValueSchema.optional(),
  /** The run needs its owner (host steps, CAN-5771; model steps, CAN-5095): it pauses when the owner is gone. */
  ownerBound: z.boolean().optional(),
  /** How `node` steps and actions start (Electron's binary as Node). */
  nodeProcess: z
    .strictObject({
      command: HostPathSchema,
      env: z
        .record(z.string().min(1).max(256), z.string().max(4096))
        .optional(),
    })
    .optional(),
  /** `ExecutionOptions.modelConfig` (CAN-5095). */
  modelConfig: CanopyJsonValueSchema.optional(),
  /** The app's own provider CLIs, for model steps (CAN-5095 D21). */
  providerBinaries: z
    .strictObject({ claude: HostPathSchema, codex: HostPathSchema })
    .optional(),
  /**
   * The app's own bundled resources, where its `builtin:app` skills live, for
   * model steps that load plugins (CAN-5832); like providerBinaries (D21).
   */
  bundledResourcesDir: HostPathSchema.optional(),
  /**
   * The tsx CLI (`tsx/dist/cli.mjs`) the host runs `tsx` steps and actions
   * with on `nodeProcess` (CAN-6316 G1). A cloud runner stages its own;
   * without it the host refuses tsx steps, and desktop runs them in process.
   */
  tsxRuntime: HostPathSchema.optional(),
  /** The model registry its model steps resolve against (CAN-5095). */
  modelCatalog: WorkerPipelineModelCatalogSchema.optional(),
  /**
   * The owner runs `git-commit-push`'s precommit-failure hook from the stored
   * outputs, so the host admits that action (CAN-6012 D3). Cloud runners
   * leave it out until CP-30.
   */
  precommitHooks: z.literal('owner').optional(),
  /** The run's Codex app-server environment, when it has a Codex step (CAN-5095 D20). */
  codexEnvironment: z
    .strictObject({
      environment: CanopyChildEnvironmentSchema,
      logicalWorkspaceEnvironmentId: z.string().min(1).max(512),
    })
    .optional(),
  /** The run's model alias preferences, stored and draft merged as its core's executor merges them (CAN-5832). */
  modelAliasPreferences: CanopyJsonValueSchema.optional(),
  /**
   * What each of the pipeline's model aliases names for this run, as its core
   * resolved it at launch: the base model, and whether the alias adds plugins.
   * The host classifies with it; each step still resolves its alias (CAN-5832).
   */
  modelAliasResolutions: WorkerPipelineModelAliasResolutionsSchema.optional(),
  /** `ExecutionOptions.pluginCollectionPreferences`: the run's draft preferences, as its state records them (CAN-5832). */
  pluginCollectionPreferences: CanopyJsonValueSchema.optional(),
  /**
   * The run's plugin collection snapshots, resolved by its core at launch
   * with the run's stored and draft preferences, as its executor resolves
   * them at start: selection references, never MCP configuration (CAN-5832).
   */
  pluginCollectionSnapshots:
    WorkerPipelinePluginCollectionSnapshotsSchema.optional(),
});
export type WorkerPipelineHostLaunch = z.output<
  typeof WorkerPipelineHostLaunchSchema
>;

/** The host-path outputs a host step returns host-locally (CAN-5771); equals WORKER_PIPELINE_HOST_PATH_OUTPUTS. */
export const PIPELINE_HOST_STEP_PATH_OUTPUTS = [
  'path',
  'setup_log_file',
  'setup_results_file',
  'reply_file',
] as const;

/**
 * What a host step's owner returns host-locally with its settlement
 * (CAN-5771): the host-path outputs the portable result refuses, how the
 * deadline ended the call, and an unexpected host error's own message.
 */
export const WorkerPipelineHostStepValuesSchema = z.strictObject({
  /** An absolute host path, or `''` where the host reports no file (a skipped setup, no reply). */
  pathOutputs: z.partialRecord(
    z.enum(PIPELINE_HOST_STEP_PATH_OUTPUTS),
    z.union([HostPathSchema, z.literal('')]),
  ),
  /** `none`: settled in time; `finalized`: the host's timeout finalizer's result; `unfinalized`: the deadline passed with no finalizer. */
  timeout: z.enum(['none', 'finalized', 'unfinalized']),
  errorMessage: z.string().min(1).max(8192).optional(),
  /** The host returned a send record the boundary refuses; the executor reports an invalid receipt, as in process. */
  invalidChatSend: z.literal(true).optional(),
});
export type WorkerPipelineHostStepValues = z.output<
  typeof WorkerPipelineHostStepValuesSchema
>;

/** The operation whose `_execution` may carry pipeline owner values (CAN-5095). */
export const CANOPY_PIPELINE_OWNER_VALUES_OPERATION =
  'worker.pipeline.hostRequest.respond';

/** The largest Codex provider block or MCP server map that crosses, as UTF-8 JSON. */
export const WORKER_PIPELINE_OWNER_VALUES_JSON_MAX_BYTES = 256 * 1024;

const ownerValueJson = canopyJsonValueSchemaWithin(
  WORKER_PIPELINE_OWNER_VALUES_JSON_MAX_BYTES,
);

/**
 * Capabilities core hands a model step host-locally (CAN-5095): a route's
 * provider environment and Codex provider block, or a Ledger route. They
 * never enter params, results, records or logs.
 */
export const WorkerPipelineOwnerValuesSchema = z.strictObject({
  /** The owner request these answer; the respond's own requestId. */
  requestId: z.string().min(1).max(3072),
  env: CanopyChildEnvironmentSchema.optional(),
  codexConfig: z
    .record(z.string(), ownerValueJson)
    .refine(
      (value) =>
        utf8ByteLength(JSON.stringify(value)) <=
        WORKER_PIPELINE_OWNER_VALUES_JSON_MAX_BYTES,
      'The Codex provider block exceeds its limit.',
    )
    .optional(),
  ledgerSubprocessTools: z
    .strictObject({
      mcpServers: z
        .record(z.string().min(1).max(256), ownerValueJson)
        .refine((value) => Object.keys(value).length <= 64)
        .refine(
          (value) =>
            utf8ByteLength(JSON.stringify(value)) <=
            WORKER_PIPELINE_OWNER_VALUES_JSON_MAX_BYTES,
        ),
      allowedTools: z.array(z.string().min(1).max(512)).max(256),
      secretValues: z.array(z.string().min(1).max(4096)).max(64),
    })
    .optional(),
  /**
   * One `owner.mcp.authorize` answer's `Authorization` header (CAN-6168),
   * for one upstream request: the worker writes it once and keeps it no
   * longer than MCP_AUTHORIZATION_TTL_MS.
   */
  mcpAuthorization: z
    .strictObject({ authorization: z.string().min(1).max(16_384) })
    .optional(),
});
export type WorkerPipelineOwnerValues = z.output<
  typeof WorkerPipelineOwnerValuesSchema
>;

export const CanopyHostExecutionSchema = z.strictObject({
  childEnvironment: CanopyChildEnvironmentSchema,
  /** Only {@link CANOPY_PIPELINE_LAUNCH_OPERATION} accepts it. */
  pipelineLaunch: WorkerPipelineHostLaunchSchema.optional(),
  /** Only {@link CANOPY_PIPELINE_OWNER_VALUES_OPERATION} accepts it. */
  pipelineOwnerValues: WorkerPipelineOwnerValuesSchema.optional(),
  /** Only {@link CANOPY_HOST_EXECUTION_MEMBER_OPERATIONS}.pipelineHostStep accepts it (CAN-5771). */
  pipelineHostStep: WorkerPipelineHostStepValuesSchema.optional(),
});

/**
 * The one operation that accepts each `_execution` member besides
 * `childEnvironment`, and the refusal any other operation answers (CAN-5771).
 * A member missing here is refused everywhere.
 */
export const CANOPY_HOST_EXECUTION_MEMBER_OPERATIONS = Object.freeze({
  pipelineLaunch: Object.freeze({
    operation: CANOPY_PIPELINE_LAUNCH_OPERATION,
    refusal: 'This operation does not accept a pipeline launch.',
  }),
  pipelineOwnerValues: Object.freeze({
    operation: CANOPY_PIPELINE_OWNER_VALUES_OPERATION,
    refusal: 'This operation does not accept pipeline owner values.',
  }),
  pipelineHostStep: Object.freeze({
    operation: 'worker.pipeline.hostRequest.respond',
    refusal: 'This operation does not accept host step values.',
  }),
} as const);

export type CanopyHostExecution = z.output<typeof CanopyHostExecutionSchema>;

export function canopyOperationAcceptsHostExecution(name: string): boolean {
  return CANOPY_HOST_EXECUTION_OPERATIONS.has(name);
}
