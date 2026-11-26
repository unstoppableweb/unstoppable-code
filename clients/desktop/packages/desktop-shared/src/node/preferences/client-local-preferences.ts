import {
  CLIENT_LOCAL_PREFERENCE_KEYS,
  type ClientLocalPreferenceKey,
  type DomainPreferencesData,
  type PreferencesCodec,
  type StoredDomainPreferences,
} from '@canopy/core-runtime/node/preferences';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../constants/preferences';
import {
  MAX_TERMINAL_DRAWER_HEIGHT,
  MIN_TERMINAL_DRAWER_HEIGHT,
  type PreferencesData,
} from '../../types';
import { clampUiScale } from '../../lib/ui-scale';
import { DEFAULT_CLIENT_LOCAL_PREFERENCES } from './defaults';
import {
  isColorMode,
  isScrollbarBehavior,
  isSidebarAppearance,
  isThemeName,
  isWorktreeDiffStatsStyle,
} from './field-normalizers';
import {
  clampNumber,
  normalizeFiniteNumber,
  normalizeLayoutPreferences,
} from './model-normalizers';
import {
  normalizeAppAdvisorDialogBounds,
  normalizeWindowBounds,
} from './record-normalizers';

export {
  storedClientLocalValues,
  type DomainPreferencesData,
  type StoredDomainPreferences,
} from '@canopy/core-runtime/node/preferences';

const CHECKED_CLIENT_LOCAL_KEYS =
  CLIENT_LOCAL_PREFERENCE_KEYS satisfies readonly (keyof PreferencesData)[];

/** Window geometry, appearance and pure view state: this client's own document (CAN-4472). */
export type ClientLocalPreferences = Pick<
  PreferencesData,
  ClientLocalPreferenceKey
>;

const DEFAULT = DEFAULT_CLIENT_LOCAL_PREFERENCES;

export function normalizeClientLocalPreferences(
  data: Partial<PreferencesData> | Record<string, unknown> | undefined,
): ClientLocalPreferences {
  const layout = normalizeLayoutPreferences(data);
  return {
    windowBounds: normalizeWindowBounds(data?.windowBounds),
    windowMaximized:
      typeof data?.windowMaximized === 'boolean'
        ? data.windowMaximized
        : DEFAULT.windowMaximized,
    windowFullScreen:
      typeof data?.windowFullScreen === 'boolean'
        ? data.windowFullScreen
        : DEFAULT.windowFullScreen,
    appAdvisorDialogBounds: normalizeAppAdvisorDialogBounds(
      data?.appAdvisorDialogBounds,
    ),
    theme: isThemeName(data?.theme) ? data.theme : DEFAULT.theme,
    colorMode: isColorMode(data?.colorMode)
      ? data.colorMode
      : DEFAULT.colorMode,
    sidebarAppearance: isSidebarAppearance(data?.sidebarAppearance)
      ? data.sidebarAppearance
      : DEFAULT.sidebarAppearance,
    worktreeDiffStatsStyle: isWorktreeDiffStatsStyle(
      data?.worktreeDiffStatsStyle,
    )
      ? data.worktreeDiffStatsStyle
      : DEFAULT.worktreeDiffStatsStyle,
    scrollbarBehavior: isScrollbarBehavior(data?.scrollbarBehavior)
      ? data.scrollbarBehavior
      : DEFAULT.scrollbarBehavior,
    // Clamped and snapped through the shared helper the Display slider and
    // the View-menu zoom items also use, so no surface can offer a scale the
    // store would rewrite behind it.
    uiScale: clampUiScale(
      typeof data?.uiScale === 'number' ? data.uiScale : undefined,
    ),
    sidebarWidth: clampNumber(
      normalizeFiniteNumber(data?.sidebarWidth, DEFAULT.sidebarWidth),
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
    ),
    sidebarCollapsed:
      typeof data?.sidebarCollapsed === 'boolean'
        ? data.sidebarCollapsed
        : DEFAULT.sidebarCollapsed,
    sidebarCodeSectionCollapsed:
      typeof data?.sidebarCodeSectionCollapsed === 'boolean'
        ? data.sidebarCodeSectionCollapsed
        : DEFAULT.sidebarCodeSectionCollapsed,
    sidebarCoworkSectionCollapsed:
      typeof data?.sidebarCoworkSectionCollapsed === 'boolean'
        ? data.sidebarCoworkSectionCollapsed
        : DEFAULT.sidebarCoworkSectionCollapsed,
    sidebarOrchestratorCollapsed:
      typeof data?.sidebarOrchestratorCollapsed === 'boolean'
        ? data.sidebarOrchestratorCollapsed
        : DEFAULT.sidebarOrchestratorCollapsed,
    // Optional: only persisted once the user has toggled the App Advisor
    // popout nav (absent = expanded default).
    ...(typeof data?.appAdvisorNavCollapsed === 'boolean'
      ? { appAdvisorNavCollapsed: data.appAdvisorNavCollapsed }
      : {}),
    worktreePanelPercent: layout.worktreePanelPercent,
    kanbanWorktreePanelPercent: layout.kanbanWorktreePanelPercent,
    activityPanelExpanded:
      typeof data?.activityPanelExpanded === 'boolean'
        ? data.activityPanelExpanded
        : DEFAULT.activityPanelExpanded,
    kanbanActivityPanelExpanded:
      typeof data?.kanbanActivityPanelExpanded === 'boolean'
        ? data.kanbanActivityPanelExpanded
        : DEFAULT.kanbanActivityPanelExpanded,
    activityPanelWidthPercent: layout.activityPanelWidthPercent,
    kanbanActivityPanelWidthPercent: layout.kanbanActivityPanelWidthPercent,
    kanbanChatPanelVisible:
      typeof data?.kanbanChatPanelVisible === 'boolean'
        ? data.kanbanChatPanelVisible
        : DEFAULT.kanbanChatPanelVisible,
    pipelineChatPanelVisible:
      typeof data?.pipelineChatPanelVisible === 'boolean'
        ? data.pipelineChatPanelVisible
        : DEFAULT.pipelineChatPanelVisible,
    pipelineChatPanelWidthPercent: clampNumber(
      normalizeFiniteNumber(
        data?.pipelineChatPanelWidthPercent,
        DEFAULT.pipelineChatPanelWidthPercent ?? 30,
      ),
      20,
      65,
    ),
    terminalDrawerCollapsed:
      typeof data?.terminalDrawerCollapsed === 'boolean'
        ? data.terminalDrawerCollapsed
        : DEFAULT.terminalDrawerCollapsed,
    terminalDrawerHeight:
      typeof data?.terminalDrawerHeight === 'number' &&
      Number.isFinite(data.terminalDrawerHeight)
        ? Math.min(
            MAX_TERMINAL_DRAWER_HEIGHT,
            Math.max(
              MIN_TERMINAL_DRAWER_HEIGHT,
              Math.round(data.terminalDrawerHeight),
            ),
          )
        : DEFAULT.terminalDrawerHeight,
  };
}

/** The client-local document's codec. It never refuses a save. */
export const CLIENT_LOCAL_PREFERENCES_CODEC: PreferencesCodec<ClientLocalPreferences> =
  {
    defaults: DEFAULT_CLIENT_LOCAL_PREFERENCES,
    normalize: (payload) => normalizeClientLocalPreferences(payload),
    project: (value) => normalizeClientLocalPreferences(value),
    inspect: () => null,
    merge: (existing, patch) =>
      normalizeClientLocalPreferences({ ...existing, ...patch }),
  };

/** The domain value without its frozen client-local copy. */
function omitClientLocalPreferences(
  value: StoredDomainPreferences,
): DomainPreferencesData {
  const domain: StoredDomainPreferences = { ...value };
  for (const key of CHECKED_CLIENT_LOCAL_KEYS) delete domain[key];
  return domain;
}

/** The merged view every reader gets: the client-local part always wins. */
export function mergeClientLocalPreferences(
  domain: StoredDomainPreferences,
  clientLocal: ClientLocalPreferences,
): PreferencesData {
  return { ...omitClientLocalPreferences(domain), ...clientLocal };
}

function copyKey<K extends ClientLocalPreferenceKey>(
  from: Partial<PreferencesData>,
  to: Partial<ClientLocalPreferences>,
  key: K,
): void {
  to[key] = from[key];
}

/** Splits a save by document: client-local keys and everything else. */
export function splitPreferencesPatch(patch: Partial<PreferencesData>): {
  domain: Partial<DomainPreferencesData>;
  clientLocal: Partial<ClientLocalPreferences>;
} {
  const domain: Partial<PreferencesData> = { ...patch };
  const clientLocal: Partial<ClientLocalPreferences> = {};
  for (const key of CHECKED_CLIENT_LOCAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(domain, key)) continue;
    copyKey(domain, clientLocal, key);
    delete domain[key];
  }
  return { domain, clientLocal };
}
