import { type JSX, useId, useState } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { ErrorBanner, ToggleSwitch } from '@canopy/ui-shared';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

const SAVE_ERROR_MESSAGE = 'Could not save this setting. Try again.';
const TOGGLE_LABEL = REMOTE_CONTROL_LABEL;

interface RemoteControlOptInSectionProps {
  /** The saved `remoteControlEnabled` preference. */
  readonly initialEnabled: boolean;
  /**
   * Reports each saved value, so a parent that remounts this section (the
   * flag going off and back on) passes the current choice back in.
   */
  readonly onSaved?: (enabled: boolean) => void;
}

/**
 * Settings → Labs → Remote Control: the per-user opt-in for
 * device-to-device remote control. Mounted only while the
 * `canopy-device-remote-control` flag is on, in a window that shows this
 * computer. The save is optimistic and rolls back if it fails.
 */
export function RemoteControlOptInSection({
  initialEnabled,
  onSaved,
}: RemoteControlOptInSectionProps): JSX.Element {
  const toggleId = useId();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = (next: boolean): void => {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    setSaveError(null);
    void window.api
      .savePreferences({ remoteControlEnabled: next })
      .then((prefs) => {
        const saved = prefs.remoteControlEnabled !== false;
        setEnabled(saved);
        onSaved?.(saved);
      })
      .catch(() => {
        setEnabled(previous);
        setSaveError(SAVE_ERROR_MESSAGE);
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <SettingsSection
      title={REMOTE_CONTROL_LABEL}
      dataTestId="settings-experiments-remote-control"
    >
      <ErrorBanner
        errorSource="remote-control-opt-in-section-save"
        className=""
        error={saveError}
      />
      <SettingsGroup>
        <SettingsRow
          label={TOGGLE_LABEL}
          htmlFor={toggleId}
          description={`Pair your devices and control one from another. Adds ${REMOTE_CONTROL_LABEL} to Settings and your computers to the account menu.`}
          control={
            <ToggleSwitch
              id={toggleId}
              checked={enabled}
              disabled={saving}
              label={TOGGLE_LABEL}
              dataTestId="remote-control-opt-in-toggle"
              onChange={save}
            />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
