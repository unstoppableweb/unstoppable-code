import { z } from 'zod';

import { CanopyJsonValueSchema } from '../errors';
import {
  CanopyChildEnvironmentSchema,
  type WorkerPipelineHostLaunch,
  WorkerPipelineLaunchEventSchema,
  WorkerPipelineLaunchInputsSchema,
  WorkerPipelineLaunchSnapshotSchema,
  WorkerPipelineModelAliasResolutionsSchema,
  WorkerPipelineModelCatalogSchema,
  WorkerPipelinePluginCollectionSnapshotsSchema,
} from '../host-execution';

/*
 * The portable pipeline start (CAN-6161, cloud pipelines CP-03): what a
 * remote primary, the web core, sends a cloud runner in
 * `worker.pipeline.execution.start` params. It is the host-local
 * `_execution.pipelineLaunch` (`WorkerPipelineHostLaunchSchema`, CAN-5086)
 * without host paths: the runner maps it to its own checkout, staged
 * actions, Node runtime and provider CLIs. Secrets cross only as the start's
 * `secrets` bindings (CAN-5067); `_execution` never crosses a relay.
 */

/** A definition's content hash: lowercase SHA-256 hex, as pipeline install pins record it. */
export const WORKER_PIPELINE_CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
/** A pipeline package digest, as pipeline install pins record it. */
export const WORKER_PIPELINE_PACKAGE_DIGEST_PATTERN =
  /^pp:v1:[A-Za-z0-9_-]{43}$/;

/** The longest delegation lease TTL a portable start carries: the longest timer delay. */
export const WORKER_PIPELINE_LEASE_TTL_MAX_MS = 2_147_483_647;

/**
 * The definition revision core admitted. The runner records it with the run
 * and fetches the definition's package by digest; it never resolves a
 * definition by name.
 */
export const WorkerPipelineDefinitionPinSchema = z.strictObject({
  contentHash: z.string().regex(WORKER_PIPELINE_CONTENT_HASH_PATTERN),
  /** `null` for a definition that ships without a package. */
  packageDigest: z
    .string()
    .regex(WORKER_PIPELINE_PACKAGE_DIGEST_PATTERN)
    .nullable(),
});

export const WorkerPipelinePortableLaunchSchema = z.strictObject({
  definition: z.strictObject({
    pin: WorkerPipelineDefinitionPinSchema,
    /** The admitted document, as `pipelineLaunch.pipeline` carries it. */
    snapshot: WorkerPipelineLaunchSnapshotSchema,
  }),
  inputs: WorkerPipelineLaunchInputsSchema.optional(),
  /**
   * The run's trigger event, as the host-local launch carries it (CAN-6327):
   * a cloud plan or a desktop tracked plan's text, or a task's. Absent for
   * `dispatch`.
   */
  event: WorkerPipelineLaunchEventSchema.optional(),
  /**
   * `ExecutionOptions.env`, layered over the runner's own base environment.
   * Not secret: secret values cross only by reference in `secrets`.
   */
  env: CanopyChildEnvironmentSchema,
  /** The run needs its owner (host and model steps): the runner holds it to the owner timers. */
  ownerBound: z.boolean().optional(),
  /**
   * The model registry the primary built for this run (CAN-5095). Without
   * it the host refuses every model step with `model_provider`.
   */
  modelCatalog: WorkerPipelineModelCatalogSchema.optional(),
  /** `ExecutionOptions.modelConfig` (CAN-5095). */
  modelConfig: CanopyJsonValueSchema.optional(),
  /** Stored and draft model alias preferences, merged as the primary's executor merges them (CAN-5832). */
  modelAliasPreferences: CanopyJsonValueSchema.optional(),
  /** What each model alias names for this run, as the primary resolved it (CAN-5832). */
  modelAliasResolutions: WorkerPipelineModelAliasResolutionsSchema.optional(),
  /** The run's draft plugin collection preferences, as its state records them (CAN-5832). */
  pluginCollectionPreferences: CanopyJsonValueSchema.optional(),
  /** The run's plugin collection snapshots: selection references, never MCP configuration (CAN-5832). */
  pluginCollectionSnapshots:
    WorkerPipelinePluginCollectionSnapshotsSchema.optional(),
  /** The shared or curated source the run records; identities, never paths. */
  sharedPipelineSource: CanopyJsonValueSchema.optional(),
  curatedPipelineSource: CanopyJsonValueSchema.optional(),
  /** Who started the run and the agent chat behind it, as the run records them. */
  initiator: CanopyJsonValueSchema.optional(),
  agentOrigin: CanopyJsonValueSchema.optional(),
  /**
   * The delegation lease the primary granted this runner incarnation
   * (ADR 31). The runner's remote-owner timers follow its TTL (CAN-6102);
   * the lease's identity and epoch come from the binding, never from params.
   */
  delegationLease: z.strictObject({
    leaseTtlMs: z.number().int().min(1).max(WORKER_PIPELINE_LEASE_TTL_MAX_MS),
  }),
});
export type WorkerPipelinePortableLaunch = z.output<
  typeof WorkerPipelinePortableLaunchSchema
>;

/** Host-local launch members with no portable counterpart. */
type WorkerPipelineHostOnlyLaunchMember = Exclude<
  keyof WorkerPipelineHostLaunch,
  keyof WorkerPipelinePortableLaunch
>;

/**
 * The host-local launch members a portable start leaves out, and why; the
 * runner supplies each from its own host. The type keeps it exhaustive, so a
 * new launch member is either portable or listed here.
 */
export const WORKER_PIPELINE_PORTABLE_LAUNCH_HOST_MEMBERS = Object.freeze({
  pipeline: 'Crosses as definition.snapshot, with its pin.',
  cwd: 'A host path: the runner runs in its own checkout.',
  bundledActionsDir: 'A host path: the runner stages its own bundled actions.',
  repoPath: 'A host path: the runner runs in its own checkout.',
  pipelineFileDir: 'A host path: the runner unpacks the pinned package.',
  pipelineDataDir: 'A host path under the runner data root.',
  assetsDir: 'A host path: the runner unpacks the pinned package.',
  assetPaths: 'Host paths: the runner unpacks the pinned package.',
  executionCheckoutRoot: 'A host path under the runner data root.',
  globalWorkspaceDir:
    "A host path: the runner names the pipeline's kept workspace under its data root.",
  secretEnv: 'Secret values: they cross only by reference in `secrets`.',
  target: 'Carries the worktree path; the runner derives it from runScope.',
  pipelinePreferenceLocator:
    'A file locator is a host path; the pin identifies the definition.',
  nodeProcess: 'The runner stages its own Node runtime for `node` steps.',
  tsxRuntime: 'The runner stages its own tsx CLI for `tsx` steps.',
  providerBinaries: 'The runner stages its own provider CLIs.',
  bundledResourcesDir:
    'A host path: the runner stages its own bundled resources and their builtin:app skills.',
  codexEnvironment:
    "The primary's Codex app-server environment; the runner builds its own.",
  precommitHooks:
    'Electron main runs the precommit-failure hook; a cloud run refuses git-commit-push until CP-30.',
} as const satisfies Record<WorkerPipelineHostOnlyLaunchMember, string>);
