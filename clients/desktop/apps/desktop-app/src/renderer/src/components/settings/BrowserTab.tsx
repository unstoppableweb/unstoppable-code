import { useCallback, useEffect, useState, type JSX } from 'react';
import { Notice, ToggleSwitch } from '@canopy/ui-shared';
import type { DefaultBrowserRegistrationStatus } from '@canopy/desktop-shared/types';
import { BrowserProfilesSettings } from './BrowserProfilesSettings';
import { BrowserSearchEngineSettings } from './BrowserSearchEngineSettings';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from './SettingsLayout';
import { useBrowserStore } from '@/stores/browserStore';
import { brandText } from '@/lib/brand';

/**
 * Recovery guidance for an OS registration the app asked for but did not get.
 * The OS is the authority here, so the toggle keeps the user's choice and this
 * explains what is left for them to do.
 */
function registrationGuidance(
  status: DefaultBrowserRegistrationStatus,
): string | null {
  if (!status.enabled && status.registered) {
    return `${brandText.appName} is still your default browser. Choose a different one in system settings.`;
  }
  if (!status.enabled || status.registered) {
    return null;
  }
  switch (status.failure) {
    case 'user-action-required':
      return `To finish, choose ${brandText.appName} in Windows Settings under Default apps.`;
    case 'registration-refused':
      return `${brandText.appName} couldn’t be set as your default browser. Set it in system settings.`;
    case 'unsupported':
      if (status.platform === 'linux') {
        return 'This is not available on Linux yet.';
      }
      return `This only works in the installed ${brandText.appName} app.`;
    default:
      return null;
  }
}

export function BrowserTab(): JSX.Element {
  const localServersOnly = useBrowserStore((state) => state.localServersOnly);
  const openAppLinks = useBrowserStore(
    (state) => state.openAppLinksInBuiltInBrowser,
  );
  const loadBrowserPreferences = useBrowserStore(
    (state) => state.loadBrowserPreferences,
  );
  const setLocalServersOnly = useBrowserStore(
    (state) => state.setLocalServersOnly,
  );
  const setOpenAppLinks = useBrowserStore(
    (state) => state.setOpenAppLinksInBuiltInBrowser,
  );
  const useAsDefault = useBrowserStore(
    (state) => state.useAsSystemDefaultBrowser,
  );
  const setUseAsDefault = useBrowserStore(
    (state) => state.setUseAsSystemDefaultBrowser,
  );
  const [saving, setSaving] = useState(false);
  const [savingAppLinks, setSavingAppLinks] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [registration, setRegistration] =
    useState<DefaultBrowserRegistrationStatus | null>(null);

  useEffect(() => {
    void loadBrowserPreferences();
  }, [loadBrowserPreferences]);

  // The OS decides whether the registration actually took, so the verified
  // status is read back from main rather than inferred from the preference.
  useEffect(() => {
    const api = window.api.browser;
    if (typeof api.getDefaultRegistrationStatus !== 'function') {
      return undefined;
    }
    let active = true;
    const refreshRegistration = (): void => {
      void api
        .getDefaultRegistrationStatus()
        .then((status) => {
          if (active) {
            setRegistration(status);
          }
        })
        .catch(() => undefined);
    };
    refreshRegistration();
    window.addEventListener('focus', refreshRegistration);
    const unsubscribe =
      typeof api.onDefaultRegistrationStatusChanged === 'function'
        ? api.onDefaultRegistrationStatusChanged((status) => {
            setRegistration(status);
          })
        : undefined;
    return (): void => {
      active = false;
      window.removeEventListener('focus', refreshRegistration);
      unsubscribe?.();
    };
  }, []);

  const handleToggle = useCallback((): void => {
    const next = !localServersOnly;
    setLocalServersOnly(next);
    setSaving(true);
    void window.api
      .savePreferences({ inAppBrowserLocalServersOnly: next })
      .then((preferences) => {
        setLocalServersOnly(preferences.inAppBrowserLocalServersOnly === true);
      })
      .catch(() => {
        setLocalServersOnly(!next);
      })
      .finally(() => {
        setSaving(false);
      });
  }, [localServersOnly, setLocalServersOnly]);

  const handleToggleAppLinks = useCallback((): void => {
    const next = !openAppLinks;
    setOpenAppLinks(next);
    setSavingAppLinks(true);
    void window.api
      .savePreferences({ openAppLinksInBuiltInBrowser: next })
      .then((preferences) => {
        setOpenAppLinks(preferences.openAppLinksInBuiltInBrowser === true);
      })
      .catch(() => {
        setOpenAppLinks(!next);
      })
      .finally(() => {
        setSavingAppLinks(false);
      });
  }, [openAppLinks, setOpenAppLinks]);

  const handleToggleDefault = useCallback((): void => {
    const next = !useAsDefault;
    setUseAsDefault(next);
    setSavingDefault(true);
    void window.api
      .savePreferences({ useAsSystemDefaultBrowser: next })
      .then((preferences) => {
        setUseAsDefault(preferences.useAsSystemDefaultBrowser === true);
      })
      .catch(() => {
        setUseAsDefault(!next);
      })
      .finally(() => {
        setSavingDefault(false);
      });
  }, [useAsDefault, setUseAsDefault]);

  const guidance =
    registration === null ? null : registrationGuidance(registration);

  return (
    <SettingsPage
      title="Browser"
      description="Choose where links open, which sites the built-in browser can load, and how it searches."
      dataTestId="settings-tab-browser"
    >
      <SettingsSection title="Built-in browser">
        <SettingsGroup>
          <SettingsRow
            label="Open links in the built-in browser"
            description={`Links you click in ${brandText.appName} open here instead of in another browser. Pull requests always open in another browser.`}
            htmlFor="settings-browser-open-app-links"
            control={
              <ToggleSwitch
                id="settings-browser-open-app-links"
                checked={openAppLinks}
                label="Open links in the built-in browser"
                dataTestId="settings-browser-open-app-links-in-built-in-browser"
                disabled={savingAppLinks}
                onChange={handleToggleAppLinks}
              />
            }
          />
          <SettingsRow
            label={`Make ${brandText.appName} your default browser`}
            description={`Links from other apps, like email, open in ${brandText.appName}.`}
            htmlFor="settings-browser-use-as-default"
            control={
              <ToggleSwitch
                id="settings-browser-use-as-default"
                checked={useAsDefault}
                label={`Make ${brandText.appName} your default browser`}
                dataTestId="settings-browser-use-as-system-default"
                disabled={savingDefault}
                onChange={handleToggleDefault}
              />
            }
          >
            {/* Under its own switch, like the launch-at-login approval
                notice: the OS answers after the toggle, and a notice above
                the group would push the switch the user just used. */}
            {guidance !== null && (
              <Notice
                intent="attention"
                data-testid="settings-browser-default-guidance"
              >
                {guidance}
              </Notice>
            )}
          </SettingsRow>
          <SettingsRow
            label="Only allow local sites"
            description="The built-in browser only loads sites running on this computer."
            htmlFor="settings-browser-local-servers-only"
            control={
              <ToggleSwitch
                id="settings-browser-local-servers-only"
                checked={localServersOnly}
                label="Only allow local sites"
                dataTestId="settings-browser-local-servers-only"
                disabled={saving}
                onChange={handleToggle}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <BrowserSearchEngineSettings />

      <BrowserProfilesSettings />
    </SettingsPage>
  );
}
