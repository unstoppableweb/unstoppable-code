import { useMemo, type JSX, type ReactNode } from 'react';
import type { BackgroundTaskStopRequest } from '@canopy/app-core';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import type {
  BackgroundTaskDetail,
  BackgroundTaskHostActions,
} from '@canopy/ui-app';
import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import { useWorkflowRun } from '@/hooks/useWorkflowRun';
import { reportNativeTaskStopFailure } from '../chat/native-task-stop';
import { WorkflowRunView } from './WorkflowRunView';
import { isTerminalStatus } from './utils';
import { subscribeWorkflowRunProgress } from './workflow-progress';

function backgroundProcessDetail(
  process: BackgroundProcess,
  paired: boolean,
): BackgroundTaskDetail {
  return {
    providerTaskId: process.taskId,
    toolName: process.toolName,
    command: process.command,
    prompt: process.prompt,
    ...(paired
      ? {}
      : {
          runId: process.runId,
          outputLocationLabel: process.outputFile,
          outputSource: process.outputFile,
          outputGeneration: process.outputTaskId,
          outputStreamKey: process.outputTaskId ?? process.taskId,
        }),
  };
}

/** The workflow body the modal used to render inline; mounted only for workflow tasks. */
// eslint-disable-next-line react-refresh/only-export-components
function DesktopWorkflowRunBody({
  process,
}: {
  readonly process: BackgroundProcess;
}): JSX.Element {
  const workflow = useWorkflowRun(
    process.transcriptDir,
    process.runId,
    isTerminalStatus(process.status),
  );
  return (
    <WorkflowRunView
      run={workflow.run}
      transcriptDir={process.transcriptDir}
      loading={workflow.loading}
    />
  );
}

export function useBackgroundTaskActions({
  projectId,
  worktreeId,
  processes,
  onSelectedTaskIdChange,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly processes: readonly BackgroundProcess[];
  /** Receives the provider task id of the process whose modal opened, or null. */
  readonly onSelectedTaskIdChange?: (taskId: string | null) => void;
}): BackgroundTaskHostActions {
  return useMemo((): BackgroundTaskHostActions => {
    const paired =
      isPairedComputerId(projectId) || isPairedComputerId(worktreeId);
    const findProcess = (task: BackgroundTask): BackgroundProcess | undefined =>
      processes.find((process) => process.id === task.id);
    const baseActions: BackgroundTaskHostActions = {
      onSelectedTaskChange: onSelectedTaskIdChange
        ? (task): void =>
            onSelectedTaskIdChange(
              task ? (findProcess(task)?.taskId ?? null) : null,
            )
        : undefined,
      getDetail: (task): BackgroundTaskDetail | null => {
        const process = findProcess(task);
        return process ? backgroundProcessDetail(process, paired) : null;
      },
    };
    if (paired) {
      return baseActions;
    }
    return {
      ...baseActions,
      // Stop goes through `CanopyClient`; the task's own notification reports
      // the end, so nothing here marks the card stopped.
      stopTarget: (task): BackgroundTaskStopRequest | null => {
        const process = findProcess(task);
        return process?.taskId
          ? {
              projectId,
              worktreeId,
              chatId: process.chatId,
              taskId: process.taskId,
            }
          : null;
      },
      onStopError: (error): void =>
        reportNativeTaskStopFailure({ projectId, worktreeId }, error),
      readFullOutput: (outputSource) =>
        window.api.activity.readFullOutput({ outputFile: outputSource }),
      subscribeOutput: (streamKey, onLines) =>
        window.api.activity.onBgProcessOutput((event) => {
          if (event.taskId !== streamKey) return;
          onLines(event.lines);
        }),
      renderWorkflowRun: (task): ReactNode => {
        const process = findProcess(task);
        return process ? <DesktopWorkflowRunBody process={process} /> : null;
      },
      subscribeWorkflowProgress: (task, onProgress): (() => void) => {
        const process = findProcess(task);
        return process?.transcriptDir && process.runId
          ? subscribeWorkflowRunProgress(
              process.transcriptDir,
              process.runId,
              onProgress,
            )
          : (): void => {};
      },
    };
  }, [onSelectedTaskIdChange, processes, projectId, worktreeId]);
}
