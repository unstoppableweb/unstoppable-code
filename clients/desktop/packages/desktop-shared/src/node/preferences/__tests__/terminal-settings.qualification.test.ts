import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  resolveKnownModel,
  type PreferencesData,
  type TerminalPreset,
} from '../../../types';
import * as NormalizationEnvironment from '../normalization-environment';
import { createCatalogPreferencesModelFacts } from '../catalog-model-facts';
import { normalizePreferences } from '../normalize-preferences';
import { mergePreferenceUpdate } from '../merge-preference-update';
import { applyTerminalSettingsSaveRule } from '../terminal-settings';

const presetA: TerminalPreset = {
  id: 'a',
  name: 'Build',
  terminalProfileId: 'default',
  command: 'make',
  enabled: true,
};
const presetB: TerminalPreset = {
  ...presetA,
  id: 'b',
  name: 'Test',
  command: 'make test',
};
const context = {
  loadError: null,
  migrationTimestamp: (): string => '2026-11-05T00:00:00.000Z',
};

describe('terminal settings revision and the preferences:save rule (CAN-4148)', () => {
  beforeEach((): void => {
    initClaudeModels([
      { id: 'opus[1m]', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
    ]);
    initCodexModels([{ id: 'gpt-6.1-sol', label: 'Codex default' }]);
    initOllamaModels([
      {
        id: 'ollama-qwen3-coder',
        rawModelId: 'qwen3-coder',
        label: 'qwen3-coder',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    NormalizationEnvironment.installPreferencesNormalizationEnvironment(
      createCatalogPreferencesModelFacts({
        status: (model) =>
          resolveKnownModel(model) ? 'available' : 'unavailable',
        ollamaEnabled: () => false,
        shortcutPlatform: () => 'darwin',
      }),
    );
  });

  function existing(): PreferencesData {
    return normalizePreferences(
      { terminalSettingsRevision: 3, terminalPresets: [presetA] },
      'persisted',
    );
  }

  it('moves the revision only when shells or presets change', () => {
    const current = existing();
    expect(
      mergePreferenceUpdate(
        current,
        { terminalPresets: [presetA, presetB] },
        context,
      ).terminalSettingsRevision,
    ).toBe(4);
    expect(
      mergePreferenceUpdate(
        current,
        { disabledTerminalShellProfileIds: ['bash'] },
        context,
      ).terminalSettingsRevision,
    ).toBe(4);
    expect(
      mergePreferenceUpdate(current, { fileAutoSave: true }, context)
        .terminalSettingsRevision,
    ).toBe(3);
    expect(
      mergePreferenceUpdate(current, { terminalPresets: [presetA] }, context)
        .terminalSettingsRevision,
    ).toBe(3);
  });

  it('never takes the revision from a patch', () => {
    const current = existing();
    expect(
      mergePreferenceUpdate(
        current,
        { terminalSettingsRevision: 99, fileAutoSave: true },
        context,
      ).terminalSettingsRevision,
    ).toBe(3);
    expect(
      mergePreferenceUpdate(
        current,
        { terminalSettingsRevision: 0, terminalPresets: [] },
        context,
      ).terminalSettingsRevision,
    ).toBe(4);
  });

  it('normalizes a missing or invalid stored revision to zero', () => {
    expect(normalizePreferences({}).terminalSettingsRevision).toBe(0);
    for (const terminalSettingsRevision of [
      -1,
      1.5,
      '7',
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        normalizePreferences({ terminalSettingsRevision })
          .terminalSettingsRevision,
      ).toBe(0);
    }
    expect(
      normalizePreferences({ terminalSettingsRevision: 7 })
        .terminalSettingsRevision,
    ).toBe(7);
  });

  it('keeps terminal settings out of a wide preferences:save patch and applies the exact legacy intent', () => {
    const cases: [Partial<PreferencesData>, Partial<PreferencesData>][] = [
      [
        { terminalPresets: [], terminalDrawerHeight: 400 },
        { terminalDrawerHeight: 400 },
      ],
      [
        { disabledTerminalShellProfileIds: [], terminalPresets: [presetA] },
        { disabledTerminalShellProfileIds: [], terminalPresets: [presetA] },
      ],
      [{ terminalPresets: [presetA] }, {}],
      [
        {
          disabledTerminalShellProfileIds: [],
          terminalPresets: [presetA],
          terminalSettingsRevision: 5,
        },
        {},
      ],
    ];
    for (const [preferences, expected] of cases) {
      const patch = { ...preferences };
      applyTerminalSettingsSaveRule(preferences, patch);
      expect(patch).toEqual(expected);
    }
  });
});
