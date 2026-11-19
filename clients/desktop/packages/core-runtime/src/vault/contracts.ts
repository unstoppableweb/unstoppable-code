import type {
  VaultEntryMetadata,
  VaultRevision,
  VaultSecretPin,
  VaultSecretRef,
  VaultStatusGetResult,
} from '@canopy/protocol/canopy-core';

export type {
  VaultEntryMetadata,
  VaultRevision,
  VaultSecretPin,
  VaultSecretRef,
} from '@canopy/protocol/canopy-core';

// V0 repository contract. V1 supplies durability/reconciliation;
// V6 supplies trusted daemon composition. This is not a grant or migration API.
export type VaultBlockReason =
  | 'locked'
  | 'denied'
  | 'unavailable'
  | 'corrupt'
  | 'key_missing'
  | 'expired';

export type VaultAdmission =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'unconfirmed' }
  | { readonly kind: 'blocked'; readonly reason: VaultBlockReason };

export type VaultNotFound = {
  readonly kind: 'not_found';
  readonly reason: 'absent' | 'deleted' | 'foreign_vault';
};

export type VaultReadOutcome =
  | {
      readonly kind: 'available';
      readonly pin: VaultSecretPin;
      /** A fresh copy, owned and zeroed after use by the consumer. */
      readonly material: Uint8Array;
    }
  | VaultNotFound
  | {
      readonly kind: 'unconfirmed';
      readonly state: 'unconfirmed' | 'delete_unconfirmed';
    }
  | { readonly kind: 'blocked'; readonly reason: VaultBlockReason };

/** Closed class of a failed storage call; never an errno string or message. */
export type VaultIoClass =
  | 'no_space'
  | 'access_denied'
  | 'not_permitted'
  | 'read_only'
  | 'io'
  | 'busy'
  | 'other';

/** Where an `unavailable` mutation failed: its hold point, apply, or a store write. */
export type VaultMutationStep = 'hold' | 'apply' | 'write';

export type VaultMutationFailure =
  | VaultNotFound
  | {
      readonly kind: 'revision_conflict';
      readonly currentRevision: VaultRevision;
    }
  | { readonly kind: 'refused'; readonly reason: 'managed_family' }
  /** Put only: not accepted; no durability work or idempotency key reservation. */
  | { readonly kind: 'refused'; readonly reason: 'entry_closed' }
  /**
   * Put or delete: not accepted, because the closure intent was not recorded.
   * No durable effect or idempotency key reservation. A put leaves admission
   * unchanged. A delete fails closed: its entry stays closed in-process (admit
   * revoked, read delete_unconfirmed) for the rest of the process's life.
   */
  | { readonly kind: 'refused'; readonly reason: 'closure_unrecorded' }
  | { readonly kind: 'idempotency_conflict' }
  /** A later accepted delete owns this entry; completion/replay cannot reopen it. */
  | { readonly kind: 'superseded'; readonly ref: VaultSecretRef }
  /** May have committed. No material or pin; only V1 reconciliation can promote it. */
  | { readonly kind: 'outcome_unknown'; readonly ref: VaultSecretRef }
  /**
   * The commit never reached the store; the closure intent is durable, so
   * admission stays closed across a restart. A same-key retry re-attempts the
   * commit once the vault key is held (a delete needs none) and no other check
   * refuses it; while the key is not held, a put's retry returns this outcome.
   */
  | {
      readonly kind: 'unavailable';
      readonly ref: VaultSecretRef;
      /** Diagnostic only, set when a storage call threw; never a branch. */
      readonly step?: VaultMutationStep;
      readonly io?: VaultIoClass;
    };

export type VaultPutOutcome =
  | { readonly kind: 'committed'; readonly pin: VaultSecretPin }
  /**
   * Not accepted: the vault key is not held (its put intent carries a keyed
   * MAC), or `corrupt` for a replace of a corrupt entry. Decided synchronously
   * before acceptance, like entry_closed; reserves nothing. Before the first
   * key-slot observation the reason is `unavailable`. Delete is never blocked.
   */
  | {
      readonly kind: 'blocked';
      readonly reason: Exclude<VaultBlockReason, 'expired'>;
    }
  | VaultMutationFailure;

export type VaultDeleteOutcome =
  | {
      readonly kind: 'committed';
      readonly ref: VaultSecretRef;
      readonly tombstoneRevision: VaultRevision;
    }
  | VaultMutationFailure;

interface VaultPutMaterial {
  readonly label: string;
  /** 1–1,000,000 bytes. The repository snapshots it before returning control. */
  readonly material: Uint8Array;
  readonly expiresAt: string | null;
  readonly idempotencyKey: string;
}

export type VaultPutRequest = VaultPutMaterial &
  (
    | {
        readonly entryId: null;
        readonly expectedRevision: null;
        readonly family: string;
      }
    | { readonly ref: VaultSecretRef; readonly expectedRevision: VaultRevision }
  );

export interface VaultDeleteRequest {
  readonly ref: VaultSecretRef;
  readonly expectedRevision: VaultRevision;
  readonly idempotencyKey: string;
}

/**
 * Read/admission view, not a writer factory. Admission is synchronous and must
 * be checked immediately before use; already copied material cannot be recalled.
 * It governs vault revisions, not tokens a consumer derives outside the vault.
 *
 * admit returns admitted exactly when get would return available at that
 * revision. Entry state precedence: unconfirmed/delete_unconfirmed first. While
 * the vault key is not held: expired if the stored date has passed (it only
 * removes access), otherwise the block reason. Once held: corrupt (tag check
 * fails), then expired, then available.
 */
export interface VaultRepository {
  get(ref: VaultSecretRef): Promise<VaultReadOutcome>;
  /** Redacted snapshots, including unconfirmed entries; never material. */
  list(): Promise<readonly VaultEntryMetadata[]>;
  admit(pin: VaultSecretPin): VaultAdmission;
  /** The last observation, synchronously; never calls or waits on the backend. */
  status(): VaultStatusGetResult;
}

/**
 * Family-scoped capability minted ONLY by trusted composition, then injected
 * into its designated domain writer. No caller-supplied writer ID, public
 * minting method or V0 family-to-writer mapping. The implementation closes over
 * the family: copying/changing this descriptive property cannot widen access.
 * A create for another family or replace/delete of another family's ref returns
 * refused{managed_family}, before admission or durability changes.
 *
 * Acceptance writes a durable closure intent synchronously, inside put/delete;
 * it survives a restart. If it cannot be written, the call is
 * refused{closure_unrecorded} before acceptance. A put while the vault key is
 * not held is blocked before acceptance; a delete needs no key.
 *
 * An accepted, CAS-matching replace/delete closes admission synchronously,
 * before the returned promise or any further durability work. No revision is
 * readable while pending. A failed/uncertain delete stays closed, across a
 * restart. An unavailable replace also stays closed, until a same-key retry
 * or new put durably confirms a successor.
 * An uncertain mutation stays unconfirmed until V1 reconciliation, never a
 * not_found/expired result and never fallback to an earlier revision.
 * A different put against a pending, uncertain or revoked entry is refused
 * with entry_closed before acceptance: no durability work, admission change
 * or idempotency key reservation. Accepted same-key retries still join/replay.
 * A CAS-matching delete also closes a pending/uncertain mutation immediately;
 * it is never refused with entry_closed. It supersedes that mutation: late
 * completion, reconciliation and same-key replay cannot publish its candidate or pin.
 * The delete's own durability outcome controls the closed entry. An unknown
 * delete needs V1 reconciliation; an unavailable delete allows a same-key
 * retry. A new create uses a new ref, never reopens the revoked ref.
 *
 * Committed means durably confirmed, not merely queued. Entry IDs are minted
 * by the store and never reissued; revisions start fresh at create. A deleted
 * ref reads deleted until V1 removes its tombstone, then absent.
 *
 * Accepted keys are scoped to this family and vault, shared by put/delete.
 * Identical retries join/replay; changed input is idempotency_conflict without effects.
 * Replay cannot reopen admission or supersede later writes. Invalid requests
 * reject with TypeError before effects (wire bounds, plus binary material).
 *
 * Every not-accepted outcome (TypeError, refused, not_found, revision_conflict,
 * idempotency_conflict, blocked) has the same effect whichever check fires: no
 * durable effect, admission change or key reservation. The one exception, a
 * delete's closure_unrecorded failing closed in-process, is reported only when
 * every other check accepts the delete. When several apply, this order decides
 * only which one is reported: validation, managed_family, not_found,
 * idempotency replay/conflict, entry_closed, revision_conflict, blocked,
 * closure_unrecorded. An accepted key replays its retained outcome even if its
 * ref now reads deleted; not_found refuses only a key never accepted. A
 * retained unavailable is re-attempted instead, unless a later accepted delete
 * superseded it; entry_closed and revision_conflict still apply, and the
 * re-attempt reuses its durable intent, so it is never closure_unrecorded.
 * While the key is not held, a put's retry returns that unavailable, never blocked.
 */
export interface VaultFamilyWriter {
  readonly family: string;
  put(request: VaultPutRequest): Promise<VaultPutOutcome>;
  delete(request: VaultDeleteRequest): Promise<VaultDeleteOutcome>;
}
