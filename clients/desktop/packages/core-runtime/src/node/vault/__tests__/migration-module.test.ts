import { readFileSync } from 'node:fs';
import {
  createResumableMigrationModule,
  type MigrationModuleOptions,
  type ResumableMigrationModule,
} from '../migration-module';
import {
  createMigrationSessionRegistry,
  type MigrationSessionOffer,
  type MigrationPresentation,
  type MigrationSessionRegistry,
  type MigrationSessionOutcome,
} from '../migration-sessions';
import {
  MIGRATION_HOST_FIELDS,
  MIGRATION_SLOTS_AT_PIN,
  type MigrationChannelFacts,
  type MigrationFamilyPorts,
  type MigrationHostFacts,
  type MigrationObservation,
  type MigrationImportResult,
  type MigrationDeletionResult,
} from '../migration-ports';
import {
  encodeMigrationFrame,
  parseMigrationLauncherFrame,
} from '../migration-protocol';
import {
  migrationFixture,
  importRequest,
  migrationIdentity,
  type MigrationFixture,
} from '../repository/__tests__/migration-fixtures';
import {
  storeFolder,
  writeTestHeader,
  type StoreFolder,
} from '../repository/__tests__/store-fixtures';
import type { VaultStore } from '../repository/store';
import type { VaultPutHooks } from '../repository/put-path';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const host: MigrationHostFacts = {
  authorityId: 'authority',
  coreAuthority: 'core',
  coreIncarnation: 'incarnation',
  coreDigest: 'digest',
  buildId: 'internal',
  packageDigest: 'package',
  updateEpoch: 'update',
};
const source = { flavorId: 'canopy-internal', secureMode: 'development' };
const facts = {
  transport: 'launcher-channel',
  channelId: 'channel',
  launcher: { os: 'darwin', pid: 42, pidversion: 7 },
  launcherDigest: 'launcher-digest',
  source,
  admittedHost: host,
} satisfies MigrationChannelFacts;
function presentation(
  offer: MigrationSessionOffer,
  channel: object,
): MigrationPresentation {
  return {
    channel,
    challenge: offer.challenge,
    operation: offer.operation,
    purpose: offer.purpose,
  };
}
interface RegistryFixture {
  registry: MigrationSessionRegistry;
  channel: object;
  offer: MigrationSessionOffer;
  fenced: Set<string>;
  changeFacts(value: MigrationChannelFacts | null): void;
  changeHost(value: MigrationHostFacts): void;
  changeGeneration(): void;
  reenter(run: () => void): void;
  expire(): void;
  timeout(): void;
}
function registryFixture(): RegistryFixture {
  const channel = {};
  let currentFacts: MigrationChannelFacts | null = facts;
  let currentHost = host;
  let generation = 'generation';
  let onGeneration = (): void => {};
  let timer = (): void => {};
  let now = 0;
  const fenced = new Set<string>();
  const registry = createMigrationSessionRegistry(
    {
      admission: {
        channel: (value) => (value === channel ? currentFacts : null),
        host: () => currentHost,
      },
      source: {
        currentGeneration: () => {
          onGeneration();
          return generation;
        },
        isFenced: (_key, gen) => fenced.has(gen),
        fence: (_key, gen) => {
          fenced.add(gen);
        },
        slotProgress: () => ({ state: 'not_started' }),
      },
      importer: {
        createIfAbsent: () =>
          Promise.resolve({ kind: 'created', receipt: 'receipt' }),
      },
      clock: {
        now: () => now,
        setTimer: (callback) => {
          timer = callback;
          return { cancel: (): void => {} };
        },
      },
    },
    { os: 'darwin' },
  );
  const issued = registry.issue(channel, 'copilot-account');
  if (!issued.issued) throw new Error('No offer.');
  return {
    registry,
    channel,
    offer: issued.offer,
    fenced,
    changeFacts: (value: MigrationChannelFacts | null): void => {
      currentFacts = value;
    },
    changeHost: (value: MigrationHostFacts): void => {
      currentHost = value;
    },
    changeGeneration: (): void => {
      generation = 'replacement';
    },
    reenter: (run: () => void): void => {
      onGeneration = run;
    },
    expire: (): void => {
      now = 60_000;
    },
    timeout: (): void => timer(),
  };
}

describe('single-use migration challenge and release authority', () => {
  it.each(['challenge', 'operation', 'purpose'] as const)(
    'rejects wrong %s and burns the challenge',
    (field) => {
      const f = registryFixture();
      const input = { ...presentation(f.offer, f.channel), [field]: 'wrong' };
      const bytes = Buffer.from('sentinel');
      expect(
        f.registry.importSlot(f.offer.sessionId, input, bytes),
      ).toMatchObject({ accepted: false });
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(
        f.registry.importSlot(
          f.offer.sessionId,
          presentation(f.offer, f.channel),
          Buffer.from('sentinel'),
        ),
      ).toMatchObject({ accepted: false });
      expect(f.registry.get(f.offer.sessionId)?.terminalTransitions).toBe(1);
    },
  );
  it.each([
    { ...facts, transport: 'remote' },
    { ...facts, channelId: 'other' },
    { ...facts, launcher: { ...facts.launcher, pid: 43 } },
    { ...facts, launcher: { ...facts.launcher, pidversion: 8 } },
    { ...facts, launcherDigest: 'other' },
    { ...facts, source: { ...source, secureMode: 'other' } },
    null,
  ])('rejects changed channel/process/source evidence %#', (changed) => {
    const f = registryFixture();
    f.changeFacts(changed);
    expect(
      f.registry.importSlot(
        f.offer.sessionId,
        presentation(f.offer, f.channel),
        Buffer.from('value'),
      ),
    ).toMatchObject({ accepted: false });
  });
  it.each(MIGRATION_HOST_FIELDS)(
    'rechecks host %s at presentation',
    (field) => {
      const f = registryFixture();
      f.changeHost({ ...host, [field]: 'other' });
      expect(
        f.registry.importSlot(
          f.offer.sessionId,
          presentation(f.offer, f.channel),
          Buffer.from('value'),
        ),
      ).toMatchObject({ accepted: false, reason: `binding:host:${field}` });
    },
  );
  it('rejects payload-built handles, source replacement and expired sessions', () => {
    for (const mutate of [
      (f: RegistryFixture): void => f.changeGeneration(),
      (f: RegistryFixture): void => f.expire(),
    ]) {
      const f = registryFixture();
      mutate(f);
      expect(
        f.registry.importSlot(
          f.offer.sessionId,
          presentation(f.offer, f.channel),
          Buffer.from('value'),
        ),
      ).toMatchObject({ accepted: false });
    }
    const f = registryFixture();
    expect(
      f.registry.importSlot(
        f.offer.sessionId,
        presentation(f.offer, {}),
        Buffer.from('value'),
      ),
    ).toMatchObject({ accepted: false });
  });
  it('revalidates process identity again at release after an async wait', async () => {
    const f = registryFixture();
    const gate = deferred();
    let released = true;
    const result = f.registry.consume(
      f.offer.sessionId,
      presentation(f.offer, f.channel),
      async (context) => {
        await gate.promise;
        released = context.mayRelease();
        return 'done';
      },
      (value): value is string => value === 'done',
    );
    f.changeFacts({
      ...facts,
      launcher: { ...facts.launcher, pidversion: 999 },
    });
    gate.resolve();
    if (!result.accepted) throw new Error('Not admitted');
    expect(await result.outcome).toMatchObject({ state: 'revoked' });
    expect(released).toBe(false);
  });
  it.each([
    'close',
    'endChannel',
    'ambiguity',
    'timeout',
    'expiry',
    'reentrant',
  ] as const)(
    'never releases after %s while observation waits',
    async (action) => {
      const f = registryFixture();
      const gate = deferred();
      let released = true;
      const result = f.registry.consume(
        f.offer.sessionId,
        presentation(f.offer, f.channel),
        async (context) => {
          await gate.promise;
          released = context.mayRelease();
          return 'done';
        },
        (value): value is string => value === 'done',
      );
      if (action === 'close') f.registry.close();
      if (action === 'endChannel') f.registry.endChannel(f.channel, 'exit');
      if (action === 'ambiguity') f.registry.reportAmbiguity('ambiguous');
      if (action === 'timeout') f.timeout();
      if (action === 'expiry') f.expire();
      if (action === 'reentrant') f.reenter(() => f.registry.close());
      gate.resolve();
      if (!result.accepted) throw new Error('Not admitted');
      // Unsettled initiators are fenced on timeout even without a release.
      expect(await result.outcome).toMatchObject({
        state: action === 'timeout' ? 'uncertain' : 'revoked',
      });
      expect(released).toBe(false);
      expect(f.fenced.size).toBe(action === 'timeout' ? 1 : 0);
      expect(f.registry.get(f.offer.sessionId)?.terminalTransitions).toBe(1);
    },
  );
  it('releases once, fences uncertainty and ignores late fulfilment', async () => {
    const f = registryFixture();
    const gate = deferred();
    const result = f.registry.consume(
      f.offer.sessionId,
      presentation(f.offer, f.channel),
      async (context) => {
        expect(context.mayRelease()).toBe(true);
        expect(context.mayRelease()).toBe(false);
        await gate.promise;
        return 'done';
      },
      (value): value is string => value === 'done',
    );
    f.timeout();
    gate.resolve();
    if (!result.accepted) throw new Error('Not admitted');
    expect(await result.outcome).toMatchObject({ state: 'uncertain' });
    expect(f.fenced.has('generation')).toBe(true);
    expect(f.registry.get(f.offer.sessionId)?.terminalTransitions).toBe(1);
  });
});

let dir: StoreFolder;
let store: VaultStore;
beforeEach(async () => {
  dir = storeFolder();
  store = await dir.opened();
  writeTestHeader(store);
});
afterEach(() => {
  store.close();
  dir.remove();
});
type UseResult = Awaited<
  ReturnType<NonNullable<MigrationFamilyPorts['use']>['use']>
>;
interface ModuleFixture {
  channel: object;
  family: MigrationFamilyPorts;
  options: MigrationModuleOptions;
  importedKeys: string[];
  receipts: Map<
    string,
    Extract<MigrationDeletionResult, { kind: 'completed' }>
  >;
  readonly module: ResumableMigrationModule;
  readonly fixture: MigrationFixture;
  observe(value: MigrationObservation): void;
  supersede(): void;
  reopen(): Promise<void>;
  offer(): Promise<MigrationSessionOffer>;
  import(): Promise<MigrationSessionOutcome<MigrationImportResult>>;
}
function moduleFixture(
  overrides: Partial<MigrationModuleOptions> = {},
  hooks: VaultPutHooks = {},
): ModuleFixture {
  const channel = {};
  let epoch = 1;
  let observed: MigrationObservation = {
    kind: 'present',
    generation: migrationIdentity.generation,
  };
  let fixture = migrationFixture(store, hooks);
  const importedKeys: string[] = [];
  const receipts = new Map<
    string,
    {
      kind: 'completed';
      operationId: string;
      generation: string;
      completionId: string;
    }
  >();
  const snapshot: NonNullable<MigrationFamilyPorts['snapshot']> = {
    observe: jest.fn(() => Promise.resolve(observed)),
    withGeneration: jest.fn(async (_source, run) => run(observed)),
  };
  const family: MigrationFamilyPorts = {
    slot: 'copilot-account',
    snapshot,
    importer: {
      import: jest.fn(async (request) => {
        expect(fixture.migration.read().head.authority).toBe('fenced');
        importedKeys.push(request.idempotencyKey);
        const result = await fixture.writer.put({
          ...importRequest(request.idempotencyKey),
          material: request.value,
        });
        if (result.kind !== 'committed') throw new Error('Import failed');
      }),
    },
    use: {
      use: jest.fn((request) =>
        Promise.resolve({
          kind: 'used' as const,
          receipt: {
            id: 'use-receipt',
            pin: request.pin,
            successorKeys: request.successorKeys,
          },
        }),
      ),
    },
    deletion: {
      remove: jest.fn((request) => {
        const receipt = {
          kind: 'completed',
          operationId: request.operationId,
          generation: request.generation,
          completionId: 'delete-completion',
        } as const;
        receipts.set(request.operationId, receipt);
        observed = { kind: 'absent' };
        return Promise.resolve(receipt);
      }),
      reconcile: jest.fn((request) =>
        Promise.resolve(
          receipts.get(request.operationId) ?? { kind: 'absent' as const },
        ),
      ),
    },
  };
  const options: MigrationModuleOptions = {
    admission: {
      channel: (handle) => (handle === channel ? facts : null),
      host: () => host,
    },
    storage: fixture.migration,
    brand: 'canopy',
    build: 'internal',
    source,
    os: 'darwin',
    epoch: () => epoch,
    families: [family],
    ...overrides,
  };
  let module = createResumableMigrationModule(options);
  return {
    channel,
    family,
    options,
    importedKeys,
    receipts,
    get module(): ResumableMigrationModule {
      return module;
    },
    get fixture(): MigrationFixture {
      return fixture;
    },
    observe: (value: MigrationObservation): void => {
      observed = value;
    },
    supersede: (): void => {
      epoch += 1;
      fixture.migration.supersede(epoch, 'sign-out');
    },
    reopen: async (): Promise<void> => {
      module.close();
      store.close();
      store = await dir.opened();
      fixture = migrationFixture(store);
      module = createResumableMigrationModule({
        ...options,
        storage: fixture.migration,
      });
    },
    offer: async (): Promise<MigrationSessionOffer> => {
      const result = await module.issue(channel, 'copilot-account');
      if (!result.issued) throw new Error(`No offer: ${result.reason}`);
      return result.offer;
    },
    import: async (): Promise<
      MigrationSessionOutcome<MigrationImportResult>
    > => {
      const issued = await module.issue(channel, 'copilot-account');
      if (!issued.issued) throw new Error(`No offer: ${issued.reason}`);
      const value = Buffer.from('credential-sentinel');
      const result = module.importSlot(
        issued.offer.sessionId,
        presentation(issued.offer, channel),
        value,
      );
      if (!result.accepted) throw new Error('Not admitted');
      const outcome = await result.outcome;
      expect(value.every((byte) => byte === 0)).toBe(true);
      return outcome;
    },
  };
}

describe('P2 resumable protocol over P1 durable storage (inert)', () => {
  it.each([60_000, 61_000])(
    'selects an import committed at %s after presentation expiry but before settlement',
    async (committedAt) => {
      let now = 0;
      const f = moduleFixture({
        clock: {
          now: () => now,
          setTimer: () => ({ cancel: (): void => {} }),
        },
      });
      const importer = f.family.importer;
      if (!importer) throw new Error('Missing importer');
      const importValue = importer.import.bind(importer);
      const entered = deferred();
      const gate = deferred();
      importer.import = async (request): Promise<void> => {
        entered.resolve();
        await gate.promise;
        await importValue(request);
      };
      const offer = await f.offer();
      now = 45_000;
      const value = Buffer.from('credential-sentinel');
      const result = f.module.importSlot(
        offer.sessionId,
        presentation(offer, f.channel),
        value,
      );
      if (!result.accepted) throw new Error('Not admitted');
      await entered.promise;
      expect(f.fixture.migration.read().head.authority).toBe('fenced');
      now = committedAt;
      gate.resolve();
      expect(await result.outcome).toMatchObject({ state: 'completed' });
      expect(f.fixture.migration.read()).toMatchObject({
        head: { authority: 'vault' },
        attempts: [{ state: 'imported_unverified' }],
      });
      expect(f.module.get(offer.sessionId)).toMatchObject({
        state: 'completed',
        terminalTransitions: 1,
      });
      expect(f.importedKeys).toHaveLength(1);
      expect(store.listEntries()).toHaveLength(1);
      expect(value.every((byte) => byte === 0)).toBe(true);
      await f.reopen();
      expect(await f.module.reconcile()).toMatchObject({
        state: 'imported_unverified',
        authority: 'vault',
      });
    },
  );
  it('imports, selects, verifies actual use and closes exact-generation cleanup across reopen', async () => {
    const f = moduleFixture();
    expect(await f.import()).toMatchObject({ state: 'completed' });
    expect(await f.module.deleteLegacy()).toEqual({ kind: 'unresolved' });
    await f.reopen();
    expect(await f.module.reconcile()).toMatchObject({
      state: 'imported_unverified',
      authority: 'vault',
    });
    expect(await f.module.verify()).toMatchObject({ state: 'verified' });
    await f.reopen();
    expect(await f.module.deleteLegacy()).toMatchObject({
      state: 'legacy_deleted',
    });
    await f.reopen();
    expect(await f.module.reconcile()).toMatchObject({
      state: 'legacy_deleted',
      authority: 'vault',
    });
    f.supersede();
    expect(await f.module.reconcile()).toEqual({ kind: 'not_started' });
    expect(f.fixture.migration.read().attempts[0]?.state).toBe(
      'legacy_deleted',
    );
    expect(await f.module.issue(f.channel, 'copilot-account')).toMatchObject({
      issued: false,
    });
    expect(store.readMigrationJournal()).not.toContain('credential-sentinel');
  });
  it.each(['snapshot', 'importer', 'use', 'deletion'] as const)(
    'never offers a family missing %s',
    async (missing) => {
      const f = moduleFixture();
      const partial = { ...f.family, [missing]: undefined };
      const module = createResumableMigrationModule({
        ...f.options,
        families: [partial],
      });
      expect(await module.issue(f.channel, 'copilot-account')).toMatchObject({
        issued: false,
        reason: 'slot-unavailable',
      });
      expect(store.listEntries()).toHaveLength(0);
    },
  );
  it('refuses duplicate families, unsupported slots and Linux Copilot', async () => {
    const f = moduleFixture();
    expect(() =>
      createResumableMigrationModule({
        ...f.options,
        families: [f.family, f.family],
      }),
    ).toThrow('Duplicate');
    for (const slot of [
      'github-pat',
      'linear-token',
      'mcp-oauth-tokens',
      'cloud-account',
      'user-environment-secrets',
      '../copilot-account',
      '',
    ]) {
      expect(await f.module.issue(f.channel, slot)).toMatchObject({
        issued: false,
      });
    }
    const linux = createResumableMigrationModule({ ...f.options, os: 'linux' });
    expect(await linux.issue(f.channel, 'copilot-account')).toMatchObject({
      issued: false,
      reason: 'slot-unavailable',
    });
  });
  it('never offers any allowlisted family on Linux', async () => {
    const f = moduleFixture();
    const linux = createResumableMigrationModule({ ...f.options, os: 'linux' });
    const results = await Promise.all(
      MIGRATION_SLOTS_AT_PIN.map((slot) => linux.issue(f.channel, slot.id)),
    );
    expect(results.filter((result) => result.issued)).toEqual([]);
    expect(f.family.snapshot).toHaveProperty('observe.mock.calls', []);
  });
  it.each(['absent', 'malformed', 'unreadable', 'outcome_unknown'] as const)(
    'preserves the %s observation disposition',
    async (kind) => {
      const f = moduleFixture();
      f.observe({ kind });
      expect(await f.module.issue(f.channel, 'copilot-account')).toMatchObject({
        issued: false,
        reason: `source:${kind}`,
      });
      expect(f.fixture.migration.read().attempts).toHaveLength(0);
    },
  );
  it('refuses Linux recovery, use and deletion of a supported-host attempt', async () => {
    const f = moduleFixture();
    await f.import();
    const linux = createResumableMigrationModule({ ...f.options, os: 'linux' });
    expect(await linux.reconcile()).toEqual({ kind: 'unavailable' });
    expect(await linux.verify()).toEqual({ kind: 'unavailable' });
    expect(f.family.use).toHaveProperty('use.mock.calls', []);
    await f.module.verify();
    expect(await linux.deleteLegacy()).toEqual({ kind: 'unavailable' });
    expect(f.family.deletion).toHaveProperty('remove.mock.calls', []);
    expect(f.fixture.migration.read().attempts[0]?.state).toBe('verified');
  });
  it('revalidates the source under the mutation queue before any import', async () => {
    const f = moduleFixture();
    const offer = await f.offer();
    f.observe({ kind: 'present', generation: 'replacement' });
    const value = Buffer.from('sentinel');
    const result = f.module.importSlot(
      offer.sessionId,
      presentation(offer, f.channel),
      value,
    );
    if (!result.accepted) throw new Error('Not admitted');
    expect(await result.outcome).toMatchObject({ state: 'revoked' });
    expect(value.every((byte) => byte === 0)).toBe(true);
    expect(f.importedKeys).toHaveLength(0);
    expect(f.fixture.migration.read().attempts).toHaveLength(0);
  });
  it('reconciles a committed import whose reply was lost without a second create', async () => {
    const f = moduleFixture();
    const original = f.family.importer;
    if (!original) throw new Error('Missing importer');
    const module = createResumableMigrationModule({
      ...f.options,
      families: [
        {
          ...f.family,
          importer: {
            import: async (request): Promise<void> => {
              await original.import(request);
              throw new Error('secret-sentinel-lost-reply');
            },
          },
        },
      ],
    });
    const issued = await module.issue(f.channel, 'copilot-account');
    if (!issued.issued) throw new Error('No offer');
    const result = module.importSlot(
      issued.offer.sessionId,
      presentation(issued.offer, f.channel),
      Buffer.from('sentinel'),
    );
    if (!result.accepted) throw new Error('Not admitted');
    expect(await result.outcome).toEqual({
      state: 'uncertain',
      reason: 'rejected',
    });
    expect(f.fixture.migration.read().attempts[0]?.state).toBe('not_started');
    await f.reopen();
    expect(await f.module.reconcile()).toMatchObject({
      state: 'imported_unverified',
      authority: 'vault',
    });
    expect(f.importedKeys).toHaveLength(1);
    expect(store.listEntries()).toHaveLength(1);
  });
  it('reuses the prepared attempt and stable key after interrupted pre-intent import', async () => {
    const f = moduleFixture();
    const attempt = f.fixture.migration.prepare(migrationIdentity, 1);
    await f.reopen();
    expect(await f.import()).toMatchObject({ state: 'completed' });
    expect(f.importedKeys).toEqual([f.fixture.migration.importKey(attempt.id)]);
    expect(f.fixture.migration.read().attempts).toHaveLength(1);
  });
  it('recovers submitted deletion by exact operation receipt, never by absence', async () => {
    const f = moduleFixture();
    await f.import();
    await f.module.verify();
    const attempt = f.fixture.migration.read().attempts[0];
    if (!attempt) throw new Error('No attempt');
    f.fixture.migration.authorizeDeletion(attempt.id, 1, 'delete-operation');
    f.fixture.migration.deletionReceipt(
      attempt.id,
      1,
      'delete-operation',
      migrationIdentity.generation,
      null,
    );
    f.observe({ kind: 'absent' });
    await f.reopen();
    expect(await f.module.deleteLegacy()).toEqual({ kind: 'unresolved' });
    expect(f.fixture.migration.read().attempts[0]?.state).toBe('verified');
    f.receipts.set('delete-operation', {
      kind: 'completed',
      operationId: 'delete-operation',
      generation: migrationIdentity.generation,
      completionId: 'completion',
    });
    expect(await f.module.deleteLegacy()).toMatchObject({
      state: 'legacy_deleted',
    });
  });
  it('preserves a source replacement before delete and rejects forged completion generations', async () => {
    const f = moduleFixture();
    await f.import();
    await f.module.verify();
    f.observe({ kind: 'present', generation: 'replacement' });
    expect(await f.module.deleteLegacy()).toEqual({ kind: 'stale' });
    expect(f.family.deletion).toHaveProperty('remove.mock.calls', []);
    const attempt = f.fixture.migration.read().attempts[0];
    const operation = attempt?.deletion;
    if (!attempt || !operation) throw new Error('No operation');
    f.fixture.migration.deletionReceipt(
      attempt.id,
      1,
      operation.id,
      operation.generation,
      null,
    );
    f.receipts.set(operation.id, {
      kind: 'completed',
      operationId: operation.id,
      generation: 'replacement',
      completionId: 'completion',
    });
    expect(await f.module.deleteLegacy()).toEqual({ kind: 'unavailable' });
    expect(f.fixture.migration.read().attempts[0]?.state).toBe('verified');
  });
  it('refuses import acknowledgements without actual intent provenance, then resumes the same attempt', async () => {
    const f = moduleFixture();
    const module = createResumableMigrationModule({
      ...f.options,
      families: [
        {
          ...f.family,
          importer: {
            import: (): Promise<void> => Promise.resolve(),
          },
        },
      ],
    });
    const issued = await module.issue(f.channel, 'copilot-account');
    if (!issued.issued) throw new Error('No offer');
    const result = module.importSlot(
      issued.offer.sessionId,
      presentation(issued.offer, f.channel),
      Buffer.from('sentinel'),
    );
    if (!result.accepted) throw new Error('Not admitted');
    expect(await result.outcome).toMatchObject({ state: 'uncertain' });
    expect(f.fixture.migration.read().attempts[0]?.state).toBe('not_started');
    expect(await f.module.verify()).toEqual({ kind: 'unresolved' });
    expect(await f.module.deleteLegacy()).toEqual({ kind: 'unresolved' });
  });
  it.each([0, 1_048_577])(
    'rejects bounded plaintext length %s without retaining bytes',
    async (length) => {
      const f = moduleFixture();
      const offer = await f.offer();
      const value = Buffer.alloc(length, 7);
      expect(
        f.module.importSlot(
          offer.sessionId,
          presentation(offer, f.channel),
          value,
        ),
      ).toMatchObject({ accepted: false });
      expect(value.every((byte) => byte === 0)).toBe(true);
      expect(f.importedKeys).toHaveLength(0);
    },
  );
  it.each([1, 1_000_000])(
    'imports supported plaintext boundary %s',
    async (length) => {
      const f = moduleFixture();
      const offer = await f.offer();
      const bytes = Buffer.alloc(length, 7);
      const result = f.module.importSlot(
        offer.sessionId,
        presentation(offer, f.channel),
        bytes,
      );
      if (!result.accepted) throw new Error('Not admitted');
      expect(await result.outcome).toMatchObject({ state: 'completed' });
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(store.listEntries()).toHaveLength(1);
    },
  );
  it('rejects a deletion completion arriving after durable sign-out', async () => {
    const f = moduleFixture();
    await f.import();
    await f.module.verify();
    const gate = deferred();
    const entered = deferred();
    const module = createResumableMigrationModule({
      ...f.options,
      families: [
        {
          ...f.family,
          deletion: {
            remove: async (request): Promise<MigrationDeletionResult> => {
              entered.resolve();
              await gate.promise;
              return {
                kind: 'completed',
                operationId: request.operationId,
                generation: request.generation,
                completionId: 'late-completion',
              };
            },
            reconcile: (): Promise<MigrationDeletionResult> =>
              Promise.resolve({ kind: 'outcome_unknown' }),
          },
        },
      ],
    });
    const pending = module.deleteLegacy();
    await entered.promise;
    f.supersede();
    gate.resolve();
    expect(await pending).toEqual({ kind: 'unavailable' });
    expect(f.fixture.migration.read().head.authority).toBe('cleared');
    expect(f.fixture.migration.read().attempts[0]?.state).toBe('verified');
  });
  it('does not select an import that completes after channel retirement', async () => {
    const f = moduleFixture();
    const gate = deferred();
    const entered = deferred();
    const original = f.family.importer;
    if (!original) throw new Error('No importer');
    const module = createResumableMigrationModule({
      ...f.options,
      families: [
        {
          ...f.family,
          importer: {
            import: async (request): Promise<void> => {
              await original.import(request);
              entered.resolve();
              await gate.promise;
            },
          },
        },
      ],
    });
    const offer = await module.issue(f.channel, 'copilot-account');
    if (!offer.issued) throw new Error('No offer');
    const result = module.importSlot(
      offer.offer.sessionId,
      presentation(offer.offer, f.channel),
      Buffer.from('sentinel'),
    );
    if (!result.accepted) throw new Error('Not admitted');
    await entered.promise;
    module.endChannel(f.channel, 'exit');
    gate.resolve();
    expect(await result.outcome).toMatchObject({ state: 'uncertain' });
    // Let the underlying importer settle; this is not a timer/poll.
    await gate.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(f.fixture.migration.read().head.authority).toBe('fenced');
    await f.reopen();
    expect(await f.module.reconcile()).toMatchObject({ authority: 'vault' });
  });
  it('rejects late use receipts after clear/reconnect and refuses reentrant operations', async () => {
    const f = moduleFixture();
    await f.import();
    const gate = deferred();
    const entered = deferred();
    const module = createResumableMigrationModule({
      ...f.options,
      families: [
        {
          ...f.family,
          use: {
            use: async (request): Promise<UseResult> => {
              entered.resolve();
              await gate.promise;
              return {
                kind: 'used',
                receipt: {
                  id: 'use',
                  pin: request.pin,
                  successorKeys: request.successorKeys,
                },
              };
            },
          },
        },
      ],
    });
    const pending = module.verify();
    await entered.promise;
    expect(await module.deleteLegacy()).toEqual({ kind: 'busy' });
    f.supersede();
    gate.resolve();
    expect(await pending).toEqual({ kind: 'unavailable' });
    expect(f.fixture.migration.read().attempts[0]?.state).toBe(
      'imported_unverified',
    );
  });
  it('wire permits no supplied source/path/use/deletion proof and retains distinct declines', () => {
    for (const type of ['verify', 'delete', 'reconcile']) {
      expect(
        parseMigrationLauncherFrame({
          protocol: 'canopy.vault.migration',
          version: 1,
          type,
        }).ok,
      ).toBe(false);
    }
    for (const reason of [
      'absent',
      'malformed',
      'unreadable',
      'outcome_unknown',
    ] as const) {
      const wire = encodeMigrationFrame({
        type: 'decline',
        sessionId: '0'.repeat(32),
        challenge: 'a'.repeat(43),
        operation: 'import',
        purpose: 'legacy-slot-import',
        reason,
      });
      expect(parseMigrationLauncherFrame(wire)).toMatchObject({
        ok: true,
        frame: { reason },
      });
      expect(
        parseMigrationLauncherFrame({
          ...wire,
          path: '/chosen',
          source: 'forged',
        }).ok,
      ).toBe(false);
    }
  });
  it('retries an interrupted durable intent with its original ref and key', async () => {
    const f = moduleFixture(
      {},
      {
        holdPut: () => Promise.reject(new Error('interrupted')),
      },
    );
    expect(await f.import()).toMatchObject({ state: 'uncertain' });
    const before = f.fixture.migration.read().attempts[0];
    if (!before?.destination) throw new Error('No intent');
    const key = f.fixture.migration.importKey(before.id);
    expect(f.fixture.migration.resolve(before.id).kind).toBe('not_committed');
    await f.reopen();
    expect(await f.import()).toMatchObject({ state: 'completed' });
    expect(f.importedKeys).toEqual([key, key]);
    expect(f.fixture.migration.read().attempts[0]?.destination?.entryId).toBe(
      before.destination.entryId,
    );
    expect(store.listEntries()).toHaveLength(1);
  });
  it('never mistakes a running import for a definite non-commit on another module', async () => {
    const entered = deferred();
    const gate = deferred();
    const f = moduleFixture(
      {},
      {
        holdPut: async () => {
          entered.resolve();
          await gate.promise;
        },
      },
    );
    const pending = f.import();
    await entered.promise;
    const fresh = createResumableMigrationModule(f.options);
    expect(await fresh.reconcile()).toEqual({ kind: 'unresolved' });
    expect(await fresh.issue(f.channel, 'copilot-account')).toMatchObject({
      issued: false,
    });
    gate.resolve();
    expect(await pending).toMatchObject({ state: 'completed' });
  });
  it.each(['before', 'after'] as const)(
    'recovers a %s-write use receipt failure without inferring verification',
    async (edge) => {
      const f = moduleFixture();
      await f.import();
      const module = createResumableMigrationModule({
        ...f.options,
        storage: {
          ...f.fixture.migration,
          recordUse: (...args) => {
            if (edge === 'after') f.fixture.migration.recordUse(...args);
            throw new Error('receipt write lost');
          },
        },
      });
      expect(await module.verify()).toEqual({ kind: 'unavailable' });
      expect(f.fixture.migration.read().attempts[0]?.state).toBe(
        edge === 'after' ? 'verified' : 'imported_unverified',
      );
      await f.reopen();
      expect(await f.module.verify()).toMatchObject({ state: 'verified' });
    },
  );
  it('recovers a delete applied before a lost response without unlinking again', async () => {
    const f = moduleFixture();
    await f.import();
    await f.module.verify();
    const adapter = f.family.deletion;
    if (!adapter) throw new Error('No deletion adapter');
    const module = createResumableMigrationModule({
      ...f.options,
      families: [
        {
          ...f.family,
          deletion: {
            ...adapter,
            remove: async (request): Promise<MigrationDeletionResult> => {
              await adapter.remove(request);
              throw new Error('lost response');
            },
          },
        },
      ],
    });
    expect(await module.deleteLegacy()).toEqual({ kind: 'unavailable' });
    expect(f.fixture.migration.read().attempts[0]?.deletion?.phase).toBe(
      'submitted',
    );
    await f.reopen();
    expect(await f.module.deleteLegacy()).toMatchObject({
      state: 'legacy_deleted',
    });
    expect(adapter).toHaveProperty('remove.mock.calls.length', 1);
  });
  it('cannot use a pre-signout offer to prepare in a later epoch', async () => {
    const f = moduleFixture();
    const offer = await f.offer();
    f.supersede();
    expect(
      f.module.importSlot(
        offer.sessionId,
        presentation(offer, f.channel),
        Buffer.from('sentinel'),
      ),
    ).toMatchObject({ accepted: false });
    expect(f.fixture.migration.read().attempts).toHaveLength(0);
  });
  it('fails closed on unavailable or invalid epochs without stranding issue or retaining plaintext', async () => {
    for (const invalid of [null, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const f = moduleFixture();
      let unavailable = true;
      const module = createResumableMigrationModule({
        ...f.options,
        epoch: () => {
          if (!unavailable) return 1;
          if (invalid === null) throw new Error('epoch-secret-sentinel');
          return invalid;
        },
      });
      expect(await module.issue(f.channel, 'copilot-account')).toMatchObject({
        issued: false,
      });
      unavailable = false;
      const issued = await module.issue(f.channel, 'copilot-account');
      if (!issued.issued) throw new Error('Issue stranded');
      unavailable = true;
      const bytes = Buffer.from('plaintext');
      expect(
        module.importSlot(
          issued.offer.sessionId,
          presentation(issued.offer, f.channel),
          bytes,
        ),
      ).toMatchObject({ accepted: false });
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(f.importedKeys).toHaveLength(0);
    }
  });
  it('refuses receipt pins not bound to the actually committed lineage', async () => {
    const f = moduleFixture();
    await f.import();
    const module = createResumableMigrationModule({
      ...f.options,
      families: [
        {
          ...f.family,
          use: {
            use: (request): Promise<UseResult> =>
              Promise.resolve({
                kind: 'used',
                receipt: {
                  id: 'forged',
                  pin: { ...request.pin, revision: request.pin.revision + 1 },
                  successorKeys: request.successorKeys,
                },
              }),
          },
        },
      ],
    });
    expect(await module.verify()).toEqual({ kind: 'unavailable' });
    expect(f.fixture.migration.read().attempts[0]?.state).toBe(
      'imported_unverified',
    );
  });
  it('does not issue across ambiguity or an account change during async observation', async () => {
    for (const action of ['ambiguity', 'epoch', 'close']) {
      const f = moduleFixture();
      const entered = deferred();
      const gate = deferred();
      const snapshot = f.family.snapshot;
      if (!snapshot) throw new Error('No snapshot');
      const module = createResumableMigrationModule({
        ...f.options,
        families: [
          {
            ...f.family,
            snapshot: {
              ...snapshot,
              observe: async (): Promise<MigrationObservation> => {
                entered.resolve();
                await gate.promise;
                return {
                  kind: 'present',
                  generation: migrationIdentity.generation,
                };
              },
            },
          },
        ],
      });
      const pending = module.issue(f.channel, 'copilot-account');
      await entered.promise;
      if (action === 'ambiguity') module.reportAmbiguity('ambiguity');
      if (action === 'epoch') f.supersede();
      if (action === 'close') module.close();
      gate.resolve();
      expect(await pending).toMatchObject({ issued: false });
    }
  });
  it('a stale offer on a second module cannot invoke import again', async () => {
    const f = moduleFixture();
    const other = createResumableMigrationModule(f.options);
    const offered = await other.issue(f.channel, 'copilot-account');
    if (!offered.issued) throw new Error('No offer');
    expect(await f.import()).toMatchObject({ state: 'completed' });
    const value = Buffer.from('second-value');
    const result = other.importSlot(
      offered.offer.sessionId,
      presentation(offered.offer, f.channel),
      value,
    );
    if (!result.accepted) throw new Error('Not admitted');
    expect(await result.outcome).toMatchObject({ state: 'revoked' });
    expect(other.get(offered.offer.sessionId)?.released).toBe(false);
    expect(f.family.importer).toHaveProperty('import.mock.calls.length', 1);
    expect(value.every((byte) => byte === 0)).toBe(true);
    other.close();
  });

  it('queued deletion never replays remove after another module submits it', async () => {
    const f = moduleFixture();
    await f.import();
    await f.module.verify();
    const remove = jest.fn(
      (): Promise<MigrationDeletionResult> =>
        Promise.resolve({
          kind: 'outcome_unknown',
        }),
    );
    const reconcile = jest.fn((): Promise<MigrationDeletionResult> => {
      expect(held).toBe(false);
      return Promise.resolve({ kind: 'outcome_unknown' });
    });
    let queue = Promise.resolve();
    let held = false;
    const snapshot: NonNullable<MigrationFamilyPorts['snapshot']> = {
      observe: () =>
        Promise.resolve({
          kind: 'present',
          generation: migrationIdentity.generation,
        }),
      withGeneration: (_source, run) => {
        const pending = queue.then(async () => {
          held = true;
          try {
            return await run({
              kind: 'present',
              generation: migrationIdentity.generation,
            });
          } finally {
            held = false;
          }
        });
        queue = pending.then(
          () => undefined,
          () => undefined,
        );
        return pending;
      },
    };
    const options = {
      ...f.options,
      families: [{ ...f.family, snapshot, deletion: { remove, reconcile } }],
    };
    const first = createResumableMigrationModule(options);
    const second = createResumableMigrationModule(options);
    const results = await Promise.all([
      first.deleteLegacy(),
      second.deleteLegacy(),
    ]);
    expect(results).toEqual([{ kind: 'unresolved' }, { kind: 'unresolved' }]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    first.close();
    second.close();
  });

  it('epoch-provider retirement at final issue revalidation cannot issue', async () => {
    const f = moduleFixture();
    const snapshot = f.family.snapshot;
    if (!snapshot) throw new Error('No snapshot');
    let observed = false;
    let revalidated = false;
    const module = createResumableMigrationModule({
      ...f.options,
      admission: {
        ...f.options.admission,
        host: () => {
          if (observed) revalidated = true;
          return host;
        },
      },
      families: [
        {
          ...f.family,
          snapshot: {
            ...snapshot,
            observe: (identity): Promise<MigrationObservation> => {
              observed = true;
              return snapshot.observe(identity);
            },
          },
        },
      ],
      epoch: () => {
        if (revalidated) module.reportAmbiguity('retired-during-epoch-read');
        return 1;
      },
    });
    expect(await module.issue(f.channel, 'copilot-account')).toMatchObject({
      issued: false,
    });
    module.close();
  });

  it('epoch-provider retirement at receipt revalidation cannot verify', async () => {
    const f = moduleFixture();
    await f.import();
    let used = false;
    const original = f.family.use;
    if (!original) throw new Error('No use');
    const module = createResumableMigrationModule({
      ...f.options,
      epoch: () => {
        if (used) module.close();
        return 1;
      },
      families: [
        {
          ...f.family,
          use: {
            use: async (request): Promise<UseResult> => {
              const result = await original.use(request);
              used = true;
              return result;
            },
          },
        },
      ],
    });
    expect(await module.verify()).toEqual({ kind: 'unavailable' });
    expect(f.fixture.migration.read().attempts[0]?.state).toBe(
      'imported_unverified',
    );
  });

  it.each([
    ['authorization', 'before'],
    ['authorization', 'after'],
    ['submission', 'before'],
    ['submission', 'after'],
    ['completion', 'before'],
    ['completion', 'after'],
  ] as const)(
    'reopens across a %s %s-write crash without losing deletion identity',
    async (boundary, edge) => {
      const f = moduleFixture();
      await f.import();
      await f.module.verify();
      const durable = f.fixture.migration;
      const adapter = f.family.deletion;
      const snapshot = f.family.snapshot;
      if (!adapter || !snapshot) throw new Error('Incomplete family');
      const fault = (write: () => void): void => {
        if (edge === 'after') write();
        throw new Error('crash-at-durable-edge');
      };
      const interrupted = createResumableMigrationModule({
        ...f.options,
        storage: {
          ...durable,
          authorizeDeletion: (...args) => {
            if (boundary === 'authorization')
              fault(() => durable.authorizeDeletion(...args));
            else durable.authorizeDeletion(...args);
          },
          deletionReceipt: (...args) => {
            const phase = args[4] === null ? 'submission' : 'completion';
            if (boundary === phase)
              fault(() => durable.deletionReceipt(...args));
            else durable.deletionReceipt(...args);
          },
        },
      });
      expect(await interrupted.deleteLegacy()).toEqual({ kind: 'unavailable' });
      const before = durable.read().attempts[0]?.deletion;
      expect(adapter).toHaveProperty(
        'remove.mock.calls.length',
        boundary === 'completion' ? 1 : 0,
      );
      interrupted.close();
      await f.reopen();
      const recovered = createResumableMigrationModule({
        ...f.options,
        storage: f.fixture.migration,
        families: [
          {
            ...f.family,
            deletion: {
              ...adapter,
              reconcile: async (request): Promise<MigrationDeletionResult> => {
                const receipt = f.receipts.get(request.operationId);
                if (receipt) return receipt;
                // A trusted adapter may finish the same submitted operation after revalidation.
                return snapshot.withGeneration(source, async (observed) =>
                  observed.kind === 'present' &&
                  observed.generation === request.generation
                    ? adapter.remove(request)
                    : { kind: 'outcome_unknown' },
                );
              },
            },
          },
        ],
      });
      expect(await recovered.deleteLegacy()).toMatchObject({
        state: 'legacy_deleted',
      });
      const after = f.fixture.migration.read().attempts[0]?.deletion;
      if (before) expect(after?.id).toBe(before.id);
      expect(adapter).toHaveProperty('remove.mock.calls.length', 1);
      recovered.close();
    },
  );
  it('pins the Electron production role disabled and Copilot custody reserved', () => {
    expect(
      readFileSync(
        'apps/desktop-app/src/main/canopy-runtime/migration-channel.ts',
        'utf8',
      ),
    ).toMatch(
      /ELECTRON_MIGRATION_ROLE\s*=\s*Object.freeze\(\{\s*enabled: false/,
    );
    expect(
      readFileSync(
        'packages/core-runtime/src/node/vault/daemon-vault.ts',
        'utf8',
      ),
    ).toContain("'copilot-account'");
  });
});

it('P7 preflight shares presentation/expiry/reentrancy admission without consuming release', () => {
  const f = registryFixture();
  const p = presentation(f.offer, f.channel);
  expect(f.registry.preflight(f.offer.sessionId, p).accepted).toBe(true);
  expect(f.registry.preflight(f.offer.sessionId, p).accepted).toBe(true);
  expect(f.registry.get(f.offer.sessionId)).toMatchObject({
    state: 'issued',
    released: false,
  });
  f.reenter(() => f.registry.reportAmbiguity('preflight-reentrancy'));
  expect(f.registry.preflight(f.offer.sessionId, p).accepted).toBe(false);
  expect(f.registry.get(f.offer.sessionId)?.released).toBe(false);
});
