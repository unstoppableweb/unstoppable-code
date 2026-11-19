import { PersonalCatalogSettings } from './PersonalCatalogSettings';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CanopyCloudAccountPublicState,
  TelemetrySharingPreferences,
  TelemetrySharingVisibility,
} from '@canopy/desktop-shared/types';
import { useCanopyCloudCredentialUsable } from '@/hooks/useCanopyCloudConnected';
import { useTelemetrySyncStatus } from '@/hooks/useTelemetrySyncStatus';
import {
  useWorkspaceContext,
  useWorkspaceContextStore,
} from '@/stores/workspaceContextStore';
import {
  useCloudAccountAvailable,
  useTelemetrySharingAvailable,
} from '@/lib/cloud-account';
import { CanopyCloudAccountSection } from './CanopyCloudAccountSection';
import { CloudSyncStatus } from './CloudSyncStatus';
import { TelemetrySharingControls } from './TelemetrySharingControls';
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageMessage,
  SettingsSection,
} from './SettingsLayout';
import {
  DEFAULT_TELEMETRY_SHARING,
  resolveAvailableTelemetryScopes,
  resolveTelemetryScopeDescriptions,
} from './telemetry-sharing';
import { resolveTelemetryLocks } from './telemetryLocks';
import { useHostedSettingsAvailable } from './hosted/hosted-settings-availability';
import { UsageDataSection } from './UsageDataSection';
import { brandText } from '@/lib/brand';

const UNLINKED_SCOPES: TelemetrySharingVisibility[] =
  resolveAvailableTelemetryScopes(null);

/**
 * Persistent Settings → Privacy surface. Lets the user review the telemetry
 * data disclosure and change the per-data-type sharing visibility at any time.
 * Follows the load → optimistic-set → save → rollback pattern.
 *
 * Scopes the SELECTED organization enforces are locked: they display at the
 * enforced value (`Organization` when required, `Off` when prohibited), their
 * selector is disabled, and a tooltip names the org. Locks are display only
 * and follow the workspace context: in Personal nothing is locked, and the
 * saved preference always holds the member's own choice (CAN-3459). Main
 * enforces each org's policy per item against the org that owns the work, and
 * broadcasts `preferencesChanged` when enforcement changes, which this tab
 * subscribes to so the locks update live after sign-in or re-probe. On mount it
 * also kicks off an on-demand server re-probe so the locks are current the
 * moment the user opens the tab, rather than up to one re-probe interval stale.
 *
 * Usage data sits above Activity sharing: its switches turn off the
 * product's own usage and diagnostic flows, and main resolves their org
 * prohibitions (see `UsageDataSection`).
 *
 * With hosted account settings available, the cloud account row lives on the
 * hosted Account page and the personal-catalog choice on Public profile, so
 * this tab keeps only Usage data and Activity sharing.
 */
export function PrivacyTab(): JSX.Element {
  const [sharing, setSharing] = useState<TelemetrySharingPreferences>(
    DEFAULT_TELEMETRY_SHARING,
  );
  const [availableScopes, setAvailableScopes] =
    useState<TelemetrySharingVisibility[]>(UNLINKED_SCOPES);
  const [account, setAccount] = useState<CanopyCloudAccountPublicState | null>(
    null,
  );
  const workspaceContext = useWorkspaceContext();
  const contextOrganizations = useWorkspaceContextStore(
    (store) => store.state.organizations,
  );
  const [loaded, setLoaded] = useState(false);
  const sharingRef = useRef<TelemetrySharingPreferences>(sharing);
  const syncStatus = useTelemetrySyncStatus();
  // Merged into the sync status line below. `TelemetrySyncStatus` is network
  // truth only: main defers a credential-less flush WITHOUT recording an upload
  // error, so `lastSyncedAt` keeps reporting the last success while the queue
  // grows. Tracked separately from the org-lock account read above so a
  // sign-in/sign-out re-read can't disturb the enforced-scope locks.
  const cloudCredentialUsable = useCanopyCloudCredentialUsable();
  const hostedSettingsAvailable = useHostedSettingsAvailable();
  const cloudAccountAvailable = useCloudAccountAvailable();
  const telemetrySharingAvailable = useTelemetrySharingAvailable();

  useEffect(() => {
    sharingRef.current = sharing;
  }, [sharing]);

  // Derive the selectable scopes from an account snapshot and keep the account
  // so the lock map can follow the selected context. A null account is the
  // unlinked/unreadable fallback (off/private, nothing locked).
  const applyAccountLocks = useCallback(
    (next: CanopyCloudAccountPublicState | null): void => {
      setAvailableScopes(resolveAvailableTelemetryScopes(next));
      setAccount(next);
    },
    [],
  );
  const { locked, lockTooltip, blockedTooltip, organizationName } = useMemo(
    () => resolveTelemetryLocks(account, workspaceContext),
    [account, workspaceContext],
  );
  const scopeDescriptions = useMemo(
    () =>
      resolveTelemetryScopeDescriptions(workspaceContext, contextOrganizations),
    [workspaceContext, contextOrganizations],
  );

  // Each loader returns a cancel function. Calling it before the in-flight
  // request resolves drops that response, so a superseded or post-unmount load
  // can't overwrite newer state out of order.
  const loadAccount = useCallback((): (() => void) => {
    let cancelled = false;
    void window.api
      .loadCanopyCloudAccount()
      .then((next) => {
        if (!cancelled) {
          applyAccountLocks(next);
        }
      })
      .catch(() => {
        // Unlinked or unreadable account — reset to the off/private fallback so
        // a transient failure after a successful load can't leave stale locks.
        if (!cancelled) {
          applyAccountLocks(null);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [applyAccountLocks]);

  const loadSharing = useCallback((): (() => void) => {
    let cancelled = false;
    void window.api.loadPreferences().then((prefs) => {
      if (cancelled) {
        return;
      }
      setSharing(prefs.telemetrySharing);
      setLoaded(true);
    });
    return (): void => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cancelSharing = loadSharing();
    const cancelAccount = loadAccount();
    return (): void => {
      cancelSharing();
      cancelAccount();
    };
  }, [loadSharing, loadAccount]);

  // Re-render locked/forced values when the main process applies org-enforced
  // settings (e.g. after sign-in or a periodic re-probe). Cancel any prior
  // in-flight reload before starting a new one so the latest result wins.
  useEffect(() => {
    let cancelSharing: (() => void) | undefined;
    let cancelAccount: (() => void) | undefined;
    const unsubscribe = window.api.onPreferencesChanged(() => {
      cancelSharing?.();
      cancelAccount?.();
      cancelSharing = loadSharing();
      cancelAccount = loadAccount();
    });
    return (): void => {
      cancelSharing?.();
      cancelAccount?.();
      unsubscribe();
    };
  }, [loadSharing, loadAccount]);

  // On mount, re-probe the account against the server so org-enforced locks
  // reflect the latest state without waiting for the periodic background
  // re-probe. Apply the returned account directly: enforcement that only
  // updates the lock map (a scope already at `organization`) doesn't change a
  // pref value and so won't broadcast `preferencesChanged`, meaning the
  // subscription above isn't enough on its own. Offline/signed-out resolves to
  // the cached state, so the cached locks from loadAccount() stay put.
  useEffect(() => {
    let cancelled = false;
    void window.api
      .refreshCanopyCloudEnforcedSettings()
      .then((next) => {
        if (!cancelled) {
          applyAccountLocks(next);
        }
      })
      .catch(() => {
        // Keep the cached locks already shown by loadAccount().
      });
    return (): void => {
      cancelled = true;
    };
  }, [applyAccountLocks]);

  const handleChange = useCallback(
    (next: TelemetrySharingPreferences): void => {
      const previous = sharingRef.current;
      setSharing(next);
      void window.api.savePreferences({ telemetrySharing: next }).catch(() => {
        // Roll back the optimistic update if persistence failed.
        setSharing(previous);
      });
    },
    [],
  );

  // A local-only build sends no usage data and syncs no activity, so there is
  // nothing to choose here. The line names what a person would otherwise look
  // for, in the words of the Settings Version row.
  if (!telemetrySharingAvailable) {
    return (
      <SettingsPage title="Privacy" dataTestId="settings-tab-privacy">
        <SettingsPageMessage>
          <span data-testid="settings-privacy-local-only">
            Usage data, error reports, and activity sharing are off in this
            build.
          </span>
        </SettingsPageMessage>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Privacy" dataTestId="settings-tab-privacy">
      {/* No hosted account to sync with in a local-only build. */}
      {!hostedSettingsAvailable && cloudAccountAvailable && (
        <SettingsSection title="Cloud sync">
          <SettingsGroup>
            <CanopyCloudAccountSection />
          </SettingsGroup>
        </SettingsSection>
      )}

      {/* Its own section, and nothing while its flag is off. */}
      {!hostedSettingsAvailable && <PersonalCatalogSettings />}

      <UsageDataSection />

      {/* What sharing is for and how the data is protected is the section's
          description. The sync status is a quiet line right-aligned under the
          choices it reports on, and the heading holds only text. */}
      <SettingsSection
        title="Activity sharing"
        dataTestId="telemetry-disclosure"
        description={
          <p>
            Sync your agent activity to {brandText.appName} Cloud to search past
            runs, pick up work across machines, and share runs with your team.{' '}
            <span data-testid="telemetry-disclosure-protection">
              Secrets like API keys are scrubbed before anything leaves the app,
              and uploaded transcripts and plans are encrypted on{' '}
              {brandText.appName} Cloud.
            </span>
          </p>
        }
      >
        <TelemetrySharingControls
          value={sharing}
          rawValue={sharing}
          onChange={handleChange}
          availableScopes={availableScopes}
          disabled={!loaded}
          locked={locked}
          lockTooltip={lockTooltip}
          blockedTooltip={blockedTooltip}
          lockOrganizationName={organizationName}
          scopeDescriptions={scopeDescriptions}
        />
        {syncStatus ? (
          <div className="flex justify-end">
            <CloudSyncStatus
              status={syncStatus}
              cloudConnected={cloudCredentialUsable}
            />
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
