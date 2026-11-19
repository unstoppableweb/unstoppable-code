import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { Buffer } from 'node:buffer';
import { type WebContents, systemPreferences } from 'electron';
import {
  UNSUPPORTED_VOICE_DICTATION_MESSAGE,
  UNSUPPORTED_VOICE_DICTATION_RESPONSE,
  isVoiceDictationPlatform,
  isVoiceSystemAccessPlatform,
} from '@canopy/desktop-shared/platform-capabilities';
import {
  IPC_CHANNELS,
  type VoiceCancelRequest,
  type VoiceEventPayload,
  type VoiceIsSupportedResponse,
  type VoiceMicrophoneAccess,
  type VoiceOpenSettingsRequest,
  type VoicePushAudioRequest,
  type VoiceSystemAccessResponse,
  type VoiceStartRequest,
  type VoiceStartResponse,
  type VoiceStopRequest,
} from '@canopy/desktop-shared/types';
import { sendToWebContents } from '../lib/web-contents-send';
import { registerIpcHandler } from '../ipc/register';
import { openExternalGuarded } from '../lib/open-external';
import { getVoiceService } from './service';

/**
 * Single source of truth for the unsupported-voice user-facing message. The
 * renderer relies on this exact string to display the disabled-state copy on
 * hosts without dictation (Windows); do not localize or paraphrase it without
 * also updating the renderer.
 */
const UNSUPPORTED_VOICE_MESSAGE = UNSUPPORTED_VOICE_DICTATION_MESSAGE;
const UNSUPPORTED_VOICE_RESPONSE: VoiceIsSupportedResponse =
  UNSUPPORTED_VOICE_DICTATION_RESPONSE;
const UNAVAILABLE_SYSTEM_ACCESS: VoiceSystemAccessResponse = {
  microphone: 'unavailable',
  speechRecognition: 'unavailable',
};

/**
 * Linux has no operating-system microphone permission: the app's permission
 * handler grants audio-only capture, and getUserMedia reports a missing or
 * busy device, which the renderer maps to its own errors.
 */
const LINUX_SYSTEM_ACCESS: VoiceSystemAccessResponse = {
  microphone: 'granted',
  speechRecognition: 'authorized',
};

function getMicrophoneAccess(): VoiceMicrophoneAccess {
  if (!isVoiceSystemAccessPlatform(hostPlatformOperatingSystem())) {
    return LINUX_SYSTEM_ACCESS.microphone;
  }
  try {
    return systemPreferences.getMediaAccessStatus('microphone');
  } catch {
    return 'unavailable';
  }
}

async function requestMicrophoneAccess(): Promise<VoiceMicrophoneAccess> {
  const current = getMicrophoneAccess();
  if (current !== 'not-determined') {
    return current;
  }
  try {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (granted) {
      return 'granted';
    }
    return getMicrophoneAccess();
  } catch {
    return 'unavailable';
  }
}

/**
 * Deterministic microphone-permission outcomes for UI automation. macOS TCC
 * cannot be driven from a test, so the E2E build substitutes a fixed answer
 * for the real privacy query. Only active in E2E builds.
 */
type E2eVoiceAccessFlow = 'grant-after-request' | 'deny-microphone';
type E2eVoiceCapability = E2eVoiceAccessFlow | 'unsupported';

const E2E_UNSUPPORTED_VOICE_RESPONSE: VoiceIsSupportedResponse = {
  supported: false,
  reason: 'Voice dictation is unavailable in this test scenario.',
};

function e2eVoiceAccessFlow(): E2eVoiceCapability | null {
  if (!__CANOPY_E2E__) {
    return null;
  }
  const value = process.env.CANOPY_E2E_VOICE_ACCESS_FLOW;
  if (
    value === 'grant-after-request' ||
    value === 'deny-microphone' ||
    value === 'unsupported'
  ) {
    return value;
  }
  return null;
}

/**
 * Whether an E2E access-flow substitution may answer a privacy query. Both
 * flows stay platform-gated so a host without voice dictation cannot report
 * "unsupported" and a concrete access status at the same time.
 */
function e2eAccessFlowApplies(
  flow: E2eVoiceAccessFlow,
  voiceSupportedPlatform: boolean,
): boolean {
  return voiceSupportedPlatform && e2eVoiceAccessFlow() === flow;
}

async function waitForE2eVoiceAccessDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

export function registerVoiceHandlers(): void {
  const service = getVoiceService();
  const voiceSupportedPlatform = isVoiceDictationPlatform(
    hostPlatformOperatingSystem(),
  );
  let e2eMicrophoneRequested = false;

  // A take belongs to the page that started it. If that page reloads,
  // navigates or goes away mid-take, nothing is left to stop it, and the
  // still-running helper would refuse every later start ("Voice session
  // already active") until the app restarts. So each take ends with its page.
  // Its events go only to that page, which may be App Advisor's own window
  // rather than the main window, so dictated text never reaches another one.
  const takeOwners = new Map<
    string,
    { readonly owner: WebContents; readonly release: () => void }
  >();
  const releaseTakeOwner = (sessionId: string): void => {
    takeOwners.get(sessionId)?.release();
  };
  const endTakeWithPage = (owner: WebContents, sessionId: string): void => {
    const end = (): void => {
      release();
      service.cancel(sessionId);
    };
    const onNavigation = (details: {
      readonly isMainFrame: boolean;
      readonly isSameDocument: boolean;
    }): void => {
      if (details.isMainFrame && !details.isSameDocument) end();
    };
    const release = (): void => {
      owner.off('did-start-navigation', onNavigation);
      owner.off('render-process-gone', end);
      owner.off('destroyed', end);
      takeOwners.delete(sessionId);
    };
    owner.on('did-start-navigation', onNavigation);
    owner.once('render-process-gone', end);
    owner.once('destroyed', end);
    takeOwners.set(sessionId, { owner, release });
  };

  service.onEvent((event: VoiceEventPayload) => {
    const owner = takeOwners.get(event.sessionId)?.owner;
    if (event.type === 'stopped' || event.type === 'error') {
      releaseTakeOwner(event.sessionId);
    }
    if (owner && !owner.isDestroyed() && !owner.isCrashed()) {
      sendToWebContents(owner, IPC_CHANNELS.voiceEvent, event);
    }
  });

  registerIpcHandler<[], VoiceIsSupportedResponse>(
    IPC_CHANNELS.voiceIsSupported,
    () => {
      const e2eFlow = e2eVoiceAccessFlow();
      if (e2eFlow === 'unsupported') {
        return E2E_UNSUPPORTED_VOICE_RESPONSE;
      }
      if (e2eFlow) {
        // Still platform-gated: an E2E run on a host without voice dictation
        // must not render a mic button whose start() throws.
        return voiceSupportedPlatform
          ? { supported: true }
          : UNSUPPORTED_VOICE_RESPONSE;
      }
      if (!voiceSupportedPlatform) {
        return UNSUPPORTED_VOICE_RESPONSE;
      }
      return service.isSupported();
    },
  );

  registerIpcHandler<[], VoiceIsSupportedResponse>(
    IPC_CHANNELS.voiceResetSupport,
    () => {
      const e2eFlow = e2eVoiceAccessFlow();
      if (e2eFlow === 'unsupported') {
        e2eMicrophoneRequested = false;
        return E2E_UNSUPPORTED_VOICE_RESPONSE;
      }
      if (e2eFlow) {
        e2eMicrophoneRequested = false;
        return voiceSupportedPlatform
          ? { supported: true }
          : UNSUPPORTED_VOICE_RESPONSE;
      }
      if (!voiceSupportedPlatform) {
        return UNSUPPORTED_VOICE_RESPONSE;
      }
      service.resetSupportCache();
      return service.isSupported();
    },
  );

  registerIpcHandler<[], VoiceMicrophoneAccess>(
    IPC_CHANNELS.voiceGetMicrophoneAccess,
    () => {
      if (e2eVoiceAccessFlow() === 'unsupported') {
        return 'unavailable';
      }
      if (e2eAccessFlowApplies('deny-microphone', voiceSupportedPlatform)) {
        return 'denied';
      }
      if (e2eAccessFlowApplies('grant-after-request', voiceSupportedPlatform)) {
        return e2eMicrophoneRequested ? 'granted' : 'not-determined';
      }
      if (!voiceSupportedPlatform) {
        return 'unavailable';
      }
      return getMicrophoneAccess();
    },
  );

  registerIpcHandler<[], VoiceSystemAccessResponse>(
    IPC_CHANNELS.voiceRequestSystemAccess,
    async () => {
      if (e2eVoiceAccessFlow() === 'unsupported') {
        return UNAVAILABLE_SYSTEM_ACCESS;
      }
      if (e2eAccessFlowApplies('deny-microphone', voiceSupportedPlatform)) {
        return { microphone: 'denied', speechRecognition: 'denied' };
      }
      if (e2eAccessFlowApplies('grant-after-request', voiceSupportedPlatform)) {
        await waitForE2eVoiceAccessDelay();
        e2eMicrophoneRequested = true;
        return {
          microphone: 'granted',
          speechRecognition: 'authorized',
        };
      }
      if (!voiceSupportedPlatform) {
        return UNAVAILABLE_SYSTEM_ACCESS;
      }
      if (!isVoiceSystemAccessPlatform(hostPlatformOperatingSystem())) {
        return LINUX_SYSTEM_ACCESS;
      }

      const microphone = await requestMicrophoneAccess();
      const speechRecognition = await service.requestSpeechRecognitionAccess();
      return { microphone, speechRecognition };
    },
  );

  registerIpcHandler<[VoiceStartRequest], VoiceStartResponse>(
    IPC_CHANNELS.voiceStart,
    async (event, request) => {
      if (!voiceSupportedPlatform) {
        throw new Error(UNSUPPORTED_VOICE_MESSAGE);
      }
      endTakeWithPage(event.sender, request.sessionId);
      try {
        await service.start(request.sessionId);
      } catch (error) {
        releaseTakeOwner(request.sessionId);
        throw error;
      }
      return { sessionId: request.sessionId };
    },
  );

  registerIpcHandler<[VoicePushAudioRequest], void>(
    IPC_CHANNELS.voicePushAudio,
    (_event, request) => {
      if (!voiceSupportedPlatform) {
        return;
      }
      const view = new Uint8Array(request.pcm);
      service.pushAudio(request.sessionId, Buffer.from(view));
    },
  );

  registerIpcHandler<[VoiceStopRequest], void>(
    IPC_CHANNELS.voiceStop,
    (_event, request) => {
      if (!voiceSupportedPlatform) {
        return;
      }
      service.stop(request.sessionId);
    },
  );

  registerIpcHandler<[VoiceCancelRequest], void>(
    IPC_CHANNELS.voiceCancel,
    (_event, request) => {
      if (!voiceSupportedPlatform) {
        return;
      }
      releaseTakeOwner(request.sessionId);
      service.cancel(request.sessionId);
    },
  );

  registerIpcHandler<[VoiceOpenSettingsRequest], void>(
    IPC_CHANNELS.voiceOpenSettings,
    async (_event, request) => {
      if (!voiceSupportedPlatform) {
        return;
      }
      // Only allow the macOS System Settings deep-link scheme. Any other
      // scheme is rejected to keep this a narrow privilege surface even if
      // the renderer is compromised.
      if (!request.url.startsWith('x-apple.systempreferences:')) {
        return;
      }
      await openExternalGuarded(request.url);
    },
  );
}
