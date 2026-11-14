import { type JSX, useId, useState } from 'react';
import { Button, ErrorBanner, Notice, ToggleSwitch } from '@canopy/ui-shared';
import { useOpenSettingsSection } from '../settings-section-navigation';
import { useAccountProxyStatus } from '@/stores/accountProxyStore';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
} from '../SettingsLayout';

const SAVE_ERROR_MESSAGE = 'Could not save this setting. Try again.';

/**
 * Settings > Labs > Multi-account proxy (CAN-4019): the per-user opt-in.
 * Mounted only while the `canopy-desktop-account-proxy` flag is on. The
 * terms notice is always visible, not only after opting in.
 */
export function AccountProxyOptInSection(): JSX.Element {
  const status = useAccountProxyStatus();
  const openSettings = useOpenSettingsSection();
  const toggleId = useId();
  const [saving, setSaving] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const enabled = optimistic ?? status?.available === true;

  const save = (next: boolean): void => {
    setOptimistic(next);
    setSaving(true);
    setSaveError(null);
    void window.api
      .savePreferences({ accountProxyEnabled: next })
      .catch(() => {
        setSaveError(SAVE_ERROR_MESSAGE);
      })
      .finally(() => {
        setOptimistic(null);
        setSaving(false);
      });
  };

  return (
    <SettingsSection
      title="Multi-account proxy"
      dataTestId="settings-experiments-account-proxy"
    >
      <ErrorBanner
        errorSource="account-proxy-opt-in-section-save"
        className=""
        error={saveError}
      />
      <SettingsGroup>
        <SettingsRow
          label="Use an account proxy"
          htmlFor={toggleId}
          description="Run agents through CLIProxyAPI, which shares several Claude, Codex, and other accounts. Adds Multi-account proxy to Settings."
          control={
            <ToggleSwitch
              id={toggleId}
              checked={enabled}
              disabled={status === null || saving}
              label="Use an account proxy"
              dataTestId="account-proxy-opt-in-toggle"
              onChange={save}
            />
          }
        >
          <Notice intent="attention" title="Check each provider's terms.">
            Using a subscription outside the provider's own apps can break its
            terms, and the provider can suspend the account.
          </Notice>
          {enabled ? (
            <SettingsSubRow
              label="Set up the proxy"
              description="Connect to a CLIProxyAPI server."
              control={
                <Button
                  size="compact"
                  data-testid="account-proxy-open-settings"
                  onClick={(): void => openSettings('account-proxy')}
                >
                  Open Multi-account proxy
                </Button>
              }
            />
          ) : null}
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
