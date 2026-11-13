/**
 * Desktop main's `PipelineHostActions`: the core-side policy point for host
 * steps (`runs.using: host`).
 *
 * The shared executor (worker side) validates inputs and raises one typed
 * request; this adapter resolves the task, applies the owner check and does
 * the work through main-owned services. Typed refusals become failure results
 * that keep every action output; unexpected errors are logged and rethrown so
 * the step fails with their message.
 *
 * Idempotency: the request's key arrives in `caller.idempotencyKey`. Group
 * membership is idempotent by construction (re-running yields the same
 * membership; only `group_created` reads `false` on the re-run), so no receipt
 * is recorded. `create-worktree` uses the keyed W5 creation receipt plus its
 * attempt journal. `wait-for-agent-reply` writes no chat state; it pins the
 * turn it bound under the attempt's host artifacts folder.
 *
 * The owner check is required: production wires the execution-owner policy,
 * and there is no permissive default.
 *
 * Group names are user text: never logged, and errors name only IDs.
 */
import type { BrowserWindow } from 'electron';
import {
  emptyMoveToGroupOutputs,
  PipelineHostRefusal,
  type MoveToGroupInputs,
  type MoveToGroupNotGroupedReason,
} from '@canopy/execution-engine/pipelines/host-actions';
import type { SidebarItemGroupScope } from '@canopy/protocol/sidebar';
import { emptyCreateWorktreeOutputs } from '@canopy/execution-engine/pipelines/host-create-worktree';
import {
  emptyCreateBotEntryOutputs,
  emptyCreateProjectEntryOutputs,
} from '@canopy/execution-engine/pipelines/host-create-entry';
import { emptySendAgentMessageOutputs } from '@canopy/execution-engine/pipelines/host-send-agent-message';
import { emptyWaitForAgentReplyOutputs } from '@canopy/execution-engine/pipelines/host-wait-for-agent-reply';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionRequest,
  PipelineHostActionResult,
  PipelineHostActions,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  sidebarItemGroupsService,
  SidebarItemGroupRefusalError,
} from '../services/sidebar-item-groups-service';
import {
  resolveTask,
  type PipelineHostOwnerCheck,
} from './host-task-resolution';
import { runCreateWorktreeHostAction } from './host-create-worktree';
import {
  runCreateBotEntryHostAction,
  runCreateProjectEntryHostAction,
  type CreateEntryHostDeps,
} from './host-create-entry';
import {
  runSendAgentMessageHostAction,
  type SendAgentMessageHostDeps,
} from './host-send-agent-message';

export type {
  PipelineHostOwnerCheck,
  PipelineHostTarget,
} from './host-task-resolution';

function notGrouped(
  reason: MoveToGroupNotGroupedReason,
): Record<string, string> {
  return {
    group_id: '',
    group_name: '',
    group_created: 'false',
    grouped: 'false',
    not_grouped_reason: reason,
  };
}

function grouped(
  groupId: string,
  groupName: string,
  created: boolean,
): Record<string, string> {
  return {
    group_id: groupId,
    group_name: groupName,
    group_created: String(created),
    grouped: 'true',
    not_grouped_reason: '',
  };
}

/** Group problems never fail the step (D12): a refusal is a successful `grouped: false`. */
async function applyGroupTarget(
  scope: SidebarItemGroupScope,
  taskId: string,
  target: MoveToGroupInputs['target'],
): Promise<Record<string, string>> {
  try {
    switch (target.kind) {
      case 'remove':
        await sidebarItemGroupsService.moveItem({
          scope,
          itemId: taskId,
          groupId: null,
        });
        return notGrouped('removed');
      case 'id': {
        await sidebarItemGroupsService.moveItem({
          scope,
          itemId: taskId,
          groupId: target.groupId,
        });
        const groups = await sidebarItemGroupsService.list(scope);
        const group = groups.find(
          (candidate) => candidate.id === target.groupId,
        );
        return grouped(target.groupId, group?.name ?? '', false);
      }
      case 'name': {
        const { group, created } =
          await sidebarItemGroupsService.assignItemToNamedGroup({
            scope,
            itemId: taskId,
            name: target.name,
            ...(target.color ? { color: target.color } : {}),
          });
        return grouped(group.id, group.name, created);
      }
    }
  } catch (error) {
    if (error instanceof SidebarItemGroupRefusalError) {
      return notGrouped(error.code);
    }
    throw error;
  }
}

async function runMoveToGroup(
  inputs: MoveToGroupInputs,
  caller: PipelineHostActionCaller,
  assertTargetOwner: PipelineHostOwnerCheck,
  signal: AbortSignal,
): Promise<PipelineHostActionResult> {
  const { target, scope } = await resolveTask(inputs.task);
  await assertTargetOwner(caller, target);
  // The executor has already reported a withdrawn step; don't start a sidebar change after it.
  signal.throwIfAborted();
  const outputs = await applyGroupTarget(
    scope,
    inputs.task.taskId,
    inputs.target,
  );
  return { status: 'success', outputs };
}

function emptyOutputsFor(
  action: PipelineHostActionRequest['action'],
): Record<string, string> {
  switch (action) {
    case 'move-to-group':
      return emptyMoveToGroupOutputs();
    case 'create-worktree':
      return emptyCreateWorktreeOutputs();
    case 'create-project-entry':
      return emptyCreateProjectEntryOutputs();
    case 'create-bot-entry':
      return emptyCreateBotEntryOutputs();
    case 'send-agent-message':
      return emptySendAgentMessageOutputs();
    case 'wait-for-agent-reply':
      return emptyWaitForAgentReplyOutputs();
  }
}

export function createDesktopPipelineHostActions(deps: {
  assertTargetOwner: PipelineHostOwnerCheck;
  getWindow?: () => BrowserWindow | null;
  /** Injected in tests; production builds a pipeline-bound port per call. */
  projectBotPortFor?: CreateEntryHostDeps['projectBotPortFor'];
  receipts?: CreateEntryHostDeps['receipts'];
  /** Injected in tests; production sends through the admitted send path. */
  sendDispatch?: SendAgentMessageHostDeps['dispatch'];
  hasTranscriptMessage?: SendAgentMessageHostDeps['hasTranscriptMessage'];
  /** Injected in tests; production reads the owned pipeline's grant. */
  resolveNativeGrant?: SendAgentMessageHostDeps['resolveNativeGrant'];
}): PipelineHostActions {
  const { assertTargetOwner } = deps;
  const entryDeps: CreateEntryHostDeps = {
    assertTargetOwner,
    ...(deps.projectBotPortFor
      ? { projectBotPortFor: deps.projectBotPortFor }
      : {}),
    ...(deps.receipts ? { receipts: deps.receipts } : {}),
  };
  const sendDeps: SendAgentMessageHostDeps = {
    assertTargetOwner,
    ...(deps.sendDispatch ? { dispatch: deps.sendDispatch } : {}),
    ...(deps.hasTranscriptMessage
      ? { hasTranscriptMessage: deps.hasTranscriptMessage }
      : {}),
    ...(deps.resolveNativeGrant
      ? { resolveNativeGrant: deps.resolveNativeGrant }
      : {}),
  };
  const getWindow = deps.getWindow ?? ((): BrowserWindow | null => null);
  return {
    async run(
      request: PipelineHostActionRequest,
      caller: PipelineHostActionCaller,
      signal: AbortSignal,
      controls?: PipelineHostActionControls,
    ): Promise<PipelineHostActionResult> {
      try {
        switch (request.action) {
          case 'move-to-group':
            return await runMoveToGroup(
              request.inputs,
              caller,
              assertTargetOwner,
              signal,
            );
          case 'create-worktree':
            return await runCreateWorktreeHostAction(
              request.inputs,
              caller,
              { assertTargetOwner, getWindow },
              signal,
              controls,
            );
          case 'create-project-entry':
            return await runCreateProjectEntryHostAction(
              request.inputs,
              caller,
              entryDeps,
              signal,
              controls,
            );
          case 'create-bot-entry':
            return await runCreateBotEntryHostAction(
              request.inputs,
              caller,
              entryDeps,
              signal,
              controls,
            );
          case 'send-agent-message':
            return await runSendAgentMessageHostAction(
              request.inputs,
              caller,
              sendDeps,
              signal,
              controls,
            );
          case 'wait-for-agent-reply': {
            // Deferred so main's startup graph never loads chat state and
            // project discovery through the pipeline host.
            const { runWaitForAgentReplyHostAction } =
              await import('./host-wait-for-agent-reply');
            return await runWaitForAgentReplyHostAction(
              request.inputs,
              caller,
              { assertTargetOwner },
              signal,
              controls,
            );
          }
        }
      } catch (error) {
        if (error instanceof PipelineHostRefusal) {
          return {
            status: 'failure',
            failureReason: error.failureReason,
            error: error.message,
            outputs: emptyOutputsFor(request.action),
          };
        }
        // The error itself is recorded; the request (and its names) is not.
        if (!signal.aborted) {
          logMainProcessError('Pipeline host action failed', error);
        }
        throw error;
      }
    },
  };
}
