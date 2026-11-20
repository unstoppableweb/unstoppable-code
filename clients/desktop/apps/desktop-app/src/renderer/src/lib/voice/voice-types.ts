import type { VoiceIsSupportedResponse } from '@canopy/desktop-shared/types';

export type VoiceSessionState = 'idle' | 'connecting' | 'listening' | 'error';

export interface VoiceTranscript {
  text: string;
  isFinal: boolean;
}

export interface VoiceProviderHandlers {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onStopped: () => void;
  onError: (message: string) => void;
  /**
   * How loud the microphone is right now, 0 (silence) to 1, for a live
   * waveform. Called for every captured audio chunk; optional because not
   * every provider can measure it.
   */
  onLevel?: (level: number) => void;
  /**
   * The host has no speech model to recognize with (Linux only: the probe's
   * `model-missing` code). Called at most once per `start()`, even when that
   * start was stopped or cancelled while it waited, because the answer
   * describes the host rather than the take.
   */
  onSpeechModelMissing?: () => void;
}

export interface VoiceTranscriptionProvider {
  readonly name: string;
  /** Probe whether the provider is usable at runtime. */
  isSupported(): Promise<boolean>;
  /** Begin capturing audio and streaming transcripts to the handlers. */
  start(handlers: VoiceProviderHandlers): Promise<void>;
  /** Signal end-of-speech; provider should flush a final transcript. */
  stop(): Promise<void>;
  /** Abort without producing a final transcript. */
  cancel(): Promise<void>;
}

export class VoiceUnsupportedError extends Error {
  /** The probe's code, when it says why (Linux only). */
  readonly code?: VoiceIsSupportedResponse['code'];

  constructor(
    message = 'Voice input is not supported',
    code?: VoiceIsSupportedResponse['code'],
  ) {
    super(message);
    this.name = 'VoiceUnsupportedError';
    if (code !== undefined) this.code = code;
  }
}

export class VoicePermissionError extends Error {
  constructor(message = 'Microphone permission denied') {
    super(message);
    this.name = 'VoicePermissionError';
  }
}

/**
 * Why the microphone could not be opened. These map 1:1 onto distinct user
 * guidance — a denied permission, a policy restriction, an un-asked prompt,
 * and a missing input device all need different instructions, and collapsing
 * them into one "access denied" message sends users to a System Settings
 * toggle that will not help them.
 */
export type VoiceMicrophoneFailureReason =
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'no-input-device'
  | 'device-unavailable'
  | 'unavailable';

/**
 * A microphone failure that carries its cause. Extends VoicePermissionError so
 * existing `instanceof` checks in the provider and hook layers keep working.
 */
export class VoiceMicrophoneError extends VoicePermissionError {
  readonly reason: VoiceMicrophoneFailureReason;

  constructor(reason: VoiceMicrophoneFailureReason, message?: string) {
    super(message ?? `Microphone unavailable (${reason})`);
    this.name = 'VoiceMicrophoneError';
    this.reason = reason;
  }
}

export class VoiceSpeechPermissionError extends Error {
  constructor(message = 'Speech Recognition permission denied') {
    super(message);
    this.name = 'VoiceSpeechPermissionError';
  }
}
