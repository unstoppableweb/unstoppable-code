import type {
  OrganizationInviteResult,
  PersonalProjectOutcome,
} from '@canopy/protocol/organizations';
import type { PersonalOrganizationUpgradeFailure } from '@canopy/app-state/personal-organization-upgrade';

/** Copy for promoting Personal into a team and inviting into it (CAN-3706). */
export const TEAM_UPGRADE_COPY = {
  createTitle: 'Create a team',
  inviteTitle: 'Invite a teammate',
  inviteTeamTitle: 'Invite your team',
  description:
    'Work together in one shared place. Teammates see the projects you include and use the same settings.',
  nameLabel: 'Team name',
  namePlaceholder: 'Acme',
  projectsLegend: 'Projects to include',
  projectsLoading: 'Loading your projects…',
  projectsEmpty: 'No Personal projects to include.',
  projectsFailed: "Couldn't load your projects.",
  projectsRetry: 'Try again',
  projectsSkip: 'Continue without projects',
  projectsSkipped:
    'Continuing without projects. You can add them from the desktop app later.',
  projectsUnavailable:
    'To include projects, create the team from the desktop app. You can also add them later.',
  multiRepoHint: 'Moves after its repositories are in the team',
  inviteLabel: 'Invite by email',
  inviteOptionalLabel: 'Invite by email (optional)',
  inviteMoreLabel: 'Invite more people',
  inviteMoreSubmit: 'Invite',
  createSubmit: 'Create team',
  createAndInviteSubmit: 'Create team and invite',
  creating: 'Creating team…',
  inviteSubmit: 'Send invite',
  inviting: 'Sending invite…',
  manage: 'Manage',
  createAnotherTeam: 'Create another team',
  restartUnavailable: "Couldn't open a new team setup. Try again.",
  retryProjects: 'Try projects again',
  checkAgain: 'Check again',
  retryInvite: 'Try the invite again',
} as const;

export function teamCreatedTitle(team: string): string {
  return `${team} is ready`;
}

/** Checklist row for the team itself, while and after it is created. */
export function teamStepLabel(team: string, created: boolean): string {
  return created ? `Created ${team}` : `Creating ${team}`;
}

function projectCount(count: number): string {
  return count === 1 ? '1 project' : `${String(count)} projects`;
}

/** Checklist row for the projects included in the team. */
export function projectsStepLabel(
  count: number,
  team: string,
  status: 'moving' | 'moved' | 'attention',
): string {
  switch (status) {
    case 'moving':
      return `Moving ${projectCount(count)} to ${team}`;
    case 'moved':
      return `Moved ${projectCount(count)} to ${team}`;
    case 'attention':
      return `Some projects didn't move to ${team}`;
  }
}

/** Checklist row for one invitation while it is being sent. */
export function invitingLabel(email: string): string {
  return `Inviting ${email}`;
}

export const CONTEXT_SWITCH_PENDING =
  'Switch to it from the organization menu.';

/** Short status for one project in the outcome list. */
export function projectOutcomeLabel(
  outcome: PersonalProjectOutcome['outcome'],
  team: string,
): string {
  switch (outcome) {
    case 'pending':
      return 'Moving…';
    case 'moved':
      return `Moved to ${team}`;
    case 'converted-private':
      return 'Moved, not shared with the team yet';
    case 'not-personal':
      return 'No longer in Personal';
    case 'workspace-not-found':
      return 'Not found on this desktop';
    case 'limit-reached':
      return `${team} has reached its project limit`;
    case 'repositories-not-in-team':
      return `Its repositories aren't in ${team} yet`;
    case 'offline':
      return 'Waiting for the desktop app';
    case 'account-changed':
      return 'Stopped because the account changed';
    case 'failed':
      return "Couldn't move";
  }
}

/** Outcomes a retry can fix without recreating anything. */
export function isRetryableOutcome(
  outcome: PersonalProjectOutcome['outcome'],
): boolean {
  return (
    outcome === 'converted-private' ||
    outcome === 'repositories-not-in-team' ||
    outcome === 'limit-reached' ||
    outcome === 'offline' ||
    outcome === 'failed'
  );
}

export function inviteOutcomeMessage(
  result: OrganizationInviteResult,
  email: string,
): string {
  switch (result.status) {
    case 'sent':
      return `Invited ${email}`;
    case 'resent':
      return `Invited ${email} again`;
    case 'deferred-for-payment':
      return `Invite created for ${email}. It hasn't been emailed yet.`;
    case 'email-suppressed':
      return `Invite created for ${email}, but no email was sent. Share the invite link from the members page.`;
  }
}

export function invitePendingMessage(email: string): string {
  return `Checking whether the invite to ${email} was sent.`;
}

export function inviteFailureMessage(
  failure: PersonalOrganizationUpgradeFailure,
  email: string,
): string {
  if (failure.code === 'rate_limited')
    return `Couldn't invite ${email} right now. Wait a moment, then retry.`;
  return failure.code === 'invite_refused' || failure.code === 'forbidden'
    ? `Couldn't invite ${email}. ${failure.message}`
    : `Couldn't invite ${email}. Try the invite again.`;
}

/** The promotion refusal sentence; the server message only for known refusals. */
export function promotionFailureMessage(
  failure: PersonalOrganizationUpgradeFailure,
): string {
  switch (failure.code) {
    case 'rate_limited':
      return "Couldn't create the team right now. Wait a moment, then try again.";
    case 'creation_disabled':
      return "Teams can't be created for this account yet.";
    case 'not_found':
    case 'forbidden':
      return "Couldn't create the team. Only the owner of Personal can turn it into a team.";
    case 'operation_conflict':
    case 'conflict':
      return "Couldn't create the team because another change is in progress. Try again.";
    case 'invalid_request':
      return 'Enter a team name of up to 256 characters.';
    default:
      return "Couldn't create the team. Try again.";
  }
}

export function conversionFailureMessage(): string {
  return "Couldn't reach the desktop app to move projects. The team is ready; retry the projects when the desktop app is open.";
}
