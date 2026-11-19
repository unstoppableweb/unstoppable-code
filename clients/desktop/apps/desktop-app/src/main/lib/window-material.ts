import { nativeTheme, type BrowserWindow } from 'electron';
import type { ColorMode, ThemeName } from '@canopy/desktop-shared/types';
import themeRecipes from '@canopy/ui-shared/styles/theme-recipes.json';

export type NativeThemeSource = 'light' | 'dark' | 'system';

/** Electron/native macOS appearance matching the app's persisted color mode. */
export function getNativeThemeSource(colorMode: ColorMode): NativeThemeSource {
  return colorMode;
}

/**
 * The selected theme's base color, which the native window paints wherever
 * the renderer has not drawn yet: before first paint and, during a live
 * resize, in the strip the window grows into before the next frame lands.
 * App windows are opaque with no native material, so this color is the only
 * thing that strip can show.
 */
export function getMainWindowStartupBackgroundColor(
  theme: ThemeName,
  shouldUseDarkColors: boolean,
): string {
  return (themeRecipes[theme] ?? themeRecipes.default).base[
    shouldUseDarkColors ? 'dark' : 'light'
  ];
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
let primaryWindowBackground: string | null = null;

/**
 * The native background a new secondary window starts with: the color the
 * main window's renderer last published, until the new window publishes its
 * own.
 */
export function getAppWindowBackgroundColor(): string {
  return (
    primaryWindowBackground ??
    getMainWindowStartupBackgroundColor(
      'default',
      nativeTheme.shouldUseDarkColors,
    )
  );
}

/**
 * Keep an app window's native background on the color its own renderer paints.
 * The renderer publishes its window surface as the page's theme color whenever
 * its theme or light/dark mode resolves, so the native strip a live resize
 * exposes always matches the page, including a paired computer's window that
 * shows that computer's theme. Each window follows only its own renderer, so
 * an older preference save can never repaint it with a stale color.
 */
export function trackAppWindowBackground(
  window: BrowserWindow,
  options: { readonly primary?: boolean } = {},
): void {
  window.webContents.on(
    'did-change-theme-color',
    (_event, color: string | null): void => {
      if (color === null || !HEX_COLOR.test(color) || window.isDestroyed()) {
        return;
      }
      window.setBackgroundColor(color);
      if (options.primary === true) primaryWindowBackground = color;
    },
  );
}
