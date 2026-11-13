import type {
  PipelineData,
  PipelineExecutionScope,
} from '@canopy/execution-engine/types/pipeline';
import {
  PIPELINE_RUN_CONTEXT_COPY,
  type PipelineRunLocation,
  type PipelineRunOwnerField,
} from '@canopy/ui-app/workflows';
import { pipelineSupportsExecutionScope } from '@/lib/pipelineExecutionScope';
import type { PipelineRunOwnerChoices } from './usePipelineRunOwnerChoices';

/**
 * Where a Workflows run goes (CAN-4542). A run with no project names the
 * owner a person chose only for a pipeline without a saved owner.
 */
export type PipelineRunDestination =
  | {
      kind: 'global';
      requestedOwner?: string;
      /** Who owns the run, saved or chosen; a cloud run always names it. */
      owner: string;
      /** The owner the run is filed under, for the started toast. */
      ownerLabel: string;
      /** The owner differs from the selected navigation context. */
      outsideNavigation: boolean;
    }
  | { kind: 'current-task'; projectId: string; worktreeId: string };

export interface ResolvedRunContext {
  location: PipelineRunLocation;
  /** Shown when the pipeline can run with or without a project. */
  showLocation: boolean;
  currentTaskUnavailable: boolean;
  owner: PipelineRunOwnerField | null;
  /** The owner a person chose; absent for a saved owner or a task run. */
  requestedOwner: string | undefined;
  ownerValue: string | null;
  runBlocked: boolean;
  /** Why Run is off when no choice in the dialog can turn it on. */
  blockedReason?: string;
}

/**
 * The destination and owner of one pipeline in the Workflows dialog. Pure,
 * so the Run gating is unit-tested without the dialog.
 */
export function resolveWorkflowsRunContext({
  pipeline,
  taskScope,
  chosenLocation,
  choices,
  selection,
  rereadPipeline,
}: {
  pipeline: PipelineData;
  /** The selected task's scope; absent with no selected task. */
  taskScope: PipelineExecutionScope | undefined;
  chosenLocation: PipelineRunLocation | undefined;
  choices: PipelineRunOwnerChoices;
  selection: {
    value: string | null;
    stale: boolean;
    choose: (owner: string) => void;
  };
  /** Reads the pipeline again, for Retry when its owner can't be read. */
  rereadPipeline?: () => void;
}): ResolvedRunContext {
  // A project file belongs to its checkout, so it only runs there.
  const supportsGlobal =
    pipeline.info.source !== 'project' &&
    pipelineSupportsExecutionScope(pipeline.info, 'global');
  const supportsTask = pipelineSupportsExecutionScope(
    pipeline.info,
    taskScope ?? 'worktree',
  );
  const currentTaskUnavailable = taskScope === undefined || !supportsTask;
  const location: PipelineRunLocation = !supportsGlobal
    ? 'current-task'
    : currentTaskUnavailable
      ? 'global'
      : (chosenLocation ?? 'global');
  const base = {
    location,
    showLocation: supportsGlobal && supportsTask,
    currentTaskUnavailable,
  };
  if (location === 'current-task') {
    // A pipeline that only runs in a task waits for a compatible one.
    return {
      ...base,
      owner: null,
      requestedOwner: undefined,
      ownerValue: null,
      runBlocked: currentTaskUnavailable,
      ...(currentTaskUnavailable
        ? { blockedReason: PIPELINE_RUN_CONTEXT_COPY.currentTaskUnavailable }
        : {}),
    };
  }
  if (choices.status === 'loading') {
    return {
      ...base,
      owner: { kind: 'loading' },
      requestedOwner: undefined,
      ownerValue: null,
      runBlocked: true,
    };
  }
  if (pipeline.localRunOwnerUnreadable === true) {
    // Never shown as unowned: main refuses the run until the owner reads.
    return {
      ...base,
      owner: { kind: 'error', onRetry: rereadPipeline ?? ((): void => {}) },
      requestedOwner: undefined,
      ownerValue: null,
      runBlocked: true,
    };
  }
  if (choices.status === 'error') {
    return {
      ...base,
      owner: { kind: 'error', onRetry: choices.retry },
      requestedOwner: undefined,
      ownerValue: null,
      runBlocked: true,
    };
  }
  const savedOwner = pipeline.localRunOwner;
  if (savedOwner !== undefined) {
    return {
      ...base,
      owner: { kind: 'fixed', label: choices.labelFor(savedOwner) },
      requestedOwner: undefined,
      ownerValue: savedOwner,
      runBlocked: false,
    };
  }
  // Personal runs without asking only when it was all that was ever offered;
  // a chosen organization that went away asks again.
  if (choices.personalOnly && !selection.stale) {
    const personal = choices.options[0]?.value ?? 'personal';
    return {
      ...base,
      owner: { kind: 'fixed', label: choices.labelFor(personal) },
      requestedOwner: personal,
      ownerValue: personal,
      runBlocked: false,
    };
  }
  return {
    ...base,
    owner: {
      kind: 'choose',
      options: choices.options,
      value: selection.value,
      onChange: selection.choose,
      stale: selection.stale,
    },
    requestedOwner: selection.value ?? undefined,
    ownerValue: selection.value,
    runBlocked: selection.value === null,
  };
}
