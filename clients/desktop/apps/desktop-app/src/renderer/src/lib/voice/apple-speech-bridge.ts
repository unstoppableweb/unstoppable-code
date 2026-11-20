import type {
  VoiceIsSupportedResponse,
  VoiceSystemAccessResponse,
} from '@canopy/desktop-shared/types';
import { pcm16Level } from './audio-level';
import { getPcmWorkletModuleUrl } from './pcm-worklet';
import { openRendererMicrophoneStream } from './renderer-microphone-access';
import {
  VoiceMicrophoneError,
  VoiceSpeechPermissionError,
  VoiceUnsupportedError,
  type VoiceMicrophoneFailureReason,
  type VoiceProviderHandlers,
  type VoiceTranscriptionProvider,
} from './voice-types';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

let idCounter = 0;
function nextSessionId(): string {
  idCounter += 1;
  return `voice-${Date.now()}-${idCounter}`;
}

function isSpeechRecognitionDenied(access: VoiceSystemAccessResponse): boolean {
  return (
    access.speechRecognition === 'denied' ||
    access.speechRecognition === 'restricted'
  );
}

/**
 * The reason a microphone status blocks capture, or `null` when it does not.
 * Every non-granted status still blocks — but each carries its own cause so
 * the UI can explain the right fix instead of always saying "access denied".
 */
function microphoneFailureReason(
  access: VoiceSystemAccessResponse,
): VoiceMicrophoneFailureReason | null {
  switch (access.microphone) {
    case 'granted':
      return null;
    case 'denied':
      return 'denied';
    case 'restricted':
      return 'restricted';
    case 'not-determined':
      return 'not-determined';
    case 'unavailable':
    case 'unknown':
      return 'unavailable';
  }
}

export class AppleSpeechBridgeProvider implements VoiceTranscriptionProvider {
  readonly name = 'apple-speech-bridge';

  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private unsubscribe: (() => void) | null = null;
  private sessionId: string | null = null;
  private active = false;
  // Bumped by stop()/cancel() and at the top of start() so an in-flight start
  // can detect that the caller aborted during permission/support/worklet setup
  // (i.e. before sessionId is assigned and stop()/cancel() can reach it).
  private startGeneration = 0;
  private readonly stoppedStreams = new WeakSet<MediaStream>();
  private readonly closedAudioContexts = new WeakSet<AudioContext>();

  async isSupported(): Promise<boolean> {
    const voiceApi = window.api.voice;
    if (!voiceApi) return false;
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      return false;
    }
    if (typeof AudioWorkletNode === 'undefined') {
      return false;
    }
    const result = await voiceApi.isSupported();
    return result.supported;
  }

  async start(handlers: VoiceProviderHandlers): Promise<void> {
    if (this.active) {
      throw new Error('Voice session already active');
    }
    const generation = ++this.startGeneration;
    const voiceApi = window.api.voice;
    if (!voiceApi) {
      throw new VoiceUnsupportedError();
    }

    const support = await voiceApi.isSupported();
    if (support.code === 'model-missing') {
      // Reported even for a start that a ⌃M release stopped while it waited:
      // the answer describes the host, not this take.
      handlers.onSpeechModelMissing?.();
    }
    if (generation !== this.startGeneration) {
      return;
    }
    if (!support.supported) {
      throw new VoiceUnsupportedError(support.reason, support.code);
    }

    let access: VoiceSystemAccessResponse;
    try {
      access = await voiceApi.requestSystemAccess();
    } catch (error) {
      if (generation !== this.startGeneration) {
        return;
      }
      await this.disposeResources();
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (generation !== this.startGeneration) {
      return;
    }
    const microphoneFailure = microphoneFailureReason(access);
    if (microphoneFailure) {
      await this.disposeResources();
      throw new VoiceMicrophoneError(microphoneFailure);
    }
    if (isSpeechRecognitionDenied(access)) {
      await this.disposeResources();
      throw new VoiceSpeechPermissionError();
    }

    const stream = await openRendererMicrophoneStream();
    if (generation !== this.startGeneration) {
      this.stopStream(stream);
      return;
    }
    this.stream = stream;

    const AudioContextCtor: typeof AudioContext =
      window.AudioContext ?? window.webkitAudioContext ?? AudioContext;
    const audioContext = new AudioContextCtor({ sampleRate: 48000 });
    this.audioContext = audioContext;

    try {
      await audioContext.audioWorklet.addModule(getPcmWorkletModuleUrl());
    } catch (error) {
      if (generation !== this.startGeneration) {
        await this.disposeStartAttempt({ stream, audioContext });
        return;
      }
      await this.disposeResources();
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (generation !== this.startGeneration) {
      await this.disposeStartAttempt({ stream, audioContext });
      return;
    }

    const sessionId = nextSessionId();
    this.sessionId = sessionId;
    this.active = true;

    this.unsubscribe = voiceApi.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.type === 'interim') {
        handlers.onInterim(event.text);
      } else if (event.type === 'final') {
        handlers.onFinal(event.text);
      } else if (event.type === 'stopped') {
        handlers.onStopped();
        void this.disposeResources();
      } else if (event.type === 'error') {
        handlers.onError(event.message);
        void this.disposeResources();
      }
    });

    try {
      await voiceApi.start({ sessionId });
    } catch (error) {
      const original =
        error instanceof Error ? error : new Error(String(error));
      await this.disposeResources();
      if (generation !== this.startGeneration) throw original;
      // Main probes again before it spawns the helper, so a model removed
      // since the check above fails here with a plain message. Read support
      // once more to tell the caller why; a failed read changes nothing.
      let reread: VoiceIsSupportedResponse;
      try {
        reread = await voiceApi.isSupported();
      } catch {
        throw original;
      }
      if (
        generation === this.startGeneration &&
        reread.code === 'model-missing'
      ) {
        handlers.onSpeechModelMissing?.();
        throw new VoiceUnsupportedError(reread.reason, reread.code);
      }
      throw original;
    }
    if (generation !== this.startGeneration) {
      try {
        await voiceApi.cancel({ sessionId });
      } catch {
        // Best effort — main may already be tearing down.
      }
      await this.disposeStartAttempt({ stream, audioContext, sessionId });
      return;
    }

    // From this point the main-process Swift helper is alive. If the audio
    // pipeline setup below throws, we must tell main to kill it so the next
    // click of the mic does not hit `Voice session already active`.
    try {
      const source = audioContext.createMediaStreamSource(stream);
      this.sourceNode = source;
      const workletNode = new AudioWorkletNode(
        audioContext,
        'canopy-pcm-downsampler',
        {
          numberOfInputs: 1,
          numberOfOutputs: 0,
        },
      );
      this.workletNode = workletNode;
      workletNode.port.onmessage = (evt: MessageEvent<ArrayBuffer>): void => {
        if (!this.active || !this.sessionId) return;
        handlers.onLevel?.(pcm16Level(evt.data));
        // We intentionally fire-and-forget this IPC — backpressure here would
        // drop audio frames, and the Swift helper tolerates bursty writes.
        void voiceApi.pushAudio({
          sessionId: this.sessionId,
          pcm: evt.data,
        });
      };
      source.connect(workletNode);
    } catch (error) {
      const activeSessionId = this.sessionId;
      if (activeSessionId) {
        try {
          await voiceApi.cancel({ sessionId: activeSessionId });
        } catch {
          // Best effort — main may already be tearing down.
        }
      }
      await this.disposeResources();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async stop(): Promise<void> {
    // Invalidate any in-flight start() so it bails before spawning the helper.
    this.startGeneration += 1;
    if (!this.sessionId || !this.active) return;
    const voiceApi = window.api.voice;
    if (voiceApi) {
      await voiceApi.stop({ sessionId: this.sessionId });
    }
    // Keep resources alive until the helper emits `stopped` / `final` so the
    // final transcript can still flow through. The main-process voice service
    // will emit one of those events, and our handler disposes the stream.
  }

  async cancel(): Promise<void> {
    // Invalidate any in-flight start() so it bails before spawning the helper.
    this.startGeneration += 1;
    if (!this.sessionId) {
      await this.disposeResources();
      return;
    }
    const voiceApi = window.api.voice;
    if (voiceApi) {
      await voiceApi.cancel({ sessionId: this.sessionId });
    }
    await this.disposeResources();
  }

  private async disposeResources(): Promise<void> {
    this.active = false;
    this.sessionId = null;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }
    if (this.stream) {
      this.stopStream(this.stream);
      this.stream = null;
    }
    if (this.audioContext) {
      await this.closeAudioContext(this.audioContext);
      this.audioContext = null;
    }
  }

  private async disposeStartAttempt(resources: {
    stream?: MediaStream;
    audioContext?: AudioContext;
    sessionId?: string;
  }): Promise<void> {
    if (resources.stream) {
      this.stopStream(resources.stream);
      if (this.stream === resources.stream) {
        this.stream = null;
      }
    }
    if (resources.audioContext) {
      await this.closeAudioContext(resources.audioContext);
      if (this.audioContext === resources.audioContext) {
        this.audioContext = null;
      }
    }
    if (resources.sessionId && this.sessionId === resources.sessionId) {
      this.sessionId = null;
      this.active = false;
      if (this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    }
  }

  private stopStream(stream: MediaStream): void {
    if (this.stoppedStreams.has(stream)) return;
    this.stoppedStreams.add(stream);
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  private async closeAudioContext(audioContext: AudioContext): Promise<void> {
    if (this.closedAudioContexts.has(audioContext)) return;
    this.closedAudioContexts.add(audioContext);
    try {
      await audioContext.close();
    } catch {
      // ignore
    }
  }
}
