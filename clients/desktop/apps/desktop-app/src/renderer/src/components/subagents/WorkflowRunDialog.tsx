import { useEffect, type JSX } from 'react';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import { WorkflowRunView } from '@/components/activity/WorkflowRunView';
import { DialogModal } from '@/components/shared/DialogModal';
import { useWorkflowRun } from '@/hooks/useWorkflowRun';
import { reportBackgroundProcessSelection } from '@/lib/current-ui-state/backgroundProcessesUiState';
import { useActivityStore } from '@/stores/activityStore';
import { subagentScopeKey, type SubagentHostScope } from './subagent-scope';

export interface WorkflowRunDialogTarget {
  readonly runId: string;
  readonly transcriptDir: string;
  readonly title: string;
  /** The run's background task, when its launch receipt named one. */
  readonly taskId?: string;
}

export interface WorkflowRunDialogProps {
  readonly scope: SubagentHostScope;
  readonly target: WorkflowRunDialogTarget | null;
  readonly onClose: () => void;
}

/**
 * Reuses the activity surface for a workflow run opened from subagents. It
 * reports the run as the selected background process while open, as the
 * chat's own workflow modal does, so App Advisor sees the same UI state.
 */
export function WorkflowRunDialog({
  scope,
  target,
  onClose,
}: WorkflowRunDialogProps): JSX.Element {
  const paired = isPairedComputerId(scope.projectId);
  const workflow = useWorkflowRun(
    paired ? undefined : target?.transcriptDir,
    paired ? undefined : target?.runId,
    false,
  );
  const taskId = target?.taskId;

  useEffect(() => {
    if (!taskId) return undefined;
    const report = (selectedTaskId: string | null): void =>
      reportBackgroundProcessSelection({
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        processes:
          useActivityStore.getState().bgProcesses[subagentScopeKey(scope)] ??
          [],
        selectedTaskId,
      });
    report(taskId);
    return (): void => report(null);
  }, [scope, taskId]);

  if (!target) return <></>;

  return (
    <DialogModal
      onClose={onClose}
      title={target.title}
      maxWidth="3xl"
      dataTestId="subagent-workflow-dialog"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <WorkflowRunView
          run={workflow.run}
          transcriptDir={paired ? undefined : target.transcriptDir}
          loading={workflow.loading}
        />
      </div>
    </DialogModal>
  );
}
