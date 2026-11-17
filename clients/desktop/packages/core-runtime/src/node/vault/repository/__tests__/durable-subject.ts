import { createFakeSecretProtection } from '../../../../platform/testing/fake-secret-protection';
import type {
  VaultRepositoryTestSubject,
  VaultTestCommit,
} from '../../../../vault/testing';
import { openVaultReadRepository } from '../read-repository';
import type { VaultStore, VaultStoreFaults } from '../store';
import { storeFolder } from './store-fixtures';

/*
 * The V0 conformance subject on the durable store: a new vault through the
 * production init path, a real SQLite file and the fake key-slot backend. A
 * held commit settles at the put or delete hold point, and its outcome becomes
 * a store fault on that write alone: `unavailable` fails it before it writes,
 * and `outcome_unknown` fails its sync, after the commit when applied.
 */

interface Gate {
  readonly settled: Promise<VaultTestCommit>;
  release(outcome: VaultTestCommit): void;
}

function gate(): Gate {
  let release: (outcome: VaultTestCommit) => void = () => undefined;
  const settled = new Promise<VaultTestCommit>((resolve) => {
    release = resolve;
  });
  return { settled, release };
}

/** Delegates to `store`; each commit runs under the outcome its hold settled. */
function routedStore(
  store: VaultStore,
  outcomes: Map<number, VaultTestCommit>,
  arm: (outcome: VaultTestCommit | null) => void,
): VaultStore {
  function routed<T>(sequence: number, commit: () => T): T {
    arm(outcomes.get(sequence) ?? null);
    outcomes.delete(sequence);
    try {
      return commit();
    } finally {
      arm(null);
    }
  }
  return {
    get header(): VaultStore['header'] {
      return store.header;
    },
    get state(): VaultStore['state'] {
      return store.state;
    },
    writeHeader: (draft) => store.writeHeader(draft),
    recordIntent: (draft, migration) => store.recordIntent(draft, migration),
    setIntentRunning: (sequence, running) =>
      store.setIntentRunning(sequence, running),
    isIntentRunning: (sequence) => store.isIntentRunning(sequence),
    readCopilotAuthority: () => store.readCopilotAuthority(),
    writeCopilotAuthority: (update) => store.writeCopilotAuthority(update),
    readMigrationJournal: () => store.readMigrationJournal(),
    writeMigrationJournal: (update) => store.writeMigrationJournal(update),
    commitEntry: (sequence, draft) =>
      routed(sequence, () => store.commitEntry(sequence, draft)),
    commitTombstone: (sequence, revision) =>
      routed(sequence, () => store.commitTombstone(sequence, revision)),
    pruneTombstones: (entryIds) => store.pruneTombstones(entryIds),
    reopen: () => store.reopen(),
    listEntries: () => store.listEntries(),
    readEntry: (entryId) => store.readEntry(entryId),
    listIntents: () => store.listIntents(),
    findIntent: (family, key) => store.findIntent(family, key),
    readTombstone: (entryId) => store.readTombstone(entryId),
    listTombstones: () => store.listTombstones(),
    durability: () => store.durability(),
    close: () => store.close(),
  };
}

export async function createDurableVaultSubject(): Promise<VaultRepositoryTestSubject> {
  const dir = storeFolder();
  let armed: VaultTestCommit | null = null;
  const faults: VaultStoreFaults = {
    beforeWrite: () => {
      if (armed?.kind === 'unavailable')
        throw new Error('injected write failure');
    },
    sync: (commit) => {
      if (armed?.kind !== 'outcome_unknown') return commit();
      if (armed.applied) commit();
      throw new Error('injected sync failure');
    },
  };
  const opened = await dir.open({ faults });
  if (opened.kind !== 'opened')
    throw new Error(`Store did not open: ${opened.step}`);
  const outcomes = new Map<number, VaultTestCommit>();
  let next: Gate | null = null;
  // Holds the next accepted write, then routes its outcome to its own commit.
  const hold = (sequence: number): Promise<void> => {
    const held = next;
    next = null;
    outcomes.delete(sequence);
    if (held === null) return Promise.resolve();
    return held.settled.then((outcome) => {
      outcomes.set(sequence, outcome);
    });
  };
  const store = routedStore(opened.store, outcomes, (outcome) => {
    armed = outcome;
  });
  const vault = await openVaultReadRepository({
    store,
    slots: createFakeSecretProtection({ backend: 'macos_keychain' }).port,
    signal: new AbortController().signal,
    holdPut: hold,
    holdDelete: hold,
  });
  if (vault.kind !== 'opened')
    throw new Error(`Vault did not open: ${vault.step}`);
  return {
    repository: vault.vault.repository,
    writer: (family) => vault.vault.writer(family),
    holdNextCommit(): ReturnType<VaultRepositoryTestSubject['holdNextCommit']> {
      if (next !== null) throw new Error('A commit is already held.');
      const held = gate();
      next = held;
      return { release: (outcome) => held.release(outcome) };
    },
    // Reconciles every entry; the kit names the one it expects to change.
    reconcile: () => vault.vault.reconcile(),
    dispose(): Promise<void> {
      vault.vault.dispose();
      opened.store.close();
      dir.remove();
      return Promise.resolve();
    },
  };
}
