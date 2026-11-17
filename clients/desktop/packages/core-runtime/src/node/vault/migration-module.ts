import type { CopilotVaultAccount } from './copilot-grant-contracts';
import { randomUUID } from 'node:crypto';
import type { CanopyDaemonClock } from '../daemon/leases';
import {
  MIGRATION_SLOTS_AT_PIN,
  sameMigrationSource,
  isMigrationImportResult,
  type MigrationAdmissionPort,
  type MigrationAttemptContext,
  type MigrationFamilyPorts,
  type MigrationHostOs,
  type MigrationImportResult,
  type MigrationLineageContext,
  type MigrationSourceIdentity,
} from './migration-ports';
import { MIGRATION_MAX_VALUE_BYTES } from './migration-protocol';
import {
  createMigrationSessionRegistry,
  type MigrationConsumeResult,
  type MigrationIssueResult,
  type MigrationPresentation,
  type MigrationSessionRegistry,
} from './migration-sessions';
import type { MigrationAttempt } from './repository/migration-codec';
import type { MigrationStorage } from './repository/migration-storage';

export interface MigrationModuleOptions {
  readonly admission: MigrationAdmissionPort;
  readonly storage: MigrationStorage;
  readonly brand: string;
  readonly build: string;
  readonly source: MigrationSourceIdentity;
  readonly os: MigrationHostOs;
  /** P4's account/head epoch; never taken from the launcher. */
  readonly epoch: () => number;
  readonly families: readonly MigrationFamilyPorts[];
  readonly clock?: CanopyDaemonClock;
}

export type MigrationRecoveryResult =
  | {
      readonly kind: 'progress';
      readonly attemptId: string;
      readonly state: MigrationAttempt['state'];
      readonly authority: 'fenced' | 'vault' | 'cleared';
    }
  | {
      readonly kind:
        | 'unavailable'
        | 'busy'
        | 'unresolved'
        | 'stale'
        | 'not_started';
    };

export interface ResumableMigrationModule extends Pick<
  MigrationSessionRegistry,
  'decline' | 'reportAmbiguity' | 'endChannel' | 'close' | 'get'
> {
  issue(channel: object, slot: string): Promise<MigrationIssueResult>;
  preflightImport(
    sessionId: string,
    presentation: MigrationPresentation,
  ): boolean;
  beginImport(
    sessionId: string,
    presentation: MigrationPresentation,
    account: CopilotVaultAccount,
    predecessorGeneration: string | null,
  ): Promise<MigrationAttemptContext>;
  importSlot(
    sessionId: string,
    presentation: MigrationPresentation,
    value: Uint8Array,
  ): MigrationConsumeResult<MigrationImportResult>;
  reconcile(): Promise<MigrationRecoveryResult>;
  verify(): Promise<MigrationRecoveryResult>;
  deleteLegacy(): Promise<MigrationRecoveryResult>;
}

/** Inert host composition. Use/deletion receipts have no launcher wire ingress. */
export function createResumableMigrationModule(
  options: MigrationModuleOptions,
): ResumableMigrationModule {
  const { storage, admission } = options;
  const source = Object.freeze({ ...options.source });
  const families = new Map<string, MigrationFamilyPorts>();
  for (const family of options.families) {
    if (families.has(family.slot))
      throw new Error('Duplicate migration family.');
    families.set(family.slot, family);
  }
  const family = families.get('copilot-account');
  const snapshot = family?.snapshot;
  const importer = family?.importer;
  const use = family?.use;
  const deletion = family?.deletion;
  // P1 supports only this family. A catalog entry is not implemented capability.
  const complete = !!(
    MIGRATION_SLOTS_AT_PIN.some(
      (slot) =>
        slot.id === 'copilot-account' && slot.platforms.includes(options.os),
    ) &&
    snapshot &&
    typeof snapshot.observe === 'function' &&
    typeof snapshot.withGeneration === 'function' &&
    importer &&
    typeof importer.import === 'function' &&
    use &&
    typeof use.use === 'function' &&
    deletion &&
    typeof deletion.remove === 'function' &&
    typeof deletion.reconcile === 'function'
  );
  let generation = '';
  let busy = false;
  let closed = false;
  let revision = 0;
  const offerEpochs = new Map<string, number>();
  const sessions = createMigrationSessionRegistry(
    {
      admission,
      clock: options.clock,
      source: {
        currentGeneration: () => generation,
        isFenced: () => false,
        fence: () => {
          /* P1 prepare already durably fences every submitted import. */
        },
        slotProgress: () => ({ state: 'not_started' }),
      },
      importer: {
        createIfAbsent: () =>
          Promise.reject(new Error('Use the resumable import boundary.')),
      },
    },
    {
      os: options.os,
      slots: complete
        ? MIGRATION_SLOTS_AT_PIN.filter((slot) => slot.id === 'copilot-account')
        : [],
    },
  );

  function readEpoch(): number | null {
    try {
      const epoch = options.epoch();
      return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
    } catch {
      return null;
    }
  }
  function current(): MigrationAttempt | null {
    const journal = storage.read();
    const epoch = readEpoch();
    if (
      epoch === null ||
      journal.head.epoch > epoch ||
      (journal.head.attemptId !== null && journal.head.epoch !== epoch)
    )
      throw new Error('Stale migration epoch.');
    const attempt = journal.attempts.find(
      (item) => item.id === journal.head.attemptId,
    );
    if (!attempt) return null;
    const identity = attempt.identity;
    if (
      identity.brand !== options.brand ||
      identity.build !== options.build ||
      identity.sourceFlavor !== source.flavorId ||
      identity.sourceMode !== source.secureMode ||
      attempt.disposition === 'cancelled'
    )
      throw new Error('Stale migration identity.');
    return attempt;
  }
  function progress(): MigrationRecoveryResult {
    const attempt = current();
    return attempt
      ? {
          kind: 'progress',
          attemptId: attempt.id,
          state: attempt.state,
          authority: storage.read().head.authority,
        }
      : { kind: 'not_started' };
  }
  function live(attempt: MigrationAttempt): MigrationAttempt {
    const latest = current();
    if (closed || latest?.id !== attempt.id)
      throw new Error('Migration retired.');
    return latest;
  }
  function context(attempt: MigrationAttempt): MigrationAttemptContext {
    return {
      attemptId: attempt.id,
      epoch: attempt.epoch,
      source,
      generation: attempt.identity.generation,
    };
  }
  function lineage(attempt: MigrationAttempt): MigrationLineageContext | null {
    live(attempt);
    const resolved = storage.reconcile(attempt.id, attempt.epoch);
    return resolved.kind === 'committed'
      ? {
          ...context(attempt),
          pin: resolved.pin,
          successorKeys: resolved.successorKeys,
        }
      : null;
  }
  async function exclusive(
    run: () => Promise<MigrationRecoveryResult>,
  ): Promise<MigrationRecoveryResult> {
    if (busy) return { kind: 'busy' };
    if (closed || !complete) return { kind: 'unavailable' };
    busy = true;
    try {
      return await run();
    } catch {
      return { kind: 'unavailable' };
    } finally {
      busy = false;
    }
  }
  async function reconcile(): Promise<MigrationRecoveryResult> {
    return exclusive(async () => {
      const attempt = current();
      if (!attempt || !snapshot) return { kind: 'not_started' };
      const resolved = storage.reconcile(attempt.id, attempt.epoch);
      if (resolved.kind === 'unresolved') return { kind: 'unresolved' };
      if (resolved.kind !== 'committed') return progress();
      // Completed cleanup no longer depends on legacy-file existence.
      if (attempt.state === 'legacy_deleted') return progress();
      return snapshot.withGeneration(
        source,
        async (observed): Promise<MigrationRecoveryResult> => {
          live(attempt);
          if (
            observed.kind !== 'present' ||
            observed.generation !== attempt.identity.generation
          )
            return { kind: 'stale' };
          storage.select(attempt.id, attempt.epoch);
          await importer?.finalize?.(
            context(attempt),
            () => !closed && current()?.id === attempt.id,
          );
          live(attempt);
          return progress();
        },
      );
    });
  }

  return {
    async issue(channel: object, slot: string): Promise<MigrationIssueResult> {
      if (busy) return { issued: false, reason: 'slot-busy' };
      if (closed) return { issued: false, reason: 'closed' };
      if (!complete || slot !== 'copilot-account' || !snapshot)
        return { issued: false, reason: 'slot-unavailable' };
      busy = true;
      const start = revision;
      try {
        const epoch = readEpoch();
        if (epoch === null)
          return { issued: false, reason: 'source-unavailable' };
        const facts = admission.channel(channel);
        if (!facts || !sameMigrationSource(facts.source, source))
          return { issued: false, reason: 'no-native-evidence' };
        if (admission.host().buildId !== options.build)
          return { issued: false, reason: 'host:buildId' };
        const observed = await snapshot.observe(source);
        if (closed) return { issued: false, reason: 'closed' };
        if (observed.kind !== 'present')
          return { issued: false, reason: `source:${observed.kind}` };
        if (!observed.generation || observed.generation.length > 4096)
          return { issued: false, reason: 'source-unavailable' };
        const attempt = current();
        if (attempt) {
          const outcome = storage.resolve(attempt.id);
          if (
            attempt.identity.generation !== observed.generation ||
            attempt.state !== 'not_started' ||
            (outcome.kind !== 'not_accepted' &&
              outcome.kind !== 'not_committed')
          )
            return { issued: false, reason: 'source-generation-fenced' };
        }
        if (
          !attempt &&
          storage
            .read()
            .attempts.some(
              (item) =>
                item.identity.brand === options.brand &&
                item.identity.build === options.build &&
                item.identity.sourceFlavor === source.flavorId &&
                item.identity.sourceMode === source.secureMode &&
                item.identity.generation === observed.generation,
            )
        )
          return { issued: false, reason: 'source-generation-fenced' };
        const revalidated = admission.channel(channel);
        if (!revalidated || !sameMigrationSource(revalidated.source, source))
          return { issued: false, reason: 'no-native-evidence' };
        if (admission.host().buildId !== options.build)
          return { issued: false, reason: 'host:buildId' };
        const finalEpoch = readEpoch();
        if (revision !== start || finalEpoch !== epoch)
          return { issued: false, reason: 'ambiguity:during-issue' };
        generation = observed.generation;
        const issued = sessions.issue(channel, slot);
        for (const id of offerEpochs.keys()) {
          if (sessions.get(id)?.state !== 'issued') offerEpochs.delete(id);
        }
        if (issued.issued) offerEpochs.set(issued.offer.sessionId, epoch);
        return issued;
      } catch {
        return { issued: false, reason: 'source-unavailable' };
      } finally {
        busy = false;
      }
    },
    preflightImport(sessionId, presentation): boolean {
      return (
        !busy &&
        !closed &&
        offerEpochs.get(sessionId) === readEpoch() &&
        sessions.preflight(sessionId, presentation).accepted
      );
    },
    async beginImport(sessionId, presentation, account, predecessorGeneration) {
      if (busy || closed || !snapshot || !importer?.begin)
        throw new Error('Import preparation unavailable.');
      const admitted = sessions.preflight(sessionId, presentation);
      const epoch = readEpoch();
      if (
        !admitted.accepted ||
        epoch === null ||
        offerEpochs.get(sessionId) !== epoch
      )
        throw new Error('Import offer unavailable.');
      busy = true;
      try {
        return await snapshot.withGeneration(source, async (observed) => {
          if (
            observed.kind !== 'present' ||
            observed.generation !== admitted.generation ||
            !sessions.preflight(sessionId, presentation).accepted ||
            readEpoch() !== epoch
          )
            throw new Error('Import source changed.');
          const existing = current();
          const attempt =
            existing ??
            storage.prepare(
              {
                brand: options.brand,
                build: options.build,
                sourceFlavor: source.flavorId,
                sourceMode: source.secureMode,
                slot: 'copilot-account',
                generation: observed.generation,
              },
              epoch,
            );
          if (attempt.identity.generation !== observed.generation)
            throw new Error('Import generation changed.');
          const ctx = context(attempt);
          await importer.begin?.({
            ...ctx,
            idempotencyKey: storage.importKey(attempt.id),
            account,
            predecessorGeneration,
          });
          live(attempt);
          return ctx;
        });
      } finally {
        busy = false;
      }
    },
    importSlot(
      sessionId: string,
      presentation: MigrationPresentation,
      value: Uint8Array,
    ): MigrationConsumeResult<MigrationImportResult> {
      const epoch = readEpoch();
      if (
        value.length === 0 ||
        value.length > MIGRATION_MAX_VALUE_BYTES ||
        busy ||
        closed ||
        epoch === null ||
        offerEpochs.get(sessionId) !== epoch
      ) {
        value.fill(0);
        sessions.revoke(sessionId, 'import-unavailable');
        return { accepted: false, reason: 'source-unavailable' };
      }
      const offeredEpoch = epoch;
      let started = false;
      const result = sessions.consume(
        sessionId,
        presentation,
        (release) => {
          started = true;
          busy = true;
          return (async (): Promise<MigrationImportResult> => {
            try {
              if (!snapshot || !importer)
                throw new Error('Incomplete migration family.');
              return await snapshot.withGeneration(source, async (observed) => {
                if (
                  observed.kind !== 'present' ||
                  observed.generation !== release.generation
                )
                  throw new Error('Source changed.');
                if (
                  offeredEpoch !== readEpoch() ||
                  !sameMigrationSource(release.source, source)
                )
                  throw new Error('Stale migration offer.');
                const existing = current();
                if (existing) {
                  const outcome = storage.resolve(existing.id);
                  if (
                    existing.identity.generation !== observed.generation ||
                    existing.state !== 'not_started' ||
                    (outcome.kind !== 'not_accepted' &&
                      outcome.kind !== 'not_committed')
                  )
                    throw new Error('Migration import is not eligible.');
                }
                generation = observed.generation;
                if (!release.mayRelease())
                  throw new Error('Migration release refused.');
                const attempt =
                  existing ??
                  storage.prepare(
                    {
                      brand: options.brand,
                      build: options.build,
                      sourceFlavor: source.flavorId,
                      sourceMode: source.secureMode,
                      slot: 'copilot-account',
                      generation,
                    },
                    offeredEpoch,
                  );
                live(attempt);
                if (attempt.identity.generation !== generation)
                  throw new Error('Stale generation.');
                if (!release.isCurrent())
                  throw new Error('Migration release retired.');
                await importer.import({
                  ...context(attempt),
                  idempotencyKey: storage.importKey(attempt.id),
                  value,
                  isCurrent: () => release.isCurrent(),
                });
                live(attempt);
                const resolved = storage.reconcile(attempt.id, attempt.epoch);
                if (resolved.kind !== 'committed')
                  throw new Error('Import unresolved.');
                if (!release.isCurrent())
                  throw new Error('Migration release retired.');
                storage.select(attempt.id, attempt.epoch);
                await importer.finalize?.(context(attempt), () =>
                  release.isCurrent(),
                );
                live(attempt);
                if (!release.isCurrent())
                  throw new Error('Migration release retired.');
                return { kind: 'created', receipt: attempt.id };
              });
            } finally {
              value.fill(0);
              busy = false;
            }
          })();
        },
        isMigrationImportResult,
      );
      if (!started) value.fill(0);
      return result;
    },
    decline(...args): ReturnType<MigrationSessionRegistry['decline']> {
      return sessions.decline(...args);
    },
    reconcile,
    verify(): Promise<MigrationRecoveryResult> {
      return exclusive(async () => {
        const attempt = current();
        if (!attempt || !use) return { kind: 'not_started' };
        if (attempt.state === 'verified' || attempt.state === 'legacy_deleted')
          return progress();
        const bound = lineage(attempt);
        if (!bound || storage.read().head.authority !== 'vault')
          return { kind: 'unresolved' };
        const result = await use.use(bound);
        live(attempt);
        if (result.kind !== 'used') return { kind: 'unresolved' };
        storage.recordUse(attempt.id, attempt.epoch, result.receipt);
        return progress();
      });
    },
    deleteLegacy(): Promise<MigrationRecoveryResult> {
      return exclusive(async () => {
        const attempt = current();
        if (!attempt || !snapshot || !deletion) return { kind: 'not_started' };
        if (attempt.state === 'legacy_deleted') return progress();
        if (attempt.state !== 'verified' || !lineage(attempt))
          return { kind: 'unresolved' };
        let operation = attempt.deletion;
        if (!operation) {
          storage.authorizeDeletion(attempt.id, attempt.epoch, randomUUID());
          operation = current()?.deletion ?? null;
        }
        if (!operation) throw new Error('No deletion authorization.');
        const authorized = operation;
        const request = { ...context(attempt), operationId: authorized.id };
        const completed = (
          receipt: Awaited<ReturnType<typeof deletion.reconcile>>,
        ): MigrationRecoveryResult => {
          live(attempt);
          if (receipt.kind === 'unavailable') return { kind: 'unavailable' };
          if (receipt.kind !== 'completed') return { kind: 'unresolved' };
          storage.deletionReceipt(
            attempt.id,
            attempt.epoch,
            receipt.operationId,
            receipt.generation,
            receipt.completionId,
          );
          return progress();
        };
        if (operation.phase === 'submitted')
          return completed(await deletion.reconcile(request));
        const result = await snapshot.withGeneration(
          source,
          async (observed): Promise<MigrationRecoveryResult | null> => {
            const latest = live(attempt);
            if (latest.state === 'legacy_deleted') return progress();
            if (!latest.deletion || latest.deletion.id !== authorized.id)
              throw new Error('Migration deletion retired.');
            // Another module may have submitted while this one waited for the queue.
            if (latest.deletion.phase === 'submitted') return null;
            if (
              observed.kind !== 'present' ||
              observed.generation !== attempt.identity.generation
            )
              return { kind: 'stale' };
            if (!lineage(attempt)) return { kind: 'unresolved' };
            storage.deletionReceipt(
              attempt.id,
              attempt.epoch,
              authorized.id,
              authorized.generation,
              null,
            );
            return completed(await deletion.remove(request));
          },
        );
        if (result !== null) return result;
        // Reconciliation owns queue acquisition; never call it while holding the queue.
        live(attempt);
        return completed(await deletion.reconcile(request));
      });
    },
    reportAmbiguity(reason): void {
      revision += 1;
      sessions.reportAmbiguity(reason);
    },
    endChannel(channel, reason): void {
      revision += 1;
      sessions.endChannel(channel, reason);
    },
    close(): void {
      closed = true;
      revision += 1;
      offerEpochs.clear();
      sessions.close();
    },
    get(sessionId): ReturnType<MigrationSessionRegistry['get']> {
      return sessions.get(sessionId);
    },
  };
}
