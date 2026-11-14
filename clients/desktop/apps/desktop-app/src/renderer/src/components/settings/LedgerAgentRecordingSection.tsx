import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { ErrorBanner, ToggleSwitch } from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

const SECTION_TITLE = 'Feed';
const LABEL = 'Agents add to the Feed';
const HELPER =
  'Agents add and update entries as they work. Turning this off stops them and keeps existing entries.';
const SAVE_ERROR_MESSAGE = "Couldn't save this setting. Try again.";
const SWITCH_ID = 'settings-ledger-agent-recording-switch';

/**
 * On unless the user turned it off. Main always normalizes the preference to
 * a boolean; reading a missing value as on keeps the documented default.
 */
function readRecordingEnabled(
  preferences: Pick<PreferencesData, 'ledgerAgentRecordingEnabled'>,
): boolean {
  return preferences.ledgerAgentRecordingEnabled !== false;
}

/**
 * Settings → General → "Agents add to the Feed" (Agent Ledger decision LD09).
 *
 * Hidden while `canopy-ledger-enabled` is off, so nothing about the Ledger
 * shows before its rollout. The switch persists
 * `PreferencesData.ledgerAgentRecordingEnabled`, which decides whether new
 * chat sessions are offered the Ledger tools and recording prompt. Turning it
 * off never removes existing entries.
 */
export function LedgerAgentRecordingSection(): JSX.Element | null {
  const ledgerEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key),
  );
  // The row owns the preference reads, so nothing is loaded while hidden.
  return ledgerEnabled ? (
    <SettingsSection title={SECTION_TITLE}>
      <SettingsGroup>
        <LedgerAgentRecordingRow />
      </SettingsGroup>
    </SettingsSection>
  ) : null;
}

function LedgerAgentRecordingRow(): JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const enabledRef = useRef(enabled);
  // While a save is in flight its result is authoritative: an earlier read or
  // a broadcast must not repaint the switch underneath it.
  const savingRef = useRef(false);

  const applyEnabled = useCallback((next: boolean): void => {
    enabledRef.current = next;
    setEnabled(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((preferences) => {
        if (cancelled || savingRef.current) return;
        applyEnabled(readRecordingEnabled(preferences));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [applyEnabled]);

  // Follows a choice saved from another window while Settings stays open.
  useEffect(
    () =>
      window.api.onPreferencesSynced((preferences) => {
        if (savingRef.current) return;
        applyEnabled(readRecordingEnabled(preferences));
        setLoaded(true);
      }),
    [applyEnabled],
  );

  const handleToggle = useCallback(
    (next: boolean): void => {
      const previous = enabledRef.current;
      applyEnabled(next);
      savingRef.current = true;
      setSaving(true);
      setSaveError(null);
      // Main merges this one field into the saved preferences.
      void window.api
        .savePreferences({ ledgerAgentRecordingEnabled: next })
        .then((preferences) => {
          applyEnabled(readRecordingEnabled(preferences));
        })
        .catch(() => {
          applyEnabled(previous);
          setSaveError(SAVE_ERROR_MESSAGE);
        })
        .finally(() => {
          savingRef.current = false;
          setSaving(false);
        });
    },
    [applyEnabled],
  );

  return (
    <SettingsRow
      label={LABEL}
      htmlFor={SWITCH_ID}
      description={HELPER}
      dataTestId="settings-ledger-agent-recording"
      control={
        <ToggleSwitch
          id={SWITCH_ID}
          checked={enabled}
          disabled={!loaded || saving}
          label={LABEL}
          onChange={handleToggle}
          dataTestId="settings-ledger-agent-recording-toggle"
        />
      }
    >
      <ErrorBanner
        errorSource="ledger-agent-recording-row-save"
        className=""
        error={saveError}
      />
    </SettingsRow>
  );
}
