import { usesNativeWindowFrame } from '@canopy/desktop-shared/platform-capabilities';

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

/**
 * Whether the main shell draws the window's title-bar drag strip (the top
 * 40px, `app-main-titlebar-drag-region` in App.tsx) on this platform.
 */
export function shellDrawsTitlebarDragRegion(
  platform: NodeJS.Platform,
): boolean {
  return platform === 'darwin';
}

/**
 * Whether a page without a top bar of its own (Home, a worktree page with
 * nothing selected) draws its own drag strip at its top edge: only with a
 * custom window frame and no shell strip.
 *
 * The inset layout starts those pages 46px down, so a page strip lands inside
 * the page, over the top notification corner. App-region hit testing ignores
 * z-order, so it would take clicks from banners and toasts drawn on top
 * (CAN-5711). Where the shell strip exists, the page strip only adds that
 * overlap, so it is left out.
 */
export function needsPageTitlebarDragRegion(
  platform: NodeJS.Platform,
): boolean {
  return (
    !usesNativeWindowFrame(platform) && !shellDrawsTitlebarDragRegion(platform)
  );
}
