import { useCallback, useRef } from 'react';
import type { UseVoiceTranscriptionResult } from './useVoiceTranscription';

/** A press shorter than this is a tap: the take keeps running hands-free. */
const DICTATION_TAP_MS = 300;

/**
 * Hold ⌃M to dictate: the press starts a take and the release ends it,
 * keeping its words. A quick tap leaves the take running hands-free; the
 * next press ends it. Feed the handlers to `useComposerShortcutRequests`.
 * While `blocked` (the speech model is downloading for this composer), both
 * handlers do nothing. `interceptStart` can take a press that would start a
 * take; it returns true when it did.
 */
export function useHoldToDictate(
  voice: UseVoiceTranscriptionResult,
  options: {
    readonly blocked?: boolean;
    readonly interceptStart?: () => boolean;
  } = {},
): {
  onDictationPress: () => void;
  onDictationRelease: (heldMs: number) => void;
} {
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const blockedRef = useRef(options.blocked === true);
  blockedRef.current = options.blocked === true;
  const interceptRef = useRef(options.interceptStart);
  interceptRef.current = options.interceptStart;
  const pressRef = useRef<'started' | 'stopped' | null>(null);
  const onDictationPress = useCallback((): void => {
    if (blockedRef.current) return;
    const current = voiceRef.current;
    if (current.state === 'listening' || current.state === 'connecting') {
      pressRef.current = 'stopped';
      void current.stop();
    } else if (interceptRef.current?.() === true) {
      pressRef.current = null;
    } else {
      pressRef.current = 'started';
      void current.start();
    }
  }, []);
  const onDictationRelease = useCallback((heldMs: number): void => {
    if (blockedRef.current) return;
    const press = pressRef.current;
    pressRef.current = null;
    if (press !== 'started' || heldMs < DICTATION_TAP_MS) return;
    void voiceRef.current.stop();
  }, []);
  return { onDictationPress, onDictationRelease };
}
