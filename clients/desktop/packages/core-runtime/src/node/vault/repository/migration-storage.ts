import { verifyCommittedReceipt } from './committed-receipt';
import { randomUUID } from 'node:crypto';
import type { VaultSecretPin } from '../../../vault/contracts';
import {
  MIGRATION_IMPORT_PREFIX,
  decodeMigrationJournal,
  encodeMigrationJournal,
  invalidMigration,
  migrationIdentity,
  migrationUse,
  type MigrationAttempt,
  type MigrationIdentity,
  type MigrationJournal,
  type MigrationUseReceipt,
} from './migration-codec';
import { verifyVaultSecret } from './sealed-secret';
import { isLiveMigrationIntent } from './migration-intent';
import type { VaultMigrationUpdate, VaultStore } from './store';
import type { VaultIntentDraft } from './store-records';
import { assertVaultSubkeysHeld, type VaultSubkeys } from './vault-keys';

export type MigrationImportOutcome =
  | { readonly kind: 'not_accepted' }
  | { readonly kind: 'not_committed'; readonly entryId: string }
  | { readonly kind: 'retired' }
  | { readonly kind: 'unresolved' }
  | {
      readonly kind: 'committed';
      readonly pin: VaultSecretPin;
      readonly successorKeys: readonly string[];
    };

export interface MigrationStorage {
  read(): MigrationJournal;
  importKey(id: string): string;
  prepare(identity: MigrationIdentity, epoch: number): MigrationAttempt;
  bindIntent(
    this: void,
    draft: VaultIntentDraft,
  ): VaultMigrationUpdate | undefined;
  resolve(id: string): MigrationImportOutcome;
  /** Repository history remains accessible after cancellation retires selection eligibility. */
  resolveExact(id: string): MigrationImportOutcome;
  reconcile(id: string, epoch: number): MigrationImportOutcome;
  select(id: string, epoch: number): void;
  recordUse(id: string, epoch: number, receipt: MigrationUseReceipt): void;
  authorizeDeletion(id: string, epoch: number, operationId: string): void;
  deletionReceipt(
    id: string,
    epoch: number,
    operationId: string,
    generation: string,
    completionId: string | null,
  ): void;
  /** Trusted retirement owner only; never admits a late ordinary deletion response. */
  retiredDeletionReceipt(
    id: string,
    epoch: number,
    operationId: string,
    generation: string,
    completionId: string,
  ): void;
  supersede(epoch: number, reason: string): void;
}

/** Inert trusted repository seam. No session, recipient, source writer or production composition. */
export function createMigrationStorage(
  store: VaultStore,
  keys: VaultSubkeys,
): MigrationStorage {
  function load(): {
    readonly stored: string | null;
    readonly journal: MigrationJournal;
  } {
    assertVaultSubkeysHeld(keys);
    if (store.header?.vaultId !== keys.vaultId) return invalidMigration();
    const stored = store.readMigrationJournal();
    const journal: MigrationJournal =
      stored === null
        ? {
            version: 1,
            vaultId: keys.vaultId,
            revision: 0,
            head: { epoch: 0, attemptId: null, authority: 'cleared' },
            attempts: [],
          }
        : decodeMigrationJournal(keys, stored);
    const intents = store.listIntents();
    for (const intent of intents) {
      if (
        intent.family !== 'copilot-account' ||
        !intent.idempotencyKey.startsWith(MIGRATION_IMPORT_PREFIX)
      )
        continue;
      const attempt = journal.attempts.find(
        (item) => importKey(item.id) === intent.idempotencyKey,
      );
      if (
        !attempt ||
        intent.family !== 'copilot-account' ||
        intent.kind !== 'put' ||
        intent.expectedRevision !== null ||
        intent.entryId !== attempt.destination?.entryId
      )
        return invalidMigration();
    }
    for (const attempt of journal.attempts) {
      if (attempt.destination === null) continue;
      const intent = intents.find(
        (item) =>
          item.family === 'copilot-account' &&
          item.idempotencyKey === importKey(attempt.id),
      );
      if (
        !intent ||
        (attempt.destination.importRevision !== null &&
          (intent.state !== 'committed' || intent.outcomeRevision !== 0))
      )
        return invalidMigration();
    }
    return { stored, journal };
  }
  function importKey(id: string): string {
    return `${MIGRATION_IMPORT_PREFIX}${id}`;
  }
  function update(
    stored: string | null,
    journal: MigrationJournal,
  ): VaultMigrationUpdate {
    return {
      expected: stored,
      next: encodeMigrationJournal(keys, {
        ...journal,
        revision: journal.revision + 1,
      }),
    };
  }
  function write(stored: string | null, journal: MigrationJournal): void {
    const result = store.writeMigrationJournal(update(stored, journal));
    if (result.kind !== 'written')
      throw new Error(`Migration write ${result.kind}. Reopen and reconcile.`);
  }
  function current(
    journal: MigrationJournal,
    id: string,
    epoch: number,
  ): MigrationAttempt {
    const attempt = journal.attempts.find((item) => item.id === id);
    if (
      !attempt ||
      attempt.epoch !== epoch ||
      journal.head.epoch !== epoch ||
      journal.head.attemptId !== id ||
      attempt.disposition === 'cancelled'
    )
      throw new Error('Migration attempt is not current.');
    return attempt;
  }
  function replace(
    journal: MigrationJournal,
    attempt: MigrationAttempt,
  ): MigrationJournal {
    return {
      ...journal,
      attempts: journal.attempts.map((item) =>
        item.id === attempt.id ? attempt : item,
      ),
    };
  }
  function outcome(
    attempt: MigrationAttempt,
    exact = false,
  ): MigrationImportOutcome {
    if (!exact && attempt.disposition === 'cancelled')
      return { kind: 'retired' };
    if (attempt.destination === null) return { kind: 'not_accepted' };
    const intent = store.findIntent('copilot-account', importKey(attempt.id));
    if (!intent || intent.entryId !== attempt.destination.entryId)
      return invalidMigration();
    if (store.isIntentRunning(intent.sequence)) return { kind: 'unresolved' };
    const lineage = store
      .listIntents()
      .filter((item) => item.entryId === intent.entryId);
    if (lineage.some((item) => item.kind === 'delete'))
      return { kind: 'retired' };
    if (intent.state === 'pending') {
      if (store.readEntry(intent.entryId) !== null) return invalidMigration();
      return { kind: 'not_committed', entryId: intent.entryId };
    }
    if (intent.outcomeRevision !== 0) return invalidMigration();
    if (lineage.some((item) => store.isIntentRunning(item.sequence)))
      return { kind: 'unresolved' };
    const family = store
      .listEntries()
      .filter((item) => item.family === 'copilot-account');
    if (family.length !== 1 || family[0]?.entryId !== intent.entryId)
      return invalidMigration();
    const entry = family[0];
    const pin = {
      ref: { vaultId: keys.vaultId, entryId: entry.entryId },
      revision: entry.revision,
    };
    if (
      verifyVaultSecret(keys, { ...entry, vaultId: keys.vaultId }, entry.sealed)
        .kind !== 'verified'
    )
      return invalidMigration();
    const successors = lineage
      .filter(
        (item) => item.state === 'committed' && item.sequence > intent.sequence,
      )
      .sort((a, b) => a.sequence - b.sequence);
    let revision = 0;
    for (const successor of successors) {
      if (
        successor.family !== 'copilot-account' ||
        successor.kind !== 'put' ||
        successor.expectedRevision !== revision ||
        successor.outcomeRevision !== revision + 1
      )
        return invalidMigration();
      revision += 1;
    }
    if (revision !== entry.revision) return invalidMigration();
    if (
      exact &&
      !verifyCommittedReceipt(
        keys,
        entry,
        successors[successors.length - 1] ?? intent,
      )
    )
      return invalidMigration();
    if (
      lineage.some((item) =>
        isLiveMigrationIntent(
          item,
          lineage,
          (sequence) => store.isIntentRunning(sequence),
          {
            entryId: intent.entryId,
            importSequence: intent.sequence,
            revision,
          },
        ),
      )
    )
      return { kind: 'unresolved' };
    return {
      kind: 'committed',
      pin,
      successorKeys: successors.map((item) => item.idempotencyKey),
    };
  }
  return {
    read(): MigrationJournal {
      return load().journal;
    },
    importKey,
    prepare(identityInput: MigrationIdentity, epoch: number): MigrationAttempt {
      const identity = migrationIdentity(identityInput);
      const { stored, journal } = load();
      if (
        !Number.isSafeInteger(epoch) ||
        epoch < journal.head.epoch ||
        journal.head.attemptId !== null ||
        journal.attempts.some(
          (item) => JSON.stringify(item.identity) === JSON.stringify(identity),
        )
      )
        throw new Error('Migration generation is not eligible.');
      if (
        store.listEntries().some((item) => item.family === 'copilot-account') ||
        store
          .listIntents()
          .some(
            (item, _index, intents) =>
              item.family === 'copilot-account' &&
              isLiveMigrationIntent(item, intents, (sequence) =>
                store.isIntentRunning(sequence),
              ),
          )
      )
        throw new Error('Migration destination is not empty.');
      const attempt: MigrationAttempt = {
        id: randomUUID(),
        identity,
        epoch,
        state: 'not_started',
        disposition: 'prepared',
        destination: null,
        use: null,
        deletion: null,
        cancellationReason: null,
      };
      write(stored, {
        ...journal,
        head: { epoch, attemptId: attempt.id, authority: 'fenced' },
        attempts: [...journal.attempts, attempt],
      });
      return attempt;
    },
    /** Called only at the repository's mint/intent seam, before any await. */
    bindIntent(draft: VaultIntentDraft): VaultMigrationUpdate | undefined {
      if (
        draft.family !== 'copilot-account' ||
        !draft.idempotencyKey.startsWith(MIGRATION_IMPORT_PREFIX)
      )
        return undefined;
      const { stored, journal } = load();
      const attempt = current(
        journal,
        draft.idempotencyKey.slice(MIGRATION_IMPORT_PREFIX.length),
        journal.head.epoch,
      );
      if (
        draft.kind !== 'put' ||
        draft.family !== 'copilot-account' ||
        draft.expectedRevision !== null ||
        attempt.disposition !== 'prepared' ||
        journal.head.authority !== 'fenced'
      )
        throw new Error('Migration import is not admissible.');
      return update(
        stored,
        replace(journal, {
          ...attempt,
          disposition: 'accepted',
          destination: { entryId: draft.entryId, importRevision: null },
        }),
      );
    },
    resolve(id: string): MigrationImportOutcome {
      const { journal } = load();
      const attempt = journal.attempts.find((item) => item.id === id);
      return attempt ? outcome(attempt) : invalidMigration();
    },
    resolveExact(id: string): MigrationImportOutcome {
      const attempt = load().journal.attempts.find((item) => item.id === id);
      return attempt ? outcome(attempt, true) : invalidMigration();
    },
    reconcile(id: string, epoch: number): MigrationImportOutcome {
      const { stored, journal } = load();
      const attempt = current(journal, id, epoch);
      const result = outcome(attempt);
      if (result.kind === 'committed' && attempt.state === 'not_started') {
        write(
          stored,
          replace(journal, {
            ...attempt,
            disposition: 'committed',
            state: 'imported_unverified',
            destination: { entryId: result.pin.ref.entryId, importRevision: 0 },
          }),
        );
      } else if (
        result.kind === 'not_committed' &&
        attempt.disposition === 'accepted'
      ) {
        write(
          stored,
          replace(journal, { ...attempt, disposition: 'not_committed' }),
        );
      }
      return result;
    },
    select(id: string, epoch: number): void {
      const { stored, journal } = load();
      const attempt = current(journal, id, epoch);
      if (
        attempt.state === 'not_started' ||
        outcome(attempt).kind !== 'committed'
      )
        throw new Error('Migration import is not committed.');
      write(stored, {
        ...journal,
        head: { ...journal.head, authority: 'vault' },
      });
    },
    recordUse(id: string, epoch: number, input: MigrationUseReceipt): void {
      const receipt = migrationUse(input);
      const { stored, journal } = load();
      const attempt = current(journal, id, epoch);
      const result = outcome(attempt);
      if (
        journal.head.authority !== 'vault' ||
        attempt.state !== 'imported_unverified' ||
        result.kind !== 'committed' ||
        JSON.stringify(receipt.pin) !== JSON.stringify(result.pin) ||
        JSON.stringify(receipt.successorKeys) !==
          JSON.stringify(result.successorKeys)
      )
        throw new Error('Migration use is not committed-lineage evidence.');
      write(
        stored,
        replace(journal, { ...attempt, state: 'verified', use: receipt }),
      );
    },
    authorizeDeletion(id: string, epoch: number, operationId: string): void {
      const { stored, journal } = load();
      const attempt = current(journal, id, epoch);
      if (
        attempt.state !== 'verified' ||
        attempt.deletion !== null ||
        journal.head.authority !== 'vault' ||
        outcome(attempt).kind !== 'committed'
      )
        throw new Error('Migration deletion is not authorized.');
      write(
        stored,
        replace(journal, {
          ...attempt,
          deletion: {
            id: operationId,
            generation: attempt.identity.generation,
            phase: 'authorized',
            completionId: null,
          },
        }),
      );
    },
    deletionReceipt(
      id: string,
      epoch: number,
      operationId: string,
      generation: string,
      completionId: string | null,
    ): void {
      const { stored, journal } = load();
      const attempt = current(journal, id, epoch);
      const deletion = attempt.deletion;
      if (
        !deletion ||
        deletion.id !== operationId ||
        deletion.generation !== generation ||
        attempt.state !== 'verified' ||
        (completionId !== null && deletion.phase !== 'submitted')
      )
        throw new Error('Migration deletion receipt does not match.');
      write(
        stored,
        replace(journal, {
          ...attempt,
          state: completionId === null ? 'verified' : 'legacy_deleted',
          deletion: {
            ...deletion,
            phase: completionId === null ? 'submitted' : 'completed',
            completionId,
          },
        }),
      );
    },
    retiredDeletionReceipt(
      id,
      epoch,
      operationId,
      generation,
      completionId,
    ): void {
      const { stored, journal } = load();
      const attempt = journal.attempts.find(
        (a) => a.id === id && a.epoch === epoch,
      );
      const deletion = attempt?.deletion;
      if (
        !attempt ||
        attempt.disposition !== 'cancelled' ||
        !completionId ||
        journal.head.epoch <= epoch ||
        !deletion ||
        deletion.id !== operationId ||
        deletion.generation !== generation ||
        deletion.phase !== 'submitted' ||
        attempt.state !== 'verified'
      )
        throw new Error('Retired cleanup receipt does not match.');
      write(
        stored,
        replace(journal, {
          ...attempt,
          state: 'legacy_deleted',
          deletion: { ...deletion, phase: 'completed', completionId },
        }),
      );
    },
    supersede(epoch: number, reason: string): void {
      const { stored, journal } = load();
      if (!Number.isSafeInteger(epoch) || epoch <= journal.head.epoch)
        throw new Error('Migration epoch must advance.');
      write(stored, {
        ...journal,
        head: { epoch, attemptId: null, authority: 'cleared' },
        attempts: journal.attempts.map((item) =>
          item.id === journal.head.attemptId && item.state !== 'legacy_deleted'
            ? { ...item, disposition: 'cancelled', cancellationReason: reason }
            : item,
        ),
      });
    },
  };
}
