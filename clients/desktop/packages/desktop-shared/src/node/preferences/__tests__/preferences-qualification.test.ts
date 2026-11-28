import type {
  PreferencesModelFacts,
  PreferencesModelStatus,
} from '@canopy/protocol/preferences';
import {
  DEFAULT_SUMMARY_FALLBACK_MODEL,
  DEFAULT_SUMMARY_MODEL,
  getProviderForModel,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  resolveKnownModel,
} from '../../../types';
import { DEFAULT_PREFERENCES } from '../defaults';
import * as NormalizationEnvironment from '../normalization-environment';
import { createCatalogPreferencesModelFacts } from '../catalog-model-facts';
import {
  normalizeProviderDefaults,
  normalizeRuntimeLimits,
  normalizeUserSelectedModel,
} from '../model-normalizers';
import {
  normalizeWindowBounds,
  normalizeAppAdvisorDialogBounds,
  normalizeChatTabPluginSelections,
  normalizeInAppNotifications,
  normalizeNativeProviderAccounts,
  normalizeDataSharingOptInHints,
  normalizeDataSharingOptInHistory,
  normalizeChatDetailPreference,
  normalizeAccountProxyConnection,
} from '../record-normalizers';
import { normalizePreferences } from '../normalize-preferences';
import { mergePreferenceUpdate } from '../merge-preference-update';
import { SUGGESTION_IDS } from '@canopy/protocol/suggestions';

describe('preference helper qualification (CAN-4471)', () => {
  let ollamaEnabled = false;

  beforeEach(() => {
    ollamaEnabled = false;
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
        ollamaEnabled: () => ollamaEnabled,
        shortcutPlatform: () => 'darwin',
      }),
    );
  });

  it('throws until a host installs an environment', () => {
    jest.isolateModules(() => {
      const environment = jest.requireActual<typeof NormalizationEnvironment>(
        '../normalization-environment',
      );
      expect(() => environment.preferencesNormalizationEnvironment()).toThrow(
        new Error(
          'Preferences normalization has no host environment; call installPreferencesNormalizationEnvironment first.',
        ),
      );
    });
  });

  it('a later install replaces the earlier one', () => {
    jest.isolateModules(() => {
      const environment = jest.requireActual<typeof NormalizationEnvironment>(
        '../normalization-environment',
      );
      environment.installPreferencesNormalizationEnvironment(
        createCatalogPreferencesModelFacts({
          status: () => 'unavailable',
          ollamaEnabled: () => false,
          shortcutPlatform: () => 'darwin',
        }),
      );
      environment.installPreferencesNormalizationEnvironment(
        createCatalogPreferencesModelFacts({
          status: () => 'unavailable',
          ollamaEnabled: () => false,
          shortcutPlatform: () => 'win32',
        }),
      );
      expect(
        environment.preferencesNormalizationEnvironment().shortcutPlatform(),
      ).toBe('win32');
    });
  });

  it('keeps saved model choices and effort when the catalog is unavailable', () => {
    initClaudeModels([]);
    initCodexModels([]);
    initOllamaModels([]);
    const saved = {
      claude: { model: 'sonnet', thinkingLevel: 'max' },
      codex: { model: 'gpt-6-astra', thinkingLevel: 'ultra' },
      ollama: { model: 'ollama-offline-model', thinkingLevel: 'high' },
      aiCredits: { model: 'org-gateway/offline-model', thinkingLevel: 'high' },
    };
    const normalized = normalizeProviderDefaults(
      { defaultChatProvider: 'ollama', defaultChatModelByProvider: saved },
      'persisted',
    );
    expect(normalized.defaultChatProvider).toBe('ollama');
    expect(normalized.defaultChatModelByProvider).toEqual(saved);
  });

  it('uses current Ollama support when projecting runtime provider defaults', () => {
    const saved = {
      defaultChatProvider: 'ollama',
      defaultChatModelByProvider: {
        claude: { model: 'sonnet', thinkingLevel: 'high' },
        codex: { model: 'gpt-6.1-sol', thinkingLevel: 'high' },
        ollama: { model: 'ollama-qwen3-coder', thinkingLevel: 'high' },
        aiCredits: null,
      },
    };
    const disabled = normalizeProviderDefaults(saved, 'runtime');
    expect(disabled.defaultChatProvider).toBe('claude');
    expect(disabled.defaultChatModelByProvider.ollama).toBeNull();
    ollamaEnabled = true;
    const enabled = normalizeProviderDefaults(saved, 'runtime');
    expect(enabled.defaultChatProvider).toBe('ollama');
    expect(enabled.defaultChatModelByProvider.ollama).toEqual({
      model: 'ollama-qwen3-coder',
      thinkingLevel: 'high',
    });
  });

  it('preserves unavailable user choices only for persisted or explicit retention', () => {
    const defaults = { stored: 'haiku', providerAware: (): string => 'sonnet' };
    expect(
      normalizeUserSelectedModel(
        'ollama-offline-model',
        true,
        defaults,
        'persisted',
      ),
    ).toEqual({ model: 'ollama-offline-model', setByUser: true });
    expect(
      normalizeUserSelectedModel(
        'ollama-offline-model',
        true,
        defaults,
        'runtime',
        {
          keepUnavailableChoice: true,
        },
      ),
    ).toEqual({ model: 'ollama-offline-model', setByUser: true });
    expect(
      normalizeUserSelectedModel(
        'ollama-offline-model',
        true,
        defaults,
        'runtime',
      ),
    ).toEqual({ model: 'sonnet', setByUser: false });
    expect(
      normalizeUserSelectedModel('opus[1m]', false, defaults, 'runtime'),
    ).toEqual({ model: 'sonnet', setByUser: false });
  });

  it('keeps runtime limit bounds, nullable caps and valid pressure ordering', () => {
    expect(
      normalizeRuntimeLimits({
        scriptTimeoutMinutes: 90,
        auditRetentionDays: 0,
        maxActiveChatTurns: null,
        maxActivePipelineExecutions: 200,
        memoryPressureWarningThresholdBytes: 5 * 1024 * 1024 * 1024,
        memoryPressureCriticalThresholdBytes: 4 * 1024 * 1024 * 1024,
      }),
    ).toMatchObject({
      scriptTimeoutMinutes: 30,
      auditRetentionDays: 1,
      maxActiveChatTurns: null,
      maxActivePipelineExecutions: 100,
      memoryPressureWarningThresholdBytes: 2 * 1024 * 1024 * 1024,
      memoryPressureCriticalThresholdBytes: 4 * 1024 * 1024 * 1024,
    });
  });

  it('preserves window coordinates and the separate window size floors', () => {
    const bounds = { x: -500, y: -200, width: 800, height: 500 };
    expect(normalizeWindowBounds(bounds)).toEqual(bounds);
    expect(normalizeWindowBounds({ ...bounds, width: 799 })).toBeNull();
    expect(normalizeWindowBounds({ ...bounds, height: Infinity })).toBeNull();
    const advisor = { x: 10, y: 20, width: 360, height: 360 };
    expect(normalizeAppAdvisorDialogBounds(advisor)).toEqual(advisor);
    expect(
      normalizeAppAdvisorDialogBounds({ ...advisor, width: 359 }),
    ).toBeNull();
  });

  it('normalizes saved selections, legacy collections and HTTP auth targets', () => {
    const target = {
      kind: 'standalone',
      serverId: 'server',
      configId: 'config',
    };
    expect(
      normalizeChatTabPluginSelections({
        collectionIds: ['current', 'shared'],
        bundleIds: ['shared', 'legacy'],
        skillRefs: [
          { sourceId: ' source ', skillName: ' skill ' },
          { sourceId: 'source', skillName: 'skill' },
          { sourceId: '', skillName: 'invalid' },
        ],
        mcpHttpAuthPreferences: [
          { target, handler: 'canopy' },
          { target, handler: 'provider' },
          { target, handler: 'invalid' },
        ],
      }),
    ).toEqual({
      collectionIds: ['current', 'shared', 'legacy'],
      skillRefs: [{ sourceId: 'source', skillName: 'skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
      mcpHttpAuthPreferences: [{ target, handler: 'provider' }],
    });
  });

  it('retains explicit notification corners and migrates the legacy toggle', () => {
    expect(
      normalizeInAppNotifications(undefined, {
        showInAppChatActivityToasts: false,
      }),
    ).toMatchObject({ enabled: false });
    expect(
      normalizeInAppNotifications({ placement: 'bottom-right' }, undefined),
    ).not.toHaveProperty('placement');
    expect(
      normalizeInAppNotifications(
        { placement: 'bottom-right', placementChosen: true },
        undefined,
      ),
    ).toMatchObject({ placement: 'bottom-right', placementChosen: true });
  });

  it('keeps native account metadata and canonical opt-in timestamps', () => {
    expect(
      normalizeNativeProviderAccounts({
        claude: {
          accountKey: ' account ',
          changedAt: 10,
          subscriptionRestoredAt: -1,
        },
        codex: { accountKey: '' },
      }),
    ).toEqual({ claude: { accountKey: 'account', changedAt: 10 } });
    expect(
      normalizeDataSharingOptInHints({
        statistics: { dismissedAt: '2026-01-01T01:00:00+01:00' },
        'feed-activity': { dismissedAt: 'invalid' },
        unknown: { dismissedAt: '2026-01-01' },
      }),
    ).toEqual({ statistics: { dismissedAt: '2026-01-01T00:00:00.000Z' } });
    expect(
      normalizeDataSharingOptInHistory([
        { enabledAt: '2026-02-01', sharing: {} },
        { enabledAt: 'invalid', sharing: {} },
        { enabledAt: '2026-01-01', sharing: {} },
      ]),
    ).toEqual([
      {
        enabledAt: '2026-01-01T00:00:00.000Z',
        sharing: {
          transcripts: 'off',
          plans: 'off',
          metadata: 'off',
          summaries: 'off',
        },
      },
      {
        enabledAt: '2026-02-01T00:00:00.000Z',
        sharing: {
          transcripts: 'off',
          plans: 'off',
          metadata: 'off',
          summaries: 'off',
        },
      },
    ]);
  });

  it('keeps saved chat detail ahead of the retired switches', () => {
    expect(normalizeChatDetailPreference(undefined)).toBe('recent');
    expect(
      normalizeChatDetailPreference({ chatGroupToolCallsEnabled: true }),
    ).toBe('compact');
    expect(
      normalizeChatDetailPreference({
        chatLiveStepWindowEnabled: true,
        chatGroupToolCallsEnabled: true,
      }),
    ).toBe('recent');
    expect(
      normalizeChatDetailPreference({
        chatDetail: 'detailed',
        chatGroupToolCallsEnabled: true,
      }),
    ).toBe('detailed');
  });

  it('validates and normalizes the persisted account proxy connection', () => {
    const connection = {
      id: 'proxy-1234',
      kind: 'server',
      url: 'example.com/v1/',
    };
    expect(normalizeAccountProxyConnection(connection)).toEqual({
      id: 'proxy-1234',
      kind: 'server',
      url: 'https://example.com',
    });
    expect(
      normalizeAccountProxyConnection({
        ...connection,
        url: 'http://example.com',
      }),
    ).toBeNull();
    expect(
      normalizeAccountProxyConnection({ ...connection, kind: 'invalid' }),
    ).toBeNull();
  });

  it('turns the account proxy on by default and keeps a turned-off proxy off', () => {
    const connection = {
      id: 'proxy-1234',
      kind: 'local' as const,
      url: 'http://127.0.0.1:8317',
    };
    const enabled = (data: Record<string, unknown> | undefined): boolean =>
      normalizePreferences(data, 'persisted').accountProxyEnabled === true;
    // Fresh, and every profile the retired Labs opt-in stored as off before
    // it connected anything.
    expect(enabled(undefined)).toBe(true);
    expect(enabled({ accountProxyEnabled: false })).toBe(true);
    expect(
      enabled({
        accountProxyEnabled: true,
        accountProxyConnection: connection,
      }),
    ).toBe(true);
    // Connected, then turned off: stays off with its connection kept.
    const off = normalizePreferences(
      { accountProxyEnabled: false, accountProxyConnection: connection },
      'persisted',
    );
    expect(off.accountProxyEnabled).toBe(false);
    expect(off.accountProxyConnection?.id).toBe('proxy-1234');

    // The Settings switch marks its choice, which then holds with or
    // without a connection, including while one is replaced or removed.
    const context = {
      loadError: null,
      migrationTimestamp: (): string => '2026-01-01T00:00:00.000Z',
    };
    const on = normalizePreferences(
      { accountProxyConnection: connection },
      'persisted',
    );
    const turnedOff = mergePreferenceUpdate(
      on,
      { accountProxyEnabled: false, accountProxyEnabledSetByUser: true },
      context,
    );
    expect(turnedOff.accountProxyEnabled).toBe(false);
    const cleared = mergePreferenceUpdate(
      turnedOff,
      { accountProxyConnection: null },
      context,
    );
    expect(cleared.accountProxyEnabled).toBe(false);
    expect(
      mergePreferenceUpdate(
        cleared,
        { accountProxyEnabled: true, accountProxyEnabledSetByUser: true },
        context,
      ).accountProxyEnabled,
    ).toBe(true);
    // Turned off with no connection yet, as the switch saves while setup
    // replaces one: still off.
    expect(
      enabled({
        accountProxyEnabled: false,
        accountProxyEnabledSetByUser: true,
      }),
    ).toBe(false);
  });

  it('keeps corrupt onboarding records distinct from never-initialized records', () => {
    const fresh = normalizePreferences(undefined, 'persisted');
    expect(fresh.planModeHint).toEqual({ version: 1, generation: 0 });
    expect(fresh.githubStarPrompt).toBeDefined();
    const corrupt = normalizePreferences(
      { planModeHint: { version: 2 }, githubStarPrompt: { version: 2 } },
      'persisted',
    );
    expect(corrupt).not.toHaveProperty('planModeHint');
    expect(corrupt).not.toHaveProperty('githubStarPrompt');
    expect(() =>
      mergePreferenceUpdate(
        corrupt,
        {},
        { loadError: null, migrationTimestamp: (): string => '' },
      ),
    ).toThrow(
      'Plan mode hint preferences could not be read; preferences were not changed.',
    );
  });

  it('blocks onboarding patches when the merge context has a load error', () => {
    const existing = normalizePreferences(undefined, 'persisted');
    const context = {
      loadError: {
        timestamp: '2026-01-01T00:00:00.000Z',
        reason: 'parse' as const,
        message: 'Invalid saved preferences',
        filePath: '/unused/preferences.json',
      },
      migrationTimestamp: (): string => '2026-01-01T00:00:00.000Z',
    };
    expect(() =>
      mergePreferenceUpdate(
        existing,
        { planModeHint: existing.planModeHint },
        context,
      ),
    ).toThrow(
      'Preferences could not be read; the plan mode hint was not changed.',
    );
    expect(() =>
      mergePreferenceUpdate(
        existing,
        { githubStarPrompt: existing.githubStarPrompt },
        context,
      ),
    ).toThrow(
      'Preferences could not be read; the GitHub star prompt was not changed.',
    );
  });

  it('calls the notification migration timestamp lazily and retains the first answer', () => {
    const existing = normalizePreferences(
      { osNotifications: { enabled: false } },
      'persisted',
    );
    const migrationTimestamp = jest.fn(() => '2026-01-01T00:00:00.000Z');
    const context = { loadError: null, migrationTimestamp };
    mergePreferenceUpdate(existing, {}, context);
    expect(migrationTimestamp).not.toHaveBeenCalled();
    const enabled = mergePreferenceUpdate(
      existing,
      {
        osNotifications: { ...existing.osNotifications, enabled: true },
      },
      context,
    );
    expect(enabled.osNotificationOfferAnsweredAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(migrationTimestamp).toHaveBeenCalledTimes(1);
    const retained = mergePreferenceUpdate(
      enabled,
      {
        osNotifications: { ...enabled.osNotifications, enabled: false },
        osNotificationOfferAnsweredAt: '2026-02-01T00:00:00.000Z',
      },
      context,
    );
    expect(retained.osNotificationOfferAnsweredAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(migrationTimestamp).toHaveBeenCalledTimes(1);
  });

  it('retains saved models on unrelated patches and validates new handoff selections', () => {
    const existing = normalizePreferences(
      {
        summaryModel: 'org-gateway/offline-model',
        summaryModelSetByUser: true,
      },
      'persisted',
    );
    const context = {
      loadError: null,
      migrationTimestamp: (): string => '2026-01-01T00:00:00.000Z',
    };
    expect(mergePreferenceUpdate(existing, {}, context)).toMatchObject({
      summaryModel: 'org-gateway/offline-model',
      summaryModelSetByUser: true,
    });
    expect(() =>
      mergePreferenceUpdate(
        existing,
        {
          handoffSummaryModel: 'org-gateway/offline-model',
        },
        context,
      ),
    ).toThrow('Choose an available conversation handoff model in Settings.');
  });

  it('timestamps suggestion dismissals inside the merge instead of trusting the patch', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const existing = normalizePreferences(undefined, 'persisted');
      const id = SUGGESTION_IDS[0];
      const next = mergePreferenceUpdate(
        existing,
        {
          suggestions: {
            ...existing.suggestions,
            dismissed: {
              ...existing.suggestions.dismissed,
              [id]: '2025-01-01T00:00:00.000Z',
            },
          },
        },
        {
          loadError: null,
          migrationTimestamp: (): string => '2026-01-01T00:00:00.000Z',
        },
      );
      expect(next.suggestions.dismissed[id]).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('derives the onboarding analytics decline in main, only in the consent-accepting commit', () => {
    const context = {
      loadError: null,
      migrationTimestamp: (): string => '2026-01-01T00:00:00.000Z',
    };
    const fresh = normalizePreferences(undefined, 'persisted');
    expect(fresh.usageAnalyticsDeclinedAtOnboarding).toBe(false);
    const consent = {
      legalConsentAcceptedAt: '2026-11-24T00:00:00.000Z',
      legalConsentTosVersion: '1',
      dataChoicesConfirmedAt: '2026-11-24T00:00:00.000Z',
    };
    // Accepting with Usage analytics turned off marks the decline.
    const declined = mergePreferenceUpdate(
      fresh,
      {
        ...consent,
        usageData: { ...fresh.usageData, productAnalytics: false },
      },
      context,
    );
    expect(declined.usageAnalyticsDeclinedAtOnboarding).toBe(true);
    expect(declined.dataChoicesConfirmedAt).toBe(
      consent.dataChoicesConfirmedAt,
    );
    // Accepting with it left on does not, whatever the caller sends.
    expect(
      mergePreferenceUpdate(
        fresh,
        { ...consent, usageAnalyticsDeclinedAtOnboarding: true },
        context,
      ).usageAnalyticsDeclinedAtOnboarding,
    ).toBe(false);
    // Already off before the gate (an earlier Settings opt-out restored after
    // a recovery): accepting keeps it an ordinary opt-out.
    const alreadyOff = normalizePreferences(
      { usageData: { ...fresh.usageData, productAnalytics: false } },
      'persisted',
    );
    expect(
      mergePreferenceUpdate(
        alreadyOff,
        { ...consent, usageData: alreadyOff.usageData },
        context,
      ).usageAnalyticsDeclinedAtOnboarding,
    ).toBe(false);
    // A later commit cannot set it either: only the accepting commit derives.
    const accepted = mergePreferenceUpdate(fresh, consent, context);
    expect(
      mergePreferenceUpdate(
        accepted,
        {
          usageData: { ...accepted.usageData, productAnalytics: false },
          usageAnalyticsDeclinedAtOnboarding: true,
        },
        context,
      ).usageAnalyticsDeclinedAtOnboarding,
    ).toBe(false);
    // A caller cannot clear it, but turning analytics on does.
    expect(
      mergePreferenceUpdate(
        declined,
        { usageAnalyticsDeclinedAtOnboarding: false },
        context,
      ).usageAnalyticsDeclinedAtOnboarding,
    ).toBe(true);
    const optedIn = mergePreferenceUpdate(
      declined,
      { usageData: { ...declined.usageData, productAnalytics: true } },
      context,
    );
    expect(optedIn.usageAnalyticsDeclinedAtOnboarding).toBe(false);
    // Normalization drops a stored flag that analytics on contradicts.
    expect(
      normalizePreferences(
        { usageAnalyticsDeclinedAtOnboarding: true },
        'persisted',
      ).usageAnalyticsDeclinedAtOnboarding,
    ).toBe(false);
  });

  it('merges organization sharing notices per key and keeps an empty map', () => {
    const context = {
      loadError: null,
      migrationTimestamp: (): string => '2026-01-01T00:00:00.000Z',
    };
    const fresh = normalizePreferences(undefined, 'persisted');
    expect(fresh).not.toHaveProperty('orgSharingNoticesSeen');
    const seeded = mergePreferenceUpdate(
      fresh,
      { orgSharingNoticesSeen: {} },
      context,
    );
    expect(seeded.orgSharingNoticesSeen).toEqual({});
    expect(
      normalizePreferences({ orgSharingNoticesSeen: {} }, 'persisted')
        .orgSharingNoticesSeen,
    ).toEqual({});
    const first = mergePreferenceUpdate(
      seeded,
      { orgSharingNoticesSeen: { 'org-a': 'metadata' } },
      context,
    );
    // A stale window writing another organization keeps the first entry.
    const second = mergePreferenceUpdate(
      first,
      { orgSharingNoticesSeen: { 'org-b': 'plans,transcripts' } },
      context,
    );
    expect(second.orgSharingNoticesSeen).toEqual({
      'org-a': 'metadata',
      'org-b': 'plans,transcripts',
    });
    // An incoming key replaces that organization's signature.
    expect(
      mergePreferenceUpdate(
        second,
        { orgSharingNoticesSeen: { 'org-a': 'metadata,plans' } },
        context,
      ).orgSharingNoticesSeen,
    ).toEqual({ 'org-a': 'metadata,plans', 'org-b': 'plans,transcripts' });
    // An unrelated save keeps the map.
    expect(
      mergePreferenceUpdate(second, {}, context).orgSharingNoticesSeen,
    ).toEqual(second.orgSharingNoticesSeen);
  });

  describe('model facts of the core doing the normalizing', () => {
    const context = {
      loadError: null,
      migrationTimestamp: (): string => '2026-01-01T00:00:00.000Z',
    };
    const catalogFacts = (
      status: (model: string) => PreferencesModelStatus,
    ): PreferencesModelFacts =>
      createCatalogPreferencesModelFacts({
        status,
        ollamaEnabled: () => false,
        shortcutPlatform: () => 'darwin',
      });
    const install = (facts: PreferencesModelFacts): void => {
      NormalizationEnvironment.installPreferencesNormalizationEnvironment(
        facts,
      );
    };
    const offlineSonnet = (model: string): PreferencesModelStatus =>
      resolveKnownModel(model) === 'sonnet' || !resolveKnownModel(model)
        ? 'unavailable'
        : 'available';

    it('replaces an unavailable model in the runtime view and keeps it in the persisted view', () => {
      install(catalogFacts(offlineSonnet));
      const saved = {
        codeReviewModel: 'sonnet',
        localMemoryModel: 'sonnet',
        localMemoryModelSetByUser: true,
        summaryModel: 'sonnet',
        summaryModelSetByUser: true,
      };
      expect(normalizePreferences(saved, 'persisted')).toMatchObject(saved);
      expect(normalizePreferences(saved, 'runtime')).toMatchObject({
        codeReviewModel: DEFAULT_PREFERENCES.codeReviewModel,
        // Memory keeps an unavailable choice; its runs refuse it.
        localMemoryModel: 'sonnet',
        localMemoryModelSetByUser: true,
        summaryModelSetByUser: false,
      });
      // The catalog still registers it: availability is the facts' answer.
      expect(resolveKnownModel('sonnet')).toBe('sonnet');
    });

    it('refuses a changed handoff model the facts call unavailable', () => {
      install(catalogFacts(offlineSonnet));
      const existing = normalizePreferences(undefined, 'persisted');
      expect(() =>
        mergePreferenceUpdate(
          existing,
          { handoffSummaryModel: 'sonnet' },
          context,
        ),
      ).toThrow(
        new Error(
          'Choose an available conversation handoff model in Settings.',
        ),
      );
      expect(
        mergePreferenceUpdate(
          existing,
          { handoffSummaryModel: 'opus[1m]' },
          context,
        ).handoffSummaryModel,
      ).toBe('opus[1m]');
    });

    it('resolves the summary default to its fallback on a core without Codex', () => {
      initCodexModels([{ id: DEFAULT_SUMMARY_MODEL, label: 'Codex summary' }]);
      const runtimeSummary = (): string =>
        normalizePreferences(undefined, 'runtime').summaryModel;
      install(catalogFacts(() => 'available'));
      expect(runtimeSummary()).toBe(DEFAULT_SUMMARY_MODEL);
      install({
        ...catalogFacts(() => 'available'),
        resolveKnownModel: (model) => {
          const known = resolveKnownModel(model);
          return known && getProviderForModel(known) === 'codex'
            ? undefined
            : known;
        },
      });
      expect(runtimeSummary()).toBe(DEFAULT_SUMMARY_FALLBACK_MODEL);
      expect(normalizePreferences(undefined, 'persisted').summaryModel).toBe(
        DEFAULT_SUMMARY_MODEL,
      );
    });

    it('keeps a changed model key as sent when the facts answer unknown', () => {
      const sent = 'org-gateway/new-model';
      const patch = {
        codeReviewModel: sent,
        handoffSummaryModel: sent,
        summaryModel: sent,
      };
      install(catalogFacts(() => 'unknown'));
      const existing = normalizePreferences(undefined, 'persisted');
      expect(mergePreferenceUpdate(existing, patch, context)).toMatchObject({
        ...patch,
        summaryModelSetByUser: true,
      });
      // The same save against facts that call it unavailable, as today.
      install(catalogFacts(() => 'unavailable'));
      const withoutHandoff = {
        codeReviewModel: sent,
        summaryModel: sent,
      };
      expect(
        mergePreferenceUpdate(existing, withoutHandoff, context),
      ).toMatchObject({
        codeReviewModel: DEFAULT_PREFERENCES.codeReviewModel,
        summaryModelSetByUser: false,
      });
      expect(() => mergePreferenceUpdate(existing, patch, context)).toThrow(
        'Choose an available conversation handoff model in Settings.',
      );
    });

    it('asks the facts about the canonical id, and never keeps an id it cannot store', () => {
      const canonical = 'org-gateway/new-model';
      install({
        ...catalogFacts((model) =>
          model === canonical ? 'unknown' : 'unavailable',
        ),
        resolveModelAlias: (model) =>
          model === 'handoff-alias' ? canonical : model,
      });
      const existing = normalizePreferences(undefined, 'persisted');
      expect(
        mergePreferenceUpdate(
          existing,
          { handoffSummaryModel: 'handoff-alias' },
          context,
        ).handoffSummaryModel,
      ).toBe(canonical);
      install(catalogFacts(() => 'unknown'));
      expect(() =>
        mergePreferenceUpdate(
          existing,
          { handoffSummaryModel: ' padded ' },
          context,
        ),
      ).toThrow('Choose an available conversation handoff model in Settings.');
    });

    it('keeps a changed provider default as sent when the facts answer unknown', () => {
      const discovered = {
        model: 'ollama-discovered',
        thinkingLevel: 'high' as const,
      };
      const gatewayModel = 'org-gateway/new-model';
      install(catalogFacts(() => 'unknown'));
      const existing = normalizePreferences(undefined, 'persisted');
      const patch = {
        defaultChatModelByProvider: {
          ...existing.defaultChatModelByProvider,
          ollama: discovered,
        },
        defaultWorktreeModelByProvider: {
          ...existing.defaultWorktreeModelByProvider,
          claude: { model: gatewayModel, thinkingLevel: 'high' as const },
        },
      };
      const kept = mergePreferenceUpdate(existing, patch, context);
      expect(kept.defaultChatModelByProvider.ollama).toEqual(discovered);
      expect(kept.defaultWorktreeModelByProvider.claude.model).toBe(
        gatewayModel,
      );
      // The same save against facts that call them unavailable, as today.
      install(catalogFacts(() => 'unavailable'));
      const replaced = mergePreferenceUpdate(existing, patch, context);
      expect(replaced.defaultChatModelByProvider.ollama).toBeNull();
      expect(replaced.defaultWorktreeModelByProvider.claude).toEqual(
        existing.defaultWorktreeModelByProvider.claude,
      );
    });
  });
});
