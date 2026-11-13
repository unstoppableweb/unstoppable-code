import {
  LEDGER_DEFAULT_STATUS_BY_TYPE,
  isLedgerTerminalStatus,
  type LedgerActorKind,
  type LedgerActorRef,
  type LedgerAttribution,
  type LedgerEntryType,
  type LedgerErrorReason,
  type LedgerStatus,
} from '@canopy/protocol/canopy-core';

/**
 * Pure Ledger policy: default statuses, the terminal lock, who may author and
 * own entries, and which updates are permitted. The repository applies these
 * rules inside its transaction; UI and adapters can reuse them for early
 * feedback, but the repository check is the one that counts.
 *
 * Immutability is structural: an update can change only `status`, `owner` and
 * the entry's parent.
 * Title, content, type, highlights, references, author, author details,
 * origin, attribution and `createdAt` are never rewritten, so a correction is
 * a new entry with `supersedesEntryId`.
 */

/** The only entry fields an Update may change; every other field is frozen. */
export const LEDGER_MUTABLE_ENTRY_FIELDS = [
  'status',
  'owner',
  'parentEntryId',
] as const;

// Creation statuses live with the contract, so interfaces show the default
// the repository applies.
export { LEDGER_DEFAULT_STATUS_BY_TYPE };

/** Actor kinds that may author entries through Add (tools and the user UI). */
export const LEDGER_ADD_AUTHOR_KINDS: readonly LedgerActorKind[] = [
  'user',
  'chat',
  'pipeline_agent',
  'managed_delegation',
];

/** Summary entries are authored by the generating background helper. */
export const LEDGER_SUMMARY_AUTHOR_KIND: LedgerActorKind = 'background';

export type LedgerEntryCreationPath = 'add' | 'summary';

export interface LedgerPolicyViolation {
  readonly reason: LedgerErrorReason;
  readonly field?: string;
}

export function defaultLedgerStatus(type: LedgerEntryType): LedgerStatus {
  return LEDGER_DEFAULT_STATUS_BY_TYPE[type];
}

/** Open entries accept status and owner changes; terminal entries never do. */
export function isLedgerEntryOpen(status: LedgerStatus): boolean {
  return !isLedgerTerminalStatus(status);
}

export function sameLedgerActor(
  left: LedgerActorRef,
  right: LedgerActorRef,
): boolean {
  return (
    left.actorId === right.actorId &&
    left.kind === right.kind &&
    left.authorityId === right.authorityId
  );
}

/** `ledger_sidecar` is an executor identity only, never an author or owner. */
export function canLedgerActorOwn(kind: LedgerActorKind): boolean {
  return kind !== 'ledger_sidecar';
}

export function canLedgerActorAuthor(
  kind: LedgerActorKind,
  path: LedgerEntryCreationPath,
): boolean {
  return path === 'summary'
    ? kind === LEDGER_SUMMARY_AUTHOR_KIND
    : LEDGER_ADD_AUTHOR_KINDS.includes(kind);
}

/**
 * Resolves the creation status. SUMMARY is always INFO; other types take the
 * requested status or their default.
 */
export function resolveLedgerInitialStatus(
  type: LedgerEntryType,
  requested: LedgerStatus | undefined,
): LedgerStatus | LedgerPolicyViolation {
  if (type === 'SUMMARY' && requested !== undefined && requested !== 'INFO') {
    return { reason: 'INVALID_INPUT', field: 'status' };
  }
  return requested ?? defaultLedgerStatus(type);
}

export function isLedgerPolicyViolation(
  value: LedgerStatus | LedgerPolicyViolation,
): value is LedgerPolicyViolation {
  return typeof value !== 'string';
}

/**
 * Sidecar attribution must be recorded by a sidecar on behalf of its primary;
 * every other attribution kind must not be recorded by a sidecar.
 */
export function checkLedgerAttribution(
  attribution: LedgerAttribution,
): LedgerPolicyViolation | null {
  if (!canLedgerActorOwn(attribution.effectiveActor.kind)) {
    return { reason: 'FORBIDDEN', field: 'attribution.effectiveActor' };
  }
  const recordedBySidecar = attribution.recordedBy.kind === 'ledger_sidecar';
  if (attribution.kind !== 'sidecar') {
    return recordedBySidecar
      ? { reason: 'FORBIDDEN', field: 'attribution.recordedBy' }
      : null;
  }
  if (!recordedBySidecar) {
    return { reason: 'INVALID_INPUT', field: 'attribution.recordedBy' };
  }
  return attribution.primaryActorId === attribution.effectiveActor.actorId
    ? null
    : { reason: 'INVALID_INPUT', field: 'attribution.primaryActorId' };
}

export interface LedgerCreationPolicyInput {
  readonly path: LedgerEntryCreationPath;
  readonly type: LedgerEntryType;
  readonly author: LedgerActorRef;
  readonly owner: LedgerActorRef;
  readonly attribution: LedgerAttribution;
}

/**
 * Checks who may create an entry. The creation's author must be its effective
 * actor; Summary entries are owned by their author; sidecars never author or
 * own.
 */
export function checkLedgerCreation(
  input: LedgerCreationPolicyInput,
): LedgerPolicyViolation | null {
  if ((input.type === 'SUMMARY') !== (input.path === 'summary')) {
    return { reason: 'INVALID_INPUT', field: 'type' };
  }
  if (!canLedgerActorAuthor(input.author.kind, input.path)) {
    return { reason: 'FORBIDDEN', field: 'author' };
  }
  if (!sameLedgerActor(input.author, input.attribution.effectiveActor)) {
    return { reason: 'INVALID_INPUT', field: 'attribution.effectiveActor' };
  }
  const attributionViolation = checkLedgerAttribution(input.attribution);
  if (attributionViolation !== null) return attributionViolation;
  if (!canLedgerActorOwn(input.owner.kind)) {
    return { reason: 'OWNER_UNAVAILABLE', field: 'owner' };
  }
  if (input.path === 'summary' && !sameLedgerActor(input.owner, input.author)) {
    return { reason: 'INVALID_INPUT', field: 'owner' };
  }
  return null;
}

export interface LedgerStatusChange {
  readonly from: LedgerStatus;
  readonly to: LedgerStatus;
}

export interface LedgerOwnerChange {
  readonly from: LedgerActorRef;
  readonly to: LedgerActorRef;
}

export type LedgerUpdateRejection =
  | 'REVISION_CONFLICT'
  | 'TERMINAL_ENTRY'
  | 'FORBIDDEN';

export type LedgerUpdateDecision =
  | {
      readonly kind: 'reject';
      readonly reason: LedgerUpdateRejection;
      readonly field?: string;
    }
  | { readonly kind: 'noop' }
  | {
      readonly kind: 'change';
      readonly status: LedgerStatusChange | null;
      readonly owner: LedgerOwnerChange | null;
      readonly parent: {
        readonly from: string | null;
        readonly to: string | null;
      } | null;
    };

export interface LedgerUpdatePolicyInput {
  readonly current: {
    readonly revision: number;
    readonly status: LedgerStatus;
    readonly owner: LedgerActorRef;
    readonly parentEntryId?: string;
  };
  readonly expectedRevision: number;
  readonly requestedStatus?: LedgerStatus;
  readonly requestedOwner?: LedgerActorRef;
  /** `null` detaches; `undefined` leaves the parent unchanged. */
  readonly requestedParentEntryId?: string | null;
  /** The caller's attribution; its effective actor is the acting identity. */
  readonly attribution: LedgerAttribution;
  /** Host-resolved owners in this chat's managed delegation subtree. */
  readonly delegateOwnerActorIds?: readonly string[];
  /**
   * Set only for the user UI, which may update any open entry in a scope it can
   * write. Agents may update their own entries and host-resolved delegated owners.
   */
  readonly mayUpdateAnyOpenEntry: boolean;
}

/**
 * True when this actor may update an entry with the current owner. Delegated
 * owners are an explicit host grant for chat and managed-delegation actors;
 * sidecar attribution continues to act only for its primary actor.
 */
export function canLedgerActorUpdateOwnedEntry(
  attribution: LedgerAttribution,
  ownerActorId: string,
  delegateOwnerActorIds?: readonly string[],
): boolean {
  if (attribution.effectiveActor.actorId === ownerActorId) return true;
  if (
    attribution.kind === 'sidecar' ||
    (attribution.effectiveActor.kind !== 'chat' &&
      attribution.effectiveActor.kind !== 'managed_delegation')
  ) {
    return false;
  }
  return delegateOwnerActorIds?.includes(ownerActorId) === true;
}

function checkUpdatePermission(
  input: LedgerUpdatePolicyInput,
): LedgerUpdateDecision | null {
  const actor = input.attribution.effectiveActor;
  if (input.mayUpdateAnyOpenEntry) {
    return actor.kind === 'user'
      ? null
      : { kind: 'reject', reason: 'FORBIDDEN', field: 'mayUpdateAnyOpenEntry' };
  }
  if (
    !canLedgerActorUpdateOwnedEntry(
      input.attribution,
      input.current.owner.actorId,
      input.delegateOwnerActorIds,
    )
  ) {
    return { kind: 'reject', reason: 'FORBIDDEN', field: 'owner' };
  }
  // Sidecars (deferred) may change status only, on behalf of their primary.
  if (
    input.attribution.kind === 'sidecar' &&
    (input.requestedOwner !== undefined ||
      input.requestedParentEntryId !== undefined)
  ) {
    return {
      kind: 'reject',
      reason: 'FORBIDDEN',
      field: input.requestedOwner !== undefined ? 'owner' : 'parentEntryId',
    };
  }
  return null;
}

/**
 * Decides an Update in the documented order: revision compare-and-swap, the
 * terminal lock (which rejects even exact no-ops), then the caller's
 * permission. A request that changes nothing on an open entry is a no-op.
 * The new owner's eligibility is checked by the caller afterwards, and only
 * when the owner actually changes.
 */
export function evaluateLedgerUpdate(
  input: LedgerUpdatePolicyInput,
): LedgerUpdateDecision {
  if (input.current.revision !== input.expectedRevision) {
    return {
      kind: 'reject',
      reason: 'REVISION_CONFLICT',
      field: 'expectedRevision',
    };
  }
  if (!isLedgerEntryOpen(input.current.status)) {
    return { kind: 'reject', reason: 'TERMINAL_ENTRY' };
  }
  const permission = checkUpdatePermission(input);
  if (permission !== null) return permission;

  const status: LedgerStatusChange | null =
    input.requestedStatus !== undefined &&
    input.requestedStatus !== input.current.status
      ? { from: input.current.status, to: input.requestedStatus }
      : null;
  const owner: LedgerOwnerChange | null =
    input.requestedOwner !== undefined &&
    input.requestedOwner.actorId !== input.current.owner.actorId
      ? { from: input.current.owner, to: input.requestedOwner }
      : null;
  const currentParentEntryId = input.current.parentEntryId ?? null;
  const parent: {
    readonly from: string | null;
    readonly to: string | null;
  } | null =
    input.requestedParentEntryId !== undefined &&
    input.requestedParentEntryId !== currentParentEntryId
      ? {
          from: currentParentEntryId,
          to: input.requestedParentEntryId,
        }
      : null;
  if (status === null && owner === null && parent === null) {
    return { kind: 'noop' };
  }
  return { kind: 'change', status, owner, parent };
}
