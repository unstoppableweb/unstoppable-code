import type { ComponentProps, JSX } from 'react';
import { ATTACH_WORKFLOW_COPY, CreateWorkflowButton } from '@canopy/ui-app';
import {
  PipelineTriggerModal,
  type PipelineRepoChoice,
  type PipelinePluginCollectionRunContext,
} from '@/components/activity/PipelineTriggerModal';
import type { PipelineExecutionScope } from '@canopy/protocol/pipelines';
import type { PipelineWatcherSelection } from '@/components/activity/usePipelineRunWatcher';
import type {
  PipelineData,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import type { WatcherRecipientGroup } from '@/components/watchers/WatcherRecipientPicker';

interface TaskReadyPipelineModalProps {
  cwd?: string;
  repoChoices?: PipelineRepoChoice[];
  /**
   * Explicit execution-scope filter hint. Defaults to deriving from `cwd`
   * (`worktree` when resolved, `directory` otherwise) when omitted — callers
   * that resolve `cwd` for a target with no worktree concept (e.g. a cowork
   * root) must pass `'directory'` explicitly since a truthy `cwd` would
   * otherwise default to `worktree`.
   */
  executionScope?: PipelineExecutionScope;
  /** Preselects this pipeline in the list when present. */
  initialPipelineId?: string;
  /** See `PipelineTriggerModal`'s `initialPipelineSource`. */
  initialPipelineSource?: PipelineInfo['source'];
  /** Input seeds applied only while `initialPipelineId` is selected. */
  initialInputs?: Record<string, string>;
  onClose: () => void;
  onRun: (
    pipelineId: string,
    pipeline: PipelineData,
    inputs: Record<string, string> | undefined,
    selectedRepoId: string | undefined,
    pluginCollectionContext: PipelinePluginCollectionRunContext,
  ) => Promise<void>;
  isRunning?: boolean;
  runError?: string | null;
  watcherRecipientGroups?: WatcherRecipientGroup[];
  onWatcherSelectionChange?: (
    selection: PipelineWatcherSelection | null,
  ) => void;
  /**
   * The composer's Attach a workflow dialog (CAN-7513): the main action
   * inserts the configured workflow (`onRun`) instead of running it, and
   * Create a workflow (`onCreateWorkflow`) leads the footer.
   */
  attach?: { onCreateWorkflow: () => void };
  /**
   * An attached workflow Send could not run as inserted, opened for review:
   * its working directory and the settings it was inserted with.
   */
  review?: {
    selectedRepoId: string | undefined;
    settings: NonNullable<
      ComponentProps<typeof PipelineTriggerModal>['initialRunSettings']
    >;
  };
}

export function TaskReadyPipelineModal({
  cwd,
  repoChoices,
  executionScope: executionScopeOverride,
  initialPipelineId,
  initialPipelineSource,
  initialInputs,
  onClose,
  onRun,
  isRunning = false,
  runError = null,
  watcherRecipientGroups,
  onWatcherSelectionChange,
  attach,
  review,
}: TaskReadyPipelineModalProps): JSX.Element {
  // Task pipelines run against a worktree; a resolved worktree cwd makes this a
  // `worktree` surface (which also lists `directory`/legacy pipelines via the
  // capability relation). Fall back to `directory` if no cwd is available.
  // Callers targeting a non-worktree cwd (e.g. a cowork root) pass an
  // explicit override instead of relying on this default.
  const executionScope =
    executionScopeOverride ?? (cwd ? 'worktree' : 'directory');

  return (
    <PipelineTriggerModal
      triggerType="task_ready"
      labels={{
        title: attach ? ATTACH_WORKFLOW_COPY.title : 'Run task workflow',
        selectSubtitle: attach
          ? ATTACH_WORKFLOW_COPY.subtitle
          : 'Select a workflow with task_ready trigger',
        emptyMessage: 'No workflows with task_ready trigger found',
      }}
      {...(attach
        ? {
            runLabel: ATTACH_WORKFLOW_COPY.insertLabel,
            // Insert records the choices; only a run saves them as defaults.
            saveModelDefaultsOnSubmit: false,
            leadingAction: (
              <CreateWorkflowButton
                onCreate={attach.onCreateWorkflow}
                dataTestId="pipeline-trigger-modal-create"
              />
            ),
          }
        : {})}
      cwd={cwd}
      repoChoices={repoChoices}
      executionScope={executionScope}
      initialPipelineId={initialPipelineId}
      {...(initialPipelineSource === undefined
        ? {}
        : { initialPipelineSource })}
      initialInputs={initialInputs}
      {...(review
        ? {
            initialRunSettings: review.settings,
            ...(review.selectedRepoId === undefined
              ? {}
              : { defaultRepoId: review.selectedRepoId }),
          }
        : {})}
      onClose={onClose}
      onRun={onRun}
      isRunning={isRunning}
      runError={runError}
      watcherRecipientGroups={watcherRecipientGroups}
      onWatcherSelectionChange={onWatcherSelectionChange}
    />
  );
}
