import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  resolveKnownModel,
  type ChatTabPluginSelections,
  type PreferencesData,
} from '../../../types';
import * as NormalizationEnvironment from '../normalization-environment';
import { createCatalogPreferencesModelFacts } from '../catalog-model-facts';
import { normalizePreferences } from '../normalize-preferences';
import { mergePreferenceUpdate } from '../merge-preference-update';
import { applyGlobalPluginDefaultsSaveRule } from '../global-plugin-defaults';

function selections(...pluginNames: string[]): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: pluginNames.map((pluginName) => ({
      marketplaceId: 'acme',
      pluginName,
    })),
  };
}

const context = {
  loadError: null,
  migrationTimestamp: (): string => '2026-11-08T00:00:00.000Z',
};

describe('global plugin defaults and the preferences:save rule (CAN-5766)', () => {
  beforeEach((): void => {
    initClaudeModels([
      { id: 'opus[1m]', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
    ]);
    initCodexModels([{ id: 'gpt-6.1-sol', label: 'Codex default' }]);
    initOllamaModels([]);
    NormalizationEnvironment.installPreferencesNormalizationEnvironment(
      createCatalogPreferencesModelFacts({
        status: (model) =>
          resolveKnownModel(model) ? 'available' : 'unavailable',
        ollamaEnabled: () => false,
        shortcutPlatform: () => 'darwin',
      }),
    );
  });

  it('keeps global plugin defaults out of a wide preferences:save patch and applies the exact one-key intent', () => {
    const cases: [Partial<PreferencesData>, Partial<PreferencesData>][] = [
      [
        {
          globalPluginSelections: selections('old'),
          showDiagnosticsPill: true,
        },
        { showDiagnosticsPill: true },
      ],
      [
        { globalPluginSelections: selections('new') },
        { globalPluginSelections: selections('new') },
      ],
      [{ showDiagnosticsPill: true }, { showDiagnosticsPill: true }],
    ];
    for (const [preferences, expected] of cases) {
      const patch = { ...preferences };
      applyGlobalPluginDefaultsSaveRule(preferences, patch);
      expect(patch).toEqual(expected);
    }
  });

  it('never puts back defaults that changed after a window read its copy', () => {
    const committed = normalizePreferences(
      {
        globalPluginSelections: selections('changed-in-core'),
        showDiagnosticsPill: false,
      },
      'persisted',
    );
    const staleSnapshot: Partial<PreferencesData> = {
      globalPluginSelections: selections('read-earlier'),
      showDiagnosticsPill: true,
    };
    const patch = { ...staleSnapshot };
    applyGlobalPluginDefaultsSaveRule(staleSnapshot, patch);
    const next = mergePreferenceUpdate(committed, patch, context);
    expect(next.globalPluginSelections?.pluginRefs).toEqual(
      selections('changed-in-core').pluginRefs,
    );
    expect(next.showDiagnosticsPill).toBe(true);
  });
});
