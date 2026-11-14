import {
  type CanopyErrorPayload,
  WorkerScriptExecutionClearResultSchema,
  WorkerScriptExecutionGroupMembersResultSchema,
  WorkerScriptExecutionStopResultSchema,
  type WorkerScriptExecutionStopResult,
} from '@canopy/protocol/canopy-core';
import type {
  ScriptsSectionOrphanGroup,
  ScriptsSectionOrphanGroupMember,
  ScriptsSectionOrphanGroupStop,
} from '@canopy/ui-app';

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
  if (!reply.ok) throw new Error(scriptActionFailure(reply.error));
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

export async function stopOrphanedScriptRun(
  target: ScriptRunTarget,
  stopRequest: { readonly mode: 'stop' | 'force'; readonly confirmed: boolean },
): Promise<WorkerScriptExecutionStopResult['outcome']> {
  const value = await instruct('worker.script.execution.stop', {
    scope: { workspaceId: target.projectId, worktreeId: target.worktreeId },
    scriptKey: target.scriptKey,
    executionId: target.executionId,
    mode: stopRequest.mode,
    ...(stopRequest.confirmed && { confirmed: true }),
  });
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
): Promise<ScriptsSectionOrphanGroupStop> {
  const value = await instruct('worker.script.execution.stop', {
    scope: { workspaceId: target.projectId, worktreeId: target.worktreeId },
    scriptKey: target.scriptKey,
    executionId: target.executionId,
    mode: 'force_group',
    confirmed: true,
    members: members.map((member) => ({
      pid: member.pid,
      startIdentity: member.startIdentity,
    })),
  });
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
