import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { Disclosure, Notice, ToggleSwitch } from '@canopy/ui-shared';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useCanopyCloudConnected } from '@/hooks/useCanopyCloudConnected';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

const HEADING = 'Personal projects on the web';
const TOGGLE_ID = 'personal-catalog-toggle';
const TITLE = 'Show my Personal projects on the web';
const DISCLOSURE =
  'Project ID, scrubbed name, kind, repository layout, local location, repository host, repository owner, repository name, repository folder names and list IDs, which repositories this device has, device ID, installation generation, local project ID, and a request to restore the list when you turn sharing on again.';
const NOTICES = {
  collision:
    'This device was registered again after a copied project list was detected.',
  removed:
    'Your web project list was removed. Turn sharing off and on to restore it.',
  full: 'Your project list is too large to sync. Some projects are waiting.',
  failed:
    'Your project list could not sync. Turn sharing off and on to register again.',
};

type PersonalCatalogPlacement = 'privacy' | 'public-profile';

const REMOVE_LIST_ON_WEB =
  'Turning this off stops updates. Remove the saved list in your web Public profile settings.';
const REMOVE_LIST_ABOVE =
  'Turning this off stops updates. Remove the saved list in the Public profile card above.';

/**
 * Where the row's saved list can be removed. On Public profile the shared
 * card above holds the removal, but only while signed in: signed out, that
 * page shows the sign-in instead, so the row points at the web.
 */
function removeListDescription(
  placement: PersonalCatalogPlacement,
  signedIn: boolean,
): string {
  return placement === 'public-profile' && signedIn
    ? REMOVE_LIST_ABOVE
    : REMOVE_LIST_ON_WEB;
}

interface PersonalCatalogRowsFrameParts {
  /** The sign-in, catalog and save-error notices (empty when none apply). */
  notices: ReactNode;
  /** The switch row with its payload disclosure. */
  row: JSX.Element;
}

interface PersonalCatalogRowsProps {
  placement: PersonalCatalogPlacement;
  /** Lays out the notices and row for the mounting page. */
  renderFrame: (parts: PersonalCatalogRowsFrameParts) => JSX.Element;
}

/**
 * The personal-catalog choice: a standard switch row with the payload
 * disclosure one click away, plus its notices. The mounting page lays them
 * out through `renderFrame`: Settings → Privacy, or the hosted Public profile
 * page's device card. Only one of those mounts it at a time, so the App
 * Advisor slice is reported once. Hidden (nothing at all) while the
 * organization-projects flag is off or preferences are still loading.
 */
export function PersonalCatalogRows({
  placement,
  renderFrame,
}: PersonalCatalogRowsProps): JSX.Element | null {
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const signedIn = useCanopyCloudConnected();
  const [prefs, setPrefs] = useState<PreferencesData | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void window.api
        .loadPreferences()
        .then((value): void => {
          if (alive) setPrefs(value);
        })
        .catch((): void => {
          if (alive) setError(true);
        });
    };
    refresh();
    const unsubscribe = window.api.onPreferencesChanged(refresh);
    const unsubscribeSynced = window.api.onPreferencesSynced(refresh);
    return (): void => {
      alive = false;
      unsubscribe();
      unsubscribeSynced();
    };
  }, []);
  useCurrentUiStateReporter(
    'settings.personalCatalog',
    enabled
      ? {
          loaded: prefs !== null,
          enabled: prefs?.personalWorkspaceCatalogSync === 'private',
          signedIn,
          pending,
          notice: prefs?.personalCatalogNotice ?? null,
          error,
        }
      : null,
  );
  if (!enabled || !prefs) return null;
  const save = async (on: boolean): Promise<void> => {
    setPending(true);
    setError(false);
    try {
      await window.api.savePreferences({
        personalWorkspaceCatalogSync: on ? 'private' : 'off',
        // No longer read; kept so persisted preferences keep their shape.
        personalCatalogOfferSeen: true,
        personalCatalogNotice: null,
      });
      setPrefs(await window.api.loadPreferences());
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };
  const notices = (
    <>
      {!signedIn ? <Notice>Sign in to sync your project list.</Notice> : null}
      {prefs.personalCatalogNotice ? (
        <Notice>{NOTICES[prefs.personalCatalogNotice]}</Notice>
      ) : null}
      {error ? (
        <Notice
          errorSource="personal-catalog-settings-save"
          intent="destructive"
        >
          Couldn&apos;t save your choice.
        </Notice>
      ) : null}
    </>
  );
  const row = (
    <SettingsRow
      label={TITLE}
      htmlFor={TOGGLE_ID}
      description={removeListDescription(placement, signedIn === true)}
      control={
        <ToggleSwitch
          id={TOGGLE_ID}
          label={TITLE}
          checked={prefs.personalWorkspaceCatalogSync === 'private'}
          disabled={pending}
          onChange={(on): void => {
            void save(on);
          }}
        />
      }
    >
      {/* Kept mounted: the payload list stays in the DOM while closed so
          find-in-page reaches it. */}
      <Disclosure
        label="What is sent"
        keepMounted
        dataTestId="personal-catalog-disclosure"
      >
        <div className="flex flex-col text-xs text-pretty fg-secondary gap-2">
          <p>
            {DISCLOSURE} Revision and catalog generation numbers keep updates in
            order.
          </p>
          <p>
            Paths, scripts, Git settings, manifests, branches, chats, files,
            environment variables, credentials, installation receipts, and
            carryover state stay on this device.
          </p>
        </div>
      </Disclosure>
    </SettingsRow>
  );
  return renderFrame({ notices, row });
}

function renderPrivacyFrame({
  notices,
  row,
}: PersonalCatalogRowsFrameParts): JSX.Element {
  return (
    <SettingsSection
      title={HEADING}
      description="Only you can see this list. Project names and repository details can be sensitive."
      headingId="personal-catalog-heading"
      dataTestId="personal-catalog-settings"
    >
      {notices}
      <SettingsGroup>{row}</SettingsGroup>
    </SettingsSection>
  );
}

/**
 * Settings → Privacy → "Personal projects on the web". A section of the
 * Privacy page: it returns the section itself, with its own group, and
 * nothing at all while hidden.
 */
export function PersonalCatalogSettings(): JSX.Element | null {
  return (
    <PersonalCatalogRows placement="privacy" renderFrame={renderPrivacyFrame} />
  );
}
