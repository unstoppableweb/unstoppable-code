import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CATALOG_COLLECTION_OPERATION_CODES,
  CatalogCollectionUpsertResultSchema,
  CatalogEntryPublishResultSchema,
  CatalogCollectionDeleteResultSchema,
  CatalogEntryUnpublishResultSchema,
  CatalogPluginInstallResultSchema,
  CatalogSkillCustomSaveResultSchema,
  CatalogSkillRemoveResultSchema,
  CatalogSkillUpdateResultSchema,
  CatalogSourceDeleteResultSchema,
  CatalogSourceUpsertResultSchema,
  isBoundedCanopyJsonValue,
  type CatalogCollectionUpsertParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../runtime/types';
import { OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import {
  CORE_CATALOG_MUTATION_KINDS,
  CatalogMutationRuns,
  createCoreCollectionEntryHandlers,
  type CatalogMutationRequest,
  type CoreCatalogMutationKind,
  type CoreCollectionEntryHost,
} from '..';

const context: CanopyHandlerContext = {
  requestId: 'r',
  caller: {
    principalId: 'p',
    clientInstanceId: 'c',
    authorityId: 'a',
    interfaceKind: 'desktop',
    grants: [],
  },
  metadata: { idempotencyKey: 'k' },
  signal: new AbortController().signal,
};

interface Result {
  [key: string]: string;
  value: string;
}

let root: string;
let ledgerPath: string;
const services: OperationService[] = [];

function open(): { operations: OperationService; runs: CatalogMutationRuns } {
  const operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  services.push(operations);
  return { operations, runs: new CatalogMutationRuns({ operations }) };
}

function request(
  effect: () => Promise<Result>,
  params: Record<string, unknown> = { sourceId: 's' },
): CatalogMutationRequest<Result> {
  return {
    kind: 'core.catalog.source.delete',
    context,
    params: { ...params, _meta: { idempotencyKey: 'k' } },
    codes: ['core.catalog.sourceConflict'],
    keyReused: () =>
      new CanopyOperationError({
        kind: 'conflict',
        message: 'This idempotency key was used with other parameters.',
        retry: { kind: 'never' },
      }),
    decode: (outcome) =>
      typeof outcome === 'object' &&
      outcome !== null &&
      'value' in outcome &&
      typeof outcome.value === 'string'
        ? { value: outcome.value }
        : null,
    effect,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4123-'));
  ledgerPath = join(root, 'ledger.sqlite');
});
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  rmSync(root, { recursive: true, force: true });
});

describe('catalog mutation receipts (CAN-4123)', () => {
  it('runs the effect once for a repeated key, across a restart', async () => {
    const first = open();
    const effect = jest.fn(
      (): Promise<Result> => Promise.resolve({ value: 'done' }),
    );

    const [a, b] = await Promise.all([
      first.runs.run(request(effect)),
      first.runs.run(request(effect)),
    ]);
    expect(a).toEqual({ value: 'done' });
    expect(b).toEqual(a);
    expect(effect).toHaveBeenCalledTimes(1);
    await expect(first.runs.run(request(effect))).resolves.toEqual(a);
    expect(effect).toHaveBeenCalledTimes(1);

    first.operations.close();
    const second = open();
    const after = jest.fn(
      (): Promise<Result> => Promise.resolve({ value: 'again' }),
    );
    await expect(second.runs.run(request(after))).resolves.toEqual(a);
    expect(after).not.toHaveBeenCalled();
  });

  it('refuses a reused key with other parameters', async () => {
    const { runs } = open();
    const effect = jest.fn(
      (): Promise<Result> => Promise.resolve({ value: 'done' }),
    );

    await runs.run(request(effect));
    await expect(
      runs.run(request(effect, { sourceId: 'other' })),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        message: 'This idempotency key was used with other parameters.',
      },
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  // CAN-4170 PR 3b-2a: the share account pin narrowed the upsert size bound,
  // so an outcome recorded under the earlier bound must still replay.
  it('replays a recorded collection upsert the size bound now refuses, and refuses only a new key', async () => {
    const { runs } = open();
    const skills = Array.from({ length: 268 }, (_, index) => ({
      sourceId: 'user',
      skillName: `skill-${String(index).padStart(4, '0')}`.padEnd(16, 'x'),
    }));
    const upsert = (key: string): CatalogCollectionUpsertParams => ({
      kind: 'collection' as const,
      entryId: null,
      expectedRevision: null,
      name: 'Cap',
      description: '',
      members: { skills, plugins: [], mcpServers: [] },
      sharedRevision: null,
      _meta: { idempotencyKey: key },
    });
    const saved = CatalogCollectionUpsertResultSchema.parse({
      entry: {
        kind: 'collection',
        entryId: 'collection:aaaaaaaa-0000-4000-8000-000000000001',
        revision: 'rev-1',
        name: 'Cap',
        description: '',
        members: { skills, plugins: [], mcpServers: [] },
        updatedAt: '2026-11-01T00:00:00.000Z',
        sharedSource: null,
        share: null,
        unresolvedMembers: [],
      },
    });
    const keyReused = (): CanopyOperationError =>
      new CanopyOperationError({
        kind: 'conflict',
        message: 'This idempotency key was used with other parameters.',
        retry: { kind: 'never' },
      });
    await runs.run({
      kind: 'core.catalog.entry.upsert',
      context,
      params: upsert('k'),
      codes: CATALOG_COLLECTION_OPERATION_CODES.upsert,
      keyReused,
      decode: (outcome) =>
        CatalogCollectionUpsertResultSchema.safeParse(outcome).data ?? null,
      effect: () => Promise.resolve(saved),
    });
    const unexpected = (): Promise<never> =>
      Promise.reject(new Error('the host was called'));
    const create = jest.fn(unexpected);
    const host: CoreCollectionEntryHost = {
      read: unexpected,
      create,
      replace: unexpected,
      delete: unexpected,
      readManagement: unexpected,
      deleteCorrupt: unexpected,
      analyze: unexpected,
      dropAnalysis: unexpected,
      commit: unexpected,
      signedInAccountId: unexpected,
      readImportReadiness: unexpected,
    };
    const { instructions } = createCoreCollectionEntryHandlers({
      host,
      runs,
      installed: () =>
        Promise.resolve({
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        }),
    });
    const handle = instructions['core.catalog.entry.upsert'];
    expect(await handle(upsert('k'), context)).toEqual(saved);
    await expect(handle(upsert('k2'), context)).rejects.toMatchObject({
      payload: { kind: 'resource_exhausted' },
    });
    expect(
      await runs.recordedOperationId({
        kind: 'core.catalog.entry.upsert',
        context,
        params: upsert('k2'),
      }),
    ).toBeNull();
    await expect(
      handle({ ...upsert('k'), name: 'Renamed' }, context),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        message: 'This idempotency key was used with other parameters.',
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("replays a restart's interruption instead of running again", async () => {
    const first = open();
    let started = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    void first.runs
      .run(
        request(() => {
          started();
          return new Promise<Result>(() => undefined);
        }),
      )
      .catch(() => undefined);
    await running;

    first.operations.close();
    const second = open();
    const effect = jest.fn(
      (): Promise<Result> => Promise.resolve({ value: 'again' }),
    );
    await expect(second.runs.run(request(effect))).rejects.toMatchObject({
      payload: { kind: 'failed_precondition', retry: { kind: 'never' } },
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it("keeps a failed effect's typed error and its cause", async () => {
    const { runs } = open();
    const cause = new Error('host');
    const thrown = new CanopyOperationError(
      {
        kind: 'conflict',
        code: 'core.catalog.sourceConflict',
        message: 'm',
        retry: { kind: 'never' },
      },
      cause,
    );
    const effect = jest.fn((): Promise<Result> => Promise.reject(thrown));

    const first = await runs
      .run(request(effect))
      .catch((error: unknown) => error);
    expect(first).toBe(thrown);
    expect(first).toBeInstanceOf(CanopyOperationError);
    if (!(first instanceof CanopyOperationError)) return;
    expect(first.runtimeCause).toBe(cause);

    const replayed = await runs
      .run(request(effect))
      .catch((error: unknown) => error);
    expect(replayed).toBeInstanceOf(CanopyOperationError);
    if (!(replayed instanceof CanopyOperationError)) return;
    expect(replayed.payload).toEqual(thrown.payload);
    expect(replayed.runtimeCause).toBeUndefined();
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('replays an outcome whose ledger write failed, and records it later', async () => {
    const { operations, runs } = open();
    const finish = jest
      .spyOn(operations, 'finish')
      .mockRejectedValueOnce(new Error('ledger busy'));
    const effect = jest.fn(
      (): Promise<Result> => Promise.resolve({ value: 'done' }),
    );

    await expect(runs.run(request(effect))).resolves.toEqual({ value: 'done' });
    await expect(runs.run(request(effect))).resolves.toEqual({ value: 'done' });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(2);
    const { items } = await operations.list({
      kinds: ['core.catalog.source.delete'],
      limit: 10,
    });
    expect(items).toEqual([
      expect.objectContaining({
        status: 'completed',
        outcome: { value: 'done' },
      }),
    ]);
  });

  it('keeps retrying an unrecorded outcome until the ledger takes it', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      const { operations, runs } = open();
      const finish = jest.spyOn(operations, 'finish');
      for (let attempt = 0; attempt < 7; attempt += 1)
        finish.mockRejectedValueOnce(new Error('ledger busy'));
      const effect = jest.fn(
        (): Promise<Result> => Promise.resolve({ value: 'done' }),
      );

      await expect(runs.run(request(effect))).resolves.toEqual({
        value: 'done',
      });
      await jest.advanceTimersByTimeAsync(300_000);

      expect(finish).toHaveBeenCalledTimes(8);
      const { items } = await operations.list({
        kinds: ['core.catalog.source.delete'],
        limit: 10,
      });
      expect(items).toEqual([expect.objectContaining({ status: 'completed' })]);
    } finally {
      jest.useRealTimers();
    }
  });
  it('records an outcome too large for the ledger as a failure (CAN-5898)', async () => {
    const first = open();
    const effect = jest.fn(
      (): Promise<Result> => Promise.resolve({ value: 'x'.repeat(40_000) }),
    );
    const tooLarge = {
      payload: {
        kind: 'internal',
        message:
          'The catalog change finished, but its result was too large to record.',
        retry: { kind: 'never' },
      },
    };
    await expect(first.runs.run(request(effect))).rejects.toMatchObject(
      tooLarge,
    );

    first.operations.close();
    const second = open();
    await expect(second.runs.run(request(effect))).rejects.toMatchObject(
      tooLarge,
    );
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('every keyed catalog outcome fits the ledger or is bounded by its handler (CAN-5898)', () => {
    const id = 'i'.repeat(512);
    const both = ['claude', 'codex'];
    const maximal: Record<
      CoreCatalogMutationKind,
      | { schema: { parse: (value: unknown) => unknown }; result: unknown }
      | { boundedBy: string }
    > = {
      'core.catalog.selection.update': {
        boundedBy: 'catalog-handlers: refuses a selection or refresh too large',
      },
      'core.catalog.source.upsert': {
        schema: CatalogSourceUpsertResultSchema,
        result: {
          sourceId: id,
          displayName: 'd'.repeat(256),
          locator: {
            kind: 'directory',
            fileRootId: id,
            relativePath: 'p'.repeat(4096),
          },
          providers: both,
          enabled: true,
          revision: Number.MAX_SAFE_INTEGER,
          lastRefresh: {
            state: 'failed',
            operationId: id,
            completedAt: '2026-11-08T00:00:00.000Z',
            errorCode: 'e'.repeat(256),
          },
        },
      },
      'core.catalog.source.delete': {
        schema: CatalogSourceDeleteResultSchema,
        result: { sourceId: id, removedProviders: both, alreadyAbsent: false },
      },
      'core.catalog.source.refresh': {
        boundedBy: 'catalog-handlers: refuses a selection or refresh too large',
      },
      'core.catalog.plugin.install': {
        schema: CatalogPluginInstallResultSchema,
        result: {
          entryId: id,
          providers: both,
          installedProviders: both,
          failedProviders: [],
        },
      },
      'core.catalog.skill.install': {
        boundedBy:
          'skill-catalog-handlers: records a 600-skill install with a receipt that fits the ledger',
      },
      'core.catalog.skill.update': {
        schema: CatalogSkillUpdateResultSchema,
        result: { entryId: id },
      },
      'core.catalog.skill.remove': {
        schema: CatalogSkillRemoveResultSchema,
        result: { entryId: id },
      },
      'core.catalog.skill.custom.save': {
        schema: CatalogSkillCustomSaveResultSchema,
        result: { entryId: id, skillName: id },
      },
      'core.catalog.entry.publish': {
        schema: CatalogEntryPublishResultSchema,
        result: {
          publicationId: id,
          remoteEntryId: id,
          revision: 'r'.repeat(256),
        },
      },
      'core.catalog.entry.unpublish': {
        schema: CatalogEntryUnpublishResultSchema,
        result: { publicationId: id },
      },
      'core.catalog.entry.upsert': {
        boundedBy:
          'collection-entry-handlers: refuses a collection too large to record before writing it',
      },
      'core.catalog.entry.delete': {
        schema: CatalogCollectionDeleteResultSchema,
        result: {
          kind: 'collection',
          entryId: `collection:${'f'.repeat(128)}`,
          deleted: true,
        },
      },
      'core.catalog.entry.import': {
        boundedBy:
          'collection-entry-handlers: refuses an analysis too large to record, and drops it',
      },
      'core.catalog.skill.updates.check': {
        boundedBy:
          'skill-catalog-handlers: records an updates check over 600 installed skills',
      },
    };
    expect(Object.keys(maximal).sort()).toEqual(
      [...CORE_CATALOG_MUTATION_KINDS].sort(),
    );
    for (const entry of Object.values(maximal)) {
      if ('boundedBy' in entry) continue;
      expect(entry.schema.parse(entry.result)).toEqual(entry.result);
      expect(isBoundedCanopyJsonValue(entry.result)).toBe(true);
    }
  });
});
