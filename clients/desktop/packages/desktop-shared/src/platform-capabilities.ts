/**
 * Pure platform-capability helpers shared across the renderer and the main
 * process.
 *
 * Each helper takes a `NodeJS.Platform` so it can be invoked from either side
 * of the IPC boundary without branching on `process.platform`. Renderer
 * callers obtain the platform value from `window.platform`, which the preload
 * bridge exposes; main-process callers use `hostPlatformOperatingSystem()`.
 *
 * This module MUST stay browser-safe: it cannot import Node-only modules or
 * reference `process`, `__dirname`, `require`, or `node:*` modules.
 */

/**
 * Voice dictation runs on macOS (the system's speech recognizer) and Linux
 * (the bundled helper with a downloaded speech model). The voice IPC
 * handlers stay registered on every platform so the renderer can call them
 * safely, but they short-circuit to unsupported responses elsewhere.
 */
export const UNSUPPORTED_VOICE_DICTATION_MESSAGE =
  'Voice dictation is available on macOS and Linux.';

export const UNSUPPORTED_VOICE_DICTATION_RESPONSE = {
  supported: false,
  reason: UNSUPPORTED_VOICE_DICTATION_MESSAGE,
} as const;

export function isVoiceDictationPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux';
}

/**
 * Whether dictation needs the operating system's microphone and Speech
 * Recognition permissions (macOS TCC). Linux has no such prompt: Chromium
 * grants audio-only capture, and getUserMedia reports a missing or busy
 * device.
 */
export function isVoiceSystemAccessPlatform(
  platform: NodeJS.Platform,
): boolean {
  return platform === 'darwin';
}

/**
 * The desktop app manages a Canopy CLI PATH entry on macOS (via a symlink in
 * `/usr/local/bin`) and on Windows (via a managed directory inserted into
 * `HKCU\Environment\Path`). Linux manages a per-user launcher under
 * `XDG_BIN_HOME` or `~/.local/bin`, without editing PATH or shell files.
 */
export function isCliPathManagementPlatform(
  platform: NodeJS.Platform,
): boolean {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
}

/**
 * Single shared source of truth for whether Ollama is supported on the current
 * platform/build. Main, preload, and renderer all import this helper so all
 * three agree, instead of each reading the raw compile-time
 * `__CANOPY_OLLAMA_ENABLED__` global.
 *
 * The build gate in `electron.vite.config.ts` checks the running app's platform
 * (process.platform in main/preload, window.platform in the renderer), allowing
 * macOS, Windows and Linux independently of the build host. An explicit
 * `CANOPY_OLLAMA_ENABLED=false` build override disables it on every platform.
 * The `typeof` guard keeps the helper safe in contexts where the define was not
 * injected (e.g. unit tests that never set the global), defaulting to enabled.
 */
export function isOllamaSupportedOnPlatform(): boolean {
  if (
    typeof __CANOPY_OLLAMA_ENABLED__ === 'boolean' &&
    !__CANOPY_OLLAMA_ENABLED__
  ) {
    return false;
  }
  // Outside the Electron build (including Jest), preserve the enabled default.
  return (
    typeof __CANOPY_OLLAMA_PLATFORM__ === 'undefined' ||
    __CANOPY_OLLAMA_PLATFORM__ === 'darwin' ||
    __CANOPY_OLLAMA_PLATFORM__ === 'win32' ||
    __CANOPY_OLLAMA_PLATFORM__ === 'linux'
  );
}

/**
 * Electron sleep inhibition, shared by the main service and its renderer indicator.
 * Linux uses the same prevent-app-suspension blocker as macOS and Windows.
 */
export function isWakeLockSupportedPlatform(
  platform: NodeJS.Platform,
): boolean {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
}

/** Linux window managers provide the title bar and native window controls. */
export function usesNativeWindowFrame(platform: NodeJS.Platform): boolean {
  return platform === 'linux';
}
