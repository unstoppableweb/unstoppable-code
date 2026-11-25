import { BrowserWindow, Notification, shell } from 'electron';
import {
  IPC_CHANNELS,
  type OsNotificationClickEvent,
  type OsNotificationCloseEvent,
  type OsNotificationOptInResponse,
  type OsNotificationShowRequest,
  type OsNotificationShowResponse,
} from '@canopy/desktop-shared/types';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  resolveOsNotificationSoundForPlatform,
  windowsToastSoundEvent,
} from '@canopy/desktop-shared/notification-sounds';
import { BRAND } from '@canopy/brand/current';
import {
  projectPreferencesForRuntime,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { broadcastPreferencesSynced } from '../lib/preferences-broadcast';
import { requestActivationRecompute } from '../notifications/campaigns/scheduler';
import {
  handleCampaignNotificationClick,
  NOTIFICATION_ID_PREFIX,
} from '../notifications/campaigns/click-router';
import { sendToWindow } from '../lib/window-send';
import { noteUserActivation } from '../lib/main-window-focus';
import { registerIpcHandler } from './register';

const NOTIFICATION_BODY_MAX_LENGTH = 240;

// Retain notification references until the OS signals 'close' (or we time
// out). Without this, V8 can GC the Notification instance before macOS
// finishes displaying the alert, causing the notification to silently vanish.
const activeNotifications = new Map<string, Notification>();
const NOTIFICATION_RETENTION_MS = 10 * 60 * 1000;

/**
 * Activation campaigns are the one caller whose click genuinely arrives long
 * after delivery: the banner sits in Notification Center until the user comes
 * back, which is the entire point of a re-engagement nudge. Dropping the
 * reference after ten minutes lets V8 collect the wrapper, and Electron then
 * never dispatches `click` -- silently disabling the create-window-and-buffer
 * routing built for exactly those delayed clicks. Still bounded, so a
 * notification the OS never closes cannot leak for the process lifetime.
 */
const CAMPAIGN_NOTIFICATION_RETENTION_MS = 24 * 60 * 60 * 1000;

function retentionMsFor(id: string): number {
  // Imported rather than re-declared: a local copy that drifted from the
  // router's would silently drop retention back to ten minutes and kill
  // delayed click routing again, with no test to catch it.
  return id.startsWith(NOTIFICATION_ID_PREFIX)
    ? CAMPAIGN_NOTIFICATION_RETENTION_MS
    : NOTIFICATION_RETENTION_MS;
}

function truncateBody(text: string): string {
  if (text.length <= NOTIFICATION_BODY_MAX_LENGTH) return text;
  return `${text.slice(0, NOTIFICATION_BODY_MAX_LENGTH - 3)}...`;
}

/**
 * Whether XML 1.0 allows `codePoint`. Excluded: C0 controls other than tab,
 * LF and CR (terminal output can carry ESC), U+FFFE/U+FFFF, and lone
 * surrogates, which `truncateBody` can leave by cutting an emoji pair.
 */
function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Escapes text for the toast XML and drops characters XML cannot hold at all,
 * since Windows rejects a toast whose XML contains one.
 */
function escapeXml(text: string): string {
  // Iterating a string yields code points; a lone surrogate comes through on
  // its own and fails `isXmlChar`.
  return Array.from(text)
    .filter((char) => isXmlChar(char.codePointAt(0) ?? 0))
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Windows picks a toast's sound from its XML, not from a `sound` option, so a
 * named sound needs the toast spelled out: title, then body, like Electron's
 * plain toast, with the audio source added.
 */
function buildWindowsToastXml(
  title: string,
  body: string,
  soundEvent: string,
): string {
  return (
    '<toast><visual><binding template="ToastGeneric">' +
    `<text>${escapeXml(title)}</text><text>${escapeXml(body)}</text>` +
    `</binding></visual><audio src="ms-winsoundevent:${soundEvent}"/></toast>`
  );
}

interface PlatformSoundOptions {
  /** macOS: the system sound file name. */
  sound?: string;
  /** Windows: the toast that selects the sound. */
  toastXml?: string;
}

/**
 * Turns the requested sound into what this platform's `Notification` takes. A
 * name the platform does not offer (a macOS name saved on Windows, or the
 * reverse) is dropped so the OS default plays, instead of being passed to an
 * OS that ignores it. `body` is the already-truncated body the toast shows.
 *
 * An unrecognized host resolves like any non-Windows platform (the macOS
 * list), matching what Settings offers there, rather than failing the whole
 * notification over an optional sound.
 */
function platformSoundOptions(
  request: OsNotificationShowRequest,
  body: string,
): PlatformSoundOptions {
  if (!request.sound || request.silent) return {};
  const hostOs = hostOperatingSystem() ?? undefined;
  const sound = resolveOsNotificationSoundForPlatform(request.sound, hostOs);
  if (sound === 'System') return {};
  if (hostOs === 'win32') {
    const soundEvent = windowsToastSoundEvent(sound);
    return soundEvent
      ? { toastXml: buildWindowsToastXml(request.title, body, soundEvent) }
      : {};
  }
  return { sound };
}

export function registerOsNotificationHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  registerIpcHandler<[OsNotificationShowRequest], OsNotificationShowResponse>(
    IPC_CHANNELS.osNotificationShow,
    (event, request) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      return showOsNotification(request, () =>
        senderWindow && !senderWindow.isDestroyed()
          ? senderWindow
          : getWindow(),
      );
    },
  );

  registerIpcHandler<[], OsNotificationOptInResponse>(
    IPC_CHANNELS.osNotificationOptIn,
    () => enableOsNotificationsWithProbe(getWindow),
  );

  registerIpcHandler<[], void>(
    IPC_CHANNELS.osNotificationOpenSystemSettings,
    async () => {
      await openOsNotificationSettings();
    },
  );
}

/**
 * How long the opt-in waits for an asynchronous presentation failure before
 * ANSWERING the caller. It does not bound the recording: the `failed` handler
 * writes the marker whenever it fires, including long after this window has
 * elapsed and the promise has settled. An earlier version resolved and then
 * relied on that same settled promise, which silently dropped every late
 * refusal.
 *
 * There is no success event to wait for -- `show()` returning proves nothing,
 * and only `failed` is observable -- so the window only decides which answer
 * the UI gets first, not what is ultimately persisted.
 */
const OPT_IN_PROBE_FAILURE_WINDOW_MS = 1_500;

/**
 * macOS reports a missing notification authorization as UNErrorDomain 1.
 *
 * macOS ONLY. Windows suppresses a blocked toast without raising `failed` at
 * all, so a Windows user whose notifications are off at the OS level looks
 * indistinguishable from a delivered one here, and the blocked row will not
 * appear for them. Detecting that needs a Windows-specific capability check,
 * which Electron does not expose either; tracked separately rather than
 * papered over with a guess.
 */
function isAuthorizationFailure(error: Error): boolean {
  return /UNErrorDomain error 1\b/.test(error.message);
}

/**
 * Opens the OS's own notification settings. The user cannot grant
 * authorization from inside the app once it has been refused -- macOS only
 * ever prompts once -- so the only honest recovery is to send them there.
 */
export async function openOsNotificationSettings(): Promise<void> {
  const macBundleId = process.defaultApp ? 'com.github.Electron' : BRAND.appId;
  const target =
    process.platform === 'darwin'
      ? `x-apple.systempreferences:com.apple.preference.notifications?id=${encodeURIComponent(macBundleId)}`
      : 'ms-settings:notifications';
  try {
    await shell.openExternal(target);
  } catch {
    // Best-effort: a deep link that the OS refuses to open must not turn a
    // recovery hint into a crash.
  }
}

/**
 * Turns Canopy's notification gate on and immediately posts a confirmation
 * notification (CAN-2793).
 *
 * The post is the point, not a nicety: flipping the preference alone never
 * triggers the OS permission prompt, because Electron exposes no way to
 * request authorization. Posting is what makes the OS ask, and the same post
 * doubles as the probe that tells us whether the OS said yes.
 */
export async function enableOsNotificationsWithProbe(
  getWindow: () => BrowserWindow | null,
): Promise<OsNotificationOptInResponse> {
  // Updater form, not read-then-write. `writePreferencesFile` merges a
  // PARTIAL into whatever is on disk inside a serialized queue, so spreading a
  // snapshot read moments earlier would revert any unrelated preference
  // changed in between -- and the probe below holds this function open for up
  // to a second and a half, which is a wide window to lose a write in.
  //
  // Clearing the refusal marker here, BEFORE probing, is what makes the
  // blocked row recoverable: this function is the only thing that can retry,
  // so a user who fixed the permission in System Settings and came back needs
  // the slate wiped before the new attempt. A fresh refusal re-sets it below.
  await updatePreferencesFile((current) => ({
    osNotifications: { ...current.osNotifications, enabled: true },
    osNotificationsDeniedAt: undefined,
  }));

  // The scheduler classifies `notifications-disabled` as EVENT_DRIVEN and
  // deliberately never polls it, so a campaign already latched as suppressed
  // stays dormant until something re-evaluates. Writing the preference here
  // bypasses `applyPreferenceSideEffects`, which is where that normally
  // happens -- without this call the ten-minute window the whole layout is
  // arranged to hit can pass with the scheduler still asleep.
  requestActivationRecompute();

  const failure = await new Promise<Error | null>((resolve) => {
    const timer = setTimeout(
      () => resolve(null),
      OPT_IN_PROBE_FAILURE_WINDOW_MS,
    );
    const response = showOsNotification(
      {
        id: 'os-notification-opt-in-probe',
        title: `${BRAND.displayName} notifications are on`,
        body: 'You will hear about finished runs and things that need you.',
      },
      getWindow,
      (error) => {
        clearTimeout(timer);
        // The ONLY place a refusal is recorded, and deliberately not routed
        // through the promise: past the window it has already settled, so
        // `resolve` is a no-op and the slow refusals this exists to catch
        // were being dropped. The synchronous `!response.shown` branch below
        // needs no equivalent -- it can only be 'unsupported' or 'error',
        // neither of which is an authorization failure.
        void recordOsNotificationRefusal(error);
        resolve(error);
      },
    );
    if (!response.shown) {
      clearTimeout(timer);
      resolve(new Error(response.reason ?? 'error'));
    }
  });

  if (failure === null) return { enabled: true, delivered: true };
  return {
    enabled: true,
    delivered: false,
    reason: isAuthorizationFailure(failure)
      ? 'os-denied'
      : failure.message === 'unsupported'
        ? 'unsupported'
        : 'error',
  };
}

/**
 * Records the durable OS-refusal marker. Set-only by design: the marker is
 * cleared at the start of the next probe, so a refusal that arrives after the
 * probe answered still sticks instead of racing a clear.
 *
 * Exported so any other observer of a real presentation failure can feed the
 * same marker -- a refusal seen hours later is as real as one seen here.
 */
export async function recordOsNotificationRefusal(
  failure: Error,
): Promise<void> {
  if (!isAuthorizationFailure(failure)) return;
  try {
    const next = await updatePreferencesFile(() => ({
      osNotificationsDeniedAt: new Date().toISOString(),
    }));
    // `updatePreferencesFile` does not broadcast -- only the save IPC handler
    // does. Without this a refusal arriving after the probe answered is
    // persisted correctly but stays invisible until the next focus or
    // remount, which is precisely the case this whole path exists to surface.
    broadcastPreferencesSynced(next, projectPreferencesForRuntime);
  } catch {
    // The marker is a UX hint; failing to persist it must not fail the opt-in.
  }
}

/**
 * `onFailed` reports the ASYNCHRONOUS presentation failure. `show()` returning
 * without throwing does not mean the banner appeared: macOS accepts the
 * request and then rejects it (`UNErrorDomain` 1 when the app lacks
 * notification authorization), which arrives on the `failed` event long after
 * this function has returned `{ shown: true }`. Callers with once-per-user
 * semantics must use this rather than trusting the return value.
 */
export function showOsNotification(
  request: OsNotificationShowRequest,
  getWindow: () => BrowserWindow | null,
  onFailed?: (error: Error) => void,
): OsNotificationShowResponse {
  if (!Notification.isSupported()) {
    // eslint-disable-next-line no-console
    console.warn(
      '[os-notifications] Notification.isSupported() returned false',
    );
    return { shown: false, reason: 'unsupported' };
  }

  try {
    const body = truncateBody(request.body);
    const notification = new Notification({
      title: request.title,
      body,
      silent: request.silent ?? false,
      // Only set when the caller has chosen a sound this platform offers:
      // `sound` on macOS, `toastXml` on Windows.
      ...platformSoundOptions(request, body),
    });

    activeNotifications.set(request.id, notification);
    const retentionTimer = setTimeout(() => {
      activeNotifications.delete(request.id);
    }, retentionMsFor(request.id));

    notification.on('click', () => {
      const window = getWindow();
      noteUserActivation();
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) {
          window.restore();
        }
        window.show();
        window.focus();
      }
      const payload: OsNotificationClickEvent = { id: request.id };
      sendToWindow(window, IPC_CHANNELS.osNotificationClicked, payload);
      // No-ops for every non-campaign notification id. Campaign clicks need
      // their own path because they routinely arrive with no window open,
      // which the generic focus-and-forward above cannot handle.
      handleCampaignNotificationClick(request.id);
    });

    notification.on('close', () => {
      clearTimeout(retentionTimer);
      activeNotifications.delete(request.id);
      const payload: OsNotificationCloseEvent = { id: request.id };
      sendToWindow(getWindow(), IPC_CHANNELS.osNotificationClosed, payload);
    });

    notification.on('failed', (_event, error) => {
      clearTimeout(retentionTimer);
      activeNotifications.delete(request.id);
      // eslint-disable-next-line no-console
      console.error('[os-notifications] failed to display', error);
      // Electron types this as a string, not an Error.
      onFailed?.(new Error(String(error)));
    });

    notification.show();
    // eslint-disable-next-line no-console
    console.log(
      `[os-notifications] shown: id=${request.id} title=${JSON.stringify(request.title)}`,
    );
    return { shown: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[os-notifications] error showing notification', error);
    return { shown: false, reason: 'error' };
  }
}
