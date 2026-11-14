import { useMemo, type JSX } from 'react';
import { createBrowserUpgradeRecovery } from '@canopy/app-state/personal-organization-upgrade';
import { organizationSettingsPath } from '@canopy/ui-app';
import { InviteToOrganizationDialog } from '@canopy/ui-app/sharing/InviteToOrganizationDialog';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { desktopPersonalOrganizationUpgradePort } from '../../lib/personal-organization-upgrade-port';
import { refreshCanopyCloudAccountData } from '../../lib/canopyCloudAccountChange';
import { openSettingsPathOrWeb } from '../../lib/navigation/settings-destinations';

export interface DesktopCreateTeamDialogProps {
  readonly accountId: string;
  readonly personalOrganizationId: string;
  /** Opened to invite someone; the email then leads the form. */
  readonly inviteRequired?: boolean;
  /** Runs after a committed promotion, once the account is re-read. */
  readonly onPromoted?: () => void;
  readonly onClose: () => void;
}

/**
 * The desktop mount of the shared Create a team flow (CAN-3706). Main promotes,
 * switches context, and moves projects; the renderer only re-reads the account
 * afterwards so every account consumer sees the team without a restart.
 * Manage opens the team's settings inside Settings when hosted settings are
 * available here, otherwise on the web, already signed in.
 */
export function DesktopCreateTeamDialog({
  accountId,
  personalOrganizationId,
  inviteRequired = false,
  onPromoted,
  onClose,
}: DesktopCreateTeamDialogProps): JSX.Element {
  const port = useMemo(
    () =>
      desktopPersonalOrganizationUpgradePort(
        accountId,
        personalOrganizationId !== '',
        personalOrganizationId !== '',
      ),
    [accountId, personalOrganizationId],
  );
  const recovery = useMemo(
    () => createBrowserUpgradeRecovery(accountId),
    [accountId],
  );
  return (
    <InviteToOrganizationDialog
      key={accountId}
      target={{ kind: 'personal', personalOrganizationId }}
      port={port}
      accountKey={accountId}
      recovery={recovery}
      inviteRequired={inviteRequired}
      readRestartPersonalOrganizationId={async () => {
        const result = await refreshCanopyCloudAccountData();
        return result.status === 'refreshed' &&
          result.reason === 'same-account-refresh' &&
          result.account.accountProbeApplied === true &&
          result.account.account?.id === accountId
          ? (result.account.personalOrganizationId ?? null)
          : null;
      }}
      onPromoted={() => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        onPromoted?.();
      }}
      onManage={openTeamSettings}
      onClose={onClose}
    />
  );
}

function openTeamSettings(organizationId: string): void {
  // CAN-4386: with hosted settings in this window, Manage opens the team's
  // settings inside Settings instead of the browser.
  openSettingsPathOrWeb(organizationSettingsPath(organizationId));
}

export interface DesktopInviteTeamDialogProps {
  readonly accountId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly onClose: () => void;
}

/**
 * The desktop mount of the same shared dialog for an existing team: only
 * invitations, as a checklist, ending with Manage (CAN-3706).
 */
export function DesktopInviteTeamDialog({
  accountId,
  organizationId,
  organizationName,
  onClose,
}: DesktopInviteTeamDialogProps): JSX.Element {
  const port = useMemo(
    () => desktopPersonalOrganizationUpgradePort(accountId, false, true),
    [accountId],
  );
  return (
    <InviteToOrganizationDialog
      key={`${accountId}:${organizationId}`}
      target={{ kind: 'team', organizationId, organizationName }}
      port={port}
      accountKey={accountId}
      onManage={openTeamSettings}
      onClose={onClose}
    />
  );
}
