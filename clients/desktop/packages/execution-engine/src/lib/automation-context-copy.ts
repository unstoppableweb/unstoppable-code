/**
 * Denial copy for background runs, and copy for automations whose target sits in a different Personal or
 * organization context than the one selected (CAN-3448). Pure and
 * browser-safe so main-process refusals and renderer notes share wording.
 *
 * Context labels are display names: `Personal`, or the organization's name
 * (callers fall back to `your organization` when the name is unknown).
 */

import {
  normalizeResourceContextSubjectName,
  type ResourceContextDecision,
  type ResourceContextSubject,
} from './resource-context-policy';

/** The target and contexts behind a `context-mismatch` denial, as display labels. */
export interface BackgroundContextMismatchDetails {
  targetName: string;
  targetContext: string;
  /** The context the run was bound to when it was turned on. */
  boundContext: string;
  /** The target carries a durable ownership-transfer record. */
  projectMoved?: boolean;
}

export interface BackgroundExecutionDeniedMessageOptions {
  /** The denial also switched the automation off; say so. */
  turnedOff?: boolean;
  /** Names for a `context-mismatch` denial; without them the copy stays generic. */
  mismatch?: BackgroundContextMismatchDetails;
  /** The automation is still on, so it re-binds only when turned off and on again. */
  stillOn?: boolean;
  /** Safe display identity or selection reference for a missing or unclassifiable capability. */
  subject?: ResourceContextSubject;
}

/** A retryable lookup failure has no authoritative resource verdict. */
export function backgroundExecutionRetryMessage(
  kind: 'run' | 'watcher' | 'watcher-setup',
): string {
  switch (kind) {
    case 'run':
      return "Couldn't check access to what this run uses. Try again in a moment.";
    case 'watcher':
      return "Couldn't check access to what this watcher uses. It'll try again.";
    case 'watcher-setup':
      return "Couldn't check access to what this watcher uses yet, so it wasn't set up. Try again in a moment.";
  }
}

/** Bounded recovery guidance for unattended runs; never display raw policy tokens. */
export function backgroundExecutionDeniedMessage(
  reason: Extract<ResourceContextDecision, { allow: false }>['reason'],
  options: BackgroundExecutionDeniedMessageOptions = {},
): string {
  const { mismatch, subject, turnedOff, stillOn } = options;
  const subjectName = subject
    ? normalizeResourceContextSubjectName(subject.name)
    : undefined;
  if (reason === 'context-mismatch' && mismatch) {
    const next = `Turn it ${
      stillOn && !turnedOff ? 'off and on' : 'on'
    } again to run it in ${mismatch.targetContext}.`;
    if (mismatch.projectMoved) {
      return turnedOff
        ? `Turned off because ${mismatch.targetName} moved to ${mismatch.targetContext}, but this automation still runs in ${mismatch.boundContext}. ${next}`
        : `${mismatch.targetName} moved to ${mismatch.targetContext}, but this automation still runs in ${mismatch.boundContext}. ${next}`;
    }
    return turnedOff
      ? `Turned off because ${mismatch.targetName} is in ${mismatch.targetContext}, but this automation was turned on in ${mismatch.boundContext}. ${next}`
      : `${mismatch.targetName} is in ${mismatch.targetContext}, but this automation was turned on in ${mismatch.boundContext}. ${next}`;
  }
  const labels = {
    'context-mismatch':
      "This is in a different Personal or organization context than the one it was set up in, so it didn't run.",
    'access-removed': 'You no longer have access to something this uses.',
    'unknown-provenance': subjectName
      ? `Couldn't confirm where ${subjectName} came from, so it didn't run.`
      : "Couldn't confirm where something this uses came from, so it didn't run.",
    // A stale selection must be repaired explicitly; retrying cannot restore it.
    'missing-dependency': subjectName
      ? `${subjectName} is missing or unavailable, so this didn't run. Check the selected capabilities and choose it again.`
      : "Something this needs is missing, so it didn't run.",
    'unsupported-target': "Couldn't confirm where this runs, so it didn't run.",
    'plugin-catalog-newer':
      "The plugin catalog was written by a newer version of the app, so this didn't run. Update the app to run it.",
    'plugin-catalog-damaged':
      "The plugin catalog is damaged, so this didn't run.",
  };
  return turnedOff ? `${labels[reason]} It's been turned off.` : labels[reason];
}

/**
 * What a person was doing when the automation was refused: turning it on,
 * Run now, or saving a new target for one that's already on.
 */
export type AutomationContextRefusalAction = 'enable' | 'run' | 'save';

export interface AutomationContextRefusalInput {
  /** The target project's display name. */
  targetName: string;
  action: AutomationContextRefusalAction;
}

/**
 * Refused before anything ran: turning an automation on, Run now, or
 * retargeting it. Automations bind to the context that owns their target, so
 * a refusal means the account isn't a member of that organization (CAN-3598).
 */
export function automationContextRefusalMessage(
  input: AutomationContextRefusalInput,
): string {
  const next =
    input.action === 'enable'
      ? 'turn this automation on'
      : input.action === 'save'
        ? 'save this automation again'
        : 'run this automation again';
  return `${input.targetName} is in an organization you're not a member of. Ask for access, then ${next}.`;
}

export interface AutomationContextNoteInput {
  targetName: string;
  /** Where the target lives; `null` for an organization the account isn't in. */
  targetContext: string | null;
}

/** Inline note on an automation whose saved target is outside the selection. */
export function automationContextNoteMessage(
  input: AutomationContextNoteInput,
): string {
  return input.targetContext === null
    ? `${input.targetName} is in an organization you're not a member of. Ask for access to turn this automation on or run it.`
    : `${input.targetName} is in ${input.targetContext}, so turning this automation on runs it there.`;
}

/** Where an automation runs, shown on its row: `Runs in Personal` or `Runs in {organization}`. */
export function automationRunsInMessage(contextLabel: string): string {
  return `Runs in ${contextLabel}`;
}

/** Display label for a context, given the organizations the account belongs to. */
export function workspaceContextDisplayLabel(
  context:
    | { kind: 'personal' }
    | { kind: 'organization'; organizationId: string },
  organizations: readonly { id: string; name: string }[],
  unknownOrganizationLabel = 'your organization',
): string {
  if (context.kind === 'personal') return 'Personal';
  const name = organizations
    .find((organization) => organization.id === context.organizationId)
    ?.name.trim();
  return name && name.length > 0 ? name : unknownOrganizationLabel;
}
