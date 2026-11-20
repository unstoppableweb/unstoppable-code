import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import type { ChatMessageSendSurface } from '../chatMessageSendTelemetry';
import {
  VoiceMicrophoneError,
  VoicePermissionError,
  VoiceSpeechPermissionError,
  VoiceUnsupportedError,
} from './voice-types';

/**
 * `dictation:session_end` (CAN-6070): one event per recording session, when it
 * ends. A session is one take of the voice hook, from the mic button press to
 * its single terminal event.
 *
 * Context is bounded: how the session ended, why it failed, and the composer
 * surface. The duration is the operation's own start-to-finish time. Transcript
 * text, audio details, error messages, and chat or project ids are never
 * recorded; a failure reason comes from the error's type, never its message.
 */

const OPERATION_NAME = 'canopy.dictation_session';

/**
 * Same vocabulary as `chat:message_send.chat_surface`, minus `home`: the Home
 * composer does not report dictation sessions (CAN-6070 scopes workspace chat,
 * standalone chat and App Advisor).
 */
export type DictationSurface = Exclude<ChatMessageSendSurface, 'home'>;

/**
 * - `sent`: the user chose Send on the recording row and the words landed.
 * - `inserted`: the user stopped and the words landed in the draft.
 * - `discarded`: cancelled, the composer or chat changed, or nothing was heard.
 * - `failed`: the session ended with an error.
 */
export type DictationOutcome = 'sent' | 'inserted' | 'discarded' | 'failed';

/** Closed set; `unknown` is only for a failure the hook cannot classify. */
export type DictationFailureReason =
  | 'permission_denied'
  | 'microphone_unavailable'
  | 'unsupported'
  | 'start_failed'
  | 'helper_error'
  | 'stop_failed'
  | 'insert_failed'
  | 'unknown';

export type DictationSessionEnd =
  | { outcome: Exclude<DictationOutcome, 'failed'> }
  | { outcome: 'failed'; failureReason: DictationFailureReason };

export interface DictationSessionTelemetry {
  /** Reports the session once; later calls do nothing. */
  end: (result: DictationSessionEnd) => void;
}

/** Why `provider.start()` rejected, from the error's type only. */
export function dictationFailureReasonForStartError(
  error: unknown,
): DictationFailureReason {
  if (error instanceof VoiceMicrophoneError) {
    switch (error.reason) {
      case 'denied':
      case 'restricted':
      case 'not-determined':
        return 'permission_denied';
      case 'no-input-device':
      case 'device-unavailable':
        return 'microphone_unavailable';
      case 'unavailable':
        // The OS reported no microphone status, so the cause is unknown.
        return 'unknown';
    }
  }
  if (error instanceof VoiceSpeechPermissionError) return 'permission_denied';
  // A bare permission error does not say what went wrong.
  if (error instanceof VoicePermissionError) return 'unknown';
  if (error instanceof VoiceUnsupportedError) return 'unsupported';
  return 'start_failed';
}

let nextSessionKey = 0;

export function beginDictationSession(
  surface: DictationSurface,
): DictationSessionTelemetry {
  const operationKey = `dictation-session-${(nextSessionKey += 1)}`;
  let ended = false;
  // The client operation calls never throw, so dictation cannot be affected.
  startClientOperation(OPERATION_NAME, { operationKey });
  return {
    end: (result): void => {
      if (ended) return;
      ended = true;
      const context = {
        outcome: result.outcome,
        ...(result.outcome === 'failed'
          ? { failure_reason: result.failureReason }
          : {}),
        chat_surface: surface,
      };
      succeedClientOperation(OPERATION_NAME, { operationKey, context });
    },
  };
}
