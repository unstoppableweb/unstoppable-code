import type {
  CanopyErrorPayload,
  CatalogEntry,
} from '@canopy/protocol/canopy-core';
import type { RemoteControlChatTabPluginSelections } from '@canopy/protocol/remote-control/shell';
import { readCloudProjectCatalog } from '../cloud-chat-catalog';
import {
  readCloudProjectSandboxRoutes,
  readCloudProjectSettings,
  saveCloudProjectCoworkSettings,
  saveCloudProjectDefaultPlugins,
  saveCloudProjectInstructions,
} from '../cloud-project-settings';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
} from '../invoker';

// CAN-7053: a cloud project's instructions, default plugins, egress hosts
// and host settings, read and saved over the web core the way the web's
// settings dialog does (apps/web/src/components/chat/web-core-requests.ts).

const AT = '2026-11-17T12:00:00.000Z';
const stamp = { revision: 0, createdAt: AT, updatedAt: AT } as const;

const curatedSkill: CatalogEntry = {
  entryId: 'skill:cloud-curated/review',
  kind: 'skill',
  name: 'Review',
  description: '',
  source: 'remote',
  content: {
    kind: 'skill',
    entrypoint: null,
    selectionRef: { sourceId: 'cloud-curated', skillName: 'review' },
  },
  availability: 'available',
  ...stamp,
};

const teamSkill: CatalogEntry = {
  entryId: 'skill:team/notes',
  kind: 'skill',
  name: 'Notes',
  description: '',
  source: 'user',
  content: {
    kind: 'skill',
    entrypoint: null,
    selectionRef: { sourceId: 'team', skillName: 'notes' },
  },
  availability: 'available',
  ...stamp,
};

const invalidArgument: CanopyErrorPayload = {
  kind: 'invalid_argument',
  message: 'Unknown revision.',
  retry: { kind: 'never' },
};

type Handler = (
  params: Record<string, unknown>,
) => CanopyCoreRelayLikeReply | undefined;

class FakeWebCore implements CoreCoworkInvoker {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly handlers = new Map<string, Handler>();

  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<CanopyCoreRelayLikeReply> {
    this.calls.push({ method, params });
    const reply = this.handlers.get(method)?.(params);
    return Promise.resolve(
      reply ?? {
        ok: false,
        error: {
          kind: 'capability_unavailable',
          message: `${method} is not served.`,
          retry: { kind: 'never' },
        },
      },
    );
  }

  openStream(): never {
    throw new Error('Project settings open no stream.');
  }
}

// Jest's asymmetric matchers are typed `any`; held as `unknown` here.
const ANY_KEY: unknown = expect.any(String);

const SELECTIONS: RemoteControlChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'cloud-curated', skillName: 'review' }],
  pluginRefs: [{ marketplaceId: 'marketplace:a', pluginName: 'lint' }],
};

describe('cloud project settings over the web core (CAN-7053)', () => {
  it("reads the project's instructions, default plugins, their revision and the unusable ones from core.workspace.get revision 2", async () => {
    const core = new FakeWebCore();
    const unavailable = {
      ref: {
        kind: 'plugin',
        marketplaceId: 'marketplace:a',
        pluginName: 'lint',
        via: { kind: 'direct' },
      },
      reason: 'deleted',
      disposition: 'gone',
    };
    core.handlers.set('core.workspace.get', () => ({
      ok: true,
      value: {
        revision: 6,
        cloudSettings: {
          hostModeEnabled: true,
          hostPorts: [3000, 'x', 8080],
          egressAllowedHosts: ['api.example.com', 7],
          defaultAgentInstructions: 'Be brief.',
          defaultPluginSelections: {
            skillRefs: SELECTIONS.skillRefs,
            pluginRefs: SELECTIONS.pluginRefs,
          },
          defaultPluginSelectionsRevision: 4,
          defaultPluginSelectionsUnavailable: [unavailable, { bogus: true }],
        },
      },
    }));
    const settings = await readCloudProjectSettings(core, 'ws-1');
    expect(core.calls).toEqual([
      {
        method: 'core.workspace.get',
        params: { workspaceId: 'ws-1', revision: 2 },
      },
    ]);
    expect(settings.instructions).toBe('Be brief.');
    // The egress hosts and host settings, as stored; a malformed entry is
    // left out.
    expect(settings.hostModeEnabled).toBe(true);
    expect(settings.hostPorts).toEqual([3000, 8080]);
    expect(settings.egressAllowedHosts).toEqual(['api.example.com']);
    // The project revision of this read, which guards the dialog's save.
    expect(settings.revision).toBe(6);
    // Every list the picker reads is present, even one the store left out.
    expect(settings.defaultPluginSelections).toEqual(
      expect.objectContaining({
        collectionIds: [],
        skillRefs: SELECTIONS.skillRefs,
        pluginRefs: SELECTIONS.pluginRefs,
      }),
    );
    expect(settings.defaultPluginSelectionsRevision).toBe(4);
    // A malformed entry is left out rather than shown.
    expect(settings.unavailable).toEqual([unavailable]);

    // A project without either reads as empty, not as an error.
    core.handlers.set('core.workspace.get', () => ({
      ok: true,
      value: {
        cloudSettings: {
          defaultAgentInstructions: null,
          defaultPluginSelections: null,
        },
      },
    }));
    await expect(readCloudProjectSettings(core, 'ws-1')).resolves.toEqual({
      hostModeEnabled: false,
      hostPorts: [],
      egressAllowedHosts: [],
      instructions: '',
      description: '',
      defaultModelDefinitionId: null,
      deletionRetentionDays: undefined,
      defaultPluginSelections: null,
      defaultPluginSelectionsRevision: undefined,
      unavailable: [],
    });

    // Deprecated bundle ids read as collections.
    core.handlers.set('core.workspace.get', () => ({
      ok: true,
      value: {
        cloudSettings: {
          defaultAgentInstructions: '',
          defaultPluginSelections: {
            bundleIds: ['bundle-1'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      },
    }));
    expect(
      (await readCloudProjectSettings(core, 'ws-1')).defaultPluginSelections,
    ).toEqual({ collectionIds: ['bundle-1'], skillRefs: [], pluginRefs: [] });

    // Defaults it can't read are an error, never null: null reads as none,
    // and saving that would clear them.
    for (const defaultPluginSelections of [
      'not a record',
      { skillRefs: [{ sourceId: 'team' }], pluginRefs: [] },
    ]) {
      core.handlers.set('core.workspace.get', () => ({
        ok: true,
        value: {
          cloudSettings: {
            defaultAgentInstructions: '',
            defaultPluginSelections,
          },
        },
      }));
      await expect(
        readCloudProjectSettings(core, 'ws-1'),
      ).rejects.toBeInstanceOf(CoreCoworkRequestError);
    }

    // A web core that answers no cloud settings is an error, never a blank
    // form whose Save would clear them.
    core.handlers.set('core.workspace.get', () => ({
      ok: true,
      value: { workspaceId: 'ws-1' },
    }));
    await expect(readCloudProjectSettings(core, 'ws-1')).rejects.toBeInstanceOf(
      CoreCoworkRequestError,
    );
  });

  it("reads the project's description, default model and Trash retention from the same cloud settings", async () => {
    const core = new FakeWebCore();
    core.handlers.set('core.workspace.get', () => ({
      ok: true,
      value: {
        revision: 6,
        cloudSettings: {
          description: 'Notes for the team',
          defaultModelDefinitionId: 'model-a',
          deletionRetentionDays: 14,
          defaultAgentInstructions: null,
          defaultPluginSelections: null,
        },
      },
    }));
    const settings = await readCloudProjectSettings(core, 'ws-1');
    expect(core.calls).toHaveLength(1);
    expect(settings).toMatchObject({
      description: 'Notes for the team',
      defaultModelDefinitionId: 'model-a',
      deletionRetentionDays: 14,
    });

    // None stored, or a value of the wrong type, reads as none: no
    // description, the account's default model, and the web's default
    // retention, which the dialog fills in.
    core.handlers.set('core.workspace.get', () => ({
      ok: true,
      value: {
        cloudSettings: {
          description: 7,
          defaultModelDefinitionId: 9,
          deletionRetentionDays: 'forever',
          defaultAgentInstructions: null,
          defaultPluginSelections: null,
        },
      },
    }));
    expect(await readCloudProjectSettings(core, 'ws-1')).toMatchObject({
      description: '',
      defaultModelDefinitionId: null,
      deletionRetentionDays: undefined,
    });
  });

  it('saves the description, default model and Trash retention in one keyed core.workspace.cowork.update, at revision 2 only with the retention, guarded by the read revision', async () => {
    const core = new FakeWebCore();
    core.handlers.set('core.workspace.cowork.update', () => ({
      ok: true,
      value: { workspaceId: 'ws-1', warnings: ['Sync pending', 7] },
    }));
    await expect(
      saveCloudProjectCoworkSettings(
        core,
        'ws-1',
        { description: 'Notes', defaultModel: 'model-a' },
        6,
      ),
    ).resolves.toEqual(['Sync pending']);
    await saveCloudProjectCoworkSettings(
      core,
      'ws-1',
      { defaultModel: null, deletionRetentionDays: 30 },
      undefined,
    );
    const [described, retained] = core.calls;
    expect(described).toEqual({
      method: 'core.workspace.cowork.update',
      params: {
        workspaceId: 'ws-1',
        expectedRevision: 6,
        settings: { description: 'Notes', defaultModel: 'model-a' },
        _meta: { idempotencyKey: ANY_KEY },
      },
    });
    // The retention is revision 2's field; null clears the default model.
    expect(retained).toEqual({
      method: 'core.workspace.cowork.update',
      params: {
        workspaceId: 'ws-1',
        revision: 2,
        settings: { defaultModel: null, deletionRetentionDays: 30 },
        _meta: { idempotencyKey: ANY_KEY },
      },
    });
    expect(JSON.stringify(described?.params._meta)).not.toBe(
      JSON.stringify(retained?.params._meta),
    );

    // A refusal is the save's error.
    core.handlers.set('core.workspace.cowork.update', () => ({
      ok: false,
      error: {
        kind: 'invalid_argument',
        message: "This model isn't available.",
        retry: { kind: 'never' },
      },
    }));
    await expect(
      saveCloudProjectCoworkSettings(
        core,
        'ws-1',
        { defaultModel: 'model-b' },
        6,
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  });

  it('saves instructions as a whole overwrite at revision 2, and at revision 1 only when the web core rejects the revision', async () => {
    const core = new FakeWebCore();
    core.handlers.set('core.workspace.instructions.update', () => ({
      ok: true,
      value: { warnings: ['Sync pending', 7] },
    }));
    await expect(
      saveCloudProjectInstructions(core, 'ws-1', 'New text'),
    ).resolves.toEqual(['Sync pending']);
    expect(core.calls).toEqual([
      {
        method: 'core.workspace.instructions.update',
        params: { workspaceId: 'ws-1', content: 'New text', revision: 2 },
      },
    ]);

    core.calls.length = 0;
    core.handlers.set('core.workspace.instructions.update', (params) =>
      params.revision === undefined
        ? { ok: true, value: {} }
        : { ok: false, error: invalidArgument },
    );
    await expect(
      saveCloudProjectInstructions(core, 'ws-1', ''),
    ).resolves.toEqual([]);
    expect(core.calls.map((call) => call.params)).toEqual([
      { workspaceId: 'ws-1', content: '', revision: 2 },
      { workspaceId: 'ws-1', content: '' },
    ]);

    // Any other refusal is the save's error, with no second call.
    core.calls.length = 0;
    core.handlers.set('core.workspace.instructions.update', () => ({
      ok: false,
      error: {
        kind: 'permission_denied',
        message: 'Not yours.',
        retry: { kind: 'never' },
      },
    }));
    await expect(
      saveCloudProjectInstructions(core, 'ws-1', 'x'),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(core.calls).toHaveLength(1);
  });

  it('sets default plugins with setDefaults, guarded by the read revision and keyed, and clears them with null', async () => {
    const core = new FakeWebCore();
    core.handlers.set('core.workspace.plugins.update', () => ({
      ok: true,
      value: { warnings: [] },
    }));
    await saveCloudProjectDefaultPlugins(core, 'ws-1', SELECTIONS, 4);
    await saveCloudProjectDefaultPlugins(core, 'ws-1', null, undefined);
    const [guarded, cleared] = core.calls;
    expect(guarded?.params).toEqual({
      workspaceId: 'ws-1',
      change: {
        kind: 'setDefaults',
        defaultPluginSelections: SELECTIONS,
        expectedDefaultPluginSelectionsRevision: 4,
      },
      _meta: { idempotencyKey: ANY_KEY },
    });
    expect(cleared?.params).toEqual({
      workspaceId: 'ws-1',
      change: { kind: 'setDefaults', defaultPluginSelections: null },
      _meta: { idempotencyKey: ANY_KEY },
    });
    // Each save is its own command.
    const keyOf = (
      call: { params: Record<string, unknown> } | undefined,
    ): string => JSON.stringify(call?.params._meta);
    expect(keyOf(guarded)).not.toBe(keyOf(cleared));

    core.handlers.set('core.workspace.plugins.update', () => ({
      ok: false,
      error: {
        kind: 'failed_precondition',
        message: 'The defaults changed.',
        retry: { kind: 'never' },
      },
    }));
    await expect(
      saveCloudProjectDefaultPlugins(core, 'ws-1', SELECTIONS, 4),
    ).rejects.toMatchObject({ payload: { kind: 'failed_precondition' } });
  });

  it("offers the project's catalog as a chat's picker does, keeping a curated skill the defaults name", async () => {
    const core = new FakeWebCore();
    core.handlers.set('core.catalog.snapshot.get', () => ({
      ok: true,
      value: {
        revision: 1,
        entries: [curatedSkill, teamSkill],
        generatedAt: AT,
      },
    }));
    const named = (await readCloudProjectCatalog(core, 'ws-1', SELECTIONS))
      .plugins;
    expect(core.calls[0]?.method).toBe('core.catalog.snapshot.get');
    expect(core.calls[0]?.params).toMatchObject({
      scope: { workspaceId: 'ws-1' },
      includeUnavailable: true,
    });
    const names = (catalog: { skills: { skillName: string }[] }): string[] =>
      catalog.skills.map((skill) => skill.skillName).sort();
    expect(names(named)).toEqual(['notes', 'review']);
    // Without the defaults naming it, a curated skill is offered through its
    // plugin only, as in a chat's picker.
    expect(
      names((await readCloudProjectCatalog(core, 'ws-1', null)).plugins),
    ).toEqual(['notes']);
  });

  it("offers the project's default models as the web's settings dialog does, from the same snapshot read", async () => {
    const core = new FakeWebCore();
    const model = (
      id: string,
      libraryEligibility?: string,
    ): Record<string, unknown> => ({
      id,
      label: `Label ${id}`,
      provider: 'vendor',
      family: null,
      familyLabel: null,
      ...(libraryEligibility === undefined ? {} : { libraryEligibility }),
    });
    core.handlers.set('core.catalog.snapshot.get', () => ({
      ok: true,
      value: {
        revision: 1,
        entries: [teamSkill],
        generatedAt: AT,
        cloudModels: {
          models: [
            model('model-b', 'available'),
            model('model-a'),
            model('model-locked', 'locked'),
          ],
          modelHarnesses: {},
          defaultModelId: 'model-a',
          defaultModelBlocked: false,
        },
      },
    }));
    const catalog = await readCloudProjectCatalog(core, 'ws-1', null);
    // One read serves the plugins and the models.
    expect(core.calls).toHaveLength(1);
    expect(catalog.plugins.skills).toHaveLength(1);
    // Every hosted model in the catalog's order, a locked one listed but not
    // choosable, as the web's picker lists them.
    expect(catalog.models).toEqual([
      { id: 'model-b', label: 'Label model-b', disabled: false },
      { id: 'model-a', label: 'Label model-a', disabled: false },
      { id: 'model-locked', label: 'Label model-locked', disabled: true },
    ]);

    // A web core that answers no hosted catalog offers no models, so the
    // picker shows that they couldn't load, never an empty list to save.
    core.handlers.set('core.catalog.snapshot.get', () => ({
      ok: true,
      value: { revision: 1, entries: [teamSkill], generatedAt: AT },
    }));
    expect((await readCloudProjectCatalog(core, 'ws-1', null)).models).toBe(
      null,
    );
  });

  it('retries the catalog read at the model-catalog revision only when the web core rejects the compatibility one', async () => {
    const core = new FakeWebCore();
    core.handlers.set('core.catalog.snapshot.get', (params) =>
      params.revision === 5
        ? { ok: false, error: invalidArgument }
        : {
            ok: true,
            value: { revision: 1, entries: [teamSkill], generatedAt: AT },
          },
    );
    const catalog = (await readCloudProjectCatalog(core, 'ws-1', null)).plugins;
    expect(catalog.skills).toHaveLength(1);
    expect(core.calls).toHaveLength(2);
    expect(core.calls[0]?.params.revision).not.toBe(
      core.calls[1]?.params.revision,
    );
  });

  it("reads a project's live sandbox routes as the web's Host tab does, and refuses an answer that isn't one", async () => {
    const core = new FakeWebCore();
    core.handlers.set('core.workspace.sandboxRoutes.get', () => ({
      ok: true,
      value: {
        hostModeEnabled: true,
        sandboxStatus: 'running',
        declaredPorts: [3000],
        routes: [{ port: 3000, url: 'https://p3000.example.dev/' }],
        expiresAt: AT,
      },
    }));
    await expect(readCloudProjectSandboxRoutes(core, 'ws-1')).resolves.toEqual({
      hostModeEnabled: true,
      declaredPorts: [3000],
      routes: [{ port: 3000, url: 'https://p3000.example.dev/' }],
      expiresAtMs: Date.parse(AT),
      warnings: [],
    });
    expect(core.calls).toEqual([
      {
        method: 'core.workspace.sandboxRoutes.get',
        params: { workspaceId: 'ws-1' },
      },
    ]);

    core.handlers.set('core.workspace.sandboxRoutes.get', () => ({
      ok: true,
      value: { routes: 'not a list' },
    }));
    await expect(
      readCloudProjectSandboxRoutes(core, 'ws-1'),
    ).rejects.toBeDefined();
  });
});
