import {
  LedgerActorRefSchema,
  LedgerAddEntryParamsSchema,
  LedgerAttributionSchema,
  LedgerAuthorDetailsSchema,
  LedgerLeftOpenReasonSchema,
  LedgerOriginSchema,
  LedgerPublishSummaryParamsSchema,
  LedgerTimestampSchema,
  LedgerUuidSchema,
  LedgerUpdateEntryParamsSchema,
  countCodePoints,
  ledgerProvisionalTitle,
  normalizeLedgerFileRefs,
  type LedgerActorRef,
  type LedgerAttribution,
  type LedgerAuthorDetails,
  type LedgerEntryType,
  type LedgerFileRef,
  type LedgerMutation,
  type LedgerOrigin,
  type LedgerOwnerTarget,
  type LedgerStatus,
  type LedgerUpdateEntryParams,
} from '@canopy/protocol/canopy-core';

import { LedgerStoreError } from './errors';
import { hashLedgerCanonicalValue } from './hashing';
import {
  isLedgerPolicyViolation,
  resolveLedgerInitialStatus,
  type LedgerEntryCreationPath,
} from './policy';
import { parseLedgerInput } from './records';
import type {
  LedgerAddEntryInput,
  LedgerHandBackEntryInput,
  LedgerListReceiptKeysInput,
  LedgerPublishSummaryInput,
  LedgerUpdateEntryInput,
  LedgerWorkSummaryInput,
} from './types';
import { toLedgerTimestamp } from './time';

/**
 * Request normalization. Every command is validated with the protocol schemas
 * (which trim text and enforce limits), normalized (defaults applied, file
 * references de-duplicated, owner targets resolved to actor IDs), and hashed.
 * The hash covers only the caller's request, not host context such as author
 * details or origin anchors, so a replay of the same request with the same
 * key returns the stored receipt even if that context was re-captured.
 */

/** Longest accepted idempotency key, in code points. */
export const LEDGER_IDEMPOTENCY_KEY_MAX_CODE_POINTS = 1_024;

export const LEDGER_COMMAND_OPERATIONS = {
  addEntry: 'core.ledger.entry.add',
  updateEntry: 'core.ledger.entry.update',
  publishSummary: 'core.ledger.summary.publish',
} as const;

/** Receipt namespace reserved for the store-internal session handback. */
const LEDGER_HANDBACK_RECEIPT_OPERATION = 'internal.ledger.entry.handback';

export type LedgerCommandOperation =
  (typeof LEDGER_COMMAND_OPERATIONS)[keyof typeof LEDGER_COMMAND_OPERATIONS];

type LedgerReceiptOperation =
  | LedgerCommandOperation
  | typeof LEDGER_HANDBACK_RECEIPT_OPERATION;

/** At most this many keys per receipt-key lookup. */
export const LEDGER_RECEIPT_KEYS_MAX = 100;

/** Maximum host-resolved actors in one bounded managed-delegation query. */
export const LEDGER_WORK_SUMMARY_ACTOR_IDS_MAX = 1_024;

/** A validated receipt-key lookup. */
export interface LedgerReceiptKeysRequest {
  readonly ledgerId: string;
  readonly operation: LedgerCommandOperation;
  /** Distinct keys, in the order given. */
  readonly idempotencyKeys: readonly string[];
}

/**
 * Validates a receipt-key lookup: a known command operation and at most
 * `LEDGER_RECEIPT_KEYS_MAX` well-formed keys.
 */
export function normalizeReceiptKeysRequest(
  input: LedgerListReceiptKeysInput,
): LedgerReceiptKeysRequest {
  if (typeof input.ledgerId !== 'string' || input.ledgerId.length === 0) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'ledgerId' });
  }
  const operation = Object.values(LEDGER_COMMAND_OPERATIONS).find(
    (candidate) => candidate === input.operation,
  );
  if (operation === undefined) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'operation' });
  }
  const keys: unknown = input.idempotencyKeys;
  if (!Array.isArray(keys) || keys.length > LEDGER_RECEIPT_KEYS_MAX) {
    throw new LedgerStoreError('INVALID_INPUT', {
      field: 'idempotencyKeys',
      limit: LEDGER_RECEIPT_KEYS_MAX,
    });
  }
  const idempotencyKeys: string[] = [];
  for (const key of keys) {
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      countCodePoints(key) > LEDGER_IDEMPOTENCY_KEY_MAX_CODE_POINTS
    ) {
      throw new LedgerStoreError('INVALID_INPUT', {
        field: 'idempotencyKeys',
        limit: LEDGER_IDEMPOTENCY_KEY_MAX_CODE_POINTS,
      });
    }
    if (!idempotencyKeys.includes(key)) idempotencyKeys.push(key);
  }
  return { ledgerId: input.ledgerId, operation, idempotencyKeys };
}

/**
 * Receipts are scoped by ledger, caller and operation. The caller is the
 * attribution's `recordedBy` actor (the chat, user, helper or sidecar that
 * issued the command), so two callers can never alias each other's receipts.
 */
export interface LedgerReceiptKey {
  readonly ledgerId: string;
  readonly actorId: string;
  readonly operation: LedgerReceiptOperation;
  readonly idempotencyKey: string;
}

export interface LedgerEntryDraft {
  readonly path: LedgerEntryCreationPath;
  /** The Add form omitted its title and may resolve the provisional value. */
  readonly pendingTitle: boolean;
  readonly type: LedgerEntryType;
  readonly title: string;
  readonly content: string;
  readonly highlights: string[];
  readonly referenceFiles: LedgerFileRef[];
  readonly status: LedgerStatus;
  readonly author: LedgerActorRef;
  readonly authorDetails: LedgerAuthorDetails;
  readonly owner: LedgerActorRef;
  /** Host eligibility verdict for an owner other than the author. */
  readonly ownerEligible: boolean;
  readonly origin: LedgerOrigin;
  readonly attribution: LedgerAttribution;
  readonly supersedesEntryId: string | undefined;
  /** Summary publication detail kept in the outbox payload. */
  readonly publication: { readonly sourceTruncated: boolean } | null;
}

export interface LedgerCreateRequest {
  readonly draft: LedgerEntryDraft;
  /** The caller's requested parent, retained for the transaction to resolve. */
  readonly parentEntryId: string | undefined;
  readonly receiptKey: LedgerReceiptKey;
  readonly requestHash: string;
}

export interface LedgerUpdateRequest {
  readonly params: LedgerUpdateEntryParams;
  readonly attribution: LedgerAttribution;
  readonly invocationOrigin: LedgerOrigin;
  readonly newOwner: LedgerActorRef | null;
  /** Host eligibility verdict for `newOwner`. */
  readonly ownerEligible: boolean;
  /** Host-resolved owners in the acting chat's managed delegation subtree. */
  readonly delegateOwnerActorIds: readonly string[] | undefined;
  readonly mayUpdateAnyOpenEntry: boolean;
  readonly receiptKey: LedgerReceiptKey;
  readonly requestHash: string;
}

export interface LedgerWorkSummaryRequest {
  readonly ledgerId: string;
  readonly actorIds: readonly string[];
}

export interface LedgerHandBackRequest {
  readonly ledgerId: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly endedActorId: string;
  readonly newOwner: LedgerActorRef;
  readonly transitionAt: string;
  readonly reason: NonNullable<LedgerMutation['leftOpen']>;
  readonly receiptKey: LedgerReceiptKey;
  readonly requestHash: string;
}

function receiptKey(
  ledgerId: string,
  caller: LedgerActorRef,
  operation: LedgerCommandOperation,
  idempotencyKey: string,
): LedgerReceiptKey {
  return receiptKeyForActorId(
    ledgerId,
    caller.actorId,
    operation,
    idempotencyKey,
  );
}

function receiptKeyForActorId(
  ledgerId: string,
  actorId: string,
  operation: LedgerReceiptOperation,
  idempotencyKey: string,
): LedgerReceiptKey {
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length === 0 ||
    countCodePoints(idempotencyKey) > LEDGER_IDEMPOTENCY_KEY_MAX_CODE_POINTS
  ) {
    throw new LedgerStoreError('INVALID_INPUT', {
      field: 'idempotencyKey',
      limit: LEDGER_IDEMPOTENCY_KEY_MAX_CODE_POINTS,
    });
  }
  return { ledgerId, actorId, operation, idempotencyKey };
}

/** De-duplicates references and drops absent `startLine` members. */
function normalizeReferenceFiles(
  refs: readonly LedgerFileRef[],
): LedgerFileRef[] {
  return normalizeLedgerFileRefs(refs).map(
    (ref: LedgerFileRef): LedgerFileRef =>
      ref.startLine === undefined
        ? { rootId: ref.rootId, path: ref.path }
        : { rootId: ref.rootId, path: ref.path, startLine: ref.startLine },
  );
}

/**
 * The resolved owner must be the actor the request named: the caller itself
 * for an omitted target or `'self'`, otherwise the explicit actor ID.
 */
function assertResolvedOwner(
  target: LedgerOwnerTarget | undefined,
  resolved: LedgerActorRef,
  self: LedgerActorRef,
): void {
  const expected =
    target === undefined || target === 'self' ? self.actorId : target.actorId;
  if (resolved.actorId !== expected) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'owner' });
  }
}

function initialStatus(
  type: LedgerEntryType,
  requested: LedgerStatus | undefined,
): LedgerStatus {
  const status = resolveLedgerInitialStatus(type, requested);
  if (isLedgerPolicyViolation(status)) {
    throw new LedgerStoreError(status.reason, { field: status.field });
  }
  return status;
}

function hashCreation(
  draft: LedgerEntryDraft,
  extra: { readonly [key: string]: string | boolean | null },
  parentEntryId: string | undefined,
): string {
  return hashLedgerCanonicalValue({
    ...extra,
    type: draft.type,
    title: draft.title,
    content: draft.content,
    highlights: draft.highlights,
    referenceFiles: draft.referenceFiles,
    status: draft.status,
    ownerActorId: draft.owner.actorId,
    supersedesEntryId: draft.supersedesEntryId ?? null,
    ...(parentEntryId === undefined ? {} : { parentEntryId }),
  });
}

export function normalizeAddEntryRequest(
  input: LedgerAddEntryInput,
): LedgerCreateRequest {
  const params = parseLedgerInput(LedgerAddEntryParamsSchema, input.params, '');
  const author = parseLedgerInput(LedgerActorRefSchema, input.author, 'author');
  const owner = parseLedgerInput(LedgerActorRefSchema, input.owner, 'owner');
  const attribution = parseLedgerInput(
    LedgerAttributionSchema,
    input.attribution,
    'attribution',
  );
  assertResolvedOwner(params.owner, owner, author);
  const draft: LedgerEntryDraft = {
    path: 'add',
    pendingTitle: params.title === undefined,
    type: params.type,
    title: params.title ?? ledgerProvisionalTitle(params.content),
    content: params.content,
    highlights: params.highlights ?? [],
    referenceFiles: normalizeReferenceFiles(params.referenceFiles ?? []),
    status: initialStatus(params.type, params.status),
    author,
    authorDetails: parseLedgerInput(
      LedgerAuthorDetailsSchema,
      input.authorDetails,
      'authorDetails',
    ),
    owner,
    ownerEligible: input.ownerEligible !== false,
    origin: parseLedgerInput(LedgerOriginSchema, input.origin, 'origin'),
    attribution,
    supersedesEntryId: params.supersedesEntryId,
    publication: null,
  };
  const parentEntryId = params.parentEntryId;
  return {
    draft,
    parentEntryId,
    receiptKey: receiptKey(
      input.ledgerId,
      attribution.recordedBy,
      LEDGER_COMMAND_OPERATIONS.addEntry,
      input.idempotencyKey,
    ),
    requestHash: hashCreation(draft, {}, parentEntryId),
  };
}

/**
 * A Summary entry is authored and owned by the generating helper, attributed
 * to the system, and always INFO. Its origin is derived from the publication
 * parameters, so the caller cannot supply an inconsistent one.
 */
export function normalizeSummaryRequest(
  input: LedgerPublishSummaryInput,
): LedgerCreateRequest {
  const params = parseLedgerInput(
    LedgerPublishSummaryParamsSchema,
    input.params,
    '',
  );
  const helper = parseLedgerInput(LedgerActorRefSchema, input.helper, 'helper');
  const helperDetails = parseLedgerInput(
    LedgerAuthorDetailsSchema,
    input.helperDetails,
    'helperDetails',
  );
  const draft: LedgerEntryDraft = {
    path: 'summary',
    pendingTitle: false,
    type: 'SUMMARY',
    title: params.title,
    content: params.content,
    highlights: params.highlights ?? [],
    referenceFiles: [],
    status: 'INFO',
    author: helper,
    authorDetails: helperDetails,
    owner: helper,
    ownerEligible: true,
    origin: {
      kind: 'summary',
      ledgerId: input.ledgerId,
      snapshotId: params.snapshotId,
      generationId: params.generationId,
      helperActorId: helper.actorId,
      ...(params.observedTaskId === undefined
        ? {}
        : { observedTaskId: params.observedTaskId }),
      ...(params.summaryArtifactId === undefined
        ? {}
        : { summaryArtifactId: params.summaryArtifactId }),
    },
    attribution: {
      kind: 'system',
      effectiveActor: helper,
      recordedBy: helper,
      executorDetails: helperDetails,
    },
    supersedesEntryId: undefined,
    publication: { sourceTruncated: params.sourceTruncated },
  };
  return {
    draft,
    parentEntryId: undefined,
    receiptKey: receiptKey(
      input.ledgerId,
      helper,
      LEDGER_COMMAND_OPERATIONS.publishSummary,
      input.idempotencyKey,
    ),
    requestHash: hashCreation(
      draft,
      {
        snapshotId: params.snapshotId,
        generationId: params.generationId,
        sourceTruncated: params.sourceTruncated,
        observedTaskId: params.observedTaskId ?? null,
        summaryArtifactId: params.summaryArtifactId ?? null,
      },
      undefined,
    ),
  };
}

export function normalizeUpdateEntryRequest(
  input: LedgerUpdateEntryInput,
): LedgerUpdateRequest {
  const params = parseLedgerInput(
    LedgerUpdateEntryParamsSchema,
    input.params,
    '',
  );
  const attribution = parseLedgerInput(
    LedgerAttributionSchema,
    input.attribution,
    'attribution',
  );
  const newOwner =
    input.newOwner === null
      ? null
      : parseLedgerInput(LedgerActorRefSchema, input.newOwner, 'newOwner');
  const delegateOwnerActorIds = normalizeDelegateOwnerActorIds(
    input.delegateOwnerActorIds,
  );
  if ((params.owner === undefined) !== (newOwner === null)) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'owner' });
  }
  if (newOwner !== null) {
    assertResolvedOwner(params.owner, newOwner, attribution.effectiveActor);
  }
  return {
    params,
    attribution,
    invocationOrigin: parseLedgerInput(
      LedgerOriginSchema,
      input.invocationOrigin,
      'invocationOrigin',
    ),
    newOwner,
    ownerEligible: input.ownerEligible !== false,
    delegateOwnerActorIds,
    mayUpdateAnyOpenEntry: input.mayUpdateAnyOpenEntry === true,
    receiptKey: receiptKey(
      input.ledgerId,
      attribution.recordedBy,
      LEDGER_COMMAND_OPERATIONS.updateEntry,
      input.idempotencyKey,
    ),
    requestHash: hashLedgerCanonicalValue({
      entryId: params.entryId,
      expectedRevision: params.expectedRevision,
      status: params.status ?? null,
      ownerActorId: newOwner?.actorId ?? null,
      ...(params.parentEntryId === undefined
        ? {}
        : { parentEntryId: params.parentEntryId }),
      ...(params.openChildren === undefined
        ? {}
        : { openChildren: params.openChildren }),
    }),
  };
}

function normalizeDelegateOwnerActorIds(
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > LEDGER_WORK_SUMMARY_ACTOR_IDS_MAX
  ) {
    throw new LedgerStoreError('INVALID_INPUT', {
      field: 'delegateOwnerActorIds',
      limit: LEDGER_WORK_SUMMARY_ACTOR_IDS_MAX,
    });
  }
  const actorIds = new Set<string>();
  for (const rawActorId of value) {
    const actorId = parseLedgerInput(
      LedgerUuidSchema,
      rawActorId,
      'delegateOwnerActorIds',
    );
    actorIds.add(actorId);
  }
  return Array.from(actorIds);
}

export function normalizeLedgerWorkSummaryInput(
  input: LedgerWorkSummaryInput,
): LedgerWorkSummaryRequest {
  const ledgerId = parseLedgerInput(
    LedgerUuidSchema,
    input.ledgerId,
    'ledgerId',
  );
  const rawActorIds: unknown = input.actorIds;
  if (
    !Array.isArray(rawActorIds) ||
    rawActorIds.length > LEDGER_WORK_SUMMARY_ACTOR_IDS_MAX
  ) {
    throw new LedgerStoreError('INVALID_INPUT', {
      field: 'actorIds',
      limit: LEDGER_WORK_SUMMARY_ACTOR_IDS_MAX,
    });
  }
  const actorIds = new Set<string>();
  for (const rawActorId of rawActorIds) {
    actorIds.add(parseLedgerInput(LedgerUuidSchema, rawActorId, 'actorIds'));
  }
  return { ledgerId, actorIds: Array.from(actorIds) };
}

/**
 * Validates and hashes the trusted store-internal handback command. Its
 * receipt namespace is separate from the public Update command, and the
 * hash includes every handback fence and attribution-relevant actor.
 */
export function normalizeHandBackEntryRequest(
  input: LedgerHandBackEntryInput,
): LedgerHandBackRequest {
  const ledgerId = parseLedgerInput(
    LedgerUuidSchema,
    input.ledgerId,
    'ledgerId',
  );
  const entryId = parseLedgerInput(LedgerUuidSchema, input.entryId, 'entryId');
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw new LedgerStoreError('INVALID_INPUT', { field: 'expectedRevision' });
  }
  const endedActorId = parseLedgerInput(
    LedgerUuidSchema,
    input.endedActorId,
    'endedActorId',
  );
  const newOwner = parseLedgerInput(
    LedgerActorRefSchema,
    input.newOwner,
    'newOwner',
  );
  const transitionAtValue = parseLedgerInput(
    LedgerTimestampSchema,
    input.transitionAt,
    'transitionAt',
  );
  const transitionAt = toLedgerTimestamp(new Date(transitionAtValue));
  const reason = parseLedgerInput(
    LedgerLeftOpenReasonSchema,
    input.reason,
    'reason',
  );
  const receiptKey = receiptKeyForActorId(
    ledgerId,
    endedActorId,
    LEDGER_HANDBACK_RECEIPT_OPERATION,
    input.idempotencyKey,
  );

  return {
    ledgerId,
    entryId,
    expectedRevision: input.expectedRevision,
    endedActorId,
    newOwner,
    transitionAt,
    reason,
    receiptKey,
    requestHash: hashLedgerCanonicalValue({
      entryId,
      expectedRevision: input.expectedRevision,
      endedActorId,
      newOwner,
      transitionAt,
      reason,
    }),
  };
}
