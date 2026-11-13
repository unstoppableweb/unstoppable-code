import type { WorkflowRunStarter } from './workflow-run-model';

/**
 * Who started a pipeline run, as both run records name it: the desktop
 * execution's `initiator` and the cloud run detail's `initiation.initiator`.
 * Structural, so neither record's package is imported here.
 */
export type WorkflowRunInitiator =
  | { readonly kind: 'user' | 'hook' | 'portal' | 'automation' }
  | { readonly kind: 'app_advisor' | 'agent' };

export interface WorkflowRunStarterSource {
  readonly initiator?: WorkflowRunInitiator | null;
  /** The trigger event the run started with, such as `plan_ready`. */
  readonly event?: string | null;
  /** The run was fired by a hook. */
  readonly hook?: boolean;
  /**
   * An automation initiator is always a schedule's, as a cloud run's is
   * (CP-46). A desktop execution's summary doesn't say whether a schedule or
   * Run now started it, so it reads as Automation.
   */
  readonly automationsAreScheduled?: boolean;
}

/**
 * What the Runs feed says started a pipeline run (CAN-3981). A hook or a
 * plan, task or workflow trigger names itself; otherwise the recorded
 * initiator does, so a run App Advisor, Remote Control, an agent or an
 * automation started no longer reads as Manual. A run that recorded no
 * initiator was started by hand.
 */
export function workflowRunStarterOf({
  initiator,
  event,
  hook = false,
  automationsAreScheduled = false,
}: WorkflowRunStarterSource): WorkflowRunStarter {
  if (hook || initiator?.kind === 'hook') return 'hook';
  switch (event) {
    case 'plan_ready':
      return 'plan-approved';
    case 'task_ready':
      return 'task-ready';
    case 'workflow':
      return 'workflow';
    default:
      break;
  }
  switch (initiator?.kind) {
    case 'portal':
      return 'remote-control';
    case 'app_advisor':
      return 'app-advisor';
    case 'agent':
      return 'chat';
    case 'automation':
      return automationsAreScheduled ? 'schedule' : 'automation';
    default:
      return 'manual';
  }
}
