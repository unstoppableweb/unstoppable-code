import type { PortalChatTabPluginSelections } from '@canopy/protocol/portal';
import type {
  CanopyErrorPayload,
  CatalogEntry,
} from '@canopy/protocol/canopy-core';
import { createCloudChatCatalog } from '../cloud-chat-catalog';
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
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  selectionRevision = 7;
  selectedItemIds: string[] = ['skill:curated/review'];
  updateRefusal: CanopyErrorPayload | null = null;

  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<CanopyCoreRelayLikeReply> {
    this.calls.push({ method, params });
    switch (method) {
      case 'core.catalog.snapshot.get':
        return Promise.resolve({
          ok: true,
          value: { revision: 1, entries: this.entries, generatedAt: AT },
        });
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
                  modelId: 'claude-opus',
                },
              ],
            },
            archives: [],
            runtimeByChatId: {},
            queue: [],
          },
        });
      case 'core.chat.update': {
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
    ): PortalChatTabPluginSelections => ({
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
