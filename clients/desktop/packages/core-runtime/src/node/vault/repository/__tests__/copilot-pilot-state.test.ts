import { createCopilotVaultGrantAuthority } from '../../copilot-grant-authority';
import {
  CopilotAuthorityRecordSchema,
  type CopilotAuthorityRecord,
  type CopilotGrantAuthorityOptions,
  type CopilotVaultGrant,
  type CopilotVaultGrantAuthority,
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
  copilotAuthorityBundle,
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
let holdDelete: (() => Promise<void>) | undefined;
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
    holdDelete: () => holdDelete?.() ?? Promise.resolve(),
  });
  if (result.kind !== 'opened') throw new Error('Vault did not open');
  vault = result.vault;
}
beforeEach(async () => {
  folder = storeFolder();
  slots = createFakeSecretProtection({ backend: 'macos_keychain' });
  fault = null;
  holdPut = undefined;
  holdDelete = undefined;
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
it('v2 lineage is strict, domain-separated, bound to the successor and cannot be downgraded to v1', async () => {
  const state = initialize();
  const before = state.read();
  const account = { host: 'github.com', login: 'pilot', id: '1' };
  const authority: CopilotAuthorityRecord = {
    version: 2,
    sequence: 1,
    head: null,
    mutation: null,
    removal: null,
    completed: {
      operationId: 'successor:cancel',
      epoch: 'successor-epoch',
      kind: 'delete',
    },
    setupLineage: {
      version: 1,
      phase: 'cancelled',
      successor: { operationId: 'successor', epoch: 'successor-epoch' },
      predecessor: {
        version: 1,
        state: 'disabled',
        identity: {
          operationId: 'predecessor',
          epoch: 'predecessor-epoch',
          account,
          origin: 'setup',
        },
        pinGeneration: 'exact-nonce',
        pin: {
          ref: { vaultId: vault.vaultId, entryId: 'previous-entry' },
          revision: 1,
        },
      },
    },
  };
  const upgraded = { ...before, version: 2 as const, authority };
  const keys = deriveVaultSubkeys(new Uint8Array(32).fill(72), vault.vaultId);
  try {
    const encoded = encodeCopilotAuthority(keys, upgraded);
    expect(decodeCopilotAuthority(keys, encoded)).toEqual(upgraded);
    const payload = canonicalCopilotJson(upgraded);
    const oldMac = withVaultSubkey(keys, 'receipt', (key) =>
      createHmac('sha256', key)
        .update('canopy/vault/copilot-authority/v1\0')
        .update(payload)
        .digest('hex'),
    );
    expect(() =>
      decodeCopilotAuthority(keys, JSON.stringify({ payload, mac: oldMac })),
    ).toThrow();
    for (const damaged of [
      { ...upgraded, version: 1 },
      { ...upgraded, authority: { ...authority, version: 1 } },
      {
        ...upgraded,
        authority: {
          ...authority,
          setupLineage: { ...authority.setupLineage, extra: 'forbidden' },
        },
      },
      {
        ...upgraded,
        authority: {
          ...authority,
          completed: { ...authority.completed, epoch: 'foreign-epoch' },
        },
      },
      {
        ...upgraded,
        authority: {
          ...authority,
          setupLineage: {
            ...authority.setupLineage,
            predecessor: {
              ...authority.setupLineage?.predecessor,
              pin: {
                ref: { vaultId: 'foreign-vault', entryId: 'previous-entry' },
                revision: 1,
              },
            },
          },
        },
      },
    ])
      expect(() => copilotAuthorityBundle(damaged, vault.vaultId)).toThrow();
    expect(await state.journal.compareExchange(0, authority)).toBe(true);
    expect(state.read().version).toBe(2);
    const { setupLineage: _witness, ...rest } = authority;
    expect(_witness).toEqual(authority.setupLineage);
    await expect(
      state.journal.compareExchange(1, { ...rest, version: 1, sequence: 2 }),
    ).rejects.toThrow();
    expect(state.read()).toEqual(upgraded);
  } finally {
    disposeVaultSubkeys(keys);
  }
});

it('v2 retired witness binds the exact disabled receipt to its completed delete and cannot be downgraded', async () => {
  const state = initialize();
  const before = state.read();
  const predecessor = {
    version: 1 as const,
    state: 'disabled' as const,
    identity: {
      operationId: 'retired-head',
      epoch: 'retired-epoch',
      account: { host: 'github.com', login: 'pilot', id: '1' },
      origin: 'setup' as const,
    },
    pinGeneration: 'retired-nonce',
    pin: {
      ref: { vaultId: vault.vaultId, entryId: 'retired-entry' },
      revision: 2,
    },
  };
  const authority: CopilotAuthorityRecord = {
    version: 2,
    sequence: 1,
    head: null,
    mutation: null,
    removal: null,
    completed: {
      operationId: 'removal:2',
      epoch: 'retired-epoch',
      kind: 'delete',
    },
    setupLineage: {
      version: 1,
      phase: 'retired',
      successor: { operationId: 'removal:2', epoch: 'retired-epoch' },
      predecessor,
    },
  };
  const upgraded = { ...before, version: 2 as const, authority };
  const keys = deriveVaultSubkeys(new Uint8Array(32).fill(72), vault.vaultId);
  const { setupLineage: witness, ...withoutWitness } = authority;
  if (!witness) throw new Error('Missing retired witness');
  const head = {
    operationId: 'retired-head',
    epoch: 'retired-epoch',
    account: predecessor.identity.account,
    origin: 'setup' as const,
    pin: predecessor.pin,
    pinGeneration: 'retired-nonce',
  };
  try {
    const encoded = encodeCopilotAuthority(keys, upgraded);
    expect(decodeCopilotAuthority(keys, encoded)).toEqual(upgraded);
    const payload = canonicalCopilotJson(upgraded);
    const oldMac = withVaultSubkey(keys, 'receipt', (key) =>
      createHmac('sha256', key)
        .update('canopy/vault/copilot-authority/v1\0')
        .update(payload)
        .digest('hex'),
    );
    expect(() =>
      decodeCopilotAuthority(keys, JSON.stringify({ payload, mac: oldMac })),
    ).toThrow();
    // Authenticated bytes: any edited receipt field breaks the MAC.
    expect(() =>
      decodeCopilotAuthority(
        keys,
        encoded.replace('retired-nonce', 'foreign-nonce'),
      ),
    ).toThrow();
    const damaged: Record<string, unknown> = {
      'v1 relabel': { ...authority, version: 1 },
      'missing witness key': withoutWitness,
      'extra key': { ...authority, setupLineage: { ...witness, extra: 1 } },
      'foreign completion': {
        ...authority,
        completed: { ...authority.completed, operationId: 'foreign:2' },
      },
      'cancel completion': {
        ...authority,
        completed: { ...authority.completed, operationId: 'removal:cancel' },
        setupLineage: {
          ...witness,
          successor: { ...witness.successor, operationId: 'removal:cancel' },
        },
      },
      'replace completion': {
        ...authority,
        completed: { ...authority.completed, kind: 'replace' },
      },
      'predecessor epoch': {
        ...authority,
        setupLineage: {
          ...witness,
          predecessor: {
            ...predecessor,
            identity: { ...predecessor.identity, epoch: 'foreign-epoch' },
          },
        },
      },
      'predecessor is the delete': {
        ...authority,
        setupLineage: {
          ...witness,
          predecessor: {
            ...predecessor,
            identity: { ...predecessor.identity, operationId: 'removal:2' },
          },
        },
      },
      'unpinned predecessor': {
        ...authority,
        setupLineage: {
          ...witness,
          predecessor: { ...predecessor, pin: null },
        },
      },
      'selected predecessor': {
        ...authority,
        setupLineage: {
          ...witness,
          predecessor: { ...predecessor, state: 'selected' },
        },
      },
      'pending mutation': {
        ...authority,
        mutation: {
          operationId: 'successor',
          epoch: 'successor-epoch',
          account: head.account,
          origin: 'setup',
          kind: 'create',
          from: null,
          committed: null,
          probeConfirmed: false,
          cancelling: false,
        },
      },
      'retained head': { ...authority, head },
    };
    for (const [name, record] of Object.entries(damaged))
      expect([
        name,
        CopilotAuthorityRecordSchema.safeParse(record).success,
      ]).toEqual([name, false]);
    expect(() =>
      copilotAuthorityBundle(
        {
          ...upgraded,
          authority: {
            ...authority,
            setupLineage: {
              ...witness,
              predecessor: {
                ...predecessor,
                pin: {
                  ...predecessor.pin,
                  ref: { ...predecessor.pin.ref, vaultId: 'foreign-vault' },
                },
              },
            },
          },
        },
        vault.vaultId,
      ),
    ).toThrow();
    // A v2 record with no witness is still a readable, unbound completion.
    expect(
      CopilotAuthorityRecordSchema.safeParse({
        ...authority,
        setupLineage: null,
      }).success,
    ).toBe(true);
    expect(await state.journal.compareExchange(0, authority)).toBe(true);
    expect(state.read()).toEqual(upgraded);
    await expect(
      state.journal.compareExchange(1, {
        ...withoutWitness,
        version: 1,
        sequence: 2,
      }),
    ).rejects.toThrow();
    expect(state.read()).toEqual(upgraded);
  } finally {
    disposeVaultSubkeys(keys);
  }
});

it('v2 cancelled witness may bind the successor own surviving receipt, only when cancelled, and cannot be downgraded', async () => {
  const state = initialize();
  const before = state.read();
  const account = { host: 'github.com', login: 'pilot', id: '1' };
  const own = {
    version: 1 as const,
    state: 'disabled' as const,
    identity: {
      operationId: 'successor',
      epoch: 'successor-epoch',
      account,
      origin: 'setup' as const,
    },
    pinGeneration: 'survivor-nonce',
    pin: null,
  };
  const authority: CopilotAuthorityRecord = {
    version: 2,
    sequence: 1,
    head: null,
    mutation: null,
    removal: null,
    completed: {
      operationId: 'successor:cancel',
      epoch: 'successor-epoch',
      kind: 'delete',
    },
    setupLineage: {
      version: 1,
      phase: 'cancelled',
      successor: { operationId: 'successor', epoch: 'successor-epoch' },
      predecessor: own,
    },
  };
  const upgraded = { ...before, version: 2 as const, authority };
  const keys = deriveVaultSubkeys(new Uint8Array(32).fill(72), vault.vaultId);
  const { setupLineage: witness, ...withoutWitness } = authority;
  if (!witness) throw new Error('Missing cancelled witness');
  const pinned = {
    ...own,
    pin: {
      ref: { vaultId: vault.vaultId, entryId: 'successor-entry' },
      revision: 1,
    },
  };
  try {
    const encoded = encodeCopilotAuthority(keys, upgraded);
    expect(decodeCopilotAuthority(keys, encoded)).toEqual(upgraded);
    // Authenticated bytes: an edited survivor nonce breaks the MAC.
    expect(() =>
      decodeCopilotAuthority(
        keys,
        encoded.replace('survivor-nonce', 'foreign-nonce'),
      ),
    ).toThrow();
    expect(
      CopilotAuthorityRecordSchema.safeParse({
        ...authority,
        setupLineage: { ...witness, predecessor: pinned },
      }).success,
    ).toBe(true);
    const creating = {
      operationId: 'successor',
      epoch: 'successor-epoch',
      account,
      origin: 'setup' as const,
      kind: 'create' as const,
      from: null,
      committed: null,
      probeConfirmed: false,
      cancelling: false,
    };
    const damaged: Record<string, unknown> = {
      'survivor epoch': {
        ...authority,
        setupLineage: {
          ...witness,
          predecessor: {
            ...own,
            identity: { ...own.identity, epoch: 'foreign-epoch' },
          },
        },
      },
      'import survivor': {
        ...authority,
        setupLineage: {
          ...witness,
          predecessor: {
            ...own,
            identity: { ...own.identity, origin: 'import' },
          },
        },
      },
      'selected survivor': {
        ...authority,
        setupLineage: {
          ...witness,
          predecessor: { ...pinned, state: 'selected' },
        },
      },
      'creating own receipt': {
        ...authority,
        completed: null,
        mutation: creating,
        setupLineage: { ...witness, phase: 'creating' },
      },
      'cancelling own receipt': {
        ...authority,
        completed: null,
        mutation: { ...creating, cancelling: true },
        setupLineage: { ...witness, phase: 'cancelling' },
      },
      'retired own receipt': {
        ...authority,
        completed: { ...authority.completed, operationId: 'successor' },
        setupLineage: { ...witness, predecessor: pinned, phase: 'retired' },
      },
      'foreign completion': {
        ...authority,
        completed: { ...authority.completed, operationId: 'foreign:cancel' },
      },
    };
    for (const [name, record] of Object.entries(damaged))
      expect([
        name,
        CopilotAuthorityRecordSchema.safeParse(record).success,
      ]).toEqual([name, false]);
    expect(() =>
      copilotAuthorityBundle(
        {
          ...upgraded,
          authority: {
            ...authority,
            setupLineage: {
              ...witness,
              predecessor: {
                ...pinned,
                pin: {
                  ...pinned.pin,
                  ref: { ...pinned.pin.ref, vaultId: 'foreign-vault' },
                },
              },
            },
          },
        },
        vault.vaultId,
      ),
    ).toThrow();
    expect(await state.journal.compareExchange(0, authority)).toBe(true);
    expect(state.read()).toEqual(upgraded);
    await expect(
      state.journal.compareExchange(1, {
        ...withoutWitness,
        version: 1,
        sequence: 2,
      }),
    ).rejects.toThrow();
    expect(state.read()).toEqual(upgraded);
  } finally {
    disposeVaultSubkeys(keys);
  }
});

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

const grant: CopilotVaultGrant = {
  version: 1,
  clientId: 'client',
  host: 'github.com',
  login: 'pilot',
  id: '1',
  accessToken: 'p8-access-sentinel',
  refreshToken: 'p8-refresh-sentinel',
  accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  refreshTokenExpiresAt: '2099-02-01T00:00:00.000Z',
};
async function publishedImport(): Promise<CopilotPilotState> {
  const state = initialize();
  const key = bind(state);
  accept(state);
  const put = await state.writer.put(importRequest(key));
  if (put.kind !== 'committed') throw new Error('Missing import');
  const before = state.read();
  const b = before.binding;
  if (!b) throw new Error('Missing binding');
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
  return state;
}

async function completedPublishedDelete(): Promise<CopilotPilotState> {
  const state = await publishedImport();
  const before = await state.journal.read();
  const head = before.head;
  if (!head) throw new Error('Missing publication');
  const operationId = 'round-2-rejected-delete';
  expect(
    await state.journal.compareExchange(before.sequence, {
      ...before,
      sequence: before.sequence + 1,
      removal: { operationId: 'round-2-removal', epoch: head.epoch },
      mutation: {
        operationId,
        epoch: head.epoch,
        account: head.account,
        origin: head.origin,
        kind: 'delete',
        from: head.pin,
        committed: null,
        probeConfirmed: true,
        cancelling: false,
      },
    }),
  ).toBe(true);
  const pending = await state.journal.read();
  expect(
    await state.writer.delete({
      ref: head.pin.ref,
      expectedRevision: head.pin.revision,
      idempotencyKey: operationId,
    }),
  ).toMatchObject({ kind: 'committed' });
  expect(
    await state.journal.compareExchange(pending.sequence, {
      ...pending,
      sequence: pending.sequence + 1,
      mutation: null,
      completed: { operationId, epoch: head.epoch, kind: 'delete' },
    }),
  ).toBe(true);
  return state;
}

it.each([false, true])(
  'P8 round 2 completed published delete retires after restart (prune: %s)',
  async (prune) => {
    const state = await completedPublishedDelete();
    const before = state.read();
    const head = before.authority.head;
    const completed = before.authority.completed;
    if (!head || !completed) throw new Error('Missing held completion');
    await reopen();
    if (prune) store.pruneTombstones([head.pin.ref.entryId]);
    const rebuilt = vault.openCopilotPilotState({ kind: 'existing' });
    expect(await rebuilt.journal.reconcile(completed.operationId)).toEqual({
      kind: 'committed',
      pin: { ref: head.pin.ref, revision: head.pin.revision + 1 },
    });
    expect(await authority(rebuilt).resume(completed.operationId)).toEqual({
      kind: 'removed',
    });
    expect(rebuilt.read().binding).toEqual({
      ...before.binding,
      phase: 'retired',
    });
    expect(rebuilt.read().authority).toMatchObject({
      head: null,
      mutation: null,
      removal: null,
      completed,
    });
    expect(rebuilt.read().controls).toEqual([
      expect.objectContaining({
        kind: 'retirement',
        phase: 'retired',
        destination: head.pin,
      }),
    ]);
    expect(await authority(rebuilt).remove(head.epoch)).toEqual({
      kind: 'removed',
    });
    expect(store.listIntents().filter((i) => i.kind === 'delete')).toHaveLength(
      1,
    );
  },
);

it.each([
  'operation',
  'epoch',
  'completion',
  'fence',
  'receipt',
  'revision',
  'next-sequence',
  'sequence',
] as const)(
  'P8 round 2 completed published delete refuses %s mismatch without retiring history',
  async (damage) => {
    let state = await completedPublishedDelete();
    if (damage === 'receipt' || damage === 'revision') {
      vault.dispose();
      store.close();
      const db = new DatabaseSync(join(folder.folder, VAULT_STORE_FILE));
      db.exec(
        damage === 'receipt'
          ? "UPDATE vault_intents SET receipt = zeroblob(32) WHERE kind = 'delete'"
          : "UPDATE vault_intents SET outcome_revision = outcome_revision + 1 WHERE kind = 'delete'",
      );
      db.close();
      await reopen();
      state = vault.openCopilotPilotState({ kind: 'existing' });
    }
    if (damage === 'fence') {
      const previous = await state.journal.read();
      expect(
        await state.journal.compareExchange(previous.sequence, {
          ...previous,
          sequence: previous.sequence + 1,
          removal: null,
        }),
      ).toBe(true);
    }
    const before = state.read();
    const previous = before.authority;
    const completed = previous.completed;
    if (!completed) throw new Error('Missing completion');
    if (damage === 'sequence') {
      const reconcile = state.journal.reconcile.bind(state.journal);
      jest.spyOn(state.journal, 'reconcile').mockImplementation(async (id) => {
        const result = await reconcile(id);
        expect(
          state.compareExchange(previous.sequence, {
            ...before,
            authority: { ...previous, sequence: previous.sequence + 1 },
          }),
        ).toBe(true);
        return result;
      });
    }
    const saving = state.journal.compareExchange(previous.sequence, {
      ...previous,
      sequence: previous.sequence + (damage === 'next-sequence' ? 2 : 1),
      head: null,
      removal: null,
      completed:
        damage === 'completion'
          ? null
          : {
              ...completed,
              operationId:
                damage === 'operation'
                  ? 'foreign-delete'
                  : completed.operationId,
              epoch: damage === 'epoch' ? 'foreign-epoch' : completed.epoch,
            },
    });
    if (damage === 'sequence') await expect(saving).resolves.toBe(false);
    else await expect(saving).rejects.toThrow();
    expect(state.read()).toEqual(
      damage === 'sequence'
        ? {
            ...before,
            authority: { ...previous, sequence: previous.sequence + 1 },
          }
        : before,
    );
    expect(store.listIntents().filter((i) => i.kind === 'delete')).toHaveLength(
      1,
    );
  },
);

it.each(['before', 'after'] as const)(
  'P8 published retirement keeps head/binding/control atomic across %s-COMMIT uncertainty',
  async (where) => {
    const state = await publishedImport();
    const original = state.read();
    const head = original.authority.head;
    const binding = original.binding;
    if (!head || !binding) throw new Error('Missing publication');
    const write = store.writeCopilotAuthority.bind(store);
    let armed = true;
    let operationId: string | undefined;
    jest
      .spyOn(store, 'writeCopilotAuthority')
      .mockImplementation((update): ReturnType<typeof write> => {
        const encoded: unknown = JSON.parse(update.next);
        if (
          typeof encoded !== 'object' ||
          encoded === null ||
          !('payload' in encoded) ||
          typeof encoded.payload !== 'string'
        )
          throw new Error('Invalid authority envelope');
        const body = copilotAuthorityBundle(
          JSON.parse(encoded.payload),
          vault.vaultId,
        );
        if (body.binding?.phase === 'retired' && armed) {
          armed = false;
          operationId = state.read().authority.mutation?.operationId;
          expect(state.migration.read().head).toMatchObject({
            epoch: 2,
            attemptId: null,
            authority: 'cleared',
          });
          fault = where;
        }
        return write(update);
      });
    expect(await authority(state).remove(head.epoch)).toEqual(
      where === 'before'
        ? { kind: 'blocked', reason: 'unconfirmed' }
        : { kind: 'removed' },
    );
    expect(armed).toBe(false);
    if (!operationId) throw new Error('Missing stable deletion identity');
    await reopen();
    const rebuilt = vault.openCopilotPilotState({ kind: 'existing' });
    const pending = rebuilt.read();
    if (where === 'before') {
      expect(pending.binding).toEqual(original.binding);
      expect(pending.authority.head).toEqual(head);
      expect(pending.authority.mutation).toMatchObject({
        operationId,
        kind: 'delete',
        from: head.pin,
      });
      expect(pending.controls).toEqual(original.controls);
    } else {
      expect(pending.binding?.phase).toBe('retired');
      expect(pending.authority.head).toBeNull();
      expect(pending.authority.mutation).toBeNull();
    }
    expect(await authority(rebuilt).resume(operationId)).toEqual({
      kind: 'removed',
    });
    const retired = rebuilt.read();
    expect(retired.binding).toEqual({ ...original.binding, phase: 'retired' });
    expect(retired.authority.head).toBeNull();
    expect(retired.authority.mutation).toBeNull();
    expect(retired.authority.removal).toBeNull();
    expect(retired.authority.completed).toEqual({
      kind: 'delete',
      epoch: head.epoch,
      operationId,
    });
    expect(retired.controls).toEqual([
      {
        kind: 'retirement',
        operationId: original.binding.operationId,
        attemptId: original.binding.attemptId,
        migrationEpoch: original.binding.migrationEpoch,
        identity: original.binding.identity,
        accountEpoch: head.epoch,
        destination: head.pin,
        completionId: null,
        phase: 'retired',
      },
    ]);
    expect(
      store
        .listIntents()
        .filter((i) => i.kind === 'delete')
        .map((i) => i.idempotencyKey),
    ).toEqual([operationId]);
    expect(store.readEntry(head.pin.ref.entryId)).toBeNull();
    const keys = deriveVaultSubkeys(new Uint8Array(32).fill(72), vault.vaultId);
    try {
      expect(
        decodeCopilotAuthority(keys, encodeCopilotAuthority(keys, retired)),
      ).toEqual(retired);
      // A headless retirement cannot be interpreted as an older published account.
      expect(() =>
        encodeCopilotAuthority(keys, {
          ...retired,
          binding: { ...binding, phase: 'published' },
        }),
      ).toThrow();
      const payload = canonicalCopilotJson({ ...retired, version: 2 });
      const mac = withVaultSubkey(keys, 'receipt', (key) =>
        createHmac('sha256', key)
          .update('canopy/vault/copilot-authority/v1\0')
          .update(payload)
          .digest('hex'),
      );
      expect(() =>
        decodeCopilotAuthority(keys, JSON.stringify({ payload, mac })),
      ).toThrow();
    } finally {
      disposeVaultSubkeys(keys);
    }
  },
);

it.each(['copilot_authority_format', 'copilot_authority_v1', 'both'])(
  'P8 retired empty custody never becomes unused after losing authenticated marker %s',
  async (marker) => {
    const state = await publishedImport();
    const head = state.read().authority.head;
    if (!head) throw new Error('Missing publication');
    expect(await authority(state).remove(head.epoch)).toEqual({
      kind: 'removed',
    });
    vault.dispose();
    store.close();
    const db = new DatabaseSync(join(folder.folder, VAULT_STORE_FILE));
    if (marker === 'both')
      db.exec("DELETE FROM vault_meta WHERE key LIKE 'copilot_authority_%'");
    else db.prepare('DELETE FROM vault_meta WHERE key = ?').run(marker);
    db.close();
    await reopen();
    expect(() => vault.openCopilotPilotState({ kind: 'existing' })).toThrow();
    expect(() => initialize()).toThrow();
  },
);

function authority(
  state: CopilotPilotState,
  loseDelete = false,
  refresh?: CopilotGrantAuthorityOptions['refresh'],
  deliver: CopilotGrantAuthorityOptions['recipient']['deliver'] = () =>
    undefined,
): CopilotVaultGrantAuthority {
  return createCopilotVaultGrantAuthority({
    repository: () => Promise.resolve(vault.repository),
    writer: () =>
      Promise.resolve({
        ...state.writer,
        put: (request) => state.writer.put(request),
        async delete(request) {
          const result = await state.writer.delete(request);
          return loseDelete && result.kind === 'committed'
            ? { kind: 'outcome_unknown', ref: result.ref }
            : result;
        },
      }),
    probeKeyIfDue: () => vault.probeKeyIfDue(),
    journal: state.journal,
    probe: () => Promise.resolve(),
    refresh: refresh ?? (() => Promise.resolve({ kind: 'rejected' })),
    selection: {
      confirm: (request) =>
        Promise.resolve({
          kind: 'confirmed',
          receipt: { ...request, pinGeneration: 'p8' },
        }),
      disable: () => Promise.resolve({ kind: 'disabled' }),
    },
    recipient: { admitted: () => true, deliver, revoke: () => undefined },
  });
}
it.each([false, true])(
  'P8 real journal completes an acknowledged-lost destination delete after full store reconstruction without replay (pruned tombstone: %s)',
  async (prune) => {
    const state = initialize();
    const a = authority(state, true);
    const created = await a.create(grant, 'setup');
    if (created.kind !== 'ready')
      throw new Error('setup failed: ' + JSON.stringify(created));
    expect((await a.remove(created.head.epoch)).kind).toBe('blocked');
    const pending = await state.journal.read();
    if (!pending.mutation) throw new Error('Missing pending deletion');
    const operationId = pending.mutation.operationId;
    expect(store.findIntent('copilot-account', operationId)?.state).toBe(
      'committed',
    );
    await reopen();
    if (prune) store.pruneTombstones([created.head.pin.ref.entryId]);
    const reconstructed = vault.openCopilotPilotState({ kind: 'existing' });
    expect(await authority(reconstructed).resume(operationId)).toEqual({
      kind: 'removed',
    });
    expect(store.listIntents().filter((i) => i.kind === 'delete')).toHaveLength(
      1,
    );
    expect((await reconstructed.journal.read()).head).toBeNull();
  },
);

it('P8 explicit removal uses trusted metadata even when the selected ciphertext cannot be decrypted', async () => {
  const state = initialize();
  const created = await authority(state).create(grant, 'setup');
  if (created.kind !== 'ready') throw new Error('Expected account');
  vault.dispose();
  store.close();
  const db = new DatabaseSync(join(folder.folder, VAULT_STORE_FILE));
  db.exec('UPDATE vault_entries SET tag = zeroblob(16)');
  db.close();
  await reopen();
  const reconstructed = vault.openCopilotPilotState({ kind: 'existing' });
  const a = authority(reconstructed);
  expect(await a.present('recipient', created.head.epoch)).toEqual({
    kind: 'blocked',
    reason: 'corrupt',
  });
  expect(await a.remove(created.head.epoch)).toEqual({ kind: 'removed' });
  expect(store.listIntents().filter((i) => i.kind === 'delete')).toHaveLength(
    1,
  );
});

it.each(['receipt', 'missing-entry', 'wrong-revision'] as const)(
  'P8 delete reconciliation refuses %s instead of adopting absence or conflicting history',
  async (damage) => {
    const state = initialize();
    const a = authority(state);
    const created = await a.create(grant, 'setup');
    if (created.kind !== 'ready') throw new Error('Expected account');
    holdDelete = (): Promise<void> => {
      fault = 'before';
      return Promise.resolve();
    };
    expect((await a.remove(created.head.epoch)).kind).toBe('blocked');
    const m = (await state.journal.read()).mutation;
    if (!m) throw new Error('Expected pending deletion');
    vault.dispose();
    store.close();
    const db = new DatabaseSync(join(folder.folder, VAULT_STORE_FILE));
    if (damage === 'receipt')
      db.exec(
        "UPDATE vault_intents SET receipt = zeroblob(32) WHERE kind = 'delete'",
      );
    if (damage === 'missing-entry') db.exec('DELETE FROM vault_entries');
    if (damage === 'wrong-revision')
      db.exec(
        "UPDATE vault_intents SET expected_revision = expected_revision + 1 WHERE kind = 'delete'",
      );
    db.close();
    holdDelete = undefined;
    await reopen();
    const reconstructed = vault.openCopilotPilotState({ kind: 'existing' });
    expect(await reconstructed.journal.reconcile(m.operationId)).toEqual({
      kind: 'unconfirmed',
    });
    expect((await authority(reconstructed).resume(m.operationId)).kind).toBe(
      'blocked',
    );
    expect(store.listIntents().filter((i) => i.kind === 'delete')).toHaveLength(
      1,
    );
    expect((await reconstructed.journal.read()).head).toEqual(created.head);
  },
);
it.each(['before', 'after'] as const)(
  'P8 real journal distinguishes running, stopped and committed deletion (%s)',
  async (where) => {
    const state = initialize();
    const a = authority(state);
    const created = await a.create(grant, 'setup');
    if (created.kind !== 'ready')
      throw new Error('setup failed: ' + JSON.stringify(created));
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    holdDelete = (): Promise<void> => {
      entered();
      return held;
    };
    const removing = a.remove(created.head.epoch);
    await started;
    const m = (await state.journal.read()).mutation;
    if (!m) throw new Error('Missing deletion');
    const intent = store.findIntent('copilot-account', m.operationId);
    if (!intent) throw new Error('Missing intent');
    try {
      expect(store.isIntentRunning(intent.sequence)).toBe(true);
      expect(await state.journal.reconcile(m.operationId)).toEqual({
        kind: 'unconfirmed',
      });
    } finally {
      fault = where;
      release();
      await removing;
    }
    expect(store.isIntentRunning(intent.sequence)).toBe(false);
    expect(await state.journal.reconcile(m.operationId)).toEqual(
      where === 'before'
        ? { kind: 'retryable' }
        : {
            kind: 'committed',
            pin: {
              ref: created.head.pin.ref,
              revision: created.head.pin.revision + 1,
            },
          },
    );
  },
);

it('P8 real journal reconstruction never retires or replays a live process presentation', async () => {
  const state = initialize();
  let entered: () => void = () => undefined;
  let release: (result: { kind: 'lost' }) => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const response = new Promise<{ kind: 'lost' }>((resolve) => {
    release = resolve;
  });
  const refresh = jest.fn(() => {
    entered();
    return response;
  });
  const deliver = jest.fn(() => undefined);
  const a = authority(state, false, refresh, deliver);
  const created = await a.create(
    {
      ...grant,
      accessTokenExpiresAt: new Date(Date.now() + 1000).toISOString(),
    },
    'setup',
  );
  if (created.kind !== 'ready') throw new Error('Missing setup');
  const presenting = a.present('old', created.head.epoch);
  await started;
  try {
    const before = state.read();
    const intents = store.listIntents();
    const replay = jest.fn(() =>
      Promise.resolve({ kind: 'rejected' as const }),
    );
    const rebuilt = authority(
      vault.openCopilotPilotState({ kind: 'existing' }),
      false,
      replay,
      deliver,
    );
    expect(await rebuilt.demand()).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
    expect(await rebuilt.present('new', created.head.epoch)).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
    expect(state.read()).toEqual(before);
    expect(store.listIntents()).toEqual(intents);
    expect(store.listIntents().filter((i) => i.kind === 'delete')).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(replay).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  } finally {
    release({ kind: 'lost' });
    await presenting;
  }
});
