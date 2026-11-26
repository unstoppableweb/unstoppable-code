import type {
  ScheduledActivity,
  WorkflowEditSection,
} from '@canopy/desktop-shared/types';
import type { PipelineDocumentLocator } from '@/lib/pipelineDocument';
import type { PipelineEditDeepLink } from '@/stores/navigationStore';

/**
 * What a "New" automation starts from (CAN-4072). The worktree side panel
 * seeds its project, and the worktree the automation targets when it has one.
 */
export type AutomationDraftSeed =
  | {
      readonly projectId: string;
      readonly isCowork: boolean;
      readonly existingWorktreeId?: string;
      /** Prefill from a repeated Home task (CAN-4009). */
      readonly name?: string;
      readonly prompt?: string;
    }
  /**
   * A schedule from the Designer's trigger card (CAN-4224): its name and
   * whether it repeats or runs once. The person picks the workflow in the
   * form's own picker, which sets up its inputs, model aliases and plugins.
   */
  | {
      readonly name: string;
      readonly trigger: 'cron' | 'one_time';
    };

/** Fields every edit target carries, whatever it edits. */
export interface WorkflowEditTargetCommon {
  /** Section the shell shows; unset opens Definition. */
  section?: WorkflowEditSection;
  /**
   * Item the shell's Back reopens. It wins over a pipeline's own return
   * fields, and a chain resolves one level per Back.
   */
  returnTo?: WorkflowEditTarget;
}

/**
 * The item the Workflows edit shell shows (CAN-4072). A pipeline with a null
 * `pipelineId` and no `sharedRemoteId` is a new draft, and its `draftKey`
 * tells two drafts apart.
 */
export type WorkflowEditTarget =
  | (WorkflowEditTargetCommon &
      PipelineEditDeepLink & {
        kind: 'pipeline';
        draftKey?: string;
        /**
         * A workflow page's schedule to expand on its Trigger section
         * (CAN-5782). Not part of the item's identity.
         */
        focusScheduleId?: string;
      })
  | (WorkflowEditTargetCommon & { kind: 'automation'; activityId: string })
  | (WorkflowEditTargetCommon & {
      kind: 'automation-draft';
      draftKey: string;
      seed?: AutomationDraftSeed;
    })
  | (WorkflowEditTargetCommon & {
      kind: 'shared-automation';
      remoteId: string;
      /** The Library row's name, shown while the share loads. */
      name?: string;
    });

let draftSequence = 0;

/** A draft key no earlier call returned, so each New opens a fresh draft. */
export function newWorkflowDraftKey(): string {
  draftSequence += 1;
  return `draft-${Date.now().toString(36)}-${draftSequence.toString(36)}`;
}

function isNewPipelineDraft(
  target: Extract<WorkflowEditTarget, { kind: 'pipeline' }>,
): boolean {
  return target.pipelineId === null && !target.sharedRemoteId;
}

/** Whether the target is an item that has not been saved yet. */
export function isWorkflowEditDraft(target: WorkflowEditTarget): boolean {
  if (target.kind === 'automation-draft') return true;
  return target.kind === 'pipeline' && isNewPipelineDraft(target);
}

/**
 * Gives a new pipeline draft a draft key when it arrives without one, so it
 * never shares a key with another draft. Every other target is returned as is.
 */
export function withWorkflowDraftKey(
  target: WorkflowEditTarget,
): WorkflowEditTarget {
  if (target.kind !== 'pipeline' || target.draftKey !== undefined) {
    return target;
  }
  return isNewPipelineDraft(target)
    ? { ...target, draftKey: newWorkflowDraftKey() }
    : target;
}

/**
 * Stable identity of the edited item. Section and `returnTo` are not part of
 * it, so moving between sections or arriving from somewhere else never reads
 * as a different item.
 */
export function workflowEditKey(target: WorkflowEditTarget): string {
  switch (target.kind) {
    case 'pipeline':
      if (target.draftKey !== undefined && isNewPipelineDraft(target)) {
        return `pipeline-draft:${target.draftKey}`;
      }
      return `pipeline:${JSON.stringify([
        target.source ?? null,
        target.sharedRemoteId ?? null,
        target.cwd ?? null,
        target.filePath ?? null,
        target.pipelineId,
      ])}`;
    case 'automation':
      return `automation:${target.activityId}`;
    case 'automation-draft':
      return `automation-draft:${target.draftKey}`;
    case 'shared-automation':
      return `shared-automation:${target.remoteId}`;
  }
}

function hasPipelineLocation(
  target: Extract<WorkflowEditTarget, { kind: 'pipeline' }>,
): boolean {
  return (
    target.source !== undefined ||
    target.sharedRemoteId !== undefined ||
    target.cwd !== undefined ||
    target.filePath !== undefined
  );
}

/**
 * Whether two targets show the same item. Callers describe a saved pipeline
 * differently: App Advisor names only its id, while the Library adds where it
 * lives. A bare id therefore matches the pipeline shown with that id, and a
 * shared pipeline matches by its remote id; two located links must agree.
 * A bare id is ambiguous when a project pipeline shares a library pipeline's
 * id; it then keeps the one shown rather than switching, as run matching does.
 */
export function isSameWorkflowEditItem(
  a: WorkflowEditTarget,
  b: WorkflowEditTarget,
): boolean {
  if (workflowEditKey(a) === workflowEditKey(b)) return true;
  if (a.kind !== 'pipeline' || b.kind !== 'pipeline') return false;
  if (isNewPipelineDraft(a) || isNewPipelineDraft(b)) return false;
  if (a.sharedRemoteId !== undefined && a.sharedRemoteId === b.sharedRemoteId) {
    return true;
  }
  return (
    a.pipelineId === b.pipelineId &&
    (!hasPipelineLocation(a) || !hasPipelineLocation(b))
  );
}

/**
 * The deep link for a pipeline document locator, the form Library rows and
 * saved drafts resolve to, so Edit and Share open the same document.
 */
export function pipelineEditLinkFromLocator(
  locator: PipelineDocumentLocator,
): PipelineEditDeepLink {
  return {
    pipelineId: locator.pipelineId,
    ...(locator.cwd !== undefined ? { cwd: locator.cwd } : {}),
    ...(locator.pipelineFilePath !== undefined
      ? { filePath: locator.pipelineFilePath }
      : {}),
    ...(locator.pipelineSource !== undefined
      ? { source: locator.pipelineSource }
      : {}),
    ...(locator.sharedRemoteId !== undefined
      ? { sharedRemoteId: locator.sharedRemoteId }
      : {}),
  };
}

/**
 * The Workflow page that edits a schedule (CAN-5782): the user pipeline a
 * workflow schedule runs. The page edits where each schedule runs (its
 * project and Run in, or no project), so every target opens there.
 */
export function workflowPageIdForActivity(
  activity: Pick<
    ScheduledActivity,
    'action' | 'ownedPipeline' | 'workflowSchedule'
  >,
): string | undefined {
  if (activity.workflowSchedule === undefined) return undefined;
  const stored = activity.ownedPipeline?.storedAction ?? activity.action;
  if (stored.type !== 'worktree_pipeline') return undefined;
  return activity.workflowSchedule.pipelineId;
}

/**
 * Where an automation edit target for this record opens instead (CAN-5782):
 * its Workflow page, on the Trigger section with the schedule expanded, or
 * on Runs when Runs was asked for. `undefined` keeps the Automation page.
 */
export function workflowEditTargetForActivity(
  activity: Pick<
    ScheduledActivity,
    'id' | 'action' | 'ownedPipeline' | 'workflowSchedule'
  >,
  link: Pick<WorkflowEditTargetCommon, 'section' | 'returnTo'> = {},
): Extract<WorkflowEditTarget, { kind: 'pipeline' }> | undefined {
  const pipelineId = workflowPageIdForActivity(activity);
  if (pipelineId === undefined) return undefined;
  return {
    kind: 'pipeline',
    pipelineId,
    source: 'user',
    section: link.section === 'runs' ? 'runs' : 'trigger',
    focusScheduleId: activity.id,
    ...(link.returnTo !== undefined ? { returnTo: link.returnTo } : {}),
  };
}
