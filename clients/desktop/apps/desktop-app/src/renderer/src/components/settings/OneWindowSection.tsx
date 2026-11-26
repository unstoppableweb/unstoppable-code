import { type JSX, useId, useState } from 'react';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { ErrorBanner, ToggleSwitch } from '@canopy/ui-shared/components';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import {
  refreshOneWindowSwitch,
  useOneWindowSwitch,
} from '@/stores/oneWindowStore';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

const SAVE_ERROR_MESSAGE = 'Could not save this setting. Try again.';
const LABEL = 'One window for all computers';
// Nothing acts on the switch until the one-window work lands (CAN-7761 and
// later), so the description says so instead of promising the behavior.
// Those changes update it.
const DESCRIPTION =
  'Show tasks from your paired computers in this window instead of a separate window for each one. Still being built: turning it on changes nothing yet.';

/**
 * Settings → Labs → One window for all computers (CAN-7755): this
 * computer's switch for the one-window work. On by default in internal
 * builds, off in every other build, until the person chooses. Mounted only
 * in a window that shows this computer. The switch always shows main's
 * value; while a save is in flight it is disabled, and the read after the
 * save shows the result, so it never shows a choice main didn't apply. It
 * stays disabled until main's value has been read.
 */
export function OneWindowSection(): JSX.Element {
  const toggleId = useId();
  const { enabled, loaded } = useOneWindowSwitch();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<InlineFailure | null>(null);

  const save = (next: boolean): void => {
    setSaving(true);
    setSaveError(null);
    void window.api
      .savePreferences({ oneWindowEnabled: next })
      // Show main's value after the commit, not the reply's.
      .then(refreshOneWindowSwitch)
      .catch((cause: unknown) => {
        // The banner records the failure; reporting it here too would count
        // it twice.
        const appError = toAppError(resolveClientAppError(cause));
        setSaveError(
          appError
            ? inlineFailure(appError, SAVE_ERROR_MESSAGE)
            : { error: SAVE_ERROR_MESSAGE },
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <SettingsSection title={LABEL} dataTestId="settings-experiments-one-window">
      <ErrorBanner
        errorSource="one-window-section-save"
        className=""
        error={saveError?.error}
        {...(saveError?.details === undefined
          ? {}
          : { details: saveError.details })}
      />
      <SettingsGroup>
        <SettingsRow
          label={LABEL}
          htmlFor={toggleId}
          description={DESCRIPTION}
          control={
            <ToggleSwitch
              id={toggleId}
              checked={enabled}
              disabled={!loaded || saving}
              label={LABEL}
              dataTestId="one-window-toggle"
              onChange={save}
            />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
