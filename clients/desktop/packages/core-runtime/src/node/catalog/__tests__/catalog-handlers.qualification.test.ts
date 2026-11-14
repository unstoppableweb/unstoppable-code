import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_CATALOG_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_QUERY_DEFINITIONS,
  CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SOURCE_QUERY_DEFINITIONS,
  emptyCatalogSelectionRefs,
  type CanopyCallerDescriptor,
  type CatalogEntry,
  type CatalogSelectionRefs,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import {
  CatalogHostRefusedError,
  CatalogMutationRuns,
  CatalogSelectionUnavailableError,
  catalogContentRevision,
  createCoreCatalogHandlers,
  type CatalogPluginInstallOutcome,
  type CatalogPublication,
  type CatalogPublishOptions,
  type CatalogPublishPackage,
  type CatalogPluginTarget,
  type CatalogRefreshOutcome,
  type CatalogRefreshPlan,
  type CatalogSelectionRead,
  type CatalogSelectionScope,
  type CatalogSnapshotRead,
  type CatalogSourceRecord,
  type CoreCatalogHost,
} from '..';

const at = '2026-11-05T00:00:00.000Z';

function pluginEntry(
  name: string,
  availability: CatalogEntry['availability'],
): CatalogEntry {
  return {
    entryId: `plugin:m/${name}`,
    kind: 'plugin',
    name,
    description: '',
    source: 'plugin',
    content: {
      kind: 'plugin',
      manifest: {
        name,
        version: '',
        capabilities: [],
        dependencies: [],
      },
    },
    availability,
    revision: 0,
    createdAt: at,
    updatedAt: at,
  };
}

const ref = (name: string): { marketplaceId: string; pluginName: string } => ({
  marketplaceId: 'm',
  pluginName: name,
});

class MemoryCatalogHost implements CoreCatalogHost {
  entries: CatalogEntry[] = [
    pluginEntry('a', 'available'),
    pluginEntry('b', 'available'),
    pluginEntry('gone', 'missing'),
  ];
  global: CatalogSelectionRefs = {
    ...emptyCatalogSelectionRefs(),
    pluginRefs: [ref('a')],
  };
  chat: CatalogSelectionRead = {
    revision: 7,
    selections: {
      ...emptyCatalogSelectionRefs(),
      pluginRefs: [ref('a'), ref('gone')],
    },
    tombstones: { ...emptyCatalogSelectionRefs(), pluginRefs: [ref('b')] },
  };
  sources: CatalogSourceRecord[] = [
    {
      sourceId: 'git-source',
      displayName: 'owner/repo',
      locator: { kind: 'git', repository: 'owner/repo', ref: null },
      providers: ['claude', 'codex'],
      enabled: true,
      revision: 1,
      lastRefresh: { state: 'never' },
    },
  ];
  pluginTarget: CatalogPluginTarget = {
    entryId: 'plugin:m/a',
    marketplaceId: 'm',
    pluginName: 'a',
    install: 'external',
  };
  extraPluginRefs: { marketplaceId: string; pluginName: string }[] = [];
  readonly refreshPlans: CatalogRefreshPlan[] = [];
  readError: Error | null = null;
  snapshotFailures = 0;
  listSourcesError: Error | null = null;
  refreshGate: Promise<void> = Promise.resolve();
  refreshFails = false;
  installOutcome: CatalogPluginInstallOutcome | null = null;
  readonly calls = {
    replaceGlobalSelection: 0,
    replaceWorkspaceSelection: [] as Parameters<
      CoreCatalogHost['replaceWorkspaceSelection']
    >[0][],
    refreshSources: 0,
    installPlugin: 0,
    publishPlugin: 0,
    publishSkill: [] as { entryId: string; pkg: CatalogPublishPackage }[],
    publishPluginPackage: [] as {
      target: CatalogPluginTarget;
      pkg: CatalogPublishPackage;
      options?: CatalogPublishOptions;
    }[],
  };
  publishOutcome: CatalogPublication | Error = {
    publicationId: 'mkt-1',
    remoteEntryId: 'plugin:marketplace:mkt-1/a',
    revision: 'a'.repeat(40),
  };
  publishPlugin?: (target: CatalogPluginTarget) => Promise<CatalogPublication> =
    () => {
      this.calls.publishPlugin += 1;
      return this.publishOutcome instanceof Error
        ? Promise.reject(this.publishOutcome)
        : Promise.resolve(this.publishOutcome);
    };
  publishPluginPackage?: (
    target: CatalogPluginTarget,
    pkg: CatalogPublishPackage,
    options?: CatalogPublishOptions,
  ) => Promise<CatalogPublication> = (target, pkg, options) => {
    this.calls.publishPluginPackage.push({ target, pkg, options });
    return this.publishOutcome instanceof Error
      ? Promise.reject(this.publishOutcome)
      : Promise.resolve(this.publishOutcome);
  };
  publishSkill?: (
    entryId: string,
    pkg: CatalogPublishPackage,
  ) => Promise<CatalogPublication> = (entryId, pkg) => {
    this.calls.publishSkill.push({ entryId, pkg });
    return this.publishOutcome instanceof Error
      ? Promise.reject(this.publishOutcome)
      : Promise.resolve(this.publishOutcome);
  };

  snapshot(): Promise<CatalogSnapshotRead> {
    if (this.snapshotFailures > 0) {
      this.snapshotFailures -= 1;
      return Promise.reject(new Error('catalog cache busy'));
    }
    return Promise.resolve({
      entries: this.entries,
      refs: {
        ...emptyCatalogSelectionRefs(),
        pluginRefs: [ref('a'), ref('b'), ref('gone'), ...this.extraPluginRefs],
      },
    });
  }

  readSelection(scope: CatalogSelectionScope): Promise<CatalogSelectionRead> {
    if (this.readError) return Promise.reject(this.readError);
    if (scope.kind === 'chat') return Promise.resolve(this.chat);
    if (scope.kind === 'workspace')
      return Promise.resolve({
        revision: 3,
        selections: emptyCatalogSelectionRefs(),
        tombstones: emptyCatalogSelectionRefs(),
      });
    return Promise.resolve({
      revision: catalogContentRevision(this.global),
      selections: this.global,
      tombstones: null,
    });
  }

  async replaceGlobalSelection(
    expectedRevision: number,
    refs: CatalogSelectionRefs,
  ): Promise<{ outcome: 'replaced' | 'conflict'; read: CatalogSelectionRead }> {
    this.calls.replaceGlobalSelection += 1;
    if (expectedRevision !== catalogContentRevision(this.global))
      return {
        outcome: 'conflict',
        read: await this.readSelection({ kind: 'global' }),
      };
    this.global = refs;
    return {
      outcome: 'replaced',
      read: await this.readSelection({ kind: 'global' }),
    };
  }

  replaceWorkspaceSelection(
    request: Parameters<CoreCatalogHost['replaceWorkspaceSelection']>[0],
  ): Promise<CatalogSelectionRead> {
    this.calls.replaceWorkspaceSelection.push(request);
    return Promise.resolve({
      revision: 4,
      selections: request.refs,
      tombstones: null,
    });
  }

  listSources(): Promise<CatalogSourceRecord[]> {
    if (this.listSourcesError) return Promise.reject(this.listSourcesError);
    return Promise.resolve(this.sources);
  }

  addGitSource(): Promise<CatalogSourceRecord> {
    return Promise.reject(new Error('not used'));
  }

  deleteSource(): Promise<{
    removedProviders: ('claude' | 'codex')[];
    alreadyAbsent: boolean;
  }> {
    return Promise.reject(new Error('not used'));
  }

  async refreshSources(
    plan: CatalogRefreshPlan,
  ): Promise<CatalogRefreshOutcome> {
    this.calls.refreshSources += 1;
    this.refreshPlans.push(plan);
    await this.refreshGate;
    const ids = [...plan.updateSourceIds, ...plan.scanOnlySourceIds];
    return this.refreshFails
      ? { refreshed: [], failed: ids }
      : { refreshed: ids, failed: [] };
  }

  findPlugin(entryId: string): Promise<CatalogPluginTarget | null> {
    return Promise.resolve(
      entryId === this.pluginTarget.entryId ? this.pluginTarget : null,
    );
  }

  installPlugin(
    _target: CatalogPluginTarget,
    providers: readonly ('claude' | 'codex')[],
  ): Promise<CatalogPluginInstallOutcome> {
    this.calls.installPlugin += 1;
    return Promise.resolve(
      this.installOutcome ?? { installed: [...providers], failed: [] },
    );
  }
}

const caller = (
  grant: CanopyCallerDescriptor['grants'][number],
): CanopyCallerDescriptor => ({
  principalId: 'p',
  clientInstanceId: 'c',
  authorityId: 'a',
  interfaceKind: 'desktop',
  grants: [grant],
});
const reader = caller('core.catalog.read');
const writer = caller('core.catalog.write');
const keyed = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});

let root: string;
let operations: OperationService;
let host: MemoryCatalogHost;

let now = new Date('2026-11-05T00:00:00.000Z');

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the dispatcher type is inferred from its definitions
function compose() {
  const runs = new CatalogMutationRuns({ operations });
  const handlers = createCoreCatalogHandlers({ host, runs, clock: () => now });
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {
        ...CORE_CATALOG_QUERY_DEFINITIONS,
        ...CORE_CATALOG_SOURCE_QUERY_DEFINITIONS,
      },
      instructions: {
        ...CORE_CATALOG_INSTRUCTION_DEFINITIONS,
        ...CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS,
        ...CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS,
      },
      streams: {},
    },
    handlers: { ...handlers, streams: {} },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4123-'));
  const path = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(path),
  });
  host = new MemoryCatalogHost();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('core.catalog handlers (CAN-4123)', () => {
  it('serves only the kinds it has and only available entries unless asked', async () => {
    const dispatcher = compose();
    await expect(
      dispatcher.query(
        'core.catalog.snapshot.get',
        { scope: {}, kinds: ['model'], includeUnavailable: false },
        { caller: reader },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });

    const available = await dispatcher.query(
      'core.catalog.snapshot.get',
      { scope: {}, kinds: [], includeUnavailable: false },
      { caller: reader },
    );
    expect(available.entries.map((entry) => entry.entryId)).toEqual([
      'plugin:m/a',
      'plugin:m/b',
    ]);
    const all = await dispatcher.query(
      'core.catalog.snapshot.get',
      { scope: {}, kinds: [], includeUnavailable: true },
      { caller: reader },
    );
    expect(all.entries.map((entry) => entry.entryId)).toContain(
      'plugin:m/gone',
    );

    host.entries = host.entries.map((entry) => ({
      ...entry,
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
    }));
    now = new Date('2027-01-01T00:00:00.000Z');
    const again = await dispatcher.query(
      'core.catalog.snapshot.get',
      { scope: {}, kinds: [], includeUnavailable: false },
      { caller: reader },
    );
    expect(again.revision).toBe(available.revision);
    expect(again.generatedAt).not.toBe(available.generatedAt);
  });

  it("refuses revision 2's hosted model catalog before any read (CAN-6093)", async () => {
    const dispatcher = compose();
    // A read would fail on this instead of answering the refusal.
    host.snapshotFailures = 1;
    await expect(
      dispatcher.query(
        'core.catalog.snapshot.get',
        { scope: {}, kinds: [], includeUnavailable: false, revision: 2 },
        { caller: reader },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        details: { unsupported: ['revision'], reason: 'unserved' },
        retry: { kind: 'after_refresh', resource: 'core.runtime.manifest.get' },
      },
    });
    expect(host.snapshotFailures).toBe(1);
  });

  it('reads selections with unavailable and tombstoned ids', async () => {
    const dispatcher = compose();
    const chat = await dispatcher.query(
      'core.catalog.selection.get',
      { scope: { workspaceId: 'w', worktreeId: 't', chatId: 'c' } },
      { caller: reader },
    );
    expect(chat).toEqual({
      revision: 7,
      selectedItemIds: ['plugin:m/a', 'plugin:m/gone'],
      unavailableItemIds: ['plugin:m/gone'],
      tombstonedItemIds: ['plugin:m/b'],
    });
    await expect(
      dispatcher.query(
        'core.catalog.selection.get',
        { scope: { chatId: 'x' } },
        { caller: reader },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });

    host.readError = new CatalogSelectionUnavailableError();
    await expect(
      dispatcher.query(
        'core.catalog.selection.get',
        { scope: { workspaceId: 'w', worktreeId: 't', chatId: 'c' } },
        { caller: reader },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
  });

  it('replaces the global defaults under their revision and refuses a stale one', async () => {
    const dispatcher = compose();
    const read = await dispatcher.query(
      'core.catalog.selection.get',
      { scope: {} },
      { caller: reader },
    );
    const updated = await dispatcher.instruction(
      'core.catalog.selection.update',
      {
        scope: {},
        expectedRevision: read.revision,
        selectedItemIds: ['plugin:m/b'],
        _meta: keyed('k1'),
      },
      { caller: writer, metadata: keyed('k1') },
    );
    expect(updated.selectedItemIds).toEqual(['plugin:m/b']);
    expect(updated.revision).not.toBe(read.revision);
    expect(updated.materializationOperation).toBeNull();

    host.snapshotFailures = 1;
    host.readError = new CatalogSelectionUnavailableError();
    await expect(
      dispatcher.instruction(
        'core.catalog.selection.update',
        {
          scope: {},
          expectedRevision: read.revision,
          selectedItemIds: ['plugin:m/b'],
          _meta: keyed('k1'),
        },
        { caller: writer, metadata: keyed('k1') },
      ),
    ).resolves.toEqual(updated);
    host.snapshotFailures = 0;
    host.readError = null;

    await expect(
      dispatcher.instruction(
        'core.catalog.selection.update',
        {
          scope: {},
          expectedRevision: read.revision,
          selectedItemIds: ['plugin:m/a'],
          _meta: keyed('k2'),
        },
        { caller: writer, metadata: keyed('k2') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.catalog.selection.revisionConflict',
        retry: { kind: 'after_refresh' },
      },
    });

    host.snapshotFailures = 1;
    const retried = {
      scope: {},
      expectedRevision: updated.revision,
      selectedItemIds: ['plugin:m/a'],
      _meta: keyed('k4'),
    };
    await expect(
      dispatcher.instruction('core.catalog.selection.update', retried, {
        caller: writer,
        metadata: keyed('k4'),
      }),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    const recovered = await dispatcher.instruction(
      'core.catalog.selection.update',
      retried,
      { caller: writer, metadata: keyed('k4') },
    );
    expect(recovered.selectedItemIds).toEqual(['plugin:m/a']);

    const calls = host.calls.replaceGlobalSelection;
    await expect(
      dispatcher.instruction(
        'core.catalog.selection.update',
        {
          scope: {},
          expectedRevision: recovered.revision,
          selectedItemIds: ['plugin:m/unknown'],
          _meta: keyed('k3'),
        },
        { caller: writer, metadata: keyed('k3') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(host.calls.replaceGlobalSelection).toBe(calls);
  });

  it('refuses chat writes and keeps workspace writes off the ledger', async () => {
    const dispatcher = compose();
    await expect(
      dispatcher.instruction(
        'core.catalog.selection.update',
        {
          scope: { workspaceId: 'w', worktreeId: 't', chatId: 'c' },
          expectedRevision: 7,
          selectedItemIds: [],
          _meta: keyed('k'),
        },
        { caller: writer, metadata: keyed('k') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });

    await dispatcher.instruction(
      'core.catalog.selection.update',
      {
        scope: { workspaceId: 'w' },
        expectedRevision: 3,
        selectedItemIds: ['plugin:m/a'],
        _meta: keyed('k'),
      },
      { caller: writer, metadata: keyed('k') },
    );
    expect(host.calls.replaceWorkspaceSelection).toEqual([
      expect.objectContaining({
        workspaceId: 'w',
        expectedRevision: 3,
        idempotencyKey: 'catalog-selection:k',
      }),
    ]);
    const { items } = await operations.list({
      kinds: ['core.catalog.selection.update'],
      limit: 10,
    });
    expect(items).toEqual([]);
  });

  it('admits a refresh, returns at once and replays its acknowledgement', async () => {
    const dispatcher = compose();
    let release = (): void => undefined;
    host.refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const params = {
      sourceIds: ['git-source'],
      providers: ['claude', 'codex'] satisfies ('claude' | 'codex')[],
      mode: 'update_then_scan' as const,
      _meta: keyed('k'),
    };

    const ack = await dispatcher.instruction(
      'core.catalog.source.refresh',
      params,
      { caller: writer, metadata: keyed('k') },
    );
    const anyOperationId: unknown = expect.any(String);
    expect(ack).toEqual({
      operationId: anyOperationId,
      acceptedSources: ['git-source'],
      scanOnlySources: [],
    });
    const replay = await dispatcher.instruction(
      'core.catalog.source.refresh',
      params,
      { caller: writer, metadata: keyed('k') },
    );
    expect(replay).toEqual(ack);
    release();
    await operations.waitForTerminal(ack.operationId);
    expect(host.calls.refreshSources).toBe(1);

    host.listSourcesError = new Error('sources busy');
    await expect(
      dispatcher.instruction('core.catalog.source.refresh', params, {
        caller: writer,
        metadata: keyed('k'),
      }),
    ).resolves.toEqual(ack);
    host.listSourcesError = null;

    host.sources = [];
    const afterRemoval = await dispatcher.instruction(
      'core.catalog.source.refresh',
      params,
      { caller: writer, metadata: keyed('k') },
    );
    expect(afterRemoval).toEqual(ack);
    expect(host.calls.refreshSources).toBe(1);

    await expect(
      dispatcher.instruction(
        'core.catalog.source.refresh',
        { ...params, sourceIds: ['nope'], _meta: keyed('k2') },
        { caller: writer, metadata: keyed('k2') },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.catalog.sourceNotFound' },
    });
    const { items } = await operations.list({
      kinds: ['core.catalog.source.refresh'],
      limit: 10,
    });
    expect(items).toHaveLength(1);
  });

  it('replays a refresh of all sources after a source was added', async () => {
    const dispatcher = compose();
    const refreshAll = (): Promise<{
      operationId: string;
      acceptedSources: string[];
    }> =>
      dispatcher.instruction(
        'core.catalog.source.refresh',
        {
          sourceIds: 'all',
          providers: ['claude', 'codex'],
          mode: 'update_then_scan',
          _meta: keyed('all'),
        },
        { caller: writer, metadata: keyed('all') },
      );

    const ack = await refreshAll();
    expect(ack.acceptedSources).toEqual(['git-source']);
    await operations.waitForTerminal(ack.operationId);
    host.sources = [
      ...host.sources,
      { ...host.sources[0], sourceId: 'added-source' },
    ];

    await expect(refreshAll()).resolves.toEqual(ack);
    expect(host.calls.refreshSources).toBe(1);
    expect(host.refreshPlans[0]).toMatchObject({
      all: true,
      updateSourceIds: ['git-source'],
    });

    host.sources = Array.from({ length: 101 }, (_, index) => ({
      ...host.sources[0],
      sourceId: `source-${index}`,
    }));
    await expect(
      dispatcher.instruction(
        'core.catalog.source.refresh',
        {
          sourceIds: 'all',
          providers: ['claude', 'codex'],
          mode: 'update_then_scan',
          _meta: keyed('too-many'),
        },
        { caller: writer, metadata: keyed('too-many') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'resource_exhausted',
        code: 'core.catalog.refreshTooLarge',
      },
    });
    expect(host.calls.refreshSources).toBe(1);
  });

  it('refuses a selection or refresh too large to record before changing anything (CAN-5898)', async () => {
    const dispatcher = compose();
    host.extraPluginRefs = Array.from({ length: 400 }, (_, index) =>
      ref(`${'a-plugin-with-a-long-name-'.repeat(8)}${index}`),
    );
    const read = await dispatcher.query(
      'core.catalog.selection.get',
      { scope: {} },
      { caller: reader },
    );
    await expect(
      dispatcher.instruction(
        'core.catalog.selection.update',
        {
          scope: {},
          expectedRevision: read.revision,
          selectedItemIds: host.extraPluginRefs.map(
            (plugin) => `plugin:m/${plugin.pluginName}`,
          ),
          _meta: keyed('large-selection'),
        },
        { caller: writer, metadata: keyed('large-selection') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'resource_exhausted',
        message: 'This selection is too large to record.',
      },
    });
    expect(host.calls.replaceGlobalSelection).toBe(0);

    host.sources = Array.from({ length: 100 }, (_, index) => ({
      ...host.sources[0],
      sourceId: `${'a-source-with-a-long-id-'.repeat(16)}${index}`,
    }));
    await expect(
      dispatcher.instruction(
        'core.catalog.source.refresh',
        {
          sourceIds: 'all',
          providers: ['claude', 'codex'],
          mode: 'update_then_scan',
          _meta: keyed('large-refresh'),
        },
        { caller: writer, metadata: keyed('large-refresh') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'resource_exhausted',
        code: 'core.catalog.refreshTooLarge',
      },
    });
    expect(host.calls.refreshSources).toBe(0);
    const { items } = await operations.list({
      kinds: ['core.catalog.source.refresh'],
      limit: 10,
    });
    expect(items).toEqual([]);
  });

  it('replays a large explicit refresh under its key without checking its size again (CAN-5898)', async () => {
    const dispatcher = compose();
    host.sources = Array.from({ length: 40 }, (_, index) => ({
      ...host.sources[0],
      sourceId: `${'a-source-with-a-long-id-'.repeat(20)}${index}`,
    }));
    const refresh = (): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.source.refresh',
        {
          sourceIds: host.sources.map((source) => source.sourceId),
          providers: ['claude', 'codex'],
          mode: 'update_then_scan',
          _meta: keyed('large-explicit'),
        },
        { caller: writer, metadata: keyed('large-explicit') },
      );

    const ack = await refresh();
    expect(ack).toMatchObject({ scanOnlySources: [] });
    await expect(refresh()).resolves.toEqual(ack);
    expect(host.calls.refreshSources).toBe(1);
  });

  it('fails a scan-only refresh when every requested source failed', async () => {
    const dispatcher = compose();
    host.refreshFails = true;
    const ack = await dispatcher.instruction(
      'core.catalog.source.refresh',
      {
        sourceIds: ['git-source'],
        providers: ['claude', 'codex'],
        mode: 'scan',
        _meta: keyed('scan'),
      },
      { caller: writer, metadata: keyed('scan') },
    );
    expect(ack.scanOnlySources).toEqual(['git-source']);
    const record = await operations.waitForTerminal(ack.operationId);
    expect(record.status).toBe('failed');
    expect(record.error).toMatchObject({
      kind: 'unavailable',
      code: 'core.catalog.refreshUnavailable',
    });
  });

  it('publishes a plugin once per key and refuses what cannot be published (CAN-6176)', async () => {
    const dispatcher = compose();
    const publish = (
      key: string,
      overrides: Record<string, unknown> = {},
    ): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.entry.publish',
        {
          entryId: 'plugin:m/a',
          kind: 'plugin',
          expectedRevision: 0,
          visibility: 'private',
          teamId: null,
          organizationId: null,
          ...overrides,
          _meta: keyed(key),
        },
        { caller: writer, metadata: keyed(key) },
      );
    const published = {
      publicationId: 'mkt-1',
      remoteEntryId: 'plugin:marketplace:mkt-1/a',
      revision: 'a'.repeat(40),
    };
    await expect(Promise.all([publish('p1'), publish('p1')])).resolves.toEqual([
      published,
      published,
    ]);
    expect(host.calls.publishPlugin).toBe(1);

    await expect(
      publish('p2', { visibility: 'organization', organizationId: 'org' }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'core.catalog.visibilityInvalid',
      },
    });
    host.publishPluginPackage = undefined;
    for (const [key, overrides, kind] of [
      ['p3', { kind: 'skill', entryId: 'skill:s/x' }, 'invalid_argument'],
      [
        'p3b',
        { package: { analysisId: 'a', selectedOptionalResourceIds: [] } },
        // Served below by a host that uploads a plugin's package.
        'capability_unavailable',
      ],
      ['p3c', { kind: 'model', entryId: 'model:m' }, 'capability_unavailable'],
    ] as const)
      await expect(publish(key, overrides)).rejects.toMatchObject({
        payload: { kind },
      });
    await expect(publish('p4', { expectedRevision: 3 })).rejects.toMatchObject({
      payload: { kind: 'conflict', code: 'core.catalog.revisionConflict' },
    });
    await expect(
      publish('p5', { entryId: 'plugin:m/nope' }),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.catalog.entryNotFound' },
    });
    expect(host.calls.publishPlugin).toBe(1);

    for (const [refusal, payload] of [
      [
        'publish-source-unsupported',
        { kind: 'failed_precondition', code: 'core.catalog.entryReadOnly' },
      ],
      [
        'publish-revision-moved',
        { kind: 'conflict', code: 'core.catalog.revisionConflict' },
      ],
      [
        'publish-remote-unavailable',
        {
          kind: 'unavailable',
          code: 'core.catalog.remoteUnavailable',
          // Recorded under its key: a retry with that key replays this failure.
          retry: { kind: 'never' },
        },
      ],
    ] as const) {
      host.publishOutcome = new CatalogHostRefusedError(refusal);
      await expect(publish(`r-${refusal}`)).rejects.toMatchObject({ payload });
    }

    host.publishPlugin = undefined;
    await expect(publish('p6')).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
  });

  it("uploads a local plugin's consented package once per key (CAN-6176 D13)", async () => {
    const dispatcher = compose();
    const pkg = { analysisId: 'analysis-p', selectedOptionalResourceIds: [] };
    const publish = (
      key: string,
      overrides: Record<string, unknown> = {},
    ): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.entry.publish',
        {
          entryId: 'plugin:m/a',
          kind: 'plugin',
          expectedRevision: 0,
          visibility: 'private',
          teamId: null,
          organizationId: null,
          package: pkg,
          ...overrides,
          _meta: keyed(key),
        },
        { caller: writer, metadata: keyed(key) },
      );
    await expect(Promise.all([publish('u1'), publish('u1')])).resolves.toEqual([
      host.publishOutcome,
      host.publishOutcome,
    ]);
    // The package path takes the found plugin and never adds a public source.
    expect(
      host.calls.publishPluginPackage.map(({ target, pkg: sent }) => ({
        entryId: target.entryId,
        marketplaceId: target.marketplaceId,
        pluginName: target.pluginName,
        pkg: sent,
      })),
    ).toEqual([
      { entryId: 'plugin:m/a', marketplaceId: 'm', pluginName: 'a', pkg },
    ]);
    expect(host.calls.publishPlugin).toBe(0);
    await expect(publish('u2', { expectedRevision: 2 })).rejects.toMatchObject({
      payload: { kind: 'conflict', code: 'core.catalog.revisionConflict' },
    });
    expect(host.calls.publishPluginPackage).toHaveLength(1);

    // The account the person chose reaches the host, which refuses another.
    await publish('u2b', { expectedAccountId: 'acct-1' });
    expect(host.calls.publishPluginPackage.at(-1)?.options).toEqual({
      expectedAccountId: 'acct-1',
    });
    host.publishOutcome = new CatalogHostRefusedError(
      'publish-account-mismatch',
    );
    await expect(
      publish('u2c', { expectedAccountId: 'acct-2' }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.catalog.accountMismatch',
      },
    });

    host.publishOutcome = new CatalogHostRefusedError('publish-package-stale');
    await expect(publish('u3')).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.catalog.packageStale',
        message:
          'This plugin changed after its files were checked. Check them again.',
      },
    });
    const taken =
      'A plugin named a from Team tools is already in your cloud marketplace. Remove it first or rename this one.';
    host.publishOutcome = new CatalogHostRefusedError(
      'publish-name-taken',
      new Error(taken),
    );
    await expect(publish('u5')).rejects.toMatchObject({
      payload: {
        kind: 'already_exists',
        code: 'core.catalog.entryNameTaken',
        message: taken,
      },
    });
    host.publishOutcome = new CatalogHostRefusedError(
      'publish-source-unsupported',
    );
    await expect(publish('u4')).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.catalog.entryReadOnly',
        message: "This plugin's files can't be added to the cloud.",
      },
    });
  });

  it('publishes a custom skill with its consented package once per key (CAN-6176)', async () => {
    const dispatcher = compose();
    host.entries.push({
      entryId: 'skill:custom:app/helper',
      kind: 'skill',
      name: 'helper',
      description: '',
      source: 'user',
      content: { kind: 'skill', entrypoint: null },
      availability: 'available',
      revision: 0,
      createdAt: '2026-11-10T00:00:00.000Z',
      updatedAt: '2026-11-10T00:00:00.000Z',
    });
    const pkg = {
      analysisId: 'analysis-1',
      selectedOptionalResourceIds: ['r'],
    };
    const published = {
      publicationId: 'skill-remote-1',
      remoteEntryId: 'skill:cloud-custom/skill-remote-1',
      revision: 'b'.repeat(64),
    };
    host.publishOutcome = published;
    const publish = (
      key: string,
      overrides: Record<string, unknown> = {},
    ): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.entry.publish',
        {
          entryId: 'skill:custom:app/helper',
          kind: 'skill',
          expectedRevision: 0,
          visibility: 'private',
          teamId: null,
          organizationId: null,
          package: pkg,
          ...overrides,
          _meta: keyed(key),
        },
        { caller: writer, metadata: keyed(key) },
      );
    await expect(Promise.all([publish('s1'), publish('s1')])).resolves.toEqual([
      published,
      published,
    ]);
    expect(host.calls.publishSkill).toEqual([
      { entryId: 'skill:custom:app/helper', pkg },
    ]);

    await expect(
      publish('s2', { visibility: 'team', teamId: 'team' }),
    ).rejects.toMatchObject({
      payload: { code: 'core.catalog.visibilityInvalid' },
    });
    await expect(publish('s3', { expectedRevision: 1 })).rejects.toMatchObject({
      payload: { kind: 'conflict', code: 'core.catalog.revisionConflict' },
    });
    await expect(
      publish('s4', { entryId: 'skill:custom:app/gone' }),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.catalog.entryNotFound' },
    });
    expect(host.calls.publishSkill).toHaveLength(1);

    for (const [refusal, payload] of [
      [
        'publish-package-stale',
        {
          kind: 'conflict',
          code: 'core.catalog.packageStale',
          retry: { kind: 'after_refresh', resource: 'core.catalog.entry' },
        },
      ],
      [
        'publish-package-blocked',
        {
          kind: 'failed_precondition',
          code: 'core.catalog.packageBlocked',
          message:
            "This skill has a file or dependency that can't be added to the cloud. Check its files again.",
        },
      ],
      [
        'publish-entry-not-found',
        { kind: 'not_found', code: 'core.catalog.entryNotFound' },
      ],
      [
        'publish-source-unsupported',
        { kind: 'failed_precondition', code: 'core.catalog.entryReadOnly' },
      ],
      [
        'publish-revision-moved',
        { kind: 'conflict', code: 'core.catalog.revisionConflict' },
      ],
      [
        'publish-remote-unavailable',
        { kind: 'unavailable', code: 'core.catalog.remoteUnavailable' },
      ],
    ] as const) {
      host.publishOutcome = new CatalogHostRefusedError(refusal);
      await expect(publish(`r-${refusal}`)).rejects.toMatchObject({ payload });
    }

    host.publishSkill = undefined;
    await expect(publish('s5')).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
  });

  it('installs a plugin once per key and refuses what cannot be installed', async () => {
    const dispatcher = compose();
    await expect(
      dispatcher.instruction(
        'core.catalog.plugin.install',
        {
          entryId: 'plugin:m/a',
          providers: ['claude', 'codex'],
          _meta: keyed('k1'),
        },
        { caller: writer, metadata: keyed('k1') },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.catalog.pluginNotInstallable' },
    });

    const install = (): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.plugin.install',
        { entryId: 'plugin:m/a', providers: ['claude'], _meta: keyed('k2') },
        { caller: writer, metadata: keyed('k2') },
      );
    const installed = {
      entryId: 'plugin:m/a',
      providers: ['claude'],
      installedProviders: ['claude'],
      failedProviders: [],
    };
    await expect(Promise.all([install(), install()])).resolves.toEqual([
      installed,
      installed,
    ]);
    expect(host.calls.installPlugin).toBe(1);
  });

  it('reports a partial install with the providers that installed and failed', async () => {
    const dispatcher = compose();
    host.pluginTarget = { ...host.pluginTarget, install: 'managed' };
    host.installOutcome = { installed: ['claude'], failed: ['codex'] };
    const install = (key: string): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.plugin.install',
        {
          entryId: 'plugin:m/a',
          providers: ['codex', 'claude'],
          _meta: keyed(key),
        },
        { caller: writer, metadata: keyed(key) },
      );
    const partial = {
      entryId: 'plugin:m/a',
      providers: ['claude', 'codex'],
      installedProviders: ['claude'],
      failedProviders: ['codex'],
    };
    await expect(install('partial')).resolves.toEqual(partial);
    await expect(install('partial')).resolves.toEqual(partial);
    expect(host.calls.installPlugin).toBe(1);

    host.installOutcome = { installed: [], failed: [] };
    await expect(install('none')).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'core.catalog.pluginInstallFailed',
      },
    });
  });

  it('replays an install receipt recorded before provider outcomes', async () => {
    const dispatcher = compose();
    const params = { entryId: 'plugin:m/a', providers: ['claude'] };
    const admitted = await operations.admit({
      kind: 'core.catalog.plugin.install',
      status: 'running',
      receipt: {
        caller: 'core.catalog:p',
        idempotencyKey: 'old',
        fingerprint: createHash('sha256')
          .update(stableStringify(params), 'utf8')
          .digest('hex'),
      },
      origin: { kind: 'client', sourceId: 'c' },
      owner: { kind: 'principal', id: 'p' },
      scope: {},
    });
    await operations.finish(admitted.operation.operationId, {
      status: 'completed',
      outcome: params,
    });

    await expect(
      dispatcher.instruction(
        'core.catalog.plugin.install',
        { ...params, providers: ['claude'], _meta: keyed('old') },
        { caller: writer, metadata: keyed('old') },
      ),
    ).resolves.toEqual({
      ...params,
      installedProviders: ['claude'],
      failedProviders: [],
    });
    expect(host.calls.installPlugin).toBe(0);
  });

  it('refuses calls without their grant', async () => {
    const dispatcher = compose();
    await expect(
      dispatcher.query(
        'core.catalog.selection.get',
        { scope: {} },
        { caller: writer },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      dispatcher.instruction(
        'core.catalog.plugin.install',
        { entryId: 'plugin:m/a', providers: ['claude'], _meta: keyed('k') },
        { caller: reader, metadata: keyed('k') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  });
});
