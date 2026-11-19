import { VaultEntryDeleteParamsSchema } from '@canopy/protocol/canopy-core';

import type {
  VaultDeleteOutcome,
  VaultDeleteRequest,
  VaultMutationStep,
  VaultNotFound,
  VaultSecretRef,
} from '../../../vault/contracts';
import { isWellFormedText } from './canonical-encoding';
import type { VaultReadView, VaultViewEntry } from './read-view';
import { vaultDeleteReceipt, vaultDeleteReceiptMatches } from './receipts';
import {
  vaultIoClass,
  vaultStoreUnavailableOutcome,
  type VaultStore,
} from './store';
import { refuseVaultWrite, type VaultWriteRefusal } from './write-refusal';

/*
 * `delete` on the durable store (CAN-4500 unit D2), in this synchronous order:
 * validate, close admission, write the delete intent, then the hold point,
 * and the tombstone after it. Nothing here needs the vault key: the receipt
 * is a keyless hash and the tombstone carries no secret. An accepted delete
 * supersedes every put and earlier delete on its entry that has not
 * committed. On a reopened store, unit E writes each accepted intent an
 * uncertain write lost, and `reconcile` applies tombstones that landed.
 */

/** The check that refused a delete, in reporting order. */
export type VaultDeleteRefusalStep =
  | 'validation'
  | 'managed_family'
  | 'not_found'
  | 'idempotency'
  | 'revision'
  /** The delete intent was not written; the entry stays closed in-process. */
  | 'intent';

export interface VaultDeleteHooks {
  /** Test seam: awaited at each delete's hold point, after its intent is durable. */
  readonly holdDelete?: (sequence: number) => Promise<void>;
  /** Observes every refused delete; it cannot change the outcome. */
  readonly onDeleteRefused?: (
    refusal: VaultWriteRefusal<VaultDeleteRefusalStep>,
  ) => void;
}

/**
 * The delete that superseded a write, whose intent may still be lost; null
 * when the store's records show the supersession.
 */
type VaultSupersession = { readonly sequence: number | null } | null;

/** The put path's side of the keys and entries both paths share. */
interface VaultDeletePuts {
  /** True when the receipt key names an accepted put. */
  hasKey(key: string): boolean;
  /** Fences every put on the entry that has not committed. */
  supersede(entryId: string, by: VaultSupersession): void;
}

interface VaultDeletePathOptions extends VaultDeleteHooks {
  readonly view: VaultReadView;
  readonly store: VaultStore;
  readonly receiptKey: (family: string, idempotencyKey: string) => string;
  /** Reopens a faulted store and writes lost delete intents; never throws. */
  readonly recover: () => void;
  readonly puts: VaultDeletePuts;
}

interface VaultDeletePath {
  /** True when the receipt key names an accepted delete. */
  hasKey(key: string): boolean;
  delete(
    family: string,
    request: VaultDeleteRequest,
  ): Promise<VaultDeleteOutcome>;
  /** Writes each accepted intent an uncertain write lost, on an open store. */
  recordUnrecorded(): void;
  /** Settles each uncertain tombstone from the records, as a restart would. */
  reconcile(): void;
}

interface DeleteInput {
  readonly ref: VaultSecretRef;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

type Retained =
  | {
      readonly kind: 'in_flight';
      readonly settled: Promise<VaultDeleteOutcome>;
    }
  | { readonly kind: 'committed'; readonly tombstoneRevision: number }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'outcome_unknown' }
  | { readonly kind: 'superseded' };

/** An accepted delete key and the outcome it replays. */
interface DeleteReceipt {
  readonly family: string;
  readonly idempotencyKey: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly hash: Uint8Array;
  /** Null while the intent write is uncertain, until a reopened store shows it. */
  sequence: number | null;
  /** Set once a later accepted delete owns the entry. */
  superseded: boolean;
  /** The first delete that superseded it. */
  supersededBy: VaultSupersession;
  /** Set while its tombstone write was uncertain and nothing has settled it. */
  tombstoneUncertain: boolean;
  outcome: Retained;
}

/** Reads each request field once; anything outside its bounds is a TypeError. */
function snapshotDelete(request: VaultDeleteRequest): DeleteInput {
  const { idempotencyKey, ...params } = request;
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 512 ||
    !isWellFormedText(idempotencyKey)
  )
    throw new TypeError('Invalid vault delete.');
  const parsed = VaultEntryDeleteParamsSchema.safeParse(params);
  if (!parsed.success || !isWellFormedText(parsed.data.ref.entryId))
    throw new TypeError('Invalid vault delete.');
  const { ref, expectedRevision } = parsed.data;
  return {
    ref: { vaultId: ref.vaultId, entryId: ref.entryId },
    expectedRevision,
    idempotencyKey,
  };
}

function toTypeError(error: unknown): TypeError {
  return error instanceof TypeError
    ? error
    : new TypeError('Invalid vault delete.');
}

// At open, the latest pending delete on a live entry did not commit and
// retains `unavailable`; any other pending one was superseded.
function replayedReceipts(
  view: VaultReadView,
  receiptKey: VaultDeletePathOptions['receiptKey'],
): Map<string, DeleteReceipt> {
  const deletes = view.intents.filter((intent) => intent.kind === 'delete');
  const removed = new Set(view.deleted);
  const latest = new Map<string, number>();
  for (const intent of deletes) {
    if (intent.state === 'committed') removed.add(intent.entryId);
    const previous = latest.get(intent.entryId) ?? 0;
    latest.set(intent.entryId, Math.max(previous, intent.sequence));
  }
  const receipts = new Map<string, DeleteReceipt>();
  for (const intent of deletes) {
    let outcome: Retained = { kind: 'superseded' };
    if (intent.state === 'committed')
      outcome =
        intent.outcomeRevision === null
          ? { kind: 'outcome_unknown' }
          : { kind: 'committed', tombstoneRevision: intent.outcomeRevision };
    else if (
      !removed.has(intent.entryId) &&
      latest.get(intent.entryId) === intent.sequence
    )
      outcome = { kind: 'unavailable' };
    receipts.set(receiptKey(intent.family, intent.idempotencyKey), {
      family: intent.family,
      idempotencyKey: intent.idempotencyKey,
      entryId: intent.entryId,
      expectedRevision: intent.expectedRevision ?? 0,
      hash: intent.receipt,
      sequence: intent.sequence,
      superseded: outcome.kind === 'superseded',
      supersededBy: null,
      tombstoneUncertain: false,
      outcome,
    });
  }
  return receipts;
}

export function createVaultDeletePath(
  options: VaultDeletePathOptions,
): VaultDeletePath {
  const { view, store, receiptKey, recover, puts } = options;
  const { vaultId, entries, deleted } = view;
  const hold = options.holdDelete ?? ((): Promise<void> => Promise.resolve());
  /** By family and key, like put receipts. */
  const receipts = replayedReceipts(view, receiptKey);
  /** Accepted deletes whose intent write was uncertain and is not yet found. */
  const lost = new Set<DeleteReceipt>();

  function refOf(entryId: string): VaultSecretRef {
    return { vaultId, entryId };
  }

  function isRecorded(entryId: string): boolean {
    return !Array.from(lost).some((receipt) => receipt.entryId === entryId);
  }

  // Final only once its own intent and the delete that superseded it are
  // durable, so a restart cannot revive it; until then nothing knows.
  function reportSuperseded(receipt: DeleteReceipt): VaultDeleteOutcome {
    recover();
    const by = receipt.supersededBy;
    const final =
      receipt.sequence !== null && (by === null || by.sequence !== null);
    return {
      kind: final ? 'superseded' : 'outcome_unknown',
      ref: refOf(receipt.entryId),
    };
  }

  function notAccepted(
    step: VaultDeleteRefusalStep,
    result: VaultDeleteOutcome | TypeError,
  ): Promise<VaultDeleteOutcome> {
    return refuseVaultWrite(
      options.onDeleteRefused,
      step,
      { closure: null, material: null },
      result,
    );
  }

  function find(ref: VaultSecretRef): VaultViewEntry | VaultNotFound {
    if (ref.vaultId !== vaultId)
      return { kind: 'not_found', reason: 'foreign_vault' };
    return (
      entries.get(ref.entryId) ?? {
        kind: 'not_found',
        reason: deleted.has(ref.entryId) ? 'deleted' : 'absent',
      }
    );
  }

  function retainedOutcome(
    receipt: DeleteReceipt,
    outcome: Exclude<Retained, { kind: 'in_flight' }>,
  ): VaultDeleteOutcome {
    if (outcome.kind === 'superseded') return reportSuperseded(receipt);
    const ref = refOf(receipt.entryId);
    return outcome.kind === 'committed'
      ? { kind: 'committed', ref, tombstoneRevision: outcome.tombstoneRevision }
      : { kind: outcome.kind, ref };
  }

  function retain(outcome: VaultDeleteOutcome): Retained {
    switch (outcome.kind) {
      case 'committed':
        return {
          kind: 'committed',
          tombstoneRevision: outcome.tombstoneRevision,
        };
      case 'outcome_unknown':
      case 'superseded':
        return { kind: outcome.kind };
      default:
        return { kind: 'unavailable' };
    }
  }

  /**
   * Fences every earlier delete on the entry that has not committed. One
   * whose uncertain tombstone may have landed stays unknown, since a restart
   * replays a landed one `committed`; `reconcile` settles it.
   */
  function supersede(entryId: string, by: VaultSupersession): void {
    receipts.forEach((receipt) => {
      if (receipt.entryId !== entryId || receipt.outcome.kind === 'committed')
        return;
      if (!receipt.superseded) receipt.supersededBy = by;
      receipt.superseded = true;
      if (receipt.outcome.kind !== 'in_flight' && !receipt.tombstoneUncertain)
        receipt.outcome = { kind: 'superseded' };
    });
    puts.supersede(entryId, by);
  }

  function tombstone(
    receipt: DeleteReceipt,
    sequence: number,
  ): VaultDeleteOutcome {
    const { entryId } = receipt;
    const ref = refOf(entryId);
    const tombstoneRevision = receipt.expectedRevision + 1;
    // The store erases the entry's row, ciphertext included, in this transaction.
    const written = store.commitTombstone(sequence, tombstoneRevision);
    if (written.kind === 'uncertain') {
      receipt.tombstoneUncertain = true;
      return { kind: 'outcome_unknown', ref };
    }
    if (written.kind !== 'written')
      return vaultStoreUnavailableOutcome(ref, written);
    entries.delete(entryId);
    deleted.add(entryId);
    return { kind: 'committed', ref, tombstoneRevision };
  }

  /** The hold point, then the tombstone, unless a later delete owns the entry. */
  async function commit(
    receipt: DeleteReceipt,
    sequence: number,
  ): Promise<VaultDeleteOutcome> {
    const ref = refOf(receipt.entryId);
    let step: VaultMutationStep = 'hold';
    store.setIntentRunning(sequence, true);
    try {
      await hold(sequence);
      if (receipt.superseded) return { kind: 'superseded', ref };
      step = 'apply';
      return tombstone(receipt, sequence);
    } catch (error) {
      return { kind: 'unavailable', ref, step, io: vaultIoClass(error) };
    } finally {
      store.setIntentRunning(sequence, false);
    }
  }

  function run(
    receipt: DeleteReceipt,
    sequence: number,
  ): Promise<VaultDeleteOutcome> {
    const settled = commit(receipt, sequence).then((result) => {
      // Once a later delete is accepted, even mid-settlement, only a commit stands.
      const outcome: VaultDeleteOutcome =
        receipt.superseded &&
        result.kind !== 'committed' &&
        !receipt.tombstoneUncertain
          ? { kind: 'superseded', ref: refOf(receipt.entryId) }
          : result;
      receipt.outcome = retain(outcome);
      return outcome.kind === 'superseded'
        ? reportSuperseded(receipt)
        : outcome;
    });
    receipt.outcome = { kind: 'in_flight', settled };
    return settled.then((outcome) => structuredClone(outcome));
  }

  /** A same-key delete: join, replay, or re-attempt a retained `unavailable`. */
  function replay(
    receipt: DeleteReceipt,
    input: DeleteInput,
    found: VaultViewEntry | VaultNotFound,
  ): Promise<VaultDeleteOutcome> {
    if (
      input.ref.vaultId !== vaultId ||
      !vaultDeleteReceiptMatches(
        { ref: input.ref, expectedRevision: input.expectedRevision },
        receipt.hash,
      )
    )
      return notAccepted('idempotency', { kind: 'idempotency_conflict' });
    const { outcome } = receipt;
    if (outcome.kind === 'in_flight')
      return outcome.settled.then((settled) => structuredClone(settled));
    if (outcome.kind !== 'unavailable' || receipt.sequence === null)
      return Promise.resolve(retainedOutcome(receipt, outcome));
    // The re-attempt reuses its durable intent, so it is never closure_unrecorded.
    if (!('closure' in found)) return notAccepted('not_found', found);
    if (found.revision !== receipt.expectedRevision)
      return notAccepted('revision', {
        kind: 'revision_conflict',
        currentRevision: found.revision,
      });
    found.closure = 'delete_pending';
    return run(receipt, receipt.sequence);
  }

  /** A delete under a key this family never accepted. */
  function accept(
    family: string,
    input: DeleteInput,
    entry: VaultViewEntry,
  ): Promise<VaultDeleteOutcome> {
    if (entry.revision !== input.expectedRevision)
      return notAccepted('revision', {
        kind: 'revision_conflict',
        currentRevision: entry.revision,
      });
    if (!Number.isSafeInteger(input.expectedRevision + 1))
      return notAccepted(
        'revision',
        new TypeError('Vault revision exhausted.'),
      );
    const hash = vaultDeleteReceipt({
      ref: input.ref,
      expectedRevision: input.expectedRevision,
    });
    // Fails closed: from here on, a refusal leaves the entry closed for the
    // rest of the process's life.
    entry.closure = 'delete_pending';
    const unrecorded: VaultDeleteOutcome = {
      kind: 'refused',
      reason: 'closure_unrecorded',
    };
    let sequence: number | null;
    try {
      recover();
      // A restart orders deletes by sequence, so a lost earlier intent must
      // land before this one does.
      if (!isRecorded(entry.entryId)) return notAccepted('intent', unrecorded);
      const written = store.recordIntent({
        kind: 'delete',
        family,
        idempotencyKey: input.idempotencyKey,
        entryId: entry.entryId,
        expectedRevision: input.expectedRevision,
        receipt: hash,
      });
      if (written.kind === 'not_written')
        return notAccepted('intent', unrecorded);
      sequence = written.kind === 'written' ? written.value.sequence : null;
    } catch {
      return notAccepted('intent', unrecorded);
    }
    const receipt: DeleteReceipt = {
      family,
      idempotencyKey: input.idempotencyKey,
      entryId: entry.entryId,
      expectedRevision: input.expectedRevision,
      hash,
      sequence,
      superseded: false,
      supersededBy: null,
      tombstoneUncertain: false,
      outcome: { kind: 'outcome_unknown' },
    };
    supersede(entry.entryId, receipt);
    receipts.set(receiptKey(family, input.idempotencyKey), receipt);
    // The intent may have landed: the entry stays closed until reconciliation.
    if (sequence === null) {
      lost.add(receipt);
      return Promise.resolve({
        kind: 'outcome_unknown',
        ref: refOf(entry.entryId),
      });
    }
    return run(receipt, sequence);
  }

  /** The checks before acceptance, in the contract's reporting order. */
  function route(
    family: string,
    input: DeleteInput,
  ): Promise<VaultDeleteOutcome> {
    const found = find(input.ref);
    if ('closure' in found && found.family !== family)
      return notAccepted('managed_family', {
        kind: 'refused',
        reason: 'managed_family',
      });
    const key = receiptKey(family, input.idempotencyKey);
    if (puts.hasKey(key))
      return notAccepted('idempotency', { kind: 'idempotency_conflict' });
    const receipt = receipts.get(key);
    if (receipt) return replay(receipt, input, found);
    if (!('closure' in found)) return notAccepted('not_found', found);
    return accept(family, input, found);
  }

  // A lost intent written late still follows every put its delete
  // superseded, so that supersession survives a restart.
  function recordUnrecorded(): void {
    for (const receipt of Array.from(lost)) {
      if (store.state !== 'open') return;
      const landed = store.findIntent(receipt.family, receipt.idempotencyKey);
      let sequence: number | null = null;
      if (landed !== null) {
        if (landed.kind === 'delete' && landed.entryId === receipt.entryId)
          sequence = landed.sequence;
      } else {
        const written = store.recordIntent({
          kind: 'delete',
          family: receipt.family,
          idempotencyKey: receipt.idempotencyKey,
          entryId: receipt.entryId,
          expectedRevision: receipt.expectedRevision,
          receipt: receipt.hash,
        });
        if (written.kind === 'written') sequence = written.value.sequence;
      }
      if (sequence === null) continue;
      receipt.sequence = sequence;
      lost.delete(receipt);
    }
  }

  // A superseded delete is settled here only when its tombstone was uncertain:
  // landed, a restart replays it `committed`; still pending, `superseded`.
  function reconcile(): void {
    receipts.forEach((receipt) => {
      const { sequence } = receipt;
      if (
        receipt.outcome.kind !== 'outcome_unknown' ||
        (receipt.superseded && !receipt.tombstoneUncertain) ||
        sequence === null
      )
        return;
      const intent = store.findIntent(receipt.family, receipt.idempotencyKey);
      if (intent?.sequence !== sequence) return;
      const revision = intent.outcomeRevision;
      if (revision === null) {
        if (receipt.superseded && intent.state === 'pending') {
          receipt.tombstoneUncertain = false;
          receipt.outcome = { kind: 'superseded' };
        }
        return;
      }
      // A restart reads only the intent; retention may already have pruned
      // the tombstone if this delete was still settling at an earlier reconcile.
      const tombstone = store.readTombstone(receipt.entryId);
      if (tombstone !== null && tombstone.sequence !== sequence) return;
      entries.delete(receipt.entryId);
      if (tombstone !== null) deleted.add(receipt.entryId);
      receipt.tombstoneUncertain = false;
      receipt.outcome = { kind: 'committed', tombstoneRevision: revision };
      supersede(receipt.entryId, null);
    });
    // An uncertain tombstone that landed before a later delete superseded it
    // still erased the entry: nothing else on it can commit, as after a restart.
    receipts.forEach((receipt) => {
      const { entryId } = receipt;
      if (deleted.has(entryId) || store.readTombstone(entryId) === null) return;
      entries.delete(entryId);
      deleted.add(entryId);
      supersede(entryId, null);
    });
  }

  return {
    hasKey: (key) => receipts.has(key),
    recordUnrecorded,
    reconcile,
    delete(family, request): Promise<VaultDeleteOutcome> {
      let input: DeleteInput;
      try {
        input = snapshotDelete(request);
      } catch (error) {
        return notAccepted('validation', toTypeError(error));
      }
      try {
        return route(family, input);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error('Vault delete failed.'),
        );
      }
    },
  };
}
