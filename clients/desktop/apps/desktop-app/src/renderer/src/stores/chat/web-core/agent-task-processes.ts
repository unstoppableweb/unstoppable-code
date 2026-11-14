import { agentTaskBackgroundTasks } from '@canopy/agent-transcript/agent-tasks';
import type { AgentTaskRow } from '@canopy/protocol/cloud-session';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';

const TOOL_NAMES: Record<BackgroundProcess['kind'], string> = {
  agent: 'Task',
  bash: 'Bash',
  task: 'Task',
  workflow: 'Workflow',
};

/** Prefixes the id of every process a web core agent task publishes. */
const WEB_CORE_TASK_PROCESS_ID_PREFIX = 'web-core-task:';

/**
 * Whether the web core published `process` for a cloud chat's agent task.
 * Its transcript holds no launch for it, so a rebuild must keep it (CAN-6452).
 */
export function isWebCoreTaskProcess(process: BackgroundProcess): boolean {
  return process.id.startsWith(WEB_CORE_TASK_PROCESS_ID_PREFIX);
}

/**
 * A cloud chat's background work as the desktop tray lists a local chat's:
 * each agent task row the web core reports, through the same classification
 * the cloud chat page used (`agentTaskBackgroundTasks`). Cloud tasks offer no
 * Stop until the web core serves it (CAN-6107).
 */
export function cloudChatBackgroundProcesses(
  chatId: string,
  tasks: readonly AgentTaskRow[],
): BackgroundProcess[] {
  return agentTaskBackgroundTasks(tasks).map((task) => {
    const startedAt = task.startedAt ?? task.updatedAt;
    return {
      id: `${WEB_CORE_TASK_PROCESS_ID_PREFIX}${task.id}`,
      chatId,
      toolUseId:
        task.ownerToolUseId ?? `${WEB_CORE_TASK_PROCESS_ID_PREFIX}${task.id}`,
      taskId: task.id,
      toolName: TOOL_NAMES[task.kind],
      kind: task.kind,
      description: task.title,
      status: task.status,
      startedAt,
      updatedAt: task.updatedAt,
      ...(task.settledAt === null ? {} : { endedAt: task.settledAt }),
      ...(task.summary === null ? {} : { summary: task.summary }),
      ...(task.lastDescription === null
        ? {}
        : { lastDescription: task.lastDescription }),
      outputLines: [...task.outputLines],
      canStop: false,
    };
  });
}
