import { type JSX, useCallback, useEffect, useState } from 'react';
import { DEFAULT_VOICE_DICTATION_ENABLED } from '@canopy/desktop-shared/constants/preferences';
import type {
  PreferencesData,
  VoiceIsSupportedResponse,
  VoiceMicrophoneAccess,
  VoiceSpeechRecognitionAccess,
} from '@canopy/desktop-shared/types';
import {
  MICROPHONE_PRIVACY_SETTINGS_URL,
  SPEECH_PRIVACY_SETTINGS_URL,
} from '@/lib/voice/voice-error';
import { requestRendererMicrophoneAccess } from '@/lib/voice/renderer-microphone-access';
import { notifyVoiceDictationEnabledChanged } from '@/lib/voice/voice-dictation-pref';
import { isVoiceSystemAccessPlatform } from '@canopy/desktop-shared/platform-capabilities';
import { localPlatform } from '@/lib/local-platform';
import { brandText } from '@/lib/brand';
import {
  Button,
  ToggleSwitch,
  StatusLabel,
} from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from './SettingsLayout';
import { SpeechModelSection } from './SpeechModelSection';

const ENABLE_TOGGLE_ID = 'settings-dictation-enabled-toggle';

type SupportState =
  | { status: 'checking' }
  | { status: 'resolved'; response: VoiceIsSupportedResponse };

type MicState =
  | { status: 'checking' }
  | { status: 'resolved'; access: VoiceMicrophoneAccess };

type SpeechState =
  | { status: 'checking' }
  | { status: 'idle' }
  | { status: 'resolved'; access: VoiceSpeechRecognitionAccess };

function savePreference(patch: Partial<PreferencesData>): void {
  void window.api.savePreferences(patch);
}

/**
 * Dictation needs the operating system's microphone and Speech Recognition
 * permissions on macOS only. Linux has none to ask for; there the tab
 * explains microphone problems instead.
 */
function needsSystemAccess(): boolean {
  return isVoiceSystemAccessPlatform(localPlatform());
}

export function DictationTab(): JSX.Element {
  const systemAccess = needsSystemAccess();
  const [enabled, setEnabled] = useState(DEFAULT_VOICE_DICTATION_ENABLED);
  const [support, setSupport] = useState<SupportState>({ status: 'checking' });
  const [mic, setMic] = useState<MicState>({ status: 'checking' });
  const [speech, setSpeech] = useState<SpeechState>({ status: 'idle' });
  const [rechecking, setRechecking] = useState(false);
  const [requestingAccess, setRequestingAccess] = useState(false);

  const loadMicAccess = useCallback(async (): Promise<void> => {
    try {
      const access = await window.api.voice.getMicrophoneAccess();
      setMic({ status: 'resolved', access });
    } catch {
      setMic({ status: 'resolved', access: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api.loadPreferences().then((prefs) => {
      if (!cancelled) setEnabled(prefs.voiceDictationEnabled);
    });
    void window.api.voice
      .isSupported()
      .then((response) => {
        if (!cancelled) setSupport({ status: 'resolved', response });
      })
      .catch(() => {
        if (!cancelled) {
          setSupport({
            status: 'resolved',
            response: { supported: false, reason: 'probe failed' },
          });
        }
      });
    void loadMicAccess();
    return (): void => {
      cancelled = true;
    };
  }, [loadMicAccess]);

  const handleToggle = useCallback((next: boolean): void => {
    setEnabled(next);
    savePreference({ voiceDictationEnabled: next });
    notifyVoiceDictationEnabledChanged(next);
  }, []);

  const handleRecheck = useCallback(async (): Promise<void> => {
    setRechecking(true);
    setSupport({ status: 'checking' });
    setMic({ status: 'checking' });
    setSpeech({ status: 'idle' });
    try {
      const response = await window.api.voice.recheckSupported();
      setSupport({ status: 'resolved', response });
    } catch {
      setSupport({
        status: 'resolved',
        response: { supported: false, reason: 'probe failed' },
      });
    }
    await loadMicAccess();
    setRechecking(false);
  }, [loadMicAccess]);

  const handleModelInstalledChange = useCallback((): void => {
    void handleRecheck();
  }, [handleRecheck]);

  const handleRequestAccess = useCallback(async (): Promise<void> => {
    setRequestingAccess(true);
    setMic({ status: 'checking' });
    setSpeech({ status: 'checking' });
    let speechAccess: VoiceSpeechRecognitionAccess = 'unavailable';

    try {
      await requestRendererMicrophoneAccess();
    } catch {
      // The status query below reports the final TCC state. If macOS denied the
      // request, the row should still point the user at System Settings.
    }

    try {
      const access = await window.api.voice.requestSystemAccess();
      speechAccess = access.speechRecognition;
    } catch {
      speechAccess = 'unavailable';
    }

    try {
      const microphoneAccess = await window.api.voice.getMicrophoneAccess();
      setMic({ status: 'resolved', access: microphoneAccess });
    } catch {
      setMic({ status: 'resolved', access: 'unavailable' });
    } finally {
      setSpeech({ status: 'resolved', access: speechAccess });
      setRequestingAccess(false);
    }
  }, []);

  const handleOpenMicSettings = useCallback((): void => {
    void window.api.voice.openSettings({
      url: MICROPHONE_PRIVACY_SETTINGS_URL,
    });
  }, []);

  const handleOpenSpeechSettings = useCallback((): void => {
    void window.api.voice.openSettings({
      url: SPEECH_PRIVACY_SETTINGS_URL,
    });
  }, []);

  return (
    <SettingsPage title="Dictation" dataTestId="settings-tab-dictation">
      <SettingsSection title="General">
        <SettingsGroup>
          <SettingsRow
            label="Enable dictation"
            htmlFor={ENABLE_TOGGLE_ID}
            description={
              systemAccess
                ? 'Adds a microphone button to the chat input. Requires macOS 26 or later for on-device speech recognition.'
                : 'Adds a microphone button to the chat input. Speech is recognized on this computer, with a speech model you download once.'
            }
            control={
              <ToggleSwitch
                id={ENABLE_TOGGLE_ID}
                checked={enabled}
                label="Enable dictation"
                onChange={handleToggle}
                dataTestId="dictation-enabled-toggle"
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SpeechModelSection onInstalledChange={handleModelInstalledChange} />

      <SettingsSection title="Compatibility">
        <SettingsGroup>
          <SettingsRow
            label="On-device speech recognition"
            description={<SupportStatus state={support} />}
            control={
              <Button
                size="compact"
                variant="secondary"
                onClick={(): void => void handleRecheck()}
                disabled={
                  rechecking ||
                  support.status === 'checking' ||
                  mic.status === 'checking'
                }
                data-testid="dictation-recheck"
              >
                {rechecking ? 'Re-checking…' : 'Re-check'}
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      {systemAccess ? (
        <SettingsSection
          title="System access"
          description={
            <>
              {brandText.appName} needs microphone and Speech Recognition access
              for on-device transcription.
            </>
          }
        >
          <SettingsGroup>
            {/* The section's one action is a row of its own, so no control
                floats beside the heading. */}
            <SettingsRow
              label="Permissions"
              description="Shows the macOS prompts for access not requested yet."
              control={
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={(): void => void handleRequestAccess()}
                  disabled={requestingAccess}
                  data-testid="dictation-request-access"
                >
                  {requestingAccess ? 'Requesting…' : 'Request access'}
                </Button>
              }
            />
            <MicrophoneRow state={mic} onOpenSettings={handleOpenMicSettings} />
            <SpeechRecognitionRow
              state={speech}
              onOpenSettings={handleOpenSpeechSettings}
            />
          </SettingsGroup>
        </SettingsSection>
      ) : (
        <SettingsSection title="Microphone">
          <SettingsGroup>
            <SettingsRow
              label="If dictation can't hear you"
              description="Dictation uses your default input device. Check that a microphone is connected and chosen as the input in your system's sound settings, and that no other app is using it."
            />
          </SettingsGroup>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}

function SupportStatus({ state }: { state: SupportState }): JSX.Element {
  if (state.status === 'checking') {
    return <span>Checking compatibility…</span>;
  }
  const { supported, reason } = state.response;
  if (supported) {
    return (
      <span className="font-medium fg-success">
        Available{reason ? `. ${reason}` : ''}
      </span>
    );
  }
  return <StatusLabel>Not available{reason ? `. ${reason}` : ''}</StatusLabel>;
}

function OpenSystemSettingsButton({
  pane,
  onClick,
}: {
  /** The privacy pane the button opens, for its accessible name. */
  pane: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <Button
      size="compact"
      variant="secondary"
      onClick={onClick}
      aria-label={`Open System Settings for ${pane}`}
    >
      Open System Settings
    </Button>
  );
}

interface MicrophoneRowProps {
  state: MicState;
  onOpenSettings: () => void;
}

function MicrophoneRow({
  state,
  onOpenSettings,
}: MicrophoneRowProps): JSX.Element {
  return (
    <SettingsRow
      label="Microphone"
      description={<MicrophoneStatusText state={state} />}
      control={
        <OpenSystemSettingsButton pane="Microphone" onClick={onOpenSettings} />
      }
    />
  );
}

function MicrophoneStatusText({ state }: { state: MicState }): JSX.Element {
  if (state.status === 'checking') {
    return <span data-testid="dictation-mic-status-text">Checking…</span>;
  }
  switch (state.access) {
    case 'granted':
      return (
        <span
          data-testid="dictation-mic-status-text"
          className="font-medium fg-success"
        >
          Granted
        </span>
      );
    case 'denied':
      return (
        <StatusLabel data-testid="dictation-mic-status-text">
          Denied. Open System Settings to allow it.
        </StatusLabel>
      );
    case 'not-determined':
      return (
        <span data-testid="dictation-mic-status-text">
          Not requested yet. The first dictation attempt will ask.
        </span>
      );
    case 'restricted':
      return (
        <StatusLabel data-testid="dictation-mic-status-text">
          Restricted by system policy.
        </StatusLabel>
      );
    case 'unavailable':
      return (
        <span data-testid="dictation-mic-status-text">
          Status unavailable on this platform.
        </span>
      );
    case 'unknown':
      return (
        <span data-testid="dictation-mic-status-text">Status unknown.</span>
      );
  }
}

interface SpeechRecognitionRowProps {
  state: SpeechState;
  onOpenSettings: () => void;
}

function SpeechRecognitionRow({
  state,
  onOpenSettings,
}: SpeechRecognitionRowProps): JSX.Element {
  return (
    <SettingsRow
      label="Speech Recognition"
      description={<SpeechRecognitionStatusText state={state} />}
      control={
        <OpenSystemSettingsButton
          pane="Speech Recognition"
          onClick={onOpenSettings}
        />
      }
    />
  );
}

function SpeechRecognitionStatusText({
  state,
}: {
  state: SpeechState;
}): JSX.Element {
  if (state.status === 'checking') {
    return <span data-testid="dictation-speech-status-text">Checking…</span>;
  }
  if (state.status === 'idle') {
    return (
      <span data-testid="dictation-speech-status-text">
        Not checked yet. Request access to let macOS ask.
      </span>
    );
  }
  switch (state.access) {
    case 'authorized':
      return (
        <span
          data-testid="dictation-speech-status-text"
          className="font-medium fg-success"
        >
          Granted
        </span>
      );
    case 'denied':
      return (
        <StatusLabel data-testid="dictation-speech-status-text">
          Denied. Open System Settings to allow it.
        </StatusLabel>
      );
    case 'not-determined':
      return (
        <span data-testid="dictation-speech-status-text">
          Not requested yet. Request access to let macOS ask.
        </span>
      );
    case 'restricted':
      return (
        <StatusLabel data-testid="dictation-speech-status-text">
          Restricted by system policy.
        </StatusLabel>
      );
    case 'unavailable':
      return (
        <span data-testid="dictation-speech-status-text">
          Status unavailable on this platform.
        </span>
      );
    case 'unknown':
      return (
        <span data-testid="dictation-speech-status-text">Status unknown.</span>
      );
  }
}
