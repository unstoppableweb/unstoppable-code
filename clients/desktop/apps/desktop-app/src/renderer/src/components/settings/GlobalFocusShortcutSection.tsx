import {
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  GlobalFocusShortcutFailureReason,
  GlobalFocusShortcutStatus,
} from '@canopy/desktop-shared/types';
import {
  acceleratorFromKeyboardEvent,
  formatAcceleratorForDisplay,
  GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR,
  validateGlobalShortcut,
  type ShortcutPlatform,
} from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import {
  Button,
  Kbd,
  ToggleSwitch,
  ErrorBanner,
  FieldError,
} from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';
import {
  findInAppShortcutConflict,
  GLOBAL_FOCUS_SHORTCUT_SETTINGS_TARGET,
  rendererShortcutPlatform,
} from '@/lib/globalFocusShortcut';
import {
  formatGlobalFocusShortcutForDisplay,
  useGlobalFocusShortcutStatus,
  useGlobalFocusShortcutStore,
} from '@/stores/globalFocusShortcutStore';
import {
  SettingsDescriptionLoading,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';

const TOGGLE_ID = 'settings-global-focus-shortcut-toggle';
const TOGGLE_LABEL = 'Global shortcut';

interface RecorderState {
  /** Canonical accelerator captured so far; null before the first press. */
  accelerator: string | null;
  /** Why the captured chord cannot be saved; null when it can. */
  problem: string | null;
}

function modifierHint(platform: ShortcutPlatform): string {
  // ⌥ alone is the macOS special-character layer, so it is not offered there.
  return platform === 'darwin' ? '⌘' : 'Ctrl or Alt';
}

function problemFor(
  reason: GlobalFocusShortcutFailureReason,
  platform: ShortcutPlatform,
): string {
  switch (reason) {
    case 'needs-modifier':
      return `Add a modifier key such as ${modifierHint(platform)}`;
    case 'reserved':
      return 'Reserved by your system. Choose another shortcut';
    case 'in-use':
      return 'Another app is using it. Try a different shortcut';
    case 'invalid':
      return 'Choose another shortcut';
  }
}

/**
 * Validation the recorder runs on every press: the shared OS rules plus the
 * in-app conflict check, which only the renderer can do (the command table
 * lives here).
 */
function validateRecorded(
  accelerator: string,
  platform: ShortcutPlatform,
): string | null {
  const validation = validateGlobalShortcut(accelerator, platform);
  if (!validation.ok) return problemFor(validation.reason, platform);
  const conflict = findInAppShortcutConflict(
    formatAcceleratorForDisplay(validation.accelerator, platform),
    platform,
  );
  if (conflict === null) return null;
  return `Already used by ${conflict.title}`;
}

function statusText(
  status: GlobalFocusShortcutStatus | null,
  chord: string,
): string {
  if (status === null || !status.enabled) return 'Off';
  if (status.registered) {
    return status.lastTriggeredAt !== undefined
      ? 'Working'
      : 'Active. Press it now to check it works';
  }
  switch (status.failure) {
    case 'in-use':
      return `Not active. Another app is using ${chord}.`;
    case 'reserved':
      return `Not active. ${chord} is reserved by your system.`;
    case 'needs-modifier':
      return 'Not active. Choose a shortcut with a modifier key.';
    case 'invalid':
      return 'Not active. Choose another shortcut.';
    case undefined:
      return 'Not active.';
  }
}

/**
 * Settings → Shortcuts → "Focus from anywhere" (CAN-1963): the opt-in
 * toggle, the saved chord with its live registration status, and the
 * recorder for changing it. The main process owns registration; every
 * change goes through `window.api.globalFocusShortcut.update`, which
 * registers with the OS before saving and keeps the previous chord when the
 * new one is refused.
 */
export function GlobalFocusShortcutSection(): JSX.Element {
  const { status, hydrated, busy } = useGlobalFocusShortcutStatus();
  const platform = status?.platform ?? rendererShortcutPlatform();
  const chord = formatGlobalFocusShortcutForDisplay(status);
  const enabled = status?.enabled ?? false;
  const [recorder, setRecorder] = useState<RecorderState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const recorderInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (recorder !== null) recorderInput.current?.focus();
  }, [recorder]);

  useCurrentUiStateReporter('settings.globalFocusShortcut', {
    loaded: hydrated,
    enabled,
    shortcut: chord,
    registered: status?.registered ?? false,
    recording: recorder !== null,
  });

  const update = useCallback(
    async (
      request: Parameters<
        ReturnType<typeof useGlobalFocusShortcutStore.getState>['update']
      >[0],
    ): Promise<boolean> => {
      setSaveError(null);
      let response: Awaited<
        ReturnType<
          ReturnType<typeof useGlobalFocusShortcutStore.getState>['update']
        >
      >;
      try {
        response = await useGlobalFocusShortcutStore.getState().update(request);
      } catch {
        // Main restored the OS registration before rethrowing a failed
        // preference write; the user still needs to hear that nothing was
        // saved, not watch the toggle snap back in silence.
        setSaveError("Couldn't save the shortcut. Try again.");
        return false;
      }
      if (response === null || response.ok) return true;
      const refused = formatAcceleratorForDisplay(
        response.accelerator,
        platform,
      );
      setSaveError(
        `Couldn't use ${refused}. ${problemFor(response.reason, platform)}.`,
      );
      return false;
    },
    [platform],
  );

  const handleToggle = useCallback((): void => {
    void update({ enabled: !enabled });
  }, [enabled, update]);

  const handleRecorderKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      const bare =
        !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      // Tab and Shift+Tab are focus movement, never a chord: let them reach
      // Save and Cancel (and back out) instead of trapping keyboard users.
      if (
        event.code === 'Tab' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const bareEscape = bare && event.code === 'Escape';
      if (bareEscape) {
        setRecorder(null);
        setSaveError(null);
        return;
      }
      const accelerator = acceleratorFromKeyboardEvent(event, platform);
      if (accelerator === null) return;
      setSaveError(null);
      setRecorder({
        accelerator,
        problem: validateRecorded(accelerator, platform),
      });
    },
    [platform],
  );

  const handleSave = useCallback((): void => {
    if (recorder === null || recorder.accelerator === null) return;
    void update({ accelerator: recorder.accelerator }).then((ok) => {
      if (ok) setRecorder(null);
    });
  }, [recorder, update]);

  const handleReset = useCallback((): void => {
    setRecorder(null);
    void update({ accelerator: GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR });
  }, [update]);

  const canSave =
    recorder !== null &&
    recorder.accelerator !== null &&
    recorder.problem === null;
  const preview =
    recorder?.accelerator === null || recorder === null
      ? null
      : formatAcceleratorForDisplay(recorder.accelerator, platform);

  return (
    <SettingsSection
      title="Focus from anywhere"
      description={
        <>
          Press the shortcut in any app to bring {brandText.appName} to the
          front.
        </>
      }
      headingId="settings-global-focus-shortcut-heading"
      dataTestId={GLOBAL_FOCUS_SHORTCUT_SETTINGS_TARGET}
    >
      <SettingsGroup>
        <SettingsRow
          label={TOGGLE_LABEL}
          htmlFor={TOGGLE_ID}
          control={
            <ToggleSwitch
              id={TOGGLE_ID}
              checked={enabled}
              disabled={!hydrated || busy}
              label={TOGGLE_LABEL}
              onChange={handleToggle}
              dataTestId="global-focus-shortcut-toggle"
            />
          }
        />
        <SettingsRow
          label="Shortcut"
          description={
            <span data-testid="global-focus-shortcut-status" aria-live="polite">
              {hydrated ? (
                statusText(status, chord)
              ) : (
                <SettingsDescriptionLoading />
              )}
            </span>
          }
          control={
            <>
              <span data-testid="global-focus-shortcut-chord">
                <Kbd data-testid="shortcut-keys" shortcut={chord} />
              </span>
              {recorder === null && (
                <Button
                  size="compact"
                  variant="secondary"
                  data-testid="global-focus-shortcut-change"
                  disabled={!hydrated || busy}
                  onClick={(): void => {
                    setSaveError(null);
                    setRecorder({ accelerator: null, problem: null });
                  }}
                >
                  Change shortcut
                </Button>
              )}
              {recorder === null &&
                status !== null &&
                status.accelerator !==
                  GLOBAL_FOCUS_SHORTCUT_DEFAULT_ACCELERATOR && (
                  <Button
                    size="compact"
                    variant="secondary"
                    data-testid="global-focus-shortcut-reset"
                    disabled={busy}
                    onClick={handleReset}
                  >
                    Reset to default
                  </Button>
                )}
            </>
          }
        >
          {recorder !== null && (
            <div
              className="flex flex-col gap-2"
              data-testid="global-focus-shortcut-recorder-panel"
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SettingsTextField
                    ref={recorderInput}
                    type="text"
                    width="full"
                    readOnly
                    value=""
                    placeholder="Press the new shortcut"
                    aria-label="Press the new shortcut"
                    data-testid="global-focus-shortcut-recorder"
                    onKeyDown={handleRecorderKeyDown}
                  />
                </div>
                <span
                  data-testid="global-focus-shortcut-preview"
                  className="flex min-h-6 items-center"
                  aria-live="polite"
                >
                  {preview !== null && (
                    <Kbd data-testid="shortcut-keys" shortcut={preview} />
                  )}
                </span>
                <Button
                  size="compact"
                  variant="secondary"
                  data-testid="global-focus-shortcut-cancel"
                  onClick={(): void => {
                    setRecorder(null);
                    setSaveError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="compact"
                  variant="primary"
                  data-testid="global-focus-shortcut-save"
                  disabled={!canSave || busy}
                  onClick={handleSave}
                >
                  Save
                </Button>
              </div>
              {recorder.problem !== null ? (
                <FieldError
                  id="global-focus-shortcut-validation"
                  data-testid="global-focus-shortcut-validation"
                >
                  {recorder.problem}
                </FieldError>
              ) : (
                <p className="text-xs fg-secondary">
                  Hold the modifier keys and press a key. Esc cancels.
                </p>
              )}
            </div>
          )}
          <ErrorBanner
            errorSource="global-focus-shortcut-error"
            className=""
            error={saveError}
            testId="global-focus-shortcut-error"
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
