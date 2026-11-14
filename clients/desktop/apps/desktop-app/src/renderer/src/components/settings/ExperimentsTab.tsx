import { isAntigravityHarnessReleased } from '@/lib/antigravity-settings';
import { GoogleSubscriptionConnection } from './GoogleSubscriptionConnection';
import { OpenCodeConnection } from './OpenCodeConnection';
import { AccountProxyOptInSection } from './account-proxy/AccountProxyOptInSection';
import { isCursorHarnessReleased } from '@/lib/cursor-settings';
import { isCopilotHarnessReleased } from '@/lib/copilot-settings';
import { isOpenCodeHarnessReleased } from '@/lib/opencode-settings';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { type JSX, useEffect, useState } from 'react';
import type { PreferencesLoadResult } from '@canopy/desktop-shared/types';
import { ManagedDelegationSettings } from './ManagedDelegationSettings';
import { CopilotConnection } from './CopilotConnection';
import { CursorConnection } from './CursorConnection';
import { CursorApprovalCheck } from './CursorApprovalCheck';
import { DesktopLabsSettingsSection } from './hosted/DesktopLabsSettingsSection';
import { RemoteControlOptInSection } from './RemoteControlOptInSection';
import { RendererCodeCacheSection } from './RendererCodeCacheSection';
import { SettingsPage, SettingsLoading } from './SettingsLayout';

/**
 * Settings → Labs tab. Hosts experimental features that are still
 * being evaluated: the early access master switch, managed delegation, the
 * Cursor harness diagnostics, the remote access opt-in and faster window
 * opening. How much of an agent's work chats show is under Display →
 * Appearance. Code Graph has its own settings page.
 */
export function ExperimentsTab(): JSX.Element {
  const opencodeHarnessEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key),
  );
  const copilotHarnessEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  );
  const cursorHarnessEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );
  const antigravityEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAntigravityHarness.key),
  );
  const antigravityReleased = useFeatureFlagsStore(
    isAntigravityHarnessReleased,
  );
  const cursorReleased = useFeatureFlagsStore(isCursorHarnessReleased);
  const copilotReleased = useFeatureFlagsStore(isCopilotHarnessReleased);
  const opencodeReleased = useFeatureFlagsStore(isOpenCodeHarnessReleased);
  const accountProxyFlagEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy.key),
  );
  const remoteControlFlagEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDeviceRemoteControl.key),
  );
  // The switch belongs to the computer in front of the user, so a window
  // that shows another computer leaves it out.
  const localWindow = useRemoteControlStore(
    (store) => store.context.mode === 'local',
  );
  const [delegationPreferences, setDelegationPreferences] = useState<
    Pick<
      PreferencesLoadResult,
      | 'managedDelegationMode'
      | 'managedDelegationMaxConcurrent'
      | 'managedDelegationMaxDepth'
      | 'managedDelegationLifetimeLimit'
      | '__managedDelegationRevocationIncomplete'
      | 'remoteControlEnabled'
    >
  >({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (cancelled) {
          return;
        }
        setDelegationPreferences({
          managedDelegationMode: prefs.managedDelegationMode,
          managedDelegationMaxConcurrent: prefs.managedDelegationMaxConcurrent,
          managedDelegationMaxDepth: prefs.managedDelegationMaxDepth,
          managedDelegationLifetimeLimit: prefs.managedDelegationLifetimeLimit,
          __managedDelegationRevocationIncomplete:
            prefs.__managedDelegationRevocationIncomplete,
          remoteControlEnabled: prefs.remoteControlEnabled,
        });
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  if (!loaded) {
    return (
      <SettingsPage
        title="Labs"
        description="Try experimental features."
        dataTestId="settings-tab-experiments"
      >
        <SettingsLoading />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Labs"
      description="Try experimental features."
      dataTestId="settings-tab-experiments"
    >
      <DesktopLabsSettingsSection />

      <ManagedDelegationSettings
        initialLifetimeLimit={
          delegationPreferences.managedDelegationLifetimeLimit
        }
        initialMaxDepth={delegationPreferences.managedDelegationMaxDepth}
        initialMaxConcurrent={
          delegationPreferences.managedDelegationMaxConcurrent
        }
        initialMode={delegationPreferences.managedDelegationMode ?? 'off'}
        initialRevocationIncomplete={
          delegationPreferences.__managedDelegationRevocationIncomplete
        }
      />

      {cursorHarnessEnabled && !cursorReleased && (
        <>
          <CursorConnection />
          <CursorApprovalCheck />
        </>
      )}
      {window.platform === 'darwin' &&
        antigravityEnabled &&
        !antigravityReleased && <GoogleSubscriptionConnection />}
      {copilotHarnessEnabled && !copilotReleased && <CopilotConnection />}
      {opencodeHarnessEnabled && !opencodeReleased && <OpenCodeConnection />}
      {accountProxyFlagEnabled && <AccountProxyOptInSection />}
      {remoteControlFlagEnabled && localWindow && (
        <RemoteControlOptInSection
          initialEnabled={delegationPreferences.remoteControlEnabled !== false}
          onSaved={(enabled): void => {
            setDelegationPreferences((current) => ({
              ...current,
              remoteControlEnabled: enabled,
            }));
          }}
        />
      )}
      <RendererCodeCacheSection />
    </SettingsPage>
  );
}
