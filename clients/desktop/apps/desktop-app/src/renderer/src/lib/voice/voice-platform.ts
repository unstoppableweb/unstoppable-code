import { isVoiceDictationPlatform } from '@canopy/desktop-shared/platform-capabilities';
import type { VoiceIsSupportedResponse } from '@canopy/desktop-shared/types';

/**
 * Whether the current renderer host should attempt to probe voice support.
 *
 * Voice dictation runs on macOS and Linux; on Windows the preload bridge
 * returns unsupported responses, but we skip the IPC call entirely so the
 * renderer never displays a microphone affordance.
 *
 * Callers pass `localPlatform()`: dictation runs on this computer, also in a
 * window that shows another one.
 */
export function shouldProbeVoiceSupport(
  platform: NodeJS.Platform | undefined,
): boolean {
  if (platform === undefined) {
    return false;
  }
  return isVoiceDictationPlatform(platform);
}

/**
 * Whether the composer shows its microphone for this support answer. On
 * Linux a missing speech model still shows it, and a click explains how to
 * download the model, which can arrive while the composer stays mounted.
 */
export function showsVoiceAffordance(
  support: VoiceIsSupportedResponse,
): boolean {
  return support.supported || support.code === 'model-missing';
}
