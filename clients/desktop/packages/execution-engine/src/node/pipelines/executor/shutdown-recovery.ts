import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseAgentTranscriptLines } from '@canopy/agent-transcript';
import { transcriptHasAgentActivity } from '../../../lib/usage-limit-resume-prompt';
import { isRecord } from '../../lib/type-guards';
import {
  getExecutionHarnessForModel,
  getProviderForModel,
} from '../../../model-catalog';
import type { AgentActionFailureMetadata } from '../../../agent-failures';
import type { ExecutionState, NormalizedStep } from '../../../types/pipeline';
import { beginExecutionPause } from './execution-pause-clock';

export const APP_SHUTDOWN = 'app_shutdown';

export function isShutdownSignal(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === APP_SHUTDOWN;
}

/** Read the drained subprocess log without loading an entire transcript into memory. */
export async function readShutdownAgentMetadata(
  logFile: string,
  step: NormalizedStep,
  model?: string,
): Promise<AgentActionFailureMetadata> {
  const provider = (model ? getProviderForModel(model) : undefined) ?? 'claude';
  const harness =
    (model ? getExecutionHarnessForModel(model) : undefined) ?? 'claude';
  let sessionId: string | undefined;
  let hadActivity = false;
  const lines = createInterface({
    input: createReadStream(logFile),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const event = parsed;
    if (!sessionId && typeof event.session_id === 'string')
      sessionId = event.session_id;
    if (
      !sessionId &&
      event.type === 'thread.started' &&
      typeof event.thread_id === 'string'
    )
      sessionId = event.thread_id;
    hadActivity ||= transcriptHasAgentActivity(
      parseAgentTranscriptLines([line], harness).messages,
    );
  }
  const requestedSessionId = step.with?.session_id;
  if (
    !sessionId &&
    typeof requestedSessionId === 'string' &&
    !requestedSessionId.includes('${{')
  )
    sessionId = requestedSessionId;
  return {
    version: 1,
    provider,
    agent_harness: harness,
    ...(typeof sessionId === 'string' && sessionId
      ? { session_id: sessionId }
      : {}),
    had_agent_activity: hadActivity,
    transcript_file: logFile,
    message: 'Application stopped. Resume this step after restart.',
  };
}

/** Convert only shutdown-interrupted work, retaining completed work and existing blockers. */
export function pauseInterruptedExecution(
  state: ExecutionState,
  interruptedJobIds: ReadonlySet<string>,
): void {
  for (const [jobId, job] of Object.entries(state.jobs).sort(
    ([, a], [, b]) =>
      Number(b.status === 'cancelled' || b.status === 'running') -
      Number(a.status === 'cancelled' || a.status === 'running'),
  )) {
    if (
      (!interruptedJobIds.has(jobId) && job.status === 'cancelled') ||
      ['success', 'failure', 'skipped', 'paused'].includes(job.status)
    )
      continue;
    const unfinished = Object.entries(job.steps).filter(([, step]) =>
      ['pending', 'waiting_for_capacity', 'running', 'cancelled'].includes(
        step.status,
      ),
    );
    for (const [, step] of unfinished) {
      step.status = 'pending';
      step.conclusion = undefined;
      step.outcome = undefined;
      step.completed_at = undefined;
      step.error = undefined;
    }
    const first =
      (job.status === 'pending' ||
        job.status === 'queued' ||
        job.status === 'waiting_for_capacity') &&
      state.status_reasons.length > 0
        ? undefined
        : (unfinished[0] ?? Object.entries(job.steps).slice(-1)[0]);
    job.status = first ? 'paused' : 'pending';
    job.conclusion = undefined;
    job.outcome = undefined;
    job.completed_at = undefined;
    if (!first) continue;
    const [stepId, step] = first;
    if (!['success', 'failure', 'skipped', 'cancelled'].includes(step.status))
      step.status = 'paused';
    state.status_reasons.push({
      id: randomUUID(),
      kind: APP_SHUTDOWN,
      code: APP_SHUTDOWN,
      detected_at: new Date().toISOString(),
      source: {
        job_id: jobId,
        step_id: stepId,
        attempt: 0,
        iteration: Math.max(1, job.iteration_count ?? 1),
      },
    });
  }
  if (!state.status_reasons.length && !state.pending_pauses.length) {
    state.shutdown_checkpoint ??= {
      id: randomUUID(),
      detected_at: new Date().toISOString(),
    };
  }
  state.status = 'paused';
  state.completed_at = undefined;
  // A run interrupted by shutdown or a crash sits paused until the user
  // resumes it — often across restarts. That wait is not run time.
  beginExecutionPause(state);
}
