/**
 * How an agent task's state shows on its transcript card, shared by every
 * host that renders cloud agent tasks (CAN-5976): the web's cloud task fold
 * and the desktop's web-core cloud chats compute the card the same way.
 */
import {
  isAgentTaskTerminalStatus,
  type AgentTaskRow,
} from '@canopy/protocol/cloud-session';
import type { RemoteControlChatAgentBlockData } from '@canopy/protocol/remote-control/shell';

/** The task fields a card reads. */
export type AgentTaskCardTask = Pick<
  AgentTaskRow,
  | 'taskId'
  | 'status'
  | 'approvalPending'
  | 'stopReason'
  | 'stoppable'
  | 'error'
  | 'summary'
  | 'background'
  | 'usage'
  | 'costUsd'
  | 'model'
  | 'createdAtMs'
  | 'startedAtMs'
  | 'completedAtMs'
>;

/** Whether the task has settled, as far as this build knows its status. */
export function isAgentTaskCardTerminal(
  task: Pick<AgentTaskRow, 'status'> | undefined,
): boolean {
  return (
    task !== undefined &&
    task.status !== 'unknown' &&
    isAgentTaskTerminalStatus(task.status)
  );
}

/** The fields a card takes from its task. */
export function agentTaskCardFields(
  task: AgentTaskCardTask,
): Partial<RemoteControlChatAgentBlockData> {
  const modelLabel = task.model?.label ?? task.model?.id;
  return {
    taskId: task.taskId,
    taskStatus: task.status,
    ...(task.approvalPending ? { taskApprovalPending: true } : {}),
    taskStopReason: task.stopReason,
    ...(task.stoppable === true ? { taskStoppable: true } : {}),
    ...(task.error?.message ? { taskErrorMessage: task.error.message } : {}),
    createdAt: task.createdAtMs,
    startedAt: task.startedAtMs,
    completedAt: task.completedAtMs,
    ...(modelLabel ? { modelLabel } : {}),
  };
}

/**
 * A card's result, running and error state. A background agent's spawn
 * result only says it started, so once its task settles the task's summary
 * (or error) is the result; a status this build does not know falls back to
 * the spawn call's own result.
 */
export function agentTaskCardState(input: {
  readonly task: AgentTaskCardTask | undefined;
  /** The spawn call's displayed result, when it has one. */
  readonly result:
    | { readonly output: string; readonly isError: boolean }
    | undefined;
  readonly runInBackground: boolean;
}): {
  readonly result: string | undefined;
  readonly isRunning: boolean;
  readonly isError: boolean;
  readonly background: boolean;
} {
  const { task } = input;
  const status = task?.status;
  const known = status !== undefined && status !== 'unknown';
  const terminal = isAgentTaskCardTerminal(task);
  const background = input.runInBackground || task?.background === true;
  let result = input.result?.output;
  if (terminal && (background || result === undefined)) {
    if (task?.summary != null) result = task.summary;
    else if (task?.error) result = task.error.message;
  }
  return {
    result,
    isRunning: known ? !terminal : result === undefined,
    isError: known
      ? status === 'failed' || status === 'lost'
      : input.result?.isError === true,
    background,
  };
}

/** A card's usage line from its task, with the tool calls the card shows. */
export function agentTaskCardUsage(
  task: AgentTaskCardTask | undefined,
  toolUses: number,
): RemoteControlChatAgentBlockData['usage'] {
  if (!task) return undefined;
  const u = task.usage;
  const durationMs =
    task.completedAtMs !== null && task.startedAtMs !== null
      ? task.completedAtMs - task.startedAtMs
      : undefined;
  const cost = task.costUsd === null ? undefined : Number(task.costUsd);
  const model = task.model?.label ?? task.model?.id;
  const usage: RemoteControlChatAgentBlockData['usage'] = {
    ...(u?.inputTokens === undefined ? {} : { inputTokens: u.inputTokens }),
    ...(u?.outputTokens === undefined ? {} : { outputTokens: u.outputTokens }),
    ...(u?.cacheReadTokens === undefined
      ? {}
      : { cacheReadInputTokens: u.cacheReadTokens }),
    ...(u?.cacheWriteTokens === undefined
      ? {}
      : { cacheCreationInputTokens: u.cacheWriteTokens }),
    ...(u?.contextTokens === undefined
      ? {}
      : { contextTokens: u.contextTokens }),
    ...(u?.contextWindow === undefined
      ? {}
      : { contextWindow: u.contextWindow }),
    ...(toolUses > 0 ? { toolUses } : {}),
    ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
    ...(cost !== undefined && Number.isFinite(cost)
      ? { totalCostUsd: cost }
      : {}),
    ...(model === undefined ? {} : { model }),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}
