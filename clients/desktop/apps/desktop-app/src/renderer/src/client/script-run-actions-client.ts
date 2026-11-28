import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  type CanopyErrorPayload,
  WorkerScriptExecutionClearResultSchema,
  WorkerScriptExecutionGetResultSchema,
  WorkerScriptExecutionGroupMembersResultSchema,
  WorkerScriptExecutionStopResultSchema,
  type WorkerScriptExecutionStopResult,
} from '@canopy/protocol/canopy-core';
import type {
  ScriptsSectionOrphanGroup,
  ScriptsSectionOrphanGroupMember,
  ScriptsSectionOrphanGroupStop,
} from '@canopy/ui-app';

/** A refused script action, with the refusal's code. */
export class ScriptActionError extends Error {
  readonly code: CanopyErrorPayload['code'];

  constructor(code: CanopyErrorPayload['code'], message: string) {
    super(message);
    this.name = 'ScriptActionError';
    this.code = code;
  }
}

/**
 * A user's Stop of an orphaned script run and Remove of a lost one
 * (CAN-6482), as worker.script instructions through the renderer relay.
 * Both are keyed: a retry with the same key never acts twice.
 */
async function instruct(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return request(method, {
    ...params,
    _meta: { idempotencyKey: crypto.randomUUID() },
  });
}

async function request(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (typeof window === 'undefined' || !window.canopyCore)
    throw new Error('Scripts are unavailable right now');
  const reply = await window.canopyCore.invoke({
    kind: 'request',
    method,
    params,
  });
  if (!reply.ok)
    throw new ScriptActionError(
      reply.error.code,
      scriptActionFailure(reply.error),
    );
  return reply.value;
}

function scriptActionFailure(error: CanopyErrorPayload): string {
  const { code } = error;
  if (code === 'worker.script.notOrphaned')
    return 'This run changed. Refresh the list and try again.';
  if (code === 'worker.script.executionInProgress')
    return 'This run is still running, so it can’t be removed.';
  if (code === 'worker.script.groupChanged')
    return 'This run’s processes changed since they were listed, so none was stopped. Try again.';
  if (code === 'worker.script.daemonUnavailable')
    return 'The background service isn’t reachable, so this run wasn’t stopped. Try again.';
  if (code === 'worker.script.outcomeUnknown')
    return 'The stop may have happened. The run’s status shows whether it did.';
  if (code === 'worker.script.notOwner')
    return 'This run was started by another part of the app, so it can’t be stopped here.';
  if (error.kind === 'capability_unavailable')
    return 'This computer can’t stop these processes.';
  return 'The script action didn’t finish. Try again.';
}

export interface ScriptRunTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly scriptKey: string;
  readonly executionId: string;
}

/**
 * The run `target` names, read again: `ended` when it no longer runs or
 * another run has taken its key, `running` while it runs or is orphaned, and
 * `unread` when the read failed, which is recorded.
 */
type ScriptRunReread = 'ended' | 'running' | 'unread';

async function rereadScriptRun(
  target: ScriptRunTarget,
): Promise<ScriptRunReread> {
  try {
    const value = await request('worker.script.execution.get', {
      scope: { workspaceId: target.projectId, worktreeId: target.worktreeId },
      scriptKey: target.scriptKey,
      tailLines: 0,
    });
    const { run } = WorkerScriptExecutionGetResultSchema.parse(value);
    if (run?.execution.executionId !== target.executionId) return 'ended';
    const { status } = run.execution;
    return status === 'running' || status === 'orphaned' ? 'running' : 'ended';
  } catch (readError) {
    reportClientAppError(readError);
    return 'unread';
  }
}

/**
 * Runs a Stop. When its outcome is unknown (CAN-7586), it reads the run again
 * and calls `ended` if the run has stopped. The Stop's error is thrown either
 * way; a run still running, or one that could not be read, stays as shown.
 */
async function stopWithReread<T>(
  target: ScriptRunTarget,
  stop: () => Promise<T>,
  ended: () => void,
): Promise<T> {
  try {
    return await stop();
  } catch (error) {
    if (
      error instanceof ScriptActionError &&
      error.code === 'worker.script.outcomeUnknown' &&
      (await rereadScriptRun(target)) === 'ended'
    )
      ended();
    throw error;
  }
}

export async function stopOrphanedScriptRun(
  target: ScriptRunTarget,
  stopRequest: { readonly mode: 'stop' | 'force'; readonly confirmed: boolean },
  ended: () => void,
): Promise<WorkerScriptExecutionStopResult['outcome']> {
  const value = await stopWithReread(
    target,
    () =>
      instruct('worker.script.execution.stop', {
        scope: { workspaceId: target.projectId, worktreeId: target.worktreeId },
        scriptKey: target.scriptKey,
        executionId: target.executionId,
        mode: stopRequest.mode,
        ...(stopRequest.confirmed && { confirmed: true }),
      }),
    ended,
  );
  return WorkerScriptExecutionStopResultSchema.parse(value).outcome;
}

/** An orphaned run's live processes once its main process has ended (CAN-6601). */
export async function listOrphanedScriptRunGroup(
  target: ScriptRunTarget,
): Promise<ScriptsSectionOrphanGroup> {
  const value = await request('worker.script.execution.groupMembers', {
    scope: { workspaceId: target.projectId, worktreeId: target.worktreeId },
    scriptKey: target.scriptKey,
    executionId: target.executionId,
  });
  const group = WorkerScriptExecutionGroupMembersResultSchema.parse(value);
  return {
    state: group.state,
    offerable: group.offerable,
    members: group.members.map((member) => ({
      pid: member.pid,
      startIdentity: member.startIdentity,
      startedAt: Date.parse(member.startedAt),
      command: member.command,
    })),
  };
}

/** A confirmed group Force stop of exactly the members the user saw (CAN-6601). */
export async function forceStopOrphanedScriptRunGroup(
  target: ScriptRunTarget,
  members: readonly ScriptsSectionOrphanGroupMember[],
  ended: () => void,
): Promise<ScriptsSectionOrphanGroupStop> {
  const value = await stopWithReread(
    target,
    () =>
      instruct('worker.script.execution.stop', {
        scope: { workspaceId: target.projectId, worktreeId: target.worktreeId },
        scriptKey: target.scriptKey,
        executionId: target.executionId,
        mode: 'force_group',
        confirmed: true,
        members: members.map((member) => ({
          pid: member.pid,
          startIdentity: member.startIdentity,
        })),
      }),
    ended,
  );
  const result = WorkerScriptExecutionStopResultSchema.parse(value);
  return {
    outcome:
      result.outcome === 'stopped' || result.outcome === 'unverifiable'
        ? result.outcome
        : 'still_running',
    members: result.members ?? [],
  };
}

/** True when the run's record and output were removed. */
export async function clearScriptRun(
  target: ScriptRunTarget,
): Promise<boolean> {
  const value = await instruct('worker.script.execution.clear', {
    scope: { workspaceId: target.projectId, worktreeId: target.worktreeId },
    scriptKey: target.scriptKey,
    executionId: target.executionId,
  });
  return WorkerScriptExecutionClearResultSchema.parse(value).cleared;
}
