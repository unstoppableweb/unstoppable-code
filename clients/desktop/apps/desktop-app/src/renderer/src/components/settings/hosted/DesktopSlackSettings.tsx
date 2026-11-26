import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { create } from 'zustand';
import { toAppError } from '@canopy/protocol/app-errors';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { Divider, ToggleSwitch } from '@canopy/ui-shared/components';
import { SlackIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  SlackLinkHostProvider,
  SlackSettingsSlotsProvider,
  SLACK_MENTION,
  type SlackConnectThisComputerResult,
  type SlackLinkHostPorts,
  type SlackSettingsSlots,
  type SlackThisComputerState,
} from '@canopy/ui-app/settings/slack';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  getRemoteControlApi,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import { SettingsRow } from '../SettingsLayout';

// ---------------------------------------------------------------------------
// Desktop pieces of Account → Integrations → Slack (CAN-7606).
//
// - The host port: Connect Slack runs desktop main's one-click flow
//   (`slack:connect-this-computer`), which turns on Listen for Slack mentions
//   and Allow incoming, pairs this computer for agents with no prompt when
//   needed, and opens the browser signed in straight at Slack's sign-in.
// - This computer for the shared section: its relay device, whether it
//   listens for Slack mentions (CAN-7604), and a way to change that, which
//   the section uses for Turn on and when its own link is disconnected. The
//   section has no switch of its own: Connect turns listening on.
// - The turn-off fallback: where the shared section can't show (signed out,
//   a failed load, a server that doesn't offer Slack) and the saved
//   preference is on, "On this computer" shows the plain switch so it can
//   always be turned off. The section reports whether it is on the page, so
//   the two switches are never on screen together.
// ---------------------------------------------------------------------------

// The switch keeps a label that says what it does; the row is titled by the
// app, like GitHub and Linear beside it.
const SLACK_MENTIONS_LABEL = 'Listen for Slack mentions';
const SLACK_MENTIONS_HELPER = `When you mention ${SLACK_MENTION} on Slack, your agents on this computer can start work and respond in the chat.`;

/**
 * Whether the shared Slack section is on the page: `null` until the
 * Integrations page has settled one way or the other.
 */
interface SlackSectionPresenceState {
  readonly present: boolean | null;
  readonly setPresent: (present: boolean) => void;
}

const useSlackSectionPresence = create<SlackSectionPresenceState>((set) => ({
  present: null,
  setPresent: (present): void => set({ present }),
}));

/**
 * The saved Listen for Slack mentions value as the switches last read or
 * saved it, so the shared section can say when this computer's own link
 * won't get mentions. `null` until a switch has read it.
 */
interface SlackListeningState {
  readonly enabled: boolean | null;
  readonly setEnabled: (enabled: boolean) => void;
}

const useSlackListening = create<SlackListeningState>((set) => ({
  enabled: null,
  setEnabled: (enabled): void => set({ enabled }),
}));

function useSlackMentionsOffered(): boolean {
  return useFeatureFlagsStore((store) =>
    store.isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDesktopSlackOrchestratorRequests.key,
    ),
  );
}

/**
 * Saves Listen for Slack mentions: the one save the switches and the shared
 * section's Turn on and Disconnect all use. Turning it on also lets other
 * devices control this computer, which every Slack request needs; turning
 * it off leaves that setting alone. The saved value is published through
 * `publish` before the Allow incoming step, so a failure there never leaves
 * a switch showing the old value.
 */
async function saveSlackListening(
  next: boolean,
  publish: (enabled: boolean) => void,
): Promise<void> {
  const saved = await window.api.savePreferences(
    { slackOrchestratorRequestsEnabled: next },
    { view: 'persisted' },
  );
  publish(saved.slackOrchestratorRequestsEnabled);
  if (next && !useRemoteControlStore.getState().state.allowIncoming) {
    await useRemoteControlStore.getState().setAllowIncoming(true);
  }
}

/**
 * The saved Slack preference. Reads nothing while the flag hides it; a
 * failed read leaves the switch disabled and reports why.
 */
function useSlackMentionsPreference(
  offered: boolean,
  onLoadError: (failure: InlineFailure) => void,
): {
  readonly enabled: boolean | null;
  readonly saving: boolean;
  readonly save: (next: boolean) => Promise<void>;
} {
  const [enabled, setLocalEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const setEnabled = useCallback((next: boolean): void => {
    setLocalEnabled(next);
    useSlackListening.getState().setEnabled(next);
  }, []);
  useEffect(() => {
    if (!offered) return undefined;
    let live = true;
    // Read now, and again whenever preferences change (Connect Slack and a
    // full desktop controller can change it too).
    const load = (): void => {
      void window.api
        .loadPreferences({ view: 'persisted' })
        .then((preferences) => {
          if (live) setEnabled(preferences.slackOrchestratorRequestsEnabled);
        })
        .catch((cause: unknown) => {
          const appError = toAppError(resolveClientAppError(cause));
          if (live && appError)
            onLoadError(
              inlineFailure(appError, "Couldn't load the Slack setting."),
            );
        });
    };
    load();
    const unsubscribe = window.api.onPreferencesChanged(load);
    return (): void => {
      live = false;
      unsubscribe();
    };
  }, [offered, onLoadError, setEnabled]);
  const save = useCallback(
    async (next: boolean): Promise<void> => {
      setSaving(true);
      try {
        await saveSlackListening(next, setEnabled);
      } finally {
        setSaving(false);
      }
    },
    [setEnabled],
  );
  return { enabled, saving, save };
}

/**
 * The Listen for Slack mentions row (the "On this computer" fallback). Its
 * save turns on Allow incoming with it; see `saveSlackListening`.
 */
function SlackMentionsSwitchRow({
  enabled,
  saving,
  save,
  testIdPrefix,
  error,
  setError,
}: {
  readonly enabled: boolean | null;
  readonly saving: boolean;
  readonly save: (next: boolean) => Promise<void>;
  readonly testIdPrefix: string;
  readonly error: InlineFailure | null;
  readonly setError: (failure: InlineFailure | null) => void;
}): JSX.Element {
  const toggle = (next: boolean): void => {
    setError(null);
    void save(next).catch((cause: unknown) => {
      const appError = toAppError(resolveClientAppError(cause));
      if (appError)
        setError(inlineFailure(appError, "Couldn't save the setting."));
    });
  };
  return (
    <div className="flex flex-col gap-3" data-settings-card-rows="">
      <DesktopErrorBanner
        errorSource={`${testIdPrefix}-error`}
        className=""
        error={error?.error}
        {...(error?.details === undefined ? {} : { details: error.details })}
        testId={`${testIdPrefix}-error`}
      />
      <div className="flex flex-col py-3">
        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              <SlackIcon
                size="md"
                className="shrink-0 fg-primary"
                aria-hidden
              />
              {SLACK_MENTIONS_LABEL}
            </span>
          }
          description={SLACK_MENTIONS_HELPER}
          htmlFor={testIdPrefix}
          dataTestId={`${testIdPrefix}-row`}
          control={
            <ToggleSwitch
              id={testIdPrefix}
              checked={enabled === true}
              label={SLACK_MENTIONS_LABEL}
              dataTestId={testIdPrefix}
              disabled={enabled === null || saving}
              onChange={toggle}
            />
          }
        />
      </div>
    </div>
  );
}

/**
 * Keeps the saved Listen for Slack mentions value in the shared store while
 * the settings pages are mounted, so the Slack section knows whether this
 * computer listens. A failed read leaves it unknown, and the section then
 * offers no Turn on; the section's own actions report their failures.
 */
function SlackListeningSync(): null {
  const offered = useSlackMentionsOffered();
  useSlackMentionsPreference(offered, ignoreListeningReadFailure);
  return null;
}

function ignoreListeningReadFailure(): void {
  // The section shows nothing for an unknown value; see SlackListeningSync.
}

/** Where the hosted Integrations page stands, as the device section sees it. */
export type SlackFallbackHostState =
  | 'loading'
  | 'signed_out'
  | 'error'
  | 'unavailable'
  | 'ready';

/**
 * The turn-off fallback under "On this computer": only while the preference
 * is on and the hosted page has settled without the shared Slack section.
 * Never while the page loads, so the switch doesn't flash here and move.
 */
export function SlackMentionsFallback({
  hostState,
}: {
  readonly hostState: SlackFallbackHostState;
}): JSX.Element | null {
  const offered = useSlackMentionsOffered();
  const present = useSlackSectionPresence((state) => state.present);
  const [error, setError] = useState<InlineFailure | null>(null);
  const preference = useSlackMentionsPreference(offered, setError);
  const settledWithout =
    hostState === 'signed_out' ||
    hostState === 'error' ||
    hostState === 'unavailable' ||
    (hostState === 'ready' && present === false);
  // Once shown, it stays while this computer's page is open, so turning it
  // off doesn't make the row vanish under the pointer.
  const [shown, setShown] = useState(false);
  const wanted = offered && settledWithout && preference.enabled === true;
  useEffect(() => {
    if (wanted) setShown(true);
    else if (!settledWithout) setShown(false);
  }, [wanted, settledWithout]);
  if (!offered || !settledWithout || !(wanted || shown)) return null;
  return (
    <div data-testid="account-device-card-slack">
      <Divider />
      <SlackMentionsSwitchRow
        {...preference}
        testIdPrefix="settings-slack-mentions-fallback"
        error={error}
        setError={setError}
      />
    </div>
  );
}

/** Rejects only when the bridge fails; the shared section reports that. */
function connectThisComputer(): Promise<SlackConnectThisComputerResult> {
  const api = getRemoteControlApi();
  if (api === null) return Promise.resolve({ ok: false, reason: 'failed' });
  return api.connectSlackThisComputer();
}

const DESKTOP_SLACK_LINK_PORTS: SlackLinkHostPorts = {
  kind: 'thisComputer',
  connectThisComputer,
};

/**
 * This computer for the shared section: its relay device id, matched against
 * each link's computer, whether it listens, and how to change that. Nothing
 * is reported about listening while the flag hides it.
 */
function useDesktopThisComputer(): SlackThisComputerState {
  const offered = useSlackMentionsOffered();
  const deviceId = useRemoteControlStore(
    (store) => store.state.thisDevice?.deviceId ?? null,
  );
  const enabled = useSlackListening((state) => state.enabled);
  return useMemo(
    () =>
      offered
        ? { deviceId, listening: enabled, setListening: setSlackListening }
        : { deviceId, listening: null },
    [deviceId, offered, enabled],
  );
}

function setSlackListening(next: boolean): Promise<void> {
  return saveSlackListening(next, useSlackListening.getState().setEnabled);
}

const DESKTOP_SLACK_SETTINGS_SLOTS: SlackSettingsSlots = {
  useThisComputer: useDesktopThisComputer,
  onSectionPresence: (present): void =>
    useSlackSectionPresence.getState().setPresent(present),
};

/** The desktop Slack ports and slots for the shared settings pages. */
export function DesktopSlackSettingsProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <SlackLinkHostProvider ports={DESKTOP_SLACK_LINK_PORTS}>
      <SlackSettingsSlotsProvider slots={DESKTOP_SLACK_SETTINGS_SLOTS}>
        <SlackListeningSync />
        {children}
      </SlackSettingsSlotsProvider>
    </SlackLinkHostProvider>
  );
}
