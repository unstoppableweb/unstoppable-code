import { useEffect, useState } from 'react';
import { DEFAULT_VOICE_DICTATION_ENABLED } from '@canopy/desktop-shared/constants/preferences';
import { localPlatform } from '@/lib/local-platform';
import {
  shouldProbeVoiceSupport,
  showsVoiceAffordance,
} from '@/lib/voice/voice-platform';
import { onVoiceDictationEnabledChanged } from '@/lib/voice/voice-dictation-pref';

/**
 * Feature-detects on-device voice dictation support and reads the user's
 * dictation preference, mirroring `ChatInput`'s gating so the mic button is
 * omitted entirely (rather than shown-and-disabled) wherever it can't work.
 */
export function useVoiceDictationGate(): {
  voiceSupported: boolean;
  voiceEnabledPref: boolean;
} {
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceEnabledPref, setVoiceEnabledPref] = useState(
    DEFAULT_VOICE_DICTATION_ENABLED,
  );

  useEffect(() => {
    if (!shouldProbeVoiceSupport(localPlatform())) {
      setVoiceSupported(false);
      return;
    }
    let cancelled = false;
    const voiceApi = window.api.voice;
    if (!voiceApi) return;
    void voiceApi
      .isSupported()
      .then((result) => {
        if (!cancelled) setVoiceSupported(showsVoiceAffordance(result));
      })
      .catch(() => {
        if (!cancelled) setVoiceSupported(false);
      });
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (!cancelled) setVoiceEnabledPref(prefs.voiceDictationEnabled);
      })
      .catch(() => {
        // Leave the default in place so the mic stays visible if the
        // preference file is unreadable.
      });
    const unsubscribe = onVoiceDictationEnabledChanged((enabled) => {
      if (!cancelled) setVoiceEnabledPref(enabled);
    });
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { voiceSupported, voiceEnabledPref };
}
