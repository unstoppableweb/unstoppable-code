import { CLIENT_LOCAL_PREFERENCE_KEYS } from '@canopy/core-runtime/node/preferences';
import { runStoredKeysConformance } from '@canopy/core-runtime/node/preferences/testing';
import {
  initClaudeModels,
  initCodexModels,
  resolveKnownModel,
  type PreferencesData,
} from '../../../types';
import * as NormalizationEnvironment from '../normalization-environment';
import { createCatalogPreferencesModelFacts } from '../catalog-model-facts';
import {
  CLIENT_LOCAL_PREFERENCES_CODEC,
  mergeClientLocalPreferences,
  normalizeClientLocalPreferences,
  splitPreferencesPatch,
  storedClientLocalValues,
  type ClientLocalPreferences,
} from '../client-local-preferences';
import {
  DEFAULT_CLIENT_LOCAL_PREFERENCES,
  DEFAULT_DOMAIN_PREFERENCES,
  DEFAULT_PREFERENCES,
} from '../defaults';
import { DESKTOP_PREFERENCES_CODEC } from '../desktop-preferences-codec';
import { mergePreferenceUpdate } from '../merge-preference-update';
import {
  normalizeDomainPreferences,
  normalizePreferences,
} from '../normalize-preferences';

/** A value for every client-local key that differs from its default. */
const CHANGED: ClientLocalPreferences = {
  windowBounds: { x: 10, y: 20, width: 1200, height: 800 },
  windowMaximized: true,
  windowFullScreen: true,
  appAdvisorDialogBounds: { x: 5, y: 6, width: 900, height: 700 },
  theme: 'ocean',
  colorMode: 'dark',
  sidebarAppearance: 'opaque',
  scrollbarBehavior: 'always',
  worktreeDiffStatsStyle: 'complete',
  uiScale: 125,
  sidebarWidth: 300,
  sidebarCollapsed: true,
  sidebarCodeSectionCollapsed: true,
  sidebarCoworkSectionCollapsed: true,
  sidebarOrchestratorCollapsed: true,
  appAdvisorNavCollapsed: true,
  worktreePanelPercent: 40,
  kanbanWorktreePanelPercent: 45,
  activityPanelExpanded: true,
  kanbanActivityPanelExpanded: true,
  activityPanelWidthPercent: 30,
  kanbanActivityPanelWidthPercent: 35,
  kanbanChatPanelVisible: true,
  pipelineChatPanelVisible: false,
  pipelineChatPanelWidthPercent: 50,
  terminalDrawerCollapsed: false,
  terminalDrawerHeight: 420,
};

const context = {
  loadError: null,
  migrationTimestamp: (): string => '2026-11-25T00:00:00.000Z',
};

function presentKeys(value: object): string[] {
  return CLIENT_LOCAL_PREFERENCE_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

beforeEach((): void => {
  initClaudeModels([
    { id: 'opus[1m]', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
  ]);
  initCodexModels([{ id: 'gpt-6.1-sol', label: 'Codex default' }]);
  NormalizationEnvironment.installPreferencesNormalizationEnvironment(
    createCatalogPreferencesModelFacts({
      status: (model) =>
        resolveKnownModel(model) ? 'available' : 'unavailable',
      ollamaEnabled: () => false,
      shortcutPlatform: () => 'darwin',
    }),
  );
});

// G2/G3 over the desktop inner codec; core-runtime runs the stand-ins.
runStoredKeysConformance({ describe, it }, 'the desktop domain codec', {
  inner: DESKTOP_PREFERENCES_CODEC,
  keys: CLIENT_LOCAL_PREFERENCE_KEYS,
  storedValues: CHANGED,
  unrelatedPatch: { fileAutoSave: true },
});

describe('the domain codec carries no client-local key (CAN-4472)', () => {
  it('defaults, normalization and the merge have no client-local field', () => {
    expect(presentKeys(DEFAULT_DOMAIN_PREFERENCES)).toEqual([]);
    expect(presentKeys(DESKTOP_PREFERENCES_CODEC.defaults)).toEqual([]);
    for (const view of ['persisted', 'runtime'] as const) {
      expect(presentKeys(normalizeDomainPreferences(CHANGED, view))).toEqual(
        [],
      );
    }
    const existing = normalizeDomainPreferences({}, 'persisted');
    // A stale wide snapshot that carries every moved key.
    const wide: Partial<PreferencesData> = {
      ...DEFAULT_PREFERENCES,
      ...CHANGED,
      fileAutoSave: true,
    };
    const merged = mergePreferenceUpdate(existing, wide, context);
    expect(presentKeys(merged)).toEqual([]);
    expect(merged.fileAutoSave).toBe(true);
  });

  it('the whole value is still the domain document plus the client-local one', () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      ...DEFAULT_DOMAIN_PREFERENCES,
      ...DEFAULT_CLIENT_LOCAL_PREFERENCES,
    });
    const full = normalizePreferences({ ...CHANGED, fileAutoSave: true });
    expect(full).toMatchObject({ ...CHANGED, fileAutoSave: true });
    expect(normalizePreferences({})).toMatchObject(
      DEFAULT_CLIENT_LOCAL_PREFERENCES,
    );
  });
});

describe('the client-local document (CAN-4472)', () => {
  it('normalizes each key as the single preferences document did', () => {
    expect(normalizeClientLocalPreferences(CHANGED)).toEqual(CHANGED);
    expect(normalizeClientLocalPreferences({})).toEqual(
      DEFAULT_CLIENT_LOCAL_PREFERENCES,
    );
    expect(
      normalizeClientLocalPreferences({
        sidebarWidth: 10_000,
        terminalDrawerHeight: 1,
        uiScale: 999,
        theme: 'not-a-theme',
        windowBounds: { x: 0, y: 0, width: 10, height: 10 },
        appAdvisorNavCollapsed: 'yes',
        pipelineChatPanelWidthPercent: 99,
      }),
    ).toEqual({
      ...DEFAULT_CLIENT_LOCAL_PREFERENCES,
      sidebarWidth: 480,
      terminalDrawerHeight: 180,
      uiScale: 200,
      pipelineChatPanelWidthPercent: 65,
    });
  });

  it('its codec never refuses and merges over the stored copy', () => {
    expect(CLIENT_LOCAL_PREFERENCES_CODEC.inspect({ theme: 42 })).toBeNull();
    expect(
      CLIENT_LOCAL_PREFERENCES_CODEC.merge(
        CHANGED,
        { theme: 'forest' },
        context,
      ),
    ).toEqual({ ...CHANGED, theme: 'forest' });
  });

  it('a save splits by document, and the merged view takes the client part last', () => {
    const { domain, clientLocal } = splitPreferencesPatch({
      theme: 'forest',
      sidebarWidth: 320,
      fileAutoSave: true,
      navigationMode: 'work',
    });
    expect(domain).toEqual({ fileAutoSave: true, navigationMode: 'work' });
    expect(clientLocal).toEqual({ theme: 'forest', sidebarWidth: 320 });

    // A frozen copy never shows through, not even an optional key the
    // client document doesn't hold.
    const frozen = {
      ...normalizeDomainPreferences({}, 'persisted'),
      ...CHANGED,
    };
    const client: ClientLocalPreferences = {
      ...DEFAULT_CLIENT_LOCAL_PREFERENCES,
    };
    const merged = mergeClientLocalPreferences(frozen, client);
    expect(merged).toMatchObject(DEFAULT_CLIENT_LOCAL_PREFERENCES);
    expect(merged.appAdvisorNavCollapsed).toBeUndefined();
    expect(storedClientLocalValues(frozen)).toEqual(CHANGED);
  });
});
