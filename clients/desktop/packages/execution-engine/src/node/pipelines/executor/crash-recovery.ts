import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import {
  isExecutionCancellationRequested,
  loadExecutionStateRevision,
  requestExecutionCancellation,
  saveExecutionStateIfUnchanged,
} from './execution-state';
import { refreshAllJobGroups } from '@canopy/execution-engine/node/pipelines/executor/job-scheduler';
import {
  cancelRecoveredExecutionState,
  isKnownOrphanedExecution,
} from './pipeline-executor';
import {
  buildAgentRecoveryStepResult,
  buildNestedPipelineOutputs,
} from './step-runner';
import { pauseInterruptedExecution } from '@canopy/execution-engine/node/pipelines/executor/shutdown-recovery';
import { pipelineOwnerFields } from '@canopy/execution-engine/node/pipelines/executor/owner-fence';

/**
 * A run a cloud runner recovers carries the recovering incarnation's lease
 * epoch (CAN-6198). Under the local fence, which records none, the state is
 * left as it was.
 */
function stampRecoveringLease(state: ExecutionState): ExecutionState {
  const epoch = pipelineOwnerFields().owner_lease_epoch;
  if (epoch !== undefined) state.owner_lease_epoch = epoch;
  return state;
}

function isTerminalExecutionStatus(
  status: ExecutionState['status'],
): status is 'success' | 'failure' | 'cancelled' {
  return status === 'success' || status === 'failure' || status === 'cancelled';
}

/** Recover only executions whose recorded process owner has exited. */
export async function recoverOrphanedPipelineExecutions(
  executionIds: readonly string[],
  executionsDir: string,
): Promise<string[]> {
  const errors: string[] = [];
  const recovered = new Map<string, ExecutionState | null>();
  const visiting = new Set<string>();
  const recover = async (
    id: string,
    cancelFromParent = false,
  ): Promise<ExecutionState | null> => {
    const cancelRecovered =
      cancelFromParent && recovered.get(id)?.status === 'paused';
    if (recovered.has(id) && !cancelRecovered) return recovered.get(id) ?? null;
    if (visiting.has(id))
      throw new Error(`Cyclic child execution reference: ${id}`);
    visiting.add(id);
    try {
      // A cancellation install that lost to another recovery's pause still
      // settles the request on the next attempt.
      let settleCancellation = cancelFromParent;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const loaded = await loadExecutionStateRevision(id, executionsDir);
        const state = loaded?.state ?? null;
        const expectedRevision = loaded?.revision;
        if (
          !state ||
          (!['pending', 'running'].includes(state.status) &&
            !(settleCancellation && state.status === 'paused')) ||
          (state.status !== 'paused' &&
            !(await isKnownOrphanedExecution(state)))
        ) {
          recovered.set(id, state);
          return state;
        }
        if (await isExecutionCancellationRequested(id, executionsDir)) {
          const children = Object.values(state.jobs).flatMap((job) =>
            Object.values(job.steps).flatMap((step) =>
              step.child_execution_id &&
              (step.status === 'running' ||
                (settleCancellation &&
                  ['paused', 'pending'].includes(step.status)))
                ? [step.child_execution_id]
                : [],
            ),
          );
          for (const childId of children) {
            await requestExecutionCancellation(childId, executionsDir);
            const child = await recover(childId, true);
            if (child && ['running', 'pending'].includes(child.status)) {
              throw new Error(
                `Child execution ${child.id} still has a live or unknown owner`,
              );
            }
          }
          const cancelled = stampRecoveringLease(
            cancelRecoveredExecutionState(state),
          );
          const installed = await saveExecutionStateIfUnchanged(
            cancelled,
            executionsDir,
            expectedRevision,
            { cancellation: 'clear_after', durable: true },
          );
          if (!installed) {
            settleCancellation = true;
            continue;
          }
          recovered.set(id, cancelled);
          return cancelled;
        }
        if (state.status === 'paused' && !cancelFromParent) {
          // The request was withdrawn after another recovery paused the run.
          recovered.set(id, state);
          return state;
        }
        const interrupted = new Set<string>();
        for (const [jobId, job] of Object.entries(state.jobs)) {
          if (
            ['success', 'failure', 'cancelled', 'skipped', 'paused'].includes(
              job.status,
            )
          )
            continue;
          interrupted.add(jobId);
          for (const [stepId, step] of Object.entries(job.steps)) {
            if (step.status !== 'running') continue;
            const definition = state.job_definitions[jobId]?.steps.find(
              (candidate) => candidate.id === stepId,
            );
            if (step.child_execution_id) {
              const child = await recover(step.child_execution_id);
              if (child && ['running', 'pending'].includes(child.status)) {
                throw new Error(
                  `Child execution ${child.id} still has a live or unknown owner`,
                );
              }
              if (child?.status === 'paused') {
                const reasons = child.status_reasons.map((reason) => ({
                  ...reason,
                  id: randomUUID(),
                  source: {
                    job_id: jobId,
                    step_id: stepId,
                    attempt: job.retry_count ?? 0,
                    iteration: Math.max(1, job.iteration_count ?? 1),
                    child_execution_id: child.id,
                    child_reason_id: reason.id,
                  },
                }));
                if (child.shutdown_checkpoint)
                  reasons.push({
                    id: randomUUID(),
                    kind: 'app_shutdown',
                    code: 'app_shutdown',
                    detected_at: child.shutdown_checkpoint.detected_at,
                    source: {
                      job_id: jobId,
                      step_id: stepId,
                      attempt: job.retry_count ?? 0,
                      iteration: Math.max(1, job.iteration_count ?? 1),
                      child_execution_id: child.id,
                      child_reason_id: child.shutdown_checkpoint.id,
                    },
                  });
                if (reasons.length) {
                  step.status = 'paused';
                  step.pause_reasons = reasons;
                  state.status_reasons.push(...reasons);
                  job.status = 'paused';
                  continue;
                }
              }
              if (child && isTerminalExecutionStatus(child.status)) {
                const status = child.status;
                Object.assign(step, {
                  status,
                  conclusion: status,
                  outcome: status,
                  completed_at: child.completed_at,
                  outputs: buildNestedPipelineOutputs(child),
                });
                if (
                  status === 'cancelled' ||
                  (status === 'failure' && !definition?.continue_on_error)
                ) {
                  Object.assign(job, {
                    status,
                    conclusion: status,
                    outcome: status,
                    completed_at: child.completed_at,
                  });
                  interrupted.delete(jobId);
                }
                continue;
              }
              // Missing child state or an action/input-only pause cannot safely
              // be replayed as a fresh nested pipeline. Keep a visible blocker.
              step.log_format_hint = 'agent';
            }
            if (
              definition?.uses === 'builtin/run-pipeline' &&
              !step.child_execution_id
            )
              step.log_format_hint = 'agent';
            if (
              definition &&
              ['builtin/agent-prompt', 'builtin/agent-resume'].includes(
                definition.uses ?? '',
              )
            ) {
              step.log_format_hint = 'agent';
              // Discard a prior attempt's checkpoint before reconstructing this
              // attempt from its log. Missing evidence must block automatic replay.
              delete step.agent_recovery;
              const result = step.log_file
                ? await buildAgentRecoveryStepResult({
                    result: {
                      ...step,
                      status: 'cancelled',
                      conclusion: 'cancelled',
                      outcome: 'cancelled',
                      log_file: step.log_file,
                    },
                    step: definition,
                    tempDir: join(executionsDir, id),
                    executionDir: join(executionsDir, id),
                    attempt: job.retry_count ?? 0,
                    iteration: Math.max(1, job.iteration_count ?? 1),
                    jobId,
                    stepId,
                    model: step.agent_model,
                    shutdown: true,
                    crashed: true,
                  })
                : null;
              if (result?.pause_reason) {
                // The catalog can change between launches. The saved process
                // metadata remains authoritative for this provider session.
                if (result.agent_recovery) {
                  result.agent_recovery.provider =
                    step.agent_provider ?? result.agent_recovery.provider;
                  result.agent_recovery.harness =
                    step.agent_harness ?? result.agent_recovery.harness;
                  result.pause_reason.provider = result.agent_recovery.provider;
                  result.pause_reason.agent_harness =
                    result.agent_recovery.harness;
                }
                Object.assign(step, result);
                state.status_reasons.push(result.pause_reason);
                job.status = 'paused';
              }
            }
          }
        }
        pauseInterruptedExecution(state, interrupted);
        refreshAllJobGroups(state);
        // A crash after the final step persisted must not turn completed work
        // into an unresumable pause with no checkpoint.
        if (
          !state.status_reasons.length &&
          !state.pending_pauses.length &&
          Object.values(state.job_groups).every((job) =>
            ['success', 'failure', 'cancelled', 'skipped'].includes(job.status),
          )
        ) {
          state.status = Object.values(state.jobs).some(
            (job) => job.status === 'failure',
          )
            ? 'failure'
            : Object.values(state.jobs).some(
                  (job) => job.status === 'cancelled',
                )
              ? 'cancelled'
              : 'success';
          state.completed_at = new Date().toISOString();
          delete state.shutdown_checkpoint;
        }
        // Another recovery may have installed this run first: re-read it, so
        // its reason IDs stand instead of being replaced by fresh ones.
        if (
          !(await saveExecutionStateIfUnchanged(
            stampRecoveringLease(state),
            executionsDir,
            expectedRevision,
          ))
        )
          continue;
        recovered.set(id, state);
        return state;
      }
      throw new Error(`Execution ${id} kept changing during recovery`);
    } finally {
      visiting.delete(id);
    }
  };
  for (const id of executionIds) {
    try {
      await recover(id);
    } catch (error) {
      errors.push(`Pipeline ${id}: ${String(error)}`);
    }
  }
  return errors;
}
