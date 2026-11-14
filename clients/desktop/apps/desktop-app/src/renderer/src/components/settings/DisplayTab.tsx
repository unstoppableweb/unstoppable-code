import { Fragment, type JSX, useEffect, useRef, useState } from 'react';
import {
  THEME_NAMES,
  COLOR_MODES,
  WORKTREE_DIFF_STATS_STYLES,
  SCROLLBAR_BEHAVIORS,
  CHAT_ENRICHMENT_MODES,
  WORKSPACE_LAYOUT_MODES,
  type ChatEnrichmentMode,
  type PreferencesData,
  type WorktreeDiffStatsStyle,
  type ScrollbarBehavior,
  type ThemeName,
  type ColorMode,
  type WorkspaceLayoutMode,
} from '@canopy/desktop-shared/types';
import {
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
} from '@canopy/desktop-shared/lib/ui-scale';
import {
  DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
} from '@canopy/desktop-shared/constants/preferences';
import { applyScrollbarBehavior, applyTheme, applyUiScale } from '@/lib/theme';
import { brand } from '@/lib/brand';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { WORKSPACE_LAYOUT_MODE_COPY } from '@/lib/panels/layout-mode-copy';
import {
  AppearanceSelect,
  Button,
  SettingsSelect,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSegmentedControl,
} from './SettingsLayout';
import { ChatDetailSettingsRow } from './ChatDetailSettingsRow';
import { ActivityCardSettingsRow } from './ActivityCardSettingsRow';
import { SidebarStyleSettingsRow } from './SidebarStyleSettingsRow';
import { useNavigationStore } from '@/stores/navigationStore';

type ResolvedColorMode = Exclude<ColorMode, 'system'>;

function readCurrentColorMode(): ResolvedColorMode {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

const VALID_THEME_SET = new Set<string>(THEME_NAMES);

function isThemeName(value: string): value is ThemeName {
  return VALID_THEME_SET.has(value);
}

function readCurrentTheme(): ThemeName {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr && isThemeName(attr)) return attr;
  return 'default';
}

function readCurrentScale(): number {
  const attr = document.documentElement.getAttribute('data-ui-scale');
  if (attr) {
    const n = Number(attr);
    if (n >= 75 && n <= 200) return n;
  }
  return 100;
}

/**
 * Theme names in the picker. Each preview dot draws its theme's own accent
 * token: the dot carries that theme's `data-theme` scope (and the dark scope
 * in dark mode), so it reads the theme's tokens instead of a copied color.
 * The default theme has no scope of its own, so its dot takes the brand's
 * configured swatch.
 */
const THEME_LABELS: Record<ThemeName, string> = {
  default: brand.theme.default.label,
  unstoppable: 'Cobalt',
  dusk: 'Dusk',
  lime: 'Lime',
  ocean: 'Ocean',
  retro: 'Retro',
  neo: 'Neo',
  forest: 'Forest',
};

// The dropdown offers the whole supported range. Sourced from the shared
// module so the dropdown, the View-menu zoom items and `normalizePreferences`
// cannot drift apart.
const SCALE_MIN = UI_SCALE_MIN;
const SCALE_MAX = UI_SCALE_MAX;
const SCALE_STEP = UI_SCALE_STEP;

const SCROLLBAR_BEHAVIOR_META: Record<
  ScrollbarBehavior,
  { label: string; description: string }
> = {
  system: {
    label: 'System',
    description: 'Derived from your system settings.',
  },
  always: {
    label: 'Always',
    description: 'Keep scrollbars visible whenever content can scroll.',
  },
  scroll: {
    label: 'While scrolling',
    description: 'Show during wheel or trackpad scrolling, then fade away.',
  },
  hover: {
    label: 'On hover',
    description: 'Show while hovering over a scrollable area.',
  },
  never: {
    label: 'Never',
    description: 'Keep scrollbars hidden without disabling scrolling.',
  },
};

const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const WORKTREE_DIFF_STATS_STYLE_META: Record<
  WorktreeDiffStatsStyle,
  { label: string; description: string }
> = {
  short: {
    label: 'Short',
    description: 'Abbreviate large counts, such as 1,234 to 1k.',
  },
  complete: {
    label: 'Complete',
    description: 'Show every digit, such as 1,234.',
  },
};

function savePreference(patch: Partial<PreferencesData>): void {
  void window.api.savePreferences(patch).then(emitPreferencesUpdated);
}

const CHAT_ENRICHMENT_MODE_META: Record<
  ChatEnrichmentMode,
  { label: string; description: string }
> = {
  replace: {
    label: 'Replace',
    description:
      'Show links with icons, IDs and Linear titles, with previews on hover or focus.',
  },
  hover: {
    label: 'Hover',
    description:
      'Keep the original text and add links with previews on hover or focus.',
  },
  off: {
    label: 'Off',
    description: 'Keep the original text and links without enrichment.',
  },
};

type ChatEnrichmentProvider = 'linear' | 'github';
type ChatEnrichmentModes = Record<ChatEnrichmentProvider, ChatEnrichmentMode>;

const CHAT_ENRICHMENT_PROVIDERS: readonly {
  readonly provider: ChatEnrichmentProvider;
  readonly label: string;
  readonly patch: (mode: ChatEnrichmentMode) => Partial<PreferencesData>;
}[] = [
  {
    provider: 'linear',
    label: 'Linear',
    patch: (mode) => ({ linearChatEnrichmentMode: mode }),
  },
  {
    provider: 'github',
    label: 'GitHub',
    patch: (mode) => ({ githubChatEnrichmentMode: mode }),
  },
];

function readChatEnrichmentModes(
  preferences: PreferencesData,
): ChatEnrichmentModes {
  return {
    linear:
      preferences.linearChatEnrichmentMode ??
      DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
    github:
      preferences.githubChatEnrichmentMode ??
      DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  };
}

/**
 * Per-provider modes backed by the saved preferences. A choice shows at once
 * and settles on the saved value; a failed save restores the last saved mode
 * and keeps its error until the next save of that provider. While a save is
 * pending, broadcasts for that provider only update the fallback, so an echo
 * of an earlier write cannot undo the newer choice. Every broadcast and
 * successful save bumps a version, so a mount load that answers after either
 * cannot replace the newer saved state.
 */
function useChatEnrichmentModes(): {
  readonly modes: ChatEnrichmentModes;
  readonly failed: Record<ChatEnrichmentProvider, boolean>;
  readonly choose: (
    provider: ChatEnrichmentProvider,
    patch: Partial<PreferencesData>,
    mode: ChatEnrichmentMode,
  ) => void;
} {
  const [modes, setModes] = useState<ChatEnrichmentModes>({
    linear: DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
    github: DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  });
  const [failed, setFailed] = useState({ linear: false, github: false });
  const savedRef = useRef<ChatEnrichmentModes>(modes);
  const latestSaveRef = useRef({ linear: 0, github: 0 });
  const pendingSaveRef = useRef({ linear: 0, github: 0 });
  const savedVersionRef = useRef(0);

  // Rows with a pending save keep the choice until it settles.
  function applySaved(preferences: PreferencesData): void {
    const saved = readChatEnrichmentModes(preferences);
    savedRef.current = saved;
    setModes((current) => ({
      linear: pendingSaveRef.current.linear ? current.linear : saved.linear,
      github: pendingSaveRef.current.github ? current.github : saved.github,
    }));
  }

  useEffect(() => {
    const loadVersion = savedVersionRef.current;
    const unsubscribe =
      typeof window.api.onPreferencesSynced === 'function'
        ? window.api.onPreferencesSynced((preferences) => {
            savedVersionRef.current++;
            applySaved(preferences);
          })
        : undefined;
    void window.api.loadPreferences().then(
      (preferences) => {
        if (savedVersionRef.current === loadVersion) applySaved(preferences);
      },
      // Keep the defaults; the next broadcast or save supplies saved modes.
      () => {},
    );
    return unsubscribe;
  }, []);

  function choose(
    provider: ChatEnrichmentProvider,
    patch: Partial<PreferencesData>,
    mode: ChatEnrichmentMode,
  ): void {
    const save = ++latestSaveRef.current[provider];
    pendingSaveRef.current[provider] = save;
    setFailed((current) => ({ ...current, [provider]: false }));
    setModes((current) => ({ ...current, [provider]: mode }));
    const settle = (failedSave: boolean): void => {
      if (pendingSaveRef.current[provider] !== save) return;
      pendingSaveRef.current[provider] = 0;
      setModes((current) => ({
        ...current,
        [provider]: savedRef.current[provider],
      }));
      setFailed((current) => ({ ...current, [provider]: failedSave }));
    };
    void window.api.savePreferences(patch).then(
      (preferences) => {
        // Saves commit in order, so every success is the newest saved state.
        savedVersionRef.current++;
        settle(false);
        applySaved(preferences);
        emitPreferencesUpdated(preferences);
      },
      () => settle(true),
    );
  }

  return { modes, failed, choose };
}

function ChatEnrichmentSection(): JSX.Element {
  const { modes, failed, choose } = useChatEnrichmentModes();
  return (
    <SettingsSection
      title="Chat area data enrichment"
      description={
        // What each mode does, in the section's one explanation instead of a
        // row of its own.
        <span data-testid="chat-enrichment-how-it-works">
          {CHAT_ENRICHMENT_MODES.map((mode, index) => (
            <Fragment key={mode}>
              {index > 0 ? ' ' : null}
              <span className="font-medium fg-primary">
                {CHAT_ENRICHMENT_MODE_META[mode].label}:
              </span>{' '}
              {CHAT_ENRICHMENT_MODE_META[mode].description}
            </Fragment>
          ))}
        </span>
      }
      dataTestId="chat-enrichment-section"
    >
      <SettingsGroup>
        {CHAT_ENRICHMENT_PROVIDERS.map(({ provider, label, patch }) => {
          const id = `settings-${provider}-chat-enrichment-mode`;
          return (
            <SettingsRow
              key={provider}
              label={label}
              htmlFor={id}
              dataTestId={`${provider}-chat-enrichment-row`}
              control={
                <SettingsSelect
                  id={id}
                  aria-label={`${label} chat enrichment`}
                  options={CHAT_ENRICHMENT_MODES.map((mode) => ({
                    value: mode,
                    label: CHAT_ENRICHMENT_MODE_META[mode].label,
                  }))}
                  value={modes[provider]}
                  onValueChange={(value) => {
                    const next = CHAT_ENRICHMENT_MODES.find(
                      (mode) => mode === value,
                    );
                    if (next) choose(provider, patch(next), next);
                  }}
                  data-testid={id}
                />
              }
            >
              <ErrorBanner
                errorSource="chat-enrichment-section"
                className=""
                error={
                  failed[provider]
                    ? 'Could not save this setting. Try again.'
                    : null
                }
              />
            </SettingsRow>
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}

export function DisplayTab(): JSX.Element {
  const [theme, setTheme] = useState<ThemeName>(readCurrentTheme);
  const [colorMode, setColorMode] = useState<ColorMode>(readCurrentColorMode);
  const [systemColorMode, setSystemColorMode] =
    useState<ResolvedColorMode>(readCurrentColorMode);
  const [worktreeDiffStatsStyle, setWorktreeDiffStatsStyle] =
    useState<WorktreeDiffStatsStyle>('short');
  const [scrollbarBehavior, setScrollbarBehavior] =
    useState<ScrollbarBehavior>('system');
  const [uiScale, setUiScale] = useState(readCurrentScale);
  const [singleDollarMath, setSingleDollarMath] = useState(true);
  // Newest `uiScale` this component wrote and has not seen echoed back.
  const inFlightScaleRef = useRef<number | null>(null);
  const [defaultLayoutMode, setDefaultLayoutMode] =
    useState<WorkspaceLayoutMode>('advanced');
  // The default for new worktrees. Every worktree keeps its own mode, with
  // or without early access.
  const workspaceLayoutMode = defaultLayoutMode;
  const [workspaceLayoutSaveError, setWorkspaceLayoutSaveError] = useState<
    string | null
  >(null);

  useEffect(() => {
    void window.api.loadPreferences().then((prefs) => {
      setTheme(prefs.theme);
      setColorMode(prefs.colorMode);
      setWorktreeDiffStatsStyle(prefs.worktreeDiffStatsStyle ?? 'short');
      setScrollbarBehavior(prefs.scrollbarBehavior ?? 'system');
      setSingleDollarMath(prefs.singleDollarMath !== false);
      setUiScale(prefs.uiScale);
      setDefaultLayoutMode(prefs.workspaceDefaultLayoutMode);
      applyTheme(prefs.theme, prefs.colorMode);
      applyScrollbarBehavior(prefs.scrollbarBehavior);
      applyUiScale(prefs.uiScale);
    });
  }, []);

  useEffect(() => {
    if (typeof window.api.onPreferencesSynced !== 'function') {
      return undefined;
    }
    // The dropdown is not the only writer of `uiScale`: the View menu's Zoom
    // In / Zoom Out / Actual Size items step the same preference, and main
    // broadcasts every save. Without this the dropdown would keep showing the
    // value it loaded on mount while the window around it was already
    // zoomed. `applyUiScale` is not called here — the broadcast follows a
    // commit that main has already applied to every window, and the
    // renderer's own zoom watcher republishes `data-ui-scale` from it.
    return window.api.onPreferencesSynced((preferences) => {
      // ...but an echo of our own in-flight write must not fight the latest selection.
      // Every scale choice saves, main commits saves one at a time behind an
      // atomic file write and broadcasts each back to every window including
      // this one, so choosing 100 then 130 produces a stream of stale values
      // (105, 110, ...) while the selected value is already past them. Applying those
      // would replace the newest selection with an older value.
      // Ignore broadcasts until one carries the newest value we wrote: that
      // one means main has caught up, and anything after it is a genuine
      // external change. A lost save re-arms the gate on the next move.
      if (inFlightScaleRef.current !== null) {
        if (preferences.uiScale === inFlightScaleRef.current) {
          inFlightScaleRef.current = null;
        }
        return;
      }
      setUiScale(preferences.uiScale);
    });
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystemColorMode = (): void => {
      setSystemColorMode(mediaQuery.matches ? 'dark' : 'light');
    };
    updateSystemColorMode();
    mediaQuery.addEventListener('change', updateSystemColorMode);
    return (): void => {
      mediaQuery.removeEventListener('change', updateSystemColorMode);
    };
  }, []);

  function handleThemeChange(next: ThemeName): void {
    setTheme(next);
    applyTheme(next, colorMode);
    savePreference({ theme: next });
  }

  function handleColorModeChange(next: ColorMode): void {
    setColorMode(next);
    applyTheme(theme, next);
    savePreference({ colorMode: next });
  }

  function handleScaleChange(next: number): void {
    inFlightScaleRef.current = next;
    setUiScale(next);
    applyUiScale(next);
    savePreference({ uiScale: next });
  }

  function handleWorktreeDiffStatsStyleChange(
    next: WorktreeDiffStatsStyle,
  ): void {
    setWorktreeDiffStatsStyle(next);
    savePreference({ worktreeDiffStatsStyle: next });
  }

  function handleWorkspaceLayoutModeChange(next: WorkspaceLayoutMode): void {
    if (next === workspaceLayoutMode) return;
    setWorkspaceLayoutSaveError(null);
    const previous = defaultLayoutMode;
    setDefaultLayoutMode(next);
    void window.api
      .savePreferences({ workspaceDefaultLayoutMode: next })
      .catch(() => {
        setDefaultLayoutMode(previous);
        setWorkspaceLayoutSaveError("Couldn't save project layout setting.");
      });
  }

  function handleSingleDollarMathChange(next: boolean): void {
    setSingleDollarMath(next);
    savePreference({ singleDollarMath: next });
  }

  function handleScrollbarBehaviorChange(next: ScrollbarBehavior): void {
    setScrollbarBehavior(next);
    applyScrollbarBehavior(next);
    savePreference({ scrollbarBehavior: next });
  }

  const scrollbarMeta = SCROLLBAR_BEHAVIOR_META[scrollbarBehavior];
  return (
    <SettingsPage title="Display" dataTestId="settings-tab-display">
      <SettingsSection title="Appearance">
        <SettingsGroup>
          <SettingsRow
            label="Color mode"
            description={
              colorMode === 'system'
                ? 'Follows your system setting.'
                : undefined
            }
            control={
              <AppearanceSelect
                label="Color mode"
                value={colorMode}
                onChange={handleColorModeChange}
                testId="settings-color-mode-select"
                options={COLOR_MODES.map((mode) => ({
                  value: mode,
                  label: COLOR_MODE_LABELS[mode],
                  testId: `color-mode-${mode}`,
                }))}
              />
            }
          />
          <SettingsRow
            label="Theme"
            description="The color palette for the interface."
            control={
              <AppearanceSelect
                label="Theme"
                value={theme}
                onChange={handleThemeChange}
                testId="settings-theme-select"
                options={THEME_NAMES.map((name) => {
                  const mode =
                    colorMode === 'system' ? systemColorMode : colorMode;
                  return {
                    value: name,
                    label: THEME_LABELS[name],
                    testId: `theme-swatch-${name}`,
                    // Each dot uses the represented theme's accent color.
                    preview:
                      name === 'default' ? (
                        <span
                          aria-hidden="true"
                          data-testid={`theme-color-dot-${name}`}
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{
                            background: brand.theme.default.swatch[mode].accent,
                          }}
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          data-testid={`theme-color-dot-${name}`}
                          data-theme={name}
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            mode === 'dark' ? 'dark' : ''
                          }`}
                          // A swatch of the theme's own accent: the variable
                          // resolves under this element's `data-theme`.
                          style={{ background: 'var(--bg-accent)' }}
                        />
                      ),
                  };
                })}
              />
            }
          />
          <SidebarStyleSettingsRow />
          <ActivityCardSettingsRow />
          <SettingsRow
            label="Interface scale"
            description="The overall size of the interface."
            control={
              <>
                {uiScale !== 100 ? (
                  <Button
                    size="compact"
                    variant="secondary"
                    onClick={() => handleScaleChange(100)}
                    data-testid="settings-ui-scale-reset"
                  >
                    Reset
                  </Button>
                ) : null}
                <AppearanceSelect
                  label="Interface scale"
                  value={String(uiScale)}
                  onChange={(value) => handleScaleChange(Number(value))}
                  testId="settings-ui-scale-select"
                  options={Array.from(
                    { length: (SCALE_MAX - SCALE_MIN) / SCALE_STEP + 1 },
                    (_, index) => {
                      const scale = SCALE_MIN + index * SCALE_STEP;
                      return {
                        value: String(scale),
                        label: `${scale}%`,
                        testId: `settings-ui-scale-option-${scale}`,
                      };
                    },
                  )}
                />
              </>
            }
          />
          <ChatDetailSettingsRow />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Layout">
        <SettingsGroup>
          {/* Keep customization available from Display as well as More. */}
          <SettingsRow
            label="Sidebar items"
            description="Choose which pages the sidebar shows and in what order."
            control={
              <Button
                size="compact"
                variant="secondary"
                data-testid="settings-customize-sidebar"
                onClick={() => {
                  const navigation = useNavigationStore.getState();
                  navigation.closeSettings();
                  navigation.requestCustomizeSidebar();
                }}
              >
                Customize…
              </Button>
            }
          />
          <SettingsRow
            label="Project layout"
            description={
              <>
                {WORKSPACE_LAYOUT_MODE_COPY[workspaceLayoutMode].description}{' '}
                Used for new worktrees and work entries.
              </>
            }
            control={
              <SettingsSegmentedControl
                label="Project layout"
                value={workspaceLayoutMode}
                onChange={handleWorkspaceLayoutModeChange}
                options={WORKSPACE_LAYOUT_MODES.map((mode) => ({
                  value: mode,
                  label: WORKSPACE_LAYOUT_MODE_COPY[mode].label,
                  dataTestId: `workspace-layout-default-${mode}`,
                }))}
              />
            }
          >
            <ErrorBanner
              errorSource="display-tab-workspace-layout-save"
              error={workspaceLayoutSaveError}
              className=""
            />
          </SettingsRow>
          <SettingsRow
            label="Scrollbars"
            htmlFor="settings-scrollbar-behavior"
            description={scrollbarMeta.description}
            dataTestId="scrollbar-behavior-row"
            control={
              <SettingsSelect
                id="settings-scrollbar-behavior"
                options={SCROLLBAR_BEHAVIORS.map((behavior) => ({
                  value: behavior,
                  label: SCROLLBAR_BEHAVIOR_META[behavior].label,
                }))}
                value={scrollbarBehavior}
                onValueChange={(value) => {
                  const next = SCROLLBAR_BEHAVIORS.find(
                    (behavior) => behavior === value,
                  );
                  if (next) handleScrollbarBehaviorChange(next);
                }}
                data-testid="settings-scrollbar-behavior"
              />
            }
          />
          <SettingsRow
            label="Worktree diff stats"
            description={
              WORKTREE_DIFF_STATS_STYLE_META[worktreeDiffStatsStyle].description
            }
            dataTestId="worktree-diff-stats-section"
            control={
              <SettingsSegmentedControl
                label="Worktree diff stats"
                value={worktreeDiffStatsStyle}
                onChange={handleWorktreeDiffStatsStyleChange}
                options={WORKTREE_DIFF_STATS_STYLES.map((style) => ({
                  value: style,
                  label: WORKTREE_DIFF_STATS_STYLE_META[style].label,
                  dataTestId: `worktree-diff-stats-style-${style}`,
                }))}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <ChatEnrichmentSection />

      <SettingsSection title="Math">
        <SettingsGroup>
          <SettingsRow
            label="Dollar-sign math"
            description={
              singleDollarMath
                ? 'Text between single dollar signs, such as $x^2$, shows as math. Prices such as $5 stay text.'
                : 'Text between single dollar signs stays text. Math in \\(…\\), $$…$$ and math code blocks still shows as math.'
            }
            dataTestId="single-dollar-math-row"
            control={
              <SettingsSegmentedControl
                label="Dollar-sign math"
                value={singleDollarMath ? 'on' : 'off'}
                onChange={(value) =>
                  handleSingleDollarMathChange(value === 'on')
                }
                options={[
                  {
                    value: 'on',
                    label: 'On',
                    dataTestId: 'single-dollar-math-on',
                  },
                  {
                    value: 'off',
                    label: 'Off',
                    dataTestId: 'single-dollar-math-off',
                  },
                ]}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
