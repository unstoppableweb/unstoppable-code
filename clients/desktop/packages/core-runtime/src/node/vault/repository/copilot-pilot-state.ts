import { verifyCommittedReceipt } from './committed-receipt';
import {
  CopilotAuthorityJournalError,
  type CopilotAuthorityJournal,
} from '../copilot-grant-contracts';
import type { VaultFamilyWriter } from '../../../vault/contracts';
import {
  canonicalCopilotJson,
  copilotAuthorityBundle,
  decodeCopilotAuthority,
  encodeCopilotAuthority,
  type CopilotAuthorityBundle,
} from './copilot-authority-codec';
import { MIGRATION_IMPORT_PREFIX } from './migration-codec';
import {
  createMigrationStorage,
  type MigrationStorage,
} from './migration-storage';
import { isLiveMigrationIntent } from './migration-intent';
import { verifyVaultSecret } from './sealed-secret';
import type { VaultStore, VaultMigrationUpdate } from './store';
import type { VaultIntentDraft } from './store-records';
import type { VaultSubkeys } from './vault-keys';

export type CopilotPilotInitialization =
  | { readonly kind: 'existing' }
  | { readonly kind: 'initialize-unused'; readonly hostFence: 'absent' };
export interface CopilotPilotState {
  readonly journal: CopilotAuthorityJournal;
  readonly migration: MigrationStorage;
  readonly writer: VaultFamilyWriter;
  read(): CopilotAuthorityBundle;
  /** Affirmative authenticated unused-state projection, including repository history. */
  unused(): boolean;
  /** Trusted combined control/authority transaction; no independent binding writer. */
  compareExchange(
    expectedSequence: number,
    next: CopilotAuthorityBundle,
  ): boolean;
}
export interface CopilotPilotComposition {
  open(mode: CopilotPilotInitialization): CopilotPilotState;
  bindIntent(draft: VaultIntentDraft): VaultMigrationUpdate | undefined;
  admitKey(family: string, key: string): void;
}
export function createCopilotPilotComposition(options: {
  readonly store: VaultStore;
  readonly keys: () => VaultSubkeys | null;
  readonly writer: () => VaultFamilyWriter;
  readonly reconcile: () => void;
}): CopilotPilotComposition {
  const { store } = options;
  let opened = false;
  function keys(): VaultSubkeys {
    const held = options.keys();
    if (!held || held.vaultId !== store.header?.vaultId)
      throw new CopilotAuthorityJournalError('unavailable');
    return held;
  }
  function migrationNow(): MigrationStorage {
    return createMigrationStorage(store, keys());
  }
  function load(): { stored: string; bundle: CopilotAuthorityBundle } {
    const held = keys();
    if (!store.reopen()) throw new CopilotAuthorityJournalError('unavailable');
    try {
      const stored = store.readCopilotAuthority();
      if (stored === null) throw new CopilotAuthorityJournalError('corrupt');
      const bundle = decodeCopilotAuthority(held, stored);
      validateMigrationBinding(bundle);
      return { stored, bundle };
    } catch (error) {
      if (error instanceof CopilotAuthorityJournalError) throw error;
      throw new CopilotAuthorityJournalError('corrupt');
    }
  }
  function validateMigrationBinding(bundle: CopilotAuthorityBundle): void {
    for (const control of bundle.controls) {
      const attempt = migrationNow()
        .read()
        .attempts.find((a) => a.id === control.attemptId);
      if (
        !attempt ||
        attempt.epoch !== control.migrationEpoch ||
        canonicalCopilotJson(attempt.identity) !==
          canonicalCopilotJson(control.identity) ||
        (control.destination &&
          attempt.destination?.entryId !== control.destination.ref.entryId)
      )
        throw new CopilotAuthorityJournalError('corrupt');
    }
    const b = bundle.binding;
    if (!b) return;
    const migration = migrationNow();
    const journal = migration.read();
    const attempt = journal.attempts.find((a) => a.id === b.attemptId);
    if (
      !attempt ||
      attempt.epoch !== b.migrationEpoch ||
      canonicalCopilotJson(attempt.identity) !==
        canonicalCopilotJson(b.identity) ||
      (b.destination &&
        attempt.destination?.entryId !== b.destination.ref.entryId)
    )
      throw new CopilotAuthorityJournalError('corrupt');
  }
  function validatePublication(bundle: CopilotAuthorityBundle): void {
    const b = bundle.binding;
    if (!b || !['committed', 'published'].includes(b.phase)) return;
    const migration = migrationNow();
    const journal = migration.read();
    const outcome = migration.resolveExact(b.attemptId);
    if (
      outcome.kind !== 'committed' ||
      !b.destination ||
      canonicalCopilotJson(outcome.pin.ref) !==
        canonicalCopilotJson(b.destination.ref) ||
      (b.phase === 'committed'
        ? outcome.pin.revision !== b.destination.revision
        : outcome.pin.revision < b.destination.revision) ||
      (b.phase === 'published' &&
        (journal.head.attemptId !== b.attemptId ||
          journal.head.authority !== 'vault'))
    )
      throw new CopilotAuthorityJournalError('unconfirmed');
  }

  function commit(
    expected: string | null,
    next: CopilotAuthorityBundle,
  ): boolean {
    const encoded = encodeCopilotAuthority(keys(), next);
    const result = store.writeCopilotAuthority({ expected, next: encoded });
    if (result.kind === 'written') return true;
    if (result.kind === 'not_written') return false;
    // A faulted COMMIT can have landed. Reopen the same store, never remint identity.
    options.reconcile();
    if (!store.reopen()) throw new CopilotAuthorityJournalError('unconfirmed');
    const observed = store.readCopilotAuthority();
    if (observed !== null) decodeCopilotAuthority(keys(), observed);
    if (observed === encoded) return true;
    if (observed === expected) return false;
    throw new CopilotAuthorityJournalError('unconfirmed');
  }
  function compareExchange(
    expected: number,
    input: CopilotAuthorityBundle,
  ): boolean {
    const { stored, bundle } = load();
    const next = copilotAuthorityBundle(input, keys().vaultId);
    if (bundle.authority.sequence !== expected) return false;
    validateMigrationBinding(next);
    if (next.binding?.phase !== bundle.binding?.phase)
      validatePublication(next);
    if (
      next.authority.sequence !== expected + 1 ||
      next.migrationEpoch < bundle.migrationEpoch
    )
      throw new CopilotAuthorityJournalError('corrupt');
    const b = bundle.binding;
    const n = next.binding;
    if (b) {
      if (!n || n.operationId !== b.operationId) {
        if (
          b.phase !== 'retired' ||
          !next.controls.some(
            (c) =>
              c.kind === 'retirement' &&
              c.operationId === b.operationId &&
              c.phase === 'retired' &&
              c.attemptId === b.attemptId &&
              c.migrationEpoch === b.migrationEpoch &&
              c.accountEpoch === b.accountEpoch &&
              canonicalCopilotJson(c.identity) ===
                canonicalCopilotJson(b.identity) &&
              canonicalCopilotJson(c.destination) ===
                canonicalCopilotJson(b.destination),
          )
        )
          throw new CopilotAuthorityJournalError('corrupt');
      } else {
        const {
          phase: oldPhase,
          destination: oldDestination,
          ...oldIdentity
        } = b;
        const {
          phase: newPhase,
          destination: newDestination,
          ...newIdentity
        } = n;
        const phases = [
          'pre_ingress',
          'ingress_accepted',
          'committed',
          'published',
          'cancelling',
          'retired',
        ];
        if (
          canonicalCopilotJson(oldIdentity) !==
            canonicalCopilotJson(newIdentity) ||
          phases.indexOf(newPhase) < phases.indexOf(oldPhase) ||
          (oldDestination !== null &&
            canonicalCopilotJson(oldDestination) !==
              canonicalCopilotJson(newDestination))
        )
          throw new CopilotAuthorityJournalError('corrupt');
      }
    }
    for (const control of bundle.controls) {
      const successor = next.controls.find(
        (c) => c.operationId === control.operationId,
      );
      const phases = [
        'cancelling',
        'retired',
        'authorized',
        'claim_ready',
        'source_detached',
        'remove_authorized',
        'completed',
      ];
      if (!successor) throw new CopilotAuthorityJournalError('corrupt');
      const {
        phase: beforePhase,
        completionId: beforeCompletion,
        ...beforeIdentity
      } = control;
      const {
        phase: afterPhase,
        completionId: afterCompletion,
        ...afterIdentity
      } = successor;
      if (
        canonicalCopilotJson(beforeIdentity) !==
          canonicalCopilotJson(afterIdentity) ||
        (beforeCompletion !== null && beforeCompletion !== afterCompletion) ||
        phases.indexOf(afterPhase) < phases.indexOf(beforePhase)
      )
        throw new CopilotAuthorityJournalError('corrupt');
    }
    return commit(stored, next);
  }
  function admitKey(family: string, key: string): void {
    if (
      family !== 'copilot-account' ||
      !key.startsWith(MIGRATION_IMPORT_PREFIX)
    )
      return;
    if (!opened) throw new CopilotAuthorityJournalError('unavailable');
    const { bundle } = load();
    const b = bundle.binding;
    const journal = migrationNow().read();
    const attempt = journal.attempts.find((a) => a.id === b?.attemptId);
    if (
      !b ||
      b.operationId !== key ||
      b.phase !== 'ingress_accepted' ||
      !attempt ||
      attempt.disposition === 'cancelled' ||
      journal.head.attemptId !== attempt.id ||
      journal.head.epoch !== b.migrationEpoch ||
      attempt.epoch !== b.migrationEpoch ||
      canonicalCopilotJson(attempt.identity) !==
        canonicalCopilotJson(b.identity) ||
      bundle.authority.mutation?.operationId !== key ||
      !bundle.authority.mutation.probeConfirmed ||
      bundle.authority.mutation.cancelling
    )
      throw new CopilotAuthorityJournalError('unconfirmed');
  }
  function currentMigration(): MigrationStorage {
    load();
    return migrationNow();
  }
  const migration: MigrationStorage = {
    read: () => currentMigration().read(),
    importKey: (id) => currentMigration().importKey(id),
    prepare: (identity, epoch) => currentMigration().prepare(identity, epoch),
    bindIntent: (draft) => {
      admitKey(draft.family, draft.idempotencyKey);
      return currentMigration().bindIntent(draft);
    },
    resolve: (id) => currentMigration().resolve(id),
    resolveExact: (id) => currentMigration().resolveExact(id),
    reconcile: (id, epoch) => currentMigration().reconcile(id, epoch),
    select: (id, epoch) => currentMigration().select(id, epoch),
    recordUse: (id, epoch, receipt) =>
      currentMigration().recordUse(id, epoch, receipt),
    authorizeDeletion: (id, epoch, op) =>
      currentMigration().authorizeDeletion(id, epoch, op),
    deletionReceipt: (id, epoch, op, generation, completion) =>
      currentMigration().deletionReceipt(id, epoch, op, generation, completion),
    retiredDeletionReceipt(id, epoch, op, generation, completion): void {
      const { bundle } = load();
      const control = bundle.controls.find((c) => c.operationId === op);
      if (
        bundle.binding?.phase !== 'cancelling' ||
        bundle.binding.attemptId !== id ||
        bundle.binding.migrationEpoch !== epoch ||
        control?.accountEpoch !== bundle.binding.accountEpoch ||
        control?.kind !== 'deletion' ||
        control.phase !== 'completed' ||
        control.attemptId !== id ||
        control.migrationEpoch !== epoch ||
        control.identity.generation !== generation ||
        control.completionId !== completion
      )
        throw new CopilotAuthorityJournalError('unconfirmed');
      currentMigration().retiredDeletionReceipt(
        id,
        epoch,
        op,
        generation,
        completion,
      );
    },
    supersede: (epoch, reason) => currentMigration().supersede(epoch, reason),
  };
  const journal: CopilotAuthorityJournal = {
    read: () => Promise.resolve().then(() => load().bundle.authority),
    compareExchange: (expected, next) =>
      Promise.resolve().then(() => {
        const { bundle } = load();
        // Ordinary P4 saves cannot independently change or erase binding/control state.
        return compareExchange(expected, { ...bundle, authority: next });
      }),
    reconcile(operationId) {
      try {
        options.reconcile();
        const { bundle } = load();
        if (operationId.startsWith(MIGRATION_IMPORT_PREFIX)) {
          const result = migrationNow().resolveExact(
            operationId.slice(MIGRATION_IMPORT_PREFIX.length),
          );
          if (result.kind === 'committed')
            return Promise.resolve({ kind: 'committed', pin: result.pin });
          return Promise.resolve({
            kind:
              result.kind === 'not_committed'
                ? 'retryable'
                : result.kind === 'not_accepted'
                  ? 'not_accepted'
                  : 'unconfirmed',
          });
        }
        const m = bundle.authority.mutation;
        const h = bundle.authority.head;
        const owner =
          m?.operationId === operationId
            ? m
            : h?.operationId === operationId
              ? h
              : null;
        if (!owner) return Promise.resolve({ kind: 'unconfirmed' });
        const intent = store.findIntent('copilot-account', operationId);
        if (!intent) return Promise.resolve({ kind: 'not_accepted' });
        const expected = 'from' in owner ? owner.from : null;
        const destination = 'committed' in owner ? owner.committed : owner.pin;
        if (
          intent.kind !== 'put' ||
          (expected && intent.entryId !== expected.ref.entryId) ||
          (destination && intent.entryId !== destination.ref.entryId) ||
          ('from' in owner &&
            intent.expectedRevision !== (expected?.revision ?? null)) ||
          store.isIntentRunning(intent.sequence)
        )
          return Promise.resolve({ kind: 'unconfirmed' });
        const lineage = store
          .listIntents()
          .filter((i) => i.entryId === intent.entryId);
        if (
          lineage.some(
            (i) => i.kind === 'delete' || store.isIntentRunning(i.sequence),
          )
        )
          return Promise.resolve({ kind: 'unconfirmed' });
        const entry = store.readEntry(intent.entryId);
        if (intent.state === 'pending') {
          const stoppedCreate =
            entry === null && intent.expectedRevision === null;
          const stoppedReplace =
            entry !== null &&
            expected !== null &&
            entry.family === 'copilot-account' &&
            entry.revision === expected.revision &&
            intent.expectedRevision === expected.revision &&
            verifyVaultSecret(
              keys(),
              { ...entry, vaultId: keys().vaultId },
              entry.sealed,
            ).kind === 'verified';
          return Promise.resolve({
            kind: stoppedCreate || stoppedReplace ? 'retryable' : 'unconfirmed',
          });
        }
        if (
          !entry ||
          store.listEntries().filter((e) => e.family === 'copilot-account')
            .length !== 1 ||
          (!('from' in owner) &&
            intent.outcomeRevision !== owner.pin.revision) ||
          entry.family !== 'copilot-account' ||
          intent.outcomeRevision !==
            (intent.expectedRevision === null
              ? 0
              : intent.expectedRevision + 1) ||
          verifyVaultSecret(
            keys(),
            { ...entry, vaultId: keys().vaultId },
            entry.sealed,
          ).kind !== 'verified'
        )
          return Promise.resolve({ kind: 'unconfirmed' });
        let revision = intent.outcomeRevision;
        for (const successor of lineage
          .filter(
            (i) => i.sequence > intent.sequence && i.state === 'committed',
          )
          .sort((a, b) => a.sequence - b.sequence)) {
          if (
            successor.family !== 'copilot-account' ||
            successor.expectedRevision !== revision ||
            successor.outcomeRevision !== revision + 1
          )
            return Promise.resolve({ kind: 'unconfirmed' });
          revision += 1;
        }
        if (
          entry.revision !== revision ||
          lineage.some((i) =>
            isLiveMigrationIntent(
              i,
              lineage,
              (seq) => store.isIntentRunning(seq),
              {
                entryId: entry.entryId,
                importSequence: intent.sequence,
                revision,
              },
            ),
          )
        )
          return Promise.resolve({ kind: 'unconfirmed' });
        const latest = lineage
          .filter((i) => i.state === 'committed')
          .sort((a, b) => b.sequence - a.sequence)[0];
        if (
          !latest ||
          !verifyCommittedReceipt(keys(), entry, latest) ||
          ('from' in owner &&
            owner.from === null &&
            owner.committed === null &&
            latest.sequence !== intent.sequence)
        )
          return Promise.resolve({ kind: 'unconfirmed' });
        return Promise.resolve({
          kind: 'committed',
          pin: {
            ref: { vaultId: keys().vaultId, entryId: entry.entryId },
            revision,
          },
        });
      } catch {
        return Promise.resolve({ kind: 'unconfirmed' });
      }
    },
  };
  return {
    admitKey,
    bindIntent: (draft) => {
      admitKey(draft.family, draft.idempotencyKey);
      return opened ? migrationNow().bindIntent(draft) : undefined;
    },
    open(mode): CopilotPilotState {
      const held = keys();
      options.reconcile();
      if (!store.reopen())
        throw new CopilotAuthorityJournalError('unavailable');
      const stored = store.readCopilotAuthority();
      if (stored === null) {
        if (
          mode.kind !== 'initialize-unused' ||
          mode.hostFence !== 'absent' ||
          store.listEntries().some((e) => e.family === 'copilot-account') ||
          store.listIntents().some((i) => i.family === 'copilot-account') ||
          store.listTombstones().some((t) => t.family === 'copilot-account') ||
          migrationNow().read().attempts.length !== 0 ||
          migrationNow().read().revision !== 0 ||
          migrationNow().read().head.epoch !== 0
        )
          throw new CopilotAuthorityJournalError('corrupt');
        const initial: CopilotAuthorityBundle = {
          version: 1,
          vaultId: held.vaultId,
          authority: {
            version: 1,
            sequence: 0,
            head: null,
            mutation: null,
            removal: null,
            completed: null,
          },
          migrationEpoch: 0,
          binding: null,
          controls: [],
        };
        if (!commit(null, initial))
          throw new CopilotAuthorityJournalError('unconfirmed');
      }
      load();
      opened = true;
      return {
        journal,
        migration,
        writer: options.writer(),
        read: () => load().bundle,
        unused(): boolean {
          const b = load().bundle;
          const p1 = migrationNow().read();
          return (
            b.authority.sequence === 0 &&
            !b.authority.head &&
            !b.authority.mutation &&
            !b.authority.removal &&
            !b.authority.completed &&
            !b.binding &&
            b.migrationEpoch === 0 &&
            b.controls.length === 0 &&
            p1.revision === 0 &&
            p1.head.epoch === 0 &&
            p1.attempts.length === 0 &&
            !store.listEntries().some((e) => e.family === 'copilot-account') &&
            !store.listIntents().some((i) => i.family === 'copilot-account') &&
            !store.listTombstones().some((t) => t.family === 'copilot-account')
          );
        },
        compareExchange,
      };
    },
  };
}
