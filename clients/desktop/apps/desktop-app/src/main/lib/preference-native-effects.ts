import { getDefaultBrowserRegistrationService } from '../browser/default-browser-registration';
import {
  setCloseToTrayPreference,
  syncActivationTray,
} from '../lifecycle/background-presence';
import {
  tryGetGlobalFocusShortcutService,
  type GlobalFocusShortcutService,
} from '../lifecycle/global-focus-shortcut';
import { requestActivationRecompute } from '../notifications/campaigns/scheduler';
import {
  getWakeLockService,
  type WakeLockService,
} from '../power/wake-lock-service';

export type FocusShortcutPort = Pick<
  GlobalFocusShortcutService,
  'apply' | 'getActiveAccelerator'
>;

/**
 * The host effects a committed preferences save drives on this computer
 * (CAN-4474). The save decides when each runs; the host decides how. CAN-5722
 * drives the same ports from daemon-committed changes.
 */
export interface PreferenceNativeEffects {
  keepAwake: Pick<WakeLockService, 'setEnabled'>;
  backgroundPresence: { applyCloseToTray(enabled: boolean): void };
  activationSchedule: { notificationInputsChanged(): void };
  /** Null until the shortcut service starts, as in unit suites. */
  focusShortcut(): FocusShortcutPort | null;
  /** Serial: each request applies after every earlier one settles. */
  defaultBrowser: { requestRegistration(enabled: boolean): Promise<unknown> };
}

function createElectronPreferenceNativeEffects(): PreferenceNativeEffects {
  let registrationQueue: Promise<void> = Promise.resolve();
  return {
    keepAwake: {
      setEnabled: (enabled) => getWakeLockService().setEnabled(enabled),
    },
    backgroundPresence: {
      applyCloseToTray: (enabled) => {
        setCloseToTrayPreference(enabled);
        // Create or destroy the tray to match, and fall back to disabling
        // close-to-tray if creation fails -- a resident app with no window and
        // no tray icon is unreachable except through Task Manager.
        if (!syncActivationTray()) {
          setCloseToTrayPreference(false);
        }
      },
    },
    activationSchedule: {
      notificationInputsChanged: () => requestActivationRecompute(),
    },
    focusShortcut: () => tryGetGlobalFocusShortcutService(),
    defaultBrowser: {
      requestRegistration: (enabled) => {
        // Resolved inside the queue, so a service that never started becomes
        // this request's rejection rather than a throw at the caller.
        const operation = registrationQueue.then(() =>
          getDefaultBrowserRegistrationService().apply({
            enabled,
            promptForWindowsSettings: enabled,
          }),
        );
        registrationQueue = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
    },
  };
}

export const electronPreferenceNativeEffects =
  createElectronPreferenceNativeEffects();
