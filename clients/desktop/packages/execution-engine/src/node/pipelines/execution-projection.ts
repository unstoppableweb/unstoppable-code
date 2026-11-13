import { createHash } from 'node:crypto';
import {
  WORKER_PIPELINE_ERROR_MAX_LENGTH,
  WORKER_PIPELINE_DETAIL_ITEMS_MAX,
  WORKER_PIPELINE_DETAIL_MODEL_MAX_LENGTH,
  WORKER_PIPELINE_DETAIL_NAME_MAX_LENGTH,
  WORKER_PIPELINE_DETAIL_PAUSES_MAX,
  WORKER_PIPELINE_MATRIX_VALUES_MAX_BYTES,
  WORKER_PIPELINE_PAUSE_REQUESTS_MAX_BYTES,
  WorkerPipelineHookTriggerSchema,
  WorkerPipelineInitiatorSchema,
  WorkerPipelinePauseRequestSchema,
  WorkerPipelineVariantDetailSchema,
  type WorkerPipelineArtifact,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionDetail,
  type WorkerPipelineExecutionView,
  type WorkerPipelineJobDetail,
  type WorkerPipelinePauseDetail,
  type WorkerPipelineStatusReason,
  type WorkerPipelineStepDetail,
  type WorkerPipelineVariantDetail,
} from '@canopy/protocol/canopy-core';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  ExecutionState,
  JobResult,
  PipelineStatusReason,
  StepResult,
} from '../../types/pipeline';

/*
 * Absolute host paths in error text: POSIX and home-relative paths not
 * inside a word or URL, Windows drive paths, and UNC shares. Errors carry
 * them verbatim from the host (an ENOENT names the file), and host paths
 * never cross this boundary.
 */
const HOST_PATH_PATTERN =
  /(?<![\w.:/~-])~?\/[^\s'"`<>|)\]},;]+|\b[A-Za-z]:\\[^\s'"`<>|)\]},;]*|\\\\[^\s'"`<>|)\]},;]+/g;

/** Error text a client may see: host paths replaced, then bounded. */
export function portableErrorText(text: string): string {
  return text
    .replace(HOST_PATH_PATTERN, '<path>')
    .slice(0, WORKER_PIPELINE_ERROR_MAX_LENGTH);
}

/** Where a run's definition came from, by its preference locator. */
export function definitionSourceOf(
  locator: ExecutionState['pipeline_preference_locator'],
): WorkerPipelineExecution['definitionSource'] {
  if (locator === undefined) return 'inline';
  if (locator.type === 'stored') return locator.source;
  return locator.type === 'shared' ? 'shared' : 'project';
}

/** The run's owner as the summary carries it; one that isn't a context is `null`. */
function ownerOf(state: ExecutionState): string | null {
  const owner = state.execution_context;
  return owner !== undefined && parseWorkspaceContext(owner) !== null
    ? owner
    : null;
}

export function projectPipelineExecution(
  state: ExecutionState,
): WorkerPipelineExecution {
  const statusReasonKinds = [
    ...new Set(state.status_reasons.map((reason) => reason.kind)),
  ];
  return {
    executionId: state.id,
    pipelineId: state.pipeline_id,
    name: state.pipeline_snapshot.name.slice(0, 512),
    status: state.status,
    runScope:
      state.scope ??
      (state.worktree_id !== undefined ? 'worktree' : 'directory'),
    definitionSource: definitionSourceOf(state.pipeline_preference_locator),
    owner: ownerOf(state),
    workspaceId: state.project_id ?? null,
    worktreeId: state.worktree_id ?? null,
    parentExecutionId: state.parent_execution_id ?? null,
    startedAt: new Date(state.started_at).toISOString(),
    completedAt:
      state.completed_at === undefined
        ? null
        : new Date(state.completed_at).toISOString(),
    pendingPauseCount: state.pending_pauses.length,
    ...(statusReasonKinds.length > 0 && { statusReasonKinds }),
    error: state.error === undefined ? null : portableErrorText(state.error),
  };
}

/*
 * The detail projection (CAN-6117). Each mapping below is exhaustive over the
 * executor's own union, so a value the executor gains fails to compile here
 * until the protocol enum names it too.
 */

type ReasonKind = PipelineStatusReason['kind'];
type ReasonCode = PipelineStatusReason['code'];
type Provider = NonNullable<StepResult['agent_provider']>;
type Harness = NonNullable<StepResult['agent_harness']>;

const REASON_KINDS: { readonly [K in ReasonKind]: K } = {
  provider_sign_in: 'provider_sign_in',
  app_shutdown: 'app_shutdown',
  owner_lost: 'owner_lost',
  host_rollover: 'host_rollover',
  input_required: 'input_required',
  action_paused: 'action_paused',
  provider_authentication_required: 'provider_authentication_required',
  provider_usage_limit: 'provider_usage_limit',
  provider_temporarily_unavailable: 'provider_temporarily_unavailable',
} satisfies Record<ReasonKind, WorkerPipelineStatusReason['kind']>;

const REASON_CODES: { readonly [K in ReasonCode]: K } = {
  provider_sign_in: 'provider_sign_in',
  app_shutdown: 'app_shutdown',
  owner_lost: 'owner_lost',
  host_rollover: 'host_rollover',
  input_requested: 'input_requested',
  action_requested_pause: 'action_requested_pause',
  authentication_failed: 'authentication_failed',
  unauthorized: 'unauthorized',
  oauth_organization_forbidden: 'oauth_organization_forbidden',
  http_401: 'http_401',
  rate_limit: 'rate_limit',
  usage_limit_exceeded: 'usage_limit_exceeded',
  credits_depleted: 'credits_depleted',
  http_429: 'http_429',
  model_capacity: 'model_capacity',
  server_overloaded: 'server_overloaded',
  internal_server_error: 'internal_server_error',
  http_5xx: 'http_5xx',
  connection_failed: 'connection_failed',
  stream_disconnected: 'stream_disconnected',
  provider_timeout: 'provider_timeout',
} satisfies Record<ReasonCode, WorkerPipelineStatusReason['code']>;

const PROVIDERS: { readonly [K in Provider]: K } = {
  claude: 'claude',
  codex: 'codex',
  ollama: 'ollama',
  cursor: 'cursor',
  opencode: 'opencode',
  copilot: 'copilot',
} satisfies Record<
  Provider,
  NonNullable<WorkerPipelineStatusReason['provider']>
>;

const HARNESSES: { readonly [K in Harness]: K } = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor',
  copilot: 'copilot',
  opencode: 'opencode',
} satisfies Record<Harness, NonNullable<WorkerPipelineStatusReason['harness']>>;

/** A stored time as the wire spells it; `null` when absent or unreadable. */
function timeOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function bounded(value: string | undefined, max: number): string | null {
  return value === undefined ? null : value.slice(0, max);
}

function nameOf(name: string | undefined, fallback: string): string {
  return (name ?? fallback).slice(0, WORKER_PIPELINE_DETAIL_NAME_MAX_LENGTH);
}

function currentAttempt(job: JobResult | undefined): number {
  return Math.max(job?.retry_count ?? 0, job?.retry_history?.length ?? 0);
}

function currentIteration(job: JobResult | undefined): number {
  return Math.max(1, job?.iteration_count ?? 1);
}

function projectStep(
  stepId: string,
  name: string | undefined,
  step: StepResult | undefined,
): WorkerPipelineStepDetail {
  const provider = step?.agent_provider;
  const harness = step?.agent_harness;
  const model = step?.agent_runtime_model ?? step?.agent_model;
  const hasAgent =
    provider !== undefined || harness !== undefined || model !== undefined;
  return {
    stepId,
    name: nameOf(name, stepId),
    status: step?.status ?? 'pending',
    conclusion: step?.conclusion ?? null,
    outcome: step?.outcome ?? null,
    startedAt: timeOf(step?.started_at),
    completedAt: timeOf(step?.completed_at),
    exitCode: step?.exit_code ?? null,
    error: step?.error === undefined ? null : portableErrorText(step.error),
    recoveryCount: step?.recovery_count ?? 0,
    childExecutionId: step?.child_execution_id ?? null,
    agent: hasAgent
      ? {
          provider: provider === undefined ? null : PROVIDERS[provider],
          harness: harness === undefined ? null : HARNESSES[harness],
          model: bounded(model, WORKER_PIPELINE_DETAIL_MODEL_MAX_LENGTH),
        }
      : null,
  };
}

/** A variant's values when the wire schema admits them within the size limit, else `null`. */
function matrixOf(
  values: Record<string, unknown> | undefined,
): WorkerPipelineVariantDetail['matrix'] {
  if (values === undefined) return null;
  const serialized = JSON.stringify(values);
  if (Buffer.byteLength(serialized) > WORKER_PIPELINE_MATRIX_VALUES_MAX_BYTES)
    return null;
  // The JSON round trip drops what JSON can't carry; the schema bounds the rest.
  const parsed = WorkerPipelineVariantDetailSchema.shape.matrix.safeParse(
    JSON.parse(serialized),
  );
  return parsed.success ? parsed.data : null;
}

function projectJobs(state: ExecutionState): WorkerPipelineJobDetail[] {
  return Object.entries(state.pipeline_snapshot.jobs)
    .slice(0, WORKER_PIPELINE_DETAIL_ITEMS_MAX)
    .map(([logicalJobId, logicalJob]): WorkerPipelineJobDetail => {
      const group = state.job_groups[logicalJobId];
      const physicalIds = group?.variant_job_ids.length
        ? group.variant_job_ids
        : // A job that never materialized runs as its logical id.
          group?.kind === 'matrix'
          ? []
          : [logicalJobId];
      const variants = physicalIds
        .slice(0, WORKER_PIPELINE_DETAIL_ITEMS_MAX)
        .map((physicalJobId): WorkerPipelineVariantDetail => {
          const definition = state.job_definitions[physicalJobId] ?? logicalJob;
          const result = state.jobs[physicalJobId];
          return {
            jobId: physicalJobId,
            name: nameOf(definition.name, physicalJobId),
            status: result?.status ?? 'pending',
            conclusion: result?.conclusion ?? null,
            outcome: result?.outcome ?? null,
            startedAt: timeOf(result?.started_at),
            completedAt: timeOf(result?.completed_at),
            attempt: currentAttempt(result),
            iteration: currentIteration(result),
            matrix:
              group?.kind === 'matrix' && 'matrix' in definition
                ? matrixOf(definition.matrix?.values)
                : null,
            steps: definition.steps
              .slice(0, WORKER_PIPELINE_DETAIL_ITEMS_MAX)
              .map((step) =>
                projectStep(step.id, step.name, result?.steps[step.id]),
              ),
          };
        });
      const single =
        group?.kind !== 'matrix' ? state.jobs[physicalIds[0]] : undefined;
      return {
        jobId: logicalJobId,
        name: nameOf(logicalJob.name, logicalJobId),
        kind: group?.kind ?? 'single',
        status: group?.status ?? single?.status ?? 'pending',
        conclusion: group?.conclusion ?? single?.conclusion ?? null,
        outcome: group?.outcome ?? single?.outcome ?? null,
        needs: logicalJob.needs.slice(0, WORKER_PIPELINE_DETAIL_ITEMS_MAX),
        expansion: group?.expansion ?? 'expanded',
        expansionError:
          group?.error === undefined ? null : portableErrorText(group.error),
        startedAt: timeOf(group?.started_at ?? single?.started_at),
        completedAt: timeOf(group?.completed_at ?? single?.completed_at),
        maxParallel: group?.resolved_max_parallel ?? null,
        variants,
      };
    });
}

function projectPauses(state: ExecutionState): WorkerPipelinePauseDetail[] {
  let remaining = WORKER_PIPELINE_PAUSE_REQUESTS_MAX_BYTES;
  const startedAt = new Date(state.started_at).toISOString();
  return state.pending_pauses
    .slice(0, WORKER_PIPELINE_DETAIL_PAUSES_MAX)
    .map((checkpoint): WorkerPipelinePauseDetail => {
      const identity: WorkerPipelinePauseDetail = {
        id: checkpoint.id,
        kind: checkpoint.kind,
        jobId: checkpoint.job_id,
        logicalJobId: checkpoint.logical_job_id,
        stepId: checkpoint.step_id,
        attempt: checkpoint.attempt,
        iteration: checkpoint.iteration,
        detectedAt: timeOf(checkpoint.detected_at) ?? startedAt,
      };
      if (!checkpoint.request) return identity;
      const parsed = WorkerPipelinePauseRequestSchema.safeParse({
        ...(checkpoint.request.title !== undefined && {
          title: checkpoint.request.title,
        }),
        ...(checkpoint.request.message !== undefined && {
          message: checkpoint.request.message,
        }),
        fields: checkpoint.request.fields,
      });
      const bytes = parsed.success
        ? Buffer.byteLength(JSON.stringify(parsed.data))
        : Infinity;
      if (!parsed.success || bytes > remaining)
        return { ...identity, requestUnavailableReason: 'too_large' };
      remaining -= bytes;
      return { ...identity, request: parsed.data };
    });
}

function projectReasons(state: ExecutionState): WorkerPipelineStatusReason[] {
  const startedAt = new Date(state.started_at).toISOString();
  return state.status_reasons
    .slice(0, WORKER_PIPELINE_DETAIL_PAUSES_MAX)
    .map((reason): WorkerPipelineStatusReason => {
      const resetsAt = timeOf(reason.resets_at);
      return {
        id: reason.id,
        kind: REASON_KINDS[reason.kind],
        code: REASON_CODES[reason.code],
        ...(reason.provider !== undefined && {
          provider: PROVIDERS[reason.provider],
        }),
        ...(reason.agent_harness !== undefined && {
          harness: HARNESSES[reason.agent_harness],
        }),
        ...(reason.account_scope !== undefined && {
          accountScope: reason.account_scope,
        }),
        ...(reason.model !== undefined && {
          model: reason.model.slice(0, WORKER_PIPELINE_DETAIL_MODEL_MAX_LENGTH),
        }),
        detectedAt: timeOf(reason.detected_at) ?? startedAt,
        ...(resetsAt !== null && { resetsAt }),
        ...(reason.auto_resume_suppressed === true && {
          autoResumeSuppressed: true,
        }),
        source: {
          jobId: reason.source.job_id,
          stepId: reason.source.step_id,
          attempt: reason.source.attempt,
          iteration: reason.source.iteration,
          ...(reason.source.child_execution_id !== undefined && {
            childExecutionId: reason.source.child_execution_id,
          }),
          ...(reason.source.child_reason_id !== undefined && {
            childReasonId: reason.source.child_reason_id,
          }),
        },
      };
    });
}

/** Saved reports by where they were saved: the run, then each job and step. */
function projectArtifacts(state: ExecutionState): WorkerPipelineArtifact[] {
  const artifacts: WorkerPipelineArtifact[] = [];
  const add = (
    outputs: ExecutionState['report_outputs'],
    jobId: string | null,
    stepId: string | null,
  ): void => {
    if (outputs?.report_file) artifacts.push({ kind: 'report', jobId, stepId });
    if (outputs?.report_json_file)
      artifacts.push({ kind: 'report_json', jobId, stepId });
  };
  add(state.report_outputs, null, null);
  for (const [jobId, job] of Object.entries(state.jobs)) {
    add(job.report_outputs, jobId, null);
    for (const [stepId, step] of Object.entries(job.steps))
      add(step.report_outputs, jobId, stepId);
  }
  return artifacts.slice(0, WORKER_PIPELINE_DETAIL_ITEMS_MAX);
}

function projectInitiation(
  state: ExecutionState,
): WorkerPipelineExecutionDetail['initiation'] {
  const initiator =
    state.initiator?.kind === 'automation'
      ? {
          kind: 'automation' as const,
          automationId: state.initiator.automationId,
          ...(state.initiator.automationName !== undefined && {
            automationName: state.initiator.automationName,
          }),
        }
      : state.initiator;
  const hook = state.trigger_source;
  const parsedInitiator = WorkerPipelineInitiatorSchema.safeParse(initiator);
  const parsedHook = WorkerPipelineHookTriggerSchema.safeParse(
    hook && {
      hookKey: hook.hook_key,
      hookLabel: hook.hook_label,
      triggerName: hook.trigger_name,
      target: hook.target,
      ...(hook.repo_id !== undefined && { repoId: hook.repo_id }),
      ...(hook.repo_name !== undefined && { repoName: hook.repo_name }),
      actionIndex: hook.action_index,
      triggeredAt: timeOf(hook.triggered_at),
    },
  );
  return {
    // As the usage records attribute it.
    source:
      hook?.kind === 'hook' ? 'hook' : (state.initiation_source ?? 'user'),
    initiator: parsedInitiator.success ? parsedInitiator.data : null,
    hook: parsedHook.success ? parsedHook.data : null,
    event: state.event_name ?? null,
    rerunSourceId: state.rerun_source_id ?? null,
    parentStep:
      state.parent_step_id !== undefined
        ? {
            stepId: state.parent_step_id,
            attempt: state.parent_attempt ?? 0,
            iteration: state.parent_iteration ?? 0,
          }
        : null,
  };
}

/** The digest a detail's `revision` carries, over everything else the view holds. */
function revisionOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function projectPipelineExecutionDetail(
  state: ExecutionState,
  execution: WorkerPipelineExecution = projectPipelineExecution(state),
): WorkerPipelineExecutionDetail {
  const curated = state.curated_pipeline_source;
  const locator = state.pipeline_preference_locator;
  const replay = state.rerun_context?.event_data;
  const rest: Omit<WorkerPipelineExecutionDetail, 'revision'> = {
    definition: {
      contentHash:
        curated?.contentHash ??
        (locator?.type === 'stored' ? (locator.contentHash ?? null) : null),
      revision: curated?.revision ?? null,
      packageDigest: state.pipeline_package_snapshot?.digest ?? null,
    },
    initiation: projectInitiation(state),
    rerun: {
      inputsPersisted: state.inputs_persisted !== false,
      planReadyText: Boolean(replay?.plan_ready?.plan_text),
      taskReadyText: Boolean(replay?.task_ready?.task_text),
    },
    hidden: state.hidden === true,
    pausedAt: timeOf(state.paused_at),
    pausedMs: Math.max(0, Math.floor(state.paused_ms ?? 0)),
    plan:
      state.planId !== undefined || state.plan_hash_after !== undefined
        ? {
            planId: state.planId ?? null,
            saved: state.plan_hash_after !== undefined,
            modified:
              state.plan_hash_before !== undefined &&
              state.plan_hash_after !== undefined &&
              state.plan_hash_before !== state.plan_hash_after,
          }
        : null,
    artifacts: projectArtifacts(state),
    jobs: projectJobs(state),
    pendingPauses: projectPauses(state),
    statusReasons: projectReasons(state),
  };
  return { revision: revisionOf({ execution, detail: rest }), ...rest };
}

/** The summary, with the detail when asked for. */
export function projectPipelineExecutionView(
  state: ExecutionState,
  options: { detail: boolean },
): WorkerPipelineExecutionView {
  const execution = projectPipelineExecution(state);
  return options.detail
    ? { execution, detail: projectPipelineExecutionDetail(state, execution) }
    : { execution };
}
