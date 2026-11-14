import type { JSX } from 'react';
import { Notice } from '@canopy/ui-shared';
import { brandText } from '@/lib/brand';
import {
  orgCreateFolderRefusalText,
  type OrgCreateFolderCheck,
} from '@/lib/orgCreateProject';

/**
 * What the Add project dialog says, in an organization, around the options it
 * shares with Personal (CAN-3453, CAN-3534): who the project will belong to,
 * what a chosen folder becomes, and what went wrong with the last create.
 * Presentational: the dialog owns the draft, the folder check and the create.
 */

/** What went wrong with the last create, as the dialog shows it. */
export type AddOrgProjectCreateError =
  /** Nothing was created; the fields stay editable. */
  | { readonly kind: 'failed'; readonly message: string }
  /** The per-member cap: the create action stays disabled, with no Try again. */
  | { readonly kind: 'limit-reached'; readonly message: string }
  /**
   * The project exists in the organization but not on this computer. The
   * fields lock and Try again only sets up that same project.
   */
  | { readonly kind: 'setup-failed'; readonly message: string };

/**
 * Shown above every option that makes a project the organization owns, only
 * when the organization requires chat sync: the dialog title already names the
 * organization, and a new project starts private to its member (CAN-3909).
 * Project privacy and the transcript sync are separate, so neither is called
 * "sharing" here.
 */
export function OrgProjectOwnershipNotice({
  organizationName,
  requiresActivitySharing,
}: {
  readonly organizationName: string;
  readonly requiresActivitySharing: boolean;
}): JSX.Element | null {
  if (!requiresActivitySharing) return null;
  return (
    <Notice data-testid="add-workspace-org-notice">
      {`${organizationName} requires your chats here to sync to ${brandText.appName} Cloud, where ${organizationName} can see them.`}
    </Notice>
  );
}

export function OrgProjectCreateErrorNotice({
  error,
}: {
  readonly error: AddOrgProjectCreateError;
}): JSX.Element {
  return (
    <Notice
      errorSource="add-workspace-org-error"
      data-testid="add-workspace-org-error"
      data-error-kind={error.kind}
      intent={error.kind === 'limit-reached' ? 'attention' : 'destructive'}
    >
      {error.message}
    </Notice>
  );
}

/**
 * The chosen folder's check, and any outcome the member should know before it
 * is added: a Personal project that moves, a link to a project the
 * organization already has, or a refusal.
 */
export function OrgFolderOutcome({
  organizationName,
  folderCheck,
  personalProjectName,
}: {
  readonly organizationName: string;
  readonly folderCheck: OrgCreateFolderCheck;
  /** The Personal project on the chosen folder, when the sidebar knows its name. */
  readonly personalProjectName: string | null;
}): JSX.Element | null {
  if (folderCheck.status === 'checking')
    return (
      <p
        role="status"
        className="text-xs fg-secondary"
        data-testid="add-workspace-org-folder-kind"
        data-folder-kind="checking"
      >
        Checking this folder…
      </p>
    );
  const { inspection } = folderCheck;
  // A folder without a repository is a routine Cowork project.
  if (inspection.kind === 'cowork') return null;
  if (inspection.kind === 'refused')
    return (
      <Notice
        className=""
        intent="attention"
        data-testid="add-workspace-org-folder-kind"
        data-folder-kind="refused"
        data-refusal-reason={inspection.reason}
      >
        {orgCreateFolderRefusalText(
          inspection.reason,
          organizationName,
          inspection.repositories,
        )}
      </Notice>
    );
  // A multi-repo project only needs saying when it moves a Personal one.
  if (inspection.kind === 'multi-repo')
    return inspection.personalWorkspaceId === undefined ? null : (
      <Notice
        className=""
        data-testid="add-workspace-org-folder-kind"
        data-folder-kind="personal"
      >
        {`Your Personal project${personalProjectName === null ? '' : ` ${personalProjectName}`} moves to ${organizationName}. You can move it back.`}
      </Notice>
    );
  const linked =
    inspection.target === 'new'
      ? null
      : `This folder is already in ${organizationName} as ${inspection.target.projectName}.`;
  // Moving a Personal project is the consequential part, so it is said before
  // the project is added whether or not the folder also links to an existing
  // project.
  if (inspection.personalWorkspaceId !== undefined) {
    const moves = `Your Personal project${personalProjectName === null ? '' : ` ${personalProjectName}`} moves to ${organizationName}. You can move it back.`;
    return (
      <Notice
        className=""
        data-testid="add-workspace-org-folder-kind"
        data-folder-kind="personal"
      >
        {linked === null ? moves : `${linked} ${moves}`}
      </Notice>
    );
  }
  if (linked !== null)
    return (
      <Notice
        className=""
        data-testid="add-workspace-org-folder-kind"
        data-folder-kind="linked"
      >
        {`${linked} It'll be linked, not copied.`}
      </Notice>
    );
  // A routine outcome is what the option already says a git repository
  // becomes, and it is added on pick, so there is nothing more to say.
  return null;
}
