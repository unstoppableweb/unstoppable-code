'use client';

import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { useState, type JSX } from 'react';
import { Github } from '@canopy/ui-shared/icons/AppIcons';
import { Button, ErrorBanner, Heading } from '@canopy/ui-shared/components';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { canEditOrg } from '@canopy/protocol/settings/organization-permissions';
import {
  SettingsConfirmDialog,
  useSettingsBrand,
  useSettingsClient,
  useSettingsNavigation,
} from '../host';
import { useSettingsErrorCopy } from '../errors';
import { GITHUB_CONNECT_KNOWN_ERRORS } from '../github/github-organization-error-copy';
import { useOrganizationSettingsSubtabSlots } from './settings/organization-settings-subtab-slots';
import {
  disconnectGitHub,
  getOrganizationDetail,
  startGitHubConnect,
} from './team-api';
import type { SettingsFailure } from '../errors';

interface TeamGitHubConnectionSectionProps {
  detail: OrganizationDetail;
  onDetailChange: (detail: OrganizationDetail) => void;
}

/**
 * Owner/admin control for connecting the org-level GitHub App (CAN-405). When
 * connected, telemetry ingest fetches authoritative PR data from GitHub and
 * overrides the client-supplied merge/diff fields. Connecting follows GitHub's
 * install flow in this tab when the host supplies `followGitHubInstallUrl`;
 * otherwise the install opens in the browser and the card offers "Check
 * again" to re-read the connection. Disconnecting removes the connection row.
 * Returns `null` for members who cannot edit the org so the control never
 * renders for them.
 */
export function TeamGitHubConnectionSection({
  detail,
  onDetailChange,
}: TeamGitHubConnectionSectionProps): JSX.Element | null {
  const brand = useSettingsBrand();
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.organization.github');
  const navigation = useSettingsNavigation();
  const { followGitHubInstallUrl } = useOrganizationSettingsSubtabSlots();
  const [busy, setBusy] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  // The install opened in the browser; the card waits for "Check again".
  const [continuingInBrowser, setContinuingInBrowser] = useState(false);
  const [checking, setChecking] = useState(false);

  if (!canEditOrg(detail.viewerRole)) {
    return null;
  }

  const { connected, accountLogin } = detail.githubConnection;

  const handleConnect = async (): Promise<void> => {
    try {
      setBusy(true);
      setError(null);
      const { installUrl } = await startGitHubConnect(client, detail.id);
      if (followGitHubInstallUrl !== undefined) {
        // Full-page navigation to GitHub's install flow; the Setup-URL
        // callback returns the user to the settings page with a `?github=`
        // status.
        followGitHubInstallUrl(installUrl);
        return;
      }
      // The install completes in the browser, where the callback lands.
      navigation.openExternal(installUrl);
      setContinuingInBrowser(true);
      setBusy(false);
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'connect GitHub',
          known: GITHUB_CONNECT_KNOWN_ERRORS,
        }),
      );
      setBusy(false);
    }
  };

  const handleCheckAgain = async (): Promise<void> => {
    try {
      setChecking(true);
      setError(null);
      const updated = await getOrganizationDetail(client, detail.id);
      onDetailChange(updated);
      if (updated.githubConnection.connected) setContinuingInBrowser(false);
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, { action: 'check the GitHub connection' }),
      );
    } finally {
      setChecking(false);
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    try {
      setBusy(true);
      setError(null);
      await disconnectGitHub(client, detail.id);
      onDetailChange({
        ...detail,
        githubConnection: { connected: false, accountLogin: null },
      });
      setConfirmingDisconnect(false);
    } catch (err) {
      setError(errorCopy.actionFailure(err, { action: 'disconnect GitHub' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={SETTINGS_CARD_CLASS}
      data-testid="team-github-connection-section"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={2} variant="section">
          GitHub connection
        </Heading>
        <p className={SETTINGS_CARD_SUBTITLE_CLASS}>
          Connect the {brand.displayName} GitHub App so pull request merge state
          and diff stats in the timeline are pulled straight from GitHub,
          keeping them accurate and up to date.
        </p>
      </div>
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <div className={SETTINGS_CARD_ROW_CLASS}>
          <div className="flex min-w-0 items-center gap-3">
            <Github size={16} className="shrink-0 fg-secondary" />
            <div className="min-w-0">
              <div className="text-s font-medium fg-primary">GitHub</div>
              {connected ? (
                <p
                  className="text-xs text-pretty fg-secondary"
                  data-testid="team-github-connected"
                >
                  {accountLogin ? `Connected to ${accountLogin}` : 'Connected'}
                </p>
              ) : continuingInBrowser ? (
                <p
                  className="text-xs text-pretty fg-secondary"
                  data-testid="team-github-continue-in-browser"
                >
                  Continue in your browser.
                </p>
              ) : (
                <p className="text-xs text-pretty fg-secondary">
                  Not connected
                </p>
              )}
            </div>
          </div>
          {connected ? (
            <Button
              size="compact"
              variant="secondary"
              onClick={() => setConfirmingDisconnect(true)}
              disabled={busy}
              data-testid="team-github-disconnect"
            >
              Disconnect
            </Button>
          ) : continuingInBrowser ? (
            <Button
              size="compact"
              variant="secondary"
              onClick={() => void handleCheckAgain()}
              disabled={checking}
              data-testid="team-github-check-again"
            >
              {checking ? 'Checking…' : 'Check again'}
            </Button>
          ) : (
            <Button
              size="compact"
              variant="secondary"
              onClick={() => void handleConnect()}
              disabled={busy}
              data-testid="team-github-connect"
            >
              {busy ? 'Connecting…' : 'Connect GitHub'}
            </Button>
          )}
        </div>
        {error ? (
          <div className="pb-3">
            <ErrorBanner
              errorSource="team-git-hub-connection-section"
              error={error?.copy}
              details={error?.details}
            />
          </div>
        ) : null}
      </div>

      {confirmingDisconnect ? (
        <SettingsConfirmDialog
          title="Disconnect GitHub?"
          message="The timeline will go back to trusting pull request data reported by the desktop client. You can reconnect at any time."
          confirmLabel="Disconnect"
          busyLabel="Disconnecting…"
          busy={busy}
          destructive
          onConfirm={() => void handleDisconnect()}
          onCancel={() => setConfirmingDisconnect(false)}
          dataTestId="team-github-disconnect-confirm"
        />
      ) : null}
    </section>
  );
}
