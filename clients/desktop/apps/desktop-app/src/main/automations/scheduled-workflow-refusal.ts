/**
 * Why a schedule won't run a definition whose only trigger is `workflow`, or
 * one that declares neither `dispatch` nor `workflow` (CAN-5782). A refusal
 * found before a timed fire's If Command runs settles the occurrence as
 * skipped; one found after it is a failed run, so the condition never runs
 * twice.
 */
export class ScheduledWorkflowRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduledWorkflowRefusal';
  }
}

/** The start result's code for a {@link ScheduledWorkflowRefusal}. */
export const SCHEDULED_WORKFLOW_REFUSAL_CODE = 'schedule_refused';

/** An agent's schedule or Run now needs a Manual (`dispatch`) trigger. */
export const SCHEDULE_DISPATCH_REQUIRED_MESSAGE =
  'Workflow does not support dispatch triggers.';
export const SCHEDULE_UNAPPROVED_WORKFLOW_MESSAGE =
  "This workflow's only trigger is Workflow, and its current version wasn't saved by a person. Save or approve it on its page before it runs on a schedule.";
export const SCHEDULE_AUTOMATION_PACKAGE_WORKFLOW_MESSAGE =
  "This schedule runs its workflow with a package installed with the automation, which a person's approval doesn't cover yet. Ask its publisher for a version with a Manual trigger, then reinstall it.";
export const SCHEDULE_UNREADABLE_PACKAGE_MESSAGE =
  "This workflow's package couldn't be verified. Reinstall it from the share link.";
export const SCHEDULE_LIVE_SHARE_WORKFLOW_MESSAGE =
  'This schedule runs a shared workflow whose only trigger is Workflow. Install the workflow, then schedule the installed copy.';
export const SCHEDULE_PROJECT_WORKFLOW_MESSAGE =
  "A project workflow whose only trigger is Workflow can't run on a schedule yet. Add a Manual trigger to it, or schedule a saved copy.";
