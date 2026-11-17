import { createCopilotVaultGrantAuthority } from '../../copilot-grant-authority';
import type {
  CopilotVaultGrant,
  CopilotVaultGrantAuthority,
} from '../../copilot-grant-contracts';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createFakeSecretProtection } from '../../../../platform/testing/fake-secret-protection';
import {
  openVaultReadRepository,
  type VaultReadRepository,
} from '../read-repository';
import {
  VAULT_STORE_FILE,
  type VaultStore,
  type VaultStoreFaults,
} from '../store';
import { storeFolder, type StoreFolder } from './store-fixtures';
import { importRequest, migrationIdentity } from './migration-fixtures';
import type { CopilotPilotState } from '../copilot-pilot-state';
import {
  canonicalCopilotJson,
  decodeCopilotAuthority,
  encodeCopilotAuthority,
} from '../copilot-authority-codec';
import {
  deriveVaultSubkeys,
  disposeVaultSubkeys,
  withVaultSubkey,
} from '../vault-keys';

let folder: StoreFolder;
let store: VaultStore;
let vault: VaultReadRepository;
let slots: ReturnType<typeof createFakeSecretProtection>;
let fault: 'before' | 'after' | null;
let holdPut: (() => Promise<void>) | undefined;
const faults: VaultStoreFaults = {
  sync: (commit): void => {
    const armed = fault;
    fault = null;
    if (armed !== 'before') commit();
    if (armed) throw new Error('injected unknown COMMIT');
  },
};
async function reopen(): Promise<void> {
  vault?.dispose();
  store?.close();
  store = await folder.opened(faults);
  const result = await openVaultReadRepository({
    store,
    slots: slots.port,
    signal: new AbortController().signal,
    minProbeIntervalMs: 0,
    holdPut: () => holdPut?.() ?? Promise.resolve(),
  });
  if (result.kind !== 'opened') throw new Error('Vault did not open');
  vault = result.vault;
}
beforeEach(async () => {
  folder = storeFolder();
  slots = createFakeSecretProtection({ backend: 'macos_keychain' });
  fault = null;
  holdPut = undefined;
  await reopen();
});
afterEach(() => {
  vault.dispose();
  store.close();
  folder.remove();
});
function initialize(): CopilotPilotState {
  return vault.openCopilotPilotState({
    kind: 'initialize-unused',
    hostFence: 'absent',
  });
}
function bind(state: CopilotPilotState): string {
  const attempt = state.migration.prepare(migrationIdentity, 1);
  const key = state.migration.importKey(attempt.id);
  const before = state.read();
  const account = { host: 'github.com', login: 'pilot', id: '1' };
  expect(
    state.compareExchange(before.authority.sequence, {
      ...before,
      migrationEpoch: 1,
      authority: {
        ...before.authority,
        sequence: before.authority.sequence + 1,
        mutation: {
          kind: 'create',
          origin: 'import',
          operationId: key,
          epoch: 'account-epoch',
          account,
          from: null,
          committed: null,
          probeConfirmed: false,
          cancelling: false,
        },
      },
      binding: {
        attemptId: attempt.id,
        migrationEpoch: 1,
        operationId: key,
        accountEpoch: 'account-epoch',
        identity: migrationIdentity,
        account,
        predecessorGeneration: null,
        phase: 'pre_ingress',
        destination: null,
      },
    }),
  ).toBe(true);
  return key;
}
function accept(state: CopilotPilotState): void {
  const before = state.read();
  if (!before.binding || !before.authority.mutation)
    throw new Error('No binding');
  expect(
    state.compareExchange(before.authority.sequence, {
      ...before,
      authority: {
        ...before.authority,
        sequence: before.authority.sequence + 1,
        mutation: { ...before.authority.mutation, probeConfirmed: true },
      },
      binding: { ...before.binding, phase: 'ingress_accepted' },
    }),
  ).toBe(true);
}
it('ordinary open is inert; explicit unused init survives reconstructed holder/store and preserves GitHub', async () => {
  expect(store.readCopilotAuthority()).toBeNull();
  expect(() => vault.openCopilotPilotState({ kind: 'existing' })).toThrow();
  await vault
    .writer('github-pat')
    .put({ ...importRequest('github'), family: 'github-pat' });
  const github = store.listEntries();
  initialize();
  await reopen();
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  expect(state.read().authority.sequence).toBe(0);
  expect(store.listEntries()).toEqual(github);
  const dbPath = join(folder.folder, VAULT_STORE_FILE);
  vault.dispose();
  store.close();
  const db = new DatabaseSync(dbPath);
  expect(
    db
      .prepare("SELECT value FROM vault_meta WHERE key = 'schema_version'")
      .get()?.value,
  ).toBe('1');
  db.close();
});
it('full holder/write path requires ingress binding; same sequence cannot erase control state; exact history outlives retirement', async () => {
  const state = initialize();
  const key = bind(state);
  await expect(state.writer.put(importRequest(key))).rejects.toThrow();
  accept(state);
  const stale = await state.journal.read();
  const before = state.read();
  expect(
    state.compareExchange(before.authority.sequence, {
      ...before,
      authority: {
        ...before.authority,
        sequence: before.authority.sequence + 1,
      },
    }),
  ).toBe(true);
  expect(
    await state.journal.compareExchange(stale.sequence, {
      ...stale,
      sequence: stale.sequence + 1,
    }),
  ).toBe(false);
  const put = await state.writer.put(importRequest(key));
  if (put.kind !== 'committed') throw new Error('Import not committed');
  expect(await state.journal.reconcile(key)).toEqual({
    kind: 'committed',
    pin: put.pin,
  });
  const id = state.read().binding?.attemptId;
  if (!id) throw new Error('No attempt');
  state.migration.supersede(2, 'cancelled');
  expect(state.migration.resolve(id)).toEqual({ kind: 'retired' });
  expect(await state.journal.reconcile(key)).toEqual({
    kind: 'committed',
    pin: put.pin,
  });
  await expect(state.writer.put(importRequest(key))).rejects.toThrow();
  await reopen();
  expect(
    await vault
      .openCopilotPilotState({ kind: 'existing' })
      .journal.reconcile(key),
  ).toEqual({ kind: 'committed', pin: put.pin });
});
it.each(['before', 'after'] as const)(
  'reconciles %s-COMMIT uncertainty without reminting a binding',
  (where) => {
    const state = initialize();
    const before = state.read();
    const next = { ...before, authority: { ...before.authority, sequence: 1 } };
    fault = where;
    expect(state.compareExchange(0, next)).toBe(where === 'after');
    expect(state.read().authority.sequence).toBe(where === 'after' ? 1 : 0);
  },
);
it('reacquires current held keys after lock/reprobe, rather than retaining a disposed P1 handle', async () => {
  const state = initialize();
  slots.inject({ kind: 'locked' });
  await vault.refresh();
  expect(() => state.read()).toThrow();
  expect(() => state.migration.read()).toThrow();
  slots.clearFaults();
  await vault.refresh();
  expect(state.read().authority.sequence).toBe(0);
  expect(state.migration.read().attempts).toEqual([]);
});
it.each([
  'copilot_authority_format',
  'copilot_authority_v1',
  'both',
  'mac',
  'format',
])(
  'refuses missing/corrupt %s metadata rather than resetting a used state',
  async (edit) => {
    const state = initialize();
    bind(state);
    vault.dispose();
    store.close();
    const db = new DatabaseSync(join(folder.folder, VAULT_STORE_FILE));
    if (edit === 'both')
      db.exec("DELETE FROM vault_meta WHERE key LIKE 'copilot_authority_%'");
    else if (edit === 'mac')
      db.exec(
        "UPDATE vault_meta SET value = '{}' WHERE key = 'copilot_authority_v1'",
      );
    else if (edit === 'format')
      db.exec(
        "UPDATE vault_meta SET value = '2' WHERE key = 'copilot_authority_format'",
      );
    else db.prepare('DELETE FROM vault_meta WHERE key = ?').run(edit);
    db.close();
    await reopen();
    expect(() => initialize()).toThrow();
  },
);
it.each(['copilot_authority_format', 'copilot_authority_v1'])(
  'headerless %s is evidence, not a fresh vault',
  async (key) => {
    vault.dispose();
    store.close();
    const db = new DatabaseSync(join(folder.folder, VAULT_STORE_FILE));
    db.exec('DELETE FROM vault_header');
    db.prepare('INSERT INTO vault_meta (key, value) VALUES (?, ?)').run(
      key,
      '1',
    );
    db.close();
    expect(await folder.open()).toMatchObject({
      kind: 'store_unavailable',
      step: 'init_state',
    });
  },
);
it('canonical domain-separated codec rejects MAC/shape/version/vault/sequence/size tampering and contains no material', () => {
  const state = initialize();
  const keys = deriveVaultSubkeys(new Uint8Array(32).fill(72), vault.vaultId);
  try {
    const bundle = state.read();
    const encoded = encodeCopilotAuthority(keys, bundle);
    expect(decodeCopilotAuthority(keys, encoded)).toEqual(bundle);
    for (const value of [
      { ...bundle, version: 2 },
      { ...bundle, vaultId: 'foreign' },
      {
        ...bundle,
        authority: {
          ...bundle.authority,
          sequence: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      { ...bundle, extra: 'secret' },
      { ...bundle, controls: new Array(129).fill({}) },
    ]) {
      const payload = canonicalCopilotJson(value);
      const mac = withVaultSubkey(keys, 'receipt', (key) =>
        createHmac('sha256', key)
          .update('canopy/vault/copilot-authority/v1\0')
          .update(payload)
          .digest('hex'),
      );
      expect(() =>
        decodeCopilotAuthority(keys, JSON.stringify({ payload, mac })),
      ).toThrow();
    }
    expect(() =>
      decodeCopilotAuthority(keys, encoded.replace('"mac":"', '"mac":"0')),
    ).toThrow();
    expect(() => decodeCopilotAuthority(keys, 'x'.repeat(262145))).toThrow();
    expect(store.readCopilotAuthority()).not.toContain('credential-sentinel');
  } finally {
    disposeVaultSubkeys(keys);
  }
});

it.each([false, true])(
  'exact outcome distinguishes running from stopped pending and committed (%s)',
  async (stopBeforeCommit) => {
    const state = initialize();
    const key = bind(state);
    accept(state);
    expect(await state.journal.reconcile(key)).toEqual({
      kind: 'not_accepted',
    });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    holdPut = (): Promise<void> => held;
    const put = state.writer.put(importRequest(key));
    expect(await state.journal.reconcile(key)).toEqual({ kind: 'unconfirmed' });
    if (stopBeforeCommit) fault = 'before';
    release();
    const result = await put;
    if (stopBeforeCommit) {
      expect(result.kind).toBe('outcome_unknown');
      expect(await state.journal.reconcile(key)).toEqual({ kind: 'retryable' });
    } else {
      expect(result.kind).toBe('committed');
      expect((await state.journal.reconcile(key)).kind).toBe('committed');
    }
    expect(await state.journal.reconcile('unknown-operation')).toEqual({
      kind: 'unconfirmed',
    });
  },
);
it('real P4 setup authority uses the sole repository writer/journal across reconstruction without credential metadata', async () => {
  const grant: CopilotVaultGrant = {
    version: 1,
    clientId: 'client',
    host: 'github.com',
    login: 'pilot',
    id: '1',
    accessToken: 'storage-access-sentinel',
    refreshToken: 'storage-refresh-sentinel',
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    refreshTokenExpiresAt: '2099-02-01T00:00:00.000Z',
  };
  function authority(state: CopilotPilotState): CopilotVaultGrantAuthority {
    return createCopilotVaultGrantAuthority({
      repository: () => Promise.resolve(vault.repository),
      writer: () => Promise.resolve(state.writer),
      probeKeyIfDue: () => vault.probeKeyIfDue(),
      journal: state.journal,
      probe: () => Promise.resolve(),
      refresh: () => Promise.resolve({ kind: 'rejected' }),
      selection: {
        confirm: (request) =>
          Promise.resolve({
            kind: 'confirmed',
            receipt: { ...request, pinGeneration: 'generation' },
          }),
        disable: () => Promise.resolve({ kind: 'disabled' }),
      },
      recipient: {
        admitted: () => true,
        deliver: (): void => undefined,
        revoke: (): void => undefined,
      },
    });
  }
  const state = initialize();
  const result = await authority(state).create(grant, 'setup');
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Setup not ready');
  expect(await state.journal.reconcile(result.head.operationId)).toEqual({
    kind: 'committed',
    pin: result.head.pin,
  });
  expect(store.readCopilotAuthority()).not.toContain('storage-access-sentinel');
  expect(store.readCopilotAuthority()).not.toContain(
    'storage-refresh-sentinel',
  );
  await reopen();
  expect(
    await authority(vault.openCopilotPilotState({ kind: 'existing' })).status(),
  ).toEqual(result);
});
it('binding/control changes cannot regress or erase newer authenticated phases', () => {
  const state = initialize();
  bind(state);
  const old = state.read();
  accept(state);
  const current = state.read();
  expect(() =>
    state.compareExchange(current.authority.sequence, {
      ...old,
      authority: { ...old.authority, sequence: current.authority.sequence + 1 },
    }),
  ).toThrow();
  expect(() =>
    state.compareExchange(current.authority.sequence, {
      ...current,
      binding: null,
      authority: {
        ...current.authority,
        sequence: current.authority.sequence + 1,
      },
    }),
  ).toThrow();
  expect(state.read()).toEqual(current);
});
it('published bindings retain their import destination across pending and committed successors without blocking journal control', async () => {
  const state = initialize();
  const key = bind(state);
  accept(state);
  const put = await state.writer.put(importRequest(key));
  if (put.kind !== 'committed') throw new Error('Import not committed');
  const before = state.read();
  const b = before.binding;
  const m = before.authority.mutation;
  if (!b || !m) throw new Error('No bound import');
  state.migration.reconcile(b.attemptId, b.migrationEpoch);
  state.migration.select(b.attemptId, b.migrationEpoch);
  expect(
    state.compareExchange(before.authority.sequence, {
      ...before,
      authority: {
        ...before.authority,
        sequence: before.authority.sequence + 1,
        mutation: null,
        head: {
          operationId: key,
          epoch: b.accountEpoch,
          account: b.account,
          origin: 'import',
          pin: put.pin,
          pinGeneration: 'import',
        },
      },
      binding: { ...b, destination: put.pin, phase: 'published' },
    }),
  ).toBe(true);
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  holdPut = (): Promise<void> => held;
  const request = importRequest('successor');
  const successor = state.writer.put({
    ref: put.pin.ref,
    expectedRevision: put.pin.revision,
    idempotencyKey: 'successor',
    label: request.label,
    expiresAt: request.expiresAt,
    material: request.material,
  });
  expect(await state.journal.read()).toMatchObject({ head: { pin: put.pin } });
  expect(await state.journal.reconcile(key)).toEqual({ kind: 'unconfirmed' });
  release();
  const advanced = await successor;
  if (advanced.kind !== 'committed') throw new Error('Successor not committed');
  expect(await state.journal.reconcile(key)).toEqual({
    kind: 'committed',
    pin: advanced.pin,
  });
  const current = state.read();
  if (!current.authority.head) throw new Error('No head');
  expect(
    await state.journal.compareExchange(current.authority.sequence, {
      ...current.authority,
      sequence: current.authority.sequence + 1,
      head: {
        ...current.authority.head,
        operationId: 'successor',
        pin: advanced.pin,
        pinGeneration: 'successor',
      },
    }),
  ).toBe(true);
  expect(state.read().binding?.destination).toEqual(put.pin);
  await reopen();
  expect(
    await vault
      .openCopilotPilotState({ kind: 'existing' })
      .journal.reconcile(key),
  ).toEqual({ kind: 'committed', pin: advanced.pin });
});
it('retains exact cancellation control when retiring a binding; stale P4 saves cannot remove it', () => {
  const state = initialize();
  bind(state);
  let before = state.read();
  const binding = before.binding;
  if (!binding || !before.authority.mutation) throw new Error('Missing import');
  expect(
    state.compareExchange(before.authority.sequence, {
      ...before,
      migrationEpoch: 2,
      authority: {
        ...before.authority,
        sequence: before.authority.sequence + 1,
        mutation: { ...before.authority.mutation, cancelling: true },
      },
      binding: { ...binding, phase: 'cancelling' },
    }),
  ).toBe(true);
  state.migration.supersede(2, 'cancel');
  before = state.read();
  const control = {
    kind: 'retirement',
    operationId: binding.operationId,
    attemptId: binding.attemptId,
    migrationEpoch: binding.migrationEpoch,
    identity: binding.identity,
    accountEpoch: binding.accountEpoch,
    destination: null,
    completionId: null,
    phase: 'retired',
  } as const;
  expect(
    state.compareExchange(before.authority.sequence, {
      ...before,
      authority: {
        ...before.authority,
        sequence: before.authority.sequence + 1,
        mutation: null,
      },
      binding: { ...binding, phase: 'retired' },
      controls: [control],
    }),
  ).toBe(true);
  before = state.read();
  expect(
    state.compareExchange(before.authority.sequence, {
      ...before,
      authority: {
        ...before.authority,
        sequence: before.authority.sequence + 1,
      },
      binding: null,
    }),
  ).toBe(true);
  before = state.read();
  expect(() =>
    state.compareExchange(before.authority.sequence, {
      ...before,
      controls: [],
      authority: {
        ...before.authority,
        sequence: before.authority.sequence + 1,
      },
    }),
  ).toThrow();
  expect(state.read().controls).toEqual([control]);
});
it('a bare committed intent with a corrupt operation receipt is never commit evidence', async () => {
  const state = initialize();
  const key = bind(state);
  accept(state);
  expect((await state.writer.put(importRequest(key))).kind).toBe('committed');
  vault.dispose();
  store.close();
  const db = new DatabaseSync(join(folder.folder, VAULT_STORE_FILE));
  db.exec('UPDATE vault_intents SET receipt = zeroblob(32)');
  db.close();
  await reopen();
  expect(
    await vault
      .openCopilotPilotState({ kind: 'existing' })
      .journal.reconcile(key),
  ).toEqual({ kind: 'unconfirmed' });
});

it('cannot replace a bound retirement with evidence for another account epoch', () => {
  const state = initialize();
  bind(state);
  let before = state.read();
  const binding = before.binding;
  if (!binding) throw new Error('No binding');
  state.compareExchange(before.authority.sequence, {
    ...before,
    authority: {
      ...before.authority,
      sequence: before.authority.sequence + 1,
      mutation: null,
    },
    binding: { ...binding, phase: 'retired' },
  });
  before = state.read();
  expect(() =>
    state.compareExchange(before.authority.sequence, {
      ...before,
      authority: {
        ...before.authority,
        sequence: before.authority.sequence + 1,
      },
      binding: null,
      controls: [
        {
          kind: 'retirement',
          operationId: binding.operationId,
          attemptId: binding.attemptId,
          migrationEpoch: binding.migrationEpoch,
          identity: binding.identity,
          accountEpoch: 'foreign-account-epoch',
          destination: binding.destination,
          completionId: null,
          phase: 'retired',
        },
      ],
    }),
  ).toThrow();
});

it.each(['before', 'after'] as const)(
  'initialization reconciles %s-COMMIT uncertainty without implicit reinitialization',
  async (where) => {
    fault = where;
    if (where === 'before') {
      expect(() => initialize()).toThrow();
      expect(store.readCopilotAuthority()).toBeNull();
    } else expect(initialize().read().authority.sequence).toBe(0);
    await reopen();
    if (where === 'before')
      expect(() => vault.openCopilotPilotState({ kind: 'existing' })).toThrow();
    else
      expect(
        vault.openCopilotPilotState({ kind: 'existing' }).read().authority
          .sequence,
      ).toBe(0);
  },
);
