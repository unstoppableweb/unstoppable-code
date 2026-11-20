import { useCallback, useEffect, useRef, useState } from 'react';
import { AppleSpeechBridgeProvider } from '../lib/voice/apple-speech-bridge';
import {
  VoiceMicrophoneError,
  VoicePermissionError,
  VoiceSpeechPermissionError,
  VoiceUnsupportedError,
  type VoiceSessionState,
  type VoiceTranscriptionProvider,
} from '../lib/voice/voice-types';
import {
  classifyVoiceError,
  guidanceForMicrophoneFailure,
  speechModelMissingGuidance,
  unknownMicrophoneFailureGuidance,
  type VoiceErrorGuidance,
} from '../lib/voice/voice-error';
import type { VoiceTarget } from '../lib/voice/voice-target';
import {
  beginDictationSession,
  dictationFailureReasonForStartError,
  type DictationFailureReason,
  type DictationSessionTelemetry,
  type DictationSurface,
} from '../lib/voice/dictationSessionTelemetry';

export interface UseVoiceTranscriptionOptions {
  target: VoiceTarget | null;
  /** A new draft can reuse the same editor; its identity still ends the take. */
  destinationKey?: string | null;
  onFinalCommitted?: (text: string) => void;
  /** Override the provider (used by tests). */
  provider?: VoiceTranscriptionProvider;
  /**
   * The composer surface to report each session under (`dictation:session_end`).
   * Omit it, or pass `null`, for a destination that is not a user chat.
   */
  telemetrySurface?: DictationSurface | null;
  /**
   * Opts in to offering the speech model download (CAN-7341): a user start
   * that finds no model publishes `speechModelRequest` for this destination
   * instead of showing the error. Omit it where there is no destination; the
   * error then explains the download.
   */
  speechModelOffer?: { readonly destinationKey: string };
}

/** What ends a take with `stop()`. */
export interface VoiceStopOptions {
  /** The user chose Send on the recording row; reported as the take's outcome. */
  send?: boolean;
}

/** How a `start()` ended. */
export type VoiceStartOutcome =
  | 'started'
  | 'speech-model-missing'
  | 'failed'
  | 'cancelled';

/** A user start found no speech model, for the destination it began in. */
export interface SpeechModelRequest {
  /** Increases by one per published request. */
  readonly seq: number;
  readonly destinationKey: string;
}

export interface UseVoiceTranscriptionResult {
  state: VoiceSessionState;
  error: string | null;
  /**
   * Recovery guidance for the current failure, or `null` when there is none to
   * show. Ownership lives here rather than in each composer so a dismissal can
   * never outlive the failure it dismissed: every `start()` clears it, so a
   * repeat failure always re-surfaces even when its message is byte-identical
   * to the one the user just closed (which is exactly what a denied
   * microphone produces on every retry).
   */
  errorGuidance: VoiceErrorGuidance | null;
  /** Hide the guidance for the current failure only. */
  dismissError: () => void;
  /**
   * Starts a take. `origin: 'auto'` is a start the app made on its own (the
   * speech model finished downloading); it never publishes a request.
   */
  start: (options?: {
    readonly origin?: 'user' | 'auto';
  }) => Promise<VoiceStartOutcome>;
  stop: (options?: VoiceStopOptions) => Promise<void>;
  cancel: () => Promise<void>;
  /**
   * The loudest microphone level (0 to 1) since the previous read, then
   * resets; a waveform polls it at its own pace. Kept out of React state so
   * audio chunks never re-render the composer.
   */
  readLevel: () => number;
  /** When the current take started listening (epoch ms), else `null`. */
  listeningSince: number | null;
  /** The latest missing-model request, while `speechModelOffer` is set. */
  speechModelRequest: SpeechModelRequest | null;
  /**
   * Shows a failure the way a failed take does: the mic's error state and
   * the error modal. Ignored while a take is starting or listening.
   */
  reportError: (guidance: VoiceErrorGuidance) => void;
}

/** The user start whose missing-model answer may publish a request. */
interface OfferRequest {
  /** The start's request version. */
  readonly id: number;
  readonly destinationGeneration: number;
  published: boolean;
}

/**
 * Recovery guidance for a `start()` rejection. Typed microphone failures carry
 * their own cause; everything else is classified from its message.
 */
function guidanceForStartError(error: unknown): VoiceTakeFailure {
  const reason = dictationFailureReasonForStartError(error);
  if (error instanceof VoiceMicrophoneError) {
    // The title is the action to take, which is what the mic button's tooltip
    // and aria-label need; the full steps live in the modal.
    const guidance = guidanceForMicrophoneFailure(error.reason);
    return { guidance, message: guidance.title, reason };
  }
  if (error instanceof VoiceSpeechPermissionError) {
    const message =
      'Speech Recognition access denied. Enable it in System Settings → Privacy & Security → Speech Recognition.';
    return { guidance: classifyVoiceError(message), message, reason };
  }
  if (error instanceof VoicePermissionError) {
    // Bare, i.e. not a VoiceMicrophoneError — the cause is unknown, so never
    // assert a denial. The raw cause goes in the modal steps; `message` stays
    // the guidance title because it becomes the mic button's tooltip and
    // aria-label.
    const guidance = unknownMicrophoneFailureGuidance(error.message || null);
    return { guidance, message: guidance.title, reason };
  }
  if (
    error instanceof VoiceUnsupportedError &&
    error.code === 'model-missing'
  ) {
    const guidance = speechModelMissingGuidance();
    return { guidance, message: error.message || guidance.title, reason };
  }
  if (error instanceof VoiceUnsupportedError) {
    const message =
      error.message || 'Voice input is not supported on this device.';
    return { guidance: classifyVoiceError(message), message, reason };
  }
  const message =
    error instanceof Error && error.message
      ? error.message
      : 'Voice input failed to start';
  return { guidance: classifyVoiceError(message), message, reason };
}

/** Why a take ended without success, as shown to the user. */
interface VoiceTakeFailure {
  message: string;
  guidance: VoiceErrorGuidance;
  /** Reported with the session; chosen by the failing path, never from the message. */
  reason: DictationFailureReason;
}

function failureFromMessage(
  message: string,
  reason: DictationFailureReason,
): VoiceTakeFailure {
  return { message, guidance: classifyVoiceError(message), reason };
}

/**
 * One recording take. Its transcript stays here, out of the editor, until the
 * take ends; the first terminal event wins and inserts it exactly once.
 */
interface VoiceTake {
  readonly version: number;
  /** The destination captured when the take began. */
  readonly target: VoiceTarget | null;
  /** Latest nonblank interim snapshot; snapshots replace, never concatenate. */
  transcript: string;
  terminal: boolean;
  /** The user chose Send when stopping; set by `stop({ send: true })`. */
  sendRequested: boolean;
  /** Null when the composer reports no sessions. */
  readonly telemetry: DictationSessionTelemetry | null;
}

export function useVoiceTranscription(
  options: UseVoiceTranscriptionOptions,
): UseVoiceTranscriptionResult {
  const {
    target,
    destinationKey,
    onFinalCommitted,
    provider,
    telemetrySurface,
    speechModelOffer,
  } = options;
  const offerKey = speechModelOffer?.destinationKey;
  const [state, setState] = useState<VoiceSessionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<VoiceErrorGuidance | null>(null);
  const [guidanceDismissed, setGuidanceDismissed] = useState(false);
  const providerRef = useRef<VoiceTranscriptionProvider | null>(null);
  const targetRef = useRef<VoiceTarget | null>(target);
  const destinationKeyRef = useRef(destinationKey);
  const onFinalCommittedRef = useRef<typeof onFinalCommitted>(onFinalCommitted);
  const telemetrySurfaceRef = useRef(telemetrySurface);
  const requestVersionRef = useRef(0);
  const takeRef = useRef<VoiceTake | null>(null);
  const peakLevelRef = useRef(0);
  const [listeningSince, setListeningSince] = useState<number | null>(null);
  const offerKeyRef = useRef(offerKey);
  offerKeyRef.current = offerKey;
  const destinationGenerationRef = useRef(0);
  const offerRequestRef = useRef<OfferRequest | null>(null);
  const requestSeqRef = useRef(0);
  const [speechModelRequest, setSpeechModelRequest] =
    useState<SpeechModelRequest | null>(null);

  // Every destination change, A→B→A included, starts a new generation, so a
  // missing-model answer from an earlier one never publishes.
  const offerTargetRef = useRef({ target, offerKey });
  useEffect(() => {
    const previous = offerTargetRef.current;
    if (previous.target === target && previous.offerKey === offerKey) return;
    offerTargetRef.current = { target, offerKey };
    destinationGenerationRef.current += 1;
    offerRequestRef.current = null;
  }, [target, offerKey]);

  useEffect(() => {
    onFinalCommittedRef.current = onFinalCommitted;
  }, [onFinalCommitted]);

  useEffect(() => {
    telemetrySurfaceRef.current = telemetrySurface;
  }, [telemetrySurface]);

  /** Ends the current take without inserting anything. */
  const discardTake = useCallback((): void => {
    requestVersionRef.current += 1;
    const take = takeRef.current;
    if (take) {
      take.terminal = true;
      take.telemetry?.end({ outcome: 'discarded' });
    }
    takeRef.current = null;
  }, []);

  useEffect(() => {
    if (
      targetRef.current === target &&
      destinationKeyRef.current === destinationKey
    )
      return;
    targetRef.current = target;
    destinationKeyRef.current = destinationKey;
    if (!takeRef.current) return;
    // A destination change permanently discards the take, even if the user
    // later returns to the same editor. Invalidate before cancellation can
    // synchronously deliver any remaining provider events.
    discardTake();
    void providerRef.current?.cancel();
    setState('idle');
  }, [target, destinationKey, discardTake]);

  useEffect(() => {
    providerRef.current = provider ?? new AppleSpeechBridgeProvider();
    return (): void => {
      offerRequestRef.current = null;
      discardTake();
      void providerRef.current?.cancel();
      providerRef.current = null;
    };
  }, [provider, discardTake]);

  const isLive = useCallback(
    (take: VoiceTake): boolean =>
      !take.terminal && take.version === requestVersionRef.current,
    [],
  );

  /**
   * The single terminal path for final, stopped, and error events. The take is
   * marked terminal before anything else runs, so duplicate or reentrant
   * events cannot insert twice, and the transcript is in the editor before the
   * committed callback and before state leaves recording (chat and home send
   * on the transition to idle).
   */
  const finishTake = useCallback(
    (
      take: VoiceTake,
      finalText: string | null,
      failure: VoiceTakeFailure | null,
    ): void => {
      if (!isLive(take)) return;
      take.terminal = true;
      const transcript =
        finalText !== null && finalText.trim() ? finalText : take.transcript;
      take.transcript = '';
      if (takeRef.current === take) takeRef.current = null;
      let outcome = failure;
      let inserted = false;
      const destination = targetRef.current;
      // A destination that changed mid-take never receives the old take.
      if (transcript.trim() && destination && destination === take.target) {
        try {
          destination.commitFinal(transcript);
          inserted = true;
        } catch {
          // Never acknowledge a commit that did not land, so no send follows.
          outcome ??= failureFromMessage(
            "Couldn't insert the dictated text",
            'insert_failed',
          );
        }
        if (inserted) onFinalCommittedRef.current?.(transcript);
      }
      if (outcome) {
        take.telemetry?.end({
          outcome: 'failed',
          failureReason: outcome.reason,
        });
        setError(outcome.message);
        setGuidance(outcome.guidance);
        setGuidanceDismissed(false);
        setState('error');
        return;
      }
      take.telemetry?.end({
        outcome: inserted
          ? take.sendRequested
            ? 'sent'
            : 'inserted'
          : 'discarded',
      });
      setState('idle');
    },
    [isLive],
  );

  const start = useCallback(
    async (
      startOptions: { readonly origin?: 'user' | 'auto' } = {},
    ): Promise<VoiceStartOutcome> => {
      const activeProvider = providerRef.current;
      if (!activeProvider) return 'cancelled';
      if (state === 'connecting' || state === 'listening') return 'cancelled';
      // A start before the state re-renders supersedes a take still in
      // flight; that take can no longer finish, so it ends here as discarded.
      if (takeRef.current) discardTake();
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      const surface = telemetrySurfaceRef.current;
      const take: VoiceTake = {
        version: requestVersion,
        target: targetRef.current,
        transcript: '',
        terminal: false,
        sendRequested: false,
        telemetry: surface ? beginDictationSession(surface) : null,
      };
      takeRef.current = take;
      // A newer start supersedes any older pending answer; an automatic
      // start never offers the download.
      const offerRequest: OfferRequest | null =
        startOptions.origin === 'auto'
          ? null
          : {
              id: requestVersion,
              destinationGeneration: destinationGenerationRef.current,
              published: false,
            };
      offerRequestRef.current = offerRequest;
      setError(null);
      setGuidance(null);
      // A new attempt is a new failure opportunity — never let the previous
      // dismissal suppress whatever this attempt reports.
      setGuidanceDismissed(false);
      setState('connecting');
      peakLevelRef.current = 0;
      setListeningSince(Date.now());
      try {
        await activeProvider.start({
          onInterim: (text) => {
            if (!isLive(take)) return;
            // Buffer only: the editor stays the user's while they record.
            if (text.trim()) take.transcript = text;
            setState('listening');
          },
          onFinal: (text) => {
            finishTake(take, text, null);
          },
          onStopped: () => {
            // The helper ended without a final event (e.g. the user stopped
            // very quickly); keep what was heard rather than discarding it.
            finishTake(take, null, null);
          },
          onLevel: (level) => {
            if (!isLive(take)) return;
            peakLevelRef.current = Math.max(peakLevelRef.current, level);
          },
          onError: (message) => {
            // Preserve any text the user has already dictated. Only real
            // permission/configuration errors should bubble up to the UI; the
            // text they spoke is never thrown away.
            finishTake(take, null, failureFromMessage(message, 'helper_error'));
          },
          onSpeechModelMissing: () => {
            const current = offerRequestRef.current;
            const key = offerKeyRef.current;
            if (
              key === undefined ||
              current === null ||
              current !== offerRequest ||
              current.destinationGeneration !==
                destinationGenerationRef.current ||
              current.published
            ) {
              return;
            }
            current.published = true;
            requestSeqRef.current += 1;
            setSpeechModelRequest({
              seq: requestSeqRef.current,
              destinationKey: key,
            });
          },
        });
        if (!isLive(take)) return 'cancelled';
        setState('listening');
        return 'started';
      } catch (err) {
        if (
          err instanceof VoiceUnsupportedError &&
          err.code === 'model-missing'
        ) {
          if (offerKeyRef.current === undefined) {
            finishTake(take, null, guidanceForStartError(err));
          } else {
            // A composer that offers the download says so in its notice (or,
            // for its own automatic start, in its own error), never here. The
            // session still reports why it ended.
            if (isLive(take)) {
              take.telemetry?.end({
                outcome: 'failed',
                failureReason: dictationFailureReasonForStartError(err),
              });
            }
            finishTake(take, null, null);
          }
          return 'speech-model-missing';
        }
        const live = isLive(take);
        finishTake(take, null, guidanceForStartError(err));
        return live ? 'failed' : 'cancelled';
      }
    },
    [state, isLive, finishTake, discardTake],
  );

  const stop = useCallback(
    async (stopOptions?: VoiceStopOptions): Promise<void> => {
      const activeProvider = providerRef.current;
      if (!activeProvider) return;
      if (state === 'idle') return;
      const take = takeRef.current;
      if (take && stopOptions?.send) take.sendRequested = true;
      if (state === 'connecting') {
        // Stopping is never a discard: anything already heard is kept.
        if (take) finishTake(take, null, null);
        discardTake();
        await activeProvider.cancel();
        // finishTake already published the outcome. Cleanup must not overwrite
        // an insertion failure, or the state of a subsequent take.
        return;
      }
      try {
        // The take keeps its transcript until the provider's terminal event.
        await activeProvider.stop();
      } catch (err) {
        if (!take) return;
        finishTake(
          take,
          null,
          failureFromMessage(
            err instanceof Error && err.message
              ? err.message
              : 'Voice input failed to stop',
            'stop_failed',
          ),
        );
      }
    },
    [state, finishTake, discardTake],
  );

  const cancel = useCallback(async (): Promise<void> => {
    const activeProvider = providerRef.current;
    if (!activeProvider) return;
    // Invalidate first, so callbacks fired during cancellation insert nothing.
    offerRequestRef.current = null;
    discardTake();
    await activeProvider.cancel();
    setState('idle');
    setError(null);
    setGuidance(null);
  }, [discardTake]);

  const reportError = useCallback((next: VoiceErrorGuidance): void => {
    // A live take owns the state. Read the take, not the rendered state: a
    // take that just ended has queued its idle state but not rendered it.
    const take = takeRef.current;
    if (take && !take.terminal) return;
    setError(next.title);
    setGuidance(next);
    setGuidanceDismissed(false);
    setState('error');
  }, []);

  const dismissError = useCallback((): void => {
    setGuidanceDismissed(true);
  }, []);

  const readLevel = useCallback((): number => {
    const level = peakLevelRef.current;
    peakLevelRef.current = 0;
    return level;
  }, []);

  // A take's clock runs only while it is connecting or listening.
  useEffect(() => {
    if (state === 'idle' || state === 'error') setListeningSince(null);
  }, [state]);

  return {
    state,
    error,
    errorGuidance: guidanceDismissed ? null : guidance,
    dismissError,
    start,
    stop,
    cancel,
    readLevel,
    listeningSince,
    speechModelRequest: offerKey === undefined ? null : speechModelRequest,
    reportError,
  };
}
