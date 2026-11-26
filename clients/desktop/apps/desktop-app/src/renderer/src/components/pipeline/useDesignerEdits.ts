import { useCallback, useMemo, useState } from 'react';
import type { Pipeline, Step } from '@canopy/execution-engine/types/pipeline';
import {
  insertWorkflowStep,
  moveWorkflowStep,
  newWorkflowStepId,
  removeWorkflowStep,
  setWorkflowStepId,
  type WorkflowDesignerEditResult,
} from '@canopy/pipeline-interop/workflow-designer-edits';
import {
  addWorkflowPath,
  removeWorkflowPath,
  removeWorkflowSplit,
  renameWorkflowPath,
  splittableWorkflowJobs,
  splitWorkflowJob,
} from '@canopy/pipeline-interop/workflow-designer-split-edits';
import {
  workflowDesignerRefusalMessage,
  workflowStepCatalogEntry,
  type WorkflowDesignerEditAction,
  type WorkflowDesignerEditing,
  type WorkflowStepChoice,
} from '@canopy/ui-app/workflows';
import { createJobId } from '../../lib/pipelineEditor';
import type { UsePipelineEditorReturn } from '../../hooks/usePipelineEditor';

export interface DesignerEdits {
  /** Undefined when the workflow can't be edited. */
  readonly editing: WorkflowDesignerEditing | undefined;
  readonly notice: { message: string; onDismiss: () => void } | undefined;
  /**
   * Bumped by every applied insert, move and remove. Such an edit can put a
   * different step at the selected position, so whatever the host decided
   * for the selected step (its panel, its router lock) is decided again.
   */
  readonly revision: number;
  /**
   * Sets a step's ID through the designer's check. Returns why it was
   * refused, or null once applied.
   */
  readonly renameStep: (
    jobId: string,
    stepIndex: number,
    id: string | undefined,
  ) => string | null;
  /**
   * Renames one of a split's paths, its route and guard together. Returns
   * why it was refused, or null once applied.
   */
  readonly renamePath: (
    jobId: string,
    pathJobId: string,
    label: string,
  ) => string | null;
}

/** The step a picker choice adds, named after its task. */
function stepFor(
  pipeline: Pipeline,
  jobId: string,
  choice: Exclude<WorkflowStepChoice, { readonly kind: 'split' }>,
): Step {
  if (choice.kind === 'script')
    return {
      id: newWorkflowStepId(pipeline, jobId, 'script'),
      name: 'Run script',
      run: '',
    };
  if (choice.kind === 'custom')
    return { id: newWorkflowStepId(pipeline, jobId, 'action'), uses: '' };
  const uses = `builtin/${choice.actionId}`;
  const known = workflowStepCatalogEntry({ uses, script: false });
  return {
    id: newWorkflowStepId(pipeline, jobId, choice.actionId),
    ...(known ? { name: known.label } : {}),
    uses,
  };
}

/**
 * The designer's structural edits for the desktop editor (CAN-4224 phase
 * 02). Each one runs the pure edit, then applies the result as one editor
 * mutation, so undo, dirty tracking and validation see it like any edit. A
 * refused edit leaves the draft as it was and says why.
 */
export function useDesignerEdits(
  editor: UsePipelineEditorReturn,
): DesignerEdits {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const { pipeline, readonly, replaceEntirePipeline, setSelection } = editor;

  const apply = useCallback(
    (
      action: WorkflowDesignerEditAction,
      result: WorkflowDesignerEditResult,
    ): number | undefined | false => {
      if (!result.ok) {
        setRefusal(workflowDesignerRefusalMessage(action, result.refusal));
        return false;
      }
      setRefusal(null);
      replaceEntirePipeline(result.pipeline);
      setRevision((current) => current + 1);
      return result.stepIndex;
    },
    [replaceEntirePipeline],
  );

  // One projection, and only while the Designer shows its "+" buttons.
  const splittableJobs = useMemo(
    (): ReadonlySet<string> =>
      pipeline && !readonly && editor.mainView === 'designer'
        ? splittableWorkflowJobs(pipeline)
        : new Set(),
    [pipeline, readonly, editor.mainView],
  );

  const editing = useMemo((): WorkflowDesignerEditing | undefined => {
    if (!pipeline || readonly) return undefined;
    return {
      splittableJobs,
      onInsertStep: (jobId, index, choice) => {
        if (choice.kind === 'split') {
          // The router's step opens, to choose what it decides on.
          const at = apply('split', splitWorkflowJob(pipeline, jobId));
          if (at !== false && at !== undefined)
            setSelection({ type: 'step', jobId, stepIndex: at });
          return;
        }
        const at = apply(
          'insert',
          insertWorkflowStep(
            pipeline,
            jobId,
            index,
            stepFor(pipeline, jobId, choice),
          ),
        );
        if (at !== false && at !== undefined)
          setSelection({ type: 'step', jobId, stepIndex: at });
      },
      onRemoveStep: (jobId, stepIndex) => {
        if (
          apply('remove', removeWorkflowStep(pipeline, jobId, stepIndex)) !==
          false
        )
          setSelection({ type: 'none' });
      },
      onMoveStep: (jobId, from, to) => {
        const at = apply('move', moveWorkflowStep(pipeline, jobId, from, to));
        if (at !== false && at !== undefined)
          setSelection({ type: 'step', jobId, stepIndex: at });
      },
      onAddPath: (jobId) => {
        apply('add-path', addWorkflowPath(pipeline, jobId));
      },
      onRemovePath: (jobId, pathJobId) => {
        if (
          apply(
            'remove-path',
            removeWorkflowPath(pipeline, jobId, pathJobId),
          ) !== false
        )
          setSelection({ type: 'none' });
      },
      onRemoveSplit: (jobId, keepPathJobId) => {
        if (
          apply(
            'remove-split',
            removeWorkflowSplit(pipeline, jobId, keepPathJobId),
          ) !== false
        )
          setSelection({ type: 'none' });
      },
      onAddFirstStep: (choice) => {
        // A workflow with no steps has no job to end in paths.
        if (choice.kind === 'split') return;
        const jobId = createJobId(Object.keys(pipeline.jobs));
        const empty: Pipeline = {
          ...pipeline,
          jobs: { ...pipeline.jobs, [jobId]: { steps: [] } },
        };
        setRefusal(null);
        setRevision((current) => current + 1);
        replaceEntirePipeline({
          ...empty,
          jobs: {
            ...empty.jobs,
            [jobId]: { steps: [stepFor(empty, jobId, choice)] },
          },
        });
        setSelection({ type: 'step', jobId, stepIndex: 0 });
      },
    };
  }, [
    apply,
    pipeline,
    readonly,
    replaceEntirePipeline,
    setSelection,
    splittableJobs,
  ]);

  const renameStep = useCallback(
    (jobId: string, stepIndex: number, id: string | undefined) => {
      if (!pipeline) return null;
      const result = setWorkflowStepId(pipeline, jobId, stepIndex, id);
      if (!result.ok)
        return workflowDesignerRefusalMessage('rename', result.refusal);
      replaceEntirePipeline(result.pipeline);
      return null;
    },
    [pipeline, replaceEntirePipeline],
  );

  const renamePath = useCallback(
    (jobId: string, pathJobId: string, label: string) => {
      if (!pipeline) return null;
      const result = renameWorkflowPath(pipeline, jobId, pathJobId, label);
      if (!result.ok)
        return workflowDesignerRefusalMessage('rename-path', result.refusal);
      replaceEntirePipeline(result.pipeline);
      return null;
    },
    [pipeline, replaceEntirePipeline],
  );

  return {
    editing,
    renamePath,
    notice:
      refusal === null
        ? undefined
        : { message: refusal, onDismiss: () => setRefusal(null) },
    renameStep,
    revision,
  };
}
