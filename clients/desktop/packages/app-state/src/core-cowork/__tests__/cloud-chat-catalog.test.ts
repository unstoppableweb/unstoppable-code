import type { RemoteControlChatTabPluginSelections } from '@canopy/protocol/remote-control/shell';
import type {
  CanopyErrorPayload,
  CatalogCloudModels,
  CatalogEntry,
} from '@canopy/protocol/canopy-core';
import {
  CATALOG_CHANGE_UNKNOWN,
  cloudChatPickerModels,
  createCloudChatCatalog,
} from '../cloud-chat-catalog';
import { CoreCoworkOutcomeUnknownError } from '../unknown-outcome';
import type { CanopyCoreRelayLikeReply, CoreCoworkInvoker } from '../invoker';

// A fake web core serving the catalog reads and `core.chat.update` the way
// apps/web/src/lib/web-core/catalogs and chat.ts do (CAN-4161, CAN-4156).

const SCOPE = {
  workspaceId: 'workspace-1',
  worktreeId: 'task-1',
  chatId: 'chat-1',
};
const AT = '2026-11-07T12:00:00.000Z';

const stamp = { revision: 0, createdAt: AT, updatedAt: AT } as const;

const entries: CatalogEntry[] = [
  {
    entryId: 'model:claude-opus',
    kind: 'model',
    name: 'Claude Opus',
    description: '',
    source: 'remote',
    content: {
      kind: 'model',
      providerId: 'claude',
      modelName: 'claude-opus',
      contextWindow: 200_000,
      capabilities: [],
      harness: 'claude',
    },
    availability: 'available',
    ...stamp,
  },
  {
    entryId: 'skill:curated/review',
    kind: 'skill',
    name: 'Review',
    description: 'Reviews a change',
    source: 'remote',
    content: {
      kind: 'skill',
      entrypoint: null,
      selectionRef: { sourceId: 'curated', skillName: 'review' },
    },
    availability: 'available',
    ...stamp,
  },
  {
    // A source id holding '/': only its ref names it correctly.
    entryId: 'skill:team/a/notes',
    kind: 'skill',
    name: 'Notes',
    description: '',
    source: 'user',
    content: {
      kind: 'skill',
      entrypoint: null,
      selectionRef: { sourceId: 'team/a', skillName: 'notes' },
    },
    availability: 'available',
    ...stamp,
  },
  {
    entryId: 'skill:legacy/old',
    kind: 'skill',
    name: 'Without a ref',
    description: '',
    source: 'remote',
    content: { kind: 'skill', entrypoint: null },
    availability: 'available',
    ...stamp,
  },
];

class FakeWebCore implements CoreCoworkInvoker {
  entries: CatalogEntry[] = entries;
  /**
   * The hosted catalog the web core answers at revision 2 when models are
   * asked for (CAN-6093), as `GET /api/cloud/models` sends it.
   */
  cloudModels: Record<string, unknown> | undefined = undefined;
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  selectionRevision = 7;
  selectedItemIds: string[] = ['skill:curated/review'];
  updateRefusal: CanopyErrorPayload | null = null;
  /** The chat's model as its snapshot reads it. */
  modelId = 'claude-opus';
  /**
   * The next update loses its reply (CAN-7196): as a same-key retry, or as
   * S7c's unavailable and never retried, applied or not.
   */
  lostUpdate: {
    retry: 'same_idempotency_key' | 'never';
    applies: boolean;
  } | null = null;
  /** What a pluginSelections save answers beside its receipt (CAN-6092). */
  updateCapabilities: unknown = undefined;

  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<CanopyCoreRelayLikeReply> {
    this.calls.push({ method, params });
    switch (method) {
      case 'core.catalog.snapshot.get': {
        const kinds = Array.isArray(params.kinds) ? params.kinds : [];
        const answersCloudModels =
          this.cloudModels !== undefined &&
          params.revision !== undefined &&
          (kinds.length === 0 || kinds.includes('model'));
        return Promise.resolve({
          ok: true,
          value: {
            revision: 1,
            entries: this.entries,
            generatedAt: AT,
            ...(answersCloudModels ? { cloudModels: this.cloudModels } : {}),
          },
        });
      }
      case 'core.catalog.selection.get':
        return Promise.resolve({
          ok: true,
          value: {
            revision: this.selectionRevision,
            selectedItemIds: this.selectedItemIds,
            unavailableItemIds: [],
          },
        });
      case 'core.chat.snapshot.get':
        return Promise.resolve({
          ok: true,
          value: {
            workspaceId: SCOPE.workspaceId,
            worktreeId: SCOPE.worktreeId,
            revision: 3,
            tabs: {
              activeTabId: SCOPE.chatId,
              items: [
                {
                  chatId: SCOPE.chatId,
                  title: 'Chat',
                  kind: 'chat',
                  createdAt: AT,
                  modelId: this.modelId,
                },
              ],
            },
            archives: [],
            runtimeByChatId: {},
            queue: [],
          },
        });
      case 'core.chat.update': {
        const lost = this.lostUpdate;
        if (lost !== null) {
          this.lostUpdate = null;
          const action = Object(params.action) as Record<string, unknown>;
          if (lost.applies && action.type === 'chat.set_model')
            this.modelId = String(action.model);
          if (lost.applies && action.type === 'chat.patch_tab_settings') {
            const patch = Object(action.patch) as Record<string, unknown>;
            const saved = Object(patch.pluginSelections) as {
              skillRefs?: { sourceId: string; skillName: string }[];
            };
            this.selectedItemIds = (saved.skillRefs ?? []).map(
              (ref) => `skill:${ref.sourceId}/${ref.skillName}`,
            );
          }
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'unavailable',
              message: 'The reply was lost.',
              retry: { kind: lost.retry },
            },
          });
        }
        if (this.updateRefusal !== null) {
          const error = this.updateRefusal;
          this.updateRefusal = null;
          return Promise.resolve({ ok: false, error });
        }
        return Promise.resolve({
          ok: true,
          value: {
            commandId: String(params.commandId),
            revision: 0,
            outcome: 'applied',
            entityId: SCOPE.chatId,
            ...(this.updateCapabilities === undefined
              ? {}
              : { capabilities: this.updateCapabilities }),
          },
        });
      }
      default:
        return Promise.resolve({
          ok: false,
          error: {
            kind: 'capability_unavailable',
            message: `${method} is not served.`,
            retry: { kind: 'never' },
          },
        });
    }
  }

  openStream(): never {
    throw new Error('The catalog opens no stream.');
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

describe('cloud chat catalog over the web core (CAN-5972)', () => {
  it("accepts a save's capability state beyond the 32 KiB JSON detail bound (CAN-6092)", async () => {
    const core = new FakeWebCore();
    const catalog = createCloudChatCatalog(core, SCOPE);
    await catalog.refresh();
    const pruned = Array.from({ length: 400 }, (_, index) => ({
      kind: 'plugin',
      marketplaceId: `marketplace-${index}`,
      pluginName: `a-plugin-with-a-long-name-${index}`,
    }));
    expect(JSON.stringify(pruned).length).toBeGreaterThan(32_768);
    core.updateCapabilities = {
      capabilityBundles: {},
      capabilityBundleStateVersion: 3,
      outcome: 'staged',
      capabilityPruned: pruned,
      warnings: [],
    };
    await expect(
      catalog.setSelections({
        collectionIds: [],
        skillRefs: [{ sourceId: 'curated', skillName: 'review' }],
        pluginRefs: [],
        mcpServerRefs: [],
      }),
    ).resolves.toBeUndefined();
    expect(catalog.store.getState().selectionConflict).toBe(false);
  });

  it('a capability selection writes through core.chat.update and re-reads on conflict', async () => {
    const core = new FakeWebCore();
    const logDev = jest.fn<void, [string]>();
    const catalog = createCloudChatCatalog(core, SCOPE, { logDev });
    await catalog.refresh();

    const state = catalog.store.getState();
    expect(state.selectionRevision).toBe(7);
    expect(state.selections.skillRefs).toEqual([
      { sourceId: 'curated', skillName: 'review' },
    ]);
    expect(state.plugins?.skills.map((skill) => skill.sourceId)).toEqual([
      'curated',
      'team/a',
    ]);
    expect(logDev).toHaveBeenCalledTimes(1);
    expect(logDev.mock.calls[0]?.[0]).toContain('1 catalog entries');

    core.updateRefusal = {
      kind: 'conflict',
      message: 'The chat changed.',
      code: 'core.chat.revisionConflict',
      retry: { kind: 'after_refresh', resource: 'core.chat.snapshot' },
    };
    core.selectionRevision = 8;
    core.selectedItemIds = ['skill:team/a/notes'];
    core.calls.length = 0;
    await catalog.setSelections({
      collectionIds: [],
      skillRefs: [
        { sourceId: 'curated', skillName: 'review' },
        { sourceId: 'team/a', skillName: 'notes' },
      ],
      pluginRefs: [],
      mcpServerRefs: [],
    });

    const update = core.calls[0];
    expect(update?.method).toBe('core.chat.update');
    expect(update?.params).not.toHaveProperty('expectedRevision');
    expect(update?.params).toMatchObject({
      projectId: SCOPE.workspaceId,
      worktreeId: SCOPE.worktreeId,
      action: {
        type: 'chat.patch_tab_settings',
        tabId: SCOPE.chatId,
        patch: {
          pluginSelections: {
            skillRefs: [
              { sourceId: 'curated', skillName: 'review' },
              { sourceId: 'team/a', skillName: 'notes' },
            ],
          },
        },
      },
    });
    expect(core.methods()).not.toContain('core.catalog.selection.update');
    expect(core.methods().slice(1).sort()).toEqual([
      'core.catalog.selection.get',
      'core.catalog.snapshot.get',
      'core.chat.snapshot.get',
    ]);
    const after = catalog.store.getState();
    expect(after.selectionConflict).toBe(true);
    expect(after.selectionRevision).toBe(8);
    expect(after.selections.skillRefs).toEqual([
      { sourceId: 'team/a', skillName: 'notes' },
    ]);
  });

  it('model choice calls chat.set_model on the web core only', async () => {
    const core = new FakeWebCore();
    const catalog = createCloudChatCatalog(core, SCOPE);
    await catalog.refresh();
    expect(catalog.store.getState().currentModel).toBe('claude-opus');
    expect(catalog.store.getState().models).toEqual([
      expect.objectContaining({
        id: 'claude-opus',
        label: 'Claude Opus',
        provider: 'claude',
        kind: 'model',
      }),
    ]);
    core.calls.length = 0;

    await catalog.setModel('claude-sonnet');

    expect(core.methods()).toEqual(['core.chat.update']);
    expect(core.calls[0]?.params).toMatchObject({
      projectId: SCOPE.workspaceId,
      worktreeId: SCOPE.worktreeId,
      action: {
        type: 'chat.set_model',
        tabId: SCOPE.chatId,
        model: 'claude-sonnet',
        providerType: 'claude',
      },
    });
    expect(catalog.store.getState().currentModel).toBe('claude-sonnet');

    core.updateRefusal = {
      kind: 'invalid_argument',
      message: 'That model is not available.',
      retry: { kind: 'never' },
    };
    await expect(catalog.setModel('other')).rejects.toThrow(
      'That model is not available.',
    );
    expect(catalog.store.getState().currentModel).toBe('claude-sonnet');
  });

  it.each(['never', 'same_idempotency_key'] as const)(
    'a model or selection change whose answer never came, with retry %s, is sent once and shows what the chat reads, never rolled back (CAN-7196)',
    async (retry) => {
      const core = new FakeWebCore();
      const catalog = createCloudChatCatalog(core, SCOPE);
      await catalog.refresh();
      const updates = (): number =>
        core.methods().filter((method) => method === 'core.chat.update').length;

      // It landed: the chat reads the new model, so it stays.
      core.lostUpdate = { retry, applies: true };
      const landed = catalog.setModel('claude-sonnet');
      await expect(landed).rejects.toBeInstanceOf(
        CoreCoworkOutcomeUnknownError,
      );
      await expect(landed).rejects.toThrow(CATALOG_CHANGE_UNKNOWN);
      expect(updates()).toBe(1);
      expect(catalog.store.getState().currentModel).toBe('claude-sonnet');

      // It never landed: the chat reads the model it kept.
      core.lostUpdate = { retry, applies: false };
      await expect(catalog.setModel('other')).rejects.toBeInstanceOf(
        CoreCoworkOutcomeUnknownError,
      );
      expect(updates()).toBe(2);
      expect(catalog.store.getState().currentModel).toBe('claude-sonnet');

      // A selection that landed shows as the chat reads it.
      core.lostUpdate = { retry, applies: true };
      await expect(
        catalog.setSelections({
          collectionIds: [],
          skillRefs: [{ sourceId: 'team/a', skillName: 'notes' }],
          pluginRefs: [],
          mcpServerRefs: [],
        }),
      ).rejects.toThrow(CATALOG_CHANGE_UNKNOWN);
      expect(updates()).toBe(3);
      expect(catalog.store.getState().selections.skillRefs).toEqual([
        { sourceId: 'team/a', skillName: 'notes' },
      ]);
      expect(catalog.store.getState().selectionConflict).toBe(false);
    },
  );

  it('offers only entries the web core will run and keeps the refs of the rest', async () => {
    const core = new FakeWebCore();
    core.entries = [
      ...entries,
      {
        entryId: 'model:claude-fable',
        kind: 'model',
        name: 'Claude Fable',
        description: '',
        source: 'remote',
        content: {
          kind: 'model',
          providerId: 'claude',
          modelName: 'claude-fable',
          contextWindow: null,
          capabilities: [],
        },
        // Locked behind AI Credits; the cloud composer has no unlock flow.
        availability: 'disabled',
        ...stamp,
      },
      {
        entryId: 'plugin:market/blocked',
        kind: 'plugin',
        name: 'Blocked',
        description: '',
        source: 'remote',
        content: {
          kind: 'plugin',
          manifest: {
            name: 'blocked',
            version: '',
            capabilities: [],
            dependencies: [],
          },
          selectionRef: { marketplaceId: 'market', pluginName: 'blocked' },
        },
        availability: 'incompatible',
        ...stamp,
      },
      {
        entryId: 'mcp_server:linear/default',
        kind: 'mcp_server',
        name: 'Linear',
        description: '',
        source: 'remote',
        content: {
          kind: 'mcp_server',
          transport: 'http',
          commandRef: null,
          url: null,
          authIntegrationId: null,
          connectionState: 'not_connected',
          selectionRef: { serverId: 'linear', configId: 'default' },
        },
        availability: 'auth_required',
        ...stamp,
      },
    ];
    core.selectedItemIds = ['plugin:market/blocked'];
    const catalog = createCloudChatCatalog(core, SCOPE);
    await catalog.refresh();

    const state = catalog.store.getState();
    expect(state.models.map((model) => model.id)).toEqual(['claude-opus']);
    expect(state.plugins?.plugins).toEqual([]);
    expect(state.plugins?.mcpServers).toEqual([]);
    expect(state.selections.pluginRefs).toEqual([
      { marketplaceId: 'market', pluginName: 'blocked' },
    ]);

    core.calls.length = 0;
    await catalog.setSelections({
      ...state.selections,
      skillRefs: [{ sourceId: 'curated', skillName: 'review' }],
    });
    expect(core.calls[0]?.params).toMatchObject({
      action: {
        patch: {
          pluginSelections: {
            pluginRefs: [{ marketplaceId: 'market', pluginName: 'blocked' }],
          },
        },
      },
    });
  });

  it("lists the hosted catalog's models as the web's picker does, by vendor and family, and leaves locked ones out (CAN-6753)", async () => {
    const core = new FakeWebCore();
    const modelEntry = (
      id: string,
      providerId: string,
      availability: CatalogEntry['availability'],
    ): CatalogEntry => ({
      entryId: `model:${id}`,
      kind: 'model',
      name: id,
      description: '',
      source: 'remote',
      content: {
        kind: 'model',
        providerId,
        modelName: id,
        contextWindow: null,
        capabilities: [],
      },
      availability,
      ...stamp,
    });
    // The web core lists Core's provider key, a model vendor, on each entry,
    // and the hosted catalog itself as `cloudModels` at revision 2.
    core.entries = [
      modelEntry('vendor-b-model', 'openai', 'available'),
      modelEntry('vendor-a-model', 'anthropic', 'available'),
      modelEntry('vendor-a-locked', 'anthropic', 'disabled'),
      ...entries.filter((entry) => entry.kind !== 'model'),
    ];
    core.cloudModels = {
      models: [
        {
          id: 'vendor-b-model',
          label: 'Vendor B model',
          description: 'An older model',
          provider: 'openai',
          family: 'family-b',
          familyLabel: 'Family B',
          harness: 'codex',
          showMoreOnly: true,
          contextWindow: 400_000,
          thinkingLevels: ['low', 'high', 'ultra'],
          fastGatewayId: null,
          fastModeSupported: true,
          libraryEligibility: 'available',
        },
        {
          id: 'vendor-a-model',
          label: 'Vendor A model',
          provider: 'anthropic',
          family: 'family-a',
          familyLabel: null,
          harness: 'claude',
          contextWindow: 200_000,
          libraryEligibility: 'available',
        },
        {
          id: 'vendor-a-locked',
          label: 'Vendor A locked',
          provider: 'anthropic',
          family: 'family-a',
          familyLabel: 'Family A',
          harness: 'claude',
          libraryEligibility: 'locked',
        },
      ],
      modelHarnesses: {
        'vendor-b-model': 'codex',
        'vendor-a-model': 'claude',
        'vendor-a-locked': 'claude',
      },
      defaultModelId: 'vendor-a-model',
      defaultModelBlocked: false,
      modelLibrary: 'unlocked',
    };
    const catalog = createCloudChatCatalog(core, SCOPE);
    await catalog.refresh();

    // The web's projection of the same rows: the harness as the provider,
    // Core's provider as the vendor, Core's family, the AI Credits source,
    // the Legacy flag and the owner's default. A locked model stays out,
    // since this composer has no unlock flow.
    expect(catalog.store.getState().models).toEqual([
      {
        id: 'vendor-b-model',
        label: 'Vendor B model',
        description: 'An older model',
        showMoreOnly: true,
        contextWindow: 400_000,
        provider: 'codex',
        source: 'ai-gateway',
        harness: 'codex',
        supportsFastMode: true,
        kind: 'model',
        available: true,
        family: 'family-b',
        familyLabel: 'Family B',
        vendor: 'openai',
        supportedThinkingLevels: ['low', 'high'],
        libraryEligibility: 'available',
      },
      {
        id: 'vendor-a-model',
        label: 'Vendor A model',
        contextWindow: 200_000,
        provider: 'claude',
        source: 'ai-gateway',
        harness: 'claude',
        supportsFastMode: false,
        kind: 'model',
        available: true,
        family: 'family-a',
        familyLabel: 'family-a',
        vendor: 'anthropic',
        isDefault: true,
        libraryEligibility: 'available',
      },
    ]);
    // Revision 5 adds compatibility to the hosted model catalog (CAN-6807).
    expect(
      core.calls.find((call) => call.method === 'core.catalog.snapshot.get')
        ?.params,
    ).toMatchObject({ revision: 5 });
  });

  it("lists the owner's locked models for the picker, in catalog order, only when the library names how to unlock them (CAN-6937)", () => {
    const hosted = (
      modelLibrary: 'unlocked' | 'needs_purchase' | undefined,
      lockedToo = true,
    ): CatalogCloudModels => ({
      models: [
        {
          id: 'vendor-a-model',
          label: 'Vendor A model',
          provider: 'anthropic',
          family: 'family-a',
          familyLabel: 'Family A',
          harness: 'claude',
          libraryEligibility: 'available',
        },
        ...(lockedToo
          ? [
              {
                id: 'vendor-a-locked',
                label: 'Vendor A locked',
                provider: 'anthropic',
                family: 'family-a',
                familyLabel: 'Family A',
                harness: 'claude',
                libraryEligibility: 'locked',
              },
            ]
          : []),
      ],
      modelHarnesses: {
        'vendor-a-model': 'claude',
        'vendor-a-locked': 'claude',
      },
      defaultModelId: 'vendor-a-model',
      defaultModelBlocked: false,
      ...(modelLibrary === undefined ? {} : { modelLibrary }),
    });

    const listed = cloudChatPickerModels(hosted('needs_purchase'));
    expect(listed?.access).toBe('needs_purchase');
    expect(
      listed?.models.map((model) => [model.id, model.libraryEligibility]),
    ).toEqual([
      ['vendor-a-model', 'available'],
      ['vendor-a-locked', 'locked'],
    ]);
    // An unlocked library, none named, or nothing locked: nothing to unlock.
    expect(cloudChatPickerModels(hosted('unlocked'))).toBeNull();
    expect(cloudChatPickerModels(hosted(undefined))).toBeNull();
    expect(cloudChatPickerModels(hosted('needs_purchase', false))).toBeNull();
    expect(cloudChatPickerModels(undefined)).toBeNull();
  });

  it("names each row's source as the web core labels it and lists a curated skill once, through its plugin (CAN-6397)", async () => {
    const MARKETPLACE = 'marketplace:5f0c6c1e-6a2a-4d4f-9c55-3a8a2b7f0e11';
    const curatedSkill = (skillName: string, name: string): CatalogEntry => ({
      entryId: `skill:cloud-curated/${skillName}`,
      kind: 'skill',
      name,
      description: '',
      sourceLabel: 'Curated',
      source: 'remote',
      content: {
        kind: 'skill',
        entrypoint: null,
        selectionRef: { sourceId: 'cloud-curated', skillName },
      },
      availability: 'available',
      ...stamp,
    });
    const plugin = (
      marketplaceId: string,
      pluginName: string,
      name: string,
      sourceLabel: string,
    ): CatalogEntry => ({
      entryId: `plugin:${marketplaceId}/${pluginName}`,
      kind: 'plugin',
      name,
      description: '',
      sourceLabel,
      source: 'remote',
      content: {
        kind: 'plugin',
        manifest: {
          name: pluginName,
          version: '',
          capabilities: [],
          dependencies: [],
          providerSupport: { claude: true, codex: true },
        },
        selectionRef: { marketplaceId, pluginName },
      },
      availability: 'available',
      ...stamp,
    });
    const core = new FakeWebCore();
    // As apps/web/src/lib/web-core/catalogs/entries.ts serves them: curated
    // skills also stand alone, beside the curated plugin they belong to.
    core.entries = [
      curatedSkill('release-notes', 'Release notes'),
      curatedSkill('changelog', 'Changelog'),
      plugin('cloud-curated', 'release-notes', 'Release notes', 'Curated'),
      plugin(MARKETPLACE, 'lint-rules', 'Lint rules', 'Acme'),
    ];
    // Changelog was picked on its own, so its row stays.
    core.selectedItemIds = ['skill:cloud-curated/changelog'];
    const catalog = createCloudChatCatalog(core, SCOPE);
    await catalog.refresh();

    const plugins = catalog.store.getState().plugins;
    const sources = [
      ...(plugins?.skills ?? []).map((skill) => skill.source),
      ...(plugins?.plugins ?? []).map((row) => row.marketplaceName),
    ];
    expect(sources.length).toBeGreaterThan(0);
    expect({
      // No Source cell shows a raw marketplace or curated id.
      rawSources: sources.filter((source) =>
        /marketplace:|cloud-curated/.test(source),
      ),
      plugins: plugins?.plugins.map((row) => [row.name, row.marketplaceName]),
      // Release notes is listed once, as its plugin; Changelog stays
      // because it is selected individually.
      skills: plugins?.skills.map((skill) => [skill.name, skill.source]),
    }).toEqual({
      rawSources: [],
      plugins: [
        ['Release notes', 'Curated'],
        ['Lint rules', 'Acme'],
      ],
      skills: [['Changelog', 'Curated']],
    });

    // The unlisted skill keeps its ref: saving it never drops it.
    core.calls.length = 0;
    const releaseNotes = {
      sourceId: 'cloud-curated',
      skillName: 'release-notes',
    };
    await catalog.setSelections({
      collectionIds: [],
      skillRefs: [releaseNotes],
      pluginRefs: [],
      mcpServerRefs: [],
    });
    expect(core.calls[0]?.params).toMatchObject({
      action: {
        patch: { pluginSelections: { skillRefs: [releaseNotes] } },
      },
    });
  });

  it('a stale model failure never rolls back a newer choice', async () => {
    const pending: ((reply: CanopyCoreRelayLikeReply) => void)[] = [];
    class GatedWebCore extends FakeWebCore {
      override request(
        method: string,
        params: Record<string, unknown>,
      ): Promise<CanopyCoreRelayLikeReply> {
        if (method !== 'core.chat.update') return super.request(method, params);
        this.calls.push({ method, params });
        return new Promise((resolve) => pending.push(resolve));
      }
    }
    const refused: CanopyCoreRelayLikeReply = {
      ok: false,
      error: {
        kind: 'invalid_argument',
        message: 'Refused.',
        retry: { kind: 'never' },
      },
    };
    const applied: CanopyCoreRelayLikeReply = {
      ok: true,
      value: {
        commandId: 'c',
        revision: 0,
        outcome: 'applied',
        entityId: SCOPE.chatId,
      },
    };
    const flush = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    };
    const core = new GatedWebCore();
    const catalog = createCloudChatCatalog(core, SCOPE);
    await catalog.refresh();
    expect(catalog.store.getState().currentModel).toBe('claude-opus');

    // A then B: B waits for A, so the web core applies them in order.
    const first = catalog.setModel('model-a').catch((error: unknown) => error);
    const second = catalog.setModel('model-b');
    await flush();
    expect(pending).toHaveLength(1);
    expect(catalog.store.getState().currentModel).toBe('model-b');

    pending[0]?.(refused);
    await first;
    await flush();
    // A's failure is stale: the display keeps B.
    expect(catalog.store.getState().currentModel).toBe('model-b');
    expect(pending).toHaveLength(2);
    pending[1]?.(applied);
    await second;
    expect(catalog.store.getState().currentModel).toBe('model-b');

    // The latest choice failing goes back to the last saved model.
    const third = catalog.setModel('model-c').catch((error: unknown) => error);
    await flush();
    pending[2]?.(refused);
    await third;
    expect(catalog.store.getState().currentModel).toBe('model-b');
  });

  it('a refresh that overlaps a model save never applies its stale model', async () => {
    const updates: ((reply: CanopyCoreRelayLikeReply) => void)[] = [];
    const snapshots: (() => void)[] = [];
    let gateSnapshots = false;
    class GatedWebCore extends FakeWebCore {
      override request(
        method: string,
        params: Record<string, unknown>,
      ): Promise<CanopyCoreRelayLikeReply> {
        if (method === 'core.chat.update') {
          this.calls.push({ method, params });
          return new Promise((resolve) => updates.push(resolve));
        }
        if (method === 'core.chat.snapshot.get' && gateSnapshots) {
          const reply = super.request(method, params);
          return new Promise((resolve) =>
            snapshots.push(() => void reply.then(resolve)),
          );
        }
        return super.request(method, params);
      }
    }
    const flush = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    };
    const core = new GatedWebCore();
    const catalog = createCloudChatCatalog(core, SCOPE);
    await catalog.refresh();

    const save = catalog.setModel('model-b');
    await flush();
    gateSnapshots = true;
    // This read sees the chat before the save lands: model claude-opus.
    const read = catalog.refresh();
    await flush();
    updates[0]?.({
      ok: true,
      value: {
        commandId: 'c',
        revision: 0,
        outcome: 'applied',
        entityId: SCOPE.chatId,
      },
    });
    await save;
    snapshots[0]?.();
    await read;

    expect(catalog.store.getState().currentModel).toBe('model-b');
  });

  it('capability saves apply in order and the newest choice wins', async () => {
    const updates: ((reply: CanopyCoreRelayLikeReply) => void)[] = [];
    class GatedWebCore extends FakeWebCore {
      override request(
        method: string,
        params: Record<string, unknown>,
      ): Promise<CanopyCoreRelayLikeReply> {
        if (method !== 'core.chat.update') return super.request(method, params);
        this.calls.push({ method, params });
        return new Promise((resolve) => updates.push(resolve));
      }
    }
    const applied: CanopyCoreRelayLikeReply = {
      ok: true,
      value: {
        commandId: 'c',
        revision: 0,
        outcome: 'applied',
        entityId: SCOPE.chatId,
      },
    };
    const flush = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    };
    const core = new GatedWebCore();
    const catalog = createCloudChatCatalog(core, SCOPE);
    await catalog.refresh();
    const review = { sourceId: 'curated', skillName: 'review' };
    const notes = { sourceId: 'team/a', skillName: 'notes' };
    const selection = (
      skillRefs: { sourceId: string; skillName: string }[],
    ): RemoteControlChatTabPluginSelections => ({
      collectionIds: [],
      skillRefs,
      pluginRefs: [],
      mcpServerRefs: [],
    });
    const skillsSent = (): unknown[] =>
      core.calls
        .filter((call) => call.method === 'core.chat.update')
        .map((call) => call.params.action);

    const first = catalog.setSelections(selection([review]));
    await flush();
    const second = catalog.setSelections(selection([notes]));
    const third = catalog.setSelections(selection([]));
    await flush();
    // One write at a time: the second and third wait for the first.
    expect(updates).toHaveLength(1);
    updates[0]?.(applied);
    await first;
    await second;
    await flush();
    // The second was superseded while it waited, so it is never sent.
    expect(updates).toHaveLength(2);
    updates[1]?.(applied);
    await third;

    const sent = skillsSent();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      patch: { pluginSelections: { skillRefs: [review] } },
    });
    expect(sent[1]).toMatchObject({
      patch: { pluginSelections: { skillRefs: [] } },
    });
  });
});
