import {
  LEDGER_DEFAULT_STATUS_BY_TYPE,
  isLedgerTerminalStatus,
  type LedgerActorKind,
  type LedgerActorRef,
  isLedgerGlobalContainer,
  type LedgerAttribution,
  type LedgerContainer,
  type LedgerEntryType,
  type LedgerErrorReason,
  type LedgerOpenChildrenChoice,
  type LedgerStatus,
} from './schemas';

/**
 * Pure Ledger policy: default statuses, the terminal lock, who may author and
 * own entries, which updates are permitted, and which entries a close or a
 * start revises with it. Every Ledger writer applies these rules inside its
 * own transaction: the desktop store (`LedgerRepository`) and the web core's
 * cloud writer (CAN-6422). Neither keeps a copy of them.
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

/** What the cascade planners read of an entry: its holder's own wrapper. */
export interface LedgerCascadeNode {
  readonly entry: {
    readonly entryId: string;
    readonly type: LedgerEntryType;
    readonly status: LedgerStatus;
    readonly owner: Pick<LedgerActorRef, 'actorId'>;
    readonly parentEntryId?: string;
  };
}

/** What closing an entry does to the open entries under it (L05). */
export type LedgerChildClosePlan<Node extends LedgerCascadeNode> =
  /** Nothing under it is open, or the close leaves its children alone. */
  | { readonly kind: 'none' }
  /** Refused `OPEN_CHILDREN`, naming these open entries. */
  | { readonly kind: 'refuse'; readonly openChildEntryIds: readonly string[] }
  /** The stored hierarchy has a cycle; the writer reports it as damage. */
  | { readonly kind: 'cycle' }
  | {
      readonly kind: 'plan';
      readonly choice: LedgerOpenChildrenChoice;
      /** Detach targets: the nearest open entries at any depth. */
      readonly detachTargets: readonly Node[];
      /** Open descendants in post-order, used by complete and fail. */
      readonly openDescendants: readonly Node[];
    };

export interface LedgerChildClosePlanInput<Node extends LedgerCascadeNode> {
  /** The entry being changed. */
  readonly entryId: string;
  /** Its requested status; only a close plans anything. */
  readonly targetStatus: LedgerStatus | undefined;
  readonly choice: LedgerOpenChildrenChoice | undefined;
  readonly attribution: LedgerAttribution;
  readonly delegateOwnerActorIds?: readonly string[];
  /** The person's close, which may revise any open entry. */
  readonly mayUpdateAnyOpenEntry: boolean;
  /** The direct children of an entry, in the writer's stable order. */
  readonly childrenOf: (entryId: string) => readonly Node[];
}

/** Open entries under `entryId`, nearest first or in post-order; null on a cycle. */
function openDescendants<Node extends LedgerCascadeNode>(
  entryId: string,
  childrenOf: (entryId: string) => readonly Node[],
  order: 'nearest' | 'post-order',
): Node[] | null {
  const open: Node[] = [];
  const visited = new Set<string>([entryId]);
  const visit = (parentEntryId: string): boolean => {
    for (const child of childrenOf(parentEntryId)) {
      if (visited.has(child.entry.entryId)) return false;
      visited.add(child.entry.entryId);
      const isOpen = isLedgerEntryOpen(child.entry.status);
      // Open entries can sit beneath children that are already closed (a
      // person's close leaves its children open), so nearest looks past them.
      if (order === 'nearest' && isOpen) {
        open.push(child);
        continue;
      }
      if (!visit(child.entry.entryId)) return false;
      if (order === 'post-order' && isOpen) open.push(child);
    }
    return true;
  };
  return visit(entryId) ? open : null;
}

/**
 * Plans what closing an entry (`COMPLETED`, `FAILED` or `INFO`) does to the
 * open entries under it, at any depth (L05). With no choice, an agent's close
 * is refused naming the nearest open entries, and the person's close leaves
 * them open and attached. `detach` moves those nearest entries to top level
 * with their subtrees; `complete` and `fail` close every open descendant,
 * deepest first. An agent's choice covers only entries it may update; any
 * other open entry refuses the close with its ID.
 */
export function planLedgerChildClose<Node extends LedgerCascadeNode>(
  input: LedgerChildClosePlanInput<Node>,
): LedgerChildClosePlan<Node> {
  if (input.targetStatus === undefined || isLedgerEntryOpen(input.targetStatus))
    return { kind: 'none' };
  const nearestOpen = openDescendants(
    input.entryId,
    input.childrenOf,
    'nearest',
  );
  if (nearestOpen === null) return { kind: 'cycle' };
  if (nearestOpen.length === 0) return { kind: 'none' };
  if (input.choice === undefined) {
    return input.mayUpdateAnyOpenEntry
      ? { kind: 'none' }
      : {
          kind: 'refuse',
          openChildEntryIds: nearestOpen.map((child) => child.entry.entryId),
        };
  }
  // Detach moves the same nearest open entries the refusal names, so an open
  // subtask under an already-closed task goes to top level with its subtree.
  const revised =
    input.choice === 'detach'
      ? nearestOpen
      : openDescendants(input.entryId, input.childrenOf, 'post-order');
  if (revised === null) return { kind: 'cycle' };
  if (!input.mayUpdateAnyOpenEntry) {
    const unauthorized = revised.filter(
      (child) =>
        !canLedgerActorUpdateOwnedEntry(
          input.attribution,
          child.entry.owner.actorId,
          input.delegateOwnerActorIds,
        ),
    );
    if (unauthorized.length > 0)
      return {
        kind: 'refuse',
        openChildEntryIds: unauthorized.map((child) => child.entry.entryId),
      };
  }
  return {
    kind: 'plan',
    choice: input.choice,
    detachTargets: nearestOpen,
    openDescendants: revised,
  };
}

/**
 * The operation an entry moving to `IN_PROGRESS` starts (L04): the nearest
 * ancestor that is a `TODO` operation, or null. `'cycle'` when the stored
 * hierarchy loops. `entryOf` reads an ancestor and may throw when it is
 * missing.
 */
export function findLedgerAutoStartOperation<Node extends LedgerCascadeNode>(
  child: LedgerCascadeNode['entry'],
  entryOf: (entryId: string) => Node,
): Node | null | 'cycle' {
  let ancestor: LedgerCascadeNode['entry'] = child;
  const visited = new Set([child.entryId]);
  while (ancestor.parentEntryId !== undefined) {
    if (visited.has(ancestor.parentEntryId)) return 'cycle';
    visited.add(ancestor.parentEntryId);
    const current = entryOf(ancestor.parentEntryId);
    ancestor = current.entry;
    if (ancestor.type === 'OPERATION' && ancestor.status === 'TODO')
      return current;
  }
  return null;
}

/** What a parent check reads of the proposed parent. */
export interface LedgerParentFacts {
  readonly type: LedgerEntryType;
  readonly status: LedgerStatus;
}

export interface LedgerParentCheckInput {
  readonly childType: LedgerEntryType;
  /** The proposed parent, or undefined when the scope has no such entry. */
  readonly parent: LedgerParentFacts | undefined;
  /** A correction's inherited parent may be closed (L03). */
  readonly allowClosedParent?: boolean;
  /**
   * Whether the parent sits in the subtree of the entry being moved; only
   * read for a move, after the parent itself is known to be valid.
   */
  readonly parentInMovedSubtree?: () => boolean;
  /** TASK ancestors of the parent, up to its operation; read for a TASK child. */
  readonly parentTaskDepth: () => number;
  /** TASK levels beneath a task being moved; 0 for a new entry. */
  readonly movedTaskDepth?: () => number;
}

/**
 * Checks a parent in the documented order (L03): operations and summaries
 * take none; the parent must exist, be open (unless inherited by a
 * correction), and be an operation or a task; a move may not go under its
 * own subtree; and a task chain is at most operation › task › subtask. The
 * reads are the writer's own and run only when the check gets to them; they
 * may throw for damaged storage.
 */
export function checkLedgerParent(
  input: LedgerParentCheckInput,
): LedgerPolicyViolation | null {
  const invalid: LedgerPolicyViolation = {
    reason: 'PARENT_INVALID',
    field: 'parentEntryId',
  };
  if (input.childType === 'OPERATION' || input.childType === 'SUMMARY')
    return invalid;
  if (input.parent === undefined) return invalid;
  if (
    input.allowClosedParent !== true &&
    !isLedgerEntryOpen(input.parent.status)
  )
    return { reason: 'PARENT_CLOSED', field: 'parentEntryId' };
  if (input.parent.type !== 'OPERATION' && input.parent.type !== 'TASK')
    return invalid;
  if (input.parentInMovedSubtree?.() === true) return invalid;
  if (
    input.childType === 'TASK' &&
    input.parentTaskDepth() + 1 + (input.movedTaskDepth?.() ?? 0) > 2
  )
    return invalid;
  return null;
}

/** Why a stored task chain cannot be measured: the hierarchy is damaged. */
export type LedgerHierarchyDamage =
  | 'ledger_parent_cycle'
  | 'ledger_parent_type'
  | 'ledger_task_depth';

/**
 * The TASK ancestors of an entry, counting the entry itself when it is a
 * task, up to its operation. Operations are a boundary, not a task level.
 */
export function ledgerTaskAncestorDepth(
  entry: Pick<LedgerCascadeNode['entry'], 'entryId' | 'type' | 'parentEntryId'>,
  entryOf: (
    entryId: string,
  ) => Pick<LedgerCascadeNode['entry'], 'entryId' | 'type' | 'parentEntryId'>,
): number | { readonly damage: LedgerHierarchyDamage } {
  let depth = 0;
  let current = entry;
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(current.entryId)) return { damage: 'ledger_parent_cycle' };
    visited.add(current.entryId);
    if (current.type === 'OPERATION') return depth;
    if (current.type !== 'TASK') return { damage: 'ledger_parent_type' };
    depth += 1;
    if (depth > 2) return { damage: 'ledger_task_depth' };
    if (current.parentEntryId === undefined) return depth;
    current = entryOf(current.parentEntryId);
  }
}

/**
 * The parent a new entry takes. A correction keeps the parent of the entry
 * it corrects, closed or not, and may only name that same parent; any other
 * entry takes the parent it asks for.
 */
export function resolveLedgerCreationParent(input: {
  readonly requestedParentEntryId: string | undefined;
  /** The entry a correction supersedes; undefined for any other entry. */
  readonly corrected: { readonly parentEntryId?: string } | undefined;
}):
  | {
      readonly parentEntryId: string | undefined;
      readonly allowClosedParent: boolean;
    }
  | LedgerPolicyViolation {
  if (input.corrected === undefined)
    return {
      parentEntryId: input.requestedParentEntryId,
      allowClosedParent: false,
    };
  if (
    input.requestedParentEntryId !== undefined &&
    input.requestedParentEntryId !== input.corrected.parentEntryId
  )
    return { reason: 'PARENT_INVALID', field: 'parentEntryId' };
  return {
    parentEntryId: input.corrected.parentEntryId,
    allowClosedParent: true,
  };
}

/**
 * Whether an entry's content suits its Ledger: a global Ledger has no
 * worktree for a reference file to be relative to, so its entries take none.
 */
export function checkLedgerScopeContent(input: {
  readonly container: LedgerContainer;
  readonly referenceFileCount: number;
}): LedgerPolicyViolation | null {
  return isLedgerGlobalContainer(input.container) &&
    input.referenceFileCount > 0
    ? { reason: 'INVALID_INPUT', field: 'referenceFiles' }
    : null;
}
