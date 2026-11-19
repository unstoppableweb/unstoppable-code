import type {
  ColorMode,
  PreferencesData,
  ScrollbarBehavior,
  ThemeName,
} from '@canopy/desktop-shared/types';
import { buildBrandDefaultThemeCss } from '@canopy/protocol/brand';
import { resolveTokenHex } from '@canopy/ui-shared/lib/token-color';
import { brand } from '@/lib/brand';
import { readUiZoomFactor } from '@/lib/ui-zoom-factor';

const BRAND_DEFAULT_THEME_STYLE_ID = 'brand-default-theme';
const SYSTEM_DARK_MODE_QUERY = '(prefers-color-scheme: dark)';

let activeSystemColorScheme:
  | {
      mediaQuery: MediaQueryList;
      listener: (event: MediaQueryListEvent) => void;
    }
  | undefined;

/**
 * Publish the window surface color as the page's theme color. The main process
 * follows it (`did-change-theme-color`) to paint each app window's native
 * background, so a live resize grows into the same color this renderer paints,
 * whatever theme and mode this window shows, a paired computer's included.
 */
function publishWindowSurfaceColor(): void {
  const color = resolveTokenHex(document.documentElement, '--bg-sidebar');
  if (color === null) return;
  const existing = document.querySelector('meta[name="theme-color"]');
  const meta =
    existing instanceof HTMLMetaElement
      ? existing
      : document.head.appendChild(document.createElement('meta'));
  meta.name = 'theme-color';
  if (meta.content !== color) meta.content = color;
}

function applyResolvedColorMode(isDark: boolean): void {
  document.documentElement.classList.toggle('dark', isDark);
  publishWindowSurfaceColor();
}

function stopFollowingSystemColorScheme(): void {
  if (!activeSystemColorScheme) return;
  activeSystemColorScheme.mediaQuery.removeEventListener(
    'change',
    activeSystemColorScheme.listener,
  );
  activeSystemColorScheme = undefined;
}

function applyColorMode(colorMode: ColorMode): void {
  stopFollowingSystemColorScheme();

  if (
    colorMode !== 'system' ||
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    applyResolvedColorMode(colorMode === 'dark');
    return;
  }

  const mediaQuery = window.matchMedia(SYSTEM_DARK_MODE_QUERY);
  const listener = (event: MediaQueryListEvent): void => {
    // Defensively ignore a change event that was already queued when an
    // explicit preference replaced System. Only the currently registered
    // System listener may update the resolved mode.
    if (activeSystemColorScheme?.listener !== listener) return;
    applyResolvedColorMode(event.matches);
  };
  applyResolvedColorMode(mediaQuery.matches);
  mediaQuery.addEventListener('change', listener);
  activeSystemColorScheme = { mediaQuery, listener };
}

export function installBrandDefaultTheme(): void {
  if (typeof document === 'undefined') return;

  const css = buildBrandDefaultThemeCss(brand.theme.default);
  const existing = document.getElementById(BRAND_DEFAULT_THEME_STYLE_ID);
  if (existing instanceof HTMLStyleElement) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }

  const style = document.createElement('style');
  style.id = BRAND_DEFAULT_THEME_STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

export function applyTheme(theme: ThemeName, colorMode: ColorMode): void {
  installBrandDefaultTheme();
  const html = document.documentElement;
  if (theme === 'default') {
    html.removeAttribute('data-theme');
  } else {
    html.setAttribute('data-theme', theme);
  }
  applyColorMode(colorMode);
}

/**
 * Interface scale is a uniform Electron zoom owned by the main process
 * (`main/lib/ui-zoom.ts`): saving `uiScale` zooms every app window by
 * `uiScale / 100`, so text, controls, radii, icons and insets grow together.
 * The renderer never sets the zoom; it publishes what it observes:
 *
 * - `data-ui-scale="<N>"` on `<html>` — the selected percentage, written
 *   optimistically by {@link applyUiScale} and kept truthful from the
 *   effective zoom whenever `devicePixelRatio` changes;
 * - `--ui-zoom` — the effective zoom factor, for CSS that must stay in
 *   physical units (the macOS traffic-light reservation, which the corner
 *   divides by this value because the lights never move);
 * - `--border-hairline` — one device pixel: `devicePixelRatio` already
 *   includes the page zoom, so `1 / devicePixelRatio` CSS px is exactly one
 *   physical pixel at every zoom on every display, unlike the static
 *   resolution media query in `canopy-tokens.css` that the web app keeps.
 *
 * Panel pull-out windows mirror `<html>`'s attributes and inline style from
 * the opener (`panels/child-window-styles.ts`), so they inherit all three.
 */
const UI_SCALE_ATTRIBUTE = 'data-ui-scale';
const UI_ZOOM_PROPERTY = '--ui-zoom';
const BORDER_HAIRLINE_PROPERTY = '--border-hairline';

let devicePixelRatioWatch:
  | { mediaQuery: MediaQueryList; listener: () => void }
  | undefined;

function publishUiZoomMetrics(options: { syncScaleAttribute: boolean }): void {
  const html = document.documentElement;
  const zoom = readUiZoomFactor();
  html.style.setProperty(UI_ZOOM_PROPERTY, String(zoom));
  const devicePixelRatio = window.devicePixelRatio;
  if (Number.isFinite(devicePixelRatio) && devicePixelRatio > 0) {
    html.style.setProperty(
      BORDER_HAIRLINE_PROPERTY,
      `${1 / devicePixelRatio}px`,
    );
  }
  if (options.syncScaleAttribute) {
    html.setAttribute(UI_SCALE_ATTRIBUTE, String(Math.round(zoom * 100)));
  }
}

/**
 * Re-publishes the metrics every time `devicePixelRatio` changes — a zoom
 * change or a move to a display with another native scale. A resolution
 * media query for the current ratio stops matching on the first change, so
 * the listener fires once and re-arms for the new ratio.
 */
function watchDevicePixelRatio(): void {
  if (typeof window.matchMedia !== 'function') return;
  if (devicePixelRatioWatch) {
    devicePixelRatioWatch.mediaQuery.removeEventListener(
      'change',
      devicePixelRatioWatch.listener,
    );
    devicePixelRatioWatch = undefined;
  }
  const mediaQuery = window.matchMedia(
    `(resolution: ${window.devicePixelRatio}dppx)`,
  );
  const listener = (): void => {
    if (devicePixelRatioWatch?.listener !== listener) return;
    publishUiZoomMetrics({ syncScaleAttribute: true });
    watchDevicePixelRatio();
  };
  mediaQuery.addEventListener('change', listener);
  devicePixelRatioWatch = { mediaQuery, listener };
}

/**
 * Publishes the effective zoom metrics from the current renderer state and
 * starts following `devicePixelRatio`. Called before React mounts so the
 * hairline and `--ui-zoom` are right for the very first paint (the main
 * process has already zoomed the window by then), and by every
 * {@link applyUiScale}.
 */
export function installUiZoomMetrics(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  publishUiZoomMetrics({ syncScaleAttribute: true });
  if (!devicePixelRatioWatch) watchDevicePixelRatio();
}

/**
 * Records the selected interface scale on `<html>` and refreshes the zoom
 * metrics. The zoom itself follows from persisting the preference: the main
 * process applies `uiScale / 100` to every window on save, after which the
 * `devicePixelRatio` watcher republishes `--ui-zoom` and the hairline.
 */
export function applyUiScale(scale: number): void {
  document.documentElement.setAttribute(UI_SCALE_ATTRIBUTE, String(scale));
  publishUiZoomMetrics({ syncScaleAttribute: false });
  if (!devicePixelRatioWatch) watchDevicePixelRatio();
}

export function applyScrollbarBehavior(
  behavior: ScrollbarBehavior | undefined,
): void {
  document.documentElement.setAttribute(
    'data-scrollbar-behavior',
    behavior ?? 'system',
  );
}

export function applyChatWidth(width: PreferencesData['chatWidth']): void {
  for (const name of ['--chat-reading-width', '--chat-composer-shell-width']) {
    if (width === 'full')
      document.documentElement.style.setProperty(name, '100%');
    else document.documentElement.style.removeProperty(name);
  }
}

/**
 * Apply every display preference (named theme, color mode,
 * scrollbar behavior, UI scale, chat width) to the current renderer's `<html>` in one
 * call. Shared by startup hydration and the cross-window preference-sync
 * broadcast so secondary renderers (e.g. the App Advisor window) update in
 * immediate lockstep with the main window instead of waiting for the next
 * show/reload.
 */
export function applyDisplayPreferences(
  preferences: Pick<
    PreferencesData,
    | 'theme'
    | 'colorMode'
    | 'sidebarAppearance'
    | 'scrollbarBehavior'
    | 'uiScale'
    | 'chatWidth'
  >,
): void {
  applyTheme(preferences.theme, preferences.colorMode);
  applyScrollbarBehavior(preferences.scrollbarBehavior);
  applyUiScale(preferences.uiScale);
  applyChatWidth(preferences.chatWidth);
}
