import { type JSX, useCallback, useEffect } from 'react';
import { useSuggestionsStore } from '@canopy/app-state';
import {
  ErrorBanner,
  NoticeButton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';

const SECTION_TITLE = 'Suggestions';
const LABEL = 'Show suggestions';
const HELPER =
  'Offer suggestions, such as turning a repeated task into an automation, sharing a skill you use often, or trying plan mode. Turning this off hides suggestions and stops looking for them. It clears recorded tasks used for automation offers, but keeps skill suggestions and their request history.';
const SAVE_ERROR_MESSAGE = "Couldn't save this setting. Try again.";
const DISMISS_ERROR_MESSAGE =
  "Couldn't save a Don't show again choice. It stays hidden until you restart.";
const SWITCH_ID = 'settings-suggestions-switch';

/**
 * Settings → General → Suggestions (CAN-4343): the one master switch for
 * in-app suggestions. Reads and saves `PreferencesData.suggestions` through
 * the shared suggestions store; producers clean up after a committed off.
 */
export function SuggestionsSection(): JSX.Element {
  return (
    <SettingsSection title={SECTION_TITLE}>
      <SettingsGroup>
        <SuggestionsRow />
      </SettingsGroup>
    </SettingsSection>
  );
}

function SuggestionsRow(): JSX.Element {
  const status = useSuggestionsStore((state) => state.status);
  const enabled = useSuggestionsStore((state) => state.enabled);
  const saving = useSuggestionsStore((state) => state.saving);
  const saveFailed = useSuggestionsStore((state) => state.saveFailed);
  const failedDismissals = useSuggestionsStore(
    (state) => state.failedDismissals,
  );
  const setEnabled = useSuggestionsStore((state) => state.setEnabled);
  const dismiss = useSuggestionsStore((state) => state.dismiss);
  const load = useSuggestionsStore((state) => state.load);
  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = useCallback(
    (next: boolean): void => {
      void setEnabled(next);
    },
    [setEnabled],
  );
  const retryDismissals = useCallback((): void => {
    for (const id of failedDismissals) void dismiss(id);
  }, [dismiss, failedDismissals]);

  return (
    <SettingsRow
      label={LABEL}
      htmlFor={SWITCH_ID}
      description={HELPER}
      dataTestId="settings-suggestions"
      control={
        <ToggleSwitch
          id={SWITCH_ID}
          checked={enabled}
          disabled={status !== 'ready' || saving}
          label={LABEL}
          onChange={handleToggle}
          dataTestId="settings-suggestions-toggle"
        />
      }
    >
      <ErrorBanner
        errorSource="suggestions-row-save-failed"
        className=""
        error={saveFailed ? SAVE_ERROR_MESSAGE : null}
      />
      {failedDismissals.length > 0 ? (
        <div
          className="flex items-center gap-2"
          data-testid="settings-suggestions-dismiss-error"
        >
          <ErrorBanner
            errorSource="suggestions-row-dismiss"
            className=""
            error={DISMISS_ERROR_MESSAGE}
          />
          <NoticeButton
            variant="secondary"
            onClick={retryDismissals}
            data-testid="settings-suggestions-dismiss-retry"
          >
            Try again
          </NoticeButton>
        </div>
      ) : null}
    </SettingsRow>
  );
}
