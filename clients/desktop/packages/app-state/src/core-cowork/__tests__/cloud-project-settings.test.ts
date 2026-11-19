import type {
  CanopyErrorPayload,
  CatalogEntry,
} from '@canopy/protocol/canopy-core';
import type { PortalChatTabPluginSelections } from '@canopy/protocol/portal';
import { readCloudProjectPluginCatalog } from '../cloud-chat-catalog';
import {
  readCloudProjectSandboxRoutes,
  readCloudProjectSettings,
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

const SELECTIONS: PortalChatTabPluginSelections = {
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
    const named = await readCloudProjectPluginCatalog(core, 'ws-1', SELECTIONS);
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
      names(await readCloudProjectPluginCatalog(core, 'ws-1', null)),
    ).toEqual(['notes']);
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
    const catalog = await readCloudProjectPluginCatalog(core, 'ws-1', null);
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
