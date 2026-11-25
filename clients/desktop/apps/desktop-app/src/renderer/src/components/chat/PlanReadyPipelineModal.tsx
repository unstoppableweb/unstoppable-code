import { type JSX } from 'react';
import {
  PipelineTriggerModal,
  type PipelinePluginCollectionRunContext,
} from '@/components/activity/PipelineTriggerModal';
import type { PipelineWatcherSelection } from '@/components/activity/usePipelineRunWatcher';
import type { PipelineData } from '@canopy/execution-engine/types/pipeline';
import type {
  PipelineExecutionScope,
  ResolvedPipelineExecutionTarget,
} from '@canopy/execution-engine/types/pipeline';
import type { WatcherRecipientGroup } from '@/components/watchers/WatcherRecipientPicker';
import { usePipelineWorktreeContext } from '@/components/activity/usePipelineWorktreeContext';

export type PlanReadyPipelineModalOnRun = (
  pipelineId: string,
  pipeline: PipelineData,
  inputs: Record<string, string> | undefined,
  selectedRepoId: string | undefined,
  pluginCollectionContext: PipelinePluginCollectionRunContext,
) => Promise<void>;

interface PlanReadyPipelineModalProps {
  projectId?: string;
  worktreeId?: string;
  executionScope?: PipelineExecutionScope;
  executionTarget?: ResolvedPipelineExecutionTarget;
  onClose: () => void;
  onRun: PlanReadyPipelineModalOnRun;
  isRunning?: boolean;
  runError?: string | null;
  runErrorRecorded?: boolean;
  watcherRecipientGroups?: WatcherRecipientGroup[];
  onWatcherSelectionChange?: (
    selection: PipelineWatcherSelection | null,
  ) => void;
  ownerDocument?: Document;
}

export function PlanReadyPipelineModal({
  projectId,
  worktreeId,
  executionScope: persistedExecutionScope,
  executionTarget,
  onClose,
  onRun,
  isRunning = false,
  runError = null,
  runErrorRecorded = false,
  watcherRecipientGroups,
  onWatcherSelectionChange,
  ownerDocument,
}: PlanReadyPipelineModalProps): JSX.Element {
  const { cwd, repoChoices } = usePipelineWorktreeContext(
    projectId,
    worktreeId,
  );

  // A resolved worktree cwd means this surface runs in a worktree context, so
  // it should also list `directory`/legacy pipelines (via the capability
  // relation). Without a worktree cwd, fall back to `directory`.
  const executionScope =
    persistedExecutionScope ?? (cwd ? 'worktree' : 'directory');
  const resolvedCwd =
    executionTarget && 'path' in executionTarget ? executionTarget.path : cwd;
  const resolvedRepoChoices = executionScope === 'worktree' ? repoChoices : [];

  return (
    <PipelineTriggerModal
      triggerType="plan_ready"
      labels={{
        title: 'Run workflow',
        selectSubtitle: 'Select a workflow with plan_ready trigger',
        emptyMessage: 'No workflows with plan_ready trigger found',
      }}
      cwd={resolvedCwd}
      repoChoices={resolvedRepoChoices}
      executionScope={executionScope}
      onClose={onClose}
      onRun={onRun}
      isRunning={isRunning}
      runError={runError}
      runErrorRecorded={runErrorRecorded}
      watcherRecipientGroups={watcherRecipientGroups}
      onWatcherSelectionChange={onWatcherSelectionChange}
      ownerDocument={ownerDocument}
    />
  );
}
