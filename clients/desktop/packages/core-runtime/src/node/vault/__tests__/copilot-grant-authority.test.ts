import { readFileSync } from 'node:fs';
import {
  CORE_VAULT_QUERY_DEFINITIONS,
  CORE_VAULT_INSTRUCTION_DEFINITIONS,
  VaultEntryMetadataSchema,
} from '@canopy/protocol/canopy-core';
import type { CopilotHostSelection } from '@canopy/protocol/copilot-selection';
import type {
  VaultFamilyWriter,
  VaultPutOutcome,
  VaultRepository,
} from '../../../vault/contracts';
import { createMemoryVaultRepository } from '../../../vault/testing/memory-repository';
import { createCopilotVaultGrantAuthority } from '../copilot-grant-authority';
import {
  CopilotAuthorityRecordSchema,
  CopilotAuthorityJournalError,
  type CopilotAuthorityJournal,
  type CopilotAuthorityRecord,
  type CopilotGrantAuthorityOptions,
  type CopilotGrantHead,
  type CopilotGrantResult,
  type CopilotVaultGrant,
  type CopilotVaultGrantAuthority,
  CopilotVaultGrantSchema,
} from '../copilot-grant-contracts';
import { createFakeSecretProtection } from '../../../platform/testing/fake-secret-protection';
import {
  openVaultReadRepository,
  type VaultReadRepository,
} from '../repository/read-repository';
import {
  storeFolder,
  type StoreFolder,
} from '../repository/__tests__/store-fixtures';
import type { VaultStore } from '../repository/store';

const ACCESS = 'access-secret-sentinel';
const REFRESH = 'refresh-secret-sentinel';
const NOW = Date.parse('2026-11-06T10:00:00Z');

describe('P8 terminal family quiescence', () => {
  it('permanently fences empty setup, reopen and later factories sharing the owner', async () => {
    const h = harness();
    const a = h.create();
    const drained = a.quiesce();
    expect(a.quiesce()).toBe(drained);
    a.reopen();
    expect(a.recipientGeneration()).toBeUndefined();
    expect((await a.create(grant(), 'setup')).kind).toBe('blocked');
    const later = h.create();
    later.reopen();
    expect(later.recipientGeneration()).toBeUndefined();
    expect((await later.create(grant(), 'setup')).kind).toBe('blocked');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
    await drained;
  });

  it('releases only the wait at exactly 2000 ms, preserving a late owned successor without delivery', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      const entered = deferred<void>();
      const response =
        deferred<
          Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
        >();
      h.refresh.mockImplementationOnce(() => {
        entered.resolve();
        return response.promise;
      });
      const first = a.present('recipient', head.epoch);
      await entered.promise;
      const mutation = structuredClone(h.state().mutation);
      let completed = false;
      const drain = a.quiesce();
      void drain.then(() => {
        completed = true;
      });
      expect(a.quiesce()).toBe(drain);
      expect(a.recipientGeneration()).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1_999);
      expect(completed).toBe(false);
      expect(h.state().mutation).toEqual(mutation);
      await jest.advanceTimersByTimeAsync(1);
      expect(completed).toBe(true);
      expect(h.state().mutation).toEqual(mutation);
      const committed = deferred<void>();
      const cas = h.journal.compareExchange.bind(h.journal);
      h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
        const accepted = await cas(sequence, next);
        if (accepted && next.head?.pin.revision === head.pin.revision + 1)
          committed.resolve();
        return accepted;
      };
      response.resolve({ kind: 'success', grant: grant('-after-cap') });
      expect((await first).kind).toBe('blocked');
      await committed.promise;
      expect(h.state().head?.pin.revision).toBe(head.pin.revision + 1);
      expect(h.state().mutation).toBeNull();
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(h.deliver).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('includes response-created persistence in the owned drain before the cap', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      const entered = deferred<void>();
      const response =
        deferred<
          Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
        >();
      h.refresh.mockImplementationOnce(() => {
        entered.resolve();
        return response.promise;
      });
      const first = a.present('recipient', head.epoch);
      await entered.promise;
      const storing = deferred<void>();
      const release = deferred<void>();
      h.put.mockImplementationOnce(async (request) => {
        storing.resolve();
        await release.promise;
        return h.raw.put(request);
      });
      let completed = false;
      const drain = a.quiesce().then(() => {
        completed = true;
      });
      response.resolve({ kind: 'success', grant: grant('-during-drain') });
      await storing.promise;
      await jest.advanceTimersByTimeAsync(100);
      expect(completed).toBe(false);
      release.resolve();
      await drain;
      expect((await first).kind).toBe('blocked');
      expect(h.state().head?.pin.revision).toBe(head.pin.revision + 1);
      expect(h.deliver).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
function expectNoGrantSecrets(value: unknown): void {
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    expect(bytes.includes(Buffer.from(ACCESS))).toBe(false);
    expect(bytes.includes(Buffer.from(REFRESH))).toBe(false);
  } else if (typeof value === 'string') {
    expect(value).not.toContain(ACCESS);
    expect(value).not.toContain(REFRESH);
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      expectNoGrantSecrets(key);
      expectNoGrantSecrets(nested);
    }
  }
}
describe('P8 operation-scoped pending removal', () => {
  it('refuses an identity changed between lookup and the authenticated fence CAS', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 1), 'setup'));
    h.nextPut({ kind: 'blocked', reason: 'locked' });
    await a.present('first', head.epoch);
    await h.writesSettled();
    const before = structuredClone(h.state());
    const id = before.mutation?.operationId;
    if (!id) throw new Error('Missing pending operation');
    const cas = h.journal.compareExchange.bind(h.journal);
    let raced = false;
    h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
      if (!raced && next.removal) {
        raced = true;
        h.replaceState({
          ...before,
          sequence: before.sequence + 1,
          mutation: before.mutation
            ? { ...before.mutation, operationId: 'newer-operation' }
            : null,
        });
      }
      return cas(sequence, next);
    };
    expect((await a.removePending(id)).kind).toBe('blocked');
    expect(h.state().head).toEqual(head);
    expect(h.state().mutation?.operationId).toBe('newer-operation');
    expect(h.state().removal).toBeNull();
    expect(h.disable).not.toHaveBeenCalled();
    expect(h.deletion).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('fences a live provider before exact removal so its late successor cannot resurrect or deliver', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      const started = deferred<void>();
      const response =
        deferred<
          Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
        >();
      h.refresh.mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      const presenting = a.present('old', head.epoch);
      await started.promise;
      const id = h.state().mutation?.operationId;
      if (!id) throw new Error('Missing live operation');
      const removing = a.removePending(id);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(await removing).toEqual({ kind: 'removed' });
      response.resolve({ kind: 'success', grant: grant('-late') });
      expect((await presenting).kind).toBe('blocked');
      await h.writesSettled();
      expect(h.state().head).toBeNull();
      expect(h.state().mutation).toBeNull();
      expect(await h.repository.list()).toEqual([]);
      expect(h.deliver).not.toHaveBeenCalled();
      expect(h.deletion).toHaveBeenCalledTimes(1);
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.refresh).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
function grant(suffix = '', expiresIn = 7_200_000): CopilotVaultGrant {
  return {
    version: 1,
    clientId: 'client',
    host: 'github.com',
    login: 'pilot',
    id: '123',
    accessToken: ACCESS + suffix,
    refreshToken: REFRESH + suffix,
    accessTokenExpiresAt: new Date(NOW + expiresIn).toISOString(),
    refreshTokenExpiresAt: new Date(NOW + 30 * 86_400_000).toISOString(),
  };
}
function initial(): CopilotAuthorityRecord {
  return {
    version: 1,
    sequence: 0,
    head: null,
    mutation: null,
    removal: null,
    completed: null,
  };
}
function ready(result: CopilotGrantResult): CopilotGrantHead {
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected ready');
  return result.head;
}
function pending(result: CopilotGrantResult): string {
  expect(result.kind).toBe('pending');
  if (result.kind !== 'pending') throw new Error('Expected pending');
  return result.operationId;
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {
    throw new Error('Not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface Harness {
  memory: ReturnType<typeof createMemoryVaultRepository>;
  options: CopilotGrantAuthorityOptions;
  repository: VaultRepository;
  raw: VaultFamilyWriter;
  journal: CopilotAuthorityJournal;
  confirm: jest.MockedFunction<
    CopilotGrantAuthorityOptions['selection']['confirm']
  >;
  disable: jest.MockedFunction<
    CopilotGrantAuthorityOptions['selection']['disable']
  >;
  probe: jest.MockedFunction<CopilotGrantAuthorityOptions['probe']>;
  refresh: jest.MockedFunction<CopilotGrantAuthorityOptions['refresh']>;
  put: jest.MockedFunction<VaultFamilyWriter['put']>;
  deletion: jest.MockedFunction<VaultFamilyWriter['delete']>;
  writerFactory: jest.MockedFunction<CopilotGrantAuthorityOptions['writer']>;
  deliver: jest.MockedFunction<
    CopilotGrantAuthorityOptions['recipient']['deliver']
  >;
  admitted: jest.MockedFunction<
    CopilotGrantAuthorityOptions['recipient']['admitted']
  >;
  revoke: jest.MockedFunction<
    CopilotGrantAuthorityOptions['recipient']['revoke']
  >;
  resolutions: Map<
    string,
    Awaited<ReturnType<CopilotAuthorityJournal['reconcile']>>
  >;
  create(): CopilotVaultGrantAuthority;
  /** Synthetic process restart: fresh boot registry with the harness's exclusive owner capability. */
  restart(): CopilotVaultGrantAuthority;
  state(): CopilotAuthorityRecord;
  replaceState(next: CopilotAuthorityRecord): void;
  block(reason?: 'locked' | 'corrupt' | 'unavailable'): void;
  readFails(value: boolean): void;
  failCAS(): void;
  loseCAS(): void;
  losePut(): void;
  loseDelete(): void;
  nextPut(result: VaultPutOutcome): void;
  writesSettled(): Promise<PromiseSettledResult<unknown>[]>;
}
function harness(base?: {
  repository: VaultRepository;
  writer: VaultFamilyWriter;
  probeKeyIfDue(): Promise<void>;
}): Harness {
  const memory = createMemoryVaultRepository();
  const raw = base?.writer ?? memory.writer('copilot-account');
  let state = initial();
  let block: 'locked' | 'corrupt' | 'unavailable' | undefined;
  let readFails = false;
  let failCAS = false;
  let loseCAS = false;
  let losePut = false;
  let loseDelete = false;
  let nextPut: VaultPutOutcome | undefined;
  const resolutions = new Map<
    string,
    Awaited<ReturnType<CopilotAuthorityJournal['reconcile']>>
  >();
  const writes: Promise<unknown>[] = [];
  const repository: VaultRepository = {
    ...(base?.repository ?? memory.repository),
    get: async (ref) =>
      block
        ? { kind: 'blocked', reason: block }
        : (base?.repository ?? memory.repository).get(ref),
  };
  const put = jest.fn(
    async (request: Parameters<VaultFamilyWriter['put']>[0]) => {
      const forced = nextPut;
      nextPut = undefined;
      resolutions.set(request.idempotencyKey, { kind: 'unconfirmed' });
      const result = forced ?? (await raw.put(request));
      if (result.kind === 'committed') {
        resolutions.set(request.idempotencyKey, {
          kind: 'committed',
          pin: result.pin,
        });
        if (losePut) {
          losePut = false;
          return { kind: 'outcome_unknown', ref: result.pin.ref } as const;
        }
      } else if (result.kind === 'outcome_unknown')
        resolutions.set(request.idempotencyKey, { kind: 'unconfirmed' });
      else if (result.kind === 'unavailable')
        resolutions.set(request.idempotencyKey, { kind: 'retryable' });
      else resolutions.set(request.idempotencyKey, { kind: 'not_accepted' });
      return result;
    },
  );
  const deletion = jest.fn(
    async (request: Parameters<VaultFamilyWriter['delete']>[0]) => {
      const result = await raw.delete(request);
      if (loseDelete) {
        loseDelete = false;
        throw new Error(REFRESH);
      }
      return result;
    },
  );
  const writer: VaultFamilyWriter = {
    family: 'copilot-account',
    put(request) {
      const task = put(request);
      writes.push(task);
      return task;
    },
    delete: deletion,
  };
  const journal: CopilotAuthorityJournal = {
    lifetime: { isExclusive: () => true },
    read: () => {
      if (readFails) return Promise.reject(new Error(ACCESS));
      return Promise.resolve(structuredClone(state));
    },
    compareExchange: (sequence, next) => {
      if (failCAS) {
        failCAS = false;
        return Promise.reject(new Error(REFRESH));
      }
      if (sequence !== state.sequence) return Promise.resolve(false);
      state = structuredClone(next);
      if (loseCAS) {
        loseCAS = false;
        return Promise.reject(new Error(REFRESH));
      }
      return Promise.resolve(true);
    },
    reconcile: (id) =>
      Promise.resolve(resolutions.get(id) ?? { kind: 'not_accepted' }),
  };
  const confirm = jest.fn<
    ReturnType<CopilotGrantAuthorityOptions['selection']['confirm']>,
    Parameters<CopilotGrantAuthorityOptions['selection']['confirm']>
  >((request) =>
    Promise.resolve({
      kind: 'confirmed',
      receipt: {
        ...structuredClone(request),
        pinGeneration: `pin-${request.operationId}`,
      },
    }),
  );
  const disable = jest
    .fn<
      ReturnType<CopilotGrantAuthorityOptions['selection']['disable']>,
      Parameters<CopilotGrantAuthorityOptions['selection']['disable']>
    >()
    .mockResolvedValue({ kind: 'disabled' });
  const deliver = jest.fn<
    ReturnType<CopilotGrantAuthorityOptions['recipient']['deliver']>,
    Parameters<CopilotGrantAuthorityOptions['recipient']['deliver']>
  >();
  const admitted = jest.fn<
    ReturnType<CopilotGrantAuthorityOptions['recipient']['admitted']>,
    Parameters<CopilotGrantAuthorityOptions['recipient']['admitted']>
  >(() => true);
  const revoke = jest.fn();
  const probe = jest
    .fn<
      ReturnType<CopilotGrantAuthorityOptions['probe']>,
      Parameters<CopilotGrantAuthorityOptions['probe']>
    >()
    .mockResolvedValue(undefined);
  const refresh = jest
    .fn<
      ReturnType<CopilotGrantAuthorityOptions['refresh']>,
      Parameters<CopilotGrantAuthorityOptions['refresh']>
    >()
    .mockResolvedValue({ kind: 'success', grant: grant('-next') });
  const writerFactory = jest.fn(() => Promise.resolve(writer));
  const options: CopilotGrantAuthorityOptions = {
    repository: () => Promise.resolve(repository),
    writer: writerFactory,
    probeKeyIfDue: () => (base ? base.probeKeyIfDue() : Promise.resolve()),
    journal,
    selection: { confirm, disable },
    probe,
    refresh,
    recipient: { deliver, admitted, revoke },
    now: () => NOW,
  };
  return {
    memory,
    options,
    repository,
    raw,
    journal,
    confirm,
    disable,
    probe,
    refresh,
    put,
    deletion,
    writerFactory,
    deliver,
    admitted,
    revoke,
    resolutions,
    create: () => createCopilotVaultGrantAuthority(options),
    restart: () =>
      createCopilotVaultGrantAuthority({
        ...options,
        processLifetime: {},
        journal: { ...journal },
      }),
    state: () => structuredClone(state),
    replaceState: (next: CopilotAuthorityRecord) => {
      state = next;
    },
    block: (reason?: typeof block) => {
      block = reason;
    },
    readFails: (value: boolean) => {
      readFails = value;
    },
    failCAS: () => {
      failCAS = true;
    },
    loseCAS: () => {
      loseCAS = true;
    },
    losePut: () => {
      losePut = true;
    },
    loseDelete: () => {
      loseDelete = true;
    },
    nextPut: (result: VaultPutOutcome) => {
      nextPut = result;
    },
    writesSettled: () => Promise.allSettled(writes),
  };
}

describe('CAN-5851 unselected Copilot grant authority migration golden', () => {
  it('probes before durable create, starts a new lineage, and mints just one internal family writer', async () => {
    const h = harness();
    const authority = h.create();
    const putsAtProbe: number[] = [];
    h.probe.mockImplementation(() => {
      putsAtProbe.push(h.put.mock.calls.length);
      return Promise.resolve();
    });
    const first = ready(await authority.create(grant(), 'setup'));
    expect(h.probe).toHaveBeenCalledWith(
      ACCESS,
      first.account,
      expect.any(AbortSignal),
    );
    expect(first.epoch).not.toBe(first.pin.ref.entryId);
    expect(h.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        pin: first.pin,
        operationId: first.operationId,
      }),
    );
    expect(await authority.present('recipient', first.epoch)).toEqual(
      expect.objectContaining({ kind: 'delivered', committedPin: first.pin }),
    );
    expect(h.deliver).toHaveBeenLastCalledWith(
      'recipient',
      ACCESS,
      NOW + 7_200_000,
    );
    expect(await authority.remove(first.epoch)).toEqual({ kind: 'removed' });
    const second = ready(await authority.create(grant(), 'setup'));
    expect(second.epoch).not.toBe(first.epoch);
    expect(second.pin.ref.entryId).not.toBe(first.pin.ref.entryId);
    expect(second.pin.revision).toBe(first.pin.revision);
    expect(putsAtProbe).toEqual([0, 1]);
    expect(h.writerFactory).toHaveBeenCalledTimes(1);
    for (const [request] of h.deletion.mock.calls)
      expect(request.expectedRevision).toBeDefined();
  });

  it('never commits an unprobed setup or silently replaces an occupied singleton', async () => {
    const h = harness();
    const authority = h.create();
    h.probe.mockRejectedValueOnce(new Error(ACCESS));
    expect(await authority.create(grant(), 'setup')).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    expect(h.put).not.toHaveBeenCalled();
    expect(h.state().mutation).toBeNull();
    const head = ready(await authority.create(grant(), 'setup'));
    expect(await authority.create(grant('-other'), 'setup')).toEqual({
      kind: 'blocked',
      reason: 'busy',
    });
    expect(ready(await authority.status())).toEqual(head);
  });

  it('allows exactly one concurrent Connect to claim a stable operation', async () => {
    const h = harness();
    const a = h.create();
    const results = await Promise.all([
      a.create(grant(), 'setup'),
      a.create(grant('-other'), 'setup'),
    ]);
    expect(results.filter((r) => r.kind === 'ready')).toHaveLength(1);
    expect(h.put).toHaveBeenCalledTimes(1);
  });

  it('reconciles a lost create result after authority restart before publishing any pin', async () => {
    const h = harness();
    h.losePut();
    const operationId = pending(await h.create().create(grant(), 'setup'));
    expect(h.confirm).not.toHaveBeenCalled();
    const head = ready(await h.create().resume(operationId));
    expect(head.operationId).toBe(operationId);
    expect(h.put).toHaveBeenCalledTimes(1);
    expect(await h.repository.list()).toHaveLength(1);
  });

  it('retries the same create identity after locked, corrupt and unavailable refusal', async () => {
    for (const reason of ['locked', 'corrupt', 'unavailable'] as const) {
      const h = harness();
      const a = h.create();
      h.nextPut({ kind: 'blocked', reason });
      const operationId = pending(await a.create(grant(), 'setup'));
      ready(await a.resume(operationId));
      expect(h.put.mock.calls.map(([r]) => r.idempotencyKey)).toEqual([
        operationId,
        operationId,
      ]);
    }
  });

  it('does not re-probe, create twice, publish, or compensate on a lost pin acknowledgement', async () => {
    const h = harness();
    h.confirm.mockResolvedValueOnce({ kind: 'unconfirmed' });
    const a = h.create();
    expect(await a.create(grant(), 'setup')).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
    const id = pending(await a.status());
    expect(
      await a.present('recipient', h.state().mutation?.epoch ?? ''),
    ).toEqual({ kind: 'blocked', reason: 'changed' });
    const head = ready(await h.create().resume(id));
    expect(head.operationId).toBe(id);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.put).toHaveBeenCalledTimes(1);
    expect(h.deletion).not.toHaveBeenCalled();
    expect(h.confirm.mock.calls[0]).toEqual(h.confirm.mock.calls[1]);
  });

  it('rejects a host receipt for a newer setup even if host/login match', async () => {
    const h = harness();
    h.confirm.mockImplementationOnce((request) =>
      Promise.resolve({
        kind: 'confirmed',
        receipt: {
          ...request,
          operationId: 'newer-Connect',
          pinGeneration: 'newer-pin',
        },
      }),
    );
    expect(await h.create().create(grant(), 'setup')).toEqual({
      kind: 'blocked',
      reason: 'changed',
    });
    expect(h.state().head).toBeNull();
    expect(h.deletion).not.toHaveBeenCalled();
  });

  it('compensates only its exact setup entry and exact pin generation, with a stable delete receipt', async () => {
    const h = harness();
    h.confirm.mockResolvedValueOnce({ kind: 'unconfirmed' });
    const a = h.create();
    await a.create(grant(), 'setup');
    const operationId = pending(await a.status());
    const pin = h.state().mutation?.committed;
    h.loseDelete();
    expect(await a.cancel(operationId)).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    const expectedHead: unknown = expect.objectContaining({
      operationId,
      pinGeneration: `pin-${operationId}`,
    });
    expect(h.disable).toHaveBeenCalledWith(
      expect.objectContaining({ head: expectedHead }),
    );
    expect(await h.create().cancel(operationId)).toEqual({ kind: 'removed' });
    expect(await h.create().cancel(operationId)).toEqual({ kind: 'removed' });
    expect(h.deletion.mock.calls.map(([r]) => r)).toEqual([
      {
        ref: pin?.ref,
        expectedRevision: pin?.revision,
        idempotencyKey: `${operationId}:cancel`,
      },
      {
        ref: pin?.ref,
        expectedRevision: pin?.revision,
        idempotencyKey: `${operationId}:cancel`,
      },
    ]);
  });

  it('keeps import unselected until its trusted handoff acknowledgement, independent of legacy deletion', async () => {
    const h = harness();
    h.confirm.mockResolvedValueOnce({ kind: 'unconfirmed' });
    const a = h.create();
    await a.create(grant(), 'import');
    expect(h.probe).not.toHaveBeenCalled();
    const id = pending(await a.status());
    const head = ready(await a.resume(id));
    // There is deliberately no source-exists callback that can delete this lineage.
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    expect(h.deletion).not.toHaveBeenCalled();
  });

  it('D27 delivers the retained successor while revision admission is closed by a held put', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 1), 'setup'));
    const hold = h.memory.holdNextCommit();
    const delivered = await a.present('recipient', head.epoch);
    expect(delivered).toEqual({
      kind: 'delivered',
      expiresAt: NOW + 7_200_000,
      committedPin: null,
    });
    await new Promise<void>(setImmediate);
    expect(h.repository.admit(head.pin)).toEqual({ kind: 'unconfirmed' });
    expect(h.deliver).toHaveBeenLastCalledWith(
      'recipient',
      ACCESS + '-next',
      NOW + 7_200_000,
    );
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    expect(h.refresh).toHaveBeenCalledTimes(1);
    const id = pending(await a.status());
    hold.release({ kind: 'committed' });
    await h.writesSettled();
    const successor = ready(await a.resume(id));
    expect(successor.pin.revision).toBe(head.pin.revision + 1);
  });

  it('D27 survives save unavailability, revoke and generation bump, without refresh replay', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 1), 'setup'));
    const hold = h.memory.holdNextCommit();
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    hold.release({ kind: 'unavailable' });
    await h.writesSettled();
    const id = pending(await a.status());
    a.revoke();
    expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
    a.reopen();
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    await h.writesSettled();
    await a.resume(id);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(
      h.put.mock.calls
        .slice(1)
        .every(([request]) => request.idempotencyKey === id),
    ).toBe(true);
    expect(
      h.put.mock.calls
        .slice(1)
        .every(([request]) => request.material.includes(0)),
    ).toBe(true); // local buffers zeroed
  });

  it('retains a successor before even the journal write and repairs the same attempt on the next demand', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 1), 'setup'));
    h.refresh.mockImplementationOnce(() => {
      h.failCAS();
      return Promise.resolve({ kind: 'success', grant: grant('-next') });
    });
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    const id = pending(await a.status());
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    await h.writesSettled();
    ready(await a.resume(id));
    expect(h.put.mock.calls[1]?.[0].idempotencyKey).toBe(id);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenLastCalledWith(
      'recipient',
      ACCESS + '-next',
      NOW + 7_200_000,
    );
  });

  it('D31 makes one stored-grant presentation only on the next demand, not an automatic replay', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    h.refresh.mockResolvedValueOnce({ kind: 'lost' });
    expect(await a.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'network',
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.deletion).not.toHaveBeenCalled();
    h.refresh.mockResolvedValueOnce({ kind: 'rejected' });
    expect(await a.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'expired',
    });
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.refresh.mock.calls[1]?.[0].refreshToken).toBe(REFRESH);
    const expectedId: unknown = expect.any(String);
    expect(h.deletion).toHaveBeenCalledWith({
      ref: head.pin.ref,
      expectedRevision: head.pin.revision,
      idempotencyKey: expectedId,
    });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('uses still-valid access after a lost response but does not hide expired access', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 60_000), 'setup'));
    h.refresh.mockResolvedValue({ kind: 'lost' });
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenLastCalledWith(
      'recipient',
      ACCESS,
      NOW + 60_000,
    );
  });

  it('a lost provider response is not confused with an unknown local replace after restart', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    const hold = h.memory.holdNextCommit();
    await a.present('recipient', head.epoch);
    hold.release({ kind: 'outcome_unknown', applied: true });
    await h.writesSettled();
    const restarted = h.create();
    expect(await restarted.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    const m = h.state().mutation;
    if (!m?.from) throw new Error('Expected pending rotation');
    await h.memory.reconcile(m.from.ref);
    const rows = await h.repository.list();
    const row = rows[0];
    if (!row) throw new Error('Expected successor row');
    h.resolutions.set(m.operationId, {
      kind: 'committed',
      pin: { ref: row.ref, revision: row.revision },
    });
    expect((await restarted.present('recipient', head.epoch)).kind).toBe(
      'delivered',
    );
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('never delivers to a revoked recipient when a refresh finishes late', async () => {
    const h = harness();
    const response =
      deferred<Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>>();
    h.refresh.mockReturnValue(response.promise);
    const started = deferred<void>();
    h.refresh.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    const presenting = a.present('recipient', head.epoch);
    await started.promise;
    a.revoke();
    response.resolve({ kind: 'success', grant: grant('-next') });
    expect((await presenting).kind).toBe('blocked');
    await h.writesSettled();
    expect(h.deliver).not.toHaveBeenCalled();
    a.reopen();
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('preserves resume after a preference disable failure, but never calls unknown disable completed', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant(), 'setup'));
    h.disable.mockResolvedValueOnce({ kind: 'failed' });
    expect(await a.remove(head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    h.disable.mockResolvedValueOnce({ kind: 'unconfirmed' });
    expect(await a.remove(head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
    a.reopen();
    expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
    expect(h.deletion).not.toHaveBeenCalled();
    expect(await h.create().remove(head.epoch)).toEqual({ kind: 'removed' });
    expect(h.disable.mock.calls[1]?.[0].operationId).toBe(
      h.disable.mock.calls[2]?.[0].operationId,
    );
  });

  it.each(['removal', 'rejected refresh', 'mismatched receipt'] as const)(
    'P8 q-27 retired witness: the %s delete commits only the exact disabled receipt and binds the next setup to it',
    async (path) => {
      const h = harness();
      const a = h.create();
      const head = ready(
        await a.create(
          grant('', path === 'rejected refresh' ? -1 : 7_200_000),
          'setup',
        ),
      );
      const receipt: CopilotHostSelection = {
        version: 1,
        state: 'disabled',
        identity: {
          operationId: head.operationId,
          epoch: head.epoch,
          account: head.account,
          origin: head.origin,
        },
        pinGeneration: head.pinGeneration,
        pin: head.pin,
      };
      h.disable.mockResolvedValue({
        kind: 'disabled',
        receipt:
          path === 'mismatched receipt'
            ? { ...receipt, pinGeneration: 'foreign-nonce' }
            : receipt,
      });
      if (path === 'rejected refresh') {
        h.refresh.mockResolvedValueOnce({ kind: 'rejected' });
        expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
      } else expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
      const retired = h.state();
      expect(retired).toMatchObject({
        head: null,
        mutation: null,
        removal: null,
        completed: { kind: 'delete', epoch: head.epoch },
      });
      expect(CopilotAuthorityRecordSchema.safeParse(retired).success).toBe(
        true,
      );
      function restarted(
        predecessor: CopilotHostSelection,
      ): CopilotVaultGrantAuthority {
        return createCopilotVaultGrantAuthority({
          ...h.options,
          processLifetime: {},
          journal: { ...h.journal },
          selection: {
            ...h.options.selection,
            setupPredecessor: () => Promise.resolve(predecessor),
          },
        });
      }
      if (path === 'mismatched receipt') {
        // A receipt the head never selected is not a witness; v1 stays v1.
        expect(retired.version).toBe(1);
        expect(retired.setupLineage).toBeUndefined();
        expect(await restarted(receipt).create(grant(), 'setup')).toEqual({
          kind: 'blocked',
          reason: 'changed',
        });
        expect(h.state()).toEqual(retired);
        return;
      }
      expect(retired).toMatchObject({
        version: 2,
        setupLineage: {
          version: 1,
          phase: 'retired',
          predecessor: receipt,
          successor: {
            operationId: retired.completed?.operationId,
            epoch: head.epoch,
          },
        },
      });
      const pin = head.pin;
      const foreign: Record<string, CopilotHostSelection> = {
        operation: {
          ...receipt,
          identity: { ...receipt.identity, operationId: 'foreign-operation' },
        },
        account: {
          ...receipt,
          identity: {
            ...receipt.identity,
            account: { ...receipt.identity.account, login: 'foreign-login' },
          },
        },
        nonce: { ...receipt, pinGeneration: 'foreign-nonce' },
        pin: {
          ...receipt,
          pin: { ...pin, ref: { ...pin.ref, entryId: 'foreign-entry' } },
        },
        revision: { ...receipt, pin: { ...pin, revision: pin.revision + 1 } },
      };
      const refused: Record<string, unknown> = {};
      for (const [field, predecessor] of Object.entries(foreign))
        refused[field] = await restarted(predecessor).create(grant(), 'setup');
      expect(refused).toEqual(
        Object.fromEntries(
          Object.keys(foreign).map((field) => [
            field,
            { kind: 'blocked', reason: 'changed' },
          ]),
        ),
      );
      expect(h.state()).toEqual(retired);
      const next = ready(await restarted(receipt).create(grant(), 'setup'));
      expect(next.epoch).not.toBe(head.epoch);
    },
  );

  it.each([
    ['unprepared probe failure', 'own'],
    ['committed cancel', 'own'],
    ['replayed cancel', 'own'],
    ['unprepared probe failure', 'predecessor'],
    ['unprepared probe failure', 'foreign'],
  ] as const)(
    'P8 q-27 cancelled witness: a %s with a %s survivor binds the next setup to the exact surviving receipt',
    async (path, survivorKind) => {
      const h = harness();
      const lineage: { predecessor?: CopilotHostSelection } = {};
      let survivor: CopilotHostSelection | undefined;
      type Survivor = NonNullable<
        CopilotGrantAuthorityOptions['selection']['cancelledReceipt']
      >;
      const cancelledReceipt = jest.fn<
        ReturnType<Survivor>,
        Parameters<Survivor>
      >(() => Promise.resolve(survivor));
      const options: CopilotGrantAuthorityOptions = {
        ...h.options,
        selection: {
          ...h.options.selection,
          abandon: () => Promise.resolve(),
          cancelledReceipt,
          setupPredecessor: () => Promise.resolve(lineage.predecessor),
        },
      };
      function restarted(
        receipt: CopilotHostSelection,
      ): CopilotVaultGrantAuthority {
        return createCopilotVaultGrantAuthority({
          ...options,
          processLifetime: {},
          journal: { ...h.journal },
          selection: {
            ...options.selection,
            setupPredecessor: () => Promise.resolve(receipt),
          },
        });
      }
      function disabledReceipt(
        binding: Pick<CopilotGrantHead, 'operationId' | 'epoch' | 'account'>,
        pinGeneration: string,
        pin: CopilotHostSelection['pin'],
      ): CopilotHostSelection {
        return {
          version: 1,
          state: 'disabled',
          identity: {
            operationId: binding.operationId,
            epoch: binding.epoch,
            account: binding.account,
            origin: 'setup',
          },
          pinGeneration,
          pin,
        };
      }
      const a = createCopilotVaultGrantAuthority(options);
      const head = ready(await a.create(grant(), 'setup'));
      const retired = disabledReceipt(head, head.pinGeneration, head.pin);
      h.disable.mockResolvedValue({ kind: 'disabled', receipt: retired });
      expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
      expect(h.state().setupLineage?.phase).toBe('retired');
      lineage.predecessor = retired;
      // The receipt the cancelled witness must bind.
      let own: CopilotHostSelection;
      let cancelled: unknown;
      if (path === 'unprepared probe failure') {
        h.probe.mockRejectedValueOnce(new Error(ACCESS));
        // The successor never reached the vault: its own receipt is pin-less.
        cancelledReceipt.mockImplementationOnce((identity) => {
          const prepared = disabledReceipt(identity, 'prepared-nonce', null);
          // The nonce is host-generated, so a foreign survivor is one whose
          // journal-checked identity differs: here, the account.
          survivor =
            survivorKind === 'own'
              ? prepared
              : survivorKind === 'predecessor'
                ? retired
                : disabledReceipt(
                    {
                      ...identity,
                      account: { ...identity.account, login: 'foreign-login' },
                    },
                    'prepared-nonce',
                    null,
                  );
          return Promise.resolve(survivor);
        });
        cancelled = await a.create(grant(), 'setup');
        // Anything but the successor's own receipt keeps the predecessor.
        own = survivorKind === 'own' && survivor ? survivor : retired;
      } else {
        h.confirm.mockResolvedValueOnce({ kind: 'unconfirmed' });
        expect((await a.create(grant(), 'setup')).kind).toBe('blocked');
        const successor = h.state().mutation;
        if (!successor?.committed) throw new Error('Missing committed setup');
        own = disabledReceipt(
          successor,
          `pin-${successor.operationId}`,
          successor.committed,
        );
        if (path === 'committed cancel') {
          h.disable.mockResolvedValue({ kind: 'disabled', receipt: own });
          cancelled = await a.cancel(successor.operationId);
        } else {
          // Process ends after the deletion intent: no receipt is in hand on replay.
          h.disable.mockResolvedValue({ kind: 'disabled', receipt: own });
          h.deletion.mockRejectedValueOnce(new Error(REFRESH));
          expect((await a.cancel(successor.operationId)).kind).toBe('blocked');
          expect(h.state().mutation?.operationId).toBe(
            `${successor.operationId}:cancel`,
          );
          h.disable.mockResolvedValue({ kind: 'disabled' });
          survivor = own;
          cancelled = await restarted(own).cancel(successor.operationId);
        }
      }
      const after = h.state();
      const witness = after.setupLineage;
      if (!witness) throw new Error('Missing cancelled witness');
      expect({
        cancelled,
        phase: witness.phase,
        completed: after.completed,
      }).toEqual({
        cancelled:
          path === 'unprepared probe failure'
            ? { kind: 'blocked', reason: 'unavailable' }
            : { kind: 'removed' },
        phase: 'cancelled',
        completed: {
          operationId: `${witness.successor.operationId}:cancel`,
          epoch: witness.successor.epoch,
          kind: 'delete',
        },
      });
      expect(witness.predecessor).toEqual(own);
      expect(CopilotAuthorityRecordSchema.safeParse(after).success).toBe(true);
      const foreign: Record<string, CopilotHostSelection> = {
        operation: {
          ...own,
          identity: { ...own.identity, operationId: 'foreign-operation' },
        },
        epoch: {
          ...own,
          identity: { ...own.identity, epoch: 'foreign-epoch' },
        },
        account: {
          ...own,
          identity: {
            ...own.identity,
            account: { ...own.identity.account, login: 'foreign-login' },
          },
        },
        nonce: { ...own, pinGeneration: 'foreign-nonce' },
        pin: {
          ...own,
          pin: {
            ref: { vaultId: head.pin.ref.vaultId, entryId: 'foreign-entry' },
            revision: 9,
          },
        },
        origin: { ...own, identity: { ...own.identity, origin: 'import' } },
        enabled: { ...own, state: 'selected' },
        ...(survivorKind === 'own' ? { predecessor: retired } : {}),
        ...(survivor && survivorKind === 'foreign'
          ? { 'foreign survivor': survivor }
          : {}),
      };
      const refused: Record<string, unknown> = {};
      for (const [field, receipt] of Object.entries(foreign))
        refused[field] = await restarted(receipt).create(grant(), 'setup');
      expect(refused).toEqual(
        Object.fromEntries(
          Object.keys(foreign).map((field) => [
            field,
            { kind: 'blocked', reason: 'changed' },
          ]),
        ),
      );
      expect(h.state()).toEqual(after);
      const next = ready(await restarted(own).create(grant(), 'setup'));
      expect(next.epoch).not.toBe(witness.successor.epoch);
    },
  );

  it('uses keyless, revision-bound explicit removal even for unreadable material', async () => {
    for (const reason of ['locked', 'corrupt', 'unavailable'] as const) {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      h.block(reason);
      expect(await a.present('recipient', head.epoch)).toEqual({
        kind: 'blocked',
        reason,
      });
      expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
      expect(h.deletion.mock.calls[0]?.[0].expectedRevision).toBe(
        head.pin.revision,
      );
    }
  });

  it('reconciles lost delete acknowledgement with the same CAS/idempotency key and cannot resurrect it', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant(), 'setup'));
    h.loseDelete();
    expect(await a.remove(head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    const mutation = h.state().mutation;
    if (!mutation) throw new Error('Missing delete receipt');
    const restarted = h.create();
    expect(await restarted.resume(mutation.operationId)).toEqual({
      kind: 'removed',
    });
    expect(await restarted.remove(head.epoch)).toEqual({ kind: 'removed' });
    expect(h.deletion.mock.calls[0]).toEqual(h.deletion.mock.calls[1]);
    expect(h.state().head).toBeNull();
  });

  it('stale removal and rejection cannot delete or revoke a replacement account', async () => {
    const h = harness();
    const a = h.create();
    const old = ready(await a.create(grant(), 'setup'));
    expect(await a.remove(old.epoch)).toEqual({ kind: 'removed' });
    const next = ready(await a.create(grant('-new'), 'setup'));
    expect(await a.remove(old.epoch)).toEqual({
      kind: 'blocked',
      reason: 'changed',
    });
    expect((await a.present('recipient', next.epoch)).kind).toBe('delivered');
    expect(h.deletion).toHaveBeenCalledTimes(1);
  });

  it('refuses invalid/empty grants, unknown handles, account mismatch and missing/corrupt journal without secret errors', async () => {
    const h = harness();
    const a = h.create();
    expect(await a.create({ ...grant(), refreshToken: '' }, 'setup')).toEqual({
      kind: 'blocked',
      reason: 'denied',
    });
    expect(
      await a.create(
        {
          ...grant(),
          accessToken: '\u0000'.repeat(100_000),
          refreshToken: '\u0000'.repeat(100_000),
        },
        'setup',
      ),
    ).toEqual({ kind: 'blocked', reason: 'denied' });
    expect(await a.create({ ...grant(), id: 'not-numeric' }, 'setup')).toEqual({
      kind: 'blocked',
      reason: 'denied',
    });
    const head = ready(await a.create(grant(), 'setup'));
    h.admitted.mockReturnValue(false);
    expect((await a.present('wrong-audience', head.epoch)).kind).toBe(
      'blocked',
    );
    h.admitted.mockReturnValue(true);
    h.readFails(true);
    expect(await a.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    h.readFails(false);
    const record = h.state();
    h.replaceState({
      ...record,
      head: { ...head, account: { ...head.account, id: '999' } },
    });
    expect(await a.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'changed',
    });
    expect(h.deliver).not.toHaveBeenCalled();
    expect(
      CopilotAuthorityRecordSchema.safeParse({ ...record, accessToken: ACCESS })
        .success,
    ).toBe(false);
  });

  it('never returns grants in authority receipts, errors, persisted records, or any core.vault.* result schema', async () => {
    const h = harness();
    const a = h.create();
    const result = await a.create(grant(), 'setup');
    const head = ready(result);
    const response = await a.present('recipient', head.epoch);
    const row = (await h.repository.list())[0];
    if (!row) throw new Error('Missing metadata');
    const metadata = VaultEntryMetadataSchema.parse({
      ...row,
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    const outputs = [
      result,
      response,
      h.state(),
      ...h.confirm.mock.calls,
      metadata,
    ];
    for (const output of outputs) {
      expectNoGrantSecrets(output);
    }
    const queries = CORE_VAULT_QUERY_DEFINITIONS;
    const instructions = CORE_VAULT_INSTRUCTION_DEFINITIONS;
    const planted = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      grant: grant(),
    };
    const wire = [
      queries['core.vault.status.get'].result.parse({
        ...h.repository.status(),
        ...planted,
      }),
      queries['core.vault.entry.get'].result.parse({ ...row, ...planted }),
      queries['core.vault.entry.list'].result.parse({
        items: [{ ...row, ...planted }],
        nextCursor: null,
        ...planted,
      }),
      instructions['core.vault.entry.put'].result.parse({ ...row, ...planted }),
      instructions['core.vault.entry.delete'].result.parse({
        ref: head.pin.ref,
        tombstoneRevision: head.pin.revision + 1,
        revokedGrantCount: 0,
        ...planted,
      }),
    ];
    expectNoGrantSecrets(wire);
    h.deliver.mockImplementationOnce(() => {
      throw new Error(REFRESH);
    });
    expect(await a.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
  });

  it('refuses duplicate family rows rather than choosing the newest', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant(), 'setup'));
    await h.raw.put({
      family: 'copilot-account',
      entryId: null,
      expectedRevision: null,
      label: 'Copilot',
      material: Buffer.from(JSON.stringify(grant('-duplicate'))),
      expiresAt: null,
      idempotencyKey: 'duplicate-fixture',
    });
    expect(await a.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('never saves an unprobed setup after restart, and cancels only a proven unaccepted operation', async () => {
    const h = harness();
    const probing = deferred<void>();
    const started = deferred<void>();
    h.probe.mockImplementationOnce(() => {
      started.resolve();
      return probing.promise;
    });
    const a = h.create();
    const creating = a.create(grant(), 'setup');
    await started.promise;
    const id = pending(await a.status());
    expect(await h.create().resume(id)).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
    expect(h.put).not.toHaveBeenCalled();
    expect(await h.create().cancel(id)).toEqual({ kind: 'removed' });
    probing.resolve();
    expect((await creating).kind).toBe('blocked');
    expect(h.put).not.toHaveBeenCalled();
  });

  it('single-flights concurrent demand and refreshes at the exact one-hour boundary', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 3_600_000), 'setup'));
    const response =
      deferred<Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>>();
    const started = deferred<void>();
    h.refresh.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const calls = Array.from({ length: 8 }, () =>
      a.present('recipient', head.epoch),
    );
    await started.promise;
    response.resolve({ kind: 'success', grant: grant('-next') });
    const results = await Promise.all(calls);
    expect(results.every((r) => r.kind === 'delivered')).toBe(true);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    await h.writesSettled();
  });

  it('joins a live provider presentation after its durable fence exists', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 1), 'setup'));
    const started = deferred<void>();
    const response =
      deferred<Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>>();
    h.refresh.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const first = a.present('recipient', head.epoch);
    await started.promise;
    const late = a.present('recipient', head.epoch);
    await new Promise<void>(setImmediate);
    response.resolve({ kind: 'success', grant: grant('-next') });
    expect((await first).kind).toBe('delivered');
    expect((await late).kind).toBe('delivered');
    expect(
      h.deliver.mock.calls.every(([, token]) => token === ACCESS + '-next'),
    ).toBe(true);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    await h.writesSettled();
  });

  it.each(['deliver', 'remove'] as const)(
    'isolates replacement-account refresh after the removal cap, including late cleanup (%s)',
    async (demand) => {
      jest.useFakeTimers({ now: NOW });
      try {
        const h = harness();
        const a = h.create();
        const old = ready(await a.create(grant('', -1), 'setup'));
        const oldResponse =
          deferred<
            Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
          >();
        const started = deferred<void>();
        h.refresh.mockImplementationOnce(() => {
          started.resolve();
          return oldResponse.promise;
        });
        const oldPresenting = a.present('old-recipient', old.epoch);
        await started.promise;
        const removing = a.remove(old.epoch);
        await jest.advanceTimersByTimeAsync(2_001);
        expect(await removing).toEqual({ kind: 'removed' });

        const nextGrant = { ...grant('-new', -1), login: 'other', id: '456' };
        const next = ready(await a.create(nextGrant, 'setup'));
        expect(next.epoch).not.toBe(old.epoch);
        const nextResponse =
          deferred<
            Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
          >();
        h.refresh.mockImplementationOnce(() => nextResponse.promise);
        const nextPresenting = a.present('new-recipient', next.epoch);
        await jest.advanceTimersByTimeAsync(0);
        expect(h.refresh).toHaveBeenCalledTimes(2);
        expect(h.refresh).toHaveBeenLastCalledWith(
          nextGrant,
          expect.any(AbortSignal),
        );
        expect(h.deliver).not.toHaveBeenCalled();

        oldResponse.resolve({ kind: 'success', grant: grant('-retired') });
        expect(await oldPresenting).toEqual({
          kind: 'blocked',
          reason: 'changed',
        });
        expect(h.state().mutation?.epoch).toBe(next.epoch);
        let nextRemoving: Promise<CopilotGrantResult> | undefined;
        if (demand === 'remove') {
          nextRemoving = a.remove(next.epoch);
          await jest.advanceTimersByTimeAsync(1_999);
          // Late cleanup of the retired rotation must not bypass the new drain.
          expect(h.disable).toHaveBeenCalledTimes(1);
          expect(h.deletion).toHaveBeenCalledTimes(1);
        }
        nextResponse.resolve({
          kind: 'success',
          grant: { ...grant('-new-refreshed'), login: 'other', id: '456' },
        });
        if (nextRemoving) {
          expect(await nextRemoving).toEqual({ kind: 'removed' });
          expect(await nextPresenting).toEqual({
            kind: 'blocked',
            reason: 'changed',
          });
          expect(h.deliver).not.toHaveBeenCalled();
        } else {
          expect((await nextPresenting).kind).toBe('delivered');
          expect(h.deliver).toHaveBeenCalledTimes(1);
          expect(h.deliver).toHaveBeenLastCalledWith(
            'new-recipient',
            ACCESS + '-new-refreshed',
            NOW + 7_200_000,
          );
          expect(h.refresh).toHaveBeenCalledTimes(2);
        }
        await h.writesSettled();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([
    ['success', 'success'],
    ['success', 'rejected'],
    ['rejected', 'success'],
    ['rejected', 'rejected'],
  ] as const)(
    'ignores retired %s while current %s is awaiting checkpoint recovery',
    async (oldKind, nextKind) => {
      jest.useFakeTimers({ now: NOW });
      try {
        const h = harness();
        const a = h.create();
        const old = ready(await a.create(grant('', -1), 'setup'));
        const oldResponse =
          deferred<
            Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
          >();
        const started = deferred<void>();
        h.refresh.mockImplementationOnce(() => {
          started.resolve();
          return oldResponse.promise;
        });
        const oldPresenting = a.present('old-recipient', old.epoch);
        await started.promise;
        const removing = a.remove(old.epoch);
        await jest.advanceTimersByTimeAsync(2_001);
        expect(await removing).toEqual({ kind: 'removed' });
        const nextGrant = { ...grant('-new', -1), login: 'other', id: '456' };
        const successor = {
          ...grant('-new-refreshed'),
          login: 'other',
          id: '456',
        };
        const next = ready(await a.create(nextGrant, 'setup'));
        h.refresh.mockImplementationOnce(() => {
          h.failCAS();
          return Promise.resolve(
            nextKind === 'success'
              ? { kind: 'success', grant: successor }
              : { kind: 'rejected' },
          );
        });
        expect(await a.present('new-recipient', next.epoch)).toMatchObject(
          nextKind === 'success'
            ? { kind: 'delivered', committedPin: null }
            : { kind: 'blocked', reason: 'unavailable' },
        );
        expect(h.state().mutation?.kind).toBe('refresh');
        oldResponse.resolve(
          oldKind === 'success'
            ? { kind: 'success', grant: grant('-retired') }
            : { kind: 'rejected' },
        );
        expect(await oldPresenting).toEqual({
          kind: 'blocked',
          reason: 'changed',
        });
        expect(h.state().mutation?.epoch).toBe(next.epoch);
        expect(await a.present('new-recipient', next.epoch)).toMatchObject(
          nextKind === 'success'
            ? { kind: 'delivered' }
            : { kind: 'blocked', reason: 'expired' },
        );
        expect(h.refresh).toHaveBeenCalledTimes(2);
        if (nextKind === 'success') {
          expect(h.deliver).toHaveBeenLastCalledWith(
            'new-recipient',
            successor.accessToken,
            NOW + 7_200_000,
          );
        } else {
          expect(h.deliver).not.toHaveBeenCalled();
          expect(h.deletion).toHaveBeenCalledTimes(2);
        }
        await h.writesSettled();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(['success', 'rejected'] as const)(
    'fences a late %s after bounded removal and reconnect',
    async (kind) => {
      jest.useFakeTimers({ now: NOW });
      try {
        const h = harness();
        const a = h.create();
        const old = ready(await a.create(grant('', -1), 'setup'));
        const response =
          deferred<
            Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
          >();
        const started = deferred<void>();
        h.refresh.mockImplementationOnce(() => {
          started.resolve();
          return response.promise;
        });
        const presenting = a.present('recipient', old.epoch);
        await started.promise;
        const removing = a.remove(old.epoch);
        await jest.advanceTimersByTimeAsync(2_001);
        expect(await removing).toEqual({ kind: 'removed' });
        const next = ready(await a.create(grant('-new'), 'setup'));
        response.resolve(
          kind === 'success'
            ? { kind: 'success', grant: grant('-retired') }
            : { kind: 'rejected' },
        );
        expect((await presenting).kind).toBe('blocked');
        expect((await a.present('recipient', next.epoch)).kind).toBe(
          'delivered',
        );
        expect(h.put).toHaveBeenCalledTimes(2);
        expect(h.deletion).toHaveBeenCalledTimes(1);
        expect(h.deliver).toHaveBeenLastCalledWith(
          'recipient',
          ACCESS + '-new',
          NOW + 7_200_000,
        );
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('recovers a lost journal CAS reply without repeating setup or losing operation identity', async () => {
    const h = harness();
    h.loseCAS();
    const a = h.create();
    expect(await a.create(grant(), 'setup')).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    const id = pending(await a.status());
    expect(await a.resume(id)).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
    expect(h.put).not.toHaveBeenCalled();
    expect(await a.cancel(id)).toEqual({ kind: 'removed' });
    h.replaceState({ ...h.state(), sequence: -1 });
    expect(await a.status()).toEqual({ kind: 'blocked', reason: 'corrupt' });
  });

  it('retains genuine rejection across a failed journal write instead of replaying the rejected refresh', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    h.refresh.mockImplementationOnce(() => {
      h.failCAS();
      return Promise.resolve({ kind: 'rejected' });
    });
    expect(await a.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    expect(await a.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'expired',
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.deletion).toHaveBeenCalledTimes(1);
  });

  it('explicit removal retries a latest-revision CAS race, never a keyless unconditional delete', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant(), 'setup'));
    h.deletion.mockImplementationOnce(async (request) => {
      await h.raw.put({
        ref: head.pin.ref,
        expectedRevision: head.pin.revision,
        material: Buffer.from(JSON.stringify(grant('-late-save'))),
        label: 'Copilot',
        expiresAt: null,
        idempotencyKey: 'late-save-fixture',
      });
      return h.raw.delete(request);
    });
    expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
    expect(h.deletion.mock.calls.map(([r]) => r.expectedRevision)).toEqual([
      head.pin.revision,
      head.pin.revision,
      head.pin.revision + 1,
    ]);
    expect(h.deletion.mock.calls[0]?.[0].idempotencyKey).toBe(
      h.deletion.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(h.deletion.mock.calls[2]?.[0].idempotencyKey).not.toBe(
      h.deletion.mock.calls[0]?.[0].idempotencyKey,
    );
  });

  it('production remains completely unselected, reserved and disabled, with no activation switch', () => {
    const daemon = readFileSync(
      'packages/core-runtime/src/node/vault/daemon-vault.ts',
      'utf8',
    );
    expect(daemon).toMatch(/'copilot-account':\s*{\s*state: 'reserved'/);
    for (const path of [
      'apps/core-daemon/src/main.ts',
      'apps/core-daemon/src/daemon.ts',
      'apps/core-daemon/src/migration.ts',
      'apps/desktop-app/src/main/canopy-runtime/migration-channel.ts',
    ]) {
      expect(readFileSync(path, 'utf8')).not.toContain(
        'createCopilotVaultGrantAuthority',
      );
    }
    expect(readFileSync('apps/core-daemon/src/main.ts', 'utf8')).toMatch(
      /const daemon = await startCanopyDaemon\(\{[^{}]*nativeProtectionFor:\s*\(platform,\s*identity\)\s*=>\s*createNativeSecretProtectionOwner\(\{\s*\.\.\.identity,\s*\.\.\.buildIdentity,/,
    );
    expect(readFileSync('apps/core-daemon/src/migration.ts', 'utf8')).toContain(
      'MIGRATION_PRODUCTION_ENABLED = false',
    );
    expect(
      readFileSync(
        'apps/desktop-app/src/main/canopy-runtime/migration-channel.ts',
        'utf8',
      ),
    ).toMatch(/enabled: false/);
    for (const path of [
      'copilot-grant-authority.ts',
      'copilot-grant-contracts.ts',
    ]) {
      const source = readFileSync(
        `packages/core-runtime/src/node/vault/${path}`,
        'utf8',
      );
      expect(source).not.toMatch(
        /from ['"](?:@canopy\/desktop-shared|.*apps\/)/,
      );
    }
  });
});

describe('Copilot authority on the durable encrypted vault', () => {
  let directory: StoreFolder;
  let store: VaultStore;
  let vault: VaultReadRepository;
  let slots: ReturnType<typeof createFakeSecretProtection>;
  async function open(): Promise<void> {
    store = await directory.opened();
    const opened = await openVaultReadRepository({
      store,
      slots: slots.port,
      signal: new AbortController().signal,
      minProbeIntervalMs: 0,
    });
    if (opened.kind !== 'opened')
      throw new Error(`Vault failed to open: ${opened.step}`);
    vault = opened.vault;
    await vault.reconcile();
  }
  beforeEach(async () => {
    directory = storeFolder();
    slots = createFakeSecretProtection({ backend: 'macos_keychain' });
    await open();
  });
  afterEach(() => {
    vault.dispose();
    store.close();
    directory.remove();
  });

  it('holds only encrypted grant bytes in storage; metadata and wire projections carry no grant', async () => {
    const h = harness({
      repository: vault.repository,
      writer: vault.writer('copilot-account'),
      probeKeyIfDue: () => vault.probeKeyIfDue(),
    });
    const a = h.create();
    const head = ready(await a.create(grant(), 'setup'));
    const stored = store.readEntry(head.pin.ref.entryId);
    expect(stored).toBeTruthy();
    expectNoGrantSecrets(stored);
    expectNoGrantSecrets(await vault.repository.list());
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    const requests = h.put.mock.calls;
    expect(requests[0]?.[0].material.every((byte) => byte === 0)).toBe(true);
    // Reopen the actual SQLite store, keeping only the secret-free journal port.
    vault.dispose();
    store.close();
    await open();
    const restarted = createCopilotVaultGrantAuthority({
      ...h.options,
      repository: () => Promise.resolve(vault.repository),
      writer: () => Promise.resolve(vault.writer('copilot-account')),
      probeKeyIfDue: () => vault.probeKeyIfDue(),
    });
    expect((await restarted.present('recipient', head.epoch)).kind).toBe(
      'delivered',
    );
    expect(h.deliver).toHaveBeenLastCalledWith(
      'recipient',
      ACCESS,
      NOW + 7_200_000,
    );
  });

  it('reconciles a lost durable delete from its stored tombstone receipt without replay', async () => {
    const h = harness({
      repository: vault.repository,
      writer: vault.writer('copilot-account'),
      probeKeyIfDue: () => vault.probeKeyIfDue(),
    });
    const a = h.create();
    const head = ready(await a.create(grant(), 'setup'));
    h.deletion.mockImplementationOnce(async (request) => {
      const outcome = await h.raw.delete(request);
      if (outcome.kind !== 'committed')
        throw new Error('Expected committed delete');
      return { kind: 'outcome_unknown', ref: outcome.ref };
    });
    expect((await a.remove(head.epoch)).kind).toBe('blocked');
    const mutation = h.state().mutation;
    if (!mutation) throw new Error('Missing delete receipt');
    const intent = store.findIntent('copilot-account', mutation.operationId);
    expect(intent?.state).toBe('committed');
    expect(intent?.outcomeRevision).toBe(head.pin.revision + 1);
    const reconcile = h.journal.reconcile.bind(h.journal);
    h.journal.reconcile = async (
      id,
    ): ReturnType<CopilotAuthorityJournal['reconcile']> => {
      const receipt = store.findIntent('copilot-account', id);
      return receipt?.kind === 'delete' &&
        receipt.state === 'committed' &&
        receipt.outcomeRevision !== null
        ? {
            kind: 'committed',
            pin: {
              ref: { vaultId: head.pin.ref.vaultId, entryId: receipt.entryId },
              revision: receipt.outcomeRevision,
            },
          }
        : await reconcile(id);
    };
    const restarted = h.create();
    expect(await restarted.resume(mutation.operationId)).toEqual({
      kind: 'removed',
    });
    expect(h.deletion).toHaveBeenCalledTimes(1);
    expect(await vault.repository.list()).toEqual([]);
    expect(h.state().head).toBeNull();
    expect(h.state().removal).toBeNull();
  });

  it.each(['locked', 'unavailable'] as const)(
    'recovers a %s protection observation without prompt or reconnect',
    async (reason) => {
      const h = harness({
        repository: vault.repository,
        writer: vault.writer('copilot-account'),
        probeKeyIfDue: () => vault.probeKeyIfDue(),
      });
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      slots.inject(
        reason === 'locked'
          ? { kind: 'locked' }
          : { kind: 'unavailable', reason: 'backend_failed' },
      );
      await vault.refresh();
      expect(await a.present('recipient', head.epoch)).toEqual({
        kind: 'blocked',
        reason,
      });
      slots.clearFaults();
      expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
      expect(slots.prompts).toBe(0);
      expect(h.refresh).not.toHaveBeenCalled();
    },
  );

  it.each([
    'not a valid grant',
    JSON.stringify(null),
    JSON.stringify({ ...grant(), refreshToken: '' }),
    JSON.stringify({
      ...grant(),
      accessTokenExpiresAt: '2026-02-29T10:00:00Z',
    }),
    JSON.stringify({ ...grant(), unexpected: REFRESH }),
  ])(
    'deletes corrupt grant case %# without decrypting or guessing its CAS from account metadata',
    async (material) => {
      const h = harness({
        repository: vault.repository,
        writer: vault.writer('copilot-account'),
        probeKeyIfDue: () => vault.probeKeyIfDue(),
      });
      const raw = vault.writer('copilot-account');
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      const broken = await raw.put({
        ref: head.pin.ref,
        expectedRevision: head.pin.revision,
        label: 'Copilot',
        material: Buffer.from(material),
        expiresAt: null,
        idempotencyKey: 'corruption-fixture',
      });
      if (broken.kind !== 'committed')
        throw new Error('Could not corrupt fixture');
      h.replaceState({ ...h.state(), head: { ...head, pin: broken.pin } });
      expect(await a.present('recipient', head.epoch)).toEqual({
        kind: 'blocked',
        reason: 'corrupt',
      });
      expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
      expect(h.deletion).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: broken.pin.revision }),
      );
      expect(await vault.repository.get(head.pin.ref)).toEqual({
        kind: 'not_found',
        reason: 'deleted',
      });
    },
  );
});

describe('P4 adversarial lifecycle review', () => {
  it('does not submit a cancelled setup after an async writer lookup', async () => {
    const h = harness();
    const writer = deferred<VaultFamilyWriter>();
    const started = deferred<void>();
    const a = createCopilotVaultGrantAuthority({
      ...h.options,
      writer: async () => {
        started.resolve();
        return writer.promise;
      },
    });
    const creating = a.create(grant(), 'setup');
    await started.promise;
    const id = pending(await a.status());
    const cancelling = a.cancel(id);
    // The old implementation completes cancel before the lookup can submit.
    // Resolve from reconcile so the test also permits a safe drain implementation.
    const reconcile = h.journal.reconcile.bind(h.journal);
    h.journal.reconcile = async (
      operationId,
    ): ReturnType<CopilotAuthorityJournal['reconcile']> => {
      const outcome = await reconcile(operationId);
      writer.resolve(h.raw);
      return outcome;
    };
    writer.resolve(h.raw);
    await cancelling;
    await creating;
    expect(await h.repository.list()).toHaveLength(0);
  });

  it('fences resume while setup compensation is disabling its pin', async () => {
    const h = harness();
    h.confirm.mockResolvedValueOnce({ kind: 'unconfirmed' });
    const a = h.create();
    await a.create(grant(), 'setup');
    const id = pending(await a.status());
    const disabled =
      deferred<
        Awaited<
          ReturnType<CopilotGrantAuthorityOptions['selection']['disable']>
        >
      >();
    const started = deferred<void>();
    h.disable.mockImplementationOnce(() => {
      started.resolve();
      return disabled.promise;
    });
    const cancelling = a.cancel(id);
    await started.promise;
    const resuming = await a.resume(id);
    disabled.resolve({ kind: 'disabled' });
    await cancelling;
    expect(resuming.kind).toBe('blocked');
    expect(h.state().head).toBeNull();
    expect(await h.repository.list()).toHaveLength(0);
  });

  it('does not deliver a revision whose admission closes during final journal read', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant(), 'setup'));
    const read = h.journal.read.bind(h.journal);
    let reads = 0;
    h.journal.read = async (): ReturnType<CopilotAuthorityJournal['read']> => {
      const record = await read();
      if (++reads === 2) {
        const hold = h.memory.holdNextCommit();
        void h.raw.delete({
          ref: head.pin.ref,
          expectedRevision: head.pin.revision,
          idempotencyKey: 'external-clear',
        });
        hold.release({ kind: 'unavailable' });
      }
      return record;
    };
    expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it.each(['before', 'during'] as const)(
    'does not undo runtime revoke %s removal on a failed preference disable',
    async (timing) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      if (timing === 'before') a.revoke();
      const disabled =
        deferred<
          Awaited<
            ReturnType<CopilotGrantAuthorityOptions['selection']['disable']>
          >
        >();
      const started = deferred<void>();
      h.disable.mockImplementationOnce(() => {
        started.resolve();
        return disabled.promise;
      });
      const removing = a.remove(head.epoch);
      await started.promise;
      if (timing === 'during') a.revoke();
      disabled.resolve({ kind: 'failed' });
      expect(await removing).toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
      expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
      expect(h.deliver).not.toHaveBeenCalled();
      a.reopen();
      expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    },
  );

  it.each(['setup', 'import'] as const)(
    'does not reopen revoked admission when %s starts after runtime revoke',
    async (origin) => {
      const h = harness();
      const a = h.create();
      a.revoke();
      const head = ready(await a.create(grant(), origin));
      expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
      expect(h.deliver).not.toHaveBeenCalled();
      a.reopen();
      expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    },
  );
});

describe('P4 cancellation durability review', () => {
  it('preserves cancellation across a submitted create commit and authority restart', async () => {
    const h = harness();
    const hold = h.memory.holdNextCommit();
    const submitted = deferred<void>();
    const rawPut = h.put.getMockImplementation();
    h.put.mockImplementation(async (request) => {
      const result = rawPut?.(request);
      submitted.resolve();
      if (!result) throw new Error('No put');
      return result;
    });
    const a = h.create();
    const creating = a.create(grant(), 'setup');
    await submitted.promise;
    const id = pending(await a.status());
    const disabling = deferred<void>();
    const disableResult =
      deferred<
        Awaited<
          ReturnType<CopilotGrantAuthorityOptions['selection']['disable']>
        >
      >();
    h.disable.mockImplementationOnce(() => {
      disabling.resolve();
      return disableResult.promise;
    });
    const cancelling = a.cancel(id);
    hold.release({ kind: 'committed' });
    await creating;
    await disabling.promise;
    const resumed = await h.create().resume(id);
    disableResult.resolve({ kind: 'disabled' });
    await cancelling;
    expect(resumed.kind).toBe('blocked');
    expect(h.state().head).toBeNull();
  });
});

describe('P4 typed journal recovery', () => {
  it.each(['corrupt', 'unconfirmed', 'unavailable'] as const)(
    'fences a %s journal without leaking dependency text, then recovers',
    async (reason) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      const read = h.journal.read.bind(h.journal);
      h.journal.read = (): ReturnType<CopilotAuthorityJournal['read']> =>
        Promise.reject(new CopilotAuthorityJournalError(reason));
      expect(await a.present('recipient', head.epoch)).toEqual({
        kind: 'blocked',
        reason,
      });
      expect(h.deliver).not.toHaveBeenCalled();
      expect(h.refresh).not.toHaveBeenCalled();
      expect(h.deletion).not.toHaveBeenCalled();
      h.journal.read = read;
      expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    },
  );
});

describe('P4 presentation admission review', () => {
  it('checks recipient admission again before provider presentation', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    h.admitted.mockReturnValueOnce(true).mockReturnValue(false);
    expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('does not present an old-generation demand after revoke and reopen during load', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    const get = h.repository.get.bind(h.repository);
    h.repository.get = async (ref): ReturnType<VaultRepository['get']> => {
      const result = await get(ref);
      a.revoke();
      a.reopen();
      return result;
    };
    expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('checks revision admission after the awaited refresh journal read', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    const read = h.journal.read.bind(h.journal);
    let reads = 0;
    h.journal.read = async (): ReturnType<CopilotAuthorityJournal['read']> => {
      const record = await read();
      if (++reads === 2) {
        const hold = h.memory.holdNextCommit();
        void h.raw.delete({
          ref: head.pin.ref,
          expectedRevision: head.pin.revision,
          idempotencyKey: 'closed-before-presentation',
        });
        hold.release({ kind: 'unavailable' });
      }
      return record;
    };
    expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each(['probe', 'pin'] as const)(
    'a setup %s acknowledgement cannot undo a later runtime revoke',
    async (stage) => {
      const h = harness();
      const a = h.create();
      const started = deferred<void>();
      const finish = deferred<void>();
      if (stage === 'probe')
        h.probe.mockImplementationOnce(async () => {
          started.resolve();
          await finish.promise;
        });
      else
        h.confirm.mockImplementationOnce(async (request) => {
          started.resolve();
          await finish.promise;
          return {
            kind: 'confirmed',
            receipt: { ...request, pinGeneration: 'pin' },
          };
        });
      const creating = a.create(grant(), 'setup');
      await started.promise;
      a.revoke();
      finish.resolve();
      const head = ready(await creating);
      expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
      expect(h.deliver).not.toHaveBeenCalled();
      a.reopen();
      expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    },
  );
});

describe('P4 provider response loss across restart', () => {
  it.each(['success', 'rejected'] as const)(
    'presents the stored revision on next demand after a %s response was lost before checkpoint',
    async (kind) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', -1), 'setup'));
      h.refresh.mockImplementationOnce(() => {
        h.failCAS();
        return Promise.resolve(
          kind === 'success'
            ? { kind: 'success', grant: grant('-received') }
            : { kind: 'rejected' },
        );
      });
      expect((await a.present('recipient', head.epoch)).kind).toBe(
        kind === 'success' ? 'delivered' : 'blocked',
      );
      expect(h.refresh).toHaveBeenCalledTimes(1);
      if (kind === 'success')
        expect(h.deliver).toHaveBeenLastCalledWith(
          'recipient',
          ACCESS + '-received',
          NOW + 7_200_000,
        );
      else expect(h.deliver).not.toHaveBeenCalled();
      expect(h.state().mutation?.kind).toBe('refresh');
      const restarted = h.restart();
      expect((await restarted.present('recipient', head.epoch)).kind).toBe(
        'delivered',
      );
      expect(h.refresh).toHaveBeenCalledTimes(2);
      expect(h.refresh.mock.calls[1]?.[0].refreshToken).toBe(REFRESH);
      expect(h.deliver).toHaveBeenLastCalledWith(
        'recipient',
        ACCESS + '-next',
        NOW + 7_200_000,
      );
      expect(await restarted.remove(head.epoch)).toEqual({ kind: 'removed' });
    },
  );
});

describe('P4 cancellation scope', () => {
  it('a rejected cancellation of a replacement cannot poison its same-key saving', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    const hold = h.memory.holdNextCommit();
    await a.present('recipient', head.epoch);
    const operationId = pending(await a.status());
    hold.release({ kind: 'unavailable' });
    await h.writesSettled();
    expect(await a.cancel(operationId)).toEqual({
      kind: 'blocked',
      reason: 'changed',
    });
    ready(await a.resume(operationId));
    expect(h.put).toHaveBeenCalledTimes(3);
  });
});

describe('P4 write-ahead presentation identity', () => {
  it('will not contact the provider without a definite durable refresh fence', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    h.loseCAS();
    expect(await a.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.state().mutation?.kind).toBe('refresh');
    // A live instance knows it never submitted; it can retire that exact fence.
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('retries local lost-response retirement before exactly one next-demand presentation', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    h.refresh.mockImplementationOnce(() => {
      h.failCAS();
      return Promise.resolve({ kind: 'lost' });
    });
    expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('revalidates demand admission after the durable refresh fence acknowledgement', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    const cas = h.journal.compareExchange.bind(h.journal);
    h.journal.compareExchange = async (
      sequence,
      next,
    ): ReturnType<CopilotAuthorityJournal['compareExchange']> => {
      const saved = await cas(sequence, next);
      if (next.mutation?.kind === 'refresh') {
        a.revoke();
        a.reopen();
      }
      return saved;
    };
    expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.state().mutation).toBeNull();
  });
});

describe('P4 D31 restart demand', () => {
  it('a fresh boot identity without an exclusive store capability never proves orphanhood', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 1), 'setup'));
    h.replaceState({
      ...h.state(),
      sequence: h.state().sequence + 1,
      mutation: {
        operationId: 'orphan-refresh',
        epoch: head.epoch,
        account: head.account,
        origin: head.origin,
        kind: 'refresh',
        from: head.pin,
        committed: null,
        probeConfirmed: true,
        cancelling: false,
      },
    });
    const before = h.state();
    const journal: CopilotAuthorityJournal = {
      read: () => h.journal.read(),
      compareExchange: (sequence, next) =>
        h.journal.compareExchange(sequence, next),
      reconcile: (id) => h.journal.reconcile(id),
    };
    const restarted = createCopilotVaultGrantAuthority({
      ...h.options,
      journal,
      processLifetime: {},
    });
    expect(await restarted.present('recipient', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
    expect(h.state()).toEqual(before);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.deletion).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });
  it.each(['success', 'rejected', 'lost'] as const)(
    'presents the stored grant exactly once after process loss, with next response %s',
    async (kind) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', -1), 'setup'));
      const started = deferred<void>();
      const lost =
        deferred<
          Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
        >();
      h.refresh.mockImplementationOnce(() => {
        started.resolve();
        return lost.promise;
      });
      const interrupted = a.present('recipient', head.epoch);
      await started.promise;
      const fence = h.state().mutation;
      expect(fence?.kind).toBe('refresh');
      const restarted = h.restart();
      await restarted.status();
      expect(h.state().mutation).toEqual(fence);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      h.refresh.mockResolvedValueOnce(
        kind === 'success' ? { kind, grant: grant('-recovered') } : { kind },
      );
      expect(await restarted.present('recipient', head.epoch)).toEqual(
        kind === 'success'
          ? {
              kind: 'delivered',
              expiresAt: NOW + 7_200_000,
              committedPin: null,
            }
          : {
              kind: 'blocked',
              reason: kind === 'rejected' ? 'expired' : 'network',
            },
      );
      expect(h.refresh).toHaveBeenCalledTimes(2);
      expect(h.refresh.mock.calls[1]?.[0]).toEqual(grant('', -1));
      if (kind === 'rejected') {
        expect(h.deletion).toHaveBeenCalledTimes(1);
        expect(h.deletion.mock.calls[0]?.[0].ref).toEqual(head.pin.ref);
        expect(h.deletion.mock.calls[0]?.[0].expectedRevision).toBe(
          head.pin.revision,
        );
      } else expect(h.deletion).not.toHaveBeenCalled();
      if (kind !== 'success') expect(h.deliver).not.toHaveBeenCalled();
      lost.resolve({ kind: 'lost' });
      await interrupted;
      await h.writesSettled();
      expect(h.refresh).toHaveBeenCalledTimes(2);
      expect(h.state().mutation).toBeNull();
      if (kind === 'success')
        expect(h.state().head?.pin.revision).toBe(head.pin.revision + 1);
    },
  );

  it('retains an orphaned refresh fence until admitted demand and definite retirement CAS', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    const started = deferred<void>();
    const lost =
      deferred<Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>>();
    h.refresh.mockImplementationOnce(() => {
      started.resolve();
      return lost.promise;
    });
    const interrupted = a.present('recipient', head.epoch);
    await started.promise;
    const fence = h.state().mutation;
    const restarted = h.create();
    expect((await restarted.present('recipient', 'wrong-epoch')).kind).toBe(
      'blocked',
    );
    h.admitted.mockReturnValue(false);
    expect((await restarted.present('recipient', head.epoch)).kind).toBe(
      'blocked',
    );
    h.admitted.mockReturnValue(true);
    restarted.revoke();
    expect((await restarted.present('recipient', head.epoch)).kind).toBe(
      'blocked',
    );
    restarted.reopen();
    expect((await restarted.present('recipient', head.epoch)).kind).toBe(
      'blocked',
    );
    expect(h.state().mutation).toEqual(fence);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.deletion).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
    h.readFails(true);
    lost.resolve({ kind: 'lost' });
    await interrupted;
    h.readFails(false);
    h.failCAS();
    expect((await restarted.present('recipient', head.epoch)).kind).toBe(
      'blocked',
    );
    expect(h.state().mutation).toEqual(fence);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect((await restarted.present('recipient', head.epoch)).kind).toBe(
      'delivered',
    );
    expect(h.refresh).toHaveBeenCalledTimes(2);
    lost.resolve({ kind: 'lost' });
    await interrupted;
  });
});

describe('P4 orphan fence contention', () => {
  it('survives a lost retirement acknowledgement without automatic presentation', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    const started = deferred<void>();
    const response =
      deferred<Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>>();
    h.refresh.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const interrupted = a.present('recipient', head.epoch);
    await started.promise;
    h.readFails(true);
    response.resolve({ kind: 'lost' });
    await interrupted;
    h.readFails(false);
    const restarted = h.create();
    h.loseCAS();
    expect((await restarted.present('recipient', head.epoch)).kind).toBe(
      'blocked',
    );
    expect(h.state().mutation).toBeNull();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    const committed = deferred<void>();
    const cas = h.journal.compareExchange.bind(h.journal);
    h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
      const accepted = await cas(sequence, next);
      if (accepted && next.head?.pin.revision === head.pin.revision + 1)
        committed.resolve();
      return accepted;
    };
    const results = await Promise.all([
      restarted.present('recipient', head.epoch),
      restarted.present('recipient', head.epoch),
    ]);
    expect(results.every((result) => result.kind === 'delivered')).toBe(true);
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.refresh.mock.calls[1]?.[0]).toEqual(grant('', -1));
    response.resolve({ kind: 'lost' });
    await interrupted;
    await committed.promise;
    await h.writesSettled();
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.put).toHaveBeenCalledTimes(2);
    expect(h.state().head?.pin.revision).toBe(head.pin.revision + 1);
    expect(h.state().mutation).toBeNull();
  });

  it.each(['removal', 'revision'] as const)(
    'rechecks %s when retirement CAS loses',
    async (race) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', -1), 'setup'));
      const started = deferred<void>();
      const response =
        deferred<
          Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
        >();
      h.refresh.mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      const interrupted = a.present('recipient', head.epoch);
      await started.promise;
      h.readFails(true);
      response.resolve({ kind: 'lost' });
      await interrupted;
      h.readFails(false);
      const compareExchange = h.journal.compareExchange.bind(h.journal);
      let intercepted = false;
      h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
        if (!intercepted && !next.mutation) {
          intercepted = true;
          const current = h.state();
          if (race === 'removal')
            h.replaceState({
              ...current,
              sequence: current.sequence + 1,
              removal: { operationId: 'remove', epoch: head.epoch },
            });
          else {
            const result = await h.raw.put({
              material: Buffer.from(JSON.stringify(grant('-concurrent', -1))),
              ref: head.pin.ref,
              expectedRevision: head.pin.revision,
              idempotencyKey: 'concurrent-replace',
              label: 'Copilot',
              expiresAt: null,
            });
            if (result.kind !== 'committed')
              throw new Error('Expected committed');
            h.replaceState({
              ...current,
              sequence: current.sequence + 1,
              mutation: null,
              head: { ...head, pin: result.pin },
            });
          }
        }
        return compareExchange(sequence, next);
      };
      const restarted = h.create();
      const result = await restarted.present('recipient', head.epoch);
      if (race === 'removal') {
        expect(result).toEqual({ kind: 'blocked', reason: 'changed' });
        expect(h.refresh).toHaveBeenCalledTimes(1);
        expect(h.deliver).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual(expect.objectContaining({ kind: 'delivered' }));
        expect(h.refresh).toHaveBeenCalledTimes(2);
        expect(h.refresh.mock.calls[1]?.[0]).toEqual(grant('-concurrent', -1));
      }
      response.resolve({ kind: 'lost' });
      await interrupted;
      await h.writesSettled();
      if (race === 'removal')
        expect(h.state().removal).toEqual({
          operationId: 'remove',
          epoch: head.epoch,
        });
      expect(h.refresh).toHaveBeenCalledTimes(race === 'removal' ? 1 : 2);
    },
  );
});

describe('P4 strict custody validation', () => {
  it('validates bounded grant fields, calendar dates and unknown fields without retaining caller objects', () => {
    for (const invalid of [
      null,
      [],
      {},
      { ...grant(), extra: true },
      { ...grant(), accessToken: '' },
      { ...grant(), refreshToken: 'x'.repeat(100_001) },
      { ...grant(), clientId: 'x'.repeat(513) },
      { ...grant(), host: '' },
      { ...grant(), login: 'x'.repeat(513) },
      { ...grant(), id: '1'.repeat(129) },
      { ...grant(), version: 2 },
      { ...grant(), accessTokenExpiresAt: '2026-02-29T00:00:00Z' },
      { ...grant(), accessTokenExpiresAt: '2026-11-06T24:00:00Z' },
      { ...grant(), refreshTokenExpiresAt: '2026-11-06T10:00:00' },
      {
        ...grant(),
        accessToken: '\u0000'.repeat(100_000),
        refreshToken: '\u0000'.repeat(100_000),
      },
    ])
      expect(CopilotVaultGrantSchema.safeParse(invalid).success).toBe(false);
    const input = {
      ...grant(),
      accessTokenExpiresAt: '2028-02-29T10:00:00+01:00',
    };
    const parsed = CopilotVaultGrantSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    input.accessToken = 'mutated';
    if (!parsed.success) throw new Error('Expected valid grant');
    expect(parsed.data.accessToken).toBe(ACCESS);
    let reads = 0;
    const changing = CopilotVaultGrantSchema.safeParse({
      ...grant(),
      get accessToken(): string | null {
        return reads++ === 0 ? ACCESS : null;
      },
    });
    expect(changing.success).toBe(true);
    if (!changing.success) throw new Error('Expected valid snapshot');
    expect(changing.data.accessToken).toBe(ACCESS);
    expect(
      CopilotVaultGrantSchema.safeParse({
        ...grant(),
        accessToken: () => ACCESS,
      }).success,
    ).toBe(false);
  });

  it('validates every journal branch and nested pin without retaining caller objects', async () => {
    const h = harness();
    const head = ready(await h.create().create(grant(), 'setup'));
    const record = h.state();
    const mutation = {
      operationId: 'attempt',
      epoch: head.epoch,
      account: head.account,
      origin: head.origin,
      kind: 'replace',
      from: head.pin,
      committed: null,
      probeConfirmed: true,
      cancelling: false,
    };
    for (const invalid of [
      null,
      [],
      {},
      { ...record, sequence: -1 },
      { ...record, sequence: 0.5 },
      { ...record, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...record, extra: REFRESH },
      { ...record, head: { ...head, extra: REFRESH } },
      {
        ...record,
        head: { ...head, account: { ...head.account, extra: REFRESH } },
      },
      { ...record, head: { ...head, pin: { ...head.pin, revision: -1 } } },
      {
        ...record,
        head: {
          ...head,
          pin: { ...head.pin, ref: { ...head.pin.ref, extra: REFRESH } },
        },
      },
      { ...record, mutation: { ...mutation, kind: 'unknown' } },
      { ...record, mutation: { ...mutation, from: {} } },
      { ...record, mutation: { ...mutation, committed: {} } },
      { ...record, mutation: { ...mutation, probeConfirmed: 'true' } },
      { ...record, mutation: { ...mutation, cancelling: null } },
      { ...record, removal: { operationId: '', epoch: head.epoch } },
      {
        ...record,
        completed: {
          operationId: 'attempt',
          epoch: head.epoch,
          kind: 'refresh',
        },
      },
    ])
      expect(CopilotAuthorityRecordSchema.safeParse(invalid).success).toBe(
        false,
      );
    const parsed = CopilotAuthorityRecordSchema.parse({
      ...record,
      mutation,
      removal: { operationId: 'remove', epoch: head.epoch },
      completed: {
        operationId: 'completed',
        epoch: head.epoch,
        kind: 'replace',
      },
    });
    head.account.login = 'mutated';
    expect(parsed.mutation?.account.login).toBe('pilot');
    expect(parsed.head?.account.login).toBe('pilot');
    expect(() =>
      CopilotAuthorityRecordSchema.parse({ ...record, accessToken: ACCESS }),
    ).toThrow('Invalid Copilot custody record.');
  });
});

describe('P4 review lifecycle recovery', () => {
  it.each(['schema', 'account', 'client'] as const)(
    'retires an unusable %s refresh response without replaying the demand',
    async (mismatch) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 60_000), 'setup'));
      const successor = grant('-invalid');
      if (mismatch === 'schema') successor.accessToken = '';
      if (mismatch === 'account') successor.login = 'renamed';
      if (mismatch === 'client') successor.clientId = 'other-client';
      h.refresh.mockResolvedValueOnce({ kind: 'success', grant: successor });
      expect(await a.present('recipient', head.epoch)).toEqual({
        kind: 'blocked',
        reason: 'changed',
      });
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(h.deliver).not.toHaveBeenCalled();
      h.refresh.mockResolvedValueOnce({ kind: 'lost' });
      expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
      expect(h.refresh).toHaveBeenCalledTimes(2);
      expect(h.refresh.mock.calls[1]?.[0]).toEqual(grant('', 60_000));
      expect(h.deliver).toHaveBeenCalledTimes(1);
      expect(h.deliver).toHaveBeenLastCalledWith(
        'recipient',
        ACCESS,
        NOW + 60_000,
      );
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.state().mutation).toBeNull();
    },
  );

  it.each(['remove', 'resume'] as const)(
    'reconciles an uncertain deletion before %s retries it after restart',
    async (retry) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      h.deletion.mockImplementation(async (request) => {
        const result = await h.raw.delete(request);
        if (result.kind !== 'committed') throw new Error('Expected tombstone');
        h.resolutions.set(request.idempotencyKey, { kind: 'unconfirmed' });
        return { kind: 'outcome_unknown', ref: result.ref };
      });
      expect(await a.remove(head.epoch)).toEqual({
        kind: 'blocked',
        reason: 'unconfirmed',
      });
      const mutation = h.state().mutation;
      if (!mutation) throw new Error('Missing delete receipt');
      const restarted = h.create();
      const retryRemoval = (): Promise<CopilotGrantResult> =>
        retry === 'remove'
          ? restarted.remove(head.epoch)
          : restarted.resume(mutation.operationId);
      expect(await retryRemoval()).toEqual({
        kind: 'blocked',
        reason: 'unconfirmed',
      });
      h.resolutions.set(mutation.operationId, {
        kind: 'committed',
        pin: { ref: head.pin.ref, revision: head.pin.revision + 1 },
      });
      expect(await retryRemoval()).toEqual({ kind: 'removed' });
      expect(h.deletion).toHaveBeenCalledTimes(1);
      expect(h.state().head).toBeNull();
      expect(h.state().mutation).toBeNull();
      expect(h.state().removal).toBeNull();
      expect(await restarted.remove(head.epoch)).toEqual({ kind: 'removed' });
    },
  );

  it.each(['entry', 'revision'] as const)(
    'does not complete deletion from a reconciled tombstone with the wrong %s',
    async (mismatch) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      h.deletion.mockResolvedValueOnce({
        kind: 'outcome_unknown',
        ref: head.pin.ref,
      });
      expect((await a.remove(head.epoch)).kind).toBe('blocked');
      const mutation = h.state().mutation;
      if (!mutation) throw new Error('Missing delete receipt');
      h.resolutions.set(mutation.operationId, {
        kind: 'committed',
        pin: {
          ref: {
            ...head.pin.ref,
            entryId:
              mismatch === 'entry' ? 'other-entry' : head.pin.ref.entryId,
          },
          revision: head.pin.revision + (mismatch === 'revision' ? 0 : 1),
        },
      });
      expect(await a.resume(mutation.operationId)).toEqual({
        kind: 'blocked',
        reason: 'unconfirmed',
      });
      expect(h.state().head).toEqual(head);
      expect(h.state().mutation?.operationId).toBe(mutation.operationId);
      expect(h.deletion).toHaveBeenCalledTimes(1);
    },
  );

  it('resumes a pending setup after revoke without reopening recipient admission', async () => {
    const h = harness();
    const a = h.create();
    h.confirm.mockResolvedValueOnce({ kind: 'unconfirmed' });
    expect(await a.create(grant(), 'setup')).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
    const id = pending(await a.status());
    a.revoke();
    const head = ready(await a.resume(id));
    expect((await a.present('recipient', head.epoch)).kind).toBe('blocked');
    expect(h.deliver).not.toHaveBeenCalled();
    a.reopen();
    expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
  });

  it.each([false, true])(
    'does not revoke replacement recipients from a delayed stale removal read (existing fence: %s)',
    async (existingFence) => {
      const h = harness();
      const a = h.create();
      const old = ready(await a.create(grant(), 'setup'));
      if (existingFence) {
        h.disable.mockResolvedValueOnce({ kind: 'unconfirmed' });
        expect((await a.remove(old.epoch)).kind).toBe('blocked');
      }
      const read = h.journal.read.bind(h.journal);
      const stale = await read();
      const started = deferred<void>();
      const finish = deferred<void>();
      let held = false;
      h.journal.read = async (): Promise<CopilotAuthorityRecord> => {
        if (!held) {
          held = true;
          started.resolve();
          await finish.promise;
          return stale;
        }
        return read();
      };
      const removing = a.remove(old.epoch);
      await started.promise;
      a.revoke();
      expect(await h.create().remove(old.epoch)).toEqual({ kind: 'removed' });
      a.reopen();
      const next = ready(await a.create(grant('-replacement'), 'setup'));
      expect((await a.present('replacement', next.epoch)).kind).toBe(
        'delivered',
      );
      const revocations = h.revoke.mock.calls.length;
      finish.resolve();
      expect((await removing).kind).toBe('blocked');
      expect(h.revoke).toHaveBeenCalledTimes(revocations);
      expect((await a.present('replacement', next.epoch)).kind).toBe(
        'delivered',
      );
      expect(h.deletion).toHaveBeenCalledTimes(1);
    },
  );
});

describe('P4 removal acknowledgement isolation', () => {
  it.each([false, true])(
    'does not revoke a replacement after a delayed successful removal CAS (existing fence: %s)',
    async (existingFence) => {
      const h = harness();
      const a = h.create();
      const old = ready(await a.create(grant(), 'setup'));
      if (existingFence) {
        h.disable.mockResolvedValueOnce({ kind: 'unconfirmed' });
        expect((await a.remove(old.epoch)).kind).toBe('blocked');
      }
      const compareExchange = h.journal.compareExchange.bind(h.journal);
      const started = deferred<void>();
      const finish = deferred<void>();
      let held = false;
      h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
        const accepted = await compareExchange(sequence, next);
        if (!held && accepted && next.removal) {
          held = true;
          started.resolve();
          await finish.promise;
        }
        return accepted;
      };
      const removing = a.remove(old.epoch);
      await started.promise;
      a.revoke();
      expect(await h.create().remove(old.epoch)).toEqual({ kind: 'removed' });
      a.reopen();
      const next = ready(await a.create(grant('-replacement'), 'setup'));
      expect((await a.present('replacement', next.epoch)).kind).toBe(
        'delivered',
      );
      const revocations = h.revoke.mock.calls.length;
      finish.resolve();
      expect((await removing).kind).toBe('blocked');
      expect(h.revoke).toHaveBeenCalledTimes(revocations);
      expect((await a.present('replacement', next.epoch)).kind).toBe(
        'delivered',
      );
      expect(h.deletion).toHaveBeenCalledTimes(1);
    },
  );
});

describe('P4 deletion cleanup isolation', () => {
  it.each(['fence', 'completion'] as const)(
    'does not discard a replacement setup grant after a delayed deletion %s CAS',
    async (stage) => {
      const h = harness();
      const a = h.create();
      const old = ready(await a.create(grant(), 'setup'));
      const compareExchange = h.journal.compareExchange.bind(h.journal);
      const started = deferred<void>();
      const finish = deferred<void>();
      let held = false;
      h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
        const accepted = await compareExchange(sequence, next);
        if (
          !held &&
          accepted &&
          (stage === 'fence'
            ? next.mutation?.kind === 'delete'
            : !next.head && next.completed?.kind === 'delete')
        ) {
          held = true;
          started.resolve();
          await finish.promise;
        }
        return accepted;
      };
      const removing = a.remove(old.epoch);
      await started.promise;
      expect(await h.create().remove(old.epoch)).toEqual({ kind: 'removed' });
      h.nextPut({ kind: 'blocked', reason: 'unavailable' });
      const id = pending(await a.create(grant('-replacement'), 'setup'));
      finish.resolve();
      expect(await removing).toEqual({ kind: 'removed' });
      const next = ready(await a.resume(id));
      a.reopen();
      expect((await a.present('replacement', next.epoch)).kind).toBe(
        'delivered',
      );
      expect(h.deliver).toHaveBeenLastCalledWith(
        'replacement',
        ACCESS + '-replacement',
        NOW + 7_200_000,
      );
    },
  );
});

describe('P4 unusable refresh settlement recovery', () => {
  it.each(['read', 'CAS', 'lost-CAS'] as const)(
    'retries unusable-response retirement after a journal %s failure without automatic presentation',
    async (failure) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 60_000), 'setup'));
      h.refresh.mockImplementationOnce(() => {
        if (failure === 'read') h.readFails(true);
        else if (failure === 'CAS') h.failCAS();
        else h.loseCAS();
        return Promise.resolve({
          kind: 'success',
          grant: { ...grant('-invalid'), clientId: 'other' },
        });
      });
      expect(await a.present('recipient', head.epoch)).toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
      expect(h.deliver).not.toHaveBeenCalled();
      expect(h.refresh).toHaveBeenCalledTimes(1);
      h.readFails(false);
      h.refresh.mockResolvedValueOnce({ kind: 'lost' });
      expect((await a.present('recipient', head.epoch)).kind).toBe('delivered');
      expect(h.refresh).toHaveBeenCalledTimes(2);
      expect(h.deliver).toHaveBeenCalledTimes(1);
      expect(h.deliver).toHaveBeenLastCalledWith(
        'recipient',
        ACCESS,
        NOW + 60_000,
      );
      expect(h.state().mutation).toBeNull();
      expect(h.put).toHaveBeenCalledTimes(1);
    },
  );
});

describe('P4 concurrent removal retries', () => {
  it('keeps the retained removal identity through concurrent retries and completes after reconciliation', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant(), 'setup'));
    h.deletion.mockImplementationOnce(async (request) => {
      const result = await h.raw.delete(request);
      if (result.kind !== 'committed')
        throw new Error('Expected committed delete');
      h.resolutions.set(request.idempotencyKey, { kind: 'unconfirmed' });
      return { kind: 'outcome_unknown', ref: result.ref };
    });
    expect((await a.remove(head.epoch)).kind).toBe('blocked');
    const mutation = h.state().mutation;
    const removal = h.state().removal;
    if (!mutation || !removal) throw new Error('Missing removal receipt');
    await Promise.all([
      a.remove(head.epoch),
      a.remove(head.epoch),
      a.resume(mutation.operationId),
    ]);
    expect(h.state().mutation).toEqual(mutation);
    expect(h.state().removal).toEqual(removal);
    expect(h.deletion).toHaveBeenCalledTimes(1);
    h.resolutions.set(mutation.operationId, {
      kind: 'committed',
      pin: { ref: head.pin.ref, revision: head.pin.revision + 1 },
    });
    expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
    expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
    expect(
      h.disable.mock.calls.every(
        ([request]) => request.operationId === removal.operationId,
      ),
    ).toBe(true);
    expect(h.deletion).toHaveBeenCalledTimes(1);
  });
});

describe('P4 epoch-owned refresh attempts', () => {
  it.each([
    ['admission-closed', 'pending'],
    ['admission-closed', 'confirmed'],
    ['read-failed', 'pending'],
    ['read-failed', 'confirmed'],
  ] as const)(
    'joins its successful attempt after a delayed predecessor load is %s and saving is %s',
    async (failure, stage) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      const entered = deferred<void>();
      const release = deferred<void>();
      const get = h.repository.get.bind(h.repository);
      let held = false;
      h.repository.get = async (ref): ReturnType<VaultRepository['get']> => {
        const result = await get(ref);
        if (!held) {
          held = true;
          entered.resolve();
          await release.promise;
          if (failure === 'read-failed') {
            if (result.kind === 'available') result.material.fill(0);
            throw new Error('Unavailable material');
          }
        }
        return result;
      };
      const delayed = a.present('delayed-load', head.epoch);
      await entered.promise;
      const hold = h.memory.holdNextCommit();
      expect((await a.present('driver', head.epoch)).kind).toBe('delivered');
      await new Promise<void>(setImmediate);
      expect(h.repository.admit(head.pin)).toEqual({ kind: 'unconfirmed' });
      const id = pending(await a.status());
      if (stage === 'confirmed') {
        hold.release({ kind: 'committed' });
        ready(await a.resume(id));
      }
      release.resolve();
      expect((await delayed).kind).toBe('delivered');
      expect(h.deliver.mock.calls.map(([, token]) => token)).toEqual(
        Array(2).fill(ACCESS + '-next'),
      );
      expect(h.refresh).toHaveBeenCalledTimes(1);
      if (stage === 'pending') {
        hold.release({ kind: 'committed' });
        ready(await a.resume(id));
      }
      expect(h.state().head?.pin.revision).toBe(head.pin.revision + 1);
    },
  );

  function holdJournal(
    h: Harness,
    predicate: (next: CopilotAuthorityRecord) => boolean,
    stage: 'submission' | 'acknowledgement',
  ): { entered: Promise<void>; release(): void } {
    const entered = deferred<void>();
    const release = deferred<void>();
    const cas = h.journal.compareExchange.bind(h.journal);
    let held = false;
    h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
      if (held || !predicate(next)) return cas(sequence, next);
      held = true;
      if (stage === 'submission') {
        entered.resolve();
        await release.promise;
      }
      const result = await cas(sequence, next);
      if (stage === 'acknowledgement') {
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    return { entered: entered.promise, release: (): void => release.resolve() };
  }

  it.each(['submission', 'acknowledgement'] as const)(
    'joins preparation with a held fence %s, then joins the live provider',
    async (stage) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      const fence = holdJournal(
        h,
        (next) => next.mutation?.kind === 'refresh',
        stage,
      );
      const started = deferred<void>();
      const response =
        deferred<
          Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
        >();
      h.refresh.mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      const first = a.present('first', head.epoch);
      await fence.entered;
      const preparing = a.present('preparing', head.epoch);
      await new Promise<void>(setImmediate);
      expect(h.refresh).not.toHaveBeenCalled();
      const operation = h.state().mutation?.operationId;
      fence.release();
      await started.promise;
      const presenting = a.present('presenting', head.epoch);
      await new Promise<void>(setImmediate);
      expect(h.state().mutation?.kind).toBe('refresh');
      if (operation) expect(h.state().mutation?.operationId).toBe(operation);
      response.resolve({ kind: 'success', grant: grant('-shared') });
      expect(
        (await Promise.all([first, preparing, presenting])).every(
          (r) => r.kind === 'delivered',
        ),
      ).toBe(true);
      expect(h.deliver.mock.calls.map(([, token]) => token)).toEqual(
        Array(3).fill(ACCESS + '-shared'),
      );
      expect(h.refresh).toHaveBeenCalledTimes(1);
      await h.writesSettled();
      const id =
        h.state().mutation?.operationId ?? h.state().completed?.operationId;
      if (!id) throw new Error('Missing attempt');
      ready(await a.resume(id));
      expect(h.state().head?.pin.revision).toBe(head.pin.revision + 1);
    },
  );

  it.each(['submission', 'acknowledgement'] as const)(
    'delivers an immutable successor without waiting for replacement checkpoint %s',
    async (stage) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      const checkpoint = holdJournal(
        h,
        (next) => next.mutation?.kind === 'replace',
        stage,
      );
      const first = a.present('first', head.epoch);
      await checkpoint.entered;
      const id = pending(await a.status());
      expect(await first).toMatchObject({
        kind: 'delivered',
        committedPin: null,
      });
      expect(await a.present('late', head.epoch)).toMatchObject({
        kind: 'delivered',
        committedPin: null,
      });
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      const saving = a.resume(id);
      checkpoint.release();
      ready(await saving);
      expect(h.put.mock.calls[1]?.[0].idempotencyKey).toBe(id);
      expect(h.deliver.mock.calls.map(([, token]) => token)).toEqual(
        Array(2).fill(ACCESS + '-next'),
      );
    },
  );

  it.each([
    'reconcile',
    'put-submission',
    'put-acknowledgement',
    'commit-submission',
    'commit-acknowledgement',
  ] as const)(
    'candidate delivery bypasses held %s and survives confirmation cleanup',
    async (stage) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      const entered = deferred<void>();
      const release = deferred<void>();
      let barrier: { entered: Promise<void>; release(): void } = {
        entered: entered.promise,
        release: () => release.resolve(),
      };
      if (stage === 'reconcile') {
        const reconcile = h.journal.reconcile.bind(h.journal);
        h.journal.reconcile = async (
          id,
        ): ReturnType<CopilotAuthorityJournal['reconcile']> => {
          entered.resolve();
          await release.promise;
          return reconcile(id);
        };
      } else if (
        stage === 'put-submission' ||
        stage === 'put-acknowledgement'
      ) {
        const put = h.put.getMockImplementation();
        if (!put) throw new Error('Missing writer');
        h.put.mockImplementationOnce(async (request) => {
          if (stage === 'put-submission') {
            entered.resolve();
            await release.promise;
          }
          const result = await put(request);
          if (stage === 'put-acknowledgement') {
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      } else {
        barrier = holdJournal(
          h,
          (next) => !next.mutation && next.completed?.kind === 'replace',
          stage === 'commit-submission' ? 'submission' : 'acknowledgement',
        );
      }
      const first = a.present('first', head.epoch);
      await barrier.entered;
      expect((await first).kind).toBe('delivered');
      const id =
        h.state().mutation?.operationId ?? h.state().completed?.operationId;
      if (!id) throw new Error('Missing attempt');
      const late = a.present('late', head.epoch);
      expect((await late).kind).toBe('delivered');
      const finishing = a.resume(id);
      barrier.release();
      ready(await finishing);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(h.put).toHaveBeenCalledTimes(2);
      expect(h.deliver.mock.calls.map(([, token]) => token)).toEqual(
        Array(2).fill(ACCESS + '-next'),
      );
    },
  );

  it.each(['locked', 'corrupt', 'unavailable'] as const)(
    'retains the same bytes and identity through %s storage recovery',
    async (reason) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      const submitted: string[] = [];
      const put = h.put.getMockImplementation();
      if (!put) throw new Error('Missing writer');
      h.put.mockImplementation(async (request) => {
        submitted.push(Buffer.from(request.material).toString('utf8'));
        return put(request);
      });
      h.nextPut({ kind: 'blocked', reason });
      expect((await a.present('first', head.epoch)).kind).toBe('delivered');
      await new Promise<void>(setImmediate);
      const id = pending(await a.status());
      expect((await a.present('late', head.epoch)).kind).toBe('delivered');
      ready(await a.resume(id));
      expect(submitted).toEqual([
        JSON.stringify(grant('-next')),
        JSON.stringify(grant('-next')),
      ]);
      expect(
        h.put.mock.calls.slice(1).map(([request]) => request.idempotencyKey),
      ).toEqual([id, id]);
      expect(h.refresh).toHaveBeenCalledTimes(1);
    },
  );

  it('retains custody but refuses delivery when the account journal is unreadable', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 1), 'setup'));
    h.refresh.mockImplementationOnce(() => {
      h.readFails(true);
      return Promise.resolve({ kind: 'success', grant: grant('-kept') });
    });
    expect((await a.present('first', head.epoch)).kind).toBe('blocked');
    expect(h.deliver).not.toHaveBeenCalled();
    h.readFails(false);
    expect((await a.present('later', head.epoch)).kind).toBe('delivered');
    expect(h.deliver).toHaveBeenLastCalledWith(
      'later',
      ACCESS + '-kept',
      NOW + 7_200_000,
    );
    expect(h.refresh).toHaveBeenCalledTimes(1);
    await h.writesSettled();
  });

  it('does not promote an outstanding pre-loss request into a next-demand retry', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', -1), 'setup'));
    const started = deferred<void>();
    const response =
      deferred<Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>>();
    h.refresh.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const first = a.present('first', head.epoch);
    await started.promise;
    const read = h.journal.read.bind(h.journal);
    const entered = deferred<void>();
    const release = deferred<void>();
    let held = false;
    h.journal.read = async (): ReturnType<CopilotAuthorityJournal['read']> => {
      const state = await read();
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return state;
    };
    const delayed = a.present('delayed', head.epoch);
    await entered.promise;
    response.resolve({ kind: 'lost' });
    expect(await first).toEqual({ kind: 'blocked', reason: 'network' });
    // Allocate a new attempt before the older ticket can finish its first read.
    expect((await a.present('next', head.epoch)).kind).toBe('delivered');
    release.resolve();
    expect(await delayed).toEqual({ kind: 'blocked', reason: 'changed' });
    expect(h.refresh).toHaveBeenCalledTimes(2);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    await h.writesSettled();
  });

  it.each(['submission', 'acknowledgement'] as const)(
    'serializes later-demand retries behind loss retirement %s',
    async (stage) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', -1), 'setup'));
      h.refresh.mockResolvedValueOnce({ kind: 'lost' });
      const retirement = holdJournal(
        h,
        (next) => !next.mutation && !next.completed,
        stage,
      );
      const first = a.present('first', head.epoch);
      await retirement.entered;
      const later = [
        a.present('later-1', head.epoch),
        a.present('later-2', head.epoch),
      ];
      await new Promise<void>(setImmediate);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      retirement.release();
      expect(await first).toEqual({ kind: 'blocked', reason: 'network' });
      expect(
        (await Promise.all(later)).every((r) => r.kind === 'delivered'),
      ).toBe(true);
      expect(h.refresh).toHaveBeenCalledTimes(2);
      expect(
        h.refresh.mock.calls.map(([material]) => material.refreshToken),
      ).toEqual([REFRESH, REFRESH]);
      await h.writesSettled();
    },
  );

  it.each(['submission', 'acknowledgement'] as const)(
    'keeps rejection terminal through delete-checkpoint %s uncertainty',
    async (stage) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      h.refresh.mockResolvedValueOnce({ kind: 'rejected' });
      const checkpoint = holdJournal(
        h,
        (next) => next.mutation?.kind === 'delete',
        stage,
      );
      const first = a.present('first', head.epoch);
      await checkpoint.entered;
      const late = a.present('late', head.epoch);
      await new Promise<void>(setImmediate);
      expect(h.deliver).not.toHaveBeenCalled();
      expect(h.deletion).not.toHaveBeenCalled();
      checkpoint.release();
      expect(await first).toEqual({ kind: 'blocked', reason: 'expired' });
      expect(await late).toEqual({ kind: 'blocked', reason: 'expired' });
      expect(h.deletion).toHaveBeenCalledTimes(1);
      expect(h.deletion.mock.calls[0]?.[0].expectedRevision).toBe(
        head.pin.revision,
      );
      expect(h.refresh).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['preparing', 'presenting', 'checkpoint', 'put'] as const)(
    'revoke/reopen at %s never delivers to the old generation',
    async (stage) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      const entered = deferred<void>();
      const release = deferred<void>();
      let barrier: { entered: Promise<void>; release(): void } = {
        entered: entered.promise,
        release: () => release.resolve(),
      };
      if (stage === 'preparing' || stage === 'checkpoint') {
        barrier = holdJournal(
          h,
          (next) =>
            next.mutation?.kind ===
            (stage === 'preparing' ? 'refresh' : 'replace'),
          'submission',
        );
      } else if (stage === 'presenting') {
        h.refresh.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { kind: 'success', grant: grant('-next') };
        });
      } else {
        const put = h.put.getMockImplementation();
        if (!put) throw new Error('Missing writer');
        h.put.mockImplementationOnce(async (request) => {
          entered.resolve();
          await release.promise;
          return put(request);
        });
      }
      // Hold candidate acquisition, not the independent storage driver's reads.
      const list = h.repository.list.bind(h.repository);
      const finalRead = deferred<void>();
      let lists = 0;
      h.repository.list = async (): ReturnType<VaultRepository['list']> => {
        if (++lists === 2 && (stage === 'checkpoint' || stage === 'put'))
          await finalRead.promise;
        return list();
      };
      const old = a.present('old-generation', head.epoch);
      await barrier.entered;
      a.revoke();
      a.reopen();
      finalRead.resolve();
      barrier.release();
      expect((await old).kind).toBe('blocked');
      expect(h.deliver).not.toHaveBeenCalled();
      expect((await a.present('new-generation', head.epoch)).kind).toBe(
        'delivered',
      );
      expect(h.refresh).toHaveBeenCalledTimes(1);
      await h.writesSettled();
    },
  );

  it('closes submission before removal metadata targeting after a delayed writer lookup', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const h = harness();
      const setup = h.create();
      const head = ready(await setup.create(grant('', 1), 'setup'));
      const writer = await h.options.writer();
      const lookup = deferred<void>();
      const release = deferred<VaultFamilyWriter>();
      h.writerFactory.mockImplementation(() => {
        lookup.resolve();
        return release.promise;
      });
      const a = h.create();
      const first = a.present('first', head.epoch);
      await lookup.promise;
      expect((await first).kind).toBe('delivered');
      const disabled = deferred<void>();
      h.disable.mockImplementationOnce(() => {
        disabled.resolve();
        return Promise.resolve({ kind: 'disabled' });
      });
      const removing = a.remove(head.epoch);
      await jest.advanceTimersByTimeAsync(2_001);
      await disabled.promise;
      expect(h.disable).toHaveBeenCalledTimes(1);
      expect(h.put).toHaveBeenCalledTimes(1);
      release.resolve(writer);
      expect(await removing).toEqual({ kind: 'removed' });
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.deletion.mock.calls[0]?.[0].expectedRevision).toBe(
        head.pin.revision,
      );
      expect(h.state().head).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['submission', 'acknowledgement'] as const)(
    'supersedes preparing work after the removal cap with fence %s held',
    async (stage) => {
      jest.useFakeTimers({ now: NOW });
      try {
        const h = harness();
        const a = h.create();
        const head = ready(await a.create(grant('', 1), 'setup'));
        const fence = holdJournal(
          h,
          (next) => next.mutation?.kind === 'refresh',
          stage,
        );
        const first = a.present('first', head.epoch);
        await fence.entered;
        const removing = a.remove(head.epoch);
        await jest.advanceTimersByTimeAsync(2_001);
        expect(await removing).toEqual({ kind: 'removed' });
        const next = ready(await a.create(grant('-new-account'), 'setup'));
        fence.release();
        expect((await first).kind).toBe('blocked');
        expect(h.refresh).not.toHaveBeenCalled();
        expect((await a.present('replacement', next.epoch)).kind).toBe(
          'delivered',
        );
        expect(h.put).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    },
  );
  it('drains response-created storage before disabling and deleting the latest revision', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 1), 'setup'));
    const started = deferred<void>();
    const response =
      deferred<Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>>();
    h.refresh.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const first = a.present('first', head.epoch);
    await started.promise;
    const revoked = deferred<void>();
    h.revoke.mockImplementationOnce(() => {
      revoked.resolve();
    });
    const removing = a.remove(head.epoch);
    await revoked.promise;
    expect(h.disable).not.toHaveBeenCalled();
    response.resolve({ kind: 'success', grant: grant('-drained') });
    expect((await first).kind).toBe('blocked');
    expect(await removing).toEqual({ kind: 'removed' });
    expect(h.put).toHaveBeenCalledTimes(2);
    expect(h.deletion.mock.calls[0]?.[0].expectedRevision).toBe(
      head.pin.revision + 1,
    );
    expect(h.disable.mock.calls[0]?.[0].head.pin.revision).toBe(
      head.pin.revision + 1,
    );
    expect(h.deliver).not.toHaveBeenCalled();
  });
  it('fences an uncertain absent CAS before allocating a new provider identity', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 1), 'setup'));
    const cas = h.journal.compareExchange.bind(h.journal);
    let late: (() => Promise<boolean>) | undefined;
    let lateAccepted: boolean | undefined;
    h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
      if (next.mutation?.kind === 'refresh') {
        if (!late) {
          late = (): Promise<boolean> => cas(sequence, next);
          throw new Error('Lost submission reply');
        }
        lateAccepted = await late();
      }
      return cas(sequence, next);
    };
    expect(await a.present('first', head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    expect(h.state().mutation).toBeNull();
    expect(h.refresh).not.toHaveBeenCalled();
    expect((await a.present('next', head.epoch)).kind).toBe('delivered');
    expect(lateAccepted).toBe(false);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    await h.writesSettled();
  });

  it('keeps a waiter-owned candidate through concurrent durable confirmation', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant('', 1), 'setup'));
    const list = h.repository.list.bind(h.repository);
    const entered = deferred<void>();
    const release = deferred<void>();
    let lists = 0;
    h.repository.list = async (): ReturnType<VaultRepository['list']> => {
      if (++lists === 2) {
        entered.resolve();
        await release.promise;
      }
      return list();
    };
    const first = a.present('waiter', head.epoch);
    await entered.promise;
    const id =
      h.state().mutation?.operationId ?? h.state().completed?.operationId;
    if (!id) throw new Error('Missing attempt');
    ready(await a.resume(id));
    expect(h.state().mutation).toBeNull();
    expect(h.state().head?.pin.revision).toBe(head.pin.revision + 1);
    release.resolve();
    expect(await first).toMatchObject({
      kind: 'delivered',
      committedPin: null,
    });
    expect(h.deliver).toHaveBeenLastCalledWith(
      'waiter',
      ACCESS + '-next',
      NOW + 7_200_000,
    );
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    'success',
    'rejected',
    'no-result',
    'orphan',
    'local-mutation',
  ] as const)(
    'removal supersedes %s effects after the drain cap without resurrecting the entry',
    async (stage) => {
      jest.useFakeTimers({ now: NOW });
      try {
        const h = harness();
        let a = h.create();
        const head = ready(await a.create(grant('', 1), 'setup'));
        let interrupted: Promise<CopilotGrantResult> | undefined;
        const lost =
          deferred<
            Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
          >();
        if (stage === 'orphan') {
          const started = deferred<void>();
          h.refresh.mockImplementationOnce(() => {
            started.resolve();
            return lost.promise;
          });
          interrupted = a.present('old-process', head.epoch);
          await started.promise;
          h.readFails(true);
          lost.resolve({ kind: 'lost' });
          await interrupted;
          h.readFails(false);
          a = h.create();
        } else if (stage === 'local-mutation') {
          h.nextPut({ kind: 'blocked', reason: 'locked' });
          expect((await a.present('old-process', head.epoch)).kind).toBe(
            'delivered',
          );
          // Settle the initial failed put, without advancing any deadline.
          await jest.advanceTimersByTimeAsync(0);
          a = h.create();
        } else if (stage !== 'success') {
          h.refresh.mockResolvedValueOnce(
            stage === 'rejected' ? { kind: 'rejected' } : { kind: 'lost' },
          );
        }
        const entered = deferred<void>();
        const release = deferred<void>();
        let barrier: { entered: Promise<void>; release(): void };
        if (stage === 'local-mutation') {
          const reconcile = h.journal.reconcile.bind(h.journal);
          let held = false;
          h.journal.reconcile = async (
            id,
          ): ReturnType<CopilotAuthorityJournal['reconcile']> => {
            if (!held) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return reconcile(id);
          };
          barrier = {
            entered: entered.promise,
            release: (): void => release.resolve(),
          };
        } else {
          barrier = holdJournal(
            h,
            (next) =>
              stage === 'success'
                ? next.mutation?.kind === 'replace'
                : stage === 'rejected'
                  ? next.mutation?.kind === 'delete'
                  : !next.mutation && !next.completed,
            'submission',
          );
        }
        const first = a.present('participant', head.epoch);
        await barrier.entered;
        const removing = a.remove(head.epoch);
        await jest.advanceTimersByTimeAsync(2_001);
        expect(await removing).toEqual({ kind: 'removed' });
        const replacement = ready(
          await a.create(grant('-replacement'), 'setup'),
        );
        barrier.release();
        await first;
        lost.resolve({ kind: 'lost' });
        if (interrupted) await interrupted;
        expect((await a.present('new-account', replacement.epoch)).kind).toBe(
          'delivered',
        );
        expect(h.state().head?.epoch).toBe(replacement.epoch);
        expect(h.put).toHaveBeenCalledTimes(stage === 'local-mutation' ? 3 : 2);
        expect(h.deletion).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    },
  );
  it('settles a superseded provider after removal targeting fails, without reopening submission', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant('', 1), 'setup'));
      const started = deferred<void>();
      const response =
        deferred<
          Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>
        >();
      h.refresh.mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
      const first = a.present('first', head.epoch);
      await started.promise;
      const list = h.repository.list.bind(h.repository);
      h.disable.mockImplementationOnce(() => {
        h.repository.list = (): ReturnType<VaultRepository['list']> =>
          Promise.reject(new Error('Unavailable metadata'));
        return Promise.resolve({ kind: 'disabled' });
      });
      const removing = a.remove(head.epoch);
      await jest.advanceTimersByTimeAsync(2_001);
      expect(await removing).toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
      response.resolve({ kind: 'success', grant: grant('-superseded') });
      expect((await first).kind).toBe('blocked');
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.deliver).not.toHaveBeenCalled();
      h.repository.list = list;
      expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
    } finally {
      jest.useRealTimers();
    }
  });
  it('reclassifies an orphan as a local mutation when its retirement loses to the exact response checkpoint', async () => {
    const h = harness();
    const old = h.create();
    const head = ready(await old.create(grant('', 1), 'setup'));
    const started = deferred<void>();
    const response =
      deferred<Awaited<ReturnType<CopilotGrantAuthorityOptions['refresh']>>>();
    h.refresh.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const first = old.present('old-process', head.epoch);
    await started.promise;
    const fence = h.state().mutation;
    if (!fence) throw new Error('Missing fence');
    h.readFails(true);
    response.resolve({ kind: 'lost' });
    await first;
    h.readFails(false);
    const cas = h.journal.compareExchange.bind(h.journal);
    let intercepted = false;
    h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
      if (!intercepted && !next.mutation) {
        intercepted = true;
        const stored = await h.raw.put({
          ref: head.pin.ref,
          expectedRevision: head.pin.revision,
          material: Buffer.from(JSON.stringify(grant('-durable'))),
          label: 'Copilot',
          expiresAt: null,
          idempotencyKey: fence.operationId,
        });
        if (stored.kind !== 'committed') throw new Error('Expected commit');
        h.resolutions.set(fence.operationId, {
          kind: 'committed',
          pin: stored.pin,
        });
        const state = h.state();
        h.replaceState({
          ...state,
          sequence: state.sequence + 1,
          mutation: { ...fence, kind: 'replace' },
        });
      }
      return cas(sequence, next);
    };
    const restarted = h.create();
    expect((await restarted.present('recovered', head.epoch)).kind).toBe(
      'delivered',
    );
    expect(h.deliver).toHaveBeenLastCalledWith(
      'recovered',
      ACCESS + '-durable',
      NOW + 7_200_000,
    );
    expect(h.refresh).toHaveBeenCalledTimes(1);
    response.resolve({ kind: 'lost' });
    expect((await first).kind).toBe('blocked');
  });
});

describe('P4 single-flight epoch removal', () => {
  it.each(['disabled', 'unconfirmed', 'throws'] as const)(
    'joins the first removal through %s without another disable',
    async (outcome) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      const entered = deferred<void>();
      const release =
        deferred<
          Awaited<
            ReturnType<CopilotGrantAuthorityOptions['selection']['disable']>
          >
        >();
      h.disable.mockImplementation(async () => {
        entered.resolve();
        const result = await release.promise;
        if (outcome === 'throws') throw new Error(REFRESH);
        return result;
      });
      const removing = a.remove(head.epoch);
      await entered.promise;
      const identity = h.state().removal;
      const joined = a.remove(head.epoch);
      expect((await a.present('while-removing', head.epoch)).kind).toBe(
        'blocked',
      );
      release.resolve({ kind: outcome === 'throws' ? 'unconfirmed' : outcome });
      const first = await removing;
      expect(await joined).toEqual(first);
      expect(first).toEqual(
        outcome === 'disabled'
          ? { kind: 'removed' }
          : {
              kind: 'blocked',
              reason: outcome === 'throws' ? 'unavailable' : 'unconfirmed',
            },
      );
      expectNoGrantSecrets(first);
      expect(h.disable).toHaveBeenCalledTimes(1);
      expect(h.revoke).toHaveBeenCalledTimes(1);
      expect(h.deletion).toHaveBeenCalledTimes(outcome === 'disabled' ? 1 : 0);
      expect(h.state().removal).toEqual(
        outcome === 'disabled' ? null : identity,
      );
      expect((await h.create().present('recreated', head.epoch)).kind).toBe(
        'blocked',
      );
      expect(h.deliver).not.toHaveBeenCalled();
    },
  );

  it.each(['none', 'before', 'during', 'already-closed'] as const)(
    'clears a failed joined disable once and preserves admission (revoke: %s)',
    async (revoke) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      if (revoke === 'before') a.revoke();
      if (revoke === 'already-closed') {
        h.disable.mockResolvedValueOnce({ kind: 'unconfirmed' });
        expect((await a.remove(head.epoch)).kind).toBe('blocked');
      }
      h.disable.mockClear();
      const entered = deferred<void>();
      const release =
        deferred<
          Awaited<
            ReturnType<CopilotGrantAuthorityOptions['selection']['disable']>
          >
        >();
      h.disable.mockImplementation(() => {
        entered.resolve();
        return release.promise;
      });
      const cas = h.journal.compareExchange.bind(h.journal);
      let clears = 0;
      h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
        if (h.state().removal && !next.removal) clears++;
        return cas(sequence, next);
      };
      const removing = a.remove(head.epoch);
      await entered.promise;
      const joined = a.remove(head.epoch);
      if (revoke === 'during') a.revoke();
      expect((await a.present('while-removing', head.epoch)).kind).toBe(
        'blocked',
      );
      release.resolve({ kind: 'failed' });
      const first = await removing;
      expect(await joined).toEqual(first);
      expect(first).toEqual({ kind: 'blocked', reason: 'unavailable' });
      expect(h.disable).toHaveBeenCalledTimes(1);
      expect(clears).toBe(1);
      expect(h.state().removal).toBeNull();
      expect(h.state().head).toEqual(head);
      expect(h.deletion).not.toHaveBeenCalled();
      expect((await a.present('after-failure', head.epoch)).kind).toBe(
        // A retry owns the retained epoch fence; definite failure releases it.
        revoke === 'none' || revoke === 'already-closed'
          ? 'delivered'
          : 'blocked',
      );
      a.reopen();
      expect((await a.present('explicit-reopen', head.epoch)).kind).toBe(
        'delivered',
      );
      // A settled failure releases the slot for a later removal retry.
      h.disable.mockResolvedValue({ kind: 'disabled' });
      expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
      expect(h.disable).toHaveBeenCalledTimes(2);
    },
  );

  it('joins calls made before the first journal read settles', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant(), 'setup'));
    const first = a.remove(head.epoch);
    const joined = a.remove(head.epoch);
    expect(await joined).toEqual(await first);
    expect(await first).toEqual({ kind: 'removed' });
    expect(h.disable).toHaveBeenCalledTimes(1);
    expect(h.deletion).toHaveBeenCalledTimes(1);
  });

  it('does not join a different epoch while an old removal is awaiting its read', async () => {
    const h = harness();
    const a = h.create();
    const old = ready(await a.create(grant(), 'setup'));
    const read = h.journal.read.bind(h.journal);
    const stale = await read();
    const entered = deferred<void>();
    const release = deferred<void>();
    let held = false;
    h.journal.read = async (): Promise<CopilotAuthorityRecord> => {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
        return stale;
      }
      return read();
    };
    const removing = a.remove(old.epoch);
    await entered.promise;
    expect(await a.remove('')).toEqual({ kind: 'blocked', reason: 'changed' });
    const other = h.create();
    expect(await other.remove(old.epoch)).toEqual({ kind: 'removed' });
    const next = ready(await other.create(grant('-replacement'), 'setup'));
    a.revoke();
    a.reopen();
    expect(await a.remove(next.epoch)).toEqual({ kind: 'removed' });
    release.resolve();
    expect((await removing).kind).toBe('blocked');
    expect(h.disable).toHaveBeenCalledTimes(2);
    expect(h.deletion).toHaveBeenCalledTimes(2);
    expect(h.state().head).toBeNull();
  });
});

describe('P4 removal registration', () => {
  it('registers single-flight before the first journal callback can reenter', async () => {
    const h = harness();
    const a = h.create();
    const head = ready(await a.create(grant(), 'setup'));
    const read = h.journal.read.bind(h.journal);
    let joined: Promise<CopilotGrantResult> | undefined;
    const reentered = deferred<void>();
    let entered = false;
    h.journal.read = (): Promise<CopilotAuthorityRecord> => {
      if (!entered) {
        entered = true;
        joined = a.remove(head.epoch);
        reentered.resolve();
      }
      return read();
    };
    const removing = a.remove(head.epoch);
    await reentered.promise;
    const results = await Promise.all([removing, joined]);
    expect(results).toEqual([{ kind: 'removed' }, { kind: 'removed' }]);
    expect(joined).toBe(removing);
    expect(h.disable).toHaveBeenCalledTimes(1);
    expect(h.deletion).toHaveBeenCalledTimes(1);
  });
});

describe('P4 joined removal clear acknowledgement', () => {
  it.each(['refused', 'throws', 'lost', 'held', 'held-revoke'] as const)(
    'keeps joiners and admission fenced through a %s clear acknowledgement',
    async (outcome) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      h.disable.mockResolvedValueOnce({ kind: 'failed' });
      const cas = h.journal.compareExchange.bind(h.journal);
      const entered = deferred<void>();
      const release = deferred<void>();
      let clears = 0;
      h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
        if (!h.state().removal || next.removal) return cas(sequence, next);
        clears++;
        entered.resolve();
        if (outcome === 'refused') return false;
        if (outcome === 'throws') throw new Error(REFRESH);
        const accepted = await cas(sequence, next);
        if (outcome === 'lost') throw new Error(REFRESH);
        await release.promise;
        return accepted;
      };
      const removing = a.remove(head.epoch);
      const joined = a.remove(head.epoch);
      await entered.promise;
      if (outcome === 'held' || outcome === 'held-revoke') {
        expect(a.remove(head.epoch)).toBe(removing);
        if (outcome === 'held-revoke') a.revoke();
        expect((await a.present('during-clear', head.epoch)).kind).toBe(
          'blocked',
        );
        release.resolve();
      }
      const first = await removing;
      expect(await joined).toBe(first);
      expect(first).toEqual({ kind: 'blocked', reason: 'unavailable' });
      expectNoGrantSecrets(first);
      expect(clears).toBe(1);
      expect(h.disable).toHaveBeenCalledTimes(1);
      expect(h.deletion).not.toHaveBeenCalled();
      expect(h.state().head).toEqual(head);
      expect((await a.present('after-clear', head.epoch)).kind).toBe(
        outcome === 'held' ? 'delivered' : 'blocked',
      );
      const retained = outcome === 'refused' || outcome === 'throws';
      expect(h.state().removal === null).toBe(!retained);
      if (retained) {
        a.reopen();
        expect((await a.present('cannot-bypass-fence', head.epoch)).kind).toBe(
          'blocked',
        );
        expect((await h.create().present('recreated', head.epoch)).kind).toBe(
          'blocked',
        );
        expect(h.deliver).not.toHaveBeenCalled();
      } else {
        a.reopen();
        expect((await a.present('explicit-reopen', head.epoch)).kind).toBe(
          // Only removal recovery, not runtime reopen, releases an unknown clear.
          outcome === 'lost' ? 'blocked' : 'delivered',
        );
      }
      h.journal.compareExchange = cas;
      h.disable.mockResolvedValue({ kind: 'disabled' });
      expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
      expect(h.disable).toHaveBeenCalledTimes(2);
      expect(h.deletion).toHaveBeenCalledTimes(1);
    },
  );
});

describe('P4 admission closure ownership', () => {
  it.each(['runtime-first', 'removal-first'] as const)(
    'opens only after both runtime and failed removal release (%s)',
    async (order) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      a.revoke();
      const entered = deferred<void>();
      const release = deferred<void>();
      const cas = h.journal.compareExchange.bind(h.journal);
      h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
        const clearing = h.state().removal && !next.removal;
        const accepted = await cas(sequence, next);
        if (clearing && accepted) {
          entered.resolve();
          await release.promise;
        }
        return accepted;
      };
      h.disable.mockResolvedValueOnce({ kind: 'failed' });
      const removing = a.remove(head.epoch);
      await entered.promise;
      expect(h.state().removal).toBeNull();
      if (order === 'runtime-first') a.reopen();
      expect((await a.present('awaiting-clear', head.epoch)).kind).toBe(
        'blocked',
      );
      expect(h.deliver).not.toHaveBeenCalled();
      release.resolve();
      expect(await removing).toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
      if (order === 'removal-first') {
        expect((await a.present('runtime-held', head.epoch)).kind).toBe(
          'blocked',
        );
        a.reopen();
      }
      expect((await a.present('all-released', head.epoch)).kind).toBe(
        'delivered',
      );
    },
  );

  it.each(['unconfirmed', 'throws', 'lost-clear'] as const)(
    'runtime reopen cannot release a retained %s removal',
    async (outcome) => {
      const h = harness();
      const a = h.create();
      const head = ready(await a.create(grant(), 'setup'));
      h.disable.mockImplementationOnce(() => {
        if (outcome === 'throws') throw new Error(REFRESH);
        if (outcome === 'lost-clear') {
          h.loseCAS();
          return Promise.resolve({ kind: 'failed' });
        }
        return Promise.resolve({ kind: 'unconfirmed' });
      });
      expect((await a.remove(head.epoch)).kind).toBe('blocked');
      a.revoke();
      a.reopen();
      expect((await a.present('local', head.epoch)).kind).toBe('blocked');
      const restarted = h.create();
      restarted.reopen();
      if (outcome !== 'lost-clear') {
        expect((await restarted.present('restarted', head.epoch)).kind).toBe(
          'blocked',
        );
      }
      expect(h.deliver).not.toHaveBeenCalled();
      h.disable.mockResolvedValueOnce({ kind: 'failed' });
      expect(await a.remove(head.epoch)).toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
      expect((await a.present('recovered', head.epoch)).kind).toBe('delivered');
    },
  );

  it.each(['runtime-first', 'setup-first', 'resume'] as const)(
    'completed deletion hands its closure to originating setup, independently of runtime (%s)',
    async (order) => {
      const h = harness();
      const a = h.create();
      const old = ready(await a.create(grant(), 'setup'));
      expect(await a.remove(old.epoch)).toEqual({ kind: 'removed' });
      a.reopen();
      expect((await a.present('signed-out', old.epoch)).kind).toBe('blocked');
      a.revoke();
      const entered = deferred<void>();
      const release = deferred<void>();
      h.confirm.mockImplementationOnce(async (request) => {
        entered.resolve();
        await release.promise;
        return order === 'resume'
          ? { kind: 'unconfirmed' }
          : {
              kind: 'confirmed',
              receipt: { ...request, pinGeneration: 'new-pin' },
            };
      });
      const creating = a.create(grant('-new'), 'setup');
      await entered.promise;
      if (order === 'runtime-first') a.reopen();
      expect((await a.present('setup-pending', old.epoch)).kind).toBe(
        'blocked',
      );
      release.resolve();
      let result = await creating;
      if (order === 'resume') {
        expect(result.kind).toBe('blocked');
        result = await a.resume(pending(await a.status()));
      }
      const next = ready(result);
      if (order !== 'runtime-first') {
        expect((await a.present('runtime-held', next.epoch)).kind).toBe(
          'blocked',
        );
        a.reopen();
      }
      expect((await a.present('all-released', next.epoch)).kind).toBe(
        'delivered',
      );
      expect(h.deliver).toHaveBeenLastCalledWith(
        'all-released',
        ACCESS + '-new',
        NOW + 7_200_000,
      );
    },
  );

  it('a late deletion acknowledgement cannot reacquire a closure released by replacement setup', async () => {
    const h = harness();
    const a = h.create();
    const old = ready(await a.create(grant(), 'setup'));
    const cas = h.journal.compareExchange.bind(h.journal);
    const entered = deferred<void>();
    const release = deferred<void>();
    h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
      const completing = h.state().removal && !next.head && !next.removal;
      const accepted = await cas(sequence, next);
      if (completing && accepted) {
        entered.resolve();
        await release.promise;
      }
      return accepted;
    };
    const removing = a.remove(old.epoch);
    await entered.promise;
    const next = ready(await a.create(grant('-new'), 'setup'));
    expect((await a.present('before-old-ack', next.epoch)).kind).toBe(
      'delivered',
    );
    release.resolve();
    expect(await removing).toEqual({ kind: 'removed' });
    expect((await a.present('after-old-ack', next.epoch)).kind).toBe(
      'delivered',
    );
    expect(h.disable).toHaveBeenCalledTimes(1);
  });
});

describe('P4 closure handoff acknowledgement isolation', () => {
  it('setup completion releases its signed-out owner, not a later removal awaiting clear', async () => {
    const h = harness();
    const a = h.create();
    const old = ready(await a.create(grant(), 'setup'));
    expect(await a.remove(old.epoch)).toEqual({ kind: 'removed' });
    const cas = h.journal.compareExchange.bind(h.journal);
    const setupEntered = deferred<void>();
    const setupRelease = deferred<void>();
    const clearEntered = deferred<void>();
    const clearRelease = deferred<void>();
    h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
      const setup = !h.state().head && next.head && !next.mutation;
      const clearing = h.state().removal && !next.removal;
      const accepted = await cas(sequence, next);
      if (accepted && setup) {
        setupEntered.resolve();
        await setupRelease.promise;
      }
      if (accepted && clearing) {
        clearEntered.resolve();
        await clearRelease.promise;
      }
      return accepted;
    };
    const creating = a.create(grant('-new'), 'setup');
    await setupEntered.promise;
    const next = h.state().head;
    if (!next) throw new Error('Expected published head');
    a.reopen();
    expect((await a.present('signed-out-held', next.epoch)).kind).toBe(
      'blocked',
    );
    h.disable.mockResolvedValueOnce({ kind: 'failed' });
    const removing = a.remove(next.epoch);
    await clearEntered.promise;
    setupRelease.resolve();
    expect(ready(await creating)).toEqual(next);
    expect((await a.present('removal-held', next.epoch)).kind).toBe('blocked');
    expect(h.deliver).not.toHaveBeenCalled();
    clearRelease.resolve();
    expect(await removing).toEqual({ kind: 'blocked', reason: 'unavailable' });
    expect((await a.present('all-released', next.epoch)).kind).toBe(
      'delivered',
    );
  });

  it('setup still fences a delayed accepted removal before the local closure is taken', async () => {
    const h = harness();
    const a = h.create();
    const old = ready(await a.create(grant(), 'setup'));
    const cas = h.journal.compareExchange.bind(h.journal);
    const entered = deferred<void>();
    const release = deferred<void>();
    let held = false;
    h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
      const accepted = await cas(sequence, next);
      if (!held && accepted && next.removal) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return accepted;
    };
    const removing = a.remove(old.epoch);
    await entered.promise;
    expect(await h.create().remove(old.epoch)).toEqual({ kind: 'removed' });
    const next = ready(await a.create(grant('-new'), 'setup'));
    const revocations = h.revoke.mock.calls.length;
    release.resolve();
    expect(await removing).toEqual({ kind: 'blocked', reason: 'changed' });
    expect(h.revoke).toHaveBeenCalledTimes(revocations);
    expect((await a.present('replacement', next.epoch)).kind).toBe('delivered');
  });
});

describe('P4 signed-out closure handoff recovery', () => {
  it.each(['cancel', 'resume-cancel'] as const)(
    'a cancelled replacement transfers sign-out ownership to the next setup (%s)',
    async (recovery) => {
      const h = harness();
      const a = h.create();
      const old = ready(await a.create(grant(), 'setup'));
      expect(await a.remove(old.epoch)).toEqual({ kind: 'removed' });
      h.confirm.mockResolvedValueOnce({ kind: 'unconfirmed' });
      await a.create(grant('-cancelled'), 'setup');
      const id = pending(await a.status());
      a.revoke();
      if (recovery === 'resume-cancel') {
        h.loseDelete();
        expect((await a.cancel(id)).kind).toBe('blocked');
        expect(await a.resume(`${id}:cancel`)).toEqual({ kind: 'removed' });
      } else {
        expect(await a.cancel(id)).toEqual({ kind: 'removed' });
      }
      const next = ready(await a.create(grant('-new'), 'setup'));
      expect((await a.present('runtime-held', next.epoch)).kind).toBe(
        'blocked',
      );
      expect(h.deliver).not.toHaveBeenCalled();
      a.reopen();
      expect((await a.present('after-cancel', next.epoch)).kind).toBe(
        'delivered',
      );
    },
  );

  it.each(['acknowledged', 'lost'] as const)(
    'completed removal supersedes a setup handoff even with its %s reply delayed',
    async (reply) => {
      const h = harness();
      const a = h.create();
      const old = ready(await a.create(grant(), 'setup'));
      expect(await a.remove(old.epoch)).toEqual({ kind: 'removed' });
      const cas = h.journal.compareExchange.bind(h.journal);
      const entered = deferred<void>();
      const release = deferred<void>();
      let hold = true;
      h.journal.compareExchange = async (sequence, next): Promise<boolean> => {
        const completing =
          hold && !h.state().head && next.head && !next.mutation;
        const accepted = await cas(sequence, next);
        if (completing && accepted) {
          hold = false;
          entered.resolve();
          await release.promise;
          if (reply === 'lost') throw new Error(REFRESH);
        }
        return accepted;
      };
      const creating = a.create(grant('-superseded'), 'setup');
      await entered.promise;
      const head = h.state().head;
      if (!head) throw new Error('Expected published head');
      expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
      h.confirm.mockResolvedValueOnce({ kind: 'unconfirmed' });
      await a.create(grant('-new'), 'setup');
      const id = pending(await a.status());
      release.resolve();
      expect((await creating).kind).toBe(
        reply === 'lost' ? 'blocked' : 'ready',
      );
      a.reopen();
      expect((await a.present('setup-pending', head.epoch)).kind).toBe(
        'blocked',
      );
      expect(h.deliver).not.toHaveBeenCalled();
      const next = ready(await a.resume(id));
      expect((await a.present('all-released', next.epoch)).kind).toBe(
        'delivered',
      );
    },
  );
});
