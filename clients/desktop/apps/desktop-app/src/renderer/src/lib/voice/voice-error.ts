import { brandText } from '@/lib/brand';
import { localPlatform } from '@/lib/local-platform';
import type { VoiceMicrophoneFailureReason } from './voice-types';

export type VoiceErrorKind =
  | 'dictation-disabled'
  | 'speech-permission-denied'
  | 'microphone-permission-denied'
  | 'microphone-permission-not-determined'
  | 'microphone-restricted'
  | 'no-input-device'
  | 'device-unavailable'
  | 'language-unavailable'
  | 'unsupported'
  | 'generic';

export interface VoiceErrorGuidance {
  kind: VoiceErrorKind;
  title: string;
  steps: string[];
  /**
   * macOS `x-apple.systempreferences:` URL that deep-links the user to the
   * relevant pane in System Settings. Opened via `window.api.openExternal`.
   * Linux guidance never sets one: there is no such pane to open.
   */
  settingsUrl?: string;
  settingsLabel?: string;
}

const DICTATION_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Dictation';
export const SPEECH_PRIVACY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition';
export const MICROPHONE_PRIVACY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

/**
 * Built per call rather than hoisted to a module constant: `brandText` exposes
 * lazy getters so brand-swapping test setups see new values, and a module-level
 * object would capture the app name at import time.
 */
function microphoneDeniedGuidance(): VoiceErrorGuidance {
  return {
    kind: 'microphone-permission-denied',
    title: `Allow microphone access for ${brandText.appName}`,
    steps: [
      // Leading with "won't ask again" matters: without it the user keeps
      // clicking the microphone waiting for a prompt macOS will never show.
      'macOS blocked microphone access and will not ask again.',
      'Open System Settings → Privacy & Security → Microphone.',
      `Turn ${brandText.appName} on, then click the microphone again.`,
    ],
    settingsUrl: MICROPHONE_PRIVACY_SETTINGS_URL,
    settingsLabel: 'Open Microphone Privacy',
  };
}

/**
 * Guidance for a microphone failure whose cause is already known, so the UI
 * never has to infer it from an error message. macOS will not re-prompt once
 * access is denied, which is why the denied copy leads with System Settings
 * rather than telling the user to try again.
 */
export function guidanceForMicrophoneFailure(
  reason: VoiceMicrophoneFailureReason,
  platform: NodeJS.Platform = localPlatform(),
): VoiceErrorGuidance {
  if (platform === 'linux') {
    return linuxMicrophoneFailureGuidance(reason);
  }
  switch (reason) {
    case 'denied':
      return microphoneDeniedGuidance();
    case 'restricted':
      return {
        kind: 'microphone-restricted',
        title: 'Microphone blocked by a device policy',
        steps: [
          `A device policy is blocking microphone access for ${brandText.appName}, so this can't be changed here.`,
          'Ask whoever manages this Mac to allow microphone access.',
        ],
      };
    case 'not-determined':
      return {
        kind: 'microphone-permission-not-determined',
        title: 'Allow microphone access when macOS asks',
        steps: [
          `macOS hasn't decided on microphone access for ${brandText.appName} yet — the prompt was closed without an answer.`,
          'Click the microphone again and choose Allow.',
        ],
      };
    case 'no-input-device':
      return {
        kind: 'no-input-device',
        title: 'Connect a microphone',
        steps: [
          `macOS didn't offer ${brandText.appName} an audio input device to record from.`,
          'Connect a microphone, or choose one under System Settings → Sound → Input, then click the microphone again.',
        ],
      };
    case 'device-unavailable':
      return {
        kind: 'device-unavailable',
        title: 'Free up the microphone',
        steps: [
          `Microphone access is allowed, but macOS couldn't start recording — another app may be using it.`,
          'Quit any app that might be using the microphone, then click the microphone again.',
        ],
      };
    case 'unavailable':
      return {
        kind: 'generic',
        title: "Couldn't check microphone access",
        steps: [
          `macOS didn't report a microphone status for ${brandText.appName}.`,
          `Restart ${brandText.appName}, or check System Settings → Privacy & Security → Microphone.`,
        ],
        settingsUrl: MICROPHONE_PRIVACY_SETTINGS_URL,
        settingsLabel: 'Open Microphone Privacy',
      };
  }
}

/**
 * Guidance for a microphone failure whose cause could not be identified.
 *
 * Deliberately does not route through {@link classifyVoiceError}: that matcher
 * treats any message merely containing "microphone" as a denial, and the
 * denial copy asserts macOS "will not ask again" and links a Settings toggle.
 * The provider throws a typed `VoiceMicrophoneError` for every status it can
 * name, so an unnamed failure reaching here is more likely a capture problem
 * than a permission one — claiming otherwise sends the user to a switch that
 * is already on.
 */
export function unknownMicrophoneFailureGuidance(
  message: string | null,
  platform: NodeJS.Platform = localPlatform(),
): VoiceErrorGuidance {
  if (platform === 'linux') {
    return {
      kind: 'generic',
      title: "Couldn't start the microphone",
      steps: [
        `${brandText.appName} couldn't start the microphone. The reported cause was:`,
        message?.trim() || 'Unknown error.',
        "Try again. If it keeps failing, check the input device in your system's sound settings.",
      ],
    };
  }
  return {
    kind: 'generic',
    title: "Couldn't start the microphone",
    steps: [
      // Not attributed to macOS: the likeliest message here is Canopy's own,
      // thrown when the renderer has no getUserMedia at all.
      `${brandText.appName} couldn't start the microphone. The reported cause was:`,
      message?.trim() || 'Unknown error.',
      'Try again. If it keeps failing, check System Settings → Privacy & Security → Microphone.',
    ],
    // Deliberately no Settings deep link, matching `device-unavailable`. The
    // modal renders it as the autofocused primary button and dismisses on
    // click, so offering it here would let Enter open a pane that probably
    // cannot help *and* discard the raw cause above — the only diagnostic the
    // user has for a failure we could not name.
  };
}

/**
 * Map a raw error message (from the Swift helper, the macOS permission
 * handler, or a thrown VoicePermissionError) into a structured guidance
 * payload the UI can render.
 */
export function classifyVoiceError(
  message: string | null,
  platform: NodeJS.Platform = localPlatform(),
): VoiceErrorGuidance {
  if (platform === 'linux') {
    return classifyLinuxVoiceError(message);
  }
  const raw = (message ?? '').toLowerCase();

  if (
    raw.includes('siri and dictation') ||
    raw.includes('dictation are not available') ||
    raw.includes('dictation is disabled') ||
    raw.includes('dictation are disabled')
  ) {
    return {
      kind: 'dictation-disabled',
      title: 'Enable dictation in macOS',
      steps: [
        'Open System Settings → Keyboard → Dictation.',
        'Turn Dictation on. macOS may take a moment to download the language model.',
        `Return to ${brandText.appName} and click the microphone again.`,
      ],
      settingsUrl: DICTATION_SETTINGS_URL,
      settingsLabel: 'Open Keyboard Settings',
    };
  }

  if (
    raw.includes('on-device speech recognition unavailable') ||
    raw.includes('locale') ||
    raw.includes('language')
  ) {
    return {
      kind: 'language-unavailable',
      title: 'Install a speech recognition language',
      steps: [
        'Open System Settings → Keyboard → Dictation.',
        `Add English under Languages — macOS will download the on-device model ${brandText.appName} currently uses.`,
        `Return to ${brandText.appName} once the download finishes.`,
      ],
      settingsUrl: DICTATION_SETTINGS_URL,
      settingsLabel: 'Open Keyboard Settings',
    };
  }

  if (
    raw.includes('speech authorization denied') ||
    raw.includes('speechrecognizer') ||
    (raw.includes('speech recognition') && raw.includes('denied'))
  ) {
    return {
      kind: 'speech-permission-denied',
      title: `Allow speech recognition for ${brandText.appName}`,
      steps: [
        'Open System Settings → Privacy & Security → Speech Recognition.',
        `Toggle ${brandText.appName} on (you may need to unlock settings first).`,
        `Return to ${brandText.appName} and click the microphone again.`,
      ],
      settingsUrl: SPEECH_PRIVACY_SETTINGS_URL,
      settingsLabel: 'Open Speech Recognition Privacy',
    };
  }

  // Naming the microphone is not by itself evidence of a denial — messages
  // like "microphone unavailable" are capture failures — and the denial copy
  // asserts macOS will not ask again, so over-matching here sends users to a
  // Settings toggle that is already on. Require a denial signal alongside it,
  // mirroring the two-token shape used for speech recognition above.
  const namesMicrophone = raw.includes('microphone');
  const signalsDenial =
    raw.includes('denied') ||
    raw.includes('refused') ||
    raw.includes('not allowed') ||
    raw.includes('blocked');
  if (
    (namesMicrophone && signalsDenial) ||
    raw.includes('permission denied') ||
    raw.includes('not allowed')
  ) {
    return microphoneDeniedGuidance();
  }

  if (
    raw.includes('unsupported') ||
    raw.includes('not supported') ||
    raw.includes('speechanalyzer requires macos 26 or later') ||
    raw.includes('macos 26 or later')
  ) {
    return {
      kind: 'unsupported',
      title: 'Voice input is unavailable on this device',
      steps: [
        `macOS 26 or later is required for voice dictation in ${brandText.appName}.`,
        `If you are already on macOS 26+, try restarting ${brandText.appName}. If the problem persists, disable voice input.`,
      ],
    };
  }

  return {
    kind: 'generic',
    title: "Couldn't start voice dictation",
    steps: [
      'macOS reported the following error while starting voice input:',
      message?.trim() || 'Unknown error.',
      'Check System Settings → Keyboard → Dictation and Privacy & Security → Speech Recognition.',
    ],
    settingsUrl: DICTATION_SETTINGS_URL,
    settingsLabel: 'Open Keyboard Settings',
  };
}

/*
 * Linux: dictation runs in the bundled helper with a downloaded speech model,
 * and there is no system permission or Settings pane to send anyone to. The
 * failures are a missing model, a processor without AVX, a missing or busy
 * microphone, or the helper itself.
 */

function linuxMicrophoneFailureGuidance(
  reason: VoiceMicrophoneFailureReason,
): VoiceErrorGuidance {
  switch (reason) {
    case 'no-input-device':
      return {
        kind: 'no-input-device',
        title: 'Connect a microphone',
        steps: [
          `Your system didn't offer ${brandText.appName} an audio input device to record from.`,
          "Connect a microphone, or choose one as the input in your system's sound settings, then click the microphone again.",
        ],
      };
    case 'device-unavailable':
      return {
        kind: 'device-unavailable',
        title: 'Free up the microphone',
        steps: [
          `${brandText.appName} couldn't start recording. Another app may be using the microphone.`,
          'Quit any app that might be using the microphone, then click the microphone again.',
        ],
      };
    case 'denied':
    case 'restricted':
    case 'not-determined':
    case 'unavailable':
      return {
        kind: 'microphone-permission-denied',
        title: `${brandText.appName} couldn't use the microphone`,
        steps: [
          'Something on this computer blocked microphone access, such as a privacy switch or a sandbox.',
          'Allow microphone access for the app, then click the microphone again.',
        ],
      };
  }
}

function classifyLinuxVoiceError(message: string | null): VoiceErrorGuidance {
  const raw = (message ?? '').toLowerCase();
  // Match the exact reasons VoiceService sends for the Linux probe codes, so
  // a helper error that merely mentions a missing file isn't mistaken for
  // one. A missing speech model arrives typed (`speechModelMissingGuidance`).
  if (raw.includes('it needs avx')) {
    return {
      kind: 'unsupported',
      title: 'Dictation is unavailable on this computer',
      steps: [
        "This computer's processor doesn't support the instructions (AVX) dictation needs.",
      ],
    };
  }
  if (raw.includes("isn't included in this build")) {
    return {
      kind: 'unsupported',
      title: 'Dictation is unavailable in this build',
      steps: [`This build of ${brandText.appName} doesn't include dictation.`],
    };
  }
  return {
    kind: 'generic',
    title: "Couldn't start voice dictation",
    steps: [
      'Dictation reported the following error while starting:',
      message?.trim() || 'Unknown error.',
      `Try again. If it keeps failing, restart ${brandText.appName}.`,
    ],
  };
}

/**
 * No speech model is downloaded (the probe's `model-missing` code). Composers
 * that offer the download show their notice instead; this is for those that
 * don't, such as the automation and hook editors.
 */
export function speechModelMissingGuidance(): VoiceErrorGuidance {
  return {
    kind: 'unsupported',
    title: 'Download the speech model',
    steps: [
      'Dictation recognizes speech on this computer with a speech model you download once.',
      'Open Settings → Dictation and choose Download, then click the microphone again.',
    ],
  };
}

/**
 * The download a composer started failed (CAN-7341). Fixed text only: the
 * store's failure message can name paths on this computer, and this modal is
 * recorded by session replay. Settings → Dictation shows the message.
 */
export function speechModelDownloadFailedGuidance(): VoiceErrorGuidance {
  return {
    kind: 'generic',
    title: "Couldn't download the speech model",
    steps: [
      'Settings → Dictation shows what went wrong.',
      'Choose the microphone to try again. The download picks up where it stopped.',
    ],
  };
}

/** A composer waiting on the download lost track of it (CAN-7341). */
export function speechModelCheckFailedGuidance(): VoiceErrorGuidance {
  return {
    kind: 'generic',
    title: "Couldn't check the speech model download",
    steps: [
      "Settings → Dictation shows the download's progress.",
      'Choose the microphone to try again.',
    ],
  };
}

/** The model verified, but the automatic start still found none (CAN-7341). */
export function speechModelLoadFailedGuidance(): VoiceErrorGuidance {
  return {
    kind: 'generic',
    title: "Couldn't load the speech model",
    steps: [
      "The speech model is downloaded, but dictation couldn't load it.",
      'Remove it in Settings → Dictation, then choose the microphone to download it again.',
    ],
  };
}
