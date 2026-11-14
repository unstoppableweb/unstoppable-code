import {
  buildLedgerCreation,
  buildLedgerRevision,
  checkLedgerCreation,
  evaluateLedgerUpdate,
  isLedgerPolicyViolation,
  planLedgerChildClose,
  resolveLedgerInitialStatus,
  type LedgerActorRef,
  type LedgerAttribution,
  type LedgerAuthorDetails,
  type LedgerCommandReceipt,
  type LedgerEntriesSearchResult,
  type LedgerEntry,
  type LedgerEntryAddParams,
  type LedgerEntryUpdateParams,
  type LedgerErrorDetails,
  type LedgerOwnerCandidatePage,
  type LedgerOwnerTarget,
  type LedgerScopeRef,
  type LedgerSearchEntriesToolInput,
} from '@canopy/protocol/canopy-core';
import { AgentFeedError, type AgentFeedPort } from '../port/feed-port';
import type { AgentActionCall } from '../surface/family';

/*
 * A small in-memory Ledger for the Feed tools' conformance contract
 * (CAN-6313). It is not a Ledger store: it keeps one scope's entries in
 * memory and decides each write with the protocol's Ledger policy (initial
 * status, the update decision, the close cascade) and revision builders,
 * the rules every real writer calls, so a host's Feed port can be checked
 * against the same answers. Hosts wrap it in their own port; it throws
 * `ConformanceLedgerRefusal` with the Ledger's typed refusal.
 */

export class ConformanceLedgerRefusal extends Error {
  constructor(readonly details: LedgerErrorDetails) {
    super(details.reason);
    this.name = 'ConformanceLedgerRefusal';
  }
}

export interface ConformanceFeedLedger {
  /** The scope's person, an owner every actor may assign. */
  readonly user: LedgerActorRef;
  /** The actor of a chat, by its origin key, registered on first use. */
  actor(originKey: string): LedgerActorRef;
  add(
    actor: LedgerActorRef,
    params: LedgerEntryAddParams,
  ): LedgerCommandReceipt;
  update(
    actor: LedgerActorRef,
    params: LedgerEntryUpdateParams,
  ): LedgerCommandReceipt;
  search(
    actor: LedgerActorRef,
    params: LedgerSearchEntriesToolInput,
  ): LedgerEntriesSearchResult;
  /** Every entry revision written so far. */
  writeCount(): number;
}

const SCOPE: LedgerScopeRef = {
  ledgerId: '00000000-0000-4000-8000-0000000fee00',
  authorityId: 'conformance-ledger',
  container: { kind: 'global', owner: { kind: 'personal' } },
};

const AUTHOR_DETAILS: LedgerAuthorDetails = {
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: 'default',
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: null,
};

/** A UUID numbered within the conformance Ledger. */
function numberedId(prefix: string, sequence: number): string {
  return `00000000-0000-4000-8000-${prefix}${sequence
    .toString(16)
    .padStart(12 - prefix.length, '0')}`;
}

function refuse(
  reason: LedgerErrorDetails['reason'],
  details: Omit<LedgerErrorDetails, 'reason'> = {},
): ConformanceLedgerRefusal {
  return new ConformanceLedgerRefusal({ reason, ...details });
}

/** JSON with object keys sorted at every level. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function createConformanceFeedLedger(
  now: () => string = () => new Date().toISOString(),
): ConformanceFeedLedger {
  const actors = new Map<string, LedgerActorRef>();
  const entries: LedgerEntry[] = [];
  const keyed = new Map<
    string,
    { readonly fingerprint: string; readonly receipt: LedgerCommandReceipt }
  >();
  let sequence = 0;
  let writes = 0;
  const user: LedgerActorRef = {
    actorId: numberedId('a', 0),
    kind: 'user',
    authorityId: SCOPE.authorityId,
  };

  const attributionOf = (actor: LedgerActorRef): LedgerAttribution => ({
    kind: 'self_reported',
    effectiveActor: actor,
    recordedBy: actor,
    executorDetails: AUTHOR_DETAILS,
  });
  const tokenFor = (caller: LedgerActorRef, actorId: string): string =>
    `conformance-token:${caller.actorId}:${actorId}`;
  const ownerFor = (
    caller: LedgerActorRef,
    target: LedgerOwnerTarget | undefined,
  ): LedgerActorRef => {
    if (target === undefined || target === 'self') return caller;
    const candidate = [caller, user].find(
      (actor) => actor.actorId === target.actorId,
    );
    if (
      candidate === undefined ||
      tokenFor(caller, candidate.actorId) !== target.eligibilityToken
    )
      throw refuse('OWNER_UNAVAILABLE', { field: 'owner' });
    return candidate;
  };
  const find = (entryId: string): LedgerEntry | undefined =>
    entries.find((entry) => entry.entryId === entryId);
  const replace = (entry: LedgerEntry): void => {
    const index = entries.findIndex((item) => item.entryId === entry.entryId);
    entries[index] = entry;
    writes += 1;
  };
  const receipt = (
    entry: LedgerEntry,
    mutationId: string | null,
  ): LedgerCommandReceipt => ({
    entry,
    changed: mutationId !== null,
    mutationId,
    localSequence: String(sequence),
    syncState: 'mirrored',
  });
  /** Runs a keyed write once per caller and key. */
  const keyedWrite = (
    caller: LedgerActorRef,
    operation: string,
    params: { readonly _meta: { readonly idempotencyKey: string } },
    write: () => LedgerCommandReceipt,
  ): LedgerCommandReceipt => {
    const key = `${caller.actorId}:${operation}:${params._meta.idempotencyKey}`;
    const print = canonical(params);
    const recorded = keyed.get(key);
    if (recorded !== undefined) {
      if (recorded.fingerprint !== print)
        throw refuse('IDEMPOTENCY_KEY_REUSED');
      // A replay answers what the first write recorded, as a real writer's
      // idempotency records do.
      return recorded.receipt;
    }
    const result = write();
    keyed.set(key, { fingerprint: print, receipt: result });
    return result;
  };
  const owners = (caller: LedgerActorRef): LedgerOwnerCandidatePage => ({
    candidates: [
      {
        actor: caller,
        displayName: 'Chat',
        eligibilityToken: tokenFor(caller, caller.actorId),
        isSelf: true,
      },
      {
        actor: user,
        displayName: 'You',
        eligibilityToken: tokenFor(caller, user.actorId),
        isSelf: false,
      },
    ],
    nextCursor: null,
  });

  return {
    user,
    actor: (originKey) => {
      const existing = actors.get(originKey);
      if (existing !== undefined) return existing;
      const actor: LedgerActorRef = {
        actorId: numberedId('a', actors.size + 1),
        kind: 'chat',
        authorityId: SCOPE.authorityId,
      };
      actors.set(originKey, actor);
      return actor;
    },
    add: (caller, params) =>
      keyedWrite(caller, 'add', params, () => {
        if (params.title === undefined)
          throw refuse('INVALID_INPUT', { field: 'title' });
        const owner = ownerFor(caller, params.owner);
        const attribution = attributionOf(caller);
        const creation = checkLedgerCreation({
          path: 'add',
          type: params.type,
          author: caller,
          owner,
          attribution,
        });
        if (creation !== null)
          throw refuse(
            creation.reason,
            creation.field === undefined ? {} : { field: creation.field },
          );
        const status = resolveLedgerInitialStatus(params.type, params.status);
        if (isLedgerPolicyViolation(status))
          throw refuse(
            status.reason,
            status.field === undefined ? {} : { field: status.field },
          );
        if (params.parentEntryId !== undefined) {
          const parent = find(params.parentEntryId);
          if (parent === undefined)
            throw refuse('PARENT_INVALID', { field: 'parentEntryId' });
        }
        sequence += 1;
        const created = buildLedgerCreation({
          scope: SCOPE,
          fields: {
            author: caller,
            authorDetails: AUTHOR_DETAILS,
            owner,
            type: params.type,
            title: params.title,
            content: params.content,
            highlights: [...(params.highlights ?? [])],
            referenceFiles: [...(params.referenceFiles ?? [])],
            status,
            origin: {
              kind: 'chat',
              ledgerId: SCOPE.ledgerId,
              chatId: caller.actorId,
            },
            attribution,
            ...(params.supersedesEntryId === undefined
              ? {}
              : { supersedesEntryId: params.supersedesEntryId }),
          },
          entryId: numberedId('e', sequence),
          mutationId: numberedId('m', sequence),
          createdAt: now(),
          parentEntryId: params.parentEntryId,
        });
        entries.push(created.entry);
        writes += 1;
        return receipt(created.entry, created.mutation.mutationId);
      }),
    update: (caller, params) =>
      keyedWrite(caller, 'update', params, () => {
        const current = find(params.entryId);
        if (current === undefined)
          throw refuse('NOT_FOUND', { field: 'entryId' });
        const attribution = attributionOf(caller);
        const requestedOwner =
          params.owner === undefined
            ? undefined
            : ownerFor(caller, params.owner);
        const decision = evaluateLedgerUpdate({
          current,
          expectedRevision: params.expectedRevision,
          ...(params.status === undefined
            ? {}
            : { requestedStatus: params.status }),
          ...(requestedOwner === undefined ? {} : { requestedOwner }),
          ...(params.parentEntryId === undefined
            ? {}
            : { requestedParentEntryId: params.parentEntryId }),
          attribution,
          mayUpdateAnyOpenEntry: false,
        });
        if (decision.kind === 'reject')
          throw refuse(decision.reason, {
            ...(decision.field === undefined ? {} : { field: decision.field }),
            ...(decision.reason === 'REVISION_CONFLICT'
              ? { currentEntry: current }
              : {}),
          });
        if (decision.kind === 'noop') return receipt(current, null);
        const plan = planLedgerChildClose({
          entryId: current.entryId,
          targetStatus: decision.status?.to,
          choice: params.openChildren,
          attribution,
          mayUpdateAnyOpenEntry: false,
          childrenOf: (id) =>
            entries
              .filter((entry) => entry.parentEntryId === id)
              .map((entry) => ({ entry })),
        });
        if (plan.kind === 'refuse')
          throw refuse('OPEN_CHILDREN', {
            openChildEntryIds: [...plan.openChildEntryIds],
          });
        if (plan.kind === 'cycle') throw refuse('STORAGE_UNAVAILABLE');
        const revise = (
          previous: LedgerEntry,
          change: Parameters<typeof buildLedgerRevision>[0]['change'],
        ): LedgerEntry => {
          sequence += 1;
          const revised = buildLedgerRevision({
            previous,
            change,
            mutationId: numberedId('m', sequence),
            now: now(),
            attribution,
            invocationOrigin: current.origin,
          });
          replace(revised.entry);
          return revised.entry;
        };
        if (plan.kind === 'plan') {
          for (const child of plan.choice === 'detach'
            ? plan.detachTargets
            : plan.openDescendants)
            revise(
              child.entry,
              plan.choice === 'detach'
                ? {
                    status: null,
                    owner: null,
                    parent: {
                      from: child.entry.parentEntryId ?? null,
                      to: null,
                    },
                  }
                : {
                    status: {
                      from: child.entry.status,
                      to: plan.choice === 'complete' ? 'COMPLETED' : 'FAILED',
                    },
                    owner: null,
                    parent: null,
                  },
            );
        }
        const changed = revise(current, decision);
        return receipt(changed, numberedId('m', sequence));
      }),
    search: (caller, params) => {
      const ownerId =
        params.owner === undefined
          ? undefined
          : params.owner === 'self'
            ? caller.actorId
            : params.owner.actorId;
      const matched = entries.filter(
        (entry) =>
          (params.entryIds === undefined ||
            params.entryIds.includes(entry.entryId)) &&
          (ownerId === undefined || entry.owner.actorId === ownerId) &&
          (params.statuses === undefined ||
            params.statuses.includes(entry.status)) &&
          (params.types === undefined || params.types.includes(entry.type)),
      );
      const sorted =
        params.sort === 'updated_desc'
          ? [...matched].sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            )
          : [...matched].reverse();
      const limit = params.limit ?? 30;
      return {
        entries: sorted.slice(0, limit).map((entry) => ({
          entryId: entry.entryId,
          revision: entry.revision,
          type: entry.type,
          title: entry.title,
          content: entry.content,
          highlights: entry.highlights,
          referenceFiles: entry.referenceFiles,
          status: entry.status,
          owner: entry.owner,
          author: entry.author,
          attributionKind: entry.attribution.kind,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          ...(entry.supersedesEntryId === undefined
            ? {}
            : { supersedesEntryId: entry.supersedesEntryId }),
          ...(entry.parentEntryId === undefined
            ? {}
            : { parentEntryId: entry.parentEntryId }),
          sourceAvailability: 'available',
        })),
        nextCursor: null,
        hasMore: sorted.length > limit,
        watermark: String(sequence),
        ...(params.includeAssignableOwners === true
          ? { owners: owners(caller) }
          : {}),
      };
    },
    writeCount: () => writes,
  };
}

/** The calling chat's actor in `ledger`. */
function callerActor<H>(
  ledger: ConformanceFeedLedger,
  call: AgentActionCall<H>,
): LedgerActorRef {
  return ledger.actor(`chat:${call.scope?.chatId ?? 'unscoped'}`);
}

function asFeedError(error: unknown, self: LedgerActorRef): Error {
  if (error instanceof ConformanceLedgerRefusal)
    return new AgentFeedError(
      { kind: 'refused', failure: { details: error.details, kind: null } },
      self.actorId,
    );
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A Feed port over the in-memory Ledger, as the calling chat: what the
 * reference host serves, and the shape a host's own port takes.
 */
export function createConformanceFeedPort<H>(
  ledger: ConformanceFeedLedger,
): AgentFeedPort<H> {
  let freshKeys = 0;
  const keyOf = (idempotencyKey: string | undefined): string => {
    if (idempotencyKey !== undefined) return idempotencyKey;
    freshKeys += 1;
    return `call:${String(freshKeys)}`;
  };
  return {
    add: (params, idempotencyKey, call) => {
      const self = callerActor(ledger, call);
      try {
        const receipt = ledger.add(self, {
          ...params,
          _meta: { idempotencyKey: keyOf(idempotencyKey) },
        });
        return Promise.resolve({ receipt, selfActorId: self.actorId });
      } catch (error) {
        return Promise.reject(asFeedError(error, self));
      }
    },
    update: (params, idempotencyKey, call) => {
      const self = callerActor(ledger, call);
      try {
        const receipt = ledger.update(self, {
          ...params,
          _meta: { idempotencyKey: keyOf(idempotencyKey) },
        });
        return Promise.resolve({ receipt, selfActorId: self.actorId });
      } catch (error) {
        return Promise.reject(asFeedError(error, self));
      }
    },
    search: (params, call) => {
      const self = callerActor(ledger, call);
      try {
        return Promise.resolve({
          result: ledger.search(self, params),
          selfActorId: self.actorId,
        });
      } catch (error) {
        return Promise.reject(asFeedError(error, self));
      }
    },
  };
}
