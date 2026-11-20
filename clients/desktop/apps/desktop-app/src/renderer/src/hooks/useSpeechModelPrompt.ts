import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  clearSpeechModelAutostart,
  getSpeechModelAutostartOwner,
  hasOtherSpeechModelAutostartOwner,
  isSpeechModelAutostartOwner,
  subscribeSpeechModelAutostart,
  tryClaimSpeechModelAutostart,
} from '../lib/voice/speech-model-autostart';
import {
  speechModelCheckFailedGuidance,
  speechModelDownloadFailedGuidance,
  speechModelLoadFailedGuidance,
} from '../lib/voice/voice-error';
import {
  formatModelSize,
  useSpeechModelStatus,
  type SpeechModelResult,
} from './useSpeechModelStatus';
import type { UseVoiceTranscriptionResult } from './useVoiceTranscription';

/**
 * `offering`: the notice shows. `pending`: this composer chose Download and
 * owns the automatic start. `starting`: the model verified and the automatic
 * start runs. `waiting`: another composer owns the download; this one only
 * shows its mic as preparing.
 */
type Phase = 'idle' | 'offering' | 'pending' | 'starting' | 'waiting';

/** Failed status reads in a row, while pending, before giving up. */
const MAX_READ_FAILURES = 3;

/**
 * `notInstalled` answers in a row, while pending, before treating the
 * download as cancelled or removed in Settings. A read taken while the
 * install finishes can briefly answer `notInstalled`.
 */
const MAX_NOT_INSTALLED_READS = 3;
/** How long to wait before reading again after a `notInstalled` answer. */
const NOT_INSTALLED_RECHECK_MS = 500;

export interface UseSpeechModelPromptInput {
  readonly voice: UseVoiceTranscriptionResult;
  /** The host's full mic-available condition. */
  readonly enabled: boolean;
  /** The destination; `null` means there is none, and nothing is offered. */
  readonly resetKey: string | null;
}

export interface UseSpeechModelPromptResult {
  /** Render the download notice. */
  readonly offering: boolean;
  /** The download's size, such as "269 MB"; null when it couldn't be read. */
  readonly size: string | null;
  /** The mic shows "Downloading the speech model…" and takes no starts. */
  readonly preparing: boolean;
  readonly download: () => void;
  readonly notNow: () => void;
  /**
   * Call before a mic or shortcut start. True when another composer owns the
   * download: this one shows the preparing mic instead, and must not start.
   */
  readonly interceptStart: () => boolean;
}

/**
 * The composer's offer of the Linux speech model download (CAN-7341). A mic
 * click with no model shows a notice; Download starts the existing download,
 * and the first composer to choose it starts dictation once the model
 * verifies. Every asynchronous result is applied only in the phase it was
 * started in.
 */
export function useSpeechModelPrompt({
  voice,
  enabled,
  resetKey,
}: UseSpeechModelPromptInput): UseSpeechModelPromptResult {
  const ownerId = useId();
  const [phase, setPhaseState] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const phaseEpochRef = useRef(0);
  const [offerRead, setOfferRead] = useState<{
    readonly settled: boolean;
    readonly size: string | null;
  }>({ settled: false, size: null });
  const readFailuresRef = useRef(0);
  const notInstalledReadsRef = useRef(0);
  const recheckTimerRef = useRef<number | null>(null);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const onResultRef = useRef<(result: SpeechModelResult) => void>(() => {});

  const { refresh, act, reset } = useSpeechModelStatus({
    fetchOnMount: false,
    poll: phase === 'pending',
    onResult: (result) => onResultRef.current(result),
  });

  const setPhase = useCallback(
    (next: Phase): void => {
      phaseEpochRef.current += 1;
      if (recheckTimerRef.current !== null) {
        window.clearTimeout(recheckTimerRef.current);
        recheckTimerRef.current = null;
      }
      phaseRef.current = next;
      // Every phase starts with a fresh status: nothing read for an earlier
      // phase can drive this one.
      reset();
      setPhaseState(next);
    },
    [reset],
  );

  /** Back to idle; the owner gives up its claim on the automatic start. */
  const leave = useCallback((): void => {
    clearSpeechModelAutostart(ownerId);
    setPhase('idle');
  }, [ownerId, setPhase]);

  const startAutomatically = useCallback((): void => {
    setPhase('starting');
    const epoch = phaseEpochRef.current;
    void voiceRef.current.start({ origin: 'auto' }).then((outcome) => {
      if (epoch !== phaseEpochRef.current) return;
      if (outcome === 'speech-model-missing') {
        voiceRef.current.reportError(speechModelLoadFailedGuidance());
      }
      leave();
    });
  }, [leave, setPhase]);

  onResultRef.current = (result: SpeechModelResult): void => {
    const current = phaseRef.current;
    if (current === 'offering') {
      if (result.kind !== 'read') return;
      const size =
        'status' in result && result.status.model
          ? formatModelSize(result.status.model.sizeBytes)
          : null;
      setOfferRead({ settled: true, size });
      return;
    }
    if (current !== 'pending') return;
    if ('error' in result) {
      if (result.kind === 'action') {
        voiceRef.current.reportError(speechModelDownloadFailedGuidance());
        leave();
        return;
      }
      readFailuresRef.current += 1;
      if (readFailuresRef.current >= MAX_READ_FAILURES) {
        voiceRef.current.reportError(speechModelCheckFailedGuidance());
        leave();
      }
      return;
    }
    readFailuresRef.current = 0;
    const { status } = result;
    const afterNotInstalled = notInstalledReadsRef.current > 0;
    if (status.state !== 'notInstalled') notInstalledReadsRef.current = 0;
    if (!status.sourceConfigured) {
      voiceRef.current.reportError(speechModelDownloadFailedGuidance());
      leave();
      return;
    }
    switch (status.state) {
      case 'downloading':
        // Downloading again after `notInstalled` is a new attempt: the one
        // this composer chose was cancelled in Settings and someone started
        // another. That one doesn't start dictation here.
        if (afterNotInstalled) leave();
        return;
      case 'verifying':
        // Straight to verifying (or installed) after `notInstalled` is the
        // same install finishing; keep the claim.
        return;
      case 'installed':
        if (isSpeechModelAutostartOwner(ownerId)) startAutomatically();
        else leave();
        return;
      case 'failed':
        voiceRef.current.reportError(speechModelDownloadFailedGuidance());
        leave();
        return;
      case 'notInstalled': {
        // Cancelled or removed in Settings, unless the install is finishing:
        // read again a few times before going back to idle, with no error.
        notInstalledReadsRef.current += 1;
        if (notInstalledReadsRef.current >= MAX_NOT_INSTALLED_READS) {
          leave();
          return;
        }
        const epoch = phaseEpochRef.current;
        recheckTimerRef.current = window.setTimeout(() => {
          recheckTimerRef.current = null;
          if (epoch === phaseEpochRef.current) void refresh();
        }, NOT_INSTALLED_RECHECK_MS);
        return;
      }
      case 'unsupported':
        leave();
        return;
    }
  };

  // A request from this destination opens the notice, or waits behind the
  // composer that owns the download.
  const request = voice.speechModelRequest;
  const handledSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (request === null || handledSeqRef.current === request.seq) return;
    handledSeqRef.current = request.seq;
    if (!enabled || resetKey === null || request.destinationKey !== resetKey)
      return;
    const current = phaseRef.current;
    if (current !== 'idle' && current !== 'offering') return;
    if (hasOtherSpeechModelAutostartOwner(ownerId)) {
      setPhase('waiting');
      return;
    }
    setOfferRead({ settled: false, size: null });
    setPhase('offering');
    void refresh();
  }, [request, enabled, resetKey, ownerId, refresh, setPhase]);

  // A destination change, or a mic that becomes unavailable, ends everything
  // this composer started; a start in flight is cancelled first.
  const previousKeyRef = useRef(resetKey);
  useEffect(() => {
    const keyChanged = previousKeyRef.current !== resetKey;
    previousKeyRef.current = resetKey;
    if (!keyChanged && enabled && resetKey !== null) return;
    const current = phaseRef.current;
    if (current === 'starting') void voiceRef.current.cancel();
    if (current === 'idle') {
      phaseEpochRef.current += 1;
      return;
    }
    leave();
  }, [resetKey, enabled, leave]);

  // On unmount, give up the claim; the voice hook cancels its own take.
  useEffect(
    () => (): void => {
      phaseEpochRef.current += 1;
      if (recheckTimerRef.current !== null) {
        window.clearTimeout(recheckTimerRef.current);
      }
      clearSpeechModelAutostart(ownerId);
    },
    [ownerId],
  );

  // Once another composer owns the download, an open offer here becomes the
  // preparing mic, so its Download can never claim a later start (AC 8). A
  // composer waiting behind another returns to idle once nobody owns it.
  const owner = useSyncExternalStore(
    subscribeSpeechModelAutostart,
    getSpeechModelAutostartOwner,
  );
  useEffect(() => {
    const current = phaseRef.current;
    if (current === 'waiting' && owner === null) setPhase('idle');
    else if (current === 'offering' && owner !== null && owner !== ownerId)
      setPhase('waiting');
  }, [owner, ownerId, phase, setPhase]);

  const download = useCallback((): void => {
    if (phaseRef.current !== 'offering') return;
    if (!tryClaimSpeechModelAutostart(ownerId)) {
      setPhase('waiting');
      return;
    }
    readFailuresRef.current = 0;
    notInstalledReadsRef.current = 0;
    setPhase('pending');
    void act(() => window.api.voice.speechModel.install());
  }, [ownerId, act, setPhase]);

  const notNow = useCallback((): void => {
    if (phaseRef.current === 'offering') setPhase('idle');
  }, [setPhase]);

  // The first composer to choose Download starts dictation; until it has, a
  // mic or shortcut start anywhere else only shows the download (AC 8).
  const interceptStart = useCallback((): boolean => {
    if (!hasOtherSpeechModelAutostartOwner(ownerId)) return false;
    const current = phaseRef.current;
    if (current === 'idle' || current === 'offering') setPhase('waiting');
    return true;
  }, [ownerId, setPhase]);

  return {
    offering: phase === 'offering' && offerRead.settled,
    size: offerRead.size,
    preparing:
      phase === 'pending' || phase === 'starting' || phase === 'waiting',
    download,
    notNow,
    interceptStart,
  };
}
