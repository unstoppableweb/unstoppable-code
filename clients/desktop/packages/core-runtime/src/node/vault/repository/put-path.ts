import { randomUUID } from 'node:crypto';

import {
  VaultEntryPutParamsSchema,
  VaultFamilySchema,
} from '@canopy/protocol/canopy-core';

import type {
  VaultDeleteRequest,
  VaultFamilyWriter,
  VaultMutationStep,
  VaultNotFound,
  VaultPutOutcome,
  VaultPutRequest,
  VaultSecretRef,
} from '../../../vault/contracts';
import { isWellFormedText } from './canonical-encoding';
import { createVaultDeletePath, type VaultDeleteHooks } from './delete-path';
import type { VaultKeyHolder } from './key-holder';
import {
  committedEntry,
  type VaultReadView,
  type VaultViewEntry,
} from './read-view';
import {
  vaultPutReceipt,
  vaultPutReceiptMatches,
  type VaultPutReceiptParams,
} from './receipts';
import { isSupersededCommit, pruneExpiredTombstones } from './reconciliation';
import { VAULT_SECRET_MAX_BYTES } from './record-format';
import { sealVaultSecret } from './sealed-secret';
import {
  vaultIoClass,
  vaultStoreUnavailableOutcome,
  type VaultMigrationUpdate,
  type VaultStore,
} from './store';
import type { VaultIntentDraft } from './store-records';
import type { VaultSubkeys } from './vault-keys';
import {
  refuseVaultWrite,
  type VaultClosure,
  type VaultWriteRefusal,
} from './write-refusal';
import { zeroBytes } from './zero-bytes';

/*
 * `put` on the durable store (CAN-4500 unit D1), in this synchronous order:
 * validate, close admission, write the put intent, then the hold point, and
 * seal and commit after it. Every check before the intent commits refuses
 * through `notAccepted`. `put` never calls the key-slot backend. The family
 * writer pairs it with the delete path (unit D2), which shares its keys.
 * Unit E adds `reconcile`, with tombstone retention, and reopens a faulted
 * store before a new intent.
 */

/** The check that refused a put, in reporting order. */
export type VaultPutRefusalStep =
  | 'validation'
  | 'managed_family'
  | 'not_found'
  | 'idempotency'
  | 'entry_closed'
  | 'revision'
  /** The vault key is not held. */
  | 'key'
  | 'corrupt'
  /** The put intent was not written. */
  | 'intent';

export interface VaultPutHooks {
  /** Qualification binding admission, including same-key retries. */
  readonly migrationAdmission?: (family: string, key: string) => void;
  /** Internal inert seam: attach authenticated provenance to the minted intent. */
  readonly migrationIntent?: (
    draft: VaultIntentDraft,
  ) => VaultMigrationUpdate | undefined;
  /** Test seam: awaited at each put's hold point, after its intent is durable. */
  readonly holdPut?: (sequence: number) => Promise<void>;
  /** Observes every refused put; it cannot change the outcome. */
  readonly onPutRefused?: (
    refusal: VaultWriteRefusal<VaultPutRefusalStep>,
  ) => void;
}

interface VaultPutPathOptions extends VaultPutHooks, VaultDeleteHooks {
  readonly view: VaultReadView;
  readonly holder: VaultKeyHolder;
  readonly store: VaultStore;
  readonly clock: () => Date;
  /** The cached tag check of an entry's committed revision. */
  readonly isCorrupt: (entry: VaultViewEntry, keys: VaultSubkeys) => boolean;
}

/** A validated snapshot; `material` is the put's own copy, zeroed when it ends. */
interface PutInput {
  /** Null for a replace. */
  readonly family: string | null;
  /** Null for a create. */
  readonly ref: VaultSecretRef | null;
  readonly expectedRevision: number | null;
  readonly label: string;
  readonly expiresAt: string | null;
  readonly idempotencyKey: string;
  readonly material: Uint8Array;
}

type Retained =
  | { readonly kind: 'in_flight'; readonly settled: Promise<VaultPutOutcome> }
  | { readonly kind: 'committed'; readonly revision: number }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'outcome_unknown' }
  | { readonly kind: 'superseded' };

/** An accepted put key and the outcome it replays. */
interface PutReceipt {
  readonly family: string;
  readonly idempotencyKey: string;
  readonly entryId: string;
  readonly expectedRevision: number | null;
  readonly mac: Uint8Array;
  /** Null when the intent write itself is uncertain. */
  readonly sequence: number | null;
  /** Set once an accepted delete owns the entry. */
  superseded: boolean;
  /** The first delete that superseded it; null when the records show it. */
  supersededBy: { readonly sequence: number | null } | null;
  outcome: Retained;
}

/** Reads each request field once; anything outside its bounds is a TypeError. */
function snapshotPut(request: VaultPutRequest): PutInput {
  const { idempotencyKey, material, ...params } = request;
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 512 ||
    !isWellFormedText(idempotencyKey) ||
    !(material instanceof Uint8Array) ||
    'secret' in params
  )
    throw new TypeError('Invalid vault put.');
  const parsed = VaultEntryPutParamsSchema.safeParse({
    ...params,
    secret: 'validated',
  });
  if (!parsed.success || !isWellFormedText(parsed.data.label))
    throw new TypeError('Invalid vault put.');
  const fields = parsed.data;
  if ('ref' in fields && !isWellFormedText(fields.ref.entryId))
    throw new TypeError('Invalid vault put.');
  const copy = new Uint8Array(material);
  if (copy.byteLength < 1 || copy.byteLength > VAULT_SECRET_MAX_BYTES) {
    zeroBytes(copy);
    throw new TypeError(
      `Vault secrets must be 1-${VAULT_SECRET_MAX_BYTES} bytes.`,
    );
  }
  return {
    family: 'ref' in fields ? null : fields.family,
    ref: 'ref' in fields ? { ...fields.ref } : null,
    expectedRevision: fields.expectedRevision,
    label: fields.label,
    expiresAt: fields.expiresAt,
    idempotencyKey,
    material: copy,
  };
}

function toTypeError(error: unknown): TypeError {
  return error instanceof TypeError
    ? error
    : new TypeError('Invalid vault put.');
}

interface VaultWritePath {
  writer(family: string): VaultFamilyWriter;
  reconcile(): void;
}

/** Mints each family's writer: put here, delete through the delete path. */
export function createVaultWritePath(
  options: VaultPutPathOptions,
): VaultWritePath {
  const { view, holder, store, clock, isCorrupt } = options;
  const { vaultId, entries, deleted } = view;
  const hold = options.holdPut ?? ((): Promise<void> => Promise.resolve());
  /** By family and key; put and delete share each family's keys. */
  const receipts = new Map<string, PutReceipt>();
  /** The put that holds each entry closed in this process. */
  const closedBy = new Map<string, PutReceipt>();
  /** Every entry ID the store has seen, so a minted ID is never reissued. */
  const issued = new Set<string>(Array.from(entries.keys()));
  deleted.forEach((entryId) => issued.add(entryId));

  function receiptKey(family: string, idempotencyKey: string): string {
    return JSON.stringify([family, idempotencyKey]);
  }

  // A pending put that the reopened store holds did not commit: it retains
  // `unavailable`, unless a delete was accepted after it. So does a commit
  // that landed while a delete superseded it (unit E).
  const deleteTargets = new Set(deleted);
  for (const intent of view.intents)
    if (intent.kind === 'delete') deleteTargets.add(intent.entryId);
  for (const intent of view.intents) {
    issued.add(intent.entryId);
    if (intent.kind === 'delete') continue;
    let outcome: Retained = { kind: 'unavailable' };
    if (isSupersededCommit(intent, view.intents))
      outcome = { kind: 'superseded' };
    else if (intent.state === 'committed')
      outcome =
        intent.outcomeRevision === null
          ? { kind: 'outcome_unknown' }
          : { kind: 'committed', revision: intent.outcomeRevision };
    else if (deleteTargets.has(intent.entryId))
      outcome = { kind: 'superseded' };
    receipts.set(receiptKey(intent.family, intent.idempotencyKey), {
      family: intent.family,
      idempotencyKey: intent.idempotencyKey,
      entryId: intent.entryId,
      expectedRevision: intent.expectedRevision,
      mac: intent.receipt,
      sequence: intent.sequence,
      superseded: outcome.kind === 'superseded',
      supersededBy: null,
      outcome,
    });
  }

  // A create's uncertain commit that landed is at the revision its delete
  // expected, so a restart replays it `committed`: it stays unknown here.
  function staysUnknown(
    receipt: PutReceipt,
    kind: Retained['kind'] | VaultPutOutcome['kind'],
  ): boolean {
    return receipt.expectedRevision === null && kind === 'outcome_unknown';
  }

  const deletes = createVaultDeletePath({
    view,
    store,
    receiptKey,
    recover,
    holdDelete: options.holdDelete,
    onDeleteRefused: options.onDeleteRefused,
    puts: {
      hasKey: (key) => receipts.has(key),
      supersede(entryId, by): void {
        receipts.forEach((receipt) => {
          const { kind } = receipt.outcome;
          if (receipt.entryId !== entryId || kind === 'committed') return;
          if (!receipt.superseded) receipt.supersededBy = by;
          receipt.superseded = true;
          if (kind !== 'in_flight' && !staysUnknown(receipt, kind))
            receipt.outcome = { kind: 'superseded' };
        });
      },
    },
  });

  /**
   * Reopens a faulted store before a new intent is written, so one uncertain
   * write does not refuse every later write in the process, then writes each
   * delete intent an uncertain write lost. Promoting what that write left is
   * `reconcile`'s.
   */
  function recover(): void {
    if (store.state === 'faulted') store.reopen();
    if (store.state !== 'open') return;
    try {
      deletes.recordUnrecorded();
    } catch {
      // A malformed row leaves each lost intent for the next attempt.
    }
  }

  // Final only once its own intent and the delete that superseded it are
  // durable, so a restart cannot revive it; until then nothing knows. A lost
  // put intent is never written again, so its put stays unknown.
  function reportSuperseded(receipt: PutReceipt): VaultPutOutcome {
    recover();
    const by = receipt.supersededBy;
    const final =
      receipt.sequence !== null && (by === null || by.sequence !== null);
    return {
      kind: final ? 'superseded' : 'outcome_unknown',
      ref: refOf(receipt.entryId),
    };
  }

  /** Commits an applied uncertain put; anything else keeps its outcome. */
  function promote(receipt: PutReceipt): void {
    const intent = store.findIntent(receipt.family, receipt.idempotencyKey);
    const revision = intent?.outcomeRevision ?? null;
    if (intent?.sequence !== receipt.sequence || revision === null) return;
    const row = store.readEntry(receipt.entryId);
    if (row?.revision !== revision) return;
    const next = committedEntry(vaultId, row);
    if (entries.get(receipt.entryId)?.closure === 'delete_pending')
      next.closure = 'delete_pending';
    entries.set(receipt.entryId, next);
    if (closedBy.get(receipt.entryId) === receipt)
      closedBy.delete(receipt.entryId);
    receipt.outcome = { kind: 'committed', revision };
  }

  /** Retention without a restart; receipts are untouched, so keys replay. */
  function expireTombstones(): void {
    const expired = pruneExpiredTombstones(store, clock());
    // An uncertain prune faults the store; reopening shows what it removed.
    recover();
    if (store.state !== 'open') return;
    for (const entryId of expired) {
      if (store.readTombstone(entryId) !== null) continue;
      deleted.delete(entryId);
      entries.delete(entryId);
    }
  }

  /**
   * Trusted in-process reconciliation (unit E): reopens a faulted store,
   * promotes each uncertain write that landed and nothing superseded, then
   * prunes expired tombstones. One that did not land stays `outcome_unknown`
   * and closed until a restart.
   */
  function reconcile(): void {
    recover();
    if (store.state !== 'open') return;
    receipts.forEach((receipt) => {
      if (receipt.outcome.kind === 'outcome_unknown' && !receipt.superseded)
        promote(receipt);
    });
    deletes.reconcile();
    expireTombstones();
  }

  function now(): string {
    return clock().toISOString();
  }

  function refOf(entryId: string): VaultSecretRef {
    return { vaultId, entryId };
  }

  function notAccepted(
    step: VaultPutRefusalStep,
    input: PutInput | null,
    closure: VaultClosure | null,
    result: VaultPutOutcome | TypeError,
  ): Promise<VaultPutOutcome> {
    return refuseVaultWrite(
      options.onPutRefused,
      step,
      { closure, material: input?.material ?? null },
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

  // A put pending, in flight or uncertain, or any delete, holds its entry
  // closed; only an unavailable put lets another through.
  function isClosed(entry: VaultViewEntry): boolean {
    if (entry.closure === 'delete_pending') return true;
    if (entry.closure !== 'put_pending') return false;
    const kind = closedBy.get(entry.entryId)?.outcome.kind ?? 'unavailable';
    return kind !== 'unavailable';
  }

  function blockReason(): Extract<VaultPutOutcome, { kind: 'blocked' }> {
    return { kind: 'blocked', reason: holder.entryBlock() ?? 'unavailable' };
  }

  function retainedOutcome(
    receipt: PutReceipt,
    outcome: Exclude<Retained, { kind: 'in_flight' }>,
  ): VaultPutOutcome {
    if (outcome.kind === 'superseded') return reportSuperseded(receipt);
    const ref = refOf(receipt.entryId);
    return outcome.kind === 'committed'
      ? { kind: 'committed', pin: { ref, revision: outcome.revision } }
      : { kind: outcome.kind, ref };
  }

  function receiptParams(
    family: string,
    input: PutInput,
  ): VaultPutReceiptParams {
    return {
      vaultId,
      family,
      entryId: input.ref?.entryId ?? null,
      expectedRevision: input.expectedRevision,
      label: input.label,
      expiresAt: input.expiresAt,
      idempotencyKey: input.idempotencyKey,
      material: input.material,
    };
  }

  // The non-secret fields the intent stores; the MAC covers the rest.
  function sameTarget(receipt: PutReceipt, input: PutInput): boolean {
    if (input.ref === null) return receipt.expectedRevision === null;
    return (
      input.ref.vaultId === vaultId &&
      input.ref.entryId === receipt.entryId &&
      input.expectedRevision === receipt.expectedRevision
    );
  }

  /** Closes admission synchronously, before the intent is written. */
  function close(
    family: string,
    input: PutInput,
    entry: VaultViewEntry | null,
    entryId: string,
  ): VaultClosure {
    if (entry === null) {
      const at = now();
      entries.set(entryId, {
        entryId,
        family,
        revision: 0,
        label: input.label,
        expiresAt: input.expiresAt,
        createdAt: at,
        updatedAt: at,
        record: null,
        listed: true,
        closure: 'put_pending',
        verification: null,
      });
      return { reopen: () => void entries.delete(entryId) };
    }
    const previous = entry.closure;
    entry.closure = 'put_pending';
    return {
      reopen: (): void => {
        entry.closure = previous;
      },
    };
  }

  function mint(): string {
    let entryId = randomUUID();
    while (issued.has(entryId)) entryId = randomUUID();
    issued.add(entryId);
    return entryId;
  }

  function seal(
    family: string,
    receipt: PutReceipt,
    sequence: number,
    revision: number,
    input: PutInput,
  ): VaultPutOutcome {
    const { entryId } = receipt;
    const ref = refOf(entryId);
    const keys = holder.keys();
    if (keys === null) return { kind: 'unavailable', ref };
    const fields = {
      entryId,
      family,
      revision,
      expiresAt: input.expiresAt,
      label: input.label,
    };
    const sealed = sealVaultSecret(
      keys,
      { vaultId, ...fields },
      input.material,
    );
    const written = store.commitEntry(sequence, { ...fields, sealed });
    if (written.kind === 'uncertain') return { kind: 'outcome_unknown', ref };
    if (written.kind !== 'written')
      return vaultStoreUnavailableOutcome(ref, written);
    const next = committedEntry(vaultId, written.value);
    // An accepted delete superseded this put already, so a delete closure here
    // is one that failed closed; the commit does not reopen it.
    if (entries.get(entryId)?.closure === 'delete_pending')
      next.closure = 'delete_pending';
    entries.set(entryId, next);
    closedBy.delete(entryId);
    return { kind: 'committed', pin: { ref, revision } };
  }

  /** The hold point, then seal and commit, unless a delete superseded it. */
  async function commit(
    family: string,
    receipt: PutReceipt,
    sequence: number,
    revision: number,
    input: PutInput,
  ): Promise<VaultPutOutcome> {
    const ref = refOf(receipt.entryId);
    let step: VaultMutationStep = 'hold';
    store.setIntentRunning(sequence, true);
    try {
      await hold(sequence);
      if (receipt.superseded) return { kind: 'superseded', ref };
      step = 'apply';
      return seal(family, receipt, sequence, revision, input);
    } catch (error) {
      return { kind: 'unavailable', ref, step, io: vaultIoClass(error) };
    } finally {
      store.setIntentRunning(sequence, false);
      zeroBytes(input.material);
    }
  }

  function retain(outcome: VaultPutOutcome): Retained {
    switch (outcome.kind) {
      case 'committed':
        return { kind: 'committed', revision: outcome.pin.revision };
      case 'outcome_unknown':
      case 'superseded':
        return { kind: outcome.kind };
      default:
        return { kind: 'unavailable' };
    }
  }

  function run(
    family: string,
    receipt: PutReceipt,
    sequence: number,
    revision: number,
    input: PutInput,
  ): Promise<VaultPutOutcome> {
    closedBy.set(receipt.entryId, receipt);
    const settled = commit(family, receipt, sequence, revision, input).then(
      (result) => {
        // Once a delete is accepted, even mid-settlement, only a commit stands.
        const outcome: VaultPutOutcome =
          receipt.superseded &&
          result.kind !== 'committed' &&
          !staysUnknown(receipt, result.kind)
            ? { kind: 'superseded', ref: refOf(receipt.entryId) }
            : result;
        receipt.outcome = retain(outcome);
        return outcome.kind === 'superseded'
          ? reportSuperseded(receipt)
          : outcome;
      },
    );
    receipt.outcome = { kind: 'in_flight', settled };
    return settled.then((outcome) => structuredClone(outcome));
  }

  /** A same-key put: join, replay, or re-attempt a retained `unavailable`. */
  function replay(
    family: string,
    receipt: PutReceipt,
    input: PutInput,
  ): Promise<VaultPutOutcome> {
    const conflict: VaultPutOutcome = { kind: 'idempotency_conflict' };
    if (!sameTarget(receipt, input))
      return notAccepted('idempotency', input, null, conflict);
    const keys = holder.keys();
    const { outcome } = receipt;
    if (keys === null) {
      // No receipt can be checked: a retry of a put in flight decides once it
      // settles. An outcome without a pin grants nothing.
      if (outcome.kind === 'in_flight')
        return outcome.settled.then(() => replay(family, receipt, input));
      if (outcome.kind === 'committed')
        return notAccepted('key', input, null, blockReason());
      zeroBytes(input.material);
      return Promise.resolve(retainedOutcome(receipt, outcome));
    }
    if (
      !vaultPutReceiptMatches(keys, receiptParams(family, input), receipt.mac)
    )
      return notAccepted('idempotency', input, null, conflict);
    if (outcome.kind === 'in_flight') {
      zeroBytes(input.material);
      return outcome.settled.then((settled) => structuredClone(settled));
    }
    if (outcome.kind !== 'unavailable' || receipt.sequence === null) {
      zeroBytes(input.material);
      return Promise.resolve(retainedOutcome(receipt, outcome));
    }
    // The re-attempt reuses its durable intent, so it is never closure_unrecorded.
    const entry = entries.get(receipt.entryId);
    if (entry === undefined || isClosed(entry))
      return notAccepted('entry_closed', input, null, {
        kind: 'refused',
        reason: 'entry_closed',
      });
    const moved =
      receipt.expectedRevision === null
        ? entry.record !== null
        : entry.revision !== receipt.expectedRevision;
    if (moved)
      return notAccepted('revision', input, null, {
        kind: 'revision_conflict',
        currentRevision: entry.revision,
      });
    close(family, input, entry, entry.entryId);
    const revision =
      receipt.expectedRevision === null ? 0 : receipt.expectedRevision + 1;
    return run(family, receipt, receipt.sequence, revision, input);
  }

  /** A put under a key this family never accepted. */
  function accept(
    family: string,
    input: PutInput,
    entry: VaultViewEntry | null,
  ): Promise<VaultPutOutcome> {
    if (entry !== null) {
      if (isClosed(entry))
        return notAccepted('entry_closed', input, null, {
          kind: 'refused',
          reason: 'entry_closed',
        });
      if (entry.revision !== input.expectedRevision)
        return notAccepted('revision', input, null, {
          kind: 'revision_conflict',
          currentRevision: entry.revision,
        });
    }
    const revision = entry === null ? 0 : entry.revision + 1;
    if (!Number.isSafeInteger(revision))
      return notAccepted(
        'revision',
        input,
        null,
        new TypeError('Vault revision exhausted.'),
      );
    const entryId = entry?.entryId ?? mint();
    const closure = close(family, input, entry, entryId);
    const unrecorded: VaultPutOutcome = {
      kind: 'refused',
      reason: 'closure_unrecorded',
    };
    let intent: { readonly mac: Uint8Array; readonly sequence: number | null };
    try {
      const keys = holder.keys();
      if (keys === null)
        return notAccepted('key', input, closure, blockReason());
      if (entry !== null && isCorrupt(entry, keys))
        return notAccepted('corrupt', input, closure, {
          kind: 'blocked',
          reason: 'corrupt',
        });
      const mac = vaultPutReceipt(keys, receiptParams(family, input));
      recover();
      const draft: VaultIntentDraft = {
        kind: 'put',
        family,
        idempotencyKey: input.idempotencyKey,
        entryId,
        expectedRevision: input.expectedRevision,
        receipt: mac,
      };
      const written = store.recordIntent(
        draft,
        options.migrationIntent?.(draft),
      );
      if (written.kind === 'not_written')
        return notAccepted('intent', input, closure, unrecorded);
      intent = {
        mac,
        sequence: written.kind === 'written' ? written.value.sequence : null,
      };
    } catch {
      return notAccepted('intent', input, closure, unrecorded);
    }
    const receipt: PutReceipt = {
      family,
      idempotencyKey: input.idempotencyKey,
      entryId,
      expectedRevision: input.expectedRevision,
      mac: intent.mac,
      sequence: intent.sequence,
      superseded: false,
      supersededBy: null,
      outcome: { kind: 'outcome_unknown' },
    };
    receipts.set(receiptKey(family, input.idempotencyKey), receipt);
    if (receipt.sequence === null) {
      // The intent may have landed: the entry stays closed, as if committed.
      closedBy.set(entryId, receipt);
      zeroBytes(input.material);
      return Promise.resolve({ kind: 'outcome_unknown', ref: refOf(entryId) });
    }
    return run(family, receipt, receipt.sequence, revision, input);
  }

  function put(
    family: string,
    request: VaultPutRequest,
  ): Promise<VaultPutOutcome> {
    let input: PutInput;
    try {
      input = snapshotPut(request);
    } catch (error) {
      return notAccepted('validation', null, null, toTypeError(error));
    }
    try {
      options.migrationAdmission?.(family, input.idempotencyKey);
      return route(family, input);
    } catch (error) {
      zeroBytes(input.material);
      return Promise.reject(
        error instanceof Error ? error : new Error('Vault put failed.'),
      );
    }
  }

  /** The checks before acceptance, in the contract's reporting order. */
  function route(family: string, input: PutInput): Promise<VaultPutOutcome> {
    const found = input.ref === null ? null : find(input.ref);
    const entry = found !== null && 'closure' in found ? found : null;
    if (
      (input.family !== null && input.family !== family) ||
      (entry !== null && entry.family !== family)
    )
      return notAccepted('managed_family', input, null, {
        kind: 'refused',
        reason: 'managed_family',
      });
    const key = receiptKey(family, input.idempotencyKey);
    if (deletes.hasKey(key))
      return notAccepted('idempotency', input, null, {
        kind: 'idempotency_conflict',
      });
    const receipt = receipts.get(key);
    if (receipt) return replay(family, receipt, input);
    if (found !== null && !('closure' in found))
      return notAccepted('not_found', input, null, found);
    return accept(family, input, entry);
  }

  return {
    writer(family: string): VaultFamilyWriter {
      VaultFamilySchema.parse(family);
      return Object.freeze({
        family,
        put: (request: VaultPutRequest): Promise<VaultPutOutcome> =>
          put(family, request),
        delete: (request: VaultDeleteRequest) =>
          deletes.delete(family, request),
      });
    },
    reconcile,
  };
}
