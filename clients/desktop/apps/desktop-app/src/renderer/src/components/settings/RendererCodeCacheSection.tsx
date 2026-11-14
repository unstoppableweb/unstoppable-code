import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import {
  ErrorBanner,
  Notice,
  NoticeButton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

const SAVE_ERROR_MESSAGE = 'Could not save this setting. Try again.';
const HEADING = 'Open windows faster';
const LABEL = 'Keep app code ready';
const TOGGLE_ID = 'settings-renderer-code-cache-toggle';
const FELL_BACK_MESSAGE =
  "This was turned off because windows couldn't open this way.";
const SWITCH_BACK_FAILED_MESSAGE =
  "This is still on because saved window state couldn't be moved back. Turn it off to try again.";

/**
 * Settings → Labs → "Open windows faster".
 *
 * The switch persists `PreferencesData.rendererCodeCacheSchemeEnabled`.
 * The change applies at the next launch: main then moves the app's saved
 * window state to the new way of loading before any window opens. When the
 * saved value differs from what this launch runs with, the row offers the
 * app's existing restart. If a launch could not open its windows this way,
 * main turns the setting back off and the row says so. If a launch could not
 * move the saved state back after the setting was turned off, main turns it
 * back on (it stays on until the user turns it off again) and the row says
 * that instead. The save is optimistic and rolls back to the last persisted
 * value if it fails.
 */
export function RendererCodeCacheSection(): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [active, setActive] = useState(false);
  const [fellBack, setFellBack] = useState(false);
  const [switchBackFailed, setSwitchBackFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [restartUnavailable, setRestartUnavailable] = useState(false);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (cancelled) return;
        const next = prefs.rendererCodeCacheSchemeEnabled === true;
        setEnabled(next);
        enabledRef.current = next;
        setActive(prefs.__rendererCodeCacheSchemeActive === true);
        setFellBack(prefs.__rendererCodeCacheSchemeFellBack === true);
        setSwitchBackFailed(
          prefs.__rendererCodeCacheSchemeSwitchBackFailed === true,
        );
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const handleToggle = useCallback((next: boolean): void => {
    const previous = enabledRef.current;
    setEnabled(next);
    enabledRef.current = next;
    setSaving(true);
    setSaveError(null);
    setRestartUnavailable(false);
    void window.api
      .savePreferences({ rendererCodeCacheSchemeEnabled: next })
      .then((prefs) => {
        const committed = prefs.rendererCodeCacheSchemeEnabled === true;
        setEnabled(committed);
        enabledRef.current = committed;
      })
      .catch(() => {
        setEnabled(previous);
        enabledRef.current = previous;
        setSaveError(SAVE_ERROR_MESSAGE);
      })
      .finally(() => {
        setSaving(false);
      });
  }, []);

  const handleRestart = useCallback((): void => {
    void window.api
      .restartApp()
      .then((scheduled) => {
        if (!scheduled) setRestartUnavailable(true);
      })
      .catch(() => {
        setRestartUnavailable(true);
      });
  }, []);

  const restartNeeded = loaded && enabled !== active;

  return (
    <SettingsSection
      title={HEADING}
      headingId="settings-renderer-code-cache-heading"
      dataTestId="settings-renderer-code-cache"
    >
      {saveError && (
        <div data-testid="renderer-code-cache-error">
          <ErrorBanner
            errorSource="renderer-code-cache-section-save"
            className=""
            error={saveError}
          />
        </div>
      )}
      {fellBack && !enabled && (
        <Notice intent="attention" data-testid="renderer-code-cache-fell-back">
          {FELL_BACK_MESSAGE}
        </Notice>
      )}
      {switchBackFailed && enabled && (
        <Notice
          intent="attention"
          data-testid="renderer-code-cache-switch-back-failed"
        >
          {SWITCH_BACK_FAILED_MESSAGE}
        </Notice>
      )}
      <SettingsGroup>
        <SettingsRow
          label={LABEL}
          htmlFor={TOGGLE_ID}
          description={`Windows open sooner after the first launch. Takes effect after you restart ${brandText.appName}.`}
          control={
            <ToggleSwitch
              id={TOGGLE_ID}
              checked={enabled}
              disabled={!loaded || saving}
              label={LABEL}
              onChange={handleToggle}
              dataTestId="renderer-code-cache-toggle"
            />
          }
        >
          {restartNeeded && (
            <Notice
              intent="neutral"
              data-testid="renderer-code-cache-restart"
              actions={
                restartUnavailable ? undefined : (
                  <NoticeButton
                    variant="primary"
                    onClick={handleRestart}
                    data-testid="renderer-code-cache-restart-button"
                  >
                    Restart
                  </NoticeButton>
                )
              }
            >
              {restartUnavailable
                ? `Quit and reopen ${brandText.appName} to apply this change.`
                : `Restart ${brandText.appName} to apply this change.`}
            </Notice>
          )}
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
