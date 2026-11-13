/**
 * This computer's platform. In a window that shows another computer,
 * `window.platform` is that computer's (for its paths), while the window
 * itself, its native chrome and local features such as dictation belong to
 * this one, so they read this instead.
 */
export function localPlatform(): NodeJS.Platform {
  if (typeof window === 'undefined') return 'linux';
  return window.localPlatform ?? window.platform ?? 'linux';
}
